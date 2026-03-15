# Cache Stampede

## TL;DR

A cache stampede (thundering herd) occurs when many requests simultaneously try to repopulate an expired cache entry, overwhelming the database. Solutions include locking (only one request regenerates), probabilistic early expiration, and request coalescing. Prevention is critical for popular, expensive-to-compute cache entries.

---

## The Problem

### Normal Operation

```
Time 0: 1000 requests/sec, cache hit
  Cache: [user:123] → data (TTL: 5min remaining)
  Database: idle
  
All requests served from cache ✓
```

### Stampede Scenario

```
Time T: Cache entry expires
  Cache: [user:123] → MISS
  
  Request 1: Cache miss → Query DB
  Request 2: Cache miss → Query DB
  Request 3: Cache miss → Query DB
  ...
  Request 1000: Cache miss → Query DB

  Database: 1000 simultaneous queries!
  Response time: 10x slower or timeout
  Possible cascade failure
```

### Visualizing the Problem

```
Requests over time:
        
        │ Cache expires
        │     ↓
────────┼─────╱╲───────────
        │    ╱  ╲
        │   ╱    ╲
        │  ╱      ╲─────────
        │ ╱
────────┴─────────────────────
             │
        Stampede window
```

---

## Solution 1: Locking

### External Lock

```python
def get_with_lock(key):
    value = cache.get(key)
    if value:
        return value
    
    # Try to acquire lock
    lock_key = f"lock:{key}"
    if cache.set(lock_key, "1", nx=True, ex=30):
        try:
            # Won the lock - fetch from DB
            value = database.get(key)
            cache.set(key, value, ex=3600)
            return value
        finally:
            cache.delete(lock_key)
    else:
        # Another process is refreshing
        # Wait and retry
        sleep(0.1)
        return get_with_lock(key)  # Retry
```

### Problems with Simple Locking

```
1. Retry storms
   1000 requests waiting, all retry simultaneously

2. Lock expiration
   Lock expires before DB query completes
   
3. Deadlock potential
   Lock holder crashes without releasing
```

### Better Locking: Wait and Return Stale

```python
def get_with_stale_fallback(key):
    value, ttl = cache.get_with_ttl(key)
    
    if value and ttl > 0:
        return value  # Fresh data
    
    lock_key = f"lock:{key}"
    if cache.set(lock_key, "1", nx=True, ex=30):
        try:
            # Refresh in background
            value = database.get(key)
            cache.set(key, value, ex=3600)
        finally:
            cache.delete(lock_key)
    
    if value:
        return value  # Return stale data while refreshing
    
    # No stale data - must wait
    sleep(0.1)
    return cache.get(key)
```

---

## Solution 2: Probabilistic Early Expiration

### Concept

Randomly refresh before expiration, spreading the load.

```python
import random
import math

def should_recompute(key, ttl_remaining, beta=1):
    """
    XFetch algorithm:
    Probability of recompute increases as TTL decreases
    """
    if ttl_remaining <= 0:
        return True
    
    # Probability increases exponentially as TTL approaches 0
    expiry_gap = beta * math.log(random.random())
    return -expiry_gap >= ttl_remaining
```

### Implementation

```python
def get_with_probabilistic_refresh(key, compute_func, ttl=3600, beta=60):
    value, remaining_ttl = cache.get_with_ttl(key)
    
    if value is None or should_recompute(key, remaining_ttl, beta):
        # Recompute (either expired or probabilistically chosen)
        value = compute_func()
        cache.set(key, value, ex=ttl)
    
    return value
```

### Visualization

```
TTL timeline:
  |────────────────────────────────|
  Full TTL                         Expiry
  
Refresh probability:
  |░░░░░░░░░░░░░░░░░░░▓▓▓▓▓▓▓▓▓▓██|
  Low                    Medium   High
  
Some requests refresh early, spreading the load
```

---

## Solution 3: Request Coalescing

### Concept

Combine duplicate requests into one database query.

