# CQRS (Command Query Responsibility Segregation)

## TL;DR

CQRS separates read and write operations into different models. Commands modify state; Queries read state. Each model can be optimized for its purpose. Write model ensures invariants; Read model optimized for queries. Often paired with event sourcing. Benefits: independent scaling, optimized models. Costs: complexity, eventual consistency.

---

## The Problem

### Traditional Architecture

```
┌─────────────────────────────────────────┐
│              Single Model               │
│  ┌─────────────────────────────────┐   │
│  │       Domain Objects            │   │
│  │  (used for reads AND writes)    │   │
│  └─────────────────────────────────┘   │
│                  │                      │
│  ┌───────────────┴───────────────┐     │
│  │          Database             │     │
│  │   (same tables for both)      │     │
│  └───────────────────────────────┘     │
└─────────────────────────────────────────┘

Problems:
  - Read and write patterns differ
  - Single model compromises both
  - Scaling challenges
```

### Read vs Write Characteristics

```
Writes:
  - Low volume (relative)
  - Complex validation
  - Transactional
  - Strong consistency needed

Reads:
  - High volume (typically 10-100x writes)
  - No validation needed
  - Often denormalized
  - Eventual consistency often OK
```

---

## CQRS Architecture

### Basic Structure

```
┌─────────────────────────────────────────────────────────┐
│                      Application                        │
├────────────────────────┬────────────────────────────────┤
│     Command Side       │         Query Side             │
│                        │                                │
│   ┌──────────────┐     │     ┌──────────────┐          │
│   │   Commands   │     │     │   Queries    │          │
│   └──────┬───────┘     │     └──────┬───────┘          │
│          ▼             │            ▼                   │
│   ┌──────────────┐     │     ┌──────────────┐          │
│   │   Handlers   │     │     │   Handlers   │          │
│   └──────┬───────┘     │     └──────┬───────┘          │
│          ▼             │            ▼                   │
│   ┌──────────────┐     │     ┌──────────────┐          │
│   │ Write Model  │     │     │ Read Model   │          │
│   │  (Domain)    │────────►  │ (Projections)│          │
│   └──────┬───────┘     │     └──────┬───────┘          │
│          ▼             │            ▼                   │
│   ┌──────────────┐     │     ┌──────────────┐          │
│   │  Write DB    │     │     │   Read DB    │          │
│   └──────────────┘     │     └──────────────┘          │
└────────────────────────┴────────────────────────────────┘
```

### Command Side

```python
# Command: Intent to change state
@dataclass
class CreateOrderCommand:
    customer_id: str
    items: List[OrderItem]

# Handler: Validates and executes
class CreateOrderHandler:
    def handle(self, cmd: CreateOrderCommand):
        # Load domain object
        customer = self.customer_repo.get(cmd.customer_id)
        
        # Business logic and validation
        order = customer.create_order(cmd.items)
        
        # Persist
        self.order_repo.save(order)
        
        # Publish event for read side
        self.events.publish(OrderCreated(order))
```

### Query Side

```python
# Query: Request for data
@dataclass
class GetOrderSummaryQuery:
    order_id: str

# Handler: Retrieves from read model
class GetOrderSummaryHandler:
    def handle(self, query: GetOrderSummaryQuery):
        # Simple read from optimized store
        return self.read_db.get(
            f"order_summary:{query.order_id}"
        )
```

---

## Synchronization

### Event-Based Sync

```
Write Side           Events           Read Side
    │                   │                 │
    │  Save order       │                 │
    ▼                   │                 │
[Write DB]             │                 │
    │                   │                 │
    │  OrderCreated ───►│                 │
    │                   │                 │
    │                   ▼                 │
    │              [Event Bus]           │
    │                   │                 │
    │                   │  ───────────────►
    │                   │                 │
    │                   │                 ▼
    │                   │            [Projector]
    │                   │                 │
    │                   │                 ▼
    │                   │           [Read DB]
```

### Projector Implementation

```python
class OrderProjector:
    def handle(self, event):
        if isinstance(event, OrderCreated):
            summary = OrderSummary(
                id=event.order_id,
                customer_name=event.customer_name,
                total=event.total,
                status="created"
            )
            self.read_db.save(f"order_summary:{event.order_id}", summary)
        
        elif isinstance(event, OrderShipped):
            summary = self.read_db.get(f"order_summary:{event.order_id}")
            summary.status = "shipped"
            summary.shipped_at = event.timestamp
            self.read_db.save(f"order_summary:{event.order_id}", summary)
```

---

## Read Model Optimization

### Denormalization

