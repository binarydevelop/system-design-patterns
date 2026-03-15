# Event Sourcing

## TL;DR

Event sourcing stores all changes to application state as a sequence of events. Instead of storing current state, you store the history of what happened. Current state is derived by replaying events. Benefits: complete audit trail, temporal queries, debugging. Costs: complexity, eventual consistency, storage growth. Often paired with CQRS.

---

## Traditional vs Event Sourcing

### Traditional (State-Based)

```
Database stores current state:

Users table:  id: 123, balance: 500, updated_at: 2024-01-15

Problem: History is lost
  What was the balance yesterday? How did we get to 500? Unknown.
```

### Event Sourcing

```
Database stores events:
  AccountCreated(id=123, balance=1000)
  MoneyWithdrawn(id=123, amount=200)
  MoneyDeposited(id=123, amount=300)
  MoneyWithdrawn(id=123, amount=600)

Current state: Replay → 1000 - 200 + 300 - 600 = 500 ✓
Complete history preserved
```

---

## Core Concepts

### Event

```python
@dataclass
class Event:
    event_id: str
    aggregate_id: str
    event_type: str
    timestamp: datetime
    data: dict
    version: int

# Example
AccountCreated(
    event_id="evt-001",
    aggregate_id="account-123",
    event_type="AccountCreated",
    timestamp="2024-01-15T10:00:00Z",
    data={"owner": "Alice", "initial_balance": 1000},
    version=1
)
```

### Event Store

```
Append-only log of events

┌──────────────────────────────────────────────┐
│ Event 1 │ Event 2 │ Event 3 │ ... │ Event N │
└──────────────────────────────────────────────┘
     ↑
  Append only (no updates, no deletes)
```

### Aggregate

```
Domain entity that groups related events. Events always belong to an aggregate.

Account aggregate:  Created, Deposited, Withdrawn, Closed
Order aggregate:    Placed, Confirmed, Shipped, Delivered
```

### Command

```
Represents intent to change state. Validated, then generates events.

Command: Withdraw(account_id=123, amount=100)
  Validation: Account exists? ✓  Sufficient balance? ✓
  Result: MoneyWithdrawn event generated
```

---

## Event Store Implementation

### Schema

```sql
CREATE TABLE events (
    event_id UUID PRIMARY KEY,
    aggregate_id VARCHAR(255) NOT NULL,
    aggregate_type VARCHAR(255) NOT NULL,
    event_type VARCHAR(255) NOT NULL,
    event_data JSONB NOT NULL,
    metadata JSONB,
    version INT NOT NULL,
    timestamp TIMESTAMP NOT NULL,
    
    UNIQUE (aggregate_id, version)  -- Optimistic concurrency
);

CREATE INDEX idx_events_aggregate ON events(aggregate_id, version);
CREATE INDEX idx_events_timestamp ON events(timestamp);
```

### Append Events

```python
class EventStore:
    def append(self, aggregate_id, events, expected_version):
        with transaction():
            # Check optimistic concurrency
            current = self.get_latest_version(aggregate_id)
            if current != expected_version:
                raise ConcurrencyError(
                    f"Expected version {expected_version}, got {current}"
                )
            
            # Append events
            for i, event in enumerate(events):
                event.version = expected_version + i + 1
                self.db.insert(event)
            
            # Publish events
            for event in events:
                self.publish(event)
```

### Load Aggregate

```python
def load_aggregate(aggregate_id):
    # Get all events for aggregate
    events = event_store.get_events(aggregate_id)
    
    # Replay to rebuild state
    aggregate = Account()
    for event in events:
        aggregate.apply(event)
    
    return aggregate

class Account:
    def apply(self, event):
        if event.type == "AccountCreated":
            self.id = event.data["id"]
            self.balance = event.data["initial_balance"]
        elif event.type == "MoneyDeposited":
            self.balance += event.data["amount"]
        elif event.type == "MoneyWithdrawn":
            self.balance -= event.data["amount"]
```

---

## Snapshots

### The Problem

```
Account with 10,000 events
Every load: replay 10,000 events
Very slow!
```

### Snapshot Solution

```
Every N events, save current state as snapshot

Events: 1-1000
Snapshot at event 1000: {balance: 5000, ...}
Events: 1001-2000

Load process:
  1. Load snapshot (if exists)
  2. Replay only events after snapshot
  
Replay 1000 events instead of 2000
```

