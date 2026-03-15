# Cache Warming

## TL;DR

Cache warming pre-populates cache before traffic arrives, avoiding cold-start latency and stampedes. Strategies include startup warming, scheduled warming, and event-driven warming. Identify hot keys through analytics, access logs, or predictive models. Balance warming time against data freshness and resource usage.

---

## The Cold Cache Problem

### Symptoms

```
Scenario: Deploy new cache node or restart

Before restart:
  Cache hit rate: 95%
  DB load: 500 QPS
  Latency p99: 50ms

After restart (cold cache):
  Cache hit rate: 0%
  DB load: 10,000 QPS (20x!)
  Latency p99: 500ms (10x worse)
  
Time to recover: Minutes to hours
```

### When Cold Cache Happens

```
1. Cache node restart
2. Cache cluster expansion
3. Application deployment
4. Data center failover
5. Cache eviction (memory pressure)
6. First deployment of new feature
```

---

## Warming Strategies

### Strategy 1: Startup Warming

```python
def warm_cache_on_startup():
    """Block startup until cache is warm"""
    log.info("Starting cache warm-up...")
    
    # Get popular keys from analytics
    hot_keys = get_hot_keys_from_analytics()
    
    for key in hot_keys:
        try:
            value = database.get(key)
            cache.set(key, value, ex=3600)
        except Exception as e:
            log.warn(f"Failed to warm {key}: {e}")
    
    log.info(f"Warmed {len(hot_keys)} keys")

# In application startup
warm_cache_on_startup()
register_for_traffic()  # Only after warming
```

### Strategy 2: Shadow Traffic

```
Route portion of traffic through new cache without serving response

                      ┌─────────────┐
                 ┌───►│ Old Cache   │────► Response
                 │    └─────────────┘
    ┌────────┐   │
    │  LB    │───┤
    └────────┘   │    ┌─────────────┐
                 └───►│ New Cache   │────► Discard
                      │  (warming)  │
                      └─────────────┘

New cache sees real traffic patterns
Populates naturally before taking real traffic
```

### Strategy 3: Replay Access Logs

```python
def warm_from_access_log(log_file, sample_rate=0.1):
    """Replay recent access patterns"""
    with open(log_file) as f:
        for line in f:
            if random.random() > sample_rate:
                continue
            
            request = parse_log_line(line)
            key = extract_cache_key(request)
            
            # Simulate the cache lookup
            if not cache.exists(key):
                value = database.get(key)
                cache.set(key, value)

# Warm from last hour's logs
warm_from_access_log("/var/log/access.log")
```

### Strategy 4: Database Dump

```python
def warm_from_database():
    """Bulk load frequently accessed records"""
    
    # Load by access count or recency
    popular_users = database.query("""
        SELECT * FROM users 
        ORDER BY access_count DESC 
        LIMIT 100000
    """)
    
    pipe = cache.pipeline()
    for user in popular_users:
        pipe.set(f"user:{user.id}", serialize(user), ex=3600)
    
    pipe.execute()  # Batch write
```

---

## Identifying Hot Keys

### Analytics-Based

```python
def get_hot_keys_from_analytics():
    """Use historical data to find popular items"""
    return analytics.query("""
        SELECT cache_key, access_count
        FROM cache_access_log
        WHERE timestamp > NOW() - INTERVAL '24 hours'
        GROUP BY cache_key
        ORDER BY access_count DESC
        LIMIT 50000
    """)
```

### Sampling Current Traffic

```python
class HotKeyTracker:
    def __init__(self, sample_rate=0.01):
        self.sample_rate = sample_rate
        self.counts = Counter()
    
    def track(self, key):
        if random.random() < self.sample_rate:
            self.counts[key] += 1
    
    def get_hot_keys(self, n=10000):
        # Scale up sampled counts
        scaled = {k: v / self.sample_rate 
                  for k, v in self.counts.items()}
        return sorted(scaled, key=scaled.get, reverse=True)[:n]
```

### Predictive Warming

```python
def predictive_warm():
    """Warm based on predicted future access"""
    
    # New product launch tomorrow
    products = database.query("""
        SELECT * FROM products 
        WHERE launch_date = CURRENT_DATE + 1
    """)
    
    for product in products:
        cache.set(f"product:{product.id}", serialize(product))
    
    # Trending items
    trending = get_trending_items()
    for item in trending:
        cache.set(f"item:{item.id}", serialize(item))
```

