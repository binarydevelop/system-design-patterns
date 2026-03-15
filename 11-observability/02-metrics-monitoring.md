# Metrics and Monitoring

## TL;DR

Metrics are numerical measurements collected over time. They answer "what is happening?" through aggregated data, unlike logs (what happened?) and traces (how did it flow?). The RED method (Rate, Errors, Duration) and USE method (Utilization, Saturation, Errors) provide frameworks for comprehensive monitoring.

---

## Metrics vs. Logs vs. Traces

```
                    Metrics              Logs                 Traces
─────────────────────────────────────────────────────────────────────────
Question            What's happening?    What happened?       How did it flow?
Data type           Numbers              Text                 Spans
Cardinality         Low                  High                 Medium
Storage cost        Low                  High                 Medium
Query pattern       Aggregate            Search               Lookup by ID
Example             error_rate=0.02      "User 123 failed"    Request path

Use when you need:
- Alerting          ✓ Primary           Sometimes            Rarely
- Dashboards        ✓ Primary           Sometimes            ✓
- Debugging         Sometimes            ✓ Primary           ✓ Primary
- Capacity          ✓ Primary           Rarely               Sometimes
```

---

## Metric Types

### Counter

Cumulative value that only increases (or resets to zero).

```
http_requests_total

Time:    T0      T1      T2      T3      T4
Value:   100     150     225     310     400
Delta:   -       +50     +75     +85     +90

Use for:
- Request counts
- Bytes transferred
- Tasks completed
- Errors occurred
```

```
# TYPE http_requests_total counter
# HELP http_requests_total Total HTTP requests.
http_requests_total{method="GET",endpoint="/api/users",status="200"} 1027
http_requests_total{method="POST",endpoint="/api/orders",status="201"} 563
http_requests_total{method="GET",endpoint="/api/users",status="500"} 12
```

### Gauge

Value that can go up or down.

```
active_connections

Time:    T0      T1      T2      T3      T4
Value:   10      25      15      30      20

Use for:
- Current connections
- Queue depth
- Temperature
- Memory usage
- Active users
```

```
# TYPE active_connections gauge
# HELP active_connections Current active connections.
active_connections{service="api"} 42
active_connections{service="worker"} 17
```

### Histogram

Distribution of values across configurable buckets.

```
http_request_duration_seconds

Buckets: [0.01, 0.05, 0.1, 0.5, 1.0, 5.0, +Inf]

Observations: 0.02, 0.03, 0.08, 0.15, 0.5, 2.0, 0.04

Bucket counts:
  le="0.01":  0
  le="0.05":  3  (0.02, 0.03, 0.04)
  le="0.1":   4  (+ 0.08)
  le="0.5":   6  (+ 0.15, 0.5)
  le="1.0":   6
  le="5.0":   7  (+ 2.0)
  le="+Inf":  7

Enables:
- Percentile calculation (p50, p95, p99)
- Distribution analysis
- SLO tracking
```

```
# TYPE http_request_duration_seconds histogram
# HELP http_request_duration_seconds HTTP request duration in seconds.
http_request_duration_seconds_bucket{method="GET",endpoint="/api",le="0.01"} 0
http_request_duration_seconds_bucket{method="GET",endpoint="/api",le="0.05"} 3
http_request_duration_seconds_bucket{method="GET",endpoint="/api",le="0.1"} 4
http_request_duration_seconds_bucket{method="GET",endpoint="/api",le="0.5"} 6
http_request_duration_seconds_bucket{method="GET",endpoint="/api",le="1.0"} 6
http_request_duration_seconds_bucket{method="GET",endpoint="/api",le="5.0"} 7
http_request_duration_seconds_bucket{method="GET",endpoint="/api",le="+Inf"} 7
http_request_duration_seconds_sum{method="GET",endpoint="/api"} 2.82
http_request_duration_seconds_count{method="GET",endpoint="/api"} 7
```

### Summary

Similar to histogram but calculates quantiles client-side.

```
# TYPE http_request_duration_seconds summary
# HELP http_request_duration_seconds HTTP request duration.
http_request_duration_seconds{method="GET",quantile="0.5"} 0.042
http_request_duration_seconds{method="GET",quantile="0.9"} 0.15
http_request_duration_seconds{method="GET",quantile="0.99"} 0.48
http_request_duration_seconds_sum{method="GET"} 8734.29
http_request_duration_seconds_count{method="GET"} 51432
```

**Histogram vs. Summary:**

