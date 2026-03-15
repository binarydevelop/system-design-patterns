# Outbox Pattern

## TL;DR

The outbox pattern ensures reliable message publishing by writing messages to a database table (outbox) in the same transaction as business data. A separate process reads from the outbox and publishes to the message broker. This guarantees atomicity between database writes and message publishing, solving the dual-write problem.

---

## The Dual-Write Problem

### Naive Approach

```python
def create_order(order):
    # Step 1: Save to database
    db.save(order)
    
    # Step 2: Publish event
    message_queue.publish(OrderCreated(order))
```

### Failure Scenarios

```
Scenario 1: DB succeeds, publish fails
  db.save(order)     ✓ (committed)
  mq.publish(event)  ✗ (failed)
  
  Result: Order exists, but no event
  Downstream systems never know

Scenario 2: Publish succeeds, DB fails
  db.save(order)     (pending)
  mq.publish(event)  ✓ (published)
  db.commit()        ✗ (rolled back)
  
  Result: Event exists, but no order
  Downstream systems process phantom order
```

### Why Distributed Transactions Don't Help

```
XA/2PC:
  - Not supported by most message brokers
  - Slow (blocks on coordinator)
  - Complex failure handling
  
Need simpler, more reliable approach
```

---

## The Outbox Solution

### Architecture

```
┌─────────────────────────────────────────────────────────┐
│                      Database                           │
│  ┌─────────────┐    ┌─────────────────────────────┐    │
│  │   Orders    │    │         Outbox              │    │
│  │  ┌───────┐  │    │  ┌─────────────────────┐    │    │
│  │  │ Order │  │◄───┼──│ id, payload, status │    │    │
│  │  └───────┘  │    │  └─────────────────────┘    │    │
│  └─────────────┘    └─────────────────────────────┘    │
└─────────────────────────────────────────────────────────┘
         ▲                      │
         │                      │ Poll
         │                      ▼
┌────────┴──────┐    ┌─────────────────────┐    ┌────────┐
│  Application  │    │ Outbox Publisher    │───►│ Broker │
└───────────────┘    └─────────────────────┘    └────────┘
```

### How It Works

```
1. Application writes business data AND outbox record
   in SAME transaction

2. Transaction commits atomically
   Both order and outbox record exist, or neither

3. Background process polls outbox
   Reads unpublished messages

4. Publisher sends to message broker
   Message delivered to queue/topic

5. Publisher marks outbox record as published
   Prevents duplicate publishing
```

---

## Implementation

### Outbox Table Schema

```sql
CREATE TABLE outbox (
    id UUID PRIMARY KEY,
    aggregate_type VARCHAR(255) NOT NULL,
    aggregate_id VARCHAR(255) NOT NULL,
    event_type VARCHAR(255) NOT NULL,
    payload JSONB NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    published_at TIMESTAMP NULL,
    
    INDEX idx_outbox_unpublished (published_at) WHERE published_at IS NULL
);
```

### Writing to Outbox

```python
def create_order(order_data):
    with db.transaction():
        # Create order
        order = Order(**order_data)
        db.add(order)
        
        # Write to outbox (same transaction)
        outbox_entry = OutboxEntry(
            id=uuid4(),
            aggregate_type="Order",
            aggregate_id=str(order.id),
            event_type="OrderCreated",
            payload=json.dumps({
                "order_id": str(order.id),
                "customer_id": order.customer_id,
                "total": order.total
            })
        )
        db.add(outbox_entry)
    
    # Transaction commits atomically
    return order
```

### Outbox Publisher (Polling)

```python
class OutboxPublisher:
    def __init__(self, db, broker):
        self.db = db
        self.broker = broker
    
    def run(self):
        while True:
            self.publish_pending()
            sleep(100)  # Poll interval
    
    def publish_pending(self):
        # Get unpublished messages
        entries = self.db.query("""
            SELECT * FROM outbox 
            WHERE published_at IS NULL 
            ORDER BY created_at 
            LIMIT 100
            FOR UPDATE SKIP LOCKED
        """)
        
        for entry in entries:
            try:
                # Publish to broker
                self.broker.publish(
                    topic=f"{entry.aggregate_type}.{entry.event_type}",
                    message=entry.payload,
                    headers={"event_id": str(entry.id)}
                )
                
                # Mark as published
                self.db.execute("""
                    UPDATE outbox 
                    SET published_at = NOW() 
                    WHERE id = %s
                """, entry.id)
                
            except BrokerError:
                # Will retry on next poll
                log.error(f"Failed to publish {entry.id}")
```

