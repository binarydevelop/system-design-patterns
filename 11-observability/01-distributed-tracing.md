# Distributed Tracing

## TL;DR

Distributed tracing tracks requests as they flow through multiple services, creating a complete picture of a transaction's journey. Each trace consists of spans representing individual operations, connected by context propagation. Essential for debugging latency issues and understanding system behavior.

---

## The Problem Tracing Solves

In a microservices architecture, a single user request touches many services:

```
User Request
     │
     ▼
┌─────────┐    ┌─────────┐    ┌─────────┐    ┌─────────┐
│   API   │───►│  Auth   │───►│  User   │───►│  Cache  │
│ Gateway │    │ Service │    │ Service │    │         │
└─────────┘    └─────────┘    └─────────┘    └─────────┘
     │                             │
     │                             ▼
     │                        ┌─────────┐
     │                        │   DB    │
     │                        └─────────┘
     ▼
┌─────────┐    ┌─────────┐    ┌─────────┐
│  Order  │───►│ Payment │───►│ Notif.  │
│ Service │    │ Service │    │ Service │
└─────────┘    └─────────┘    └─────────┘

Without tracing:
- "Request took 2 seconds" - but where?
- "Payment failed" - but what was the user context?
- Logs scattered across 8 different services
```

---

## Tracing Concepts

### Trace

A trace represents the entire journey of a request through the system.

```
Trace ID: abc123

┌─────────────────────────────────────────────────────────────────┐
│                          Time →                                 │
│                                                                 │
│ ├────────────── API Gateway (500ms) ───────────────────────────┤│
│ │    ├────── Auth Service (50ms) ──────┤                       ││
│ │    │                                  │                       ││
│ │    │    ├── User Service (200ms) ────┤                       ││
│ │    │    │   ├─ DB Query (150ms) ─┤   │                       ││
│ │    │    │                            │                       ││
│ │    ├────────── Order Service (400ms) ───────────────────────┤││
│ │    │         │    ├── Payment (250ms) ──┤                   │││
│ │    │         │    │                      │                   │││
│ │    │         │    │    ├─ Notify (30ms) ─┤                  │││
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Span

A span represents a single unit of work within a trace.

```json
{
    "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
    "spanId": "00f067aa0ba902b7",
    "parentSpanId": "d5ebc7e161ade64a",
    "operationName": "HTTP GET /users/{id}",
    "serviceName": "user-service",
    "startTime": "2024-01-01T10:00:00.000Z",
    "duration": "200ms",
    "status": "OK",
    "attributes": {
        "http.method": "GET",
        "http.url": "/users/123",
        "http.status_code": 200,
        "user.id": "123"
    },
    "events": [
        {"timestamp": "...", "name": "cache.miss", "attributes": {"db.system": "redis"}},
        {"timestamp": "...", "name": "user.found"}
    ]
}
```

### Context Propagation

Trace context must be passed between services:

```
Service A                        Service B
    │                                │
    │  HTTP Request                  │
    │  Headers:                      │
    │    traceparent: 00-abc123-...  │
    │    tracestate: vendor=value    │
    │ ──────────────────────────────►│
    │                                │
    │                                │ Extracts trace context
    │                                │ Creates child span
    │                                │ with same trace_id
```

### W3C Trace Context Standard

```
traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01
             │  │                                │                  │
             │  │                                │                  └─ Flags (sampled)
             │  │                                └─ Parent Span ID
             │  └─ Trace ID
             └─ Version

tracestate: congo=t61rcWkgMzE,rojo=00f067aa0ba902b7
            Vendor-specific key-value pairs
```

---

## Implementation

### Go Instrumentation Example

```go
package main

import (
	"context"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
)

var tracer = otel.Tracer("order-service")

func processOrder(ctx context.Context, orderID string) (*Order, error) {
	ctx, span := tracer.Start(ctx, "process_order")
	defer span.End()
	span.SetAttributes(attribute.String("order.id", orderID))

	// Child span — validation
	order, err := validateOrder(ctx, orderID)
	if err != nil {
		span.RecordError(err)
		span.SetStatus(codes.Error, err.Error())
		return nil, err
	}

	// Child span — payment
	ctx, paySpan := tracer.Start(ctx, "process_payment")
	result, err := paymentService.Charge(ctx, order)
	if err != nil {
		paySpan.RecordError(err)
		paySpan.SetStatus(codes.Error, err.Error())
		paySpan.End()
		return nil, err
	}
	paySpan.SetAttributes(attribute.String("payment.method", result.Method))
	paySpan.End()

	span.SetStatus(codes.Ok, "")
	return order, nil
}
```

### W3C Trace Context in HTTP

Outgoing request from Service A (order-service) to Service B (payment-service):

```http
POST /api/v1/charge HTTP/1.1
Host: payment-service:8080
Content-Type: application/json
traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01
tracestate: order-svc=00f067aa0ba902b7

