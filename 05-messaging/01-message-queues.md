# Message Queues

## TL;DR

Message queues decouple producers and consumers, enabling asynchronous communication, load leveling, and fault tolerance. Key concepts: producers, consumers, brokers, acknowledgments. Choose based on ordering needs, throughput, durability, and exactly-once requirements. Popular options: RabbitMQ, Amazon SQS, Apache Kafka (log-based).

---

## Why Message Queues?

### Synchronous Problems

```
Direct HTTP call:
  Service A ──HTTP──► Service B
  
Problems:
  - A waits for B (latency)
  - If B is down, A fails
  - Spikes in A overwhelm B
  - Tight coupling
```

### Queue Benefits

```
With message queue:
  Service A ──► [Queue] ──► Service B

Benefits:
  - A doesn't wait (async)
  - If B is down, messages wait in queue
  - Queue absorbs traffic spikes
  - A and B don't know about each other
```

---

## Core Concepts

### Components

```
┌──────────┐     ┌───────────┐     ┌──────────┐
│ Producer │────►│   Queue   │────►│ Consumer │
│          │     │  (Broker) │     │          │
└──────────┘     └───────────┘     └──────────┘

Producer: Creates and sends messages
Queue/Broker: Stores messages durably
Consumer: Receives and processes messages
```

### Message Lifecycle

```
1. Producer sends message
2. Broker acknowledges receipt (producer-side)
3. Broker stores message durably
4. Consumer fetches message
5. Consumer processes message
6. Consumer acknowledges (consumer-side)
7. Broker removes message
```

### Message Structure

```json
{
  "id": "msg-12345",
  "timestamp": "2024-01-15T10:30:00Z",
  "headers": {
    "content-type": "application/json",
    "correlation-id": "req-67890"
  },
  "body": {
    "user_id": 123,
    "action": "signup",
    "email": "user@example.com"
  }
}
```

---

## Queue Types

### Point-to-Point

```
One message, one consumer

Producer ──► [Queue] ──► Consumer A
                    └──► Consumer B  (different message)
                    
Each message delivered to exactly one consumer
Used for: Task distribution, work queues
```

### Publish-Subscribe

```
One message, many consumers

Producer ──► [Topic] ──┬──► Consumer A (copy)
                       ├──► Consumer B (copy)
                       └──► Consumer C (copy)
                       
Each message delivered to all subscribers
Used for: Event broadcasting, notifications
```

### Competing Consumers

```
Multiple consumers share work from one queue

             ┌──► Consumer 1
Producer ──► [Queue] ──┼──► Consumer 2
             └──► Consumer 3

Each message goes to one consumer
Consumers process in parallel
Used for: Load distribution, scaling
```

---

## Delivery Semantics

### At-Most-Once

```
Producer: Send message, don't wait for ack
Consumer: Process, don't ack

Possible outcomes:
  - Message delivered and processed ✓
  - Message lost (never delivered) ✗
  
Use case: Metrics, logs where loss is acceptable
```

### At-Least-Once

```
Producer: Send, retry until acked
Consumer: Process, then ack

Possible outcomes:
  - Message delivered once ✓
  - Message delivered multiple times (retry after timeout)
  
Consumer must be idempotent!
Use case: Most applications
```

### Exactly-Once

```
Very hard to achieve truly
Usually: At-least-once + idempotent consumer

Techniques:
  - Deduplication by message ID
  - Transactional outbox
  - Kafka transactions

Use case: Financial transactions
```

---

## Acknowledgments

### Producer Acknowledgments

```python
# Fire and forget (at-most-once)
producer.send(message)

# Wait for broker ack (at-least-once)
producer.send(message).get()  # Blocks until acked

# Wait for replication (stronger durability)
producer.send(message, acks='all').get()
```

### Consumer Acknowledgments

```python
# Auto-ack (dangerous - message may be lost)
message = queue.get(auto_ack=True)
process(message)  # If this fails, message lost

# Manual ack (safer)
message = queue.get(auto_ack=False)
try:
    process(message)
    queue.ack(message)
except Exception:
    queue.nack(message)  # Requeue or dead letter
```