---

## Scheduled Warming

### Cron-Based

```python
# Run every hour, before peak traffic
@scheduled(cron="0 * * * *")
def hourly_cache_refresh():
    hot_keys = get_hot_keys()
    
    for key in hot_keys:
        # Refresh even if exists (prevent expiration)
        value = database.get(key)
        cache.set(key, value, ex=3600)
```

### Event-Driven

```python
# Warm when data changes
@on_event("product.updated")
def warm_product_cache(event):
    product_id = event.data["product_id"]
    product = database.get_product(product_id)
    
    # Update cache immediately
    cache.set(f"product:{product_id}", serialize(product))
    
    # Also warm related caches
    category = product.category
    cache.delete(f"category:{category}:products")
    warm_category_cache(category)
```

### Pre-Compute Before Peak

```python
# Before Black Friday
def pre_warm_for_sale():
    # Get all sale items
    sale_items = database.query("""
        SELECT * FROM products WHERE on_sale = true
    """)
    
    pipe = cache.pipeline()
    for item in sale_items:
        # Pre-compute views, aggregations
        pipe.set(f"product:{item.id}", serialize(item))
        pipe.set(f"product:{item.id}:reviews", get_top_reviews(item.id))
        pipe.set(f"product:{item.id}:inventory", get_inventory(item.id))
    
    pipe.execute()
    log.info(f"Warmed {len(sale_items)} sale items")
```

---

## Warming Techniques

### Parallel Warming

```python
from concurrent.futures import ThreadPoolExecutor

def parallel_warm(keys, workers=10):
    """Warm keys in parallel"""
    
    def warm_key(key):
        try:
            value = database.get(key)
            cache.set(key, value, ex=3600)
            return True
        except:
            return False
    
    with ThreadPoolExecutor(max_workers=workers) as executor:
        results = list(executor.map(warm_key, keys))
    
    success = sum(results)
    log.info(f"Warmed {success}/{len(keys)} keys")
```

### Batch Loading

```python
def batch_warm(keys, batch_size=1000):
    """Load from DB in batches"""
    
    for i in range(0, len(keys), batch_size):
        batch = keys[i:i + batch_size]
        
        # Batch DB query
        values = database.multi_get(batch)
        
        # Batch cache write
        pipe = cache.pipeline()
        for key, value in zip(batch, values):
            if value:
                pipe.set(key, serialize(value), ex=3600)
        pipe.execute()
        
        log.info(f"Warmed batch {i//batch_size + 1}")
```

### Rate-Limited Warming

```python
from ratelimit import limits

@limits(calls=1000, period=1)  # 1000 keys/second max
def rate_limited_warm(key):
    value = database.get(key)
    cache.set(key, value)

def gentle_warm(keys):
    """Warm without overloading database"""
    for key in keys:
        try:
            rate_limited_warm(key)
        except RateLimitExceeded:
            time.sleep(0.1)
```

---

## Warming on Node Addition

### Consistent Hashing Advantage

```
With consistent hashing:
  New node takes ~1/N of keyspace
  Only those keys need warming
  
Without:
  All keys potentially rehash
  Much larger warming scope
```

### Copy from Peers

```python
def warm_new_node(new_node, existing_nodes):
    """Copy relevant keys from existing nodes"""
    
    # Find keys that should be on new node
    for key in scan_all_keys():
        target = consistent_hash(key)
        
        if target == new_node:
            # This key should be on new node
            value = get_from_any_replica(key, existing_nodes)
            new_node.set(key, value)
```

### Gradual Traffic Shift

```
Phase 1: 10% traffic to new node, monitor
Phase 2: 25% traffic, cache warming
Phase 3: 50% traffic
Phase 4: 100% traffic

At each phase:
  - Monitor hit rate
  - Monitor latency
  - Pause if issues
```

---

## Warming Best Practices

### Don't Block Too Long

```python
def startup_with_timeout():
    """Limit warming time"""
    start = time.time()
    max_warm_time = 60  # seconds
    
    hot_keys = get_hot_keys()
    warmed = 0
    
    for key in hot_keys:
        if time.time() - start > max_warm_time:
            log.warn(f"Warming timeout, {warmed}/{len(hot_keys)} warmed")
            break
        
        cache.set(key, database.get(key))
        warmed += 1
    
    # Start accepting traffic even if not fully warm
```

