# Fine-Tuning Patterns

## TL;DR

Fine-tuning is the *last* tool in the adaptation toolbox, not the first — and the gap between it and the alternatives has widened every year as frontier models got better at following instructions, longer at context, and cheaper per cached token. The modern decision runs: prompting (with a strong model, good examples, and [structured outputs](./06-prompt-engineering.md)) → retrieval ([RAG](./04-rag-patterns.md), for knowledge) → and only then fine-tuning, which earns its keep for *behavior*, not knowledge: locking in style and format, distilling a frontier model's skill on a narrow task into a small cheap model, deep domain adaptation, and pushing tool-use or classification reliability past what prompting achieves. When you do tune, the practical stack has standardized: LoRA/QLoRA on an open-weights base for most cases (fractions of a percent of the parameters, one GPU, merge or hot-swap adapters at serving time), preference optimization (DPO and successors) rather than full RLHF for alignment-shaped goals, and evaluation infrastructure that exists *before* training starts — because the dominant failure mode is not underfitting, it is shipping a model you can't prove is better, trained on data you can't reproduce, into a serving stack that can't roll it back. Data quality decides outcomes: a thousand meticulously curated examples beat fifty thousand scraped ones, and the training-data pipeline inherits every discipline from [dataset versioning](../16-ml-systems/11-dataset-management-versioning.md).

---

## When to Fine-Tune (and When Not To)

The question arrives as "should we fine-tune?" and should be answered by walking a ladder in cost-of-ownership order:

**1. Prompting a frontier model.** With current instruction-following, few-shot examples, and schema-enforced outputs, prompting solves the large majority of "we need the model to do X our way" requests — at zero training cost, with instant iteration, and with prompt changes deployable in minutes. Long context plus [prompt caching](./08-context-management.md) also dissolved a classic fine-tuning motivation: stuffing stable domain reference material into a cached prefix costs ~0.1× input pricing per request, which is usually cheaper than a training program.

**2. RAG.** If the gap is *knowledge* — facts the model doesn't have, or facts that change — retrieval wins almost unconditionally: it updates in minutes (re-index) instead of weeks (re-train), it cites sources, and it respects per-user permissions. Fine-tuning is a terrible knowledge store: facts baked into weights go stale immediately, can't be attributed, can't be deleted per-tenant, and interact with the GDPR-style deletion problem (a model that memorized a user's data cannot un-memorize it by deleting a database row — see [ML risk & governance](../16-ml-systems/09-ml-risk-governance.md)).

**3. Fine-tuning.** What remains is *behavior and economics*, and here tuning is genuinely strong:

| Motivation | Why tuning wins | Typical shape |
|---|---|---|
| Style/format lock-in | Prompt tokens spent re-describing tone/format on every call become weights | 1–5K examples, SFT |
| Distillation for cost/latency | A small model matching the big one *on your task* serves at 5–20× less | Teacher generates 10–100K examples, student SFT |
| Deep domain adaptation | Vocabulary/conventions prompting can't fully instill (legal, medical, codebase-specific) | Continued pretraining + SFT |
| Reliability on a narrow task | Squeeze the last points of tool-call or classification accuracy | SFT on success traces, incl. failures-turned-corrections |
| Latency floors | Shorter prompts (no few-shot block) and smaller models cut TTFT | SFT replacing the prompt scaffolding |
| Open-weights ownership | No per-token vendor bill, data stays in-VPC, model is an asset | LoRA/full FT on Llama/Qwen/Mistral-class base |