### Ack Timeout

```
Consumer gets message at T=0
Timeout = 30 seconds

If no ack by T=30:
  Broker assumes consumer died
  Message redelivered to another consumer
  
Choose timeout > max processing time
```

---

## Queue Patterns

### Work Queue

```python
# Producer: Distribute tasks
for task in tasks:
    queue.send(task)

# Consumers: Process in parallel
while True:
    task = queue.get()
    result = process(task)
    queue.ack(task)
```

### Request-Reply

```
Request queue: client → service
Reply queue: service → client

Client:
  1. Create temp reply queue
  2. Send request with reply_to = temp queue
  3. Wait on temp queue

Service:
  1. Get request from request queue
  2. Process
  3. Send response to reply_to queue
```

### Priority Queue

```python
# High priority messages processed first
queue.send(critical_task, priority=10)
queue.send(normal_task, priority=5)
queue.send(low_task, priority=1)

# Consumer always gets highest priority first
```

---

## Popular Message Queues

### RabbitMQ

```
Protocol: AMQP
Model: Broker-centric, exchanges + queues

Features:
  - Flexible routing (direct, topic, fanout)
  - Message TTL
  - Dead letter exchanges
  - Plugins ecosystem

Best for: Complex routing, enterprise messaging
```

### Amazon SQS

```
Model: Managed queue service

Standard Queue:
  - At-least-once delivery
  - Best-effort ordering
  - Unlimited throughput

FIFO Queue:
  - Exactly-once processing
  - Strict ordering (within group)
  - 3,000 msg/sec limit

Best for: AWS-native, managed simplicity
```

### Apache Kafka

```
Model: Distributed log

Features:
  - Persistent storage (replay)
  - Partitioned for parallelism
  - Consumer groups
  - High throughput

Best for: Event streaming, large scale
```

### Redis Streams

```
Model: Append-only log in Redis

Features:
  - Consumer groups
  - Message IDs
  - Trimming by size/time
  - Fast (in-memory)

Best for: Simple streaming, already using Redis
```

---

## Sizing and Capacity

### Throughput Planning

```
Expected load:
  Peak messages: 10,000/sec
  Avg message size: 1 KB
  Retention: 7 days

Calculations:
  Throughput: 10,000 × 1 KB = 10 MB/sec
  Daily storage: 10 MB/sec × 86,400 = 864 GB/day
  Total storage: 864 × 7 = 6 TB
```

### Consumer Scaling

```
Processing time per message: 100ms
Required throughput: 1,000 msg/sec

Consumers needed:
  1000 msg/sec × 0.1 sec = 100 concurrent
  With 10 consumers: 10 parallel each
  
Add consumers until throughput met
```

---

## Monitoring

### Key Metrics

```
Queue depth:
  Number of messages waiting
  Growing = consumers too slow

Consumer lag:
  Time/messages behind producer
  Growing = falling behind

Message age:
  Oldest unprocessed message
  High = potential SLA breach

Throughput:
  Messages/second in and out
  Compare to capacity

Error rate:
  Failed processing / total
  Trigger alerts > threshold
```

### Alerting Rules

```yaml
alerts:
  - name: QueueDepthHigh
    condition: queue_depth > 10000
    for: 5m
    
  - name: ConsumerLagHigh
    condition: consumer_lag > 1h
    for: 10m
    
  - name: MessageAgeOld
    condition: oldest_message_age > 30m
    for: 5m
    
  - name: ProcessingErrors
    condition: error_rate > 1%
    for: 5m
```

---

## Error Handling

### Retry Strategies

```python
def process_with_retry(message, max_retries=3):
    for attempt in range(max_retries):
        try:
            process(message)
            return True
        except TransientError:
            delay = exponential_backoff(attempt)
            time.sleep(delay)
        except PermanentError:
            send_to_dead_letter(message)
            return False
    
    # Max retries exceeded
    send_to_dead_letter(message)
    return False
```

### Dead Letter Queue

```
Main Queue ──► Consumer ──► Success
                  │
                  └──► Failure (after retries)
                         │
                         ▼
                  Dead Letter Queue
                         │
                         ▼
               Manual review / alerting
```