```
Write model (normalized):
  Orders:     id, customer_id, total
  Customers:  id, name, email
  Items:      id, order_id, product_id, qty

Read model (denormalized):
  OrderSummary:
    order_id
    customer_name      ← Copied from Customers
    customer_email     ← Copied from Customers
    total
    item_count         ← Computed
    product_names[]    ← Copied from Products
```

### Multiple Read Models

```
Same events → Multiple optimized views

OrderCreated, ItemAdded, OrderShipped events
  ↓
┌─────────────────────────────────────────────┐
│ OrderSummaryProjection (for order page)     │
│ CustomerOrdersProjection (for customer page)│
│ ShippingDashboard (for logistics)           │
│ AnalyticsProjection (for reports)           │
└─────────────────────────────────────────────┘
```

### Read Store Options

```
Different stores for different needs:

Order summary:       Redis (fast key-value)
Full-text search:    Elasticsearch
Analytics:           ClickHouse (columnar)
Customer dashboard:  PostgreSQL (relational)

Each optimized for its use case
```

---

## Eventual Consistency

### The Trade-off

```
Command completes at T=0
Event processed at T=100ms → Read model updated
Query at T=50ms: Sees old data! "Write succeeded but I don't see my change"
```

### Handling Strategies

**Optimistic UI:** Update the client immediately on submit, before the server confirms. The UI already shows the expected state while the projection catches up.

**Read from Write Model:** For consistency-sensitive reads, fall back to the write database. See "Consistency Between Read and Write Models" below for detailed patterns (read-your-writes, versioned reads, synchronous projections).

---

## CQRS + Event Sourcing

### Natural Fit

```
Event Sourcing:
  Events are source of truth

CQRS:
  Write: Append events
  Read: Project events to read models

┌─────────────┐     ┌──────────────┐     ┌────────────┐
│  Commands   │────►│ Event Store  │────►│ Projections│
│             │     │ (write side) │     │(read side) │
└─────────────┘     └──────────────┘     └────────────┘
```

### Implementation

```python
# Write side: Event sourcing
def handle_withdraw(cmd):
    account = event_store.load(cmd.account_id)
    
    # Validate using events
    if account.balance < cmd.amount:
        raise InsufficientFunds()
    
    # Append event
    event_store.append(
        cmd.account_id,
        MoneyWithdrawn(amount=cmd.amount)
    )

# Read side: Projection
class BalanceProjection:
    def project(self, event):
        if isinstance(event, MoneyWithdrawn):
            current = redis.get(f"balance:{event.account_id}")
            redis.set(f"balance:{event.account_id}", current - event.amount)
```

---

## Without Event Sourcing

### Simpler CQRS

```python
# Write side: Traditional ORM
def create_order(cmd):
    order = Order(
        customer_id=cmd.customer_id,
        items=cmd.items
    )
    db.session.add(order)
    db.session.commit()
    
    # Publish event for read side
    publish(OrderCreated(order.id, order.total))

# Read side: Separate database
@event_handler(OrderCreated)
def project_order(event):
    summary = {
        "id": event.order_id,
        "total": event.total,
        "status": "created"
    }
    read_db.orders.insert(summary)
```

### Shared Database

```
Simplest CQRS: Same database, different access patterns

Write:
  Use ORM, complex objects
  Transactional writes

Read:
  Raw SQL or simple queries
  Read replicas
  Cached results
```

---

## When to Use CQRS

### Good Fit

```
✓ High read-to-write ratio
✓ Complex domain with business rules
✓ Need for different read models
✓ Performance requirements differ for reads vs writes
✓ Team comfortable with complexity
```

### Poor Fit

```
✗ Simple CRUD applications
✗ Low traffic systems
✗ Need for immediate consistency
✗ Small team, tight deadline
✗ Reads and writes have same patterns
```

### Evolution Path

```
Start simple:
  1. Single model, single database
  
Add read replicas:
  2. Write to primary, read from replica
  
Introduce projections:
  3. Separate read models, event-driven sync
  
Full CQRS:
  4. Different databases, full separation
  
Add Event Sourcing:
  5. Event store as write model
```

---

## Common Patterns

### Task-Based UI

```
Traditional: CRUD form with all fields

CQRS: Specific commands

Instead of:
  UpdateUser(id, name, email, phone, address, ...)

Use:
  ChangeUserEmail(id, email)
  UpdateUserAddress(id, address)
  ChangePhoneNumber(id, phone)

Benefits:
  - Clear intent
  - Specific validation
  - Better audit trail
```

### Read Model per View

```
Each UI view has its own projection

Dashboard:     DashboardProjection
Order List:    OrderListProjection
Order Detail:  OrderDetailProjection

No joins at query time
Each projection denormalized for its view
```

