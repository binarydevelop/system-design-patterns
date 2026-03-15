# Delivery Guarantees

## TL;DR

Delivery guarantees define how many times a message will be delivered: at-most-once (may lose), at-least-once (may duplicate), exactly-once (ideal but hard). True exactly-once is extremely difficult; most systems achieve it through at-least-once + idempotent consumers. Understand the guarantees of your messaging system and design consumers accordingly.

---

## The Three Guarantees

### At-Most-Once

```
Message delivered 0 or 1 time

Send ──► Broker ──► Consumer
           │
     (no retry on failure)

Possible outcomes:
  ✓ Delivered once
  ✗ Never delivered (lost)

Never duplicated
May be lost
```

### At-Least-Once

```
Message delivered 1 or more times

Send ──► Broker ──► Consumer
           │           │
     (retry if no ack) │
           │◄────(ack)─┘

Possible outcomes:
  ✓ Delivered once
  ✓ Delivered multiple times (retries)

Never lost (if producer retries)
May be duplicated
```

### Exactly-Once

```
Message delivered exactly 1 time

Requires:
  - Deduplication at broker or consumer
  - Transactional processing
  - Or: At-least-once + idempotency

Ideal but extremely difficult
Often simulated rather than true
```

---

## Failure Scenarios

### Producer Failures

```
Scenario 1: Message lost before broker
  Producer ──X──► Broker
  
  At-most-once: Lost
  At-least-once: Lost (unless producer retries)

Scenario 2: Ack lost
  Producer ──► Broker ──X──► Producer
  
  At-most-once: Producer thinks it failed, doesn't retry
  At-least-once: Producer retries, duplicate at broker
```

### Broker Failures

```
Scenario: Broker crashes after receive, before persist

  Producer ──► Broker (memory) ──X── (disk)
  
  At-most-once: Message lost
  At-least-once: Producer retries (if no ack received)

Solution: Sync to disk before ack, or replicate first
```

### Consumer Failures

```
Scenario: Consumer crashes after processing, before ack

  Broker ──► Consumer (processed) ──X── (ack)
  
  At-most-once: N/A (no ack expected)
  At-least-once: Broker redelivers, processed twice
```

---

## Implementing At-Most-Once

### Fire and Forget

```python
# Producer: Don't wait for ack
producer.send(message)
# Continue immediately, don't care if it arrived

# Consumer: Auto-ack before processing
def consume():
    message = queue.get(auto_ack=True)  # Ack immediately
    process(message)  # If this fails, message lost
```

### Use Cases

```
✓ Metrics and telemetry (loss OK)
✓ Logging (best effort)
✓ Real-time displays (stale data acceptable)
✗ Financial transactions
✗ State changes
✗ Anything requiring reliability
```

---

## Implementing At-Least-Once

### Producer Retries

```python
def send_with_retry(message, max_retries=3):
    for attempt in range(max_retries):
        try:
            # Wait for broker acknowledgment
            ack = producer.send(message, timeout=5000)
            if ack.success:
                return True
        except TimeoutError:
            if attempt < max_retries - 1:
                sleep(exponential_backoff(attempt))
    
    raise MessageDeliveryError("Failed after retries")
```

### Consumer Ack After Processing

```python
def consume():
    while True:
        message = queue.get(auto_ack=False)
        
        try:
            process(message)
            queue.ack(message)  # Only ack after success
        except Exception as e:
            queue.nack(message)  # Requeue for retry
            log.error(f"Processing failed: {e}")
```

### Handling Duplicates

```python
# Consumer must be idempotent
def process(message):
    message_id = message.id
    
    # Check if already processed
    if redis.sismember('processed_messages', message_id):
        log.info(f"Duplicate message {message_id}, skipping")
        return
    
    # Process
    do_work(message)
    
    # Mark as processed
    redis.sadd('processed_messages', message_id)
    redis.expire('processed_messages', 86400)  # 24h TTL
```

---

## Implementing Exactly-Once

### Approach 1: Deduplication

```python
class DeduplicatingConsumer:
    def __init__(self):
        self.seen = set()  # Or external store
    
    def process(self, message):
        if message.id in self.seen:
            return  # Skip duplicate
        
        do_work(message)
        self.seen.add(message.id)

# Limitation: Seen set must persist, has memory limits
```

### Approach 2: Idempotent Operations

