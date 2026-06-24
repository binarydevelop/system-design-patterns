# Distributed Cron and Scheduling

## TL;DR

Distributed cron is the problem of running scheduled work reliably across a fleet where any node can die and no two clocks agree. Single-machine cron is trivial — one daemon, one clock, one crontab — but it is a single point of failure. The naive distributed fix, running cron on every node, fires every job N times. The entire discipline of distributed cron exists to thread the needle between two symmetric, equally bad failures: **double-firing**, where a tick produces duplicate side effects, and **missed-firing**, where a scheduled tick is silently skipped. Getting this right requires coordinating *who owns the schedule* (a leader or a lease), *what time it actually is* (clock discipline, time zones, and DST), and *what is owed* after a failover (durable last-fire tracking plus idempotent execution). The schedule decides *when*; the execution is a separate concern that usually hands off to a [worker pool](./02-background-jobs-worker-pools.md).

---

## Why Single-Machine Cron Does Not Generalize

Unix cron — Brian Kernighan's original, hardened into Paul Vixie's `cron` in 1987 and still shipping in every Linux distribution — is one of the most successful pieces of system software ever written, and it works because it assumes a world that distributed systems destroy. It assumes one machine: local disk holds the crontab, the local clock defines "now", the local process starts the work, and the local syslog is a sufficient audit trail. Each minute the daemon wakes, compares the current wall-clock time against each crontab line, and forks the matching commands. There is no coordination problem because there is nothing to coordinate with.

That simplicity is also the failure. If the one machine running cron dies, every scheduled job on it silently stops, and nobody is paged because nothing *failed* — the jobs just never ran. A nightly billing run, a cache warm, a database backup: all skipped, discovered hours or days later. For anything that matters, a single cron daemon is an unacceptable single point of failure.

The obvious reflex — put the crontab on every machine in the fleet so the job survives any single death — trades one bad failure for the opposite bad failure. Now all N machines wake at 00:00, all N see the schedule is due, and all N fire the job. The backup runs N times, the invoice emails N times, the idempotency-violating side effect happens N times. You have eliminated missed-firing by guaranteeing double-firing. Distributed cron is the search for a design that has *neither* property: a job fires **once per scheduled tick, despite node failures**.

---

## The Two Failure Modes Are Symmetric — and Both Are Bad

It helps to state the target property precisely, because almost every design decision in distributed scheduling is a trade between the two ways to miss it.

**Double-firing** happens when more than one node believes it owns a tick, or when a single node retries a tick it already fired without remembering it did. The cost is duplicate side effects: two charges, two emails, two rows, two pages. For a non-idempotent job, double-firing is a correctness bug that reaches customers.

**Missed-firing** happens when no node fires a tick that was due — because the owner died between "tick is due" and "work started", or because a failover gap straddled the scheduled time, or because a clock was far enough off that the boundary was never observed. The cost is a silent gap: the backup that did not happen, the report that was never generated.

The two failures are mirror images, and which one you fear more dictates your whole approach. A scheduler can be tuned toward **at-most-once** firing (never double-fire, but accept that a tick might be lost in a failover) or **at-least-once** firing (never lose a tick, but accept that a tick might fire twice). There is no free lunch here — it is the same fundamental tension between safety and liveness that runs through all of distributed systems, and the [CAP-style](../01-foundations/03-cap-theorem.md) reality is that during a partition or a failover you cannot have both guarantees simultaneously. The escape hatch, discussed below, is to make the work **idempotent** so that at-least-once delivery becomes effectively exactly-once *effect*. That single design choice is what makes reliable distributed cron tractable.

---

## Why This Needs Coordination

To fire a tick exactly once across a fleet, the fleet must agree on a single actor responsible for that tick. There are two standard ways to manufacture that agreement, and they sit on a spectrum of cost and strength.