---

## Best Practices

### Message Design

```
1. Include correlation ID for tracing
2. Add timestamp for debugging
3. Keep messages small (< 256 KB typically)
4. Use schema versioning
5. Include message type for routing
```

### Idempotent Consumers

```python
def process_message(message):
    # Check if already processed
    if is_processed(message.id):
        return  # Skip duplicate
    
    # Process
    result = do_work(message)
    
    # Mark as processed (atomically with work if possible)
    mark_processed(message.id)
```

### Graceful Shutdown

```python
def shutdown_handler(signal, frame):
    # Stop accepting new messages
    consumer.stop_consuming()
    
    # Wait for in-flight messages
    consumer.wait_for_current()
    
    # Cleanup
    consumer.close()
    sys.exit(0)

signal.signal(signal.SIGTERM, shutdown_handler)
```

---

## Queue Internals

### Storage Engines

```
RabbitMQ:
  - Erlang Mnesia database for metadata (exchanges, queues, bindings)
  - Messages stored in per-queue message stores on disk
  - Lazy queues: messages go straight to disk, reducing RAM usage
  - Classic queues: messages held in RAM, paged to disk under memory pressure
  - Quorum queues (recommended): Raft-based replicated log on disk

Kafka:
  - Append-only log segments stored as files on disk
  - Each partition = ordered sequence of segment files
  - Segment rolls over at configurable size (default 1 GB) or time
  - Index files map offset → position in segment for fast lookups
  - Zero-copy sendfile() for efficient consumer reads directly from page cache

SQS:
  - Distributed redundant storage across multiple AZs
  - Messages replicated to multiple hosts before send returns
  - No user-visible storage engine — fully managed black box
  - Standard queues: messages stored in hash-based shards
  - FIFO queues: messages partitioned by MessageGroupId

Redis Streams:
  - Radix tree of listpack-encoded entries in memory
  - AOF / RDB persistence to disk (same as any Redis data)
  - XTRIM caps stream length to bound memory usage
```

### Message Lifecycle Details

```
produced → stored → delivered → processing → acknowledged → deleted

Timing breakdown (typical at-least-once):
  1. Producer serializes message                      ~1 ms
  2. Network round-trip to broker                     ~1-5 ms
  3. Broker persists to disk / replicates             ~1-10 ms
  4. Broker returns producer ack                      ~0 ms (included in 3)
  5. Consumer polls or receives push                  ~1-50 ms (depends on polling interval)
  6. Consumer processes business logic                 ~10-1000 ms (application-dependent)
  7. Consumer sends ack to broker                     ~1-5 ms
  8. Broker marks message consumed / deletes          ~1 ms
```

### Visibility Timeout (SQS)

```
Consumer A receives message at T=0
  → Message becomes INVISIBLE to other consumers
  → Visibility timeout = 30s (default)

If Consumer A acks (DeleteMessage) before T=30:
  → Message permanently removed ✓

If Consumer A crashes or takes too long:
  → At T=30, message becomes VISIBLE again
  → Consumer B can now receive it
  → Result: message processed twice — consumer must be idempotent

Tuning:
  - Too short: messages reappear while still being processed → duplicates
  - Too long: failed messages take forever to retry
  - Use ChangeMessageVisibility to extend mid-processing for long tasks
```

### Prefetch and QoS (RabbitMQ)

```python
# basic_qos controls how many unacked messages a consumer can hold in buffer
channel.basic_qos(prefetch_count=10)

# prefetch_count too HIGH (e.g., 1000):
#   - Consumer buffers 1000 messages in memory → OOM risk
#   - Other consumers starved (all messages sitting in one consumer's buffer)
#   - If consumer crashes, 1000 messages need redelivery

# prefetch_count too LOW (e.g., 1):
#   - Consumer processes one, round-trips for next → network-bound
#   - Throughput tanks due to idle time between messages

# Rule of thumb:
#   prefetch = consumer_throughput × network_round_trip_time
#   Example: 100 msg/sec × 0.05 sec RTT = 5
#   Start with 10-20, benchmark, adjust
```