### Prioritize by Impact

```python
def prioritized_warm():
    """Warm most important keys first"""
    
    # Tier 1: Core user paths (must warm)
    core_keys = get_core_keys()  # Login, checkout, etc.
    warm_keys(core_keys)
    
    # Tier 2: Popular content (should warm)
    if time_remaining():
        popular = get_popular_keys()
        warm_keys(popular)
    
    # Tier 3: Nice to have
    if time_remaining():
        other = get_other_keys()
        warm_keys(other)
```

### Monitor Warming Progress

```python
class WarmingMetrics:
    def __init__(self):
        self.start_time = time.time()
        self.keys_targeted = 0
        self.keys_warmed = 0
        self.errors = 0
    
    def report(self):
        elapsed = time.time() - self.start_time
        rate = self.keys_warmed / elapsed if elapsed > 0 else 0
        
        metrics.gauge("warming.progress", 
                     self.keys_warmed / self.keys_targeted)
        metrics.gauge("warming.rate", rate)
        metrics.gauge("warming.errors", self.errors)
```

---

## Deployment Warming Strategies

### Blue-Green with Warm Cache

```
Standard blue-green has a cold cache problem — green is idle with empty cache.

Solution: warm green before switching traffic

  Phase 1: Deploy new code to green
  Phase 2: Run warming job against green's cache
  Phase 3: Verify green cache hit rate > threshold (e.g. 90%)
  Phase 4: Switch LB to green
  Phase 5: Keep blue as fallback until green is confirmed stable
```

```python
def blue_green_warm_and_switch(green_env):
    """Warm green cache before cutting over traffic"""
    hot_keys = get_hot_keys_from_analytics()
    warm_keys_on_target(green_env.cache, hot_keys)

    hit_rate = measure_hit_rate(green_env.cache, sample_keys=hot_keys[:1000])
    if hit_rate < 0.90:
        raise WarmingIncompleteError(f"Green hit rate {hit_rate:.0%}, aborting switch")

    load_balancer.switch_to(green_env)
    log.info(f"Switched to green, hit rate {hit_rate:.0%}")
```

### Canary Warming

```
Route a small slice of traffic to warm cache organically:

  1% → 5% → 25% → 50% → 100%

Monitor hit rate at each phase before ramping up.
Rollback if hit rate does not converge within expected window.
```

### Rolling Deploy Challenge

```
Rolling deploys replace instances one at a time.
Each new instance starts with an empty local cache.

Problem:
  Instance 1 replaced → cold, other 9 absorb load
  Instance 2 replaced → cold, 8 warm + 2 cold
  ...by instance 5, half the fleet is still cold

Solutions:
  1. Access log replay — feed last 24h logs to new instance before it joins LB
  2. Cache snapshot transfer — DUMP old instance cache, RESTORE on new one
  3. Shared cache layer — only L1 (in-process) cache needs re-warming
```

---

## Cache Warming Infrastructure

### Access Log Replay Pipeline

```python
def warm_from_access_logs(hours=24):
    """Analyze recent access logs, extract unique keys, pre-populate cache"""
    cutoff = datetime.utcnow() - timedelta(hours=hours)
    raw_keys = [
        derive_cache_key(e.method, e.path, e.params)
        for e in parse_access_logs(since=cutoff)
    ]
    unique_keys = list(dict.fromkeys(k for k in raw_keys if k))  # dedup, preserve order
    log.info(f"Extracted {len(unique_keys)} unique keys from {hours}h of logs")
    batch_warm(unique_keys)
```

### Redis DUMP/RESTORE for Cache Migration

```python
def migrate_cache(source_redis, target_redis, keys):
    """Transfer cache entries between Redis instances via DUMP/RESTORE"""
    migrated = 0
    for key in keys:
        ttl = source_redis.pttl(key)
        if ttl < 0:
            continue
        dump = source_redis.dump(key)
        if dump:
            target_redis.restore(key, ttl, dump, replace=True)
            migrated += 1
    log.info(f"Migrated {migrated}/{len(keys)} keys")
```

### Kafka Consumer Lag as Warming Indicator

