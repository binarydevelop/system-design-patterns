# Cache Invalidation

## TL;DR

Cache invalidation is the process of removing or updating stale cache entries. The famous quote applies: "There are only two hard things in Computer Science: cache invalidation and naming things." Strategies include TTL, explicit invalidation, event-driven invalidation, and versioning. Choose based on staleness tolerance, complexity budget, and consistency requirements.

---

## The Problem

### Staleness

```
Time 0: User reads profile (cached)
  Cache: {name: "Alice", age: 30}

Time 1: User updates profile
  Database: {name: "Alice", age: 31}
  Cache: {name: "Alice", age: 30}  ← stale!

Time 2: Another user reads profile
  Returns: {age: 30}  ← wrong!
```

### Why It's Hard

```
1. Distributed nature
   Cache and database are separate systems
   No atomic update across both

2. Multiple caches
   Browser cache, CDN, application cache, database cache
   All need invalidation

3. Cache dependencies
   Invalidating A might require invalidating B, C, D
   Complex graphs of dependencies
```

---

## TTL-Based Expiration

### How It Works

```python
cache.set("user:123", user_data, ttl=300)  # 5 minutes

# After 300 seconds, entry expires
# Next read triggers cache miss
# Fresh data loaded from database
```

### Choosing TTL

```
Short TTL (seconds):
  + Fresher data
  - More cache misses
  - Higher database load
  Use: Real-time data

Medium TTL (minutes):
  + Balance of freshness and efficiency
  - Still have staleness window
  Use: User profiles, product data

Long TTL (hours/days):
  + Very high cache hit rate
  - Potentially very stale
  Use: Static content, rarely changing data
```

### TTL Trade-offs

```
TTL too short:
  Cache hit rate: 60%
  DB queries/sec: 400
  
TTL too long:
  Cache hit rate: 95%
  DB queries/sec: 50
  Staleness: up to 24 hours
  
Sweet spot: Based on change frequency
  If data changes every 10 min: TTL = 1 min
  If data changes every day: TTL = 1 hour
```

---

## Explicit Invalidation

### Delete on Write

```python
def update_user(user_id, new_data):
    # Update database
    db.update("users", user_id, new_data)
    
    # Invalidate cache
    cache.delete(f"user:{user_id}")
    
    # Next read will cache fresh data
```

### Update on Write

```python
def update_user(user_id, new_data):
    # Update database
    db.update("users", user_id, new_data)
    
    # Update cache with new data
    cache.set(f"user:{user_id}", new_data)
```

### Delete vs Update Trade-offs

```
Delete:
  + Simpler (one operation)
  + Never caches wrong data
  - Next read is a miss

Update:
  + Cache always warm
  + Lower latency
  - Risk of caching wrong data
  - More complex error handling
```

---

## Event-Driven Invalidation

### Using Message Queues

```
┌─────────┐     ┌─────────┐     ┌─────────────┐
│ Writer  │────►│  Kafka  │────►│   Cache     │
│ Service │     │ / Redis │     │ Invalidator │
└─────────┘     └─────────┘     └─────────────┘

1. Writer updates database
2. Writer publishes invalidation event
3. Invalidator consumes event
4. Invalidator deletes cache entry
```

### Implementation

```python
# Writer service
def update_user(user_id, data):
    db.update(user_id, data)
    publish_event("cache.invalidate", {
        "key": f"user:{user_id}",
        "type": "delete"
    })

# Invalidator service
def consume_invalidation(event):
    if event["type"] == "delete":
        cache.delete(event["key"])
    elif event["type"] == "update":
        new_value = db.read(event["key"])
        cache.set(event["key"], new_value)
```

### Pros & Cons

```
Pros:
  + Decoupled invalidation
  + Reliable (message queue persistence)
  + Can batch invalidations
  + Works across services

Cons:
  + Additional latency (queue processing)
  + Message ordering challenges
  + Queue becomes critical path
  + More infrastructure
```

---

## Change Data Capture (CDC)

### How It Works

```
┌──────────┐     ┌───────────┐     ┌───────┐
│ Database │────►│ CDC Tool  │────►│ Cache │
│ (binlog) │     │ (Debezium)│     │       │
└──────────┘     └───────────┘     └───────┘

Database writes → Captured from transaction log
No application changes needed
```

### Benefits

```
1. No code changes in writers
2. Captures all changes (including manual DB updates)
3. Exactly-once semantics possible
4. Works retroactively
```

### Example: Debezium