| Aspect | Histogram | Summary |
|--------|-----------|---------|
| Aggregation | ✓ Can aggregate | ✗ Cannot aggregate |
| Quantile accuracy | Approximate | Exact |
| Server load | Lower | Higher |
| Bucket config | Must pre-define | N/A |
| Recommendation | Use histogram | Rarely needed |

---

## Naming Conventions

### Prometheus Naming Best Practices

```
Format: <namespace>_<subsystem>_<name>_<unit>

GOOD:
  http_requests_total                    # Counter — use _total suffix
  http_request_duration_seconds          # Histogram — base unit (seconds, not ms)
  process_memory_bytes                   # Gauge — base unit (bytes, not MB)
  database_connections_active            # Gauge

BAD:
  requests                               # Too vague
  http_requests_count                    # Use _total for counters
  requestDurationMilliseconds            # Wrong format, wrong unit
  HttpRequestDuration                    # Wrong case
```

### Label Best Practices

```
GOOD — low cardinality:
  http_requests_total{method="GET", status="200", endpoint="/api/users"}

BAD — high cardinality (unbounded):
  http_requests_total{user_id="12345"}   # Millions of unique values!
  http_requests_total{request_id="..."}  # Unique per request!

Rule of thumb:
  Unique label combinations < 10,000
  Each label value should have < 100 unique values
```

---

## RED Method (Request-Driven)

For services (APIs, microservices):

```
R - Rate:     Request throughput (requests/second)
E - Errors:   Failed requests (count or rate)
D - Duration: Response time distribution

Dashboard Layout:
┌─────────────────────────────────────────────────────────────┐
│  Service: user-api                                          │
│                                                             │
│  ┌─────────────────┐ ┌─────────────────┐ ┌───────────────┐ │
│  │ Request Rate    │ │ Error Rate      │ │ Latency p99   │ │
│  │     523/s       │ │     0.02%       │ │     245ms     │ │
│  │     ↑ 12%       │ │     ↓ 50%       │ │     ↑ 15%     │ │
│  └─────────────────┘ └─────────────────┘ └───────────────┘ │
│                                                             │
│  [Request Rate Over Time Graph]                             │
│  [Latency Distribution Heatmap]                             │
│  [Error Rate by Endpoint]                                   │
└─────────────────────────────────────────────────────────────┘
```

### Prometheus Queries (PromQL)

```text
# Rate: Requests per second
rate(http_requests_total[5m])

# Rate by endpoint
sum by (endpoint) (rate(http_requests_total[5m]))

# Errors: Error rate percentage
sum(rate(http_requests_total{status=~"5.."}[5m])) 
/ 
sum(rate(http_requests_total[5m])) * 100

# Duration: p99 latency
histogram_quantile(0.99, 
  sum by (le) (rate(http_request_duration_seconds_bucket[5m]))
)

# Duration: Average latency
sum(rate(http_request_duration_seconds_sum[5m])) 
/ 
sum(rate(http_request_duration_seconds_count[5m]))
```

---

## USE Method (Resource-Oriented)

For resources (CPU, memory, disk, network):

```
U - Utilization: Percentage of resource capacity in use
S - Saturation:  Degree of queuing/backlog
E - Errors:      Error events

Resource Analysis:
┌──────────────┬─────────────────┬─────────────────┬─────────────────┐
│   Resource   │   Utilization   │   Saturation    │     Errors      │
├──────────────┼─────────────────┼─────────────────┼─────────────────┤
│ CPU          │ % busy          │ Run queue depth │ -               │
│ Memory       │ % used          │ Swap usage      │ OOM kills       │
│ Disk I/O     │ % time busy     │ Queue length    │ I/O errors      │
│ Network      │ % bandwidth     │ Socket backlog  │ Packet errors   │
│ Connection   │ % pool used     │ Wait queue      │ Timeouts        │
└──────────────┴─────────────────┴─────────────────┴─────────────────┘
```

### Key Resource Metrics

```text
# CPU
# Utilization: CPU usage percentage
100 - (avg by (instance) (rate(node_cpu_seconds_total{mode="idle"}[5m])) * 100)

# Saturation: Load average / CPU count
node_load1 / count by (instance) (node_cpu_seconds_total{mode="idle"})

# Memory
# Utilization
(1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes) * 100

# Saturation (swap usage indicates memory pressure)
node_memory_SwapTotal_bytes - node_memory_SwapFree_bytes

# Disk
# Utilization
rate(node_disk_io_time_seconds_total[5m]) * 100

# Saturation
node_disk_io_time_weighted_seconds_total

# Network
# Utilization (requires knowing interface speed)
rate(node_network_receive_bytes_total[5m]) * 8 / 1e9  # Gbps
```

---

## Golden Signals (Google SRE)

