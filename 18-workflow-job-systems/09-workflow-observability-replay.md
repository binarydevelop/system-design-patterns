# Workflow Observability and Replay

## TL;DR

Service observability was built for a world of short-lived, stateless calls: a request arrives, work happens, a response leaves, and the only durable record is whatever aggregate metrics and traces you sampled along the way. A workflow breaks every assumption in that model. It is a long-lived, stateful entity that can run for hours or days, retry the same step a dozen times, sleep durably between actions, and wait indefinitely on an external signal. Observing it well means answering a fundamentally different question — not "what is the error rate?" but "where is *this specific execution* right now, what has it already done, what is it waiting on, and why did attempt 4 of step 7 fail?" The substrate that makes this possible is the same append-only execution history that durable engines use for replay-based recovery: one artifact serves recovery, debugging, and audit at once. The discipline is to treat each execution as a first-class observable object, keep a per-execution view and an aggregate view side by side, and alert on stalled progress rather than only on errors.

---

## Why Request-Service Observability Doesn't Transfer

The dominant observability stack — RED metrics, distributed traces, structured logs — was shaped by stateless request/response services, and its core assumption is that the unit of work is *ephemeral*. A request lives for milliseconds to seconds, holds its state in memory and on the stack, and then vanishes. When it fails, the interesting state is already gone; you reconstruct what happened from whatever you sampled. This works because requests are individually cheap and statistically interchangeable. You rarely care about request #4,832,109 specifically; you care about the p99 of the million requests around it.

A workflow inverts all of this. The unit of work is a *durable, individually meaningful entity*. An order-fulfillment workflow, a user-onboarding saga, a nightly data DAG run — each one is a thing someone can name, owns money or obligations, and persists across process restarts, deploys, and outages. When it misbehaves, you do not want the p99; you want to open *that exact execution* and see its life story. The aggregate question "how many onboarding workflows failed today?" is real but secondary to the operational question "customer 88123 has been stuck in onboarding for three days — what is `onboarding-88123` waiting on?" Request observability has no good answer to the second question because requests are not addressable after they end. Workflow observability must make the answer a lookup.

This difference forces a different mental model. In a service you observe *flows of traffic*; in a workflow system you observe *individual stateful executions and their populations*. The execution is not a transient event but a long-lived object with identity, current state, history, and pending obligations — closer to a row in a database than to a span in a trace. Everything else about workflow observability follows from taking that object seriously.

---

## The Execution History Is the Observability Substrate

Durable-execution engines (Temporal, AWS Step Functions, Azure Durable Functions, Cadence) and DAG orchestrators (Airflow, Dagster, Prefect) share a structural property: they record an append-only history of everything an execution does. Every step start, every attempt, every input, every output, every state transition, every timer set and fired, every signal received — appended in order, with sequence numbers, to a durable log. Temporal calls it the *event history*; Step Functions calls it *execution history* and exposes it event by event in the console and API; Airflow materializes it as task instance rows and logs keyed by DAG run. The names differ; the idea is identical.

The crucial insight is that this is the *same* artifact that powers replay-based recovery, covered in [Durable Execution and Workflow Engines](./04-durable-execution-workflow-engines.md). A durable engine recovers a crashed workflow by re-reading its history and reconstructing in-memory state deterministically. That same history, read by a human or a UI instead of the engine, *is* the observability data. You do not bolt observability onto a durable workflow system as a separate concern — you get it for free from the mechanism that makes the system durable in the first place. One log serves three masters: the engine reads it to recover, the operator reads it to debug, and the auditor reads it to reconstruct what the system did and why.

This is a profound economy compared to stateless services, where the recovery story (retry the request) and the observability story (sample some telemetry) are entirely separate and the observability data is lossy by design. A workflow's history is *complete and exact* by construction, because the engine's correctness depends on it being so. The price is that history can grow large — a workflow with thousands of activities accumulates thousands of events — and that the history must remain replayable, which constrains how it can be stored and queried. But the payoff is an observability substrate that no amount of after-the-fact instrumentation on a stateless service could match: a deterministic, gap-free record of one execution's entire life.

---

## Replay as a Debugging Superpower

