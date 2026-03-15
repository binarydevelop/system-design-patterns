# Message Ordering

## TL;DR

Message ordering determines whether messages are delivered in the order they were sent. Options range from no ordering (best performance) to total ordering (worst performance). Most systems use partition-based ordering: messages with the same key are ordered, different keys may interleave. Choose based on business requirements—true total ordering is rarely needed and expensive.

---

## Why Ordering Matters

### The Problem

```
User actions (sent in this order):
  1. Create account
  2. Update profile
  3. Delete account

If delivered out of order:
  Delete arrives first → "Account not found" error
  Update arrives → Creates orphaned data
  Create arrives → Account exists again

Result: Corrupted state
```

### When Ordering Matters

```
Critical:
  - Financial transactions (credit before debit)
  - State machine transitions
  - Log aggregation
  - Replication

Less Critical:
  - Analytics events (can be reordered later)
  - Notifications (slight reorder OK)
  - Independent operations
```

---

## Ordering Levels

### No Ordering Guarantee

```
Messages may arrive in any order

Producer sends: A, B, C
Consumer sees:  C, A, B (any permutation)

Advantages:
  - Maximum throughput
  - Easy scaling
  - No coordination

Use when:
  - Operations are independent
  - Consumer can handle any order
```

### FIFO Within Producer

```
Each producer's messages arrive in order
Different producers may interleave

Producer 1: A1, B1, C1 → arrive in order
Producer 2: A2, B2, C2 → arrive in order

But overall: A1, A2, B1, C2, B2, C1 (interleaved)

Use when:
  - Events from same source must be ordered
  - Different sources are independent
```

### FIFO Within Partition/Key

```
Messages with same key are ordered
Different keys may interleave

Key=user1: login, update, logout → ordered
Key=user2: login, purchase → ordered

But: user1.login, user2.login, user1.update... (interleaved)

Most common approach
Kafka, SQS FIFO use this
```

### Total Ordering

```
ALL messages in strict global order

Send: A, B, C, D, E
Receive: A, B, C, D, E (exactly)

Requires:
  - Single partition/queue
  - Or distributed consensus

Expensive, limits throughput
Rarely truly needed
```

---

## Kafka Ordering

### Partition-Based

```
Topic with 3 partitions:
  Partition 0: [A, D, G]
  Partition 1: [B, E, H]
  Partition 2: [C, F, I]

Within partition: Strictly ordered
Across partitions: No ordering

Producer:
  - Key = null: Round-robin to partitions
  - Key = "user123": Hash to consistent partition
```

### Consumer Groups

```
Consumer Group A:
  Consumer 1 ← Partition 0
  Consumer 2 ← Partition 1
  Consumer 3 ← Partition 2

Each partition processed by one consumer
Ordering preserved within partition

If consumer fails:
  Partition reassigned
  Continues from last committed offset
```

### Ordering Guarantees

```python
# Producer: Same key = same partition = ordered
producer.send(topic='events', key='user123', value=event1)
producer.send(topic='events', key='user123', value=event2)
# event1 always before event2 for user123

# Consumer: Process in order
for message in consumer:
    process(message)
    consumer.commit()  # Commit offset
```

---

## SQS FIFO Ordering

### Message Group ID

```python
# Messages with same group ID are ordered
sqs.send_message(
    QueueUrl=queue_url,
    MessageBody='{"action": "create"}',
    MessageGroupId='user-123',
    MessageDeduplicationId='msg-001'
)

sqs.send_message(
    QueueUrl=queue_url,
    MessageBody='{"action": "update"}',
    MessageGroupId='user-123',
    MessageDeduplicationId='msg-002'
)

# Consumer receives in order for user-123
```

### Deduplication

```
FIFO queues deduplicate by:
  - MessageDeduplicationId (explicit)
  - Content hash (if content-based dedup enabled)

Window: 5 minutes
Same ID in window → message dropped
```

### Throughput Limits

```
Standard SQS: Unlimited throughput
FIFO SQS: 300 msg/sec (3000 with batching)

Per message group: 300 msg/sec max
Use multiple groups to scale
```

