# Network Partitions

## TL;DR

A network partition occurs when nodes in a distributed system cannot communicate with each other. Partitions are inevitable in any sufficiently large system. When partitioned, you must choose between consistency (reject operations) or availability (accept operations, resolve conflicts later). Design systems that detect, tolerate, and heal from partitions gracefully.

---

## What Is a Network Partition?

### Definition

A network partition divides nodes into groups that can communicate internally but not with other groups.

```
Before partition:
  ┌───────────────────────────────────┐
  │                                   │
  │   A ←──→ B ←──→ C ←──→ D ←──→ E   │
  │                                   │
  └───────────────────────────────────┘

After partition:
  ┌─────────────┐     ┌─────────────┐
  │             │  X  │             │
  │   A ←──→ B  │     │  C ←──→ D ←──→ E  │
  │             │     │             │
  └─────────────┘     └─────────────┘
    Partition 1         Partition 2
```

### Types of Partitions

**Complete partition:**
No communication between groups.

**Partial partition:**
Some paths work, others don't.

```
A ←──→ B ←──→ C
│             │
└──────X──────┘
      ↑
A can reach B, B can reach C
A cannot reach C directly
Asymmetric paths possible
```

**Asymmetric partition:**
A can send to B, but B cannot send to A.

```
A ───────→ B  ✓
A ←─────── B  ✗
```

### Causes of Partitions

| Cause | Duration | Scope |
|-------|----------|-------|
| Network switch failure | Minutes to hours | Rack/DC |
| Router misconfiguration | Minutes | Variable |
| BGP issues | Minutes to hours | Cross-DC |
| Fiber cut | Hours | Cross-region |
| Datacenter power failure | Hours | Single DC |
| Cloud provider outage | Hours | Region/Zone |
| Firewall rule change | Seconds to hours | Variable |
| DDoS attack | Hours | Targeted services |
| DNS failure | Minutes to hours | Variable |
| GC pause (perceived partition) | Seconds | Single node |

---

## Partition Frequency

### Real-World Data

Partitions are not rare:

- **Google:** ~5 partitions per cluster per year
- **Large-scale systems:** Multiple partial partitions daily
- **Cross-datacenter:** More frequent than within-DC

### Why Partitions Are Inevitable

```
P(no partition) = P(all components work)
                = P(switch1) × P(switch2) × ... × P(cable_n)
                
With many components, P(no partition) → low
```

**More nodes = more failure points = more partitions**

---

## Behavior During Partitions

### The CAP Choice

During a partition, choose:

**Availability (AP):**
```
Client → [Partition 1] → Response (possibly stale)
Client → [Partition 2] → Response (possibly stale)

Both partitions serve requests
Data may diverge
```

**Consistency (CP):**
```
Client → [Minority partition] → Error (unavailable)
Client → [Majority partition] → Response (consistent)

Only majority partition serves requests
```

### Minority vs Majority

**Majority partition** contains more than half the nodes:
- Can still form quorum
- Can elect leader
- Can make progress

**Minority partition:**
- Cannot form quorum
- Knows it's in minority (can't reach enough nodes)
- Should stop accepting writes (CP) or accept with caveats (AP)

```
5-node cluster, partition splits 3/2:

Partition A (3 nodes):
  - Has majority
  - Can elect leader
  - Continues normal operation

Partition B (2 nodes):
  - Minority
  - CP: Reject writes, serve stale reads
  - AP: Accept writes, merge later
```

---

## Detecting Partitions

### Timeout-Based

```
if time_since_last_message(node) > timeout:
  suspect_partition(node)

Problem: Can't distinguish:
  - Node crashed
  - Node slow
  - Network partition
  - Our network is the problem
```

### Heartbeat with Majority Check

```
func check_cluster_health():
  reachable = 0
  for node in cluster:
    if ping(node, timeout=1s):
      reachable++
  
  if reachable < majority_threshold:
    // We might be in minority partition
    enter_degraded_mode()
```