```
Before coalescing:
  Request 1 ─────► DB Query
  Request 2 ─────► DB Query
  Request 3 ─────► DB Query

After coalescing:
  Request 1 ─────┐
  Request 2 ─────┼─► DB Query ─► All requests
  Request 3 ─────┘
```

### Implementation

```python
import threading
from concurrent.futures import Future

class RequestCoalescer:
    def __init__(self):
        self.pending = {}  # key → Future
        self.lock = threading.Lock()
    
    def get(self, key, fetch_func):
        with self.lock:
            if key in self.pending:
                # Another request is fetching - wait for it
                return self.pending[key].result()
            
            # First request - create future
            future = Future()
            self.pending[key] = future
        
        try:
            # Fetch the data
            value = fetch_func(key)
            future.set_result(value)
            return value
        except Exception as e:
            future.set_exception(e)
            raise
        finally:
            with self.lock:
                del self.pending[key]

# Usage
coalescer = RequestCoalescer()

def get_user(user_id):
    cached = cache.get(f"user:{user_id}")
    if cached:
        return cached
    
    # Coalesce concurrent requests
    user = coalescer.get(
        f"user:{user_id}",
        lambda k: database.get_user(user_id)
    )
    
    cache.set(f"user:{user_id}", user)
    return user
```

### Go: singleflight

```go
import "golang.org/x/sync/singleflight"

var group singleflight.Group

func GetUser(userID string) (*User, error) {
    key := fmt.Sprintf("user:%s", userID)
    
    // Check cache
    if cached, ok := cache.Get(key); ok {
        return cached.(*User), nil
    }
    
    // Coalesce concurrent requests
    result, err, _ := group.Do(key, func() (interface{}, error) {
        user, err := database.GetUser(userID)
        if err != nil {
            return nil, err
        }
        cache.Set(key, user, time.Hour)
        return user, nil
    })
    
    if err != nil {
        return nil, err
    }
    return result.(*User), nil
}
```

---

## Solution 4: Background Refresh

### Concept

Never let cache expire. Refresh in background before expiration.

```python
import threading

def get_with_background_refresh(key, ttl=3600, refresh_threshold=300):
    value, remaining_ttl = cache.get_with_ttl(key)
    
    if value and remaining_ttl > refresh_threshold:
        return value  # Fresh enough
    
    if value and remaining_ttl > 0:
        # Getting stale - trigger background refresh
        trigger_background_refresh(key)
        return value  # Return current value
    
    # Expired or missing - must fetch synchronously
    value = database.get(key)
    cache.set(key, value, ex=ttl)
    return value

def trigger_background_refresh(key):
    # Non-blocking refresh
    def refresh():
        value = database.get(key)
        cache.set(key, value, ex=3600)
    
    thread = threading.Thread(target=refresh)
    thread.start()
```

### With Refresh Tokens

```python
def set_with_refresh(key, value, ttl=3600, refresh_at=300):
    """Store value with metadata for refresh"""
    data = {
        "value": value,
        "refresh_at": time.time() + ttl - refresh_at
    }
    cache.set(key, json.dumps(data), ex=ttl)

def get_with_refresh(key, fetch_func):
    raw = cache.get(key)
    if not raw:
        return fetch_sync(key, fetch_func)
    
    data = json.loads(raw)
    
    if time.time() > data["refresh_at"]:
        # Time to refresh in background
        trigger_async_refresh(key, fetch_func)
    
    return data["value"]
```

---

## Solution 5: Lease-Based Approach

### Concept

First requester gets a "lease" to refresh. Others wait or get stale data.

```python
def get_with_lease(key, stale_ttl=60):
    # Try to get current value
    value = cache.get(key)
    if value:
        return value
    
    # Try to acquire lease
    lease_key = f"lease:{key}"
    lease_acquired = cache.set(lease_key, "1", nx=True, ex=30)
    
    if lease_acquired:
        # We have the lease - refresh
        value = database.get(key)
        cache.set(key, value, ex=3600)
        cache.delete(lease_key)
        return value
    else:
        # Someone else is refreshing
        # Check for stale value
        stale_value = cache.get(f"stale:{key}")
        if stale_value:
            return stale_value
        
        # No stale value - wait briefly
        sleep(0.1)
        return cache.get(key)

# Keep stale copy for fallback
def set_with_stale(key, value, ttl=3600, stale_ttl=86400):
    cache.set(key, value, ex=ttl)
    cache.set(f"stale:{key}", value, ex=stale_ttl)
```