### Implementation

```python
def load_aggregate_with_snapshot(aggregate_id):
    # Try to load snapshot
    snapshot = snapshot_store.get_latest(aggregate_id)
    
    if snapshot:
        aggregate = deserialize(snapshot.state)
        start_version = snapshot.version + 1
    else:
        aggregate = Account()
        start_version = 0
    
    # Replay events since snapshot
    events = event_store.get_events(
        aggregate_id, 
        from_version=start_version
    )
    
    for event in events:
        aggregate.apply(event)
    
    return aggregate

def save_snapshot(aggregate_id, aggregate, version):
    snapshot_store.save(
        aggregate_id=aggregate_id,
        state=serialize(aggregate),
        version=version
    )
```

---

## Projections

### Concept

```
Events (source of truth)
    ↓ Project
Read Models (optimized for queries)

Same events → multiple projections
Each optimized for specific use case
```

### Examples

```
Events:
  AccountCreated(id=1, owner="Alice")
  MoneyDeposited(id=1, amount=1000)
  AccountCreated(id=2, owner="Bob")
  MoneyWithdrawn(id=1, amount=500)

Projection: Account Balances
  {id: 1, balance: 500}
  {id: 2, balance: 0}

Projection: Activity Timeline
  [
    {time: T1, action: "Account 1 created"},
    {time: T2, action: "Deposit of 1000 to Account 1"},
    ...
  ]

Projection: Owner Directory
  {Alice: [1], Bob: [2]}
```

### Building Projections

```python
class BalanceProjection:
    def __init__(self):
        self.balances = {}
    
    def handle(self, event):
        if event.type == "AccountCreated":
            self.balances[event.data["id"]] = event.data.get("initial_balance", 0)
        elif event.type == "MoneyDeposited":
            self.balances[event.aggregate_id] += event.data["amount"]
        elif event.type == "MoneyWithdrawn":
            self.balances[event.aggregate_id] -= event.data["amount"]
    
    def rebuild_from_start(self):
        self.balances = {}
        for event in event_store.get_all_events():
            self.handle(event)
```

---

## Benefits

### Complete Audit Trail

```
Every change is recorded
Who did what, when

Question: "Why is balance 500?"
Answer: Replay events and see each change
```

### Temporal Queries

```python
def get_balance_at_time(account_id, timestamp):
    events = event_store.get_events(
        account_id,
        before=timestamp
    )
    
    balance = 0
    for event in events:
        if event.type == "MoneyDeposited":
            balance += event.data["amount"]
        elif event.type == "MoneyWithdrawn":
            balance -= event.data["amount"]
    
    return balance

# What was balance on Jan 1?
get_balance_at_time("account-123", "2024-01-01")
```

### Debugging

```
Bug in production:
  1. Capture events that led to bug
  2. Replay locally
  3. Debug with full history
  4. Fix and test with same events
```

### Schema Evolution

```
Events are facts about the past
Don't change events, add new types

v1: UserCreated(name)
v2: UserCreated(name, email)  # New field

Old events still valid
New code handles both versions
```

---

## Challenges

### Eventual Consistency

```
Event stored → Projection updated (async)

Gap where projection is stale
UI might show outdated data

Solutions:
  - Accept eventual consistency
  - Read from event store for critical reads
  - Optimistic UI updates
```

### Storage Growth

```
Events never deleted
Storage grows forever

Mitigations:
  - Snapshots (reduce replay time)
  - Archival (move old events to cold storage)
  - Event compaction (carefully, for specific patterns)
```

### Event Schema Changes

```
Challenge: Past events are immutable

Solutions:
  - Version events explicitly
  - Upcasting: Transform old events when reading
  - Weak schema: Store as JSON, handle missing fields
```

```python
def upcast_event(event):
    if event.type == "UserCreated" and event.version == 1:
        # Add default email for v1 events
        event.data["email"] = None
        event.version = 2
    return event
```

### Complex Queries

```
Event store optimized for:
  - Append
  - Read by aggregate

NOT optimized for:
  - Complex queries across aggregates
  - Aggregations

Solution: Projections for query needs
```

---

## Event Sourcing Patterns

