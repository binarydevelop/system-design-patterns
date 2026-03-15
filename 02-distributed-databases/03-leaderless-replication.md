# Leaderless Replication

## TL;DR

Leaderless replication eliminates the leader entirely. Clients write to multiple nodes directly and read from multiple nodes, using quorums to ensure consistency. No single point of failure for writes. Trade-offs: requires quorum math, eventual consistency semantics, and careful conflict handling. Popularized by Dynamo; used by Cassandra, Riak, and Voldemort.

---

## How It Works

### Basic Concept

```
No leader. All nodes are equal.

Write request → send to ALL replicas
Read request → read from MULTIPLE replicas
Use quorum to determine success/latest value
```

### Write Path

```
Client writes to N replicas simultaneously:

┌────────┐
│ Client │───write(x=1)───┬─────────┬─────────┐
└────────┘                │         │         │
                          ▼         ▼         ▼
                     ┌───────┐ ┌───────┐ ┌───────┐
                     │Node A │ │Node B │ │Node C │
                     │  ✓    │ │  ✓    │ │  ✗    │
                     └───────┘ └───────┘ └───────┘
                          │         │
                          ▼         ▼
                     2 of 3 succeeded → write succeeds (if W=2)
```

### Read Path

```
Client reads from R replicas, takes latest:

┌────────┐
│ Client │───read(x)───┬─────────┬─────────┐
└────────┘             │         │         │
                       ▼         ▼         ▼
                  ┌───────┐ ┌───────┐ ┌───────┐
                  │Node A │ │Node B │ │Node C │
                  │ x=1   │ │ x=1   │ │ x=0   │
                  │ v=5   │ │ v=5   │ │ v=3   │
                  └───────┘ └───────┘ └───────┘
                       │         │
                       ▼         ▼
                  Compare versions → return x=1 (v=5 is latest)
```

---

## Quorum Math

### Parameters

```
N = Number of replicas
W = Write quorum (how many must acknowledge write)
R = Read quorum (how many to read from)
```

### The Quorum Condition

For strong consistency: **W + R > N**

```
Example: N=3, W=2, R=2

Write to any 2: {A, B} or {A, C} or {B, C}
Read from any 2: {A, B} or {A, C} or {B, C}

Overlap guaranteed:
  Write set ∩ Read set ≠ ∅
  At least one node has latest value
```

### Visual Proof

```
N=5, W=3, R=3

Nodes:     [A] [B] [C] [D] [E]
            │   │   │
Write to:   ✓   ✓   ✓           (any 3)
            │   │   │   │   │
Read from:          ✓   ✓   ✓   (any 3)
                    │
              Overlap at C
```

### Common Configurations

| Configuration | N | W | R | Properties |
|---------------|---|---|---|------------|
| Strong consistency | 3 | 2 | 2 | W+R=4 > 3 |
| Read-heavy | 3 | 3 | 1 | Fast reads, slow writes |
| Write-heavy | 3 | 1 | 3 | Fast writes, slow reads |
| Eventually consistent | 3 | 1 | 1 | Fastest, may read stale |

---

## Consistency Guarantees

### When W + R > N

**Strong consistency** (linearizability possible, not guaranteed):
- Every read sees latest write
- But: concurrent operations can still yield anomalies

```
Scenario: W=2, R=2, N=3

Write(x=1) to A, B succeeds
Read from B, C:
  B has x=1
  C has x=0 (hasn't received write yet)
  
Return x=1 (latest version wins)
```

### When W + R ≤ N

**Eventual consistency:**
- Might read stale data
- Eventually converges

```
Scenario: W=1, R=1, N=3

Write(x=1) to A only
Read from C only:
  C has x=0
  
Stale read! But eventually C will get x=1
```

### Sloppy Quorums

When N nodes unavailable, write to "substitute" nodes.

```
Normal: Write to {A, B, C}
A and B down: Write to {C, D, E} (D, E are substitutes)

Later: "Hinted handoff" moves data back to A, B
```

Trade-off:
- Better availability
- Weaker consistency (quorum may not overlap)

---

## Version Conflicts

### Concurrent Writes

```
Client 1: write(x, "A") → nodes {1, 2}
Client 2: write(x, "B") → nodes {2, 3}  (concurrent)

State after writes:
  Node 1: x = "A"
  Node 2: x = "A" or "B" (last one wins locally)
  Node 3: x = "B"

Read from {1, 3}: get {"A", "B"} — conflict!
```