---

## CDC-Based Outbox

### Using Change Data Capture

```
Instead of polling, use database log

Database ──► CDC (Debezium) ──► Kafka

Outbox table changes captured from binlog/WAL
Lower latency than polling
No separate publisher process
```

### Debezium Configuration

```json
{
  "connector.class": "io.debezium.connector.postgresql.PostgresConnector",
  "database.hostname": "db.example.com",
  "database.dbname": "myapp",
  "table.include.list": "public.outbox",
  "transforms": "outbox",
  "transforms.outbox.type": "io.debezium.transforms.outbox.EventRouter",
  "transforms.outbox.table.field.event.type": "event_type",
  "transforms.outbox.table.field.event.payload": "payload"
}
```

### CDC Benefits

```
+ Lower latency (near real-time)
+ No polling load on database
+ Guaranteed ordering (from log)
+ No missed messages

- More infrastructure (Debezium, Kafka Connect)
- CDC setup complexity
- Database must support log access
```

---

## Handling Duplicates

### Why Duplicates Happen

```
Scenario:
  1. Publisher reads message from outbox
  2. Publisher sends to broker ✓
  3. Publisher crashes before marking published
  4. New publisher instance starts
  5. Same message published again

Consumer receives duplicate message
```

### Idempotent Consumers

```python
class OrderEventConsumer:
    def handle(self, event):
        event_id = event.headers["event_id"]
        
        # Check if already processed
        if self.is_processed(event_id):
            log.info(f"Duplicate event {event_id}, skipping")
            return
        
        # Process event
        self.process(event)
        
        # Mark as processed
        self.mark_processed(event_id)
    
    def is_processed(self, event_id):
        return redis.sismember("processed_events", event_id)
    
    def mark_processed(self, event_id):
        redis.sadd("processed_events", event_id)
        redis.expire("processed_events", 86400)  # 24h
```

### Transactional Deduplication

```python
def handle(event):
    event_id = event.headers["event_id"]
    
    with db.transaction():
        # Try to insert processing record
        try:
            db.execute("""
                INSERT INTO processed_events (event_id, processed_at)
                VALUES (%s, NOW())
            """, event_id)
        except UniqueViolation:
            # Already processed
            return
        
        # Process event (same transaction)
        process(event)
```

---

## Ordering Guarantees

### Per-Aggregate Ordering

```sql
-- Outbox entries ordered by aggregate
SELECT * FROM outbox 
WHERE published_at IS NULL 
ORDER BY aggregate_id, created_at
FOR UPDATE SKIP LOCKED
```

### Partition by Aggregate

```python
def publish(entry):
    broker.publish(
        topic="order-events",
        key=entry.aggregate_id,  # Same aggregate → same partition
        value=entry.payload
    )
```

### Handling Out-of-Order

```
If strict ordering required:
  1. Single publisher per aggregate type
  2. Or: Sequence numbers in messages
  3. Or: Consumer reordering buffer
```

---

## Cleanup Strategies

### Delete After Publishing

```python
# Immediately delete after successful publish
db.execute("DELETE FROM outbox WHERE id = %s", entry.id)
```

### Soft Delete with Cleanup

```python
# Mark as published
db.execute("""
    UPDATE outbox SET published_at = NOW() WHERE id = %s
""", entry.id)

# Separate cleanup job
@scheduled(cron="0 * * * *")  # Hourly
def cleanup_outbox():
    db.execute("""
        DELETE FROM outbox 
        WHERE published_at < NOW() - INTERVAL '7 days'
    """)
```

### Archive Before Delete

```python
@scheduled(cron="0 0 * * *")  # Daily
def archive_outbox():
    # Move to archive table
    db.execute("""
        INSERT INTO outbox_archive
        SELECT * FROM outbox 
        WHERE published_at < NOW() - INTERVAL '7 days'
    """)
    
    # Delete from main table
    db.execute("""
        DELETE FROM outbox 
        WHERE published_at < NOW() - INTERVAL '7 days'
    """)
```

---

## Monitoring

### Key Metrics

```
Outbox lag:
  Count of unpublished messages
  Should stay low

Publish latency:
  Time from created_at to published_at
  Indicates processing speed

Publish failures:
  Rate of failed publish attempts
  Indicates broker issues

Outbox size:
  Total table size
  Should be bounded
```