The first is **leader election**: the nodes run a consensus protocol so that exactly one of them is the scheduler at any time, and only the leader evaluates schedules and fires ticks. This is how most production schedulers stay singular — Airflow's scheduler historically relied on a single active instance, and HashiCorp Nomad and Kubernetes controllers elect a leader through their consensus layer. Leader election gives a strong guarantee (at most one leader per term) but requires a real consensus substrate such as Raft or ZAB underneath it; see [leader election](../02-distributed-databases/09-leader-election.md) and the [consensus algorithms](../02-distributed-databases/08-consensus-algorithms.md) that make it safe.

The second, lighter-weight mechanism is a **lease**: a node acquires a time-bounded, durably stored claim on the schedule (or on an individual tick) and must renew it to keep ownership. Whoever holds the lease is the scheduler; if the holder dies, the lease expires and another node takes over. Quartz Scheduler's clustered mode is the canonical example — a Quartz cluster coordinates through row locks in a shared database, so exactly one node fires each trigger even though every node is running. Leases are cheaper than full consensus and recover automatically, but they are only as safe as your clock assumptions, because lease expiry is a statement about *time*, and time is exactly the thing distributed systems cannot agree on. The detailed mechanics — lease duration versus heartbeat interval, fencing tokens to defeat a paused-then-resumed old owner — live in [leases, heartbeats, and recovery](./08-leases-heartbeats-recovery.md) and [distributed locks](../01-foundations/09-distributed-locks.md).

Whether by election or by lease, the goal is identical: collapse N candidate firers down to one owner per tick, so that the default behavior is single-firing and double-firing requires an actual coordination bug.

---

## The Clock Problem: You Cannot Trust Wall-Clock Equality

The deepest difficulty in distributed cron is that "fire at 00:00:00" is a statement about time, and time in a distributed system is a fiction maintained at considerable effort. Every machine has its own crystal oscillator, drifting at its own rate, disciplined by NTP toward a reference but never perfectly. In a well-run fleet, NTP keeps machines within a few milliseconds to low tens of milliseconds of each other; a misconfigured or network-isolated host can drift by seconds or, after a bad time-sync event, jump backward entirely. The full treatment of why this is unavoidable is in [distributed time](../01-foundations/05-distributed-time.md), but the consequence for scheduling is sharp.

The naive scheduler checks `if now() == scheduled_time` (or rounds `now()` to the minute and compares). On a single machine this is fine. Across a fleet it is a double-firing and missed-firing generator, because two nodes evaluating "is it 00:00 yet?" against two slightly different clocks will disagree about the instant the tick is due. If both believe they are due, you double-fire. If a clock jumps past the boundary, that node never observes equality and the tick is missed. Wall-clock equality is never a safe trigger predicate.