### Vector Clocks for Conflict Detection

Each write carries a vector clock:

```
Write 1 at node A: {A:1}
Write 2 at node B: {B:1}

Compare:
  {A:1} vs {B:1}
  Neither dominates → concurrent → conflict

Merge or use LWW
```

### Siblings

Return all conflicting values to application:

```
Read(x) → {
  values: ["A", "B"],
  context: merged_vector_clock
}

Application decides how to merge
Next write includes context → system knows what was merged
```

---

## Read Repair and Anti-Entropy

### Read Repair

Fix stale replicas on read:

```
Read from A, B, C:
  A: x=1, version=5
  B: x=1, version=5
  C: x=0, version=3  ← stale

Return x=1 to client

Background: update C with version=5
```

**Opportunistic:** Only repairs nodes you happen to read from.

### Anti-Entropy (Background Repair)

Proactively sync replicas:

```
Periodically:
  for each pair of nodes (A, B):
    compare merkle trees
    for each different key:
      sync latest version
```

**Merkle trees** enable efficient comparison:
```
         [root hash]
         /          \
    [hash L]      [hash R]
    /      \      /      \
 [h1]   [h2]   [h3]   [h4]

Compare roots: different? → compare children
O(log n) to find differences in large datasets
```

---

## Hinted Handoff

When a node is temporarily unavailable:

```
Normal write target: A, B, C
A is down

Write to: B, C, D (D is hint recipient)
D stores: {key: x, value: 1, hint_for: A}

When A recovers:
  D sends hinted data to A
  D deletes hints
```

**Purpose:**
- Maintain write availability
- Don't lose writes during temporary failures

**Limitation:**
- Doesn't help with permanent failures
- Hints may accumulate if target stays down

---

## Handling Failures

### Read/Write Resilience

```
With N=5, W=3, R=3:
  Tolerate 2 failed nodes for writes
  Tolerate 2 failed nodes for reads
  
With N=5, W=2, R=4:
  Tolerate 3 failed nodes for writes
  Tolerate 1 failed node for reads
```

### Detecting Stale Data

```
def read_with_quorum(key, R):
  responses = parallel_read(key, all_replicas)
  wait_for(R, responses)
  
  latest = max(responses, key=lambda r: r.version)
  
  # Trigger read repair for stale replicas
  for r in responses:
    if r.version < latest.version:
      async_repair(r.node, key, latest)
  
  return latest.value
```

---

## Real-World Systems

### Amazon Dynamo

Original leaderless system (2007 paper):

```
- Consistent hashing for partitioning
- Vector clocks for versioning
- Sloppy quorums for availability
- Merkle trees for anti-entropy
- Hinted handoff for temporary failures

Design goal: "Always writable" shopping cart
```

### Apache Cassandra

```sql
-- Write with quorum
INSERT INTO users (id, name) VALUES (1, 'Alice')
USING CONSISTENCY QUORUM;

-- Read with one replica (fast, possibly stale)
SELECT * FROM users WHERE id = 1
USING CONSISTENCY ONE;

-- Configurable per-query
```

Configuration:
```yaml
# cassandra.yaml
num_tokens: 256
hinted_handoff_enabled: true
max_hint_window_in_ms: 10800000  # 3 hours
```

### Riak

```erlang
%% Write with W=2
riakc_pb_socket:put(Pid, Object, [{w, 2}]).

%% Read with R=2, return siblings
riakc_pb_socket:get(Pid, <<"bucket">>, <<"key">>, [{r, 2}]).

%% Application resolves siblings
resolve_siblings(Siblings) ->
    %% Custom merge logic
    merged_value.
```

---

## Tunable Consistency

### Per-Request Configuration

```
Request 1: Strong consistency
  W=quorum, R=quorum
  
Request 2: Fast write
  W=1, R=quorum
  
Request 3: Fast read
  W=quorum, R=1
  
Request 4: Fastest (eventual)
  W=1, R=1
```

### Consistency Levels (Cassandra)