```
Latency:     Time to service a request (successful vs. failed)
Traffic:     Demand on your system (requests/sec, transactions/sec)
Errors:      Rate of failed requests
Saturation:  How "full" your service is (capacity utilization)

Relationship to RED/USE:
├── Latency   ≈ RED Duration
├── Traffic   ≈ RED Rate
├── Errors    ≈ RED Errors / USE Errors
└── Saturation ≈ USE Saturation
```

---

## Instrumentation Patterns

### Go Instrumentation Example

```go
package main

import (
	"net/http"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/metric"
)

var meter = otel.Meter("api-server")

var (
	requestCount, _    = meter.Int64Counter("http_requests_total",
		metric.WithDescription("Total HTTP requests"))
	requestDuration, _ = meter.Float64Histogram("http_request_duration_seconds",
		metric.WithDescription("HTTP request duration in seconds"))
	inFlight, _        = meter.Int64UpDownCounter("http_requests_in_progress",
		metric.WithDescription("Requests currently being processed"))
)

func metricsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		attrs := metric.WithAttributes(
			attribute.String("method", r.Method),
			attribute.String("endpoint", r.URL.Path),
		)
		inFlight.Add(r.Context(), 1, attrs)
		start := time.Now()

		rw := &responseWriter{ResponseWriter: w, statusCode: http.StatusOK}
		next.ServeHTTP(rw, r)

		duration := time.Since(start).Seconds()
		requestCount.Add(r.Context(), 1, metric.WithAttributes(
			attribute.String("method", r.Method),
			attribute.String("endpoint", r.URL.Path),
			attribute.Int("status", rw.statusCode),
		))
		requestDuration.Record(r.Context(), duration, attrs)
		inFlight.Add(r.Context(), -1, attrs)
	})
}
```

### OpenTelemetry Collector Pipeline (Metrics)

```yaml
# otel-collector-config.yaml
receivers:
  prometheus:
    config:
      scrape_configs:
        - job_name: "api-server"
          scrape_interval: 15s
          static_configs:
            - targets: ["api:8080"]
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317

processors:
  batch:
    timeout: 5s
    send_batch_size: 1024
  memory_limiter:
    check_interval: 1s
    limit_mib: 512

exporters:
  prometheusremotewrite:
    endpoint: "http://mimir:9009/api/v1/push"
  prometheus:
    endpoint: 0.0.0.0:8889

service:
  pipelines:
    metrics:
      receivers: [otlp, prometheus]
      processors: [memory_limiter, batch]
      exporters: [prometheusremotewrite, prometheus]
```

### Business Metrics

```
# TYPE orders_total counter
# HELP orders_total Total orders processed.
orders_total{status="completed",payment_method="credit_card"} 4521
orders_total{status="completed",payment_method="paypal"} 1203
orders_total{status="refunded",payment_method="credit_card"} 47

# TYPE order_value_dollars histogram
# HELP order_value_dollars Order value in dollars.
order_value_dollars_bucket{le="50"} 1200
order_value_dollars_bucket{le="100"} 3100
order_value_dollars_bucket{le="500"} 5400
order_value_dollars_bucket{le="+Inf"} 5771

# TYPE active_users gauge
# HELP active_users Currently active users.
active_users 342
```

---

## Alerting

### Alert Design Principles

```yaml
# Good alert characteristics:
# - Actionable: Someone needs to do something
# - Relevant: Indicates real user impact
# - Specific: Clear what's wrong
# - Timely: Neither too sensitive nor too delayed

# BAD: Alert on symptoms of normal operation
- alert: HighCPU
  expr: cpu_usage > 70    # Normal for busy server

# GOOD: Alert on user-facing impact
- alert: HighErrorRate
  expr: |
    sum(rate(http_requests_total{status=~"5.."}[5m])) 
    / sum(rate(http_requests_total[5m])) > 0.01
  for: 5m
  labels:
    severity: critical
  annotations:
    summary: "High error rate (> 1%)"
    description: "Error rate is {{ $value | humanizePercentage }}"
```

### SLO-Based Alerting

```yaml
# Alert when burning through error budget too fast

# SLO: 99.9% availability = 0.1% error budget
# 30-day budget = 43.2 minutes of errors

# Multi-window, multi-burn-rate alerting
groups:
- name: slo-alerts
  rules:
  # Fast burn: 14.4x burn rate for 1 hour = 2% of monthly budget
  - alert: HighBurnRate_Fast
    expr: |
      (
        sum(rate(http_requests_total{status=~"5.."}[1h]))
        / sum(rate(http_requests_total[1h]))
      ) > (14.4 * 0.001)
    for: 2m
    labels:
      severity: critical
    annotations:
      summary: "Burning error budget 14x too fast"
  
  # Slow burn: 3x burn rate for 6 hours = 3% of monthly budget
  - alert: HighBurnRate_Slow
    expr: |
      (
        sum(rate(http_requests_total{status=~"5.."}[6h]))
        / sum(rate(http_requests_total[6h]))
      ) > (3 * 0.001)
    for: 15m
    labels:
      severity: warning
```