{"order_id": "ord_456", "amount": 99.00}
```

Response from Service B, continuing the same trace:

```http
HTTP/1.1 200 OK
Content-Type: application/json
traceresponse: 00-4bf92f3577b34da6a3ce929d0e0e4736-d5ebc7e161ade64a-01

{"status": "charged", "transaction_id": "txn_789"}
```

The OTel SDK (or auto-instrumentation agent) handles injection and extraction automatically. In Kafka/gRPC, the same `traceparent` header propagates through message headers or gRPC metadata.

### Context Propagation in Message Queues

```
Kafka Record Headers (produced by order-service):
  traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-a1b2c3d4e5f60718-01
  tracestate:  order-svc=a1b2c3d4e5f60718

Consumer (notification-service) extracts these headers → creates
a child span with the same trace_id, linking the async flow.
```

---

## Sampling Strategies

Tracing everything is expensive. Sampling reduces overhead:

### Head-Based Sampling

Decision made at trace start, propagated to all spans.

```
traceparent flags byte controls the sampling decision:

  Sampled:      00-4bf92f35...-00f067aa...-01   ← flags=01 (sampled)
  Not sampled:  00-4bf92f35...-00f067aa...-00   ← flags=00 (not sampled)

All downstream services respect the parent's decision.
```

Configured via environment variables or OTel Collector config:

```yaml
# Application-side (env vars)
OTEL_TRACES_SAMPLER: parentbased_traceidratio
OTEL_TRACES_SAMPLER_ARG: "0.10"   # Sample 10% of root traces
```

### Tail-Based Sampling

Decision made after trace completes, based on full trace data.

```
Collector receives all spans
         │
         ▼
┌─────────────────────┐
│  Tail-Based Sampler │
│                     │
│  Rules:             │
│  - Keep all errors  │
│  - Keep > 2s        │
│  - Keep 1% of rest  │
└─────────────────────┘
         │
         ▼
    Store/Discard

Pros:
- Can sample based on outcome (errors, latency)
- More intelligent decisions

Cons:
- Must buffer complete traces
- Higher resource usage
- More complex
```

### Adaptive Sampling

```
Adaptive sampling adjusts the rate based on traffic volume to maintain
a target traces-per-second. Typically implemented via tail-based sampling
in the OTel Collector (see Collector Configuration below) rather than
in application code. Jaeger's remote sampler also supports this natively.

Strategy:
  Low traffic  → sample 100% (capture everything)
  High traffic → reduce to hit target TPS (e.g., 50 traces/sec)
  Always keep  → errors, slow traces (>2s)
```

---

## Tracing Systems Architecture

### OpenTelemetry Collector

```
┌─────────────────────────────────────────────────────────────────┐
│                    Applications                                  │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐            │
│  │Service A│  │Service B│  │Service C│  │Service D│            │
│  └────┬────┘  └────┬────┘  └────┬────┘  └────┬────┘            │
│       │            │            │            │                   │
└───────┼────────────┼────────────┼────────────┼───────────────────┘
        │            │            │            │
        └────────────┼────────────┼────────────┘
                     │            │
                     ▼            ▼
              ┌─────────────────────────┐
              │   OTel Collector        │
              │                         │
              │  ┌─────────────────┐    │
              │  │    Receivers    │    │  OTLP, Jaeger, Zipkin
              │  └────────┬────────┘    │
              │           │             │
              │  ┌────────▼────────┐    │
              │  │   Processors    │    │  Batch, Filter, Sample
              │  └────────┬────────┘    │
              │           │             │
              │  ┌────────▼────────┐    │
              │  │    Exporters    │    │  Jaeger, Tempo, X-Ray
              │  └─────────────────┘    │
              └───────────┬─────────────┘
                          │
           ┌──────────────┼──────────────┐
           ▼              ▼              ▼
      ┌─────────┐   ┌─────────┐   ┌─────────┐
      │  Jaeger │   │ Grafana │   │ AWS     │
      │         │   │  Tempo  │   │ X-Ray   │
      └─────────┘   └─────────┘   └─────────┘
```

### Collector Configuration

```yaml
# otel-collector-config.yaml
receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
      http:
        endpoint: 0.0.0.0:4318

processors:
  batch:
    timeout: 1s
    send_batch_size: 1024
  
  # Filter out health check spans
  filter:
    spans:
      exclude:
        match_type: regexp
        attributes:
          - key: http.url
            value: .*/health.*
  
  # Tail-based sampling
  tail_sampling:
    decision_wait: 10s
    policies:
      - name: errors
        type: status_code
        status_code: {status_codes: [ERROR]}
      - name: slow-traces
        type: latency
        latency: {threshold_ms: 2000}
      - name: percentage
        type: probabilistic
        probabilistic: {sampling_percentage: 10}