```python
# Instead of: counter += 1
# Use: counter = specific_value

# Instead of: INSERT
# Use: UPSERT

def process_payment(payment):
    # Idempotent: Same payment_id always results in same state
    db.execute("""
        INSERT INTO payments (id, amount, status)
        VALUES (%s, %s, 'completed')
        ON CONFLICT (id) DO NOTHING
    """, payment.id, payment.amount)
```

### Approach 3: Transactional Outbox

```python
def process(message):
    with db.transaction():
        # Check if processed
        if is_processed(message.id):
            return
        
        # Do work
        update_state(message)
        
        # Mark processed (same transaction)
        mark_processed(message.id)
    
    # Only ack after transaction commits
    queue.ack(message)
```

### Approach 4: Kafka Transactions

```python
producer.init_transactions()

try:
    producer.begin_transaction()
    
    # Consume
    records = consumer.poll()
    
    # Process and produce
    for record in records:
        result = process(record)
        producer.send(output_topic, result)
    
    # Commit offsets and produced messages atomically
    producer.send_offsets_to_transaction(
        consumer.position(), 
        consumer_group
    )
    producer.commit_transaction()
    
except Exception:
    producer.abort_transaction()
```

---

## Kafka Delivery Semantics

### Producer Settings

```python
# At-most-once
producer = KafkaProducer(
    acks=0  # Don't wait for ack
)

# At-least-once
producer = KafkaProducer(
    acks='all',  # Wait for all replicas
    retries=3,
    retry_backoff_ms=100
)

# Exactly-once (idempotent producer)
producer = KafkaProducer(
    acks='all',
    enable_idempotence=True,  # Broker deduplicates
    transactional_id='my-producer'  # For transactions
)
```

### Consumer Settings

```python
# At-most-once
consumer = KafkaConsumer(
    enable_auto_commit=True,
    auto_commit_interval_ms=100  # Commit often
)

# At-least-once
consumer = KafkaConsumer(
    enable_auto_commit=False  # Manual commit after processing
)

# Exactly-once (with transactions)
consumer = KafkaConsumer(
    isolation_level='read_committed'  # Only see committed
)
```

---

## RabbitMQ Delivery Semantics

### Publisher Confirms

```python
# At-least-once with publisher confirms
channel.confirm_delivery()

try:
    channel.basic_publish(
        exchange='',
        routing_key='queue',
        body=message,
        properties=pika.BasicProperties(delivery_mode=2)  # Persistent
    )
except pika.exceptions.UnroutableError:
    # Message was not delivered
    handle_failure()
```

### Consumer Acknowledgments

```python
# At-least-once
def callback(ch, method, properties, body):
    try:
        process(body)
        ch.basic_ack(delivery_tag=method.delivery_tag)
    except Exception:
        ch.basic_nack(delivery_tag=method.delivery_tag, requeue=True)

channel.basic_consume(queue='queue', on_message_callback=callback)
```

---

## SQS Delivery Semantics

### Standard Queue

```
At-least-once delivery
Best-effort ordering

Messages may be delivered more than once
Order not guaranteed
High throughput
```

### FIFO Queue

```
Exactly-once processing
Strict ordering (within message group)

Deduplication by:
  - MessageDeduplicationId (5-minute window)
  - Content-based (hash of body)

Lower throughput (300-3000 msg/sec)
```

### Visibility Timeout

```python
# Message invisible while processing
sqs.receive_message(
    QueueUrl=queue_url,
    VisibilityTimeout=30  # seconds
)

# If not deleted within 30s, becomes visible again
# Another consumer might process it (duplicate)

# After processing:
sqs.delete_message(
    QueueUrl=queue_url,
    ReceiptHandle=receipt_handle
)
```

---

## Testing Delivery Guarantees

### Chaos Testing

```python
def test_at_least_once():
    # Send message
    message_id = producer.send(message)
    
    # Kill consumer mid-processing
    consumer.start()
    wait_for_processing_start()
    consumer.kill()
    
    # Restart consumer
    consumer.start()
    
    # Verify message processed (possibly twice)
    assert is_processed(message_id)

def test_no_message_loss():
    # Send many messages
    sent_ids = [producer.send(m) for m in messages]
    
    # Process all
    process_until_empty()
    
    # Verify all processed
    for id in sent_ids:
        assert is_processed(id)
```

### Duplicate Detection Testing