```json
// CDC event from Debezium
{
  "op": "u",  // update
  "before": {"id": 123, "name": "Alice", "age": 30},
  "after": {"id": 123, "name": "Alice", "age": 31},
  "source": {
    "table": "users",
    "ts_ms": 1634567890123
  }
}

// Consumer updates cache
cache.set(f"user:{event['after']['id']}", event['after'])
```

---

## Version-Based Invalidation

### Cache Keys with Version

```python
# Global version for user data
USER_VERSION = get_current_version()  # e.g., from config or DB

def cache_key(user_id):
    return f"user:v{USER_VERSION}:{user_id}"

def read_user(user_id):
    return cache.get(cache_key(user_id))

# Invalidate all users: increment version
def invalidate_all_users():
    increment_version()  # All old keys now orphaned
```

### Per-Entity Version

```python
def cache_key(user_id, version):
    return f"user:{user_id}:v{version}"

def read_user(user_id):
    # Get current version from lightweight store
    version = version_store.get(f"user_version:{user_id}")
    return cache.get(cache_key(user_id, version))

def update_user(user_id, data):
    new_version = version_store.increment(f"user_version:{user_id}")
    db.update(user_id, data)
    cache.set(cache_key(user_id, new_version), data)
```

### Benefits

```
+ Instant invalidation (version change)
+ No need to enumerate cached items
+ Supports bulk invalidation
+ Old versions expire naturally (TTL)

- Version lookup overhead
- Cache memory wasted on old versions
```

---

## Tag-Based Invalidation

### Concept

```
Associate cache entries with tags
Invalidate by tag to remove related entries

cache.set("product:123", data, tags=["products", "category:electronics"])
cache.set("product:456", data, tags=["products", "category:electronics"])
cache.set("product:789", data, tags=["products", "category:clothing"])

# Invalidate all electronics
cache.invalidate_tag("category:electronics")
# Deletes: product:123, product:456
# Keeps: product:789
```

### Implementation

```python
class TaggedCache:
    def set(self, key, value, tags=[]):
        self.cache.set(key, value)
        for tag in tags:
            self.tag_store.sadd(f"tag:{tag}", key)
    
    def invalidate_tag(self, tag):
        keys = self.tag_store.smembers(f"tag:{tag}")
        for key in keys:
            self.cache.delete(key)
        self.tag_store.delete(f"tag:{tag}")
```

### Use Cases

```
E-commerce:
  Tag products with category, brand, seller
  Seller updates info → invalidate all their products

CMS:
  Tag pages with author, topic, template
  Template change → invalidate all pages using it
```

---

## Handling Invalidation Failures

### Retry Pattern

```python
def invalidate_with_retry(key, max_retries=3):
    for attempt in range(max_retries):
        try:
            cache.delete(key)
            return True
        except CacheError:
            if attempt < max_retries - 1:
                sleep(exponential_backoff(attempt))
    
    # Log failure, add to dead letter queue
    log_failed_invalidation(key)
    return False
```

### Graceful Degradation

```python
def update_user(user_id, data):
    # Database update is critical
    db.update(user_id, data)
    
    # Cache invalidation is best-effort
    try:
        cache.delete(f"user:{user_id}")
    except CacheError:
        # Log but don't fail the operation
        log.warn(f"Cache invalidation failed for user:{user_id}")
        # TTL will eventually expire the stale entry
```

### Consistency Levels

```
Level 1: Best effort (fire and forget)
  - Log failure
  - Rely on TTL

Level 2: Retry with backoff
  - Retry N times
  - Log persistent failures

Level 3: Guaranteed
  - Use transactions or queues
  - Never acknowledge write until cache invalidated
  - Much more complex
```

---

## Cache Dependencies

### The Problem

```
User profile caches:
  user:123 → {name, age, friends: [456, 789]}
  user:456 → {name, age, friends: [123]}
  user_friends:123 → [user:456, user:789]  # derived cache

When user:456 updates name:
  - user:456 invalidated ✓
  - user_friends:123 still has old data ✗
```

### Dependency Tracking

```python
class DependencyAwareCache:
    def __init__(self):
        self.dependencies = {}  # key → set of dependent keys
    
    def set_with_deps(self, key, value, depends_on=[]):
        self.cache.set(key, value)
        for dep in depends_on:
            self.dependencies.setdefault(dep, set()).add(key)
    
    def invalidate(self, key):
        # Delete the key
        self.cache.delete(key)
        
        # Invalidate dependents recursively
        dependents = self.dependencies.pop(key, set())
        for dep_key in dependents:
            self.invalidate(dep_key)
```

### Avoiding Deep Dependencies

```
Better approach: Denormalize and bound staleness

Instead of:
  user_friends:123 depends on user:456, user:789

Do:
  user_friends:123 = [{id: 456, name: "Bob"}, ...]
  TTL = 1 minute
  
Staleness bounded, no cascade invalidation
```