---

## Implementing Ordering

### Sequence Numbers

```python
class OrderedProducer:
    def __init__(self):
        self.sequence = {}  # key → last sequence
    
    def send(self, key, message):
        seq = self.sequence.get(key, 0) + 1
        self.sequence[key] = seq
        
        message['_seq'] = seq
        queue.send(key=key, message=message)

class OrderedConsumer:
    def __init__(self):
        self.expected_seq = {}  # key → expected next
        self.buffer = {}  # key → out-of-order messages
    
    def process(self, key, message):
        seq = message['_seq']
        expected = self.expected_seq.get(key, 1)
        
        if seq == expected:
            # In order - process
            handle(message)
            self.expected_seq[key] = seq + 1
            
            # Check buffer for next messages
            self.process_buffered(key)
        elif seq > expected:
            # Out of order - buffer
            self.buffer.setdefault(key, {})[seq] = message
        # seq < expected: Duplicate, ignore
```

### Resequencing Buffer

```
Incoming (out of order): 3, 1, 4, 2, 5

Buffer state:
  Receive 3: buffer=[3], wait for 1
  Receive 1: process 1, buffer=[3], wait for 2
  Receive 4: buffer=[3,4], wait for 2
  Receive 2: process 2,3,4, buffer=[], wait for 5
  Receive 5: process 5

Considerations:
  - Buffer size limit
  - Timeout for missing sequences
  - Gap detection
```

### Handling Gaps

```python
def handle_potential_gap(key, expected, received):
    gap_start = expected
    gap_end = received - 1
    
    # Wait for gap to fill
    wait_until = time.time() + GAP_TIMEOUT
    
    while time.time() < wait_until:
        if gap_filled(key, gap_start, gap_end):
            return True
        sleep(0.1)
    
    # Gap timeout - decide action
    if GAP_POLICY == 'skip':
        log.warn(f"Skipping gap {gap_start}-{gap_end}")
        return True
    elif GAP_POLICY == 'fail':
        raise GapError(f"Gap detected: {gap_start}-{gap_end}")
```

---

## Scaling with Ordering

### Partition Strategies

```
By entity ID:
  user-123 → partition 0
  user-456 → partition 1
  All events for user-123 ordered ✓

By time bucket:
  Events 00:00-00:05 → partition 0
  Events 00:05-00:10 → partition 1
  Time-ordered within bucket

By hash:
  hash(key) % num_partitions
  Uniform distribution
```

### Increasing Partitions

```
Initial: 4 partitions
  Key A → partition 1
  Key B → partition 3

After adding partitions: 8 partitions
  Key A → partition 5 (different!)
  Key B → partition 3 (might change)

Problem: Key-partition mapping changes

Solutions:
  - Over-partition initially (100+ partitions)
  - Use consistent hashing
  - Coordinate partition increase with consumers
```

### Parallel Processing Limits

```
Strictly ordered queue:
  Max parallelism = number of keys
  
  1000 unique keys = 1000 parallel operations
  
If single key has high volume:
  That key becomes bottleneck
  Consider time-windowing or sub-keys
```

---

## Common Patterns

### Ordered by Entity

```python
# All events for an entity go to same partition
def get_partition_key(event):
    return event.entity_id

# Examples:
# Order events → key = order_id
# User events → key = user_id
# Session events → key = session_id
```

### Ordered by Causality

```
If event B depends on event A:
  Use same partition key

User creates order → Order events
  Key for both: order_id
  Creation before updates guaranteed

But: User profile update doesn't need order ordering
  Different partition key OK
```

### Hybrid Ordering

```
Critical path: FIFO queue (ordered, slower)
Best-effort: Standard queue (fast, unordered)

Create/Update/Delete → FIFO (order matters)
Analytics events → Standard (order doesn't matter)
```

---

## Trade-offs

| Ordering Level | Throughput | Latency | Complexity |
|----------------|------------|---------|------------|
| None | Highest | Lowest | Lowest |
| Per-producer | High | Low | Low |
| Per-key | Medium | Medium | Medium |
| Total | Lowest | Highest | Highest |

