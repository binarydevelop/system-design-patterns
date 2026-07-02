# Context Management

## TL;DR

Context management — increasingly called *context engineering* — is the discipline of deciding what an LLM sees on each call, and it has quietly replaced prompt wording as the highest-leverage skill in LLM systems. The context window is a budget with three hard properties: it is finite, attention over it is non-uniform (models reliably under-use the middle), and in agentic systems the entire transcript is re-sent and re-billed on *every* turn. Those three facts generate all the machinery in this chapter: prefix caching discipline (append-only history, stable prefixes) because re-reading is 10× cheaper than re-processing; threshold-triggered compaction because transcripts outgrow any window; context editing because stale tool results are dead weight; file-based memory because the filesystem is the only context store that survives the session; and sub-agents because a fresh context is sometimes worth more than a bigger one. The unit of optimization is not the prompt — it is the *lifecycle of the token budget across the whole task*.

---

## The Context Window Is a Budget

Every request presents the model with one sequence: system prompt, tool definitions, conversation history, retrieved documents, the current message, and space reserved for the response. Current frontier models offer 200K–1M input tokens with 64K–128K output ceilings, which sounds unlimited and is not — a single large repository, a day of agent transcripts, or a modest document corpus each exceed it comfortably.

The budget must be *allocated*, and unallocated budgets fail in a characteristic way: retrieval or history grows to fill all available space, the response gets squeezed, and quality drops precisely on the complex tasks that needed room to answer. A production system states its allocation explicitly:

```yaml
# Context budget for a support agent on a 200K-token model
context_budget:
  system_prompt_and_tools: 8_000     # fixed, cache-friendly prefix
  memory_and_user_profile: 2_000
  retrieved_documents: 40_000        # RAG results, capped at retrieval time
  conversation_history: 120_000      # compaction triggers at this threshold
  current_turn_headroom: 10_000
  reserved_for_output: 20_000        # never let input squeeze this
```

Two non-obvious rules hide in that YAML. First, *output reservation is a correctness constraint, not a courtesy* — a model that runs out of output budget truncates mid-thought, and on reasoning models the thinking tokens spend from the same output allowance as the visible answer. Second, *the history threshold sits well below the window* (120K in a 200K window) because models degrade before they overflow: long before the hard limit, you pay more per turn and get worse attention per token. Treating ~60–70% of the window as the practical ceiling, with compaction absorbing the rest, is the standard production posture.

---

## Token Economics: The Bill Is Shaped Like a Triangle

Three pricing facts shape every architecture decision in this chapter.

**Output costs ~5× input.** Across providers, output tokens run roughly five times the price of input tokens. Verbose responses, chain-of-thought you didn't need, and re-generated boilerplate are the expensive failure; enormous inputs are comparatively cheap.

**Cached input costs ~0.1× input.** Every major provider now offers prompt caching: a prefix the provider has recently processed is re-read at roughly a tenth of the fresh-input price (writes cost a small premium, ~1.25×). This single line item dominates agentic economics, as the next section shows.

**Agents re-send everything, every turn.** A chat UI sends one message; an agent loop re-sends the entire transcript — system prompt, all prior tool calls, all tool results — on every model call. Cost therefore grows *quadratically* with turn count if nothing is cached or pruned. The arithmetic is worth doing once:

```text
Agent task: 50 turns, transcript grows ~4K tokens/turn, $3/MTok input, $15/MTok output

Uncached: Σ (turn i re-sends ~4K×i tokens) ≈ 4K × 50×51/2 = 5.1M input tokens ≈ $15.30
          + 50 × 1K output tokens ≈ $0.75                          total ≈ $16
Cached:   each turn re-reads the prior transcript at 0.1× and pays fresh
          price only for the ~4K new tokens:
          5.1M × 0.1 + 4K×50 × 1.0 ≈ 0.71M effective ≈ $2.10 + output   total ≈ $2.90
```

A 5–6× cost difference — and a comparable latency difference, since cached prefixes skip prefill — from *no change to the model, prompt, or product*. This is why cache discipline is the first thing to audit in any expensive agent, and why the serving-side mechanics (KV cache, prefix reuse) covered in [LLM Infrastructure](./05-llm-infrastructure.md) leak all the way up into how you order your messages. Batch APIs add a further 50% discount for anything that can wait an hour, which is most evaluation, enrichment, and backfill traffic.