Because the engine can reconstruct an execution from its history, debugging a workflow is qualitatively different from debugging a request. When a stateless request fails, the failing state is gone the instant the response is sent; you are left inferring what happened from logs and hoping you logged the right thing. When a durable workflow fails, the failing state is *still there*, encoded in the history, and you can replay it deterministically to watch exactly what happened — which branch it took, what each activity returned, when each timer fired, why the code reached the line it did.

Replay has two distinct meanings, and conflating them is a common source of incidents. *Deterministic state-rebuild replay* is the engine reconstructing workflow state by re-executing workflow code against the recorded history; it produces no new side effects because every previously completed activity result is served from history rather than re-invoked. This is the replay that enables recovery, and it is also the replay that lets you reproduce a bug: in a durable engine you can take a problematic production history and replay it against a new build of your workflow code to see whether your fix changes the outcome — a regression test drawn from a real failure. The hard constraint is that workflow code must be deterministic; if it reads the wall clock, generates a random number, or iterates a map in nondeterministic order outside the engine's controlled APIs, replay diverges from history and the reconstruction breaks. Non-determinism is to replay what a leaked feature is to a model: invisible until it silently corrupts everything.

*Operational replay* is the other meaning: deliberately re-running failed work or re-issuing side effects — restarting a failed DAG task, reprocessing a batch, re-driving a stuck activity. This is enormously useful and enormously dangerous, because re-issuing a side effect that already partially succeeded duplicates it. Operational replay is safe only when the underlying steps are idempotent, which is exactly why observability, retry, and idempotency are inseparable concerns — see [Retry, Idempotency, and Compensation](./06-retry-idempotency-compensation.md). A "replay" button without idempotency guarantees and an audit trail is not an observability feature; it is an incident generator with a friendly label.

---

## The Two Views Every Workflow System Needs

A workflow observability system is incomplete unless it offers two views, because each hides precisely what the other reveals.

The **per-execution view** is the timeline or graph of a single run: the ordered sequence of steps and attempts, the current state, the input and output of each completed step, and — most importantly — what the execution is *waiting on* right now. This is the view an operator opens when one named workflow is stuck or wrong. Temporal's Web UI renders the event history as a navigable timeline; Step Functions draws the state machine as a visual graph with each state colored by status and a per-state event log; Airflow's Grid and Graph views show every task instance of a DAG run, color-coded, drillable into logs. The defining property of a good per-execution view is that it answers "what is happening with *this* execution" without forcing the operator to correlate logs across five services by hand. The history already correlates them; the UI just has to show it.

The **aggregate view** is the population-level picture: success and failure rates by workflow type, latency distributions, backlog depth, retry rates, the age of the oldest running execution, the count of executions stuck in each state. This is the view that tells you a *class* of workflows is degrading — that onboarding success dropped from 99% to 94% after this morning's deploy, or that the payment-charge activity's retry rate tripled. No per-execution view can show this; you would have to open ten thousand timelines to notice a 5-point drop in success rate.

The trap is building only one. A system with only aggregate dashboards can tell you 6% of workflows are failing but cannot tell you *which* ones or *why* any specific one is stuck — the operator is blind at exactly the moment a customer is on the phone. A system with only per-execution timelines lets you debug any single run beautifully but cannot tell you that a systemic regression is underway until enough individual complaints accumulate. Both views read from the same history; they differ only in whether they aggregate across executions or drill into one. A mature system makes moving between them a single click: see the failure spike in the aggregate view, filter to the affected executions, open one, read its timeline.

---

## Metrics That Are Specific to Workflows

Generic service metrics — request rate, error rate, duration — apply to a workflow system's API surface but miss everything that makes workflows distinctive. The metrics that actually matter are the ones that exploit the stateful, multi-attempt, long-lived nature of the work.

The most important and most frequently omitted distinction is **queue wait versus execution time**. A workflow step that took ten minutes to finish might have *executed* for ten seconds and *waited in a queue* for nine minutes and fifty seconds because no worker was free. These are opposite problems with opposite fixes — the first wants faster code, the second wants more workers or better prioritization (see [Priority, Fairness, and Backpressure](./07-priority-fairness-backpressure.md)) — and a single "step duration" metric that fuses them tells you nothing. Measuring schedule-to-start latency separately from start-to-close latency is the single highest-value workflow-specific instrumentation.