---

## Prevention Strategies

### Pre-warming

```python
def warm_cache_on_startup():
    """Pre-populate cache before taking traffic"""
    popular_keys = get_popular_keys()
    for key in popular_keys:
        value = database.get(key)
        cache.set(key, value, ex=3600)
    
    log.info(f"Warmed {len(popular_keys)} cache entries")
```

### Staggered TTLs

```python
import random

def set_with_jitter(key, value, base_ttl=3600, jitter_percent=10):
    """Add random jitter to prevent synchronized expiration"""
    jitter = base_ttl * jitter_percent / 100
    actual_ttl = base_ttl + random.uniform(-jitter, jitter)
    cache.set(key, value, ex=int(actual_ttl))

# Instead of all keys expiring at exactly 1 hour:
# Keys expire between 54 and 66 minutes
```

### Never-Expire with Async Refresh

```python
def setup_cache_refresh_worker():
    """Background worker that refreshes cache entries"""
    while True:
        # Get keys approaching expiration
        keys = get_keys_expiring_soon(threshold=300)
        
        for key in keys:
            try:
                value = database.get(key)
                cache.set(key, value, ex=3600)
            except Exception as e:
                log.error(f"Failed to refresh {key}: {e}")
        
        sleep(60)
```

---

## Comparison

| Solution | Complexity | Latency | DB Load | Stale Data |
|----------|------------|---------|---------|------------|
| Locking | Medium | Higher | Lowest | Possible |
| Probabilistic | Low | Normal | Low | No |
| Coalescing | Medium | Normal | Low | No |
| Background refresh | High | Lowest | Medium | Yes |
| Lease + stale | High | Low | Low | Yes |

---

## Probabilistic Early Expiration

### XFetch Algorithm Deep Dive

The XFetch algorithm, introduced by Vattani et al., prevents stampedes by probabilistically
recomputing cache entries before their TTL expires. The core insight: as a cached value
approaches expiration, individual requests independently decide whether to trigger a
recomputation, spreading the rebuild load across time rather than concentrating it at
the exact moment of expiry.

### The Formula

```
should_recompute = random() < (time_since_compute / ttl) ^ beta
```

- `time_since_compute`: elapsed time since the value was last computed
- `ttl`: total time-to-live for the cache entry
- `beta`: aggressiveness parameter (higher = earlier recomputation)

When `beta = 1`, the probability grows linearly. When `beta > 1`, recomputation
triggers earlier and more aggressively. When `beta < 1`, recomputation clusters
closer to the actual expiration time.

### Tuning Beta

```
beta = 0.5  → Conservative: recomputes very close to expiry
              Good for cheap queries, high-throughput keys

beta = 1.0  → Linear: balanced spread across the TTL window
              Default choice for most workloads

beta = 2.0  → Aggressive: starts recomputing well before expiry
              Use for expensive queries (>500ms) or extremely hot keys

beta = 3.0+ → Very aggressive: almost always recomputes in the last third of TTL
              Rarely needed; consider background refresh instead
```

### Why It Works

With 1000 requests/sec and a 1-hour TTL, the probability distribution ensures that
roughly one request triggers a recompute in the final few seconds before expiry.
The remaining 999 requests continue serving the cached value. No coordination,
no locks, no distributed state required — each node makes an independent local
decision.

### Caveats

- Does not guarantee exactly one recompute — under very high concurrency, two or
  three concurrent recomputes may still occur, but this is orders of magnitude
  better than 1000
- Requires the client to track when the value was originally computed (store
  `compute_time` alongside the cached value)
- Not effective if the cache entry is rarely accessed — the probabilistic trigger
  depends on request volume to fire at the right time

---

## Lock-Based Rebuild Patterns