### External Observer

```
                    ┌────────────┐
                    │  Observer  │
                    │  (outside  │
                    │  cluster)  │
                    └─────┬──────┘
                          │
              ┌───────────┼───────────┐
              │           │           │
              ▼           ▼           ▼
           [Node A]    [Node B]    [Node C]

Observer can detect:
- Which nodes are reachable
- Potential partition topology
- Who is in minority
```

---

## Handling Partitions

### Strategy 1: Stop Minority

Minority partition stops accepting writes.

```
Leader election requires majority:
  if cannot_reach(majority):
    step_down()
    reject_writes()
    serve_stale_reads() or reject_all()
```

**Pros:** No divergence, strong consistency
**Cons:** Minority unavailable

### Strategy 2: Continue with Conflict Resolution

Both partitions accept writes, resolve on heal.

```
Partition 1: write(x, "A")
Partition 2: write(x, "B")

After heal:
  Conflict: x = "A" or x = "B"?
  Resolution: LWW, merge, or app-specific
```

**Pros:** Always available
**Cons:** Conflicts, complexity

### Strategy 3: Hinted Handoff

Store operations intended for unreachable nodes.

```
Node A wants to write to Node C (unreachable):
  1. Write to A's hint log for C
  2. When C becomes reachable, replay hints
  
Hint: {target: C, operation: write(x, 1), timestamp: T}
```

**Pros:** Eventual delivery
**Cons:** Hints can accumulate, ordering issues

---

## Split-Brain Prevention

### Fencing Tokens

Monotonically increasing tokens prevent stale leaders.

```
Leader v1: token = 100
  → [partition] →
  
New leader v2: token = 101

Old leader v1 (stale):
  write(data, token=100)
  → Storage: "Reject: token 100 < current 101"

Storage validates tokens, rejects old leaders
```

### STONITH (Shoot The Other Node In The Head)

Forcibly terminate competing nodes.

```
Node A detects Node B unresponsive:
  1. Assume B might still be running
  2. Physically power off B (IPMI, cloud API)
  3. Wait for B to be definitely dead
  4. Take over B's resources

Prevents both nodes from acting as primary
```

### Quorum with External Arbiter

Use external service to break ties.

```
Cluster of 2 nodes (can't have majority):
  Add external arbiter (ZooKeeper, etcd, cloud metadata)
  
Election:
  if can_reach(peer) and can_reach(arbiter):
    elect_leader()
  elif can_reach(arbiter) but not peer:
    arbiter decides who becomes leader
```

---

## Partition-Tolerant Design Patterns

### Read Repair

Fix inconsistencies on read.

```
Read from replicas A, B, C:
  A returns: x=1, version=5
  B returns: x=1, version=5
  C returns: x=1, version=3  ← stale

After returning x=1 to client:
  Background: update C with version=5
```

### Anti-Entropy

Background process synchronizes replicas.

```
Periodically:
  for each pair of replicas (A, B):
    diff = compare_merkle_trees(A, B)
    for each differing key:
      sync_latest_version(A, B, key)
```

### Merkle Trees

Efficient comparison of large datasets.

```
         [root hash]
         /          \
    [hash L]      [hash R]
    /      \      /      \
 [h1]   [h2]   [h3]   [h4]
  |      |      |      |
 k1     k2     k3     k4

Compare roots:
  Same → data identical
  Different → descend to find differences
  
O(log n) to find differences
```

### CRDTs (Conflict-Free Replicated Data Types)

Data structures that merge automatically.

```
G-Counter (grow-only counter):
  Each node maintains its own count
  Merge = take max per node
  Total = sum all nodes
  
  Node A: {A:5, B:3}
  Node B: {A:4, B:7}  (B's A count is stale)
  
  Merge: {A:5, B:7}
  Total: 12
```

---

## Partition Examples

### Example 1: Database Replication