---

## Attention Is Not Uniform: Lost in the Middle and Context Rot

A context window is not random-access memory. Liu et al.'s *Lost in the Middle* (2023) established the canonical result: on multi-document QA, accuracy is highest when the relevant document is at the *beginning or end* of the context and drops substantially when it sits in the middle — a U-shaped attention curve that persists, attenuated, in current frontier models. Follow-on "needle in a haystack" testing became a standard model-qualification exercise, and the broader phenomenon — quality degrading as contexts grow long even when the needle is findable — is now commonly called *context rot*: models get distracted by irrelevant material, over-attend to recent tokens, and lose track of constraints stated once, early, in a 300K-token transcript.

The engineering responses are placement and hygiene rules rather than exotic machinery:

- **Put instructions at the edges.** Durable rules live in the system prompt (top); the current task and any binding constraints are restated near the end. Long-document prompts routinely repeat the question *after* the document for exactly this reason.
- **Order retrieved documents by importance, outside-in** — most relevant first and last, weakest in the middle — rather than by retrieval score order alone.
- **Don't ship irrelevant context.** Retrieval that pads the window with marginal chunks doesn't just waste money; it actively degrades answers by feeding the distraction failure. A reranker that cuts twenty chunks to five ([RAG Patterns](./04-rag-patterns.md)) is an attention optimization as much as a cost one.
- **Test your own needle.** Providers' needle benchmarks are synthetic. If your system depends on recall from position 200K of a legal contract, build a twenty-case retrieval probe from your own documents and run it when you change models — the same qualification discipline as any [offline evaluation](./10-llm-evaluation.md).

---

## Prefix Caching Discipline: The Load-Bearing Optimization

Prompt caching is a *prefix* match: the provider hashes the exact rendered request, and any byte that differs from the cached prefix invalidates everything after it. This turns caching from a checkbox into an architecture constraint — the request must be *assembled* so that its stable parts come first and its volatile parts come last, and so that turn N+1's request extends turn N's byte-for-byte.

The rules that follow are simple and violated constantly:

1. **Freeze the prefix.** System prompt and tool definitions render first; they must be byte-identical across calls. A timestamp, a request ID, or a "helpful" per-user greeting interpolated into the system prompt silently reprices the entire conversation to uncached rates.
2. **Append, never edit.** The message history must be append-only. Rewriting an earlier tool result, re-ordering messages, or re-serializing JSON with non-deterministic key order breaks the prefix at the edit point.
3. **Don't swap tools or models mid-session.** Tool definitions sit at position zero; adding or removing one invalidates the whole cache. Caches are also per-model — routing a conversation between models forfeits the cache each switch, which changes the math on "use the cheap model for easy turns" routing.
4. **Verify with usage fields, not vibes.** Every provider reports cached-read tokens in the response usage. A cache-hit rate near zero on a multi-turn workload means a silent invalidator; diff two consecutive rendered requests to find it.

```python
# WRONG: rebuilds the prompt each turn; three separate cache-killers.
system = f"You are a support agent. Today is {datetime.now()}."   # (1) volatile prefix
messages = sorted(history, key=relevance)[-20:]                    # (2) reordered history
tools = pick_tools_for(query)                                      # (3) varying tool set

# RIGHT: stable prefix, append-only history, fixed tools; volatile info
# travels in the latest message where it invalidates nothing.
system = SYSTEM_PROMPT_FROZEN
messages = history + [{"role": "user",
                       "content": f"[context: {datetime.now():%Y-%m-%d}] {query}"}]
```

Compaction and caching interact: compacting the transcript necessarily rewrites history and invalidates the cache once. That is the right trade — one cache-write against a much smaller transcript — but it is why compaction should fire at *thresholds*, not every turn.

---

## Long Context vs RAG

"Just put it all in the context" and "retrieve only what's relevant" are the two poles of context management, and million-token windows have moved the boundary without dissolving it.