### Decision Framework

```
Question 1: Do messages affect shared state?
  No → No ordering needed
  Yes → Continue

Question 2: Is state partitioned by key?
  Yes → Per-key ordering sufficient
  No → Continue

Question 3: Is total ordering truly required?
  Usually no → Reconsider design
  Yes → Accept performance penalty
```

---

## Debugging Ordering Issues

### Out-of-Order Detection

```python
def detect_out_of_order(messages):
    issues = []
    last_seq = {}
    
    for msg in messages:
        key = msg.partition_key
        seq = msg.sequence
        
        if key in last_seq:
            if seq <= last_seq[key]:
                issues.append({
                    'key': key,
                    'expected': last_seq[key] + 1,
                    'got': seq
                })
        
        last_seq[key] = seq
    
    return issues
```

### Logging for Ordering

```python
logger.info(f"Received message",
    extra={
        'message_id': msg.id,
        'partition': msg.partition,
        'offset': msg.offset,
        'key': msg.key,
        'sequence': msg.sequence,
        'timestamp': msg.timestamp
    }
)

# Enables post-hoc ordering analysis
```

---

## Kafka Partition Ordering Deep Dive

### Ordering Guarantee Scope

```
Within a single partition:
  Total order by offset. Consumer reads 0, 1, 2, 3... sequentially.

Across partitions:
  NO ordering guarantee. Partition 0 offset 5 may be newer or older
  than Partition 1 offset 5. poll() returns batches in arbitrary order.
```

### Partition Key Selection

```
Key groups causally related messages:
  Order lifecycle  → order_id  (create, pay, ship → ordered)
  User activity    → user_id   (login, click, logout → ordered)
  Device telemetry → device_id (readings in chronological order)

Anti-pattern:
  random_uuid → spreads load but destroys ordering
  event_type  → groups unrelated entities together
```

### Hot Partition Problem

```
Celebrity user_id → one partition gets 100x traffic, others idle.

Mitigations:
  1. Compound key (user_id + session_id) — trades per-user for per-session ordering
  2. Accept imbalance — scale hot consumer vertically, monitor partition lag
  3. App-level sharding — split into virtual sub-users, merge downstream
```

### Rebalancing and Ordering

```
Consumer group rebalance (consumer joins/leaves/crashes):

  Eager protocol (default before 2.4):
    All consumers stop fetching during rebalance
    Brief processing gap, but no out-of-order delivery
    After rebalance, resumes from last committed offset

  Cooperative rebalancing (Kafka 2.4+):
    Only revoked partitions stop, others continue processing
    Reduces blast radius — preferred for large consumer groups
```

### In-Flight Requests and Retries

```
Producer config: max.in.flight.requests.per.connection

  Set to 5 (default):
    Batch 1 fails, Batch 2 succeeds, Batch 1 retries
    → Broker receives: Batch 2, Batch 1 → OUT OF ORDER

  Set to 1:
    One request at a time → correct order, lower throughput

  Idempotent producer (enable.idempotence=true):
    Broker tracks producer sequences, rejects out-of-order writes
    Safe with max.in.flight=5. Recommended for ordering-sensitive workloads.
```

---

## Ordering Across Services

### The Fundamental Problem

```
Single-service: B crashes on E2 → restarts → replays from offset → works fine

Cross-service: B processes E1→F1, E2→F2, publishes to C
  F2 arrives at C before F1 (different topic/partition) → OUT OF ORDER

No broker guarantees ordering across independent topics and services.
```

### Sequence Numbers for Cross-Service Ordering

```python
# Publisher embeds monotonic sequence per aggregate
def publish(self, aggregate_id, event):
    version = self.store.increment_version(aggregate_id)
    event['aggregate_version'] = version
    broker.send(key=aggregate_id, value=event)

# Consumer enforces version ordering
def on_event(self, event):
    version = event['aggregate_version']
    last = self.store.get_last_version(event['aggregate_id'])

    if version == last + 1:      # Expected → apply
        self.apply(event)
        self.store.set_last_version(event['aggregate_id'], version)
    elif version <= last:         # Duplicate → skip
        pass
    else:                         # Future → buffer
        self.buffer(event['aggregate_id'], event)
```