### Mutex Pattern

The mutex pattern ensures exactly one request rebuilds the cache while all others
either wait or receive stale data. The first request to detect a cache miss acquires
a distributed lock, rebuilds, and releases the lock.

### Redis Distributed Mutex

```python
def rebuild_with_mutex(key, compute_func, ttl=3600):
    value = cache.get(key)
    if value is not None:
        return value

    lock_key = f"lock:{key}"
    # SET NX = set if not exists, EX = expiry in seconds
    # Lock TTL must exceed worst-case compute time
    acquired = redis.execute_command("SET", lock_key, "1", "NX", "EX", 5)

    if acquired:
        try:
            value = compute_func()
            cache.set(key, value, ex=ttl)
            return value
        finally:
            redis.delete(lock_key)
    else:
        # Lock held by another request — spin-wait with backoff
        for attempt in range(10):
            time.sleep(0.05 * (2 ** attempt))  # exponential backoff
            value = cache.get(key)
            if value is not None:
                return value
        raise TimeoutError(f"Cache rebuild timeout for {key}")
```

The `NX` flag is the critical piece — it provides atomic test-and-set semantics
across all application instances sharing the same Redis cluster.

### Stale-While-Revalidate

Instead of making waiters block, serve them the previous (stale) value while
exactly one request rebuilds in the background.

```python
def stale_while_revalidate(key, compute_func, ttl=3600, stale_ttl=86400):
    value = cache.get(key)
    stale_value = cache.get(f"stale:{key}")

    if value is not None:
        return value

    lock_key = f"lock:{key}"
    if redis.execute_command("SET", lock_key, "1", "NX", "EX", 5):
        # Rebuild asynchronously if we have stale data to serve
        if stale_value is not None:
            threading.Thread(target=_rebuild, args=(key, compute_func, ttl)).start()
            return stale_value
        # No stale data — must rebuild synchronously
        return _rebuild(key, compute_func, ttl)
    else:
        return stale_value  # Serve stale while another request rebuilds
```

### Pattern Comparison

| Aspect | Mutex | Stale-While-Revalidate | Probabilistic |
|--------|-------|------------------------|---------------|
| Coordination | Distributed lock | Distributed lock + stale store | None |
| Latency for waiters | Blocked until rebuild | Immediate (stale) | Immediate (cached) |
| Data freshness | Always fresh | Temporarily stale | Usually fresh |
| Infrastructure | Lock service required | Lock + dual-key storage | No extra infra |
| Failure mode | Lock expiry → brief stampede | Stale data served longer | Occasional double-compute |
| Best for | Low-traffic, freshness-critical | High-traffic, staleness-tolerant | High-traffic, stateless |

Choose mutex when data freshness is non-negotiable (e.g., account balance).
Choose stale-while-revalidate when low latency matters more than freshness
(e.g., product catalog, feed timeline). Choose probabilistic when you want
zero-coordination simplicity.

---

## Stampede in Practice

### Cold Start Stampede

Deploying a new service instance (or restarting after a crash) with an empty
local cache means every incoming request is a cache miss simultaneously.

```
Deploy new instance → 0 cached entries → 100% miss rate → DB overwhelmed

Timeline:
  t=0s   Instance joins load balancer
  t=0.1s 500 requests arrive, all miss cache
  t=0.2s Database connection pool exhausted
  t=1s   Cascading timeouts, health check fails
  t=5s   Instance removed from load balancer
```

**Mitigation: pre-warm before routing traffic.** Pull the top-N hot keys from
a sibling instance or a key registry. Only mark the instance as healthy after
the cache hit rate exceeds a threshold (e.g., 80%). Kubernetes: use a startup
probe that verifies cache readiness before the pod enters the Service endpoints.

### Celebrity Tweet Stampede

A celebrity with 50M followers posts a tweet. Followers' timeline caches all
reference this tweet. When the tweet object's cache entry expires (or is
invalidated due to an edit), millions of timeline renders simultaneously
request the same tweet from the database.