---

## Multi-Layer Cache Invalidation

### Challenge

```
Browser → CDN → App Cache → Database

All layers need invalidation!
```

### HTTP Cache Headers

```
Cache-Control: max-age=300  # Browser caches 5 min
ETag: "abc123"              # Version for revalidation

# On update:
# Return new ETag
# Client revalidates and gets new data
```

### CDN Invalidation

```python
def update_product(product_id, data):
    db.update(product_id, data)
    
    # Invalidate app cache
    app_cache.delete(f"product:{product_id}")
    
    # Invalidate CDN
    cdn.purge(f"/api/products/{product_id}")
    cdn.purge(f"/products/{product_id}.html")
```

### Invalidation Propagation

```
Order of invalidation matters:
  1. CDN (users hit this first)
  2. App cache (backend requests)
  3. Database cache (if any)

Or use versioned URLs:
  /products/123?v=abc123
  New version = new URL = cache miss everywhere
```

---

## Cache Invalidation at Scale

### Thundering Herd on Invalidation

When a popular cache key is invalidated, every concurrent request sees a cache miss and hits the database simultaneously.

```
Popular key "product:homepage-banner" invalidated
  → 10,000 requests/sec all miss cache
  → 10,000 concurrent DB queries → DB connection pool exhausted
```

Mitigations:

```
1. Staggered TTLs: base_ttl + random(0, base_ttl * 0.1)
2. Probabilistic early expiration: P(refresh) increases as TTL nears end
3. Lock-based cache rebuild: first request acquires lock, others wait
```

```python
def get_with_lock(key):
    value = cache.get(key)
    if value is not None:
        return value
    lock_key = f"lock:{key}"
    if cache.set(lock_key, "1", nx=True, ex=5):  # acquire lock
        value = db.query(key)
        cache.set(key, value, ex=300)
        cache.delete(lock_key)
        return value
    else:
        sleep(0.05)
        return cache.get(key)  # retry once
```

### Bulk Invalidation

```
Problem: invalidating all keys for user 123 requires enumerating them

Solution: version-based keys (v2:user:123:profile → v3:user:123:profile)
  Increment version → old keys are never read → expire via TTL
  O(1) invalidation, no enumeration, no multi-key delete
```

### Cross-Datacenter Invalidation

When a write lands in DC-A, the cache in DC-B remains stale until explicitly invalidated.

```
1. Pub/Sub invalidation bus (Kafka / Redis Pub/Sub)
   DC-A write → publish event → DC-B consumer deletes local cache
   Latency: 50-200ms cross-region. Message loss requires TTL fallback.

2. Bounded TTL with accepted staleness
   Set TTL low enough that staleness window is acceptable
   Simpler — no cross-DC messaging infrastructure needed

3. Lease-based invalidation
   Cache entry includes a lease token tied to the writer DC
   Remote DCs validate lease before serving cached data
```

### Facebook's Memcache Invalidation

Facebook's `mcsqueal` daemon tails the MySQL binlog and publishes invalidation events to regional Memcached clusters. Described in the TAO paper (USENIX ATC 2013), this handles billions of invalidations per day with no application-level invalidation logic. Key insight: the commit log is the single source of truth for what changed.

---

## CDC-Based Invalidation

### Pattern Overview

```
┌──────────┐     ┌───────────┐     ┌─────────┐     ┌──────────────┐
│ Database │────►│ Debezium  │────►│  Kafka   │────►│    Cache     │
│ (binlog) │     │ Connector │     │  Topic   │     │  Invalidator │
└──────────┘     └───────────┘     └─────────┘     └──────────────┘

1. Any process writes to database (app, migration, admin script)
2. Debezium captures the change from the transaction log
3. Change event published to Kafka topic (table-level or row-level)
4. Cache invalidator consumes event and deletes/updates cache entry
```

### Advantages Over Application-Level Invalidation

```
Application-level: only catches writes through app code, misses direct
DB updates/migrations/admin scripts, every writer must remember to invalidate

CDC-based: captures ALL changes regardless of source, zero app code changes
for new writers, single invalidation path — no duplication, no forgetting
```

### Ordering Guarantees

CDC events arrive in commit order within a single partition (table + primary key). This prevents the stale-after-fresh race condition.

```
Without ordering: T1 writes "Bob", T2 writes "Carol", T1's cache SET arrives last
  → cache holds "Bob" instead of "Carol"

With CDC ordering: events arrive in commit order
  → final cache state always reflects the latest write
  → use DELETE (not SET) for extra safety against reordering
```

### Latency Characteristics