**Long context wins** when the working set is bounded and reused: a single repository, one contract, a book, this quarter's reports. Everything is visible, cross-document reasoning works without retrieval plumbing, there is no retrieval-miss failure mode, and prompt caching makes the repeated re-reading affordable — a cached 500K-token corpus costs roughly what a 50K fresh prompt does per query. The costs are the per-query price floor (even cached tokens aren't free), slower first-token latency on cache misses, and context rot on tasks that need precise recall from deep positions.

**RAG wins** when the corpus is unbounded or fresh: millions of documents, data updated hourly, per-user permissioning on what may be seen at all, or the need for citations that point at a source rather than a position in a megaprompt. No window will ever hold the corpus, so selection is not optional — the question is only whether selection happens in a retrieval system you can measure and tune, or implicitly inside a model straining at a stuffed window.

The production pattern is usually the hybrid: **RAG selects the working set; long context holds it.** Retrieval narrows millions of documents to the fifty that matter for this session, the session loads them once into a cached prefix, and the conversation proceeds against that stable context. Agentic systems add a third mode — *just-in-time retrieval* — where the model itself fetches context through tools (`grep`, file reads, search APIs) mid-task instead of front-loading it; this trades pre-computed recall for the agent's ability to follow its nose, and most serious coding agents now rely on it more than on embedding indexes.

| Dimension | Long context | RAG | Agentic (just-in-time) |
|---|---|---|---|
| Corpus size | ≤ ~1M tokens | Unbounded | Unbounded but navigable |
| Freshness | Reload to update | Index latency (minutes) | Live at read time |
| Failure mode | Context rot, cost floor | Retrieval miss | Wandering, tool-call latency |
| Attribution | Weak (position) | Strong (source chunks) | Strong (explicit reads) |
| Best when | Bounded reused working set | Search over large corpora | Exploration, code, ops |

---

## Compaction: Surviving Past the Window

Every long-running conversation eventually faces the same event: the next turn will not fit. Compaction is the standard answer — summarize the older portion of the transcript into a compact digest, keep the recent turns verbatim, and continue with the digest in place of the history it replaced. Providers increasingly offer this server-side (the API summarizes and returns a compaction block you thread back), and every serious agent harness implements a client-side version; the design questions are the same either way.

**Trigger on thresholds, not turns.** Compact when the transcript crosses a budget line (say, 60–70% of the window), because compaction costs a summarization call and a cache invalidation — doing it every turn pays that price constantly for no benefit.

**The summary is a load-bearing artifact, not prose.** A generic "summarize this conversation" loses exactly the details that matter later. Production compaction prompts enumerate what must survive:

```text
Compact the conversation above into a handoff brief for an agent continuing
this task. Preserve, with exact literal values:
1. The task goal and acceptance criteria, as most recently amended.
2. Every decision made and its stated reason.
3. Constraints and user corrections (things tried and rejected — and why).
4. Exact identifiers: file paths, URLs, IDs, branch names, command flags.
5. Current state: what is done, what is in progress, what remains.
Omit: exploratory dead ends (except the lesson), verbatim tool output,
pleasantries. Target under 2,000 tokens.
```

The classic compaction bug is losing a *negative* constraint — the user said "don't touch the billing module" forty turns ago, the summary dropped it, and the agent, now unconstrained, touches the billing module. Corrections and prohibitions deserve explicit line items in the compaction schema precisely because they are short, rare, and catastrophic to lose.

**Keep the raw transcript anyway.** Compaction is for the model's working context; the full history should still land in your trace store for debugging, evaluation, and audit ([LLM Evaluation](./10-llm-evaluation.md)). Summarizing your only copy is destroying evidence.

---

## Context Editing: Pruning Instead of Summarizing

Compaction rewrites history; *context editing* deletes parts of it. In tool-heavy agent sessions, the bulk of the transcript is tool results — a 40K-token file read, a 25K-token test log — that were essential the turn they arrived and are dead weight ten turns later. Clearing stale tool results (while keeping the fact that the call happened) routinely reclaims half a transcript without touching the conversational content, and providers now expose this as a first-class API feature alongside client-side implementations.

The same logic applies at *write* time, which is cheaper than pruning after the fact:

- **Truncate tool results at the harness boundary.** No tool should be able to dump 100K tokens into the transcript; cap each result (with a "truncated, full output at `<path>`" marker) and let the agent request more if needed.
- **Offload large artifacts to the filesystem.** A generated report or fetched webpage goes to a file; the transcript carries the path and a two-line summary. The context holds *references*, the filesystem holds *content* — restorable on demand at the cost of a read.
- **Drop reasoning blocks from prior turns.** Extended-thinking output from earlier turns rarely helps later ones; most providers either strip it automatically or recommend clearing it.

The discipline mirrors [backpressure](../06-scaling/07-backpressure.md): bound what enters the queue rather than heroically draining it later.

---

## Memory: What Survives the Session

Everything above manages context *within* a session. Memory is the machinery for context that must outlive it — user preferences, project conventions, lessons from past failures — and the field has converged on an unglamorous answer: **files**.

The pattern, popularized by MemGPT's OS analogy (context window as RAM, external store as disk) and now shipped as first-class "memory tools" by providers and standard in coding agents, gives the model tools to read and write a persistent directory, plus a small always-loaded index. The model decides what is worth writing; the harness decides what gets auto-loaded at session start (typically a bounded index file, not the whole store):

```text
memory/
  MEMORY.md            # index, always loaded (~1K tokens, hard-capped)
  project-conventions.md
  user-prefers-terse-replies.md
  lesson-vitest-not-jest.md    # one fact per file, written after a correction
```

Why files beat the obvious alternative — a vector database of conversation embeddings — for most agent memory: files are inspectable (the user can read and correct what the system believes), editable (wrong memories get deleted, not diluted), naturally versioned (git), and retrieved by *deliberate* reads rather than similarity scores that surface stale or irrelevant memories into every prompt. Embedding-based memory still earns its place for large-scale recall over conversation history, but the failure mode — confidently injecting an outdated "fact" from six months ago — is exactly the [feedback-loop contamination](../16-ml-systems/01-ml-system-fundamentals.md) problem, and it argues for keeping automatic memory injection small and skeptical.

The operational hazards are staleness and scope. A memory that was true in March ("the deploy script is `deploy.sh`") silently poisons sessions in July; memory entries need the same treatment as [dataset versioning](../16-ml-systems/11-dataset-management-versioning.md) gives data — provenance, and deletion when wrong. And memory written from one user's session must never load into another's: memory stores are per-tenant security boundaries, not shared caches.

---

## Structure the Context for the Agent's Own Attention

Two lightweight patterns exploit the attention curve deliberately, and both look almost too simple to matter.

**Recitation.** Agents on long tasks drift from the goal — the "lost in the middle" victim is the objective itself, stated once, 200K tokens ago. Harnesses counter this by having the agent maintain a todo list or plan file and *re-append it* to the tail of the context as it updates — rewriting the goal into the high-attention recent-token zone every few turns. The todo list's value is less project management than attention anchoring.

**Sub-agents as context partitions.** When a subtask needs to consume a lot of context — read thirty files, digest a long log — spawning a sub-agent with a fresh window and getting back a summary keeps the orchestrator's context clean. The sub-agent burns its window on the exploration; the parent pays only for the distilled result. This is context *isolation*, the same reason [multi-agent systems](./03-multi-agent-systems.md) exist at all, and it is frequently a better answer than a bigger window: two focused 50K contexts outperform one distracted 300K context on many tasks.

---

## Failure Modes

**Quadratic cost blowup.** An agent loop with no caching and no pruning re-processes a growing transcript every turn; the bill grows with the square of the conversation length and nobody notices until the invoice. Defense: cache discipline first, then editing/compaction thresholds, and per-task token budgets with alerts.

**Cache thrash.** A timestamp in the system prompt, per-request tool filtering, or history rewriting silently drops the cache-hit rate to zero while everything still works. Defense: monitor cached-token share as an SLO; treat a drop as an incident, not a curiosity.

**Lost constraints after compaction.** The summary preserved the narrative and dropped the prohibition; the agent re-attempts something explicitly ruled out. Defense: compaction schemas with explicit slots for corrections/constraints, and keeping recent turns verbatim.

