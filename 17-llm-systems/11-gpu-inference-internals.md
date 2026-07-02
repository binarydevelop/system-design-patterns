# GPU Inference Internals

## TL;DR

LLM inference is two different workloads wearing one API. *Prefill* (processing the prompt) is compute-bound: thousands of tokens multiply through the weights in parallel and saturate the GPU's tensor cores. *Decode* (generating tokens one at a time) is memory-bandwidth-bound: every new token requires streaming the entire model — plus the growing KV cache — from HBM, doing almost no math per byte moved. On an H100, a 70B model at batch size 1 uses well under 1% of available compute; the hard ceiling on single-stream tokens/sec is set by `memory bandwidth ÷ bytes read per token`, and nothing about prompts, frameworks, or clever scheduling changes that. Every major inference optimization of the past three years — continuous batching, FlashAttention, quantization, speculative decoding, tensor parallelism, prefill/decode disaggregation — is one of two moves: raise the *arithmetic intensity* (useful FLOPs per byte of memory traffic) or reduce the bytes. This chapter builds that model from the hardware up, with the arithmetic to predict throughput ceilings before you benchmark. The serving-layer survey (schedulers, routing, caching tiers) lives in [LLM Infrastructure](./05-llm-infrastructure.md); the general model-serving stack in [Model Serving](../16-ml-systems/03-model-serving.md); the agent-workload view — session routing, fleet cost, fan-out economics — lives in [Agent Inference](./12-agent-inference.md).

---

## The GPU in Five Numbers

Everything in this chapter derives from a handful of datasheet numbers. For an H100 SXM (the workhorse of 2023–2026 inference fleets) and its successors:

| Spec | H100 SXM | H200 SXM | B200 |
|---|---|---|---|
| HBM capacity | 80 GB (HBM3) | 141 GB (HBM3e) | 192 GB (HBM3e) |
| Memory bandwidth | 3.35 TB/s | 4.8 TB/s | 8 TB/s |
| BF16 dense compute | 989 TFLOPS | 989 TFLOPS | ~2,250 TFLOPS |
| FP8 dense compute | 1,979 TFLOPS | 1,979 TFLOPS | ~4,500 TFLOPS |
| NVLink bandwidth (per GPU) | 900 GB/s | 900 GB/s | 1,800 GB/s |

(Datasheet FLOPS are often quoted "with sparsity" — double the dense number. Inference of dense transformers gets the dense figure. FP4 tensor cores, new in Blackwell, double FP8 throughput again.)

The number that organizes everything else is **machine balance**: peak compute divided by memory bandwidth.

```text
H100 balance (BF16): 989e12 FLOPS / 3.35e12 B/s ≈ 295 FLOPs per byte
H100 balance (FP8):  1979e12 / 3.35e12          ≈ 590 FLOPs per byte
```

A workload that performs fewer FLOPs per byte of HBM traffic than the machine balance cannot saturate the tensor cores — it is *memory-bound*, and its runtime is `bytes moved ÷ bandwidth`, full stop. A workload above the balance is *compute-bound* and its runtime is `FLOPs ÷ peak compute`. This is the roofline model, and LLM inference lives on both sides of it at once.

Note what got better across generations: H100 → H200 is the *same compute* with 43% more bandwidth and 76% more capacity — a pure decode upgrade. Vendors understood where the bottleneck was.

---

## Roofline: Why Decode Is Memory-Bound

A transformer forward pass performs roughly `2 × P` FLOPs per token, where `P` is the parameter count (each parameter participates in one multiply and one accumulate). The bytes side depends on batch size, because weights are read from HBM *once per forward pass* and shared across every sequence in the batch.

**Decode at batch size 1.** Generating one token for one sequence:

```text
Llama-3.3-70B in FP8: weights ≈ 70 GB

FLOPs  = 2 × 70e9            = 140 GFLOPs
Bytes  = 70e9 (all weights)  + KV cache (see next section)
Arithmetic intensity ≈ 140e9 / 70e9 = 2 FLOPs/byte

Machine balance (H100, FP8): 590 FLOPs/byte  →  memory-bound by ~300×
```