### Causal Ordering with Vector Clocks

```
When events have causal dependencies across entities:

  Event A (user created)  → clock {user_svc: 1}
  Event B (order created) → clock {order_svc: 1, user_svc: 1}

  Consumer receives B before A:
    Missing user_svc:1 → buffer B → receive A → process A, then B

  Simpler alternative — causal tokens:
    Event A produces token T1. Event B declares dependency: [T1].
    Consumer checks: seen T1? No → buffer B.

Use only when partition-key ordering is insufficient (cross-entity chains).
```

---

## Ordering vs Performance Tradeoffs

### Guarantee Spectrum

| Guarantee | Throughput | Parallelism | When to Use |
|-----------|-----------|-------------|-------------|
| No ordering (fanout) | Maximum | Unlimited | Notifications, analytics, log shipping |
| Partition ordering (per-key) | High | # partitions | Order lifecycle, user activity, device telemetry |
| Total ordering (single partition) | Lowest | 1 consumer | Financial ledger, distributed log, changelog |

### Throughput (Approximate)

```
Kafka (3 brokers, 100-byte msgs):
  No ordering: ~2M msg/sec | Partition: ~1M | Total: ~50K

SQS:
  Standard: ~120K msg/sec | FIFO per group: 300 (3000 batched)

The gap between partition and total ordering is 20x+.
```

### The 90% Rule

```
Most systems only need partition-level ordering.

Ask: "Do events for DIFFERENT entities need relative ordering?"

  Almost always no:
    User A vs User B → independent
    Order #100 vs #101 → independent

  If truly yes:
    Can you merge entities under a common aggregate key?
    Can you use a single-writer pattern instead?
    Only after exhausting alternatives: accept single-partition penalty.
```

---

## Reordering Recovery Patterns

### Out-of-Order Detection

```
Detection signals:
  - Sequence jump: received 5, expected 3 (gap = [3, 4])
  - Timestamp regression: event.ts < last_processed.ts
  - Version skip: aggregate_version jumps from 2 to 5

Monitoring:
  Metric: ordering_gap_detected{topic, partition, consumer_group}
  Alert when gap rate exceeds baseline
```

### Buffering Strategy

```
Hold future events until gaps are filled:

  last_processed=2, buffer={5: event5}
  Receive 3 → process, Receive 4 → process, buffer has 5 → process

  Risk: buffer grows unbounded if events are truly lost
  Mitigation: cap buffer size per key (e.g., 1000 events max)
```

### Timeout and Proceed

```
After N seconds waiting for missing events, accept the gap:

  Gap [3,4] detected → start 30s timer
  Timeout expires → log gap, skip to 5, process buffered events

  Late arrivals (3 or 4 after timeout):
    Option A: Ignore (moved past them)
    Option B: Apply retroactively if idempotent
    Option C: Dead-letter queue for manual review
```

### Reprocessing from Source

```
When the source supports replay, request missing events:

  Kafka:  consumer.seek(partition, offset) — re-consume forward
  SQS:    message returns after visibility timeout — automatic retry
  Custom: GET /events?aggregate_id=X&after_version=2 — direct fetch

Key principle: replay is only safe if consumers are idempotent.
See 04-delivery-guarantees.md for idempotency patterns.
```

---

## Key Takeaways

1. **Total ordering is expensive** - Avoid unless truly needed
2. **Per-key ordering is usually enough** - Partition by entity ID
3. **Same key → same partition → same consumer** - Ordering chain
4. **Sequence numbers enable verification** - Detect gaps and duplicates
5. **Buffer out-of-order messages** - With timeout for gaps
6. **More partitions = more parallelism** - But per-partition ordering
7. **Scaling affects key mapping** - Over-partition initially
8. **Design for independent keys** - Maximize parallelism