```
Primary in DC1, replicas in DC1 and DC2

DC1 ←──[partition]──→ DC2

Synchronous replication:
  DC1: "Cannot ack writes, DC2 unreachable"
  Result: Writes blocked, consistency maintained

Asynchronous replication:
  DC1: Accept writes, queue for DC2
  DC2: Serve stale reads
  Result: Available but inconsistent
```

### Example 2: Leader Election

```
5-node Raft cluster: [A, B, C, D, E]
Leader: A
Partition: [A, B] | [C, D, E]

Minority [A, B]:
  A: Cannot reach majority, steps down
  No leader, no writes

Majority [C, D, E]:
  C, D, E hold election
  New leader elected (say, C)
  Continue serving writes
```

### Example 3: Shopping Cart

```
User adds item in Region 1
User adds item in Region 2 (partition active)

Region 1 cart: [item_a, item_b]
Region 2 cart: [item_a, item_c]

On heal:
  Merge carts: [item_a, item_b, item_c]
  
  Using OR-Set CRDT:
    Add wins over concurrent remove
    Duplicates handled by unique IDs
```

---

## Testing Partitions

### Network Simulation

```bash
# Linux tc (traffic control)
# Add 100% packet loss to specific host
tc qdisc add dev eth0 root netem loss 100%

# iptables - block specific traffic
iptables -A INPUT -s 10.0.0.5 -j DROP
iptables -A OUTPUT -d 10.0.0.5 -j DROP
```

### Chaos Engineering Tools

| Tool | Approach |
|------|----------|
| Jepsen | Black-box partition testing |
| Chaos Monkey | Random instance termination |
| Toxiproxy | Programmable network proxy |
| tc + netem | Linux kernel network simulation |
| Docker network disconnect | Container-level isolation |

### Jepsen Testing

```
1. Start cluster
2. Begin workload (reads, writes)
3. Inject partition (various topologies)
4. Continue workload
5. Heal partition
6. Verify consistency invariants

Common checks:
  - No lost acknowledged writes
  - Linearizable history
  - Read-your-writes maintained
```

---

## Recovery from Partitions

### Healing Process

```
1. Detect partition healed
   - Nodes can communicate again
   - Heartbeats resume

2. Synchronize state
   - Anti-entropy runs
   - Hinted handoffs delivered
   - Merkle tree comparison

3. Resolve conflicts
   - LWW or vector clocks
   - CRDT merge
   - Application-level resolution

4. Resume normal operation
   - Leader re-established (if needed)
   - Quorums restored
```

### Conflict Resolution Strategies

| Strategy | How It Works | Trade-off |
|----------|--------------|-----------|
| Last-Writer-Wins | Higher timestamp wins | May lose writes |
| First-Writer-Wins | Lower timestamp wins | May lose writes |
| Multi-Value | Keep all versions | Application must resolve |
| Custom Merge | Application-specific logic | Complexity |
| CRDT | Automatic merge | Limited data types |

### Post-Partition Verification

```
After heal:
  1. Compare checksums across replicas
  2. Run anti-entropy scan
  3. Verify no orphaned data
  4. Check referential integrity
  5. Alert on unresolved conflicts
```

---

## Gray Failures

### Definition

A gray failure is a partial failure that is neither fully down nor fully up. The system continues to function but with degraded behavior that is difficult to detect through traditional binary health checks.

```
Failure spectrum:

  Fully healthy        Gray failure zone        Fully failed
      |                  |         |                  |
      ├──────────────────┤─────────┤──────────────────┤
   All requests      5% packet   One-way          No responses
   succeed quickly   loss, high  failure           at all
                     p99 latency
```

### Examples

- **Packet loss at low rates:** 2–5% packet loss passes health checks. TCP retransmission masks it, but tail latency spikes.
- **One-way failure:** A→B works, B→A drops. B thinks A is dead; A thinks B is healthy. Cluster membership disagrees.
- **Intermittent connectivity:** Link flaps every few seconds — too short for timeout detection, but aggregate availability is poor.