```
In event-sourced / CQRS systems, read-model caches are built from event streams.

  Lag > 0  → projections not caught up → cache still cold
  Lag = 0  → projections current       → read model cache is warm

Use consumer lag as a readiness gate:
  - New instance replays from last checkpoint
  - Reports NOT READY until lag = 0
  - Load balancer only routes traffic once ready
```

---

## Warming at Scale

### Warming Rate Limiting

```python
class TokenBucketWarmer:
    """Control warm-up QPS to avoid hammering the database"""

    def __init__(self, max_qps=500, burst=50):
        self.max_qps = max_qps
        self.tokens = burst
        self.last_refill = time.monotonic()

    def _refill(self):
        now = time.monotonic()
        self.tokens = min(burst, self.tokens + (now - self.last_refill) * self.max_qps)
        self.last_refill = now

    def warm_key(self, key):
        self._refill()
        if self.tokens < 1:
            time.sleep(1.0 / self.max_qps)
            self._refill()
        self.tokens -= 1
        value = database.get(key)
        cache.set(key, value, ex=3600)
```

### Priority Warming

```
Not all keys deserve equal warming priority (Pareto distribution):

  Top 1%  keys → ~40% of requests  ← warm first
  Top 5%  keys → ~70% of requests  ← warm second
  Top 20% keys → ~95% of requests  ← warm third
  Remaining 80%  → 5% of requests  ← skip, lazy fill on miss
```

```python
def priority_warm(tiers):
    """Warm keys in priority order: hot first, long-tail last"""
    warmer = TokenBucketWarmer(max_qps=1000)
    for tier_name, keys in tiers:
        log.info(f"Warming tier={tier_name}, keys={len(keys)}")
        for key in keys:
            warmer.warm_key(key)

# Usage: warm top 1% first, then 5%, then 20%. Skip the remaining 80%.
tiers = [
    ("critical", get_top_percent_keys(1)),
    ("hot",      get_top_percent_keys(5)),
    ("warm",     get_top_percent_keys(20)),
]
priority_warm(tiers)
```

### Partial Warming

```
Full warming may be impractical at scale (50M keys = 90 min).
Top 20% of keys covers ~95% of traffic and takes only 18 min.

Strategy: warm top 20% proactively, let remaining 80% populate lazily on miss.
Use shorter TTL on lazily-warmed keys to avoid stale long-tail data.
```

---

## Monitoring Cache Temperature

### Hit Rate as Temperature Indicator

```
Temperature zones (per-instance hit rate):

  > 95%  │ HOT   │ Cache fully effective, normal operation
  80-95% │ WARM  │ Acceptable, still converging after deploy
  < 80%  │ COLD  │ Significant DB pressure, may need intervention

Track per service instance — new instances will be colder than old ones.
A fleet-wide average can mask a single cold instance causing DB spikes.
```

### Warming Completion Metric

```python
def measure_warming_completeness(expected_keys, cache):
    """Calculate what % of expected keys are present in cache"""
    sample = random.sample(expected_keys, min(1000, len(expected_keys)))
    present = sum(1 for k in sample if cache.exists(k))
    completeness = present / len(sample)

    metrics.gauge("warming.completeness", completeness)
    return completeness
```

### Alerting on Failed Warming

```yaml
# Prometheus alerting rule
- alert: CacheWarmingStalled
  expr: |
    cache_hit_rate{instance=~".*-new-.*"} < 0.80
    and on(instance) (time() - instance_start_time) > 300
  for: 1m
  labels:
    severity: warning
  annotations:
    summary: "Instance {{ $labels.instance }} hit rate < 80% after 5 min — warming may have failed"
```

```
Playbook when alert fires:
  1. Check warming job logs for errors (DB timeouts, key fetch failures)
  2. Verify DB is not overloaded — reduce warming QPS if needed
  3. Restart warming job if it crashed
  4. Last resort: pull instance from LB until hit rate recovers
```

---

## Key Takeaways

1. **Cold cache causes cascading failures** - Database can't handle sudden load
2. **Warm before taking traffic** - Block or use gradual rollout
3. **Know your hot keys** - Analytics, sampling, or prediction
4. **Parallel + batched is efficient** - But rate limit to protect DB
5. **Prioritize by importance** - Critical paths first
6. **Time-bound warming** - Don't block forever
7. **Consistent hashing helps** - Minimize warming on scale events
8. **Monitor progress** - Know when warming is complete