The honest anti-checklist: don't tune to add facts (use RAG), don't tune what a better prompt fixes (run that experiment first — it's a day, not a quarter), don't tune without an eval set that would detect success (you won't be able to tell), and don't tune if you can't fund the *second* training run — data drifts, base models improve, and a one-off tuned model with no refresh pipeline is next year's stranded asset.

---

## The Method Landscape

### Supervised Fine-Tuning (SFT)

The workhorse: continue training the model on `(input → desired output)` pairs with the standard language-modeling loss (masking the loss on the prompt tokens so only the completion is learned). Everything else in this chapter is a variation on where the pairs come from and which parameters move.

### LoRA and QLoRA: The Default Mechanics

Full fine-tuning updates every weight — for a 70B model that means holding weights, gradients, and optimizer state for 70B parameters (roughly 500GB+ in mixed precision with Adam), i.e., a multi-node job. **LoRA** (Hu et al., 2021) observes that task adaptation lives in a low-rank subspace: freeze the base weights `W`, and learn a pair of small matrices `B·A` (rank r, typically 8–64) added to each attention/MLP projection:

```text
h = Wx + (α/r)·B·A·x        W frozen (d×d),  A: r×d,  B: d×r

7B model, r=16 on attention+MLP projections:
  trainable params ≈ 40–80M   (~1% of the model)
  optimizer state: ~1GB instead of ~84GB
  → one 24–48GB GPU trains what previously took a cluster
```

**QLoRA** (Dettmers et al., 2023) pushes the base model itself into 4-bit quantization (NF4) with the LoRA adapters trained in bf16 on top — a 70B base fits on a single 48GB card for training, at near-parity quality with 16-bit LoRA. The practical guidance that has settled out: apply adapters to all linear layers rather than just `q,v` projections; rank 16–32 covers most tasks (rank buys capacity slowly); learning rate ~1e-4 with the adapter, 10× lower if you unfreeze anything else; and expect the *data* to matter far more than any of these knobs.

At the end you either **merge** the adapter into the base weights (zero serving overhead, one artifact) or keep it separate — which enables the serving pattern below.

### Preference Optimization: DPO and Friends

SFT teaches the model what good outputs *look like*; preference methods teach it which of two outputs is *better* — the shape of alignment, helpfulness, and taste objectives where no single gold answer exists. Classic **RLHF** (reward model + PPO) delivered ChatGPT but is operationally heavy: four models in memory, RL instability, reward hacking. **DPO** (Rafailov et al., 2023) collapsed the pipeline: a closed-form loss trains directly on `(prompt, chosen, rejected)` triples — no reward model, no rollouts, roughly as easy to run as SFT — and it (plus successors like KTO, ORPO, and IPO) is now the default for preference-shaped goals outside frontier labs. **RLAIF / Constitutional AI** replaces human preference labels with AI feedback guided by written principles, which is how preference data scales past what human annotation budgets allow. For most application teams the recipe is: SFT on curated demonstrations first, then a DPO pass on preference pairs harvested from your own eval comparisons and user feedback.

**GRPO and verifiable-reward RL** — the technique behind reasoning models like DeepSeek-R1 — trains against *checkable* rewards (tests pass, answer matches) rather than learned preference models, and is worth knowing as the frontier of the field; few application teams run it, but "can I define a verifiable reward for my task?" is becoming a serious question for agentic fine-tunes.

### Distillation

The highest-ROI pattern in production today: use a frontier model (the teacher) to generate or grade tens of thousands of task-specific examples, then SFT a small open model (the student) on them. The student won't match the teacher in general — it will often match it *on your distribution*, at a fraction of the serving cost and latency. Two disciplines keep it honest: filter the teacher's outputs (grade them with the teacher itself or a judge, keep the top slice — quality in, quality out), and check the provider's terms of service, since some prohibit training competing models on their outputs. Distillation is also the standard escape hatch from per-token pricing: prototype on the frontier API, distill the stabilized behavior into a model you own.

---

## Data Is the Product

Every experienced team says the same thing: the model is a commodity; the training set is the asset. The disciplines:

**Curation beats volume.** The LIMA result (1K excellent examples producing a strong assistant) generalized: for behavior-shaped SFT, 500–5,000 meticulously curated examples routinely beat 50K scraped ones, because the model learns the *average* of what you show it — including the average sloppiness. Every example should be one you'd be happy to see verbatim in production.

**Mine production, then fix it.** The best source of training data is your own traces: real inputs, with outputs *corrected* by humans or by a stronger model. Failures from your [eval suite](./10-llm-evaluation.md) and user thumbs-downs, repaired into golden examples, target exactly the distribution where the model is weak — this is active learning with the labeling budget pointed at known gaps, the same logic as [label systems'](../16-ml-systems/10-label-ground-truth-systems.md) uncertainty sampling.

**Deduplicate, decontaminate, split honestly.** Near-duplicate examples silently overweight their pattern; eval examples leaking into training data produce the classic too-good-to-be-true validation score ([leakage](../16-ml-systems/05-training-pipelines.md), in fine-tuning clothes). Split by *entity or scenario*, not by row, when generalization to new entities is the goal.

**Version the dataset like a release artifact.** Snapshot, hash, and record the exact training set with the produced model — a tuned model whose data can't be reconstructed can't be debugged, audited, or legally defended. The full argument lives in [dataset management](../16-ml-systems/11-dataset-management-versioning.md); fine-tuning inherits all of it, plus a sharper privacy edge: PII in training data can resurface verbatim in generations, so scrubbing happens *before* training, not in the output filter.

**Format for the target.** Chat-tuned bases expect their own template (roles, special tokens); mismatched templating is the most common silent quality killer in open-weights tuning. Match the serving-time system prompt during training — the model should train in the costume it will wear.

---

## Training Mechanics Worth Knowing

The hyperparameter surface for LoRA-SFT is mercifully small, and most failures are diagnosable from two curves:

```text
epochs: 1–3 for SFT (more = memorization; watch eval loss, not train loss)
lr: 1e-4 (LoRA) with cosine decay + short warmup; 5e-6..2e-5 if full-tuning
batch: effective 32–128 via gradient accumulation; sequence-pack short examples
precision: bf16 compute; NF4 base for QLoRA
```

- **Train loss ↓, eval loss ↑** → overfitting: fewer epochs, more/better data, lower rank.
- **Both flat** → learning rate too low, wrong modules adapted, or the data doesn't actually contain a learnable signal (the most common and least suspected cause).
- **Benchmark regressions on general tasks** → catastrophic forgetting: mix a slice of general instruction data into the training set, lower the LR, or reduce epochs. Always run a general-capability probe suite alongside your task evals — a support-tone fine-tune that quietly loses arithmetic is a classic.

Tooling has consolidated: Hugging Face TRL / Axolotl / Unsloth (and LLaMA-Factory) cover open-weights SFT/DPO on one node for most cases; provider fine-tuning APIs (OpenAI, Google, and hosted platforms like Together/Fireworks) trade control for zero infrastructure. The [training-pipeline disciplines](../16-ml-systems/05-training-pipelines.md) — reproducibility contracts, seeds and determinism, run tracking, checkpointing — apply unchanged and are covered there.

---

## Serving Tuned Models

The deployment decision interacts with the tuning method more than teams expect:

**Merged model.** Fold the LoRA into the base and serve one artifact — simplest, zero overhead, right answer for a single tuned model at scale. Everything from [LLM Infrastructure](./05-llm-infrastructure.md) applies unchanged.

**Multi-LoRA serving.** Keep adapters separate and load them per-request on a shared base: vLLM, LoRAX, and similar servers batch requests for *different* adapters through one copy of the base weights (S-LoRA-style paging), which changes the economics of per-tenant customization entirely — hundreds of customer-specific adapters (each a few hundred MB, often much less) on one GPU pool, instead of hundreds of dedicated deployments. If your roadmap says "a tuned variant per customer/segment," this is the architecture, and it's a reason to prefer LoRA over full tuning even when compute is no constraint.

**Champion/challenger, always.** A tuned model is a model release: registry entry with lineage to data snapshot + base model + config, offline gate against the incumbent *including the prompting-only baseline* (the tune must beat the best prompt, or it shipped complexity for nothing), then shadow/canary with delayed-metric patience — the whole [deployment-rollout](../16-ml-systems/06-model-deployment-rollouts.md) ladder. The extra fine-tuning-specific gate: re-qualification when the *base* model or its serving stack upgrades, because an adapter is pinned to exact base weights; "upgrade the base and keep the adapter" is not a safe operation, it's a retrain.

---

## Failure Modes

**Tuning what prompting solves.** A quarter of engineering for what a rewritten prompt plus five examples achieves. Defense: the prompting baseline is a mandatory pre-experiment, and the tune must beat it on the eval set to ship.

**Knowledge baked into weights.** Facts go stale, can't be cited, can't be deleted; the model confidently recites last year. Defense: knowledge → RAG; behavior → weights.

**Data leakage and contamination.** Eval examples (or near-duplicates) in the training set produce a mirage of quality. Defense: hash-based dedup across train/eval, entity-level splits, and suspicion of any dramatic jump.

**Catastrophic forgetting.** The narrow tune erodes general capability nobody thought to test. Defense: general-capability probe suite in the gate, mixed general data in training.

**Style drift laundered as success.** The tuned model *sounds* more on-brand, and a judge model rewards the confidence while factuality quietly drops. Defense: separate evals for correctness and style; never a single "quality" score.

**Unreproducible artifact.** Great model, unknown data, departed author. Defense: the reproducibility contract — data snapshot hash, base model + revision, config, seed — enforced at registry time, exactly as for any [model registry](../16-ml-systems/13-model-registry-metadata.md) entry.

**Stranded adapter.** The base model family moves two generations; the adapter is welded to obsolete weights and the data pipeline to regenerate it was never built. Defense: budget the refresh pipeline, not the one-off run; keep the training set (the durable asset) in better shape than the checkpoint.

---

## Decision Framework

*Did a strong prompt with examples and schema enforcement fail, measurably, on an eval set?* If it wasn't tried, or there's no eval set, the answer to "should we fine-tune" is no — not yet.

*Is the gap knowledge or behavior?* Knowledge → retrieval. Behavior (style, format, task skill, tool reliability) → tuning is on the table.

*What's the unit economics goal?* If the motivation is cost/latency, distillation to a small open model is the pattern, and the business case is `(frontier per-token cost − student serving cost) × volume` against the training program + refresh pipeline.

*One model or many variants?* Per-tenant/per-task variants → LoRA + multi-adapter serving; single flagship behavior → merge and serve plain.

*Can you fund the loop?* Data refresh, re-training on base-model upgrades, eval maintenance, rollback capacity. A fine-tune is a product line, not a project.

---

## Key Takeaways

1. The adaptation ladder is prompting → RAG → fine-tuning; long context, prompt caching, and stronger instruction-following keep moving work down-ladder, and the tune must beat the best prompt to justify existing.
2. Fine-tune for behavior and economics — style lock-in, distillation, domain depth, narrow-task reliability — never for facts, which belong in retrieval.
3. LoRA/QLoRA is the default mechanism: ~1% trainable parameters, single-GPU training, adapters you can merge or hot-swap; full fine-tuning is the exception that needs a reason.
4. DPO-style preference optimization replaced RLHF for most teams' alignment-shaped goals; verifiable-reward RL (GRPO) is the frontier behind reasoning models.
5. Distilling a frontier teacher into a small student on your distribution is the highest-ROI pattern — filter the teacher's outputs, and check the ToS.
6. Data is the product: curated beats copious, production failures repaired into golden examples are the best source, and the training set is versioned, deduplicated, decontaminated, and PII-scrubbed like the release artifact it is.
7. Multi-LoRA serving makes per-tenant customization an adapter-management problem instead of a fleet problem — often the deciding argument for LoRA.
8. A tuned model is a model release: registry lineage, offline gates including the prompting baseline, canary rollout, and re-qualification whenever the base model moves.

---

## References

1. [LoRA: Low-Rank Adaptation of Large Language Models](https://arxiv.org/abs/2106.09685) — Hu et al., 2021
2. [QLoRA: Efficient Finetuning of Quantized LLMs](https://arxiv.org/abs/2305.14314) — Dettmers et al., 2023
3. [Direct Preference Optimization: Your Language Model is Secretly a Reward Model](https://arxiv.org/abs/2305.18290) — Rafailov et al., 2023
4. [Training Language Models to Follow Instructions with Human Feedback](https://arxiv.org/abs/2203.02155) — Ouyang et al., 2022 (RLHF)
5. [Constitutional AI: Harmlessness from AI Feedback](https://arxiv.org/abs/2212.08073) — Bai et al., 2022
6. [LIMA: Less Is More for Alignment](https://arxiv.org/abs/2305.11206) — Zhou et al., 2023
7. [DeepSeek-R1: Incentivizing Reasoning Capability in LLMs via Reinforcement Learning](https://arxiv.org/abs/2501.12948) — DeepSeek, 2025 (GRPO, verifiable rewards)
8. [S-LoRA: Serving Thousands of Concurrent LoRA Adapters](https://arxiv.org/abs/2311.03285) — Sheng et al., 2023
9. [TRL — Transformer Reinforcement Learning](https://huggingface.co/docs/trl) — SFT/DPO/GRPO tooling
10. [Distilling Step-by-Step!](https://arxiv.org/abs/2305.02301) — Hsieh et al., 2023