```
Celebrity tweets → 50M follower timelines reference tweet:12345
Cache TTL expires on tweet:12345
  → 200K concurrent cache misses across 40 app servers
  → Single DB row receives 200K reads in <1 second
  → Row-level lock contention, replication lag spikes
```

**Mitigation:** lease-based rebuild + stale-while-revalidate for any cache key
with an access frequency above a hotspot threshold. Twitter's approach: dedicated
hot-key caching layer that replicates popular objects to every app server's local
cache, bypassing the shared cache tier entirely.

### CDN Origin Stampede

A CDN cache purge (e.g., after deploying updated static assets) propagates to
all edge nodes simultaneously. Every edge node considers its cached copy invalid
and requests the origin server for the fresh version at the same instant.

```
Cache purge issued → 200 edge PoPs invalidate simultaneously
  → 200 concurrent requests to origin
  → Origin bandwidth saturated, 503 errors propagate to users
```

**Mitigation:** use request coalescing at the CDN layer (e.g., Cloudflare's
"request collapsing," Varnish's `grace` mode). Stagger purge propagation using
soft purges — mark content as stale rather than deleting, letting each edge
revalidate independently. Shield origin behind a mid-tier cache that absorbs
the collapsed request storm.

---

## Monitoring and Detection

### Key Metrics

Track these signals to detect a stampede before it cascades:

- **Cache miss rate spike**: a sudden jump in miss rate (e.g., from 2% to 40%
  within seconds) is the primary indicator
- **Database QPS correlation**: overlay DB query rate with cache TTL expiration
  events — synchronized spikes confirm stampede behavior
- **Lock contention rate**: if using mutex-based patterns, monitor lock acquisition
  failures as a proxy for concurrent rebuild attempts
- **p99 latency spike**: stampedes manifest as tail-latency explosions even if
  median latency stays stable

### Redis Diagnostics

```bash
# Real-time hit/miss ratio
redis-cli INFO stats | grep keyspace
# Output: keyspace_hits:1234567  keyspace_misses:8901

# Compute hit rate
# hit_rate = keyspace_hits / (keyspace_hits + keyspace_misses)
# Healthy: > 0.95 for hot keys
# Stampede signal: sudden drop below 0.80
```

### Alerting Rules

```yaml
# Prometheus alert example
- alert: CacheStampedeDetected
  expr: |
    rate(cache_misses_total[1m]) > 2 * avg_over_time(rate(cache_misses_total[1m])[1h:1m])
  for: 30s
  labels:
    severity: warning
  annotations:
    summary: "Cache miss rate >2x baseline for 30s — potential stampede"
```

The `for: 30s` clause avoids false positives from brief, benign miss spikes
(e.g., a single key expiring). If the alert fires, cross-reference with DB load
and identify which keys are missing by sampling `RANDOMKEY` or enabling key-level
miss tracking.

### Dashboard Layout

Overlay these four panels on a single time-axis dashboard:

1. **Cache hit rate** (target: >95%) — primary health indicator
2. **DB QPS** — should be flat; spikes correlate with stampede
3. **Cache TTL expiration histogram** — shows when keys are scheduled to expire;
   clustered expirations reveal jitter misconfiguration
4. **Lock acquisition rate** (if using mutex pattern) — spikes indicate concurrent
   rebuild contention

When a stampede occurs, panels 1 and 2 will mirror each other inversely: hit
rate drops as DB QPS spikes. Panel 3 reveals whether the root cause is
synchronized TTL expiration, and panel 4 confirms whether the locking layer
is absorbing the load or being overwhelmed.

---

## Key Takeaways

1. **Stampedes kill databases** - A single popular key can cause outage
2. **Locking prevents redundant queries** - But adds latency
3. **Probabilistic refresh spreads load** - Simple and effective
4. **Coalescing combines requests** - Best for concurrent requests
5. **Background refresh keeps cache warm** - Never truly expire
6. **Stale data is often acceptable** - Serve old data while refreshing
7. **Stagger TTLs** - Prevent synchronized expiration
8. **Pre-warm critical keys** - Don't start cold