### Why Gray Failures Are Worse Than Total Failures

| Property | Total Failure | Gray Failure |
|----------|--------------|--------------|
| Detection time | Seconds | Minutes to hours |
| Confidence | High (no response) | Low (some responses succeed) |
| Failover decision | Clear (promote replica) | Ambiguous (is failover premature?) |
| Blast radius | Contained to failed node | Cascading (slow node backs up queues) |
| Recovery | Restart and rejoin | Root cause unclear, may recur |

Microsoft Research (2017) found that most severe outages in large-scale cloud systems stemmed from gray failures, not fail-stop crashes. Systems designed for binary up/down states miss the spectrum in between.

### Detection Strategies

- **Multi-path probing:** Probe each node from multiple observers. If only one reports failure, the issue may be path-specific.
- **Application-level health checks:** TCP liveness is insufficient — verify end-to-end request serving.
- **Peer-to-peer failure reporting:** Nodes gossip about peer health. Multiple reports of the same degraded peer increase confidence (used by Cassandra).

```
GET /health      → 200 OK                     // shallow — misses gray failures
GET /health/deep → { "db_latency_ms": 2400,   // ← abnormally high
                     "cache_hit_rate": 0.12,   // ← abnormally low
                     "error_rate_1m": 0.04 }   // ← above threshold
```

---

## Real Partition Incidents

### AWS US-East-1 (April 2011)

A routine network change caused EBS storage nodes to lose connectivity and enter a re-mirroring storm. Cascading re-replication consumed available capacity. MySQL clusters experienced split-brain when primary and replica lost contact. Recovery took over 12 hours. Reddit, Foursquare, and Quora went fully offline.

### GitHub (October 2018)

Replacing a failing 100G network link caused a 43-second connectivity loss between the US East Coast database primary and its replicas. The orchestration tool promoted a West Coast replica to primary. When connectivity restored, the old and new primary had diverged — 24 hours of degraded service followed. Automated tooling could not resolve the bidirectional replication conflicts.

### Cloudflare (July 2020)

A BGP misconfiguration in a backbone provider caused Cloudflare routes to be withdrawn from parts of the internet. For 27 minutes, traffic from affected networks could not reach Cloudflare edge servers. The failure was external — Cloudflare nodes were healthy internally — but the partition between users and edge was functionally identical to a network partition.

### Google Cloud (June 2019)

A configuration change reduced available bandwidth on backbone links, causing packet loss across multiple GCP regions. Cascading effects hit Compute Engine, Cloud Storage, and BigQuery for approximately 4 hours — demonstrating how bandwidth-level gray failures propagate across service boundaries.

### Lessons Learned

| Incident | Root Cause | Prevention |
|----------|-----------|------------|
| AWS 2011 | Re-mirroring storm | Rate-limit recovery, capacity reserves |
| GitHub 2018 | Timeout-based promotion | Quorum-based promotion |
| Cloudflare 2020 | External BGP withdrawal | Multi-provider BGP, anycast |
| Google 2019 | Bandwidth config change | Canary network changes |

**Common theme:** every incident involved a routine operation that triggered an unexpected partition. The system's reaction — not the partition itself — caused the outage.

---

## Advanced Partition-Tolerant Patterns

### Circuit Breaker with Partition Awareness

Distinguish between timeouts (possible partition) and explicit errors (definite failure). Apply different fallback strategies for each.

```
func call_remote_service(request):
  try:
    response = send(request, timeout=2s)
    breaker.record_success()
    return response
  catch TimeoutError:
    breaker.record_timeout()
    if breaker.timeout_rate > 0.5:
      return serve_from_cache(request)  // partition — use cached data
  catch ConnectionRefused:
    breaker.record_error()
    if breaker.error_rate > 0.5:
      return error("Service unavailable")  // definite failure — fail fast
```