```python
def test_duplicate_handling():
    message = create_message()
    
    # Send same message twice
    producer.send(message)
    producer.send(message)
    
    # Process
    process_all()
    
    # Verify processed only once
    assert get_process_count(message.id) == 1
```

---

## Choosing a Guarantee

### Decision Matrix

| Requirement | Guarantee |
|-------------|-----------|
| Maximum throughput, loss OK | At-most-once |
| No message loss | At-least-once |
| No duplicates | Exactly-once or idempotent |
| Financial transactions | Exactly-once preferred |
| Event logging | At-least-once |
| Metrics | At-most-once OK |

### Cost Comparison

| Guarantee | Latency | Throughput | Complexity |
|-----------|---------|------------|------------|
| At-most-once | Lowest | Highest | Lowest |
| At-least-once | Medium | Medium | Medium |
| Exactly-once | Highest | Lowest | Highest |

---

## Kafka Idempotent Producer Internals

```
How the broker deduplicates without application-level logic:

1. PID Assignment
   Producer.init() ──► Broker allocates PID (Producer ID)

2. Sequence Tagging
   Every ProducerRecord carries (PID, partition, sequence_number)
   Sequence increments per-partition, starting at 0

3. Broker-Side Dedup
   Broker maintains: Map<(PID, partition), last_committed_sequence>

   Incoming message sequence ≤ last_committed → DUPLICATE, reject
   Incoming message sequence  = last_committed + 1 → ACCEPT
   Incoming message sequence  > last_committed + 1 → OUT_OF_ORDER, error
```

**Session scope limitation**: PID is ephemeral — assigned on `Producer.init()`. If the producer process restarts, it gets a new PID. The broker cannot correlate the new PID with the old one, so deduplication only works within a single producer session.

**Surviving restarts with `transactional.id`**: When you set `transactional.id`, the transaction coordinator persists the mapping `transactional.id → (PID, epoch)`. On restart, the producer calls `initTransactions()`, the coordinator looks up the existing PID (or allocates a new one and increments the epoch), and fences any old producer instance still running with the same `transactional.id`.

```
# Config (default since Kafka 3.0)
enable.idempotence=true    # Implies acks=all, retries=MAX_INT, max.in.flight.requests.per.connection ≤ 5

# What it costs you: ~2-3% throughput reduction (extra sequence bookkeeping)
# What it gives you: no duplicates from producer retries within one session
```

**Key subtlety**: Idempotence alone does NOT give you exactly-once across consume-transform-produce pipelines. It only deduplicates writes from a single producer to the broker. For end-to-end EOS, you need Kafka transactions.

---

## Kafka EOS Transaction Protocol

```
Transaction lifecycle — what actually happens on the wire:

1. initTransactions()
   Producer ──► TransactionCoordinator
   Coordinator bumps epoch for this transactional.id
   Old producer with same transactional.id is now fenced (zombie fencing)

2. beginTransaction()
   Local state change only, nothing sent to broker

3. send() / AddPartitionsToTxn
   First send to a new partition in this txn triggers:
   Producer ──► Coordinator: AddPartitionsToTxn(txnId, epoch, [topic-partition])
   Coordinator persists partition list to __transaction_state

4. Data writes
   Producer ──► Partition leaders: normal produce requests tagged with PID+epoch
   Leaders buffer messages but mark them as "uncommitted"

5. sendOffsetsToTransaction()
   Producer ──► Coordinator: AddOffsetsToTxn(txnId, consumerGroupId)
   Producer ──► GroupCoordinator: TxnOffsetCommit(offsets)

6. commitTransaction()
   Producer ──► Coordinator: EndTxn(COMMIT)
   Coordinator writes PREPARE_COMMIT to __transaction_state
   Coordinator writes COMMIT markers to ALL involved partitions
   Coordinator writes COMPLETE_COMMIT to __transaction_state
```

**What consumers see**: With `isolation.level=read_committed`, the consumer's fetch request returns a `LastStableOffset` (LSO). Messages beyond LSO that belong to open transactions are buffered but not delivered to the application until their transaction resolves. This means read_committed consumers may see higher end-to-end latency.

**`__transaction_state` topic**: Internal compacted topic (default 50 partitions). Each `transactional.id` hashes to one partition. Stores `(transactional.id, PID, epoch, state, involved_partitions, timeout)`. Compaction keeps only the latest state per key.

**Failure recovery**: If a producer crashes mid-transaction, the coordinator's transaction timeout (default 60s) expires and it auto-aborts. When a new producer initializes with the same `transactional.id`, the coordinator increments the epoch — any lingering writes from the old epoch are rejected by partition leaders.