| Level | Meaning |
|-------|---------|
| ONE | One replica |
| TWO | Two replicas |
| THREE | Three replicas |
| QUORUM | Majority in datacenter |
| EACH_QUORUM | Majority in each datacenter |
| LOCAL_QUORUM | Majority in local datacenter |
| ALL | All replicas |
| ANY | Any node (including hinted) |

---

## Edge Cases and Pitfalls

### Write-Read Race

```
Time:     T1          T2          T3
Client A: write(x=1, W=2)
Client B:             read(x, R=2)

If B's read arrives before write propagates to quorum:
  B might read stale value

Not linearizable even with W+R > N
```

### Last-Write-Wins Data Loss

```
Concurrent writes:
  Client A: write(x, "A") at t=100
  Client B: write(x, "B") at t=101

LWW resolves to "B"
Client A's write is lost

No error returned to Client A!
```

### Quorum Size During Failures

```
N=5, W=3, R=3 normally

2 nodes permanently fail, not replaced:
  Effective N=3
  W=3 → requires all remaining nodes (less resilient)
  
Solution: Replace failed nodes, or adjust quorum settings
```

---

## Monitoring Leaderless Systems

### Key Metrics

| Metric | Description | Action |
|--------|-------------|--------|
| Read repair rate | Repairs per second | High = inconsistency |
| Hint queue size | Pending hints | Growing = node issue |
| Quorum success rate | % achieving quorum | <100% = availability issue |
| Read latency p99 | Slow reads | Check straggler nodes |
| Version conflicts | Siblings created | High = concurrent writes |

### Health Checks

```python
def check_cluster_health():
  for node in nodes:
    # Check responsiveness
    if not ping(node):
      alert(f"Node {node} unreachable")
    
    # Check hint queue
    hints = get_hint_count(node)
    if hints > threshold:
      alert(f"Node {node} hint queue: {hints}")
    
    # Check anti-entropy
    last_repair = get_last_repair_time(node)
    if now() - last_repair > max_repair_interval:
      alert(f"Node {node} repair overdue")
```

---

## When to Use Leaderless

### Good Fit

- High write availability critical
- Multi-datacenter deployment
- Tolerance for eventual consistency
- Simple key-value workloads
- Known conflict resolution strategy

### Poor Fit

- Transactions required
- Strong consistency required
- Complex queries
- Applications can't handle conflicts
- Small datasets (overhead not worth it)

---

## Quorum Edge Cases

### Sloppy Quorums and Hinted Handoff Pitfalls

Dynamo-style sloppy quorums allow writes to non-home nodes during a network partition. This keeps the system writable but **breaks the strict quorum guarantee**:

```
Home nodes for key K: {A, B, C}
Partition isolates A and B

Sloppy quorum write (W=2): writes to {C, D}
Sloppy quorum read  (R=2): reads from {A, B}

Overlap = ∅ → stale read despite W + R > N
```

Hinted handoff eventually delivers data back to A and B, but there is **no upper bound** on how long that takes. During the gap, clients observe stale state with no indication that the quorum was sloppy.

### Read Repair Races

When multiple coordinators perform read repair concurrently on the same key, their repair writes can conflict:

```
Coordinator X reads key K → sees v5 on A, v3 on B → repairs B to v5
Coordinator Y reads key K → sees v5 on A, v4 on C → repairs C to v5
                         → also sees v3 on B (before X's repair lands)
                         → repairs B to v5 again (duplicate but harmless)

Dangerous case: if a new write v6 lands between the read and the repair,
the repair can overwrite v6 with v5 → data regression
```

Cassandra mitigates this by using cell-level timestamps: the repair write carries the original timestamp, so a newer write with a higher timestamp is never overwritten by a stale repair.

### Write Timeout with Persisted Data

A write can succeed on W nodes but the coordinator times out before receiving acknowledgements. The client sees an error and retries:

```
Attempt 1: write(x=1, id=abc) → W nodes store it → coordinator timeout → client error
Attempt 2: write(x=1, id=abc) → W nodes store again

Without idempotency keys, both writes are recorded.
For counters or append operations, this causes double-counting.
```

Mitigation: use client-generated idempotency tokens or make all writes idempotent by design (full-state replacement rather than delta).

### Weighted Quorums for Heterogeneous Nodes

Not all replicas have equal latency or reliability. A cross-region replica might be 100ms away while local replicas are sub-millisecond. Weighted quorums assign higher weight to local or faster nodes:

```
Node A (local):        weight=2
Node B (local):        weight=2
Node C (cross-region): weight=1

Total weight = 5
W = 3 (majority of weight)

Writing to A + B satisfies W=4 ≥ 3 without waiting for cross-region C
```

This reduces tail latency but increases the risk of data loss if both local nodes fail simultaneously.

---

## Anti-Entropy and Repair

### Merkle Tree Comparison

Each replica maintains a Merkle (hash) tree over its token ranges. To detect divergence, two replicas compare trees top-down:

```
Replica A tree          Replica B tree
     [H_root]               [H_root']        ← roots differ
     /       \               /       \
  [H_L]    [H_R]         [H_L]    [H_R']     ← right subtree differs
  /    \    /    \        /    \    /    \
[h1] [h2] [h3] [h4]    [h1] [h2] [h3] [h4'] ← only h4 segment differs

Result: only keys in segment 4 need synchronization
Comparison cost: O(log n) instead of O(n)
```

Trees are rebuilt periodically (Cassandra rebuilds on `nodetool repair`). Between rebuilds, the tree may be stale, so repair is a point-in-time snapshot reconciliation.

### Cassandra Repair Operations

Cassandra provides `nodetool repair` with two modes:

| Mode | Behavior | Use Case |
|------|----------|----------|
| Full repair | Compares all data in token ranges via Merkle trees | After node replacement, schema changes |
| Incremental repair | Only compares SSTables written since last repair | Regular maintenance, lower I/O cost |

**Critical interaction with `gc_grace_seconds`:**

```
gc_grace_seconds = 864000 (10 days, default)

Day 1:  DELETE key K → tombstone created on nodes A, B
Day 5:  Node C comes back online (was down since before Day 1)
Day 11: gc_grace expires → A, B discard tombstone
Day 12: Anti-entropy runs → C still has key K, A and B do not
         → C's value propagates back → zombie data resurrection

Prevention: always run repair within gc_grace_seconds window
```

### Read Repair vs Active Anti-Entropy

| Property | Read Repair (passive) | Anti-Entropy (active) |
|----------|----------------------|----------------------|
| Trigger | Client read | Background scheduled task |
| Coverage | Only keys that are read | All keys in token range |
| Latency impact | Adds repair writes to read path | No client-facing impact |
| Cold data | Never repaired if never read | Repaired on schedule |
| Resource cost | Proportional to read traffic | Proportional to data size |

Production systems use both: read repair catches hot-path inconsistencies immediately, while scheduled anti-entropy ensures cold data converges.

### Repair Scheduling Best Practices

- Run full repair at least once within `gc_grace_seconds` (typically weekly for a 10-day grace)
- Stagger repairs across nodes to avoid I/O storms
- Monitor `nodetool netstats` for streaming throughput during repair
- Sub-range repair (`-st`, `-et` flags) parallelizes across token ranges

---

## Dynamo vs Cassandra Differences

The original Dynamo paper and Cassandra diverge significantly in how they handle concurrent writes. Understanding these differences prevents incorrect assumptions when switching systems.

### Conflict Detection and Resolution

| Feature | Dynamo | Cassandra | Riak | ScyllaDB |
|---------|--------|-----------|------|----------|
| Versioning | Vector clocks | Cell-level timestamps | Vector clocks (dotted) | Cell-level timestamps |
| Conflict detection | Detects concurrent writes | No detection — LWW always | Detects concurrent writes | No detection — LWW always |
| Resolution strategy | Client-side merge | Last-writer-wins (silent) | Sibling merge (client) | Last-writer-wins (silent) |
| Client complexity | High — must handle siblings | Low — read returns one value | High — must handle siblings | Low — read returns one value |
| Data loss on conflict | No (client sees both) | Yes (earlier timestamp dropped) | No (client sees both) | Yes (earlier timestamp dropped) |

### Dynamo: Vector Clocks and Client Merge

Dynamo's shopping cart is the canonical example. Two concurrent `add-to-cart` operations produce siblings that the client must union-merge:

```
Cart v1: {widget}

Client A: add(gadget) → v2a: {widget, gadget}  [clock: {A:1}]
Client B: add(gizmo)  → v2b: {widget, gizmo}   [clock: {B:1}]

Neither dominates → conflict → client receives both siblings
Client merges: {widget, gadget, gizmo} → writes v3 [clock: {A:1, B:1}]
```