### Command → Event

```python
def handle_withdraw(cmd: WithdrawCommand):
    # Load aggregate
    account = load_aggregate(cmd.account_id)
    
    # Validate
    if account.balance < cmd.amount:
        raise InsufficientFundsError()
    
    # Generate event
    event = MoneyWithdrawn(
        account_id=cmd.account_id,
        amount=cmd.amount,
        timestamp=now()
    )
    
    # Store event
    event_store.append(cmd.account_id, [event], account.version)
    
    return event
```

### Saga/Process Manager

```
Coordinate multiple aggregates

OrderSaga:
  On OrderPlaced:
    Send ReserveInventory command
  
  On InventoryReserved:
    Send ChargePayment command
  
  On PaymentCharged:
    Send ShipOrder command
  
  On PaymentFailed:
    Send ReleaseInventory command
```

### Event Replay for Migration

```python
def migrate_to_new_projection():
    # Create new projection store
    new_projection = NewProjection()
    
    # Replay all events
    for event in event_store.get_all_events():
        new_projection.handle(event)
    
    # Switch over
    swap_projection(old_projection, new_projection)
```

---

## When to Use Event Sourcing

```
✓ Strong audit requirements (finance, healthcare)
✓ Complex domain with business rules
✓ Need for temporal queries
✓ Event-driven architecture already in place
✓ CQRS implementation
```

---

## Snapshotting Strategies

### Why Snapshot

```
Aggregate with 1,000,000 events → replay all on every load? Unacceptable.

Snapshot = serialized aggregate state at a known version.
Load snapshot → replay only events after that version.

Without snapshot:  replay 1..1,000,000  (~seconds to minutes)
With snapshot at v999,000:  deserialize + replay 1,000  (~ms)
```

### When to Snapshot

```
Every N events    — snapshot after every 100 events. Simple, predictable.
Time-based        — snapshot if last one older than T. Better for bursty writes.
On read (lazy)    — if events_since_snapshot > threshold → snapshot after load.
                    No background job, but first slow read pays the cost.

Tradeoff: too frequent → storage cost / write amplification
          too rare    → slow recovery / high replay latency
```

### Snapshot Storage

```
Separate store, keyed by (aggregate_id, version):

  snapshots: aggregate_id | version | state (JSONB) | schema_version
             account-123  | 1000    | {balance:...} | 3
             account-123  | 2000    | {balance:...} | 4

Include schema_version — snapshot from code v3 may not deserialize with v5.
Migrate on read if schema_version < current.
```

### Snapshot Manager

```python
class SnapshotManager:
    def __init__(self, event_store, snapshot_store, interval=100):
        self.event_store = event_store
        self.snapshot_store = snapshot_store
        self.interval = interval

    def load(self, aggregate_id, factory):
        snapshot = self.snapshot_store.get_latest(aggregate_id)
        if snapshot:
            aggregate = deserialize(snapshot.state, snapshot.schema_version)
            from_version = snapshot.version + 1
        else:
            aggregate, from_version = factory(), 0

        events = self.event_store.get_events(aggregate_id, from_version=from_version)
        for event in events:
            aggregate.apply(event)

        if len(events) >= self.interval:  # lazy snapshot on read
            self.snapshot_store.save(
                aggregate_id=aggregate_id, version=aggregate.version,
                state=serialize(aggregate), schema_version=CURRENT_SCHEMA_VERSION)
        return aggregate
```

---

## Schema Evolution

### The Problem

```
Events are immutable — you cannot modify stored events.
But your domain model evolves: new fields, renamed fields, split events.

Day 1:  OrderPlaced { order_id, total }
Day 90: OrderPlaced { order_id, total, currency, customer_tier }

Old events still have the day-1 shape. Application code expects day-90 shape.
```

### Upcasting

```python
# Transform old event shapes to current shape ON READ.
# Event store keeps original bytes untouched.
UPCASTERS = {
    ("OrderPlaced", 1): lambda data: {
        **data, "currency": "USD", "customer_tier": "standard",
    },
}

def upcast(event_type, version, data):
    key = (event_type, version)
    while key in UPCASTERS:
        data = UPCASTERS[key](data)
        version += 1
        key = (event_type, version)
    return data
```

### Versioned Event Types