**Attempt counts and retry rates** turn invisible struggle into a signal. A step that eventually succeeds on attempt 6 looks identical, in a success-rate metric, to one that succeeded on attempt 1, but it is consuming six times the resources and signaling an unhealthy dependency. A rising retry histogram is an early warning that precedes outright failure. **Age of the oldest non-terminal execution** is the canary for stuck work: in a healthy system it stays bounded; when it grows without limit, something is wedged. **Critical-path duration** matters for DAGs, where total runtime is set by the longest dependent chain, not the slowest individual task — optimizing an off-critical-path step changes nothing. For data DAGs, **dataset freshness and SLA-miss rate** are the metrics the business actually feels: not "did the DAG run" but "is the table that feeds the morning dashboard up to date by 6 a.m.?" And **backlog depth** — runnable work waiting versus capacity to do it — is the leading indicator of whether the system is keeping up or falling behind.

| Metric | What a service equivalent misses |
|---|---|
| Schedule-to-start vs start-to-close | Conflates "slow because it waited" with "slow because it ran" |
| Attempt count / retry rate per step | Eventual success hides expensive, unhealthy struggle |
| Age of oldest running execution | Aggregate latency stays fine while one execution is wedged forever |
| Critical-path duration (DAGs) | Total runtime is set by the longest chain, not the mean task |
| Dataset freshness / SLA-miss | "Job succeeded" says nothing about whether the data is on time |

---

## The Stuck-Workflow Detection Problem

The signature failure of a long-running stateful system is the execution that simply *stops making progress* without failing. It is not throwing errors — error-rate dashboards stay green — but it is also not advancing. It is waiting on an external signal that will never arrive, blocked on an event that an upstream system forgot to send, or expecting a timer that should have fired and did not. A stateless service cannot get stuck in this way; if its request blocks, the request times out and the failure surfaces. A workflow is *designed* to wait, often for legitimate days, so "waiting" and "wedged" look identical from the outside. Distinguishing them is the central detection problem.

The mechanisms that catch it all rely on the per-execution state being inspectable. **Per-step and per-workflow timeouts** convert silent waiting into an explicit failure event: a charge activity that has not completed in five minutes, or a workflow that has not reached a terminal state in its expected maximum duration, transitions to a timed-out state that alerting can see. **Maximum-duration alerts** catch the workflow-level version: an execution older than the 99th-percentile-plus-margin runtime for its type is, by definition, anomalous. **Last-meaningful-event inspection** is the diagnostic complement — surfacing, per stuck execution, what the most recent history event was, because the cure depends entirely on the cause. A workflow whose last event is "waiting for approval signal" needs the signal chased down; one whose last event is "timer set, fires in 2h" that is now overdue points at a timer-service fault; one that says it is runnable but has no corresponding queue task has a lost-wakeup bug. The taxonomy of stuck causes — never-arriving signal, missing event, unfired timer, no available workers, downstream outage, lost wakeup, non-determinism after a bad deploy — maps to genuinely different repair paths, so the observability system's job is not just to flag "stuck" but to expose enough of the execution's state to tell the causes apart.

---

## Correlation and Lineage to Downstream Traces

A workflow does not act in isolation; its activities call services, and those services have their own request traces. The observability question that spans the boundary is "this workflow's payment step was slow — was it the workflow engine, or the payment service it called?" Answering it requires stitching the workflow's per-step timeline to the distributed traces of the services its activities invoke.

The technique is trace-context propagation, the lineage of Google's Dapper (2010) and now standardized by [OpenTelemetry](../11-observability/01-distributed-tracing.md). When a workflow activity calls a downstream service, it propagates a trace context — a trace ID and span ID — into that call, and records the same identifiers in its own event history. The downstream service's spans then carry the same trace ID, so a single query can assemble the workflow step and the service request it triggered into one causal picture. The wrinkle unique to workflows is *duration*: a distributed trace is conventionally a single short-lived tree, but a workflow may span days, far longer than any tracing backend keeps a trace open or any sampling window covers. The pragmatic pattern is therefore not one giant trace per workflow but *correlation by stable identifiers* — store the workflow ID, run ID, and per-activity trace IDs in the history, and emit one bounded trace per activity invocation linked back to the workflow by those IDs. The workflow timeline becomes the spine, and each activity's short-lived downstream trace hangs off the relevant event. This connects the long-lived stateful view to the short-lived request view without pretending a three-day workflow is one trace.