Trade-off: no data loss, but every client must implement merge logic. Deleted items can reappear if not tracked with a "removed" set (see CRDT discussion in `04-consistency-models.md`).

### Cassandra: Last-Writer-Wins Simplicity

Cassandra avoids client-side complexity by always picking the highest timestamp. This is safe when:

- Each key has a single writer (no concurrent updates)
- Writes are full-state replacements (not partial updates)
- Clock skew across nodes is small (NTP synchronized)

When these assumptions break, data is silently lost. There is no mechanism to detect that a concurrent write was dropped.

### Riak and ScyllaDB

**Riak** uses dotted version vectors (an optimization over classic vector clocks) and is the closest production system to the original Dynamo model. It supports configurable sibling resolution with `allow_mult=true`.

**ScyllaDB** is wire-compatible with Cassandra and inherits the same LWW semantics, but its C++ implementation delivers significantly lower tail latencies (p99). Same consistency trade-offs apply.

---

## Production Configuration

### Cassandra Replication and Consistency

```sql
-- SimpleStrategy: single datacenter, development
CREATE KEYSPACE myapp
  WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 3};

-- NetworkTopologyStrategy: multi-datacenter production
CREATE KEYSPACE myapp
  WITH replication = {
    'class': 'NetworkTopologyStrategy',
    'us-east': 3,
    'eu-west': 3
  };

-- Per-query consistency level
SELECT * FROM users WHERE id = ? USING CONSISTENCY LOCAL_QUORUM;
INSERT INTO events (id, data) VALUES (?, ?) USING CONSISTENCY EACH_QUORUM;
```

`LOCAL_QUORUM` is the most common production choice: it avoids cross-region latency while maintaining quorum guarantees within a single datacenter.

### DynamoDB Configuration

| Setting | Eventually Consistent Read | Strongly Consistent Read |
|---------|---------------------------|-------------------------|
| Latency | Lower | Higher (must read from leader) |
| Cost | 0.5 RCU per 4 KB | 1.0 RCU per 4 KB |
| Staleness | Up to ~1 second | None |
| Availability | Higher | Lower during partitions |

DynamoDB defaults to eventually consistent reads. Strongly consistent reads require `ConsistentRead=true` and cost twice as much. On-demand capacity mode eliminates provisioning but has higher per-request cost — suitable for unpredictable workloads.

### Monitoring and Observability

Key metrics for operating leaderless systems at scale:

```
Coordinator latency vs replica latency:
  coordinator_latency = max(replica_latencies) + coordination_overhead
  If p99 coordinator >> p99 replica → straggler problem

Speculative retries:
  Send read to extra replica if first R haven't responded within p50
  Reduces tail latency but increases read amplification
  Cassandra: speculative_retry = '99p'  (retry if slower than p99)

Read repair rate:
  Sustained high rate → nodes falling behind or frequent restarts
  Sudden spike → possible clock skew or network partition recovery
```

### When to Relax Consistency

Not every query needs quorum. Reducing consistency for specific use cases saves latency and cost:

| Use Case | Recommended CL | Rationale |
|----------|---------------|-----------|
| Analytics / reporting queries | ONE | Staleness acceptable, reduces cluster load |
| Search index building | ONE | Index will be refreshed; stale data is temporary |
| Cache warming | ONE | Cache miss falls back to stronger read anyway |
| User activity feeds | LOCAL_ONE | Feeds tolerate brief staleness |
| Financial transactions | LOCAL_QUORUM / EACH_QUORUM | Correctness required |
| Cross-region disaster recovery reads | LOCAL_QUORUM | Avoid cross-region latency |

---

## Key Takeaways

1. **No single point of failure** - Any node can serve reads/writes
2. **Quorum determines consistency** - W + R > N for strong consistency
3. **Conflicts are application's problem** - LWW or sibling resolution
4. **Read repair is opportunistic** - Anti-entropy provides background sync
5. **Hinted handoff helps availability** - But not consistency
6. **Sloppy quorums trade consistency** - For availability during partitions
7. **Tune per-request** - Different operations need different guarantees
8. **Not linearizable** - Even with strong quorums, concurrent ops cause anomalies