exporters:
  jaeger:
    endpoint: jaeger:14250
    tls:
      insecure: true
  
  otlp:
    endpoint: tempo:4317

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [batch, filter, tail_sampling]
      exporters: [jaeger, otlp]
```

---

## Best Practices

### Span Naming

```
BAD — too specific, causes cardinality explosion:
  "GET /users/8291037"             # Millions of unique span names

GOOD — parameterized:
  "GET /users/{id}"

BAD — too generic:
  "database_query"

GOOD — descriptive:
  "SELECT users by id"
```

### Useful Attributes

```
OTel Semantic Conventions — standard attribute keys:

HTTP spans:
  http.method                    = "POST"
  http.url                       = "/api/orders"
  http.status_code               = 200
  http.request_content_length    = 1024

Database spans:
  db.system                      = "postgresql"
  db.name                        = "users"
  db.statement                   = "SELECT * FROM users WHERE id = ?"
  db.operation                   = "SELECT"

Business context (custom):
  user.id                        = "123"
  order.id                       = "ord_456"
  tenant.id                      = "acme-corp"
```

### Error Handling

```
Error handling strategy for spans:

Expected errors (validation, auth):
  → Set span status to ERROR with message
  → Do NOT record exception event (reduces noise)

Unexpected errors (panics, infrastructure failures):
  → Set span status to ERROR
  → Record exception event with stack trace
  → These show up as red spans in Jaeger/Tempo

Span status values:  Unset | Ok | Error
```

### Correlation with Logs

```
Structured log line with embedded trace context:

{
  "timestamp": "2024-01-01T10:00:00.000Z",
  "level": "INFO",
  "message": "Processing order",
  "trace_id": "4bf92f3577b34da6a3ce929d0e0e4736",
  "span_id": "00f067aa0ba902b7",
  "service": "order-service"
}

This lets Grafana/Loki link directly from a log line → Tempo/Jaeger trace view.
OTel auto-instrumentation injects trace_id/span_id into logs automatically.
```

---

## Analyzing Traces

### Finding Bottlenecks

```
Trace Timeline View:
├── API Gateway (total: 2000ms)
│   ├── Auth (50ms) ✓
│   ├── Get User (1500ms) ← BOTTLENECK
│   │   ├── Cache Lookup (5ms)
│   │   ├── DB Query (1400ms) ← ROOT CAUSE
│   │   └── Serialize (10ms)
│   └── Send Response (50ms)

Investigation:
1. DB Query taking 1400ms
2. Check db.statement attribute
3. Query: SELECT * FROM users WHERE email = ?
4. Missing index on email column!
```

### Trace Comparison

```
Normal Trace (200ms):                Slow Trace (5000ms):
├── Service A (50ms)                 ├── Service A (50ms)
│   └── Cache HIT (5ms)              │   └── Cache MISS (5ms)
├── Service B (100ms)                ├── Service B (4800ms) ← Different
│   └── DB Query (80ms)              │   ├── DB Query (80ms)
└── Service C (50ms)                 │   └── Retry x3 (4500ms) ← Retries!
                                     └── Service C (50ms)
```

### Jaeger / Tempo Query Examples

```
Jaeger UI / API queries:

  # Find traces by service and operation
  GET /api/traces?service=order-service&operation=process_order&limit=20

  # Find traces by tag
  GET /api/traces?service=order-service&tags={"http.status_code":"500"}

  # Find traces slower than 2 seconds
  GET /api/traces?service=order-service&minDuration=2s

  # Lookup a specific trace by ID
  GET /api/traces/4bf92f3577b34da6a3ce929d0e0e4736
```

```text
Grafana Tempo — TraceQL queries:

  # All error spans from order-service slower than 1s
  {resource.service.name="order-service" && status=error && duration>1s}

  # Traces with a specific attribute
  {span.http.status_code=500}

  # Traces touching both order-service and payment-service
  {resource.service.name="order-service"} && {resource.service.name="payment-service"}
```

---

## Trade-offs

| Aspect | Consideration |
|--------|---------------|
| Overhead | 1-5% latency, storage costs |
| Sampling | Miss important traces vs. cost |
| Cardinality | Too many unique tags = expensive |
| Completeness | Uninstrumented services break trace |
| Complexity | Learning curve, operational burden |

---

## References

- [OpenTelemetry Documentation](https://opentelemetry.io/docs/)
- [W3C Trace Context](https://www.w3.org/TR/trace-context/)
- [Jaeger Documentation](https://www.jaegertracing.io/docs/)
- [Google Dapper Paper](https://research.google/pubs/pub36356/)
- [Distributed Tracing in Practice](https://www.oreilly.com/library/view/distributed-tracing-in/9781492056621/)