---

## Auditability and Alerting on Long-Running Entities

Because the execution history is a complete, ordered, durable record of everything an execution did and why, it doubles as an **audit trail**. For a workflow that moves money, provisions access, or makes a regulated decision, "what did the system do, in what order, on whose behalf, and what did it decide at each branch?" is answerable directly from history — including which operator actions (a manual retry, a forced signal, a cancellation) were taken and by whom, provided those interventions are themselves appended as history events rather than performed as out-of-band database edits. The heavy governance and compliance treatment lives elsewhere; the point here is that the same substrate that serves recovery and debugging also serves audit, so a system that takes its history seriously gets auditability nearly for free.

**Alerting** on a long-running entity differs from alerting on a service, and missing the difference produces both blind spots and fatigue. A service alerts primarily on error rate and latency over a short window. A workflow's most important alert is on *stalled progress and SLA breach* — conditions that a request-style error-rate alert cannot express, because a stuck workflow is not erroring. The valuable alerts are state-aware: oldest runnable task age exceeding the SLO (not raw queue depth, which is noisy and lacks business meaning), a timer overdue beyond its scheduled fire time, a workflow exceeding its maximum expected duration, a compensation that itself failed (a far worse condition than a primary failure, because it means the system could neither finish nor cleanly undo), a dataset that missed its freshness SLA. Each of these alerts on *user or business impact*, which is the discipline that keeps a workflow alerting system from drowning operators. Alerting on every internal counter — every retry, every transient activity error that the engine will itself recover — trains operators to ignore the pager; alerting on "this customer's onboarding has been stuck for longer than our promise" keeps the signal worth waking up for. The general principles of good alerting carry over from [Alerting](../11-observability/04-alerting.md); what is workflow-specific is that the leading indicator of trouble is *absence of progress*, not presence of errors.

---

## Failure Modes

Workflow observability fails in recognizable ways, and naming them is most of preventing them.

**The invisible stuck workflow** is the defining failure: an execution waits forever on a signal that will never come, while every error-rate dashboard stays green because nothing is technically failing. The defense is timeouts and maximum-duration alerts that convert silent waiting into a visible event, plus an "oldest non-terminal execution age" metric that climbs when work wedges.

**History too large to inspect** afflicts long-lived or high-fan-out workflows whose event log grows to tens of thousands of events, at which point both the engine's replay and a human's reading slow to a crawl. The defenses are bounding workflow size (the *continue-as-new* pattern, which closes one history and starts a fresh one carrying forward only essential state) and storing large payloads by reference rather than inline, so the history records pointers and metadata, not megabytes.

**Missing correlation to downstream traces** leaves operators unable to tell whether a slow step was the engine or the service it called, because no trace context was propagated and no identifiers were recorded in history. The defense is disciplined trace-context propagation and storing trace IDs per activity from the start, not after the first incident proves they were needed.

**Aggregate metrics hiding one pathological execution** is the failure of having only the population view: a single workflow burning a thousand retries or wedged for a week is statistically invisible in a success-rate metric computed over millions. The defense is the per-execution view and outlier-oriented metrics — oldest age, max attempt count — that surface the individual rather than averaging it away.

**Non-replayable history** is the quiet corruption: workflow code that used wall-clock time, randomness, or nondeterministic iteration produces a history that no longer deterministically reconstructs, so replay diverges and both recovery and replay-based debugging break. The defense is enforcing determinism in workflow code through the engine's controlled APIs and testing replay against recorded histories as part of CI.

---

## Decision Framework

The observability a system needs scales with where it sits on the durability axis, and over-building it for simple work is as wasteful as under-building it for complex work.

For **fire-and-forget background jobs** (see [Background Jobs and Worker Pools](./02-background-jobs-worker-pools.md)), the unit of work is short and individually disposable, so request-style observability is mostly sufficient: success/failure counts, queue depth, processing latency, and a dead-letter queue for what fails. There is little per-execution state worth inspecting because a failed job is simply retried or dropped. The one workflow-specific metric worth adding even here is queue wait versus execution time, because a backed-up worker pool is the most common cause of "slow jobs."