---

## Idempotent Consumer Patterns

Four strategies for making consumers tolerate duplicate delivery, from cheapest to most complex:

| Strategy | Mechanism | Cost | Best For |
|----------|-----------|------|----------|
| Natural idempotency | Operation is inherently safe to repeat | Free | Any case where possible |
| Database constraint | Unique index rejects duplicate inserts | Low | DB-backed consumers |
| Distributed dedup store | Check external store before processing | Medium | Stateless consumers |
| Versioned state | Reject if state already at higher version | Medium | Event-sourced systems |

### Natural Idempotency

```python
# SET is idempotent; INCREMENT is not
# Instead of: UPDATE accounts SET balance = balance + 100
# Use:        UPDATE accounts SET balance = 1500 WHERE id = ? AND version = ?

# DELETE WHERE is idempotent
db.execute("DELETE FROM cart_items WHERE cart_id = ? AND product_id = ?", cart_id, product_id)
```

Rule of thumb: if the operation converges to the same state regardless of how many times it runs, it is naturally idempotent. Prefer this over all other strategies.

### Database Constraint

```python
def process(message):
    try:
        db.execute(
            "INSERT INTO processed_events (event_id, result, created_at) VALUES (%s, %s, NOW())",
            message.id, compute_result(message)
        )
    except UniqueViolation:
        log.info(f"Duplicate {message.id}, skipping")
        return  # Safe to ack
```

Works when business logic and dedup record share the same database — wrap both in one transaction for atomicity.

### Distributed Dedup Store

```python
def process(message):
    # SETNX returns False if key already exists
    if not redis.set(f"dedup:{message.id}", "1", nx=True, ex=86400):
        log.info(f"Duplicate {message.id}, skipping")
        return

    do_work(message)
    # If do_work() fails, key is already set → message won't be reprocessed
    # Mitigation: set key AFTER do_work, accept small duplicate window
```

Trade-off: setting the key before processing prevents duplicates but risks message loss on crash. Setting it after processing risks duplicates on crash. Choose based on which failure mode your system tolerates.

### Versioned State

```python
def process(event):
    current = db.execute("SELECT version FROM entities WHERE id = %s", event.entity_id)
    if current.version >= event.version:
        log.info(f"Stale event v{event.version}, current v{current.version}")
        return  # Already at this version or newer

    db.execute(
        "UPDATE entities SET data = %s, version = %s WHERE id = %s AND version < %s",
        event.data, event.version, event.entity_id, event.version
    )
```

The `WHERE version < ?` clause makes the UPDATE itself idempotent — re-applying the same event version is a no-op.

---

## Deduplication Storage Sizing

When using an external dedup store, storage grows with message rate. Size it wrong and you either run out of memory or evict IDs too early (causing false "new message" on redelivery).

### Retention Window

Keep message IDs for **2x the maximum redelivery window**. If your system can redeliver messages up to 4 hours after initial delivery, retain IDs for 8 hours. This accounts for consumer lag, retry storms, and clock skew.

### Storage Formula

```
memory = message_rate × retention_window × id_size × overhead_factor

Example:
  10,000 msg/s × 604,800 s (7 days) × 36 bytes (UUID) × 1.5 (hash table overhead)
  = 10,000 × 604,800 × 36 × 1.5
  ≈ 327 GB

  That's too much for in-memory. Reduce retention or use probabilistic structures.
```

### Alternatives