```
Explicit version in type name:
  OrderPlaced_v1 { order_id, total }
  OrderPlaced_v2 { order_id, total, currency, customer_tier }

Consumer handles both via match/switch.
Works but proliferates types — prefer upcasting for most cases.
```

### Schema Strategy Comparison

```
Weak schema (JSON, tolerant reader):
  + Easy to add fields, no registry needed
  - No compile-time safety, silent failures on typos

Strong schema (Avro / Protobuf):
  + Forward/backward compatibility enforced, compile-time types
  - Requires schema registry, more operational overhead
```

### Anti-pattern: Mutating Stored Events

```
NEVER rewrite events in the store.
Breaks: audit trail, deterministic replay, causality with downstream consumers.

To correct a fact, append a compensating event:
  OrderPlaced → OrderCorrected { reason, corrected_fields }
```

---

## Event Store Technology Choices

### PostgreSQL

```
Already shown above in "Event Store Implementation" section.
Simple, proven, JSONB for flexible event data.
Unique constraint on (aggregate_id, version) = optimistic concurrency.
Application retries on constraint violation: reload, re-validate, re-append.
```

### EventStoreDB

```
Purpose-built event store (open source, gRPC API).
Native stream-per-aggregate, built-in projections, persistent subscriptions.
Optimistic concurrency on stream version. Catch-up subscriptions for rebuilds.
Choose when ES is central to architecture and team can operate a dedicated store.
```

### Kafka as Event Log

```
Append-only distributed log — tempting as an event store, but:
  - No per-aggregate ordering (topic partitions ≠ aggregates)
  - No optimistic concurrency per aggregate
  - Reading single aggregate = scan partition or maintain external index
  - Retention policies can delete events (violates immutability)

Better role: publish events FROM event store to Kafka for downstream consumers.
Event store = source of truth, Kafka = distribution layer.
```

### DynamoDB

```
Partition key = aggregate_id, sort key = version.
Conditional write (attribute_not_exists) = optimistic concurrency.
Serverless, scales horizontally, DynamoDB Streams for CDC.
Limitations: 400 KB item limit, no built-in projections (DIY via Streams + Lambda).
```

### Comparison

```
                    PostgreSQL   EventStoreDB   Kafka      DynamoDB
Optimistic conc.    ✓ (unique)   ✓ (native)     ✗          ✓ (cond. write)
Built-in proj.      ✗ (DIY)      ✓              ✗          ✗ (DIY)
Per-aggregate read  ✓            ✓              ✗          ✓
Ops complexity      Low          Medium         High       Low
Best for            Starting out ES-centric     Distribution Serverless
```

---

## When NOT to Use Event Sourcing

```
Simple CRUD without audit needs
  User preferences, feature flags, CMS content.
  No one asks "what was the value 3 months ago?" — plain UPDATE wins.

Domain has no meaningful events
  Config management, static reference data, lookup tables.
  Rare changes + uninteresting history = ceremony with no payoff.

Team experience gap
  ES demands: eventual consistency, projection rebuilds, idempotent handlers,
  schema evolution, upcasting. Steep learning curve → bugs in production.
  Build event-driven skills incrementally before adopting full ES.

Unacceptable read staleness
  If business requires reads to reflect writes instantly, the async projection
  lag in ES + CQRS is a constant pain point. Workarounds (synchronous
  projections, read-your-writes) erode the decoupling benefits.

Unpredictable schema churn
  Event shapes shifting weekly → upcaster chains grow, test matrix explodes.
  Stabilize the domain model first, adopt ES later.

Anti-pattern: "Event Source Everything"
  Apply selectively to bounded contexts that benefit:
    Payment processing → strong audit, temporal queries → YES
    User profile CRUD  → simple reads/writes, no history → NO
  Mixing ES and non-ES contexts in the same system is normal and healthy.
```

---

## Key Takeaways

1. **Store events, not state** - State is derived
2. **Events are immutable** - Never update or delete
3. **Snapshots prevent slow rebuilds** - Take periodically
4. **Projections for queries** - Multiple views from same events
5. **Eventual consistency is normal** - Design for it
6. **Great for audit trails** - Complete history
7. **Complexity is real** - Not for simple CRUD
8. **Pairs well with CQRS** - Separate read/write models