### Alert Routing

```yaml
# alertmanager.yml
route:
  receiver: 'default'
  group_by: ['alertname', 'service']
  group_wait: 30s
  group_interval: 5m
  repeat_interval: 4h
  routes:
  - match:
      severity: critical
    receiver: 'pagerduty-critical'
    continue: true
  - match:
      severity: warning
    receiver: 'slack-warnings'
  - match:
      team: database
    receiver: 'database-team'

receivers:
- name: 'pagerduty-critical'
  pagerduty_configs:
  - service_key: '<key>'
    
- name: 'slack-warnings'
  slack_configs:
  - channel: '#alerts'
    send_resolved: true
```

---

## Dashboard Design

### Layout Principles

```
┌─────────────────────────────────────────────────────────────────────┐
│  Service Overview Dashboard                                         │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  TOP ROW: Key indicators (current state at a glance)               │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐  │
│  │ Requests │ │  Errors  │ │ Latency  │ │ Success  │ │Saturation│  │
│  │  1.2k/s  │ │   0.1%   │ │  42ms    │ │  99.9%   │ │   34%    │  │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘ └──────────┘  │
│                                                                     │
│  MIDDLE: Time series (trends and patterns)                         │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │  Request Rate & Error Rate (overlaid)                       │   │
│  │  ▁▂▃▄▅▆▇█▇▆▅▄▃▂▁                                            │   │
│  └─────────────────────────────────────────────────────────────┘   │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │  Latency Distribution (heatmap or percentiles)              │   │
│  │  p99: ████████████████████                                  │   │
│  │  p95: ████████████                                          │   │
│  │  p50: █████                                                 │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  BOTTOM: Breakdown (drill-down details)                            │
│  ┌────────────────────────┐ ┌────────────────────────────────┐     │
│  │ Errors by Endpoint     │ │ Latency by Endpoint            │     │
│  │ /api/orders    45%     │ │ /api/search     250ms          │     │
│  │ /api/users     30%     │ │ /api/orders     120ms          │     │
│  │ /api/products  25%     │ │ /api/users       45ms          │     │
│  └────────────────────────┘ └────────────────────────────────┘     │
└─────────────────────────────────────────────────────────────────────┘
```

### Essential Dashboards

```
1. Service Overview
   - RED metrics for each service
   - Dependency status
   - Recent deployments marked

2. Infrastructure
   - USE metrics for all resources
   - Cluster health
   - Node status

3. Business KPIs
   - Orders/Revenue
   - Active users
   - Conversion rates

4. SLO Dashboard
   - Current error budget
   - Burn rate
   - Historical SLO performance
```

---

## Anti-Patterns

### Cardinality Explosion

```
BAD — unbounded label values:
  http_requests_total{user_id="8291037"}      # Millions of users
  http_requests_total{request_id="a1b2c3..."}  # Unique per request
  http_requests_total{timestamp="1710504000"}  # Infinite

Impact:
  - Memory exhaustion in Prometheus
  - Query performance degradation
  - Storage costs explode

GOOD — bounded, low-cardinality labels:
  http_requests_total{user_tier="pro",endpoint="/api/users",status_class="2xx"}
  # user_tier:    free, pro, enterprise  (3 values)
  # endpoint:     ~100 routes
  # status_class: 2xx, 3xx, 4xx, 5xx    (4 values)
```

### Monitoring What's Easy, Not What Matters

```
BAD (easy to measure):
- CPU usage
- Memory usage
- Uptime

These don't tell you if users are happy!

GOOD (what matters):
- Request success rate
- Request latency (user-perceived)
- Error rate by type
- Business transactions/sec
```

---

## References

- [Prometheus Best Practices](https://prometheus.io/docs/practices/naming/)
- [Google SRE Book - Monitoring](https://sre.google/sre-book/monitoring-distributed-systems/)
- [RED Method](https://grafana.com/blog/2018/08/02/the-red-method-how-to-instrument-your-services/)
- [USE Method](https://www.brendangregg.com/usemethod.html)
- [Practical Monitoring](https://www.oreilly.com/library/view/practical-monitoring/9781491957349/)