**Bloom filter**: 10M entries at 1% false-positive rate ≈ 12 MB. Extremely memory-efficient, but false positives mean *dropped messages* (the filter says "seen" when it hasn't been). Acceptable only if occasional message loss is tolerable — which defeats the purpose of at-least-once.

**Redis sorted set with TTL-based cleanup**:
```
ZADD dedup <unix_timestamp> <message_id>     # O(log N) insert
ZSCORE dedup <message_id>                     # O(1) existence check
ZRANGEBYSCORE dedup -inf <cutoff_ts>          # Periodic cleanup of expired IDs
ZREMRANGEBYSCORE dedup -inf <cutoff_ts>       # Remove expired entries
```

This gives you exact dedup with automatic expiry. At 10K msg/s with 1-hour retention, expect ~36M entries × ~80 bytes each ≈ 2.9 GB in Redis. Manageable.

---

## Performance Overhead

Kafka delivery guarantee modes have measurable throughput and latency costs. The following ratios are illustrative — actual numbers vary by batch size, partition count, replication factor, and hardware.

| Mode | Throughput (relative) | Latency P99 | Key Config |
|------|----------------------|-------------|------------|
| At-most-once | 1.0× baseline | ~2 ms | `acks=0` |
| At-least-once | ~0.85× | ~10 ms | `acks=all`, `retries=Integer.MAX_VALUE` |
| Idempotent | ~0.82× | ~12 ms | `enable.idempotence=true` |
| Transactional | ~0.65–0.75× | ~25–50 ms | `transactional.id` set, `isolation.level=read_committed` |

**Why transactional mode is slower**:
- Each transaction requires at least 2 extra RPCs to the coordinator (`AddPartitionsToTxn`, `EndTxn`)
- Commit markers must be written to every partition involved in the transaction
- `read_committed` consumers must wait for the LSO to advance, adding tail latency
- Smaller batches amplify this overhead — batch aggressively when using transactions

**Tuning levers**:
- `linger.ms` and `batch.size`: larger batches amortize per-message overhead
- `transaction.timeout.ms`: shorter timeout = faster zombie detection, but risks aborting slow legitimate producers
- Partition count: more partitions = more commit markers per transaction, but more parallelism

**Rule of thumb**: if you need >100K msg/s per producer and P99 < 10ms, idempotent mode is the practical ceiling. Transactional mode is viable at ~50–80K msg/s with P99 ~30ms.

---

## Real Failure Scenarios

Theory breaks down at failure boundaries. These three scenarios come up repeatedly in production.

### Scenario 1: Dedup Store Down

```
Consumer receives message M1
Consumer tries Redis SETNX to check duplicate → Redis timeout / connection refused
Now what?

Option A — Fail-open (process anyway):
  Risk: duplicate processing if M1 was already seen
  Benefit: no data loss

Option B — Fail-closed (reject / nack):
  Risk: message goes back to queue, may expire or hit DLQ
  Benefit: no duplicate processing
```

**Most systems choose fail-open.** Reason: duplicates are usually cheaper to handle downstream (idempotent DB writes, reconciliation jobs) than lost messages. If your dedup store has an SLA below your message broker's, consider a local in-process fallback cache.

### Scenario 2: Consumer Crash After Offset Commit

```
Timeline:
  t1: Consumer polls batch of 100 messages
  t2: Consumer commits offsets (async or in read_committed)
  t3: Consumer begins business logic for message 51
  t4: Consumer process crashes (OOM, segfault, kill -9)

Result: messages 51–100 had their offsets committed but business logic never completed.
These messages are permanently skipped — the new consumer instance starts at offset 101.
```

**Fix**: Never commit offsets until business logic succeeds. Use manual commit (`enable.auto.commit=false`) and commit *after* processing each batch. For Kafka transactions, use `sendOffsetsToTransaction()` so offset commit is atomic with the produce — if the transaction aborts, offsets roll back too.

### Scenario 3: Broker Restart Mid-Batch

```
Producer sends batch of 50 messages to partition leader
Broker acks messages 1–30, then crashes before acking 31–50

Without idempotence:
  Producer retries all 50 (it doesn't know which were persisted)
  Messages 1–30 are duplicated on the broker
  Consumers see 80 messages instead of 50

With idempotence:
  Producer retries all 50 with same (PID, partition, sequence) tuples
  Broker's sequence tracker rejects messages 1–30 (sequence ≤ last committed)
  Broker accepts messages 31–50
  Consumers see exactly 50 messages
```

This is the single strongest argument for enabling idempotent producers — it costs almost nothing (~3% throughput) and eliminates the most common source of duplicates in Kafka.

Cross-reference: for atomically writing to both a database and a message queue (avoiding the dual-write problem that causes many of these scenarios), see `07-outbox-pattern.md`.

---

## Key Takeaways

1. **At-most-once is fastest** - But may lose messages
2. **At-least-once is most common** - Requires idempotent consumers
3. **Exactly-once is hard** - Usually simulated via deduplication
4. **Ack after processing** - Not before
5. **Idempotency is your friend** - Makes duplicates harmless
6. **Test failure scenarios** - Crash consumers, drop acks
7. **Know your system's guarantees** - Kafka vs SQS vs RabbitMQ differ
8. **Design for duplicates** - They will happen