### Alerting

```yaml
alerts:
  - name: OutboxLagHigh
    condition: count(unpublished) > 1000
    for: 5m
    
  - name: OutboxLatencyHigh
    condition: avg(publish_latency) > 30s
    for: 5m
    
  - name: OutboxPublishFailing
    condition: publish_error_rate > 0.01
    for: 5m
```

### Health Check

```python
def outbox_health():
    oldest_unpublished = db.query("""
        SELECT MIN(created_at) 
        FROM outbox 
        WHERE published_at IS NULL
    """)
    
    if oldest_unpublished:
        age = now() - oldest_unpublished
        if age > timedelta(minutes=5):
            return Health.DEGRADED
    
    return Health.HEALTHY
```

---

## Variations

### Inbox Pattern (Idempotent Consumer)

```
Mirror of outbox for consumers

Message arrives → Write to inbox → Process → Mark processed

Inbox table:
  id, message_id, payload, processed_at

Guarantees idempotency at consumer
```

### Transactional Inbox

```python
def handle_message(message):
    with db.transaction():
        # Check/insert inbox record
        result = db.execute("""
            INSERT INTO inbox (message_id, received_at)
            VALUES (%s, NOW())
            ON CONFLICT (message_id) DO NOTHING
            RETURNING id
        """, message.id)
        
        if not result:
            return  # Already processed
        
        # Process in same transaction
        process(message)
```

---

## Debezium CDC Implementation

### Architecture Deep Dive

Debezium is a distributed platform for change data capture built on top of Kafka Connect. For the outbox pattern, Debezium reads the database transaction log directly — no polling queries, no application-level hooks — and publishes row-level changes to Kafka topics.

```
Database Transaction Log ──► Debezium Connector ──► Kafka Connect ──► Kafka Topic
     (WAL / binlog)            (source connector)    (worker cluster)    (outbox.events.*)
```

### PostgreSQL: Logical Replication

PostgreSQL uses Write-Ahead Logging (WAL) for crash recovery. Debezium creates a **logical replication slot** using the `pgoutput` plugin (built-in since PostgreSQL 10) to stream changes.

- Replication slot guarantees no WAL segments are recycled before Debezium consumes them
- `pgoutput` decodes WAL entries into logical change events (INSERT, UPDATE, DELETE)
- No polling of the outbox table — changes are pushed from WAL as they commit
- Requires `wal_level = logical` in `postgresql.conf`

### MySQL: Binlog Consumption

MySQL's binary log records all data modifications. Debezium connects as a replica:

- Reads binlog events, filters for the outbox table via `table.include.list`
- Supports both row-based and mixed binlog formats (row-based required for full change capture)
- Connector tracks binlog filename + position for resume after restart

### Connector Configuration

```json
{
  "connector.class": "io.debezium.connector.postgresql.PostgresConnector",
  "database.hostname": "db-primary",
  "database.port": "5432",
  "database.user": "debezium_replication",
  "database.dbname": "app",
  "slot.name": "outbox_slot",
  "plugin.name": "pgoutput",
  "table.include.list": "public.outbox_events",
  "transforms": "outbox",
  "transforms.outbox.type": "io.debezium.transforms.outbox.EventRouter",
  "transforms.outbox.table.field.event.key": "aggregate_id",
  "transforms.outbox.table.field.event.type": "event_type",
  "transforms.outbox.table.field.event.payload": "payload",
  "transforms.outbox.route.topic.replacement": "outbox.events.${routedByValue}"
}
```

### EventRouter Transform

The `EventRouter` Single Message Transform (SMT) is the critical piece that makes Debezium outbox-aware:

- Extracts the event payload from the outbox row's `payload` column — no envelope wrapping
- Routes to the correct Kafka topic based on `aggregate_type` (e.g., `outbox.events.Order`)
- Sets the Kafka message key to `aggregate_id` — ensures partition-level ordering per entity
- Optionally removes the outbox row after publishing (via `route.tombstone.on.empty.payload`)

### Ordering Guarantee

Events are published in WAL commit order within a single Kafka partition. Since `aggregate_id` is the partition key, all events for the same aggregate land in the same partition and arrive in the exact order they were committed to the database. Cross-aggregate ordering is not guaranteed across partitions — this is by design.

---

## Outbox Table Schema Design

### Minimal Schema