---

## Queue Selection Guide

### Decision Table

```
┌──────────────────┬──────────┬────────────┬──────────┬───────────────┐
│ Criteria         │ Kafka    │ RabbitMQ   │ SQS      │ Redis Streams │
├──────────────────┼──────────┼────────────┼──────────┼───────────────┤
│ Ordering         │ Per-     │ Per-queue  │ FIFO:    │ Per-stream    │
│                  │ partition│ (FIFO)     │ per-group│ (global)      │
├──────────────────┼──────────┼────────────┼──────────┼───────────────┤
│ Delivery         │ At-least │ At-least   │ At-least │ At-least once │
│ guarantee        │ -once*   │ -once      │ -once    │               │
├──────────────────┼──────────┼────────────┼──────────┼───────────────┤
│ Throughput       │ Millions │ ~50K       │ Unlimited│ ~100K msg/s   │
│ (msg/sec)        │ msg/s    │ msg/s      │ (std)    │ (single node) │
├──────────────────┼──────────┼────────────┼──────────┼───────────────┤
│ Replay /         │ Yes      │ No         │ No       │ Yes (while    │
│ rewind           │ (native) │            │          │ retained)     │
├──────────────────┼──────────┼────────────┼──────────┼───────────────┤
│ Operational      │ High     │ Medium     │ None     │ Low (if Redis │
│ complexity       │          │            │ (managed)│ already runs) │
├──────────────────┼──────────┼────────────┼──────────┼───────────────┤
│ Cost model       │ Infra /  │ Infra /    │ Per-     │ Infra /       │
│                  │ managed  │ managed    │ request  │ managed       │
├──────────────────┼──────────┼────────────┼──────────┼───────────────┤
│ Message TTL      │ By       │ Per-msg /  │ Max 14   │ XTRIM or      │
│                  │ retention│ per-queue  │ days     │ MAXLEN        │
└──────────────────┴──────────┴────────────┴──────────┴───────────────┘

* Kafka supports exactly-once with idempotent producer + transactions
```

### When to Choose What

```
Choose Kafka when:
  - Throughput exceeds 100K msg/sec
  - Consumers need to replay historical events
  - Event streaming / event sourcing architecture
  - Multiple independent consumer groups read same data

Choose RabbitMQ when:
  - Complex routing logic (topic, headers, fanout exchanges)
  - Priority queues needed
  - Low per-message latency matters (sub-ms possible)
  - Request-reply messaging pattern is core

Choose SQS when:
  - Running on AWS and want zero operational burden
  - Serverless architecture (Lambda triggers from SQS)
  - Simple point-to-point work queues
  - Budget is per-request (pay only for what you use)

Choose Redis Streams when:
  - Redis is already in the stack (no new infra)
  - Use case is simple with moderate throughput
  - Want consumer groups without Kafka's complexity
  - Acceptable to lose data if Redis restarts without persistence
```

---

## Backpressure and Flow Control

### The Core Problem

```
Producer rate: 10,000 msg/sec
Consumer rate:  2,000 msg/sec
Queue growth:   8,000 msg/sec accumulating

Unbounded queue:
  After 1 hour: 28.8 million messages queued
  At 1 KB each: 28.8 GB memory/disk consumed
  Eventually: OOM crash, disk full, cascading failure

Bounded queue:
  Queue hits max size → producer must choose:
    a) Block (wait for space)        — adds backpressure upstream
    b) Drop new messages             — data loss, acceptable in some cases
    c) Drop oldest messages          — ring-buffer style, latest wins
```

### Backpressure by Queue Technology

