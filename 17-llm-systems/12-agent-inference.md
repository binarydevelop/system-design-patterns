# Agent Inference: Serving Multi-Step LLM Workloads

## TL;DR

An agent loop is not a chat request repeated N times — it is a distinctive inference workload: input-heavy (each step re-sends a growing, mostly-shared transcript), prefix-redundant across steps and across sibling subagents, sequential rather than parallel within a task, and bursty at the fleet level when orchestrators fan out. None of the serving levers change — caching, batching, speculation, disaggregation are all still the mechanisms — but *which lever matters and how you tune it* changes once the unit of work is a multi-step session instead of a single request. The hardware arithmetic behind those levers lives in [GPU Inference Internals](./11-gpu-inference-internals.md); the engine mechanisms that implement them (RadixAttention, disaggregated prefill/decode, speculative decoding) live in [LLM Infrastructure](./05-llm-infrastructure.md); the client-side discipline of shaping the transcript itself — the cost triangle, prefix-caching rules, compaction — lives in [Context Management](./08-context-management.md). This chapter is the session- and fleet-level view: what an operator does differently when the traffic hitting the serving stack is agents rather than chat.

---

## The Agent Workload Shape

Chat traffic is roughly one prompt in, one response out, independent across requests. Agent traffic looks different on every axis a scheduler cares about:

| Property | Chat | Agent loop |
|---|---|---|
| Requests per task | 1 | 10s–100s (one per step) |
| Prefix reuse across requests | Low (new conversation) | Very high (steps N and N+1 share everything before the newest turn) |
| Input:output ratio | Often near 1:1 | Often 50:1–100:1 (transcript dominates, output is one action) |
| Idle time between model calls | None | Seconds (tool execution: shell, search, code run) |
| Latency contract | Per-request TTFT/ITL | Per-*task* deadline, spread across many requests |
| Burstiness | Smooth, per-user | Spiky: one orchestrator call fans out to N parallel subagent calls |