```sql
CREATE TABLE outbox_events (
    id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    aggregate_type VARCHAR(255) NOT NULL,   -- e.g., 'Order', 'Payment'
    aggregate_id  VARCHAR(255) NOT NULL,   -- entity's business ID
    event_type    VARCHAR(255) NOT NULL,   -- e.g., 'OrderCreated', 'PaymentFailed'
    payload       JSONB       NOT NULL,    -- full event body
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### Why `aggregate_id` Matters

The `aggregate_id` column serves dual purpose:

1. **Kafka partition key** — Debezium's EventRouter (or the polling publisher) uses this as the message key. Kafka hashes it to a partition, guaranteeing all events for the same entity arrive in order.
2. **Consumer correlation** — downstream services use `aggregate_id` to reconstruct entity state without querying the source.

### Payload Strategy: Full vs Reference

| Strategy | Tradeoff |
|---|---|
| **Full payload** (entire event body in JSONB) | Self-contained events, larger rows, consumers need nothing else |
| **Reference** (event ID + type, consumer fetches details) | Small outbox rows, but introduces coupling — consumer must call back to source service |

Prefer full payload unless event size routinely exceeds 1MB. Self-contained events decouple services more effectively.

### Retention and Cleanup

With CDC (Debezium), processed rows can be deleted immediately — Debezium tracks its position in the WAL via the replication slot, not by reading the outbox table. Keeping the table small reduces vacuum overhead and index bloat.

For polling-based implementations, retain rows until `published_at` is set, then delete via a scheduled cleanup job.

### Indexes

- **Primary key on `id`** — required for deduplication and lookups
- **Partial index on `created_at WHERE published_at IS NULL`** — for polling-based publishers to find unpublished rows efficiently
- Avoid indexing `payload` — JSONB GIN indexes on the outbox table add write overhead with no read benefit

### Table Partitioning

For high-throughput systems, partition the outbox table by `created_at` using PostgreSQL's native partitioning or `pg_partman`:

```sql
CREATE TABLE outbox_events (
    id UUID NOT NULL DEFAULT gen_random_uuid(),
    aggregate_type VARCHAR(255) NOT NULL,
    aggregate_id VARCHAR(255) NOT NULL,
    event_type VARCHAR(255) NOT NULL,
    payload JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
) PARTITION BY RANGE (created_at);
```

Partitioning enables `DROP`-based cleanup (dropping old partitions) instead of row-level `DELETE`, avoiding table bloat and long-running vacuum operations.

---

## Polling vs CDC Tradeoffs

### Comparison Matrix

| Aspect | Polling | CDC (Debezium) |
|---|---|---|
| **Latency** | Polling interval bound (100ms–5s typical) | Near-real-time (<100ms from commit) |
| **Ordering** | `ORDER BY created_at` may have gaps under concurrent writes | WAL order is exact commit order |
| **Database load** | Repeated queries on outbox table; mitigated with `FOR UPDATE SKIP LOCKED` | Reads from replication slot — minimal incremental load |
| **Operational complexity** | Simple SQL query + cron or loop | Debezium + Kafka Connect cluster + monitoring |
| **Failure recovery** | Re-poll from last processed ID or `published_at IS NULL` | Debezium resumes from stored WAL offset |
| **Infrastructure** | Application + database only | Kafka, Kafka Connect, Debezium, Schema Registry |
| **Throughput ceiling** | Limited by poll query speed + batch size | WAL streaming scales with database write throughput |

### When to Choose Polling

- Small-to-medium event volume (< 1,000 events/second)
- No existing Kafka infrastructure and no plan to adopt it
- Team prefers operational simplicity over latency
- Events are not latency-sensitive (batch processing, daily reports)

### When to Choose CDC

- High throughput (> 1,000 events/second sustained)
- Strict ordering requirements within an aggregate
- Existing Kafka infrastructure with operational expertise
- Near-real-time event propagation is a business requirement
- Multiple consumers need the same event stream (Kafka topic fan-out)

### Hybrid Approach

Some systems start with polling and migrate to CDC as scale demands. The outbox table schema remains identical — only the publisher mechanism changes. This makes polling a safe starting point with a clear upgrade path.

---

## Outbox Pattern Failure Modes

### Replication Slot Bloat (CDC)

When Debezium is down or unable to consume, PostgreSQL retains WAL segments referenced by the replication slot. Unchecked, this fills disk and crashes the database.

**Detection:** Monitor `pg_replication_slots` — compare `confirmed_flush_lsn` against `pg_current_wal_lsn()`. A growing delta indicates Debezium is falling behind.

```sql
SELECT slot_name,
       pg_wal_lsn_diff(pg_current_wal_lsn(), confirmed_flush_lsn) AS bytes_behind