### Synchronous Read-After-Write

```python
def create_and_return_order(cmd):
    # Create order (write side)
    order_id = command_handler.create_order(cmd)
    
    # Wait for read model to sync
    summary = poll_until_exists(
        f"order_summary:{order_id}",
        timeout=5s
    )
    
    return summary
```

---

## Testing CQRS

### Command Testing

```python
def test_withdraw_insufficient_funds():
    # Given account with balance 100
    account = Account(balance=100)
    
    # When withdrawing 200
    cmd = WithdrawCommand(account_id=account.id, amount=200)
    
    # Then should raise error
    with pytest.raises(InsufficientFundsError):
        handler.handle(cmd)
```

### Projection Testing

```python
def test_order_projection():
    # Given events
    events = [
        OrderCreated(order_id="1", total=100),
        ItemAdded(order_id="1", item="Widget"),
        OrderShipped(order_id="1")
    ]
    
    # When projected
    projection = OrderProjection()
    for event in events:
        projection.handle(event)
    
    # Then summary correct
    summary = projection.get("1")
    assert summary.status == "shipped"
    assert summary.total == 100
```

---

## Read Model Projection Patterns

### Flat Denormalized Tables

Pre-join all data needed for a specific query into a single table. No joins at query time.

```
Write model (normalized):              Read model (flat):
  orders(id, customer_id, status)        order_summary:
  customers(id, name, email)               order_id, customer_name, customer_email,
  order_items(id, order_id, product_id)    product_names[], item_count, total, status

One SELECT, zero JOINs. Projection handles denormalization on write.
```

### Materialized View per Use Case

Different screens need different shapes of the same data. Build a separate projection for each.

```
Same event stream → multiple projections:
  Mobile list view:   { order_id, status, total, created_at }
  Web detail view:    { order_id, status, total, items[], customer, shipping_address }
  Admin dashboard:    { order_id, customer_name, total, status, fraud_score, region }
Each stores exactly what its consumer needs — nothing more.
```

### Elasticsearch as Read Model

Project events into denormalized Elasticsearch documents for full-text search and filtering.

```python
@event_handler(ProductUpdated)
def project_product(event):
    es.index(index="products", id=event.product_id, body={
        "name": event.name, "description": event.description,
        "category": event.category, "price": event.price, "tags": event.tags
    })

# Query: full-text search + filter in one call
results = es.search(index="products", body={
    "query": {"bool": {
        "must": {"match": {"description": "wireless"}},
        "filter": {"range": {"price": {"lte": 50}}}
    }}
})
```

### Redis as Read Model

Sorted sets for leaderboards, hashes for profile cards. Sub-millisecond reads.

```python
@event_handler(ScoreUpdated)
def project_leaderboard(event):
    redis.zadd("leaderboard:global", {event.user_id: event.score})
    redis.hset(f"profile:{event.user_id}", mapping={
        "name": event.user_name, "score": event.score
    })

# Top 10 in <1ms
top_10 = redis.zrevrange("leaderboard:global", 0, 9, withscores=True)
```

### GraphQL Read Model

Design projections to match your GraphQL schema directly. Store nested documents so each query resolves with a single read — no resolver chains, no N+1.

```
Projection document mirrors GraphQL type:
  { "id": "order-1",
    "customer": { "id": "c-1", "name": "Alice" },
    "items": [{ "product": "Widget", "qty": 2, "price": 10 }] }
```

### Projection Rebuilding

If projection logic changes, replay all events to rebuild from scratch. This is the killer feature of CQRS+ES: deploy new code, create a new read store, replay events, swap traffic, tear down old store. Zero downtime, no migration scripts. The event stream is the source of truth.

---

## Consistency Between Read and Write Models

### Eventual Consistency Is the Default

Write model updates, event published, read model updated asynchronously. The gap is **projection lag**.

```
T=0ms   Command accepted, event stored    T=15ms  Consumer picks up event
T=5ms   Event published to bus            T=20ms  Read model updated
→ Any query between T=0 and T=20 sees stale data.
```

### Measuring Projection Lag

Track the delta between event timestamp and projection update timestamp. Alert when lag exceeds your SLA.

```python
class MonitoredProjector:
    def project(self, event):
        self.do_project(event)
        lag_ms = (datetime.utcnow() - event.timestamp).total_seconds() * 1000
        metrics.histogram("projection.lag_ms", lag_ms,
                          tags=[f"projection:{self.__class__.__name__}"])
        if lag_ms > 500:
            metrics.increment("projection.lag_sla_breach")
```