For **scheduled and DAG workloads** (see [DAG Orchestration](./05-dag-orchestration.md)), executions become individually meaningful — a specific nightly run can fail in a way that matters — so a per-run view (Grid/Graph-style), critical-path timing, retry visibility, and dataset-freshness/SLA-miss metrics become necessary. The aggregate view tracks run success rates and backlog; the per-run view supports debugging a specific failed run.

For **durable, long-running workflows** (see [Durable Execution and Workflow Engines](./04-durable-execution-workflow-engines.md)), the full apparatus is justified: a complete per-execution event-history view, replay for deterministic debugging, stuck-workflow detection via timeouts and max-duration alerts, trace correlation to downstream services, compensation-failure alerting, and history-size management. The defining question to ask of any such system is the same one that separates a real workflow platform from a job queue with delusions: *can I open one named execution and see its entire life — what it did, what it is waiting on, and why its last attempt failed — without reading logs from five services by hand?* If the answer is no, the system is observable in aggregate but blind in the particular, and the particular is where workflows live.

---

## Key Takeaways

1. Workflow observability answers a different question than service observability: not "what is the error rate?" but "where is this specific execution, what has it done, what is it waiting on, and why did this attempt fail?"
2. A workflow is a long-lived stateful entity, not an ephemeral request; observe each execution as a first-class, addressable object, not just as a contributor to aggregate rates.
3. The append-only execution history is the observability substrate — the same artifact that powers replay-based recovery also makes a workflow debuggable and auditable, so one log serves recovery, debugging, and audit.
4. Replay is a debugging superpower: deterministic state-rebuild replay lets you reproduce a real failure against new code, but it requires deterministic workflow code, and operational replay requires idempotency or it duplicates side effects.
5. Every workflow system needs both a per-execution view (one run's timeline and current wait state) and an aggregate view (rates, backlog, outliers); each hides what the other shows.
6. The highest-value workflow-specific metric is queue wait versus execution time — slow-because-it-waited and slow-because-it-ran are opposite problems with opposite fixes.
7. The signature failure is the invisible stuck workflow that waits forever without erroring; detect it with timeouts, max-duration alerts, oldest-age metrics, and last-meaningful-event inspection.
8. Correlate workflow steps to downstream service traces via OpenTelemetry-style context propagation, but correlate long-lived workflows by stored identifiers rather than one impossibly long trace.
9. Alert on stalled progress and SLA breach, not just error rate, and alert on business impact to avoid drowning operators in recoverable transient noise.
10. Scale observability with the durability axis: RED-style metrics for background jobs, per-run views for DAGs, the full history/replay/stuck-detection apparatus for durable workflows.

---

## References

1. [Dapper, a Large-Scale Distributed Systems Tracing Infrastructure](https://research.google/pubs/pub36356/) — Sigelman et al., Google, 2010
2. [Temporal Documentation: Event History and the Web UI](https://docs.temporal.io/workflows#event-history)
3. [AWS Step Functions: Viewing and Debugging Executions](https://docs.aws.amazon.com/step-functions/latest/dg/concepts-state-machine-data.html)
4. [Apache Airflow: Grid and Graph Views](https://airflow.apache.org/docs/apache-airflow/stable/ui.html)
5. [OpenTelemetry: Traces and Context Propagation](https://opentelemetry.io/docs/concepts/signals/traces/)
6. [Dagster: Observability and Asset-Based Orchestration](https://docs.dagster.io/concepts/ops-jobs-graphs/op-events)
7. [Azure Durable Functions: Diagnostics and Replay](https://learn.microsoft.com/en-us/azure/azure-functions/durable/durable-functions-diagnostics)

## Related Patterns

- [Durable Execution and Workflow Engines](./04-durable-execution-workflow-engines.md)
- [DAG Orchestration](./05-dag-orchestration.md)
- [Retry, Idempotency, and Compensation](./06-retry-idempotency-compensation.md)
- [Priority, Fairness, and Backpressure](./07-priority-fairness-backpressure.md)
- [Background Jobs and Worker Pools](./02-background-jobs-worker-pools.md)
- [Distributed Tracing](../11-observability/01-distributed-tracing.md)
- [Alerting](../11-observability/04-alerting.md)
- [Logging](../11-observability/03-logging.md)
- [Incident Management and Postmortems](../11-observability/07-incident-management.md)
- [Disaster Recovery](../15-deployment/05-disaster-recovery.md)