FROM pg_replication_slots
WHERE slot_name = 'outbox_slot';
```

**Mitigation:** Set `max_slot_wal_keep_size` (PostgreSQL 13+) to cap retained WAL. Alert when lag exceeds a threshold (e.g., 1GB). If Debezium is unrecoverable, drop and recreate the slot — accept that some events may need re-publishing from the outbox table.

### Duplicate Events on Consumer Restart

If a consumer crashes after processing an event but before committing its offset, it will re-receive the event on restart. Consumers must be idempotent. See `04-delivery-guarantees.md` for patterns.

### Schema Evolution

Adding or removing fields in the outbox payload breaks consumers that expect a fixed structure. Strategies:

- **Avro + Schema Registry:** Enforce forward and backward compatibility at the schema level. Debezium natively integrates with Confluent Schema Registry.
- **JSONB with additive changes only:** Never remove fields, only add optional ones. Consumers ignore unknown fields.
- **Versioned event types:** Use `OrderCreated.v2` as the `event_type` to distinguish incompatible schema versions.

### Large Payloads

Outbox rows with large JSONB payloads (>100KB) slow down WAL replication and increase Kafka message size. Options:

- Store the full payload in a separate table; the outbox row holds a reference (event ID + aggregate type). Consumers fetch the payload from an API or object store.
- Compress payloads before writing to the outbox column.
- Claim-check pattern: write the payload to S3/GCS, store the object key in the outbox row.

### Transaction Ordering Across Aggregates

A single database transaction may write outbox entries for multiple aggregates (e.g., `Order` and `Payment`). These events land on different Kafka partitions and may arrive at consumers in any order. Design consumers to handle this:

- Do not assume cross-aggregate causal ordering
- Use explicit correlation IDs if downstream logic requires coordinated processing
- If strict cross-aggregate ordering is required, route all related events through the same `aggregate_id` — but this limits partition parallelism

---

## Alternatives to Outbox

### Listen/Notify (PostgreSQL)

PostgreSQL's `NOTIFY` can be issued inside the same transaction as the business write. A listening process receives the notification and publishes to the broker.

```sql
-- Inside transaction
INSERT INTO orders (...) VALUES (...);
NOTIFY order_events, '{"order_id": "abc", "type": "OrderCreated"}';
```

**Limitation:** Notifications are not persisted. If the listener is disconnected or crashes, events are lost permanently. No replay capability. Only suitable for non-critical, best-effort notifications.

### Transactional Messaging (XA/2PC)

Enlist both the database and the message broker in a distributed transaction using XA. Both commit or both roll back.

**Limitation:** Most message brokers (Kafka, RabbitMQ, SQS) do not support XA. Even where supported, 2PC is slow (coordinator round-trips), fragile (coordinator failure blocks all participants), and operationally painful. The outbox pattern exists precisely because XA is impractical at scale.

### Domain Events Published After Commit

```python
def create_order(order_data):
    order = save_to_db(order_data)
    # DB committed, now publish
    broker.publish(OrderCreated(order))  # crash here = lost event
```

The gap between commit and publish is the exact vulnerability the outbox pattern eliminates. Any crash, network timeout, or process kill in that window causes a lost event with no recovery path.

### Event Table with Application Polling

Similar to outbox but without the formal outbox structure — the application writes events to a generic table and polls it for publishing. Functionally equivalent to the outbox pattern but often lacks the explicit `aggregate_id` partitioning and idempotency design.

### When Outbox Is Overkill

- Internal service communication where the caller retries on failure (synchronous HTTP with retry)
- Non-critical notifications (email, Slack alerts) where occasional loss is acceptable
- Single-service architectures with no downstream consumers
- Prototyping or MVP stages where operational simplicity outweighs reliability guarantees

---

## Key Takeaways

1. **Solves dual-write problem** - Atomic database + message
2. **Same transaction is key** - Business data + outbox together
3. **Polling or CDC** - Choose based on latency needs
4. **Duplicates will happen** - Consumers must be idempotent
5. **Order by aggregate** - Preserve per-entity ordering
6. **Clean up regularly** - Don't let outbox grow unbounded
7. **Monitor lag** - Detect publishing problems early
8. **Inbox for consumers** - Same pattern on receive side