### Read-Your-Writes Pattern

After a write, read from the write model for that user's session until the projection catches up. Store the latest write version in the session; on read, check if the projection version meets it — if not, fall back to the write model.

```python
def get_order(order_id, user_session):
    min_version = session_store.get(f"last_write:{user_session}")
    summary = read_db.get(order_id)
    if min_version and (not summary or summary.version < min_version):
        return write_db.get_order(order_id)  # fallback
    return summary
```

### Synchronous Projections

Update the read model in the same transaction as the write. Eliminates lag but couples the models. Only viable for single-DB deployments.

```python
def create_order(cmd):
    with db.transaction():
        order = Order(customer_id=cmd.customer_id, items=cmd.items)
        db.session.add(order)
        summary = OrderSummary.from_order(order)  # same transaction
        db.session.add(summary)
```

Trades independent scalability for strong consistency. Appropriate when you share one database and cannot tolerate any projection lag.

### Versioned Reads

Include a version number in the read model. Clients check if the version reflects their latest write.

```
POST /orders → 201 Created { "id": "o-1", "version": 7 }

GET /orders/o-1?min_version=7
  → if read model version >= 7: return 200
  → if read model version < 7:  return 202 Accepted (retry later)
```

---

## When CQRS Adds Unnecessary Complexity

### Simple CRUD Applications

If reads and writes have the same shape — a form that saves and displays the same fields — CQRS adds a synchronization layer with no benefit. A single model with REST endpoints is simpler and sufficient.

### Small Team Overhead

Maintaining separate read and write models doubles the code surface. Every schema change touches both sides. Need team discipline, clear ownership, and experience with eventual consistency debugging.

### Single Database, No Scaling Pressure

If you are not scaling reads independently from writes, a well-indexed table behind an ORM handles both paths. Adding projections and an event bus is overhead without a scaling payoff.

### Low Read/Write Asymmetry

CQRS shines when reads vastly outnumber writes (100:1 or higher). If reads and writes are roughly equal, the complexity of maintaining separate models is harder to justify.

### Anti-Pattern: CQRS Everywhere

Apply CQRS to bounded contexts with clear read/write asymmetry — product catalog, analytics dashboards, search. Do not apply it uniformly across the entire system. Most services are fine with simple CRUD.

### Decision Checklist

```
5 questions before adopting CQRS ("no" to 3+ → likely premature):

1. Do reads and writes have fundamentally different shapes?
2. Is the read-to-write ratio > 50:1?
3. Do you need multiple read model representations?
4. Can your users tolerate eventual consistency?
5. Does your team have experience with event-driven systems?
```

---

## Production CQRS Architecture

### Event Bus Selection

```
Kafka:     Durable, ordered per partition, replay from offset.
           Best for high-throughput, multi-consumer architectures.
RabbitMQ:  Simpler ops, flexible routing (fanout, topic).
           Best for lower throughput, simpler topologies.
```

### Projection Service Design

Stateless consumer that reads events and updates the read store. Must be idempotent — processing the same event twice produces the same result (cross-ref `04-delivery-guarantees.md`). Use event ID as a dedup key: check before projecting, mark after.

```python
class ProjectionConsumer:
    def process(self, event):
        if self.read_db.has_processed(event.event_id):
            return
        self.projector.project(event)
        self.read_db.mark_processed(event.event_id)
```

### Monitoring

```
Projection lag:       event_timestamp - projection_timestamp (alert > 500ms)
Failed projections:   events routed to dead-letter queue (alert: any DLQ entry)
Read model staleness: last_projection_update_timestamp (alert: no update > 30s)
Consumer group lag:   Kafka consumer offset - latest offset (backpressure signal)
```

### Deployment Independence

Read and write models deploy independently. Read model can be rebuilt without affecting writes — deploy new projection logic, replay events, swap traffic. A domain logic change in the write service does not require a read service release, and vice versa.

### Scaling

Scale read model replicas independently from the write model. Write side: single primary (writes are sequential per aggregate). Read side: add Elasticsearch nodes for search, Redis replicas for cache, PostgreSQL read replicas for relational queries — each scaled to its own traffic pattern.

---

## Key Takeaways

1. **Separate reads and writes** - Different models for different needs
2. **Optimize each side** - Write for invariants, read for queries
3. **Sync via events** - Publish on write, project on read
4. **Accept eventual consistency** - Or pay for immediate
5. **Multiple read models OK** - Different views from same events
6. **Pairs well with Event Sourcing** - Natural combination
7. **Not always needed** - Adds complexity
8. **Start simple, evolve** - Don't over-engineer initially