```
RabbitMQ flow control:
  - Memory alarm triggers at configurable threshold (default 40% of RAM)
  - When triggered: all publishing connections BLOCKED
  - Disk alarm: triggers when free disk < limit (default 50 MB)
  - Connection-level credit flow: channels throttle producers automatically
  - Visible in management UI as "blocking" / "blocked" connection state

Kafka (no backpressure by design):
  - Log-based: producer always appends, never blocked by consumer speed
  - Consumer lag grows silently — partition log retains messages
  - Broker disk fills up if retention + lag exceeds capacity
  - Producer can be throttled via broker quotas (bytes/sec per client)
  - max.block.ms: producer blocks if broker buffer is full (network-level only)

SQS (no backpressure):
  - Messages accumulate without limit (standard queues)
  - No feedback mechanism to slow producers
  - Messages expire after retention period (default 4 days, max 14)
  - Cost grows linearly with accumulated messages

Redis Streams:
  - MAXLEN / MINID caps stream size, oldest entries evicted
  - No built-in producer blocking — application must implement
  - Memory pressure handled by Redis maxmemory-policy (eviction)
```

### Monitoring Consumer Lag

```
Consumer lag = latest produced offset − last consumed offset

Health thresholds (adjust per use case):
  ┌───────────┬───────────────┬──────────────┬──────────────┐
  │ Severity  │ Kafka lag     │ RabbitMQ     │ SQS          │
  │           │ (offsets)     │ (queue depth)│ (approx msg) │
  ├───────────┼───────────────┼──────────────┼──────────────┤
  │ Healthy   │ < 1,000       │ < 1,000      │ < 1,000      │
  │ Warning   │ 1K - 100K     │ 1K - 10K     │ 1K - 50K     │
  │ Critical  │ > 100K        │ > 10K        │ > 50K        │
  └───────────┴───────────────┴──────────────┴──────────────┘

If lag is growing steadily:
  1. Scale consumers horizontally (add instances)
  2. Optimize processing time per message
  3. Increase prefetch / batch size
  4. If none work: throttle producers or shed load
```

---

## Production Operations

### Queue Depth and Message Age Monitoring

```
Queue depth (messages waiting to be consumed):
  - Stable depth: consumers keeping up — healthy
  - Sustained growth: consumers falling behind — ACTION NEEDED
  - Sawtooth pattern: batch producers + consumers — usually fine

Oldest message age:
  - Measures worst-case processing delay
  - If age > SLA target: you are already breaching commitments
  - Kafka: consumer_lag_offsets × avg_time_between_messages
  - SQS: ApproximateAgeOfOldestMessage CloudWatch metric
  - RabbitMQ: head_message_timestamp via management API
```

### Consumer Group Management

```bash
# Kafka: check consumer group lag
kafka-consumer-groups.sh --bootstrap-server localhost:9092 \
  --describe --group my-consumer-group

# Kafka: reset offsets (careful — reprocesses messages)
kafka-consumer-groups.sh --bootstrap-server localhost:9092 \
  --group my-consumer-group --topic my-topic \
  --reset-offsets --to-earliest --execute

# RabbitMQ management UI (default port 15672):
#   Connections tab: client IPs, state, channels per connection
#   Channels tab: prefetch, unacked count, message rates
#   Queues tab: depth, incoming/deliver rates, consumer count

# SQS: check queue attributes
aws sqs get-queue-attributes --queue-url <url> \
  --attribute-names ApproximateNumberOfMessages \
                    ApproximateNumberOfMessagesNotVisible \
                    ApproximateAgeOfOldestMessage
```

### Capacity Planning

```
Formula:
  storage_needed = message_rate × avg_message_size × retention_period

Example:
  5,000 msg/sec × 2 KB × 7 days
  = 5,000 × 2,048 × 604,800
  = 6.2 TB (before replication)

  With replication factor 3: 18.6 TB

Budget for:
  - Peak rate (not average) for headroom
  - Replication overhead
  - Index / metadata overhead (~10-15% for Kafka)
  - Growth margin (plan for 2x current volume)
```

---

## Key Takeaways

1. **Queues decouple systems** - Async, resilient, scalable
2. **At-least-once is common** - Requires idempotent consumers
3. **Ack after processing** - Not before
4. **Monitor queue depth** - Early warning of problems
5. **Use dead letter queues** - Handle permanent failures
6. **Size for peak load** - Queues absorb spikes
7. **Plan message schema** - Include ID, timestamp, type
8. **Graceful shutdown** - Don't lose in-flight messages