Timeouts mean the remote side may still be processing — retrying risks duplicates. Explicit errors mean rejection — retry is safe if idempotent (see `08-idempotency.md`).

### Crumbling Walls

Degrade gracefully by shedding non-critical features, preserving the core user journey.

```
if partition_detected():
  disable(priority_3)  // A/B tests, personalization, ads
  if sustained_partition(duration > 5m):
    disable(priority_2)  // Recommendations, reviews, analytics
  serve_priority_1_with_local_data()  // Checkout, auth, order status
```

Define the shedding order before the partition happens, not during an incident.

### Session Affinity During Partition

Keep users pinned to the same side of the partition for their session duration. This avoids the worst user-facing inconsistency: seeing your own write disappear.

```
User on Partition A: reads/writes A → consistent view
User rerouted to B mid-session:     → cart items vanish, order reverts

Solution: sticky sessions via session ID hash during detected partition
```

### Conflict-Free Operations

Design writes that are safe on both sides without conflict resolution:

- **Commutative:** `increment(counter, 5)` not `set(counter, 15)` — merge by summing
- **Idempotent:** `set_if_absent(key, value)` — applying twice is safe
- **Append-only:** `add_to_set(cart, item_id)` — union is conflict-free

### Partition Recovery Protocol

Define merge strategy before the partition happens — during the partition is too late.

```
Pre-partition contract:
  1. Each partition logs mutations with vector clock timestamps
  2. On heal, compare mutation logs from both sides
  3. Apply merge per data type:
     Counters → sum deltas | Sets → union | Registers → LWW
  4. Verify merged state against invariants
  5. If invariants violated → flag for manual resolution
```

---

## Systematic Partition Testing

### Chaos Engineering Tooling

**Toxiproxy** — A TCP proxy between your application and its dependencies for programmatic failure injection.

```bash
# Create proxy for database connection
toxiproxy-cli create pg --listen 0.0.0.0:15432 --upstream db-primary:5432

# Gray failure: 5s latency with jitter
toxiproxy-cli toxic add pg --type latency --attribute latency=5000 --attribute jitter=1000

# Total partition: drop all traffic
toxiproxy-cli toxic add pg --type timeout --attribute timeout=0
```

**iptables** — Kernel-level asymmetric partition simulation.

```bash
iptables -A INPUT -s 10.0.1.0/24 -j DROP  # block incoming only → one-way partition
```

### Jepsen for Partition Validation

Jepsen automates partition testing for distributed systems (see `03-cap-theorem.md` for CAP context). It generates concurrent workloads, injects faults, and verifies consistency against a formal model.

Key findings: many "CP" databases lose acknowledged writes during partitions, many "AP" databases fail to converge after heal, and clock skew combined with partitions produces the worst bugs.

### Game Days

Scheduled partition simulation exercises for practicing incident response in a controlled environment.

```
Game day: announce window → inject partition → observe alerting
  → respond per runbook → verify data consistency → retro on gaps
```

Netflix pioneered this with Chaos Monkey (instance termination) and Chaos Kong (region evacuation). The goal is to discover whether your system handles breaking correctly.

### Verification Checklist

| Check | Method |
|-------|--------|
| No lost acknowledged writes | Compare write log against final state |
| No duplicate processing | Verify idempotency keys, count side effects |
| Correct failover/failback | Confirm primary promotion and replica rejoin |
| Data consistency | Cross-replica checksum comparison |
| Referential integrity | Foreign key / cross-entity validation |

---

## Key Takeaways

1. **Partitions are inevitable** - Design for them, not around them
2. **You must choose** - Availability or consistency during partition
3. **Majority can proceed** - Minority should be careful
4. **Split-brain is dangerous** - Use fencing, quorums, or arbiters
5. **Detection is imperfect** - Timeout-based, can false-positive
6. **Plan for healing** - Anti-entropy, conflict resolution, verification
7. **Test partitions** - Chaos engineering, Jepsen testing
8. **CRDTs help** - Automatic merge for appropriate data types