Typical end-to-end: ~50-200ms (p50), ~200-500ms (p99). Breakdown: DB-to-binlog ~1ms, Debezium capture 10-50ms, Kafka publish+consume 20-100ms, cache delete 1-5ms.

### When to Use CDC-Based Invalidation

```
Good fit: multi-service writes to same DB, critical cache consistency
(financial/inventory), audit trail needed, legacy direct-DB access

Poor fit: simple single-service CRUD, DB without binlog/WAL access,
invalidation latency budget < 50ms
```

---

## Consistency Windows

### Definition

The consistency window is the time between a database write completing and the cache reflecting that write (`T_cache_updated - T_db_commit`). Any read during this window may return stale data.

### Sources of Inconsistency

```
1. TTL expiration delay:         window = 0 to full TTL
2. Invalidation propagation:     window = 50-500ms (event-driven)
3. Read-through race condition:  read caches pre-write value after write
4. Cross-DC replication lag:     window = 50-200ms cross-region
```

### Measuring Consistency

```
1. Sample comparison: periodically read N random keys from cache and DB,
   calculate staleness rate and duration

2. Invalidation lag tracking: timestamp DB commit and cache invalidation,
   track p50/p95/p99 of the delta

3. Cache miss rate analysis: lower-than-expected misses indicate stale
   data being served; unexpected misses indicate invalidation is working
```

### SLA Definition

```
Example: "Cache consistent within 500ms of DB write for 99.9% of keys"

Monitoring:
  - Alert if p99 invalidation lag > 1s
  - Alert if staleness sample check fails > 0.1% of keys
```

### Business Impact by Staleness Duration

```
Use Case          │  1s     │  5s      │  30s     │  5min
──────────────────┼─────────┼──────────┼──────────┼──────────
User profile      │ Fine    │ Fine     │ Fine     │ Acceptable
Inventory count   │ Risky   │ Oversell │ Oversell │ Dangerous
Product price     │ Fine    │ Risky    │ Wrong $  │ Wrong $
Session/auth      │ Fine    │ Fine     │ Security │ Security
Feature flags     │ Fine    │ Fine     │ Fine     │ Stale exp
Leaderboard       │ Fine    │ Fine     │ Fine     │ Fine
```

Choose TTL and invalidation strategy based on worst acceptable staleness per use case.

---

## Common Invalidation Bugs

### Race Condition: Stale Read After Write

```
Thread A (reader):          Thread B (writer):
  cache miss
  read DB → old value
                              write DB → new value
                              delete cache
  set cache → old value ← BUG: stale value cached after invalidation
```

Fix: always use bounded TTL. Use a short TTL on cache miss (e.g., 30s) and a longer TTL on explicit write-through (e.g., 300s). The race condition staleness is bounded to the short TTL.

### Delete vs Set-Empty

```
cache.delete("avatar:123")      → cache miss → DB query → correct but costly
cache.set("avatar:123", null)   → cache hit  → return null → fast but risky
```

Decision: if "not found" is a valid, common state (e.g., checking username availability), cache the null. If "not found" is rare or indicates a bug (e.g., user profile), delete the key and let the next read verify against DB.

### Cascading Invalidation: Forgetting Derived Caches

```
user:123 name changed "Alice" → "Bob"
  user:123            → invalidated ✓
  user:123:feed       → still shows "Alice posted..." ✗
  team:456:members    → still lists "Alice" ✗
```

Solutions: (1) tag-based invalidation — tag all derived caches with "user:123", single `invalidate_tag` clears them all; (2) explicit dependency registry mapping entity to derived keys; (3) short TTL on derived caches to bound staleness without cascade logic.

### Invalidation During Deployment

During rolling deploys, old and new code may write different cache formats. New code reading an old-format entry may hit missing fields.

```
Solutions:
  1. Versioned cache keys — old "v1:user:123", new "v2:user:123"
     Both coexist safely, old expires via TTL

  2. Cache flush on deploy — simple but causes cold-cache stampede
     Mitigate with cache warming (pre-populate critical keys)

  3. Backward-compatible serialization — handle missing fields with defaults
     Avoids the problem entirely but requires discipline
```

---

## Key Takeaways

1. **TTL is the safety net** - Bound staleness even when invalidation fails
2. **Delete is simpler than update** - Less chance of caching wrong data
3. **Event-driven scales better** - Decouple writers from cache
4. **CDC captures everything** - Including direct DB changes
5. **Version keys for bulk invalidation** - Instant, no enumeration
6. **Tags for related data** - Invalidate groups together
7. **Handle failures gracefully** - Cache is not critical path
8. **Beware dependencies** - Cascade invalidation is complex