The robust pattern is to never compare clocks for equality and to never depend on cross-node clock agreement for correctness. Instead, store the *next fire time* durably and treat a tick as due when `now() >= next_fire_time`, deriving correctness from a single authoritative clock (typically the database server's time, used by every scheduler node) rather than from each node's local clock. Identity, crucially, comes from the schedule and its nominal time — `(schedule_id, scheduled_time)` — never from "the current time rounded to a minute". When two would-be schedulers both decide schedule A is due for `2026-06-15T00:00:00Z`, they compute the *same* identity and converge on the same tick instead of creating two.

Time zones and daylight-saving time turn this from hard to notorious. A schedule expressed as "every day at 02:30 America/New_York" is ambiguous twice a year: on spring-forward night 02:30 does not exist, and on fall-back night it exists *twice*. A scheduler that stores a numeric UTC offset instead of the IANA zone name (`America/New_York`, not `-05:00`) will silently fire an hour early or late after every DST transition, because the offset it cached is no longer the offset in effect. The defenses are concrete: store the IANA zone, not an offset; compute fire times against an up-to-date tz database; and make the spring-forward (skip or shift) and fall-back (fire once or twice) policies *explicit and user-visible*, because a hidden default here becomes a billing or compliance incident. DST bugs are a perennial source of real outages precisely because they hide until a transition night and then misfire every affected schedule at once.

---

## What About the Tick We Missed While the Leader Was Down?

Failover is not instantaneous. When the scheduler leader dies, there is a gap — lease expiry plus election plus warm-up — before a new leader takes over, and a scheduled tick can fall inside that gap. The new leader must answer a question the single-machine cron never had to: *what do I owe?* This is the single most important design decision in a distributed scheduler, and it has two parts: knowing what was missed, and deciding what to do about it.

Knowing requires durable state. The new leader cannot ask "what time is it now and what is due now"; it must ask "what was the last tick I successfully fired, and what should have fired between then and now". That demands persisting the **last-known-good fire time** for every schedule to durable storage, so a failover leader can reconstruct the backlog rather than guessing. This is the central lesson of Google's Borgcron, described in *Reliable Cron across the Planet* (ACM Queue, 2016) and Chapter 24 of the Google SRE book: the scheduler keeps a small amount of hard state — which jobs have launched and which have not — replicated across datacenters via Paxos, so that a newly-elected leader knows exactly what the dead leader had and had not done. Without that durable record, every failover risks either re-firing recently-fired ticks (double-fire) or skipping in-flight ones (missed-fire).

Deciding what to do is a **catch-up versus skip** policy, and the right answer depends entirely on the semantics of the job:

| Missed-run policy | Use when | Risk if misapplied |
|---|---|---|
| Skip the gap | Freshness beats completeness — cache warms, health pings | Lost periods that were actually required |
| Catch up every missed tick | Each period is legally or financially mandated — hourly billing, regulatory reports | Catch-up storm saturates workers after a long outage |
| Catch up only the latest | State is overwritten anyway — full snapshot sync | Intermediate periods genuinely needed are lost |
| Bounded catch-up | Old work is useful only within a freshness window | Tuning the window wrong silently drops or floods |

Catch-up has a sharp edge: after a multi-hour outage, "fire every missed tick" can dump hundreds of backlogged runs onto the fleet at once — a self-inflicted thundering herd. Borgcron and every mature scheduler bound this, and the backfilled runs should not share unlimited capacity with live ticks; route them to a separate queue or lower priority class so catch-up cannot starve real-time work. Airflow exposes exactly this tension through its `catchup` flag and `max_active_runs` limit, which is a per-schedule answer to "how much past am I willing to relive at once".

The policy only stays safe if a re-fired tick is harmless, which is why **idempotency** is the load-bearing assumption underneath all of this. If executing the same `(schedule_id, scheduled_time)` twice produces the same effect as executing it once, then catch-up is safe, at-least-once delivery is safe, and an overzealous failover is a non-event. The patterns that make a tick idempotent — idempotency keys, dedupe tables, compensating actions — are covered in [retry, idempotency, and compensation](./06-retry-idempotency-compensation.md) and the foundational [idempotency](../01-foundations/08-idempotency.md) treatment. Build the job to be idempotent and you convert the hardest correctness problem in scheduling into a tuning problem.

---

## Schedule Versus Execution

A recurring confusion is to conflate the *schedule* (a recurring rule about when work should happen) with the *execution* (the concrete job that one tick produces). They have different lifecycles and different identities, and keeping them separate is what makes a scheduler debuggable.

| Object | Example | Identity | Mutability |
|---|---|---|---|
| Schedule | "Every day at 09:00 Asia/Tokyo" | `schedule_id` | Mutable by users/config |
| Run (execution) | "schedule A for 2026-06-15T00:00:00Z" | `(schedule_id, scheduled_time)` | Immutable identity, mutable status |

The schedule is the *when*; firing it produces an immutable run record that is the *what*. That run record is the audit trail and, more importantly, the deduplication key. A clean way to enforce single-firing is to make the run record's creation an atomic, idempotent insert keyed on the tick identity:

```sql
INSERT INTO scheduled_runs (schedule_id, scheduled_time, status, created_at)
VALUES (:schedule_id, :scheduled_time, 'created', now())
ON CONFLICT (schedule_id, scheduled_time) DO NOTHING;
```

This turns "did this tick already fire?" from a distributed coordination question into a database uniqueness constraint: whichever scheduler wins the insert owns the tick, and the loser's `DO NOTHING` is a no-op rather than a duplicate. A scheduler crash *after* the insert but before launching the work is recoverable, because a reconciler can scan for runs stuck in `created` and enqueue them — the durable run record is what closes the gap between "decided to fire" and "actually fired".

Crucially, creating the run is where the scheduler's job usually *ends*. The scheduler decides a tick is due and emits a durable run; a separate [worker pool](./02-background-jobs-worker-pools.md) actually executes it. This separation is deliberate: scheduling is a low-throughput, coordination-heavy control-plane concern, while execution is a high-throughput, elastic, data-plane concern that wants independent [auto-scaling](../06-scaling/08-auto-scaling.md). Coupling them means a slow job blocks the next tick's evaluation; decoupling them means the scheduler stays a tiny, fast, single-owner component and the heavy lifting scales horizontally.

---

## Overlapping Runs: When a Job Outlasts Its Interval

A schedule that fires every five minutes assumes each run finishes in well under five minutes. Reality disagrees: a job slows down, a dependency stalls, the data volume grows, and run N is still going when run N+1 comes due. This is not an edge case; it is a guaranteed eventuality, and a scheduler that has no opinion about it will quietly do the most dangerous thing — start a second copy. There are exactly three policies, and the choice is a real design decision:

- **Skip** the new tick while the previous run is still active. Correct for jobs that are not safe to run concurrently and where a missed period is acceptable — a sync that will simply pick up more on its next successful run. Kubernetes CronJob exposes this directly as `concurrencyPolicy: Forbid`.
- **Queue** the new tick to run after the current one finishes. Correct when every period must eventually run but two cannot run at once — serializing them preserves both completeness and mutual exclusion, at the cost of falling progressively behind if the slowdown persists.
- **Allow concurrent** runs. Correct only when the job is genuinely independent per-tick and idempotent or partitioned, so two copies do not corrupt shared state. Kubernetes CronJob's default `Allow` is convenient and exactly the setting that produces overlapping-pileup incidents when applied thoughtlessly.

The pathological version is **overlap pileup**: with `Allow` and a job that has permanently slowed below its interval, every tick launches another concurrent copy, each contending for the same resources, each making the others slower, until the fleet melts. The guidance is concrete — default to `Forbid` or `Skip` for any job touching shared mutable state, reserve `Allow` for verified-independent work, and always cap concurrency so a slow job degrades gracefully instead of recruiting the whole fleet into its own slowdown.

---

## Sharding and Multi-Region: Staying Singular at Scale

A single elected scheduler is simple but eventually becomes a throughput bottleneck — a fleet running millions of schedules cannot evaluate all of them from one node every tick. The answer is to **shard schedule ownership**: partition schedules across scheduler instances (by hash of `schedule_id`, by time bucket, or by tenant), with each shard independently electing or leasing its own owner. The invariant to preserve through sharding is unchanged — exactly one owner per schedule — so a schedule must belong to exactly one shard, and shard reassignment during scaling must hand off ownership cleanly rather than letting two shards briefly both claim it. A useful refinement at scale is to separate the read-heavy *schedule scan* (which schedules are due?) from the write-heavy *run creation* (emit the durable tick), because they have different load profiles and scaling needs.

Multi-region multiplies the difficulty, because now two regions can each believe they own a schedule — a geographic version of split-brain. Active-active scheduling needs either a single home region per schedule (with explicit, deliberate failover when that region is lost) or a globally-consistent run identity (a cross-region unique constraint on `(schedule_id, scheduled_time)`) so that even simultaneous firing in two regions converges on one run. Borgcron solves this by running the cron service as a single Paxos-replicated state machine across datacenters: many replicas, one leader, one authoritative record of what has fired. The standing guidance for any job with external side effects is unambiguous — a cross-region *duplicate* tick is almost always worse than a *late* tick, so prefer stable ownership with explicit failover over racing active-active firers.

---

## Operational Visibility

A scheduler fails silently by nature — a missed tick produces no error, just an absence — so observability is not optional; it is how you detect the failure mode that has no exception. The signals worth alerting on are the ones that reveal the scheduler is falling behind or misbehaving before a customer notices: **schedule scan lag** (how stale is the oldest un-evaluated schedule), **tick-to-execution latency** (how long from due to actually fired), **duplicate-run conflict count** (how often two schedulers race for the same tick — a low non-zero number is healthy coordination working; a spike is split-brain), **missed-run count by policy**, **catch-up backlog depth**, and **leader/lease ownership churn** (frequent failovers point at clock or network trouble). The single most important alert is "oldest due schedule not yet evaluated", because it fires on the missed-firing failure that produces no log line of its own.

---

## Failure Modes

The characteristic failures of distributed schedulers recur across organizations, and naming them is most of preventing them.

**Double fire** — two nodes each believe they own a tick, or one node re-fires after a crash without remembering it already fired. Root cause is missing or weak single-ownership coordination, or a non-durable last-fire record. Defense: lease-or-elect a single owner, key runs on `(schedule_id, scheduled_time)`, and make execution idempotent so a duplicate is harmless rather than a customer-visible bug.

**Missed fire** — no node fires a due tick, usually because the owner died inside the due window or a clock jumped past the boundary. Defense: durable last-known-good fire time plus a catch-up policy, and a reconciler that enqueues runs stuck in `created`.

**Overlap pileup** — a job that runs longer than its interval launches concurrent copies that compound the slowdown. Defense: a per-schedule concurrency policy (`Forbid`/`Skip` by default) and a hard concurrency cap.

**Clock skew** — local-clock disagreement causes early, late, double, or missed ticks. Defense: discipline clocks with NTP, never trigger on wall-clock equality, and derive due-ness from a single authoritative clock.

**DST and time-zone bugs** — schedules fire an hour early/late, twice, or not at all around transitions. Defense: store IANA zone names not offsets, keep the tz database current, and make spring-forward/fall-back policy explicit and user-visible.

**Leader split-brain** — a paused-then-resumed old leader fires alongside the new one. Defense: fencing tokens and short, well-tuned leases so a stale owner is rejected when it tries to act. See [leases, heartbeats, and recovery](./08-leases-heartbeats-recovery.md).

**Catch-up storm** — an unbounded backfill after an outage dumps hundreds of runs at once and saturates the fleet. Defense: bounded catch-up, a separate queue or priority class for backfill, and a per-schedule cap on active runs.

---

## Decision Framework

The right scheduler is the cheapest design whose guarantees match the job's criticality and idempotency. Three questions resolve almost every case.

*Is the job idempotent, and how bad is a duplicate or a miss?* This dominates everything. An idempotent job that overwrites state can tolerate at-least-once firing and a much simpler scheduler. A non-idempotent job with customer-visible side effects (charges, emails, payouts) needs strict single-firing and durable dedupe, and should be made idempotent if at all possible before anything else.

*How critical is the job, and how big is the fleet?* These select the mechanism:

- **Single-node cron (Vixie cron, a systemd timer)** — correct for low-criticality, single-host jobs where a missed run during host downtime is acceptable. Simplest possible thing; do not over-engineer a log-rotation job into a distributed system.
- **Kubernetes CronJob** — the right default for containerized fleets needing survivability without standing up bespoke coordination. The control plane elects a controller, so the schedule survives any single node, and `concurrencyPolicy` plus `startingDeadlineSeconds` give explicit overlap and missed-run handling. Be aware its guarantee is roughly at-least-once: it can occasionally skip or double-fire around control-plane disruptions, so the job must still be idempotent.
- **A coordinated distributed scheduler (Quartz clustered, Airflow, Temporal cron workflows, or a Borgcron-style service)** — warranted for large fleets, many tenants, time-zone-aware business schedules, SLA-backed windows, and jobs where missed or duplicate firing has financial or regulatory weight. This is where durable last-fire tracking, sharded ownership, multi-region home regions, and explicit catch-up policy earn their complexity.

*At-most-once or at-least-once?* Decide deliberately, because during a failover you cannot have both. If a duplicate is worse than a miss, lean at-most-once and accept occasional gaps. If a miss is worse than a duplicate, lean at-least-once and make the work idempotent so the duplicates are free. The wrong answer here is to not choose, and to discover your scheduler's implicit choice during an incident.

---

## Key Takeaways

1. A single cron daemon is a single point of failure; running cron on every node fires every job N times — distributed cron exists to achieve neither, firing once per scheduled tick despite node failures.
2. The two failure modes are symmetric and both bad: double-firing causes duplicate side effects, missed-firing silently skips a tick. Decide which you fear more, because during a failover you cannot rule out both.
3. Idempotency is the load-bearing assumption: make a re-fired `(schedule_id, scheduled_time)` harmless, and at-least-once firing becomes effectively exactly-once effect.
4. Manufacture single ownership through leader election or a lease; never trust N nodes to independently agree on who fires a tick.
5. Never trigger on wall-clock equality across machines — derive due-ness from `now() >= next_fire_time` against one authoritative clock, and identify ticks by schedule plus nominal time, not by the current minute.
6. Store IANA time zones, not numeric offsets, and make DST spring-forward/fall-back policy explicit; transition nights are a perennial source of misfire incidents.
7. A failover leader must know what it owes: persist the last-known-good fire time durably (the Borgcron lesson) and apply a deliberate skip-versus-catch-up policy, bounding catch-up so it cannot become a thundering herd.
8. Decide an explicit overlap policy — skip, queue, or allow concurrent — for any job that can outlast its interval; default to forbidding overlap for jobs touching shared state.
9. Separate the schedule (when) from the execution (the resulting run), and hand execution off to an independently-scaled worker pool.
10. Match the mechanism to criticality and fleet size: single-node cron for trivial jobs, Kubernetes CronJob for containerized fleets, a coordinated distributed scheduler for critical, multi-tenant, time-zone-aware work.

---

## Related Patterns

- [Background Jobs and Worker Pools](./02-background-jobs-worker-pools.md) — where executions actually run after a tick fires
- [Retry, Idempotency, and Compensation](./06-retry-idempotency-compensation.md) — making a re-fired tick safe
- [Leases, Heartbeats, and Recovery](./08-leases-heartbeats-recovery.md) — single-owner mechanics and fencing
- [Distributed Time](../01-foundations/05-distributed-time.md) — why clocks cannot be trusted for equality
- [Leader Election](../02-distributed-databases/09-leader-election.md) and [Consensus Algorithms](../02-distributed-databases/08-consensus-algorithms.md) — electing one scheduler
- [Distributed Locks](../01-foundations/09-distributed-locks.md) and [Idempotency](../01-foundations/08-idempotency.md)
- [Auto-Scaling](../06-scaling/08-auto-scaling.md) — scaling the execution tier independently of the scheduler

---

## References

1. [Reliable Cron across the Planet](https://queue.acm.org/detail.cfm?id=2745840) — Štěpán Davidovič and Kavita Guliani, ACM Queue, 2016 (the Borgcron design)
2. [Site Reliability Engineering, Chapter 24: Distributed Periodic Scheduling with Cron](https://sre.google/sre-book/distributed-periodic-scheduling/) — Google, 2016
3. [Vixie cron](https://man7.org/linux/man-pages/man8/cron.8.html) — Paul Vixie, 1987, the de facto Unix cron
4. [Kubernetes CronJob](https://kubernetes.io/docs/concepts/workloads/controllers/cron-jobs/) — concurrency policy, starting deadline, and at-least-once semantics
5. [Quartz Scheduler: Configuring Clustering](https://www.quartz-scheduler.org/documentation/quartz-2.3.0/configuration/ConfigJDBCJobStoreClustering.html) — database-row-lock coordination
6. [Apache Airflow: DAG Runs, catchup, and max_active_runs](https://airflow.apache.org/docs/apache-airflow/stable/authoring-and-scheduling/dag-run.html)
7. [Temporal: Schedules and Cron](https://docs.temporal.io/workflows#schedule) — durable-execution scheduling with exactly-once semantics
8. [IANA Time Zone Database](https://www.iana.org/time-zones) — why zones, not offsets, are the correct unit