The GPU spends its time streaming weights, not multiplying. The tokens/sec ceiling follows directly:

```text
Single-stream ceiling = bandwidth / bytes per token
                      = 3.35 TB/s / 70 GB ≈ 48 tokens/sec
```

No scheduler, kernel, or framework setting pushes a single FP8 70B stream past ~48 tok/s on one H100 — you can only get closer to the ceiling (good engines reach 80–90% of it). At that rate the GPU delivers 48 × 140 GFLOPs ≈ 6.7 TFLOPS of its 1,979 TFLOPS FP8 peak: **0.3% compute utilization**. The remaining 99.7% is the raw material every batching and speculation trick harvests.

**Decode at batch size B.** The same weight read now serves B sequences: FLOPs scale with B, weight bytes don't. Arithmetic intensity ≈ `2B` FLOPs per weight-byte, so decode crosses into compute-bound territory around `B ≈ balance / 2` — roughly 150 concurrent sequences for BF16, ~300 for FP8, before accounting for KV-cache reads (which push the crossover higher, since each sequence brings its own KV traffic that doesn't amortize).

**Prefill.** Processing an N-token prompt is one forward pass over N tokens: `2 × P × N` FLOPs against one weight read. Intensity ≈ `2N` FLOPs/byte — a 1,000-token prompt is ~3.4× over the FP8 balance (~7× over BF16). Past a few hundred tokens, prefill saturates compute. This asymmetry — decode starves compute, prefill saturates it — is the root cause of chunked prefill (cap prefill chunks so co-scheduled decodes aren't stalled) and ultimately of disaggregated serving, covered below.

Speculative decoding is the same arithmetic exploited from another angle: a small draft model proposes k tokens, and the large model *verifies all k in one forward pass* — one weight read amortized over k tokens, exactly like batching, but within a single stream. That is why speculation helps most at low batch (spare compute everywhere) and fades at high batch (compute already spoken for).

---

## The KV-Cache Ledger

Attention requires every past token's key and value vectors. Recomputing them each step would make generation quadratic, so engines cache them — and the cache competes with weights for both HBM *capacity* and HBM *bandwidth*.

Per-token size for a grouped-query attention (GQA) model:

```text
KV bytes/token = 2 (K and V) × layers × kv_heads × head_dim × bytes/param

Llama-3-70B (80 layers, 8 KV heads, head_dim 128, BF16):
  2 × 80 × 8 × 128 × 2 ≈ 320 KB per token
  → a 128K-context sequence holds ≈ 40 GB of KV — half an H100.
```

(The full sizing table, PagedAttention's role in eliminating fragmentation, and capacity planning live in [Model Serving](../16-ml-systems/03-model-serving.md).)

The capacity story is well known; the *bandwidth* story is the one that surprises. During decode, each step reads the sequence's entire KV cache in addition to the weights. A batch of 32 sequences at 16K tokens each carries `32 × 16,384 × 320 KB ≈ 168 GB` of KV — read *every step*, dwarfing the 70 GB weight read. Long contexts therefore lower the tokens/sec ceiling even when everything fits: the bytes-per-token denominator grows with context length. This is why GQA (8 KV heads instead of 64 cuts KV 8×), DeepSeek's multi-head latent attention (MLA, which compresses KV into a low-rank latent), and FP8 KV caches are *throughput* features, not just capacity features — and why the prefix-caching discipline in [Context Management](./08-context-management.md) has a hardware-level mirror: a cached prefix is KV the GPU neither recomputes nor re-stores.

---

## Kernels: FlashAttention and the Memory Hierarchy

The roofline logic recurses one level down. Inside the GPU, the hierarchy is HBM (TB/s, tens of GB) → L2 (~50 MB) → SRAM/shared memory per streaming multiprocessor (~228 KB on H100, ~20 TB/s aggregate). Kernels are fast when they keep intermediate results in SRAM and touch HBM once.

Naive attention materializes the N×N score matrix in HBM:

```text
One layer, one head, N = 8,192, BF16:
  S = QKᵀ: 8192² × 2 B ≈ 134 MB written to HBM, read back for softmax,
  written again, read again for ×V — ≈ 0.5 GB of HBM traffic per head,
  × 64 heads × 80 layers ≈ multiple TB per single forward pass. Unusable.
```

FlashAttention (Dao et al., 2022; v2 2023; v3 2024 for Hopper) tiles Q, K, V into SRAM-sized blocks and computes softmax incrementally (online softmax), so the N×N matrix *never exists in HBM*. HBM traffic drops from O(N²) to O(N) — with FLOPs unchanged. It is the canonical example of the chapter's thesis: a "faster" kernel that does the same math but moves fewer bytes. FlashAttention-3 adds Hopper-specific asynchrony (overlapping tensor-core matmuls with softmax on separate warps) and native FP8 support.

Two other kernel-level facts matter operationally:

- **Kernel launch overhead is a decode tax.** A decode step is thousands of tiny kernels; at ~5 μs launch overhead each, the CPU can become the bottleneck. CUDA graphs record the whole step once and replay it as a single launch — vLLM and TensorRT-LLM enable this by default, and it is a large fraction of their small-batch advantage over naive PyTorch loops.
- **Attention kernels are now a pluggable layer.** FlashInfer, FlashAttention, and TensorRT-LLM's fused kernels compete on paged-KV layouts, GQA specialization, and speculative-verification shapes; engines swap them per model and hardware. When a new model architecture underperforms, a missing specialized kernel is the usual suspect.

---

## Batching Economics

Batching converts idle compute into throughput, at the price of per-stream latency. The trade is worth quantifying before tuning:

```python
# Decode-step time vs batch size, H100 FP8, 70B dense model, 8K avg context
BW, COMPUTE = 3.35e12, 1979e12          # bytes/s, FLOPs/s
W, KV_TOK   = 70e9, 160e3               # weight bytes, FP8 KV bytes/token

def step_time(batch, ctx=8192):
    bytes_moved = W + batch * ctx * KV_TOK
    flops       = batch * 2 * 70e9
    return max(bytes_moved / BW, flops / COMPUTE)   # roofline: slower side wins

for b in (1, 8, 32, 128):
    t = step_time(b)
    print(f"batch {b:>3}: {b/t:>6.0f} tok/s total, {1/t:>5.1f} tok/s per stream")

# batch   1:     47 tok/s total,  47.0 tok/s per stream
# batch   8:    333 tok/s total,  41.6 tok/s per stream
# batch  32:    958 tok/s total,  29.9 tok/s per stream
# batch 128:   1803 tok/s total,  14.1 tok/s per stream
```

Total throughput rises steeply (the weight read amortizes) while per-stream speed — each user's inter-token latency — degrades as KV traffic comes to dominate. Cost per token falls in proportion to total throughput: at ~$2/hr for an H100, batch 1 costs ~$12 per million output tokens, batch 128 about $0.31. This is the entire economic engine of inference providers, and the reason *goodput* — throughput that meets the latency SLO — is the correct objective, not raw tokens/sec. Continuous batching (admitting and retiring sequences every step rather than per-batch) is what keeps real batches full; the scheduling mechanics are in [LLM Infrastructure](./05-llm-infrastructure.md).

The operational failure is tuning throughput past the SLO cliff: a config that wins the benchmark at batch 256 while every user's inter-token latency sits at 70 ms. Set the SLO first (e.g., TTFT < 1 s, inter-token < 40 ms), then find the largest batch that honors it.

---

## Quantization: Halve the Bytes, Double the Ceiling

Because decode time is `bytes ÷ bandwidth`, weight precision converts directly into speed — every halving of bytes-per-parameter roughly doubles the single-stream ceiling and doubles how much model fits per GPU:

| Format | Bytes/param | 70B weights | H100 1-stream ceiling | Quality cost (typical) |
|---|---|---|---|---|
| BF16 | 2.0 | 140 GB (2 GPUs) | ~24 tok/s | baseline |
| FP8 (E4M3) | 1.0 | 70 GB | ~48 tok/s | negligible on Hopper+; near-universal in production |
| INT4 weight-only (AWQ/GPTQ) | 0.5 | 35 GB | ~96 tok/s | small but real; concentrates in math, code, long-tail knowledge |
| FP4 (NVFP4/MXFP4, Blackwell) | 0.5 | 35 GB | ~2× FP8 on B200 | with FP4 tensor cores, compute drops too; QAT closing the gap |

The mechanics differ in where the savings land. FP8 runs on Hopper/Blackwell tensor cores natively — fewer bytes *and* double compute. INT4 weight-only quantization (AWQ, GPTQ) stores weights in 4 bits but dequantizes to 16-bit for the multiply: pure bandwidth savings, ideal for the memory-bound decode regime, no help for compute-bound prefill. Blackwell's FP4 tensor cores make 4-bit a first-class compute format — OpenAI's gpt-oss shipped with MXFP4 weights natively, a signal of where open-weight serving defaults are heading. KV caches quantize too (FP8 KV is routine, cutting the per-token ledger above in half), which matters exactly in the long-context regime where KV dominates the bandwidth budget.

The governing rule from [Model Serving](../16-ml-systems/03-model-serving.md) applies with extra force here: perplexity hides quantization damage. A 4-bit model can match BF16 perplexity while dropping several points on GSM8K or code-generation suites, because the loss concentrates in exactly the narrow distributions those tasks exercise. Gate quantized rollouts on *your* task evals, and A/B them like any model change ([LLM Evaluation](./10-llm-evaluation.md)).

---

## Parallelism: TP, PP, EP

When the model outgrows one GPU — in capacity or in required ceiling — you split it. The three axes have sharply different communication profiles:

**Tensor parallelism (TP)** slices every weight matrix across GPUs; each layer ends with an all-reduce to combine partial results. Two all-reduces per layer, every token, means TP is only viable inside a high-bandwidth domain — NVLink at 900 GB/s, not PCIe or Ethernet. On H100/H200-class systems the NVSwitch domain is 8 GPUs, which is why "TP=8" is the standard wide configuration; rack-scale NVL72 systems (72 Blackwell GPUs in one NVLink domain) relax the boundary, but the principle stands: *TP stops at the NVLink domain edge*. The payoff is that TP shards the bandwidth problem too — 8 GPUs stream 1/8th of the weights each, multiplying the single-stream ceiling by nearly 8.

**Pipeline parallelism (PP)** assigns contiguous layer blocks to different GPUs; only activations (megabytes, not gigabytes) cross the boundary, so PP tolerates ordinary interconnects and spans nodes. The cost is pipeline bubbles — stages idling while waiting for each other — which decode's one-token-at-a-time cadence makes hard to fill. Typical large deployments compose both: TP=8 within each node, PP across nodes.

**Expert parallelism (EP)** is the MoE-specific axis: distribute experts across GPUs and route tokens to their assigned experts' hosts. DeepSeek-V3/R1 is the reference design — 671B total parameters but only ~37B active per token (1 shared + 8 of 256 routed experts):

```text
Dense 671B, FP8, hypothetical: 671 GB per token per step  → ~5 tok/s ceiling on H100 BW
MoE 671B/37B active:          ~37 GB of expert+shared weights per token
                              → the ceiling of a 37B model, with 671B of capacity
```

The catch: *which* 37 GB differs per token. At small batch, each GPU still holds its full expert shard but serves few tokens — capacity cost without amortization. At large batch, every expert sees traffic and the all-to-all dispatch/combine communication becomes the dominant cost. MoE economics only work at scale, which is why wide-EP deployments (DeepSeek's own serving runs prefill groups of dozens of GPUs) and expert-load balancing (auxiliary losses at training time, redundant hot experts at serving time) are inseparable from the architecture.

---

## Disaggregation: Splitting Prefill from Decode

Prefill and decode fight when co-scheduled: a long prefill stalls every decode in the batch (inter-token latency spikes), and decode's memory-bound steps waste the compute a prefill could use. Chunked prefill softens the interference; *disaggregated serving* removes it — separate GPU pools for prefill and decode, with the prompt's KV cache shipped from one to the other (DistServe made the goodput case; Mooncake runs it at scale for Kimi; NVIDIA Dynamo productizes it; vLLM and SGLang both support it).

The KV transfer is the engineering crux: tens of GB per long prompt, moved over NVLink or RDMA (NIXL is the transport layer in Dynamo; LMCache plays the same role for vLLM), hidden behind layer-by-layer streaming so decode starts before the transfer finishes. The wins compound with *tiered KV caching* — HBM for hot prefixes, DRAM and SSD behind it — because a shared multi-turn system prompt or a long document re-queried across sessions is prefill you never redo. Mooncake reports the majority of its production tokens are served from cache rather than recomputed.

Disaggregation also unlocks *heterogeneous* fleets: prefill wants compute (Blackwell), decode wants bandwidth and capacity (H200 is a decode machine by construction). Sizing the two pools independently against your traffic's prefill:decode ratio is a capacity-planning exercise straight out of [ML Capacity & Cost Planning](../16-ml-systems/14-ml-capacity-cost-planning.md); the operator's view of these platforms is the [LLM Inference Platforms case study](../08-case-studies/13-llm-inference-platforms.md).

---

## Constrained Decoding Is (Almost) Free

Structured outputs — JSON schemas, tool-call grammars — are enforced by masking invalid tokens at each decode step. The naive cost model says "checking 128K vocabulary entries against a grammar every token must be slow"; the actual systems make it nearly free. xgrammar (used by vLLM and SGLang) compiles the grammar ahead of time into a pushdown automaton, precomputes context-independent token masks, and overlaps the remaining mask computation with the GPU's forward pass — the mask is ready before the logits are. SGLang's jump-forward decoding goes further: when the grammar permits exactly one continuation (the fixed keys and punctuation of a JSON schema), it appends those tokens *without running the model at all*, turning structure into a speedup rather than a tax. The residual cost cases are large dynamically-generated schemas (compilation can't be amortized) and highly ambiguous grammars (masks stay context-dependent). If structured-output latency hurts, the schema — not the GPU — is usually what needs optimizing.

---

## Measuring It: The Metrics That Map to the Roofline

Each serving metric corresponds to a hardware regime, which is what makes them diagnostic rather than decorative:

- **TTFT (time to first token)** — prefill latency: compute-bound, scales with prompt length, improved by more FLOPs, chunking policy, and prefix-cache hits.
- **TPOT / ITL (time per output token / inter-token latency)** — decode: bandwidth-bound, degraded by batch size and long contexts, improved by quantization, TP width, and speculation.
- **Throughput (tok/s per GPU)** — the amortization metric; meaningless without the latency it was bought at.
- **Goodput** — throughput within SLO. The only number that belongs in a capacity plan.

Benchmark with the workload's real shape: `vllm bench serve` and NVIDIA's genai-perf both replay prompt/output length distributions and measure percentile TTFT/ITL; MLPerf Inference provides the cross-vendor reference points. The classic pitfalls are all distribution mismatches — fixed-length synthetic prompts (hides chunked-prefill interference and KV pressure), ignoring prefix-cache hit rates (production hit rates of 50%+ change TTFT entirely), and reporting mean rather than p99 ITL (the stall a user actually notices). Percentile discipline and load-testing method are the same as any latency-sensitive service ([Capacity Planning](../01-foundations/10-capacity-planning.md)).

---

## Failure Modes

**KV pressure cascades.** Memory fills with cached sequences → the scheduler preempts one, evicting its KV → the sequence later resumes with a full re-prefill → which adds compute load and evicts someone else. Symptom: throughput collapses and TTFT spikes under load that "should fit." Watch preemption/eviction counters, cap max concurrent sequences below the OOM line, and quantize KV before buying GPUs.

**TP across a slow interconnect.** Tensor parallelism over PCIe or across nodes turns two all-reduces per layer into the bottleneck; the deployment "works" at a fraction of expected throughput. TP inside the NVLink domain, PP across it — measured all-reduce latency tells you which side of the line you're on.

**The quantization eval gap.** The INT4 model matches perplexity, passes the smoke test, ships — and a week later math-heavy or code-heavy traffic shows a regression no serving metric caught. Quality gates must be task evals, run per quantization artifact, not per model family.

**Throughput tuning past the SLO.** Benchmarks reward batch sizes and chunk sizes that a p99 inter-token SLO forbids. Any tok/s figure quoted without its latency percentile is a red flag in a design review.

**Long-context surprise.** A feature raises average context from 4K to 64K; per-token KV traffic grows 16×, the decode ceiling drops, and the fleet sized for 4K saturates. Context-length distribution is a first-class capacity input, same as QPS.

**Straggler experts.** In MoE serving, a hot expert (or a slow GPU hosting one) gates every token in the all-to-all; p99 latency degrades fleet-wide. Requires per-expert load metrics and redundant placement of hot experts.

---

## Decision Framework

| Situation | Reach for |
|---|---|
| Single-stream latency matters most (interactive agents) | FP8/INT4 weights, TP up to the NVLink domain, speculative decoding |
| Throughput/cost matters most (batch, evals, backfill) | Large-batch continuous batching, batch APIs, MoE models |
| Long contexts dominate | GQA/MLA models, FP8 KV, prefix caching, H200-class bandwidth |
| Model fits one GPU | No TP — parallelism you don't need is pure overhead |
| Model > 1 GPU, ≤ 1 node | TP within NVLink |
| Model > 1 node | TP=8 + PP across nodes; EP if MoE |
| Mixed prefill/decode interference at scale | Chunked prefill first; disaggregation when the fleet is large enough to split |
| Deciding whether to buy compute or bandwidth | Prefill-heavy → compute (B200); decode-heavy → bandwidth/capacity (H200) |

---

## Key Takeaways

1. **Decode is memory-bound; prefill is compute-bound.** One sentence explains most of inference engineering. Compute the machine balance and the bytes-per-token before trusting any benchmark.
2. **The single-stream ceiling is `bandwidth ÷ bytes per token`.** ~48 tok/s for FP8-70B on one H100 — everything else is about getting close to it or amortizing past it.
3. **Batching, speculation, and quantization are the same move** — more useful work per byte of HBM traffic — applied to concurrency, single streams, and the bytes themselves.
4. **KV cache is a bandwidth problem, not just a capacity problem.** Long contexts lower the tokens/sec ceiling; GQA/MLA and FP8 KV are throughput features.
5. **Parallelism follows the interconnect**: TP inside NVLink, PP across nodes, EP for MoE — and MoE only pays at batch scale.
6. **Goodput is the objective.** Set latency SLOs first, then maximize throughput inside them; report percentiles, never means.
7. **Quantize aggressively, gate on task evals.** Perplexity will not tell you what INT4 broke.

## References

- Williams, Waterman & Patterson — *Roofline: An Insightful Visual Performance Model* (2009)
- Dao et al. — *FlashAttention* (2022), *FlashAttention-2* (2023); Shah et al. — *FlashAttention-3* (2024)
- Kwon et al. — *Efficient Memory Management for LLM Serving with PagedAttention* (vLLM, 2023)
- Zhong et al. — *DistServe: Disaggregating Prefill and Decoding* (2024)
- Qin et al. — *Mooncake: A KVCache-centric Disaggregated Architecture* (2024)
- DeepSeek-AI — *DeepSeek-V3 Technical Report* (2024)
- Leviathan et al. — *Fast Inference via Speculative Decoding* (2023)
- Dong et al. — *XGrammar: Flexible and Efficient Structured Generation* (2024)
- NVIDIA H100/H200/B200 datasheets; NVIDIA Dynamo architecture documentation
- MLPerf Inference results (mlcommons.org); vLLM, SGLang, TensorRT-LLM documentation
- [Attention & Transformers](../09-whitepapers/15-attention-transformers.md) — the architecture this chapter serves