**Context poisoning.** A hallucinated "fact," a wrong tool output, or an injected instruction enters the transcript early and every later turn reasons from it — errors compound because the context *is* the agent's world-model. Defense: validate tool outputs at the boundary, keep untrusted retrieved content clearly delimited ([prompt injection](./06-prompt-engineering.md)), and prefer restarting a poisoned session over arguing with it.

**Context distraction.** Stuffing the window with marginally relevant retrieval measurably *lowers* accuracy versus a tighter context. Defense: rerank hard, cap retrieved tokens, and evaluate retrieval precision, not just recall.

**Stale memory.** Yesterday's convention, confidently injected today. Defense: memory provenance, easy deletion, user-visible memory contents, and skepticism about auto-injecting anything the user can't see.

---

## Decision Framework

*Where should this information live?* — The four-tier answer: in the **system prompt** if it is true for every request; in **memory files** if it must survive sessions; in the **transcript** if it is this conversation's working state; behind **retrieval or tools** if it is one working set among many. Most context bloat is information living one tier too high.

*Is the transcript append-only and the prefix frozen?* If not, fix that before any other optimization — it is the difference between cached and uncached economics.

*What fires when the budget is hit?* A system without an explicit compaction threshold has chosen "fail at the window limit" as its policy.

*Can the model find what it needs, or merely fit it?* Fitting 800K tokens is easy; recalling one clause from the middle is not. If precise recall matters, retrieve narrowly instead of stuffing broadly, and test recall at depth with your own documents.

*What survives the session, and who can read it?* Memory is a persistence layer with tenancy, staleness, and audit properties — design it like one.

---

## Key Takeaways

1. Context engineering has replaced prompt wording as the core skill: the question is what the model sees each call, across the whole task lifecycle, not how the instruction is phrased.
2. The window is a budget with explicit allocations and an output reservation; the practical ceiling is ~60–70% of the advertised limit, with compaction absorbing the rest.
3. Cached input at ~0.1× is the dominant economic fact of agentic systems; append-only history and frozen prefixes are worth 5×+ on cost and latency before any cleverness.
4. Attention is U-shaped — instructions at the edges, weakest content in the middle, and never ship context you don't need, because irrelevant tokens actively degrade answers.
5. Million-token windows moved the long-context/RAG boundary but didn't dissolve it: RAG selects the working set, long context holds it, and agents increasingly retrieve just-in-time through tools.
6. Compaction is a schema, not a summary: decisions, constraints, corrections, and exact identifiers survive verbatim; the full transcript still goes to the trace store.
7. Prune at the boundary: cap tool results, offload artifacts to files, clear stale tool outputs — references in context, content on disk.
8. Memory converged on files: inspectable, correctable, versioned, deliberately read — with staleness and tenancy treated as first-class risks.
9. Recitation and sub-agent context partitions are cheap, high-leverage attention tools: rewrite the goal into the recent-token zone, and buy fresh windows instead of bigger ones.
10. Watch cached-token share and per-task spend as SLOs; the characteristic failures (quadratic cost, cache thrash, lost constraints, poisoning) are all invisible until instrumented.

---

## References

1. [Lost in the Middle: How Language Models Use Long Contexts](https://arxiv.org/abs/2307.03172) — Liu et al., 2023
2. [Effective Context Engineering for AI Agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) — Anthropic, 2025
3. [Context Rot: How Increasing Input Tokens Impacts LLM Performance](https://research.trychroma.com/context-rot) — Chroma Research, 2025
4. [MemGPT: Towards LLMs as Operating Systems](https://arxiv.org/abs/2310.08560) — Packer et al., 2023
5. [Context Engineering for AI Agents: Lessons from Building Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus) — Manus, 2025 (KV-cache discipline, recitation, filesystem-as-context)
6. [Prompt Caching — Anthropic Documentation](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) — prefix semantics, TTLs, cache pricing
7. [LLMLingua: Compressing Prompts for Accelerated Inference](https://arxiv.org/abs/2310.05736) — Jiang et al., 2023
8. [How Long Contexts Fail](https://www.dbreunig.com/2025/06/22/how-contexts-fail-and-how-to-fix-them.html) — Breunig, 2025 (poisoning/distraction/confusion taxonomy)