Two consequences follow immediately. First, the per-step token histogram is the opposite of chat's: a 40K-token step that adds 200 output tokens is normal, so a scheduler tuned on chat's assumptions (roughly symmetric input/output) will misjudge agent request cost. Second, the gaps between model calls — the tool executing a shell command, hitting an API, running a test suite — are dead time from the model server's perspective but a live decision point for the scheduler: does it hold the session's state (KV cache, connection, priority) or release it for other traffic? The rest of this chapter is mostly about that one decision, made concrete in different subsystems. The transcript-growth mechanics that produce this shape — the append-only history, the quadratic cost of an uncached loop — are derived with a full worked example in [Context Management](./08-context-management.md#token-economics-the-bill-is-shaped-like-a-triangle); this chapter starts from that shape as a given and asks what the *serving fleet* should do about it.

---

## Unit Economics at the Fleet Level

[Context Management](./08-context-management.md#token-economics-the-bill-is-shaped-like-a-triangle) already derives the client-side arithmetic: an N-step agent task without caching costs quadratically more than one with it, because each step re-sends the growing transcript. That result is the input to this section, not something to re-derive. The fleet-operator questions are different: given that shape, how do you plan capacity and price a task?

**Cost-per-task, not cost-per-token, is the capacity primitive.** A chat fleet sizes against tokens/sec. An agent fleet's actual unit of work is the task — N steps, a prefix that grows by roughly the same amount each step, a cache-hit profile that depends on whether the routing layer kept the session's KV warm. Two fleets serving the identical total token volume can have wildly different GPU-hour costs if one serves it as 10,000 independent 1-step chats and the other as 100 hundred-step agent tasks, because the second profile lives or dies on cache reuse:

```text
Fleet sizing input: 5,000 agent tasks/day, avg 30 steps/task, prefix grows ~3K tok/step
Total tokens/day (uncached-equivalent) ≈ 5,000 × 3K × (30×31/2) ≈ 7.0B token-equivalents
At a 90% steady-state cache-hit rate (typical for a sticky-routed fleet): effective
prefill load ≈ 0.7B token-equivalents — a 10x difference in required prefill GPU-hours
between a fleet that keeps sessions cache-affine and one that doesn't.
```

That 10x is the entire capacity-planning question for an agent fleet: the GPU-hour estimate is dominated by the assumed cache-hit rate, and the cache-hit rate is a routing and retention *policy*, not a property of the traffic. Translating a target tasks/day and steps/task into GPU-hours or provider spend, under a stated cache-hit assumption, is the same exercise as any other headroom calculation in [ML Capacity and Cost Planning](../16-ml-systems/14-ml-capacity-cost-planning.md) — the agent-specific input is just that the cache-hit rate has to be modeled explicitly rather than assumed constant.

**The cache-write premium interacts with tool latency, not just step count.** Provider prompt caches carry a write premium (commonly ~1.25× the fresh-input price for a 5-minute TTL, ~2× for a 1-hour TTL) and cached reads at a fraction of fresh price (~0.1×) regardless of tier. An agent step that waits on a slow tool — a build, a long-running query, a human-in-the-loop pause — risks the 5-minute cache expiring before the next model call, converting *that step* back to a full-price prefill of the accumulated transcript plus a fresh write:

```text
If tool-wait time distribution has P(wait > 5 min) = p, then expected cache-adjusted
cost per step ≈ (1 - p) × (cached_prefix + write_premium_5m × increment)
              + p × (fresh_prefix + write_premium_5m × prefix).
Moving to the 1-hour tier avoids the expiry cost but pays its higher write premium on
every write regardless of p. The two tiers break even at a p* that scales with the
increment-to-prefix ratio (Δ/P) — for typical agent loops, where each step adds a small
increment to a much larger accumulated prefix (Δ/P well under 0.2 after a few steps),
p* works out well under 10%: most agent workloads with any long-running tools clear the
break-even for the longer TTL.
```

This is a policy decision the routing layer should make per-workload (interactive coding agent vs. long-running research agent), not a global default — a fleet running both should not pin the same TTL to each.

**Aggregate session state, not aggregate throughput, sizes the fleet.** A hundred concurrent agent sessions each holding a 50K-token cached prefix is 5M tokens of KV resident in the fleet at once — independent of how many tokens/sec any of them is currently generating (most are idle, waiting on a tool). The binding constraint for an agent-heavy fleet is frequently HBM (or tiered-KV DRAM/SSD) occupied by *idle* sessions' cached prefixes, not compute or bandwidth spent on active decode. Sizing for concurrent-session KV footprint, separately from sizing for active-decode throughput, is the agent-specific line item that a chat-only capacity model omits entirely.

---

## Routing and Session Affinity

Prefix caching and tiered KV storage are engine mechanisms, covered in [LLM Infrastructure](./05-llm-infrastructure.md#inside-a-modern-inference-engine) (RadixAttention, HBM→DRAM→SSD tiering); re-prefill cost arithmetic is covered in [GPU Inference Internals](./11-gpu-inference-internals.md#the-kv-cache-ledger). What those chapters don't cover is the operator decision an agent workload forces: an agent session is a *multi-request relationship with a specific replica's cache*, and every routing decision either protects or destroys that relationship.

**Sticky vs. cache-aware routing.** Two policies compete for the same problem:

- *Session-hash affinity* (route by session ID to the same replica every time) is simple and cheap to implement but blind to load — if a session lands on a replica that's already hot, affinity pins it there anyway, and a burst of long-running sessions can concentrate on a handful of replicas while others idle.
- *Cache-aware / prefix-tree-aware load balancing* (SGLang's cache-aware router, similar logic in other RadixAttention-based schedulers) tracks which replicas hold which prefixes and routes new requests toward the replica most likely to already have the longest matching prefix cached, falling back to load-based routing when no replica has a useful match.

The failure mode of pure hash affinity is a hot replica that affinity won't route around. The failure mode of pure cache-aware routing with no affinity floor is cache churn: under load, the router may occasionally send a session's next step to a different, less-loaded replica that doesn't have its prefix, converting a cache hit into a full re-prefill for load-balancing reasons that had nothing to do with the session itself. Production routers combine both: prefer the affine replica up to a load threshold, fall back to cache-aware selection beyond it.

**The failover ledger.** When a session's replica dies, restarts, or is drained (a routine event at fleet scale — deploys, autoscaling, spot preemption), the session's KV cache is gone, and the next step pays a full re-prefill of everything accumulated so far. Quantified against the prefill numbers in [GPU Inference Internals](./11-gpu-inference-internals.md#roofline-why-decode-is-memory-bound): a session 40 steps into a task with a 120K-token accumulated transcript loses a compute-bound prefill on the order of seconds, not milliseconds — and that cost is paid by exactly the sessions that have invested the most, since prefix length grows with step count. A fleet's failover cost is therefore concentrated in its longest-running, most-valuable sessions, which is the opposite of where chat failover cost concentrates (uniformly small, since chat requests don't accumulate state).

**Hold-vs-release KV during tool waits.** While a session waits on a tool call, its KV occupies HBM (or a cache tier) doing nothing. Holding it guarantees the next step is a cache hit; releasing it (demoting to a cheaper tier, or evicting outright under memory pressure) frees capacity for other traffic but converts the session's next step into a partial or full re-prefill. The right policy is a function of the tool-wait distribution from the previous section: short, predictable waits (a fast API call) favor holding; long or unbounded waits (a human-in-the-loop approval, an async batch job) favor demoting to a cheaper tier rather than holding premium HBM hostage to an indefinite pause.

**Affinity vs. load-balance tension.** A single long agent session that stays affine to one replica for its entire lifetime is, from that replica's perspective, a slowly-growing KV tenant that never leaves — the same replica-hot-spotting problem that any sticky-session system faces, but sharper here because the "session" can run for hours and its KV footprint grows monotonically. Capacity headroom per replica needs to account for a small number of very long sessions consuming disproportionate KV, not just an even distribution of request rate.

---

## Per-Step Latency Budget

A chat request's latency is TTFT plus decode time for one response. A task's latency is the sum across every step:

```text
Task latency ≈ Σ_i (TTFT_i + k_i · ITL_i + tool_time_i)   for i = 1..N steps
```

Three things fall out of that sum that don't matter for a single request:

**TTFT compounds instead of paying once.** A chat user pays prefill latency once per conversation turn they're actively waiting on. An agent task pays it N times, and because the transcript grows each step, later TTFTs are larger than earlier ones even with prefix caching (the *uncached increment* — this step's new tokens — still has to be prefilled fresh every time). A task-level SLO ("finish in under 60 seconds") is a budget across all N steps, not a per-step number, which means the serving layer needs task-aware admission control, not just per-request rate limiting.

**Streaming and early dispatch hide tool latency inside model latency instead of adding to it.** If the harness streams tool-call arguments as they're generated and begins dispatching the tool call before the model has finished its full turn (as soon as a complete, valid tool-call object is available), the tool's latency overlaps with the tail of the model's decode instead of starting after it. Parallel tool calls in a single turn are the same idea one level up: dispatching several independent tool calls at once turns N sequential tool-wait periods into one, which is a latency win even though it doesn't change token counts at all.

**Extended thinking is a step-time variable the harness must bound.** Reasoning/thinking tokens are generated (and billed) before the visible action, and an unbounded thinking budget on a single step can consume most of a task's latency allowance on one decision. Per-step thinking-token caps are a latency-budget control, not just a cost control, in exactly the way output-length caps are for chat.

---

## Why Speculation Pays More for Agents

Speculative decoding itself — drafters, verification arithmetic, when it wins — is covered in [LLM Infrastructure](./05-llm-infrastructure.md#inside-a-modern-inference-engine) and in the single-forward-pass verification cost in [GPU Inference Internals](./11-gpu-inference-internals.md#roofline-why-decode-is-memory-bound). The mechanism doesn't change for agents; the payoff does, because agent output has a property chat output usually doesn't: **low entropy**.

A model emitting a tool-call argument object, rewriting a file with a small diff, or filling a fixed JSON schema is, token by token, far more predictable than a model writing open-ended prose — the next token is very often determined by the schema, the surrounding code, or the file being edited rather than genuinely uncertain. Speculative acceptance rate tracks predictability directly, so:

- **n-gram / prompt-lookup drafting is close to free and close to optimal** for the file-editing case specifically: when the agent is rewriting a file it has already read, the unmodified portions of the file *are* the draft — a lookup against the agent's own recent context proposes long, high-acceptance runs with no separate drafter model to serve or maintain.
- **EAGLE/Medusa-class drafters see higher acceptance on tool-call and code output** than on creative or conversational text, for the same reason chat traffic sees the least benefit from speculation of any workload.
- **Provider "predicted output" features** (submitting an expected output alongside the request, verified the same way as model-drafted speculation) are a managed version of exactly this, aimed squarely at the agent use case: rewriting a file with a known-similar draft.

The operational implication is that speculation should be enabled and tuned *per workload*, not fleet-wide with one setting: a fleet serving both open-ended chat and code-editing agents will see the code-editing traffic pull 2–3× speedup from a drafter that does almost nothing for the chat traffic, and sizing the drafter's own compute cost against a blended acceptance rate under-credits the agent share.

---

## Fan-Out: Multi-Agent Inference Economics

An orchestrator that spawns subagents multiplies the workload shape above rather than replacing it. Each subagent that receives a fresh context re-pays prefill for whatever the orchestrator hands it — its slice of the task, relevant files, the shared system prompt — so fan-out trades the orchestrator's context growth (the concern in [Context Management](./08-context-management.md#structure-the-context-for-the-agents-own-attention)) for N parallel prefill events at the serving layer.

**Orchestrator token amplification.** A single orchestrator turn that dispatches 5 subagents, each with a 20K-token context, generates roughly 100K tokens of prefill work from what looked like one decision — work that a single-agent loop would have spread across many sequential steps instead of one burst. This is a real cost, but it buys wall-clock time: 5 subagents running in parallel finish in roughly the time of one, at roughly 5× the token cost of one — the same throughput-for-latency trade covered generally in [Multi-Agent Systems](./03-multi-agent-systems.md) and [Orchestration Patterns](./02-orchestration-patterns.md), specialized here to what it costs the inference fleet specifically.

**Shared-prefix reuse across siblings is the lever that makes fan-out affordable.** If the orchestrator gives every subagent the same system prompt and the same base context (a shared codebase snapshot, a common instruction set) with only the per-subagent task description varying, a cache-aware router can serve all N subagents' prefill from one shared cached prefix rather than N independent ones — the fan-out pays for one prefill, not N, on the shared portion. This only works if the routing layer recognizes the shared prefix across concurrently-arriving requests and if the harness actually constructs subagent prompts with the shared material first and the divergent material last (the same prefix-ordering discipline as any cache-sensitive request, applied across siblings instead of across turns).

**Fan-out is burst load the scheduler has to absorb, not steady state.** N subagents dispatched at once look, from the serving layer's perspective, like a traffic spike with unusually high prefix overlap — very different from N independent users arriving at the same moment. A scheduler that treats it as ordinary burst traffic (spin up capacity, load-balance evenly) will scatter cache-sharing siblings across replicas and lose the reuse described above; one that recognizes sibling fan-out can intentionally co-locate the batch to capture it.

**When fan-out beats a longer single loop.** Parallel subagents win when subtasks are genuinely independent (so no step needs another's output before it can start) and the shared-prefix reuse above is available; they lose when the fan-out multiplies cost for a task that a single, more context-efficient loop would have solved sequentially at a fraction of the token cost. The architectural question of which pattern fits belongs to [Orchestration Patterns](./02-orchestration-patterns.md) and [Multi-Agent Systems](./03-multi-agent-systems.md); the point here is that the serving-cost side of that decision is dominated by whether prefix sharing across siblings is actually captured, not just by the step count.

---

## Serving Tiers for Agent Traffic

Agent traffic is not homogeneous, and treating it as one tier misprices most of it:

- **Interactive agents** (a user watching a coding agent or a chat-driven assistant) need the latency discipline of the previous sections: sticky/cache-aware routing, bounded per-step thinking budgets, task-level SLOs.
- **Background agents** (an agent working a queued task with no one watching in real time) can tolerate higher per-step latency in exchange for better batching and cheaper capacity — the same admission-control trade as any latency-insensitive queue.
- **Batch APIs** (evals, large-scale backfill, offline agent runs) fit agent workloads especially well precisely because agent prefixes repeat: a batch of similar tasks against a shared codebase or shared instructions is close to the ideal case for both provider batch discounts and cache reuse.

**Preemption cost scales with session age.** Preempting a fresh chat request costs almost nothing — a few hundred tokens of lost work. Preempting an agent session 60 steps in destroys a KV cache built from a compute-bound prefill accumulated over the entire task so far; the next admission of that session pays for all of it again. A preemption policy tuned on chat (roughly age-independent, evict whatever's convenient) systematically picks the most expensive thing to evict when applied to agent traffic. Age-aware preemption — preferring to evict short sessions over long ones, all else equal — is the agent-specific correction.

**Per-step timeout/retry semantics have to assume the loop, not the request.** A retry policy that resends a failed step's request is safe only if the step itself was idempotent — if the step included a tool call that already ran (a write, an email sent, a payment attempted), a naive retry re-executes it. This is the same idempotency discipline as any distributed retry ([Retries, Timeouts, and Hedging](../06-scaling/10-retries-timeouts-hedging.md); [Retry, Idempotency, and Compensation](../18-workflow-job-systems/06-retry-idempotency-compensation.md)), but agent loops make the failure mode easy to miss because the "request" being retried is one LLM call embedded in a longer, stateful task — retrying the call is cheap and looks safe even when retrying the *step's side effects* is not.

---

## Measuring Agent Inference

Per-request metrics — the ones [GPU Inference Internals](./11-gpu-inference-internals.md#measuring-it-the-metrics-that-map-to-the-roofline) defines for chat and batch traffic — still apply to each individual model call an agent makes, but they don't answer the questions that matter for the workload as a whole:

- **Cache hit rate per session**, not per request. A session with an 80% average hit rate across its lifetime can still have failed on step 12 specifically (a routing miss, a TTL expiry) — session-level tracking catches the sessions being systematically failed by routing that request-level aggregates smooth over.
- **Cost per task**, aggregated across every step and every subagent fan-out the task triggered — the number that should actually appear on a capacity plan or a pricing model, not cost per token or per request.
- **Task-level goodput**: tasks completed within their end-to-end deadline, divided by tasks attempted — the task-level analog of the per-request goodput metric in ch. 11, and the only throughput number that reflects whether the fleet is actually serving the product's latency contract.
- **p99 step TTFT**, tracked per step-index within a task if volume allows: since transcripts grow across steps, step 40's TTFT distribution is not the same population as step 2's, and averaging them together hides degradation that only shows up late in long tasks.

The general lesson from ch. 11 — report percentiles tied to the actual latency contract, not fleet-wide averages — applies here with an extra dimension: the contract is per-task, and the population that matters shifts as sessions age.

---

## Failure Modes

**Load balancer scattering a session across replicas.** A router with no affinity floor sends a session's consecutive steps to different replicas under load. Every replica reports healthy, aggregate throughput looks fine, and the only visible symptom is the fleet's cache-hit rate quietly collapsing — an incident that most dashboards built for chat traffic won't surface, because they don't track hit rate as a function of session continuity.

**Subagent storm evicting the fleet-wide prefix cache.** A large fan-out (an orchestrator spawning dozens of subagents at once, or many users triggering fan-out concurrently) floods every replica with fresh, mutually-unrelated prefixes, evicting the warm prefixes of unrelated long-running sessions in the process. The result is a burst of subagent traffic degrading the latency of sessions that had nothing to do with it. Capacity headroom for fan-out bursts needs to be planned separately from steady-state session capacity, the same way any noisy-neighbor problem is.

**Retry-without-idempotency doubling task spend (and worse, side effects).** A step that times out and gets retried, where the underlying tool call already completed, both re-runs the side effect and pays for the LLM call twice. At the fleet-cost level this is invisible in per-request metrics and only shows up as unexplained cost-per-task drift; at the correctness level it can be a duplicated write.

**Thinking-budget runaway.** One step's reasoning stream runs far longer than typical, consuming most of the task's latency budget and pinning a decode slot for an outsized duration — degrading not just that task but, at high concurrency, the replica's service to every other session sharing it.

**Preemption of aged sessions cascading into re-prefill load.** The same KV-pressure cascade described in [GPU Inference Internals](./11-gpu-inference-internals.md#failure-modes) — memory fills, the scheduler preempts, the evicted sequence later re-prefills, adding load that evicts someone else — is worse for agent traffic specifically because the sessions most likely to be evicted under naive (age-blind) preemption are exactly the long, high-value ones with the most accumulated prefix to lose.

---

## Decision Framework

| Situation | Reach for |
|---|---|
| Interactive agent, user watching | Cache-aware sticky routing with an affinity floor, bounded per-step thinking, task-level SLO admission control |
| Background/queued agent work | Looser latency tolerance, batch-friendly scheduling, standard (non-affinity-floored) load balancing |
| Evals, backfill, offline agent runs | Provider batch APIs; the shared-prefix, shared-instructions case they're built for |
| Long tool-wait steps common (build, human approval, async job) | Demote KV to a cheaper tier during the wait rather than holding premium HBM; consider the 1-hour cache TTL tier |
| Fan-out with a shared base context across subagents | Construct shared material first / divergent material last in every subagent prompt; verify the router is capturing sibling cache reuse |
| Agent output is schema-fixed or file-rewrite-shaped (tool calls, diffs) | Enable speculation per-workload — n-gram/prompt-lookup drafting or predicted outputs, not just a fleet-wide drafter tuned on chat |
| Sizing the fleet | Model cache-hit rate explicitly as a policy input to GPU-hour estimates; size KV footprint for concurrent idle sessions, not just active decode throughput |
| Choosing a preemption policy | Age-aware eviction (protect long sessions) instead of age-blind convenience eviction |

---

## Key Takeaways

1. **Agents are a distinct workload shape, not chat repeated.** Input-heavy, prefix-redundant across steps and siblings, sequential per task, bursty at the fleet level — every lever below follows from this shape.
2. **Cache-hit rate is a policy, not a traffic property**, and it dominates fleet sizing: a 10x swing in required prefill capacity between a cache-affine fleet and one that isn't is the normal range, not an edge case.
3. **The cache-write premium and TTL interact with tool latency.** Model the P(tool wait exceeds the cache TTL) explicitly per workload before picking a TTL tier.
4. **Routing is the load-bearing decision an agent fleet makes that a chat fleet doesn't**: sticky vs. cache-aware routing, the failover ledger, and hold-vs-release KV during tool waits all follow from treating a session as a multi-request relationship with a replica's cache.
5. **Task latency is a sum across steps, not one number** — TTFT compounds, streaming and parallel tool calls are latency levers, and thinking budgets need per-step caps.
6. **Speculation pays more for agents** because tool-call and file-edit output is low-entropy; tune it per-workload rather than fleet-wide.
7. **Fan-out multiplies prefill cost for parallelism**, and the entire economics hinges on whether the router captures shared-prefix reuse across siblings.
8. **Preemption and retry policy both need to be age/state-aware**: evicting or retrying an agent step is not the cheap, uniform operation it is for a chat request.
9. **Measure at the session and task level**, not just per-request — cache hit rate per session, cost per task, task-level goodput, and step-indexed p99 TTFT are the metrics that actually diagnose agent-serving health.

## References

- Zheng et al. — *SGLang: Efficient Execution of Structured Language Model Programs* (2024) — RadixAttention and cache-aware load balancing
- Zhong et al. — *DistServe: Disaggregating Prefill and Decoding* (2024)
- Qin et al. — *Mooncake: A KVCache-centric Disaggregated Architecture* (2024)
- Leviathan et al. — *Fast Inference via Speculative Decoding* (2023); Cai et al. — *Medusa* (2024); Li et al. — *EAGLE* (2024)
- [Prompt Caching — Anthropic Documentation](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) — TTL tiers, write premiums
- [Effective Context Engineering for AI Agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) — Anthropic, 2025
- [Multi-Agent Research System](https://www.anthropic.com/engineering/multi-agent-research-system) — Anthropic, 2025 — orchestrator/subagent token economics
- [GPU Inference Internals](./11-gpu-inference-internals.md) — hardware roofline, KV-cache ledger, prefill/decode arithmetic
- [LLM Infrastructure](./05-llm-infrastructure.md) — serving engine mechanisms this chapter builds on
- [Context Management](./08-context-management.md) — client-side cost triangle and prefix-caching discipline this chapter builds on
