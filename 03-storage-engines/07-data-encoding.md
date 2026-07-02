# Data Encoding

## TL;DR

Encoding is the contract between your data and time. Every byte that crosses a durable boundary — disk, network, queue — outlives the code that wrote it, and will be read by code that doesn't exist yet. That makes encoding two problems wearing one name: a *performance* problem (JSON parses at ~100 MB/s and triples payload size; Protobuf does 5–10× better; zero-copy formats skip parsing entirely) and a *compatibility* problem (can last year's consumer read tomorrow's producer's output, and vice versa?). The compatibility problem is the one that causes outages: it's governed by mechanical rules — Protobuf's field tags, Avro's reader/writer schema resolution, the reserved-number discipline — and enforced, in mature systems, by a schema registry that rejects breaking changes at CI time instead of discovering them at 3 a.m. This chapter covers the wire formats and why they're shaped that way, the evolution rules per format, registry operations, and the failure modes (JSON number precision, tag reuse, required-field traps, data-lake schema drift) that recur across every company.

---

## The Problem: Data Outlives Code

```
In-memory object:                       Must become bytes for:
  User {                                  - disk (storage engines, backups)
    id: 123,                              - network (RPC, APIs)
    name: "Alice",                        - queues (events that sit for days)
    emails: [...]                         - other languages entirely
  }

And the reverse, years later, by code that has been deployed
hundreds of times since the bytes were written.
```

The asymmetry that drives all encoding design: **writes happen once, under one schema; reads happen forever, under every schema that will ever exist.** A rolling deploy means old and new code run *simultaneously* against the same topics and tables, so compatibility isn't a migration event — it's a permanent operating condition:

```
Backward compatibility:  NEW code reads OLD data
  (required to deploy consumers first, and to read historical data —
   missing fields must have defaults)

Forward compatibility:   OLD code reads NEW data
  (required to deploy producers first — unknown fields must be
   skippable without breaking)

Full compatibility = both = deploy in any order. Rolling deploys and
multi-team ownership effectively demand full compatibility.
```

---

## Text Formats: JSON and Its Sharp Edges

```json
{"id": 123, "name": "Alice", "emails": ["a@example.com"], "balance": 99.99}
```

JSON won the boundary between organizations — self-describing, universal, debuggable with eyeballs — and its costs are well-known (3–5× the bytes of binary, key names repeated per record, ~100 MB/s parse throughput, base64 for binary data). Less well-known are the sharp edges that cause real incidents:

```
Number precision: JSON has ONE number type — IEEE-754 double.
  Integers above 2⁵³ silently lose precision in JavaScript and many
  parsers. Twitter's snowflake IDs (64-bit) famously broke JS clients:
    {"id": 10765432100123456789}  → parsed as ...456780
  Fix: serialize 64-bit IDs as strings ("id_str"), or use a
  big-integer-aware parser. This bug ships to production constantly.

No schema = no contract: a "compatible" change is whatever your
  most fragile consumer's hand-written parsing tolerates. null vs
  absent-field vs "" distinctions differ per language and library.

Duplicate keys, key ordering, NaN/Infinity: all
  implementation-defined. Canonicalization (for signing/hashing JSON)
  is a minefield — see JCS (RFC 8785) before hashing JSON.
```

XML survives where its schema machinery (XSD, namespaces) or document orientation is genuinely used — SOAP-era enterprise, config, documents. For data records it's strictly dominated. YAML is for humans editing config, never for machine-to-machine data (implicit typing: `no` parses as `false`, `3.10` as `3.1`).

---

## Binary Formats: Three Different Bets

### Protobuf: tag numbers on the wire

```protobuf
message User {
  int32 id = 1;                //  ← the "= 1" is the wire identity
  string name = 2;
  repeated string emails = 3;
}
```

```
Wire format: a stream of (tag, wire-type, value) triples
  field 1 (id=123):    08 7B          — tag+type: 1 byte, varint value
  field 2 ("Alice"):   12 05 41 6c 69 63 65   — tag, length, bytes

Varint: 7 bits per byte, high bit = continuation.
  0-127 → 1 byte; 300 → 2 bytes. Small numbers are nearly free.
  (sint32/64 add ZigZag: maps -1→1, 1→2 so negatives stay small.)

The consequences of tags-on-wire:
  + unknown tags are SKIPPABLE (wire type tells the length)
    → forward compatibility is structural, not optional
  + field NAMES are compile-time only — renaming a field is free
  - the tag number IS the field's identity forever
    → reusing a tag misinterprets old data with the new field's type:
      silent corruption, the worst failure mode in this chapter
```

### Avro: no tags, schema does the work

```json
{"type": "record", "name": "User", "fields": [
  {"name": "id", "type": "int"},
  {"name": "name", "type": "string"}
]}
```

```
Wire format: just concatenated values, in schema order. No tags,
no field names, no lengths where the type implies them.
  → the smallest payloads of any general format
  → but UNREADABLE without the writer's exact schema

Reading = schema resolution: reader supplies ITS schema, runtime
matches fields BY NAME against the writer's schema:
  writer has extra field  → reader skips it (forward compat)
  reader has extra field  → default value fills it (backward compat,
                            IF a default was declared — enforced!)
  renamed field           → aliases: ["old_name"]

The bet: schemas are cheap to distribute (embedded in files for
batch: one schema, a million rows; registry ID for streaming: 5 bytes
per message). Where that holds — Kafka, data lakes — Avro excels.
Where it doesn't — ad-hoc RPC — Protobuf's self-delimiting fields win.
```

### Zero-copy: FlatBuffers and Cap'n Proto

```
Traditional: bytes → parse → object graph → access
Zero-copy:   bytes → access (fields read directly from the buffer
             via offsets; "parse time" is zero)

Use when: you read millions of records and touch 2 fields each
  (games, ML feature pipelines, mmap'd files, IPC).
Costs: larger payloads than protobuf (alignment, offset tables),
  awkward mutation, less ecosystem. Wrong default for APIs.
```

MessagePack/CBOR are "binary JSON" — schemaless, 40–60% smaller, faster; right when you want JSON's flexibility with less waste (CBOR is the IoT/COSE standard), but they inherit JSON's no-contract problem.

---

## Schema Evolution: The Rules, Per Format

### Protobuf

```protobuf
message User {
  reserved 2, 5;                 // tags retired FOREVER
  reserved "name", "age";        // names too (prevents tooling confusion)
  int32 id = 1;
  string email = 3;
  string phone = 4;
}
```

```
Safe:                                Unsafe:
  add field with NEW tag               reuse a tag number — silent corruption
  remove field + reserve its tag       change a field's type (mostly)
  rename a field (names ≠ wire)        change int32 ↔ sint32 (different encoding!)
  optional → repeated (scalars)        anything with required (proto2 — which is
                                       why proto3 removed required entirely)
```

The `required` lesson is generational: a field that must exist can never be removed, because some reader somewhere will reject the message. Every mature schema culture converged on "everything optional, defaults everywhere, validation in code" — constraints belong to the application layer, which can be deployed; wire formats can't.

### Avro

```
Safe:                                Requires care:
  add field WITH default               add field without default: breaks
  remove field that HAD default          backward compat (registry rejects)
  rename via aliases                   type promotions: int→long→float→double
  reorder fields (matched by name)       OK; the reverse is not
```

### JSON

No mechanical rules exist — evolution discipline is conventions: additive-only changes, `additionalProperties: true` if you use JSON Schema, version envelopes (`{"v": 2, ...}`) or versioned endpoints, and contract tests standing in for what a registry would enforce.

---

## Schema Registry: Making Compatibility Enforceable

The registry turns evolution rules from tribal knowledge into a build-time gate:

```
Producer:  register schema (once) → get 4-byte schema ID
           send [magic 0x0][schema_id: 4B][avro payload]
Consumer:  read ID → fetch schema (cached — registry is NOT on the
           hot path) → resolve against its own reader schema

The enforcement: registering a schema that violates the subject's
compatibility mode is REJECTED — the incompatible producer fails in
CI/deploy, not in the consumer at runtime.
```

```
Compatibility modes (Confluent vocabulary):
  BACKWARD (default): new schema can read data written by the last
    schema. Deployment order: consumers first.
  FORWARD:  last schema can read data written by the new schema.
    Deployment order: producers first.
  FULL:     both. Deploy in any order.
  *_TRANSITIVE: checked against ALL registered versions, not just the
    last — REQUIRED if a topic/lake retains data older than one schema
    generation (i.e., almost always the right choice; the non-transitive
    defaults are a common gap: v3 is compatible with v2, v2 with v1,
    but v3 cannot read v1's data still sitting in the topic).

API sketch:
  POST /subjects/{subject}/versions            → register, returns {"id": 42}
  POST /compatibility/subjects/{s}/versions/latest → pre-flight check
  PUT  /config/{subject}                       → set mode per subject
```

Protobuf ecosystems get the same gate from `buf breaking` (schema linting against a baseline in CI) with or without a registry; the principle is identical — **breaking changes should fail a build, not a consumer**.

---

## Performance: What the Benchmarks Actually Say

| Format | Serialize | Deserialize | Size (1 KB JSON baseline) | Schema |
|--------|-----------|-------------|--------------|--------|
| JSON | ~100 MB/s | ~200 MB/s | 100% | no |
| JSON + gzip | ~50 MB/s | ~80 MB/s | ~40% | no |
| MessagePack | ~400 MB/s | ~800 MB/s | ~65% | no |
| Protobuf | ~800 MB/s | ~1.5 GB/s | ~30% | yes |
| Avro | ~600 MB/s | ~1 GB/s | ~28% | yes |
| FlatBuffers | ~1.5 GB/s | zero-copy | ~45% | yes |

*Order-of-magnitude guidance; varies by language and data shape. JS/Python narrow the gaps (their JSON parsers are C, their protobuf often isn't); Go/Java/C++/Rust widen them.*

Why binary-with-schema wins: no field names on the wire (tags/positions instead), no type sniffing (schema fixes types at compile time), varints for small numbers, generated code instead of reflection. When it doesn't matter: a service doing 50 req/s spends nothing meaningful on JSON — encoding optimization pays at *pipeline* scale (per-hop costs × hops × message rate) or at *storage* scale (billions of rows, where you should be in [Parquet/columnar](./06-column-storage.md) anyway, which applies these same encodings — dictionary, RLE, bit-packing — per column).

---

## Where Encodings Live in a System

```
External API:      JSON (REST/GraphQL) — humans and unknown clients
Internal RPC:      Protobuf over gRPC — contracts + codegen + speed
Event streaming:   Avro (or Protobuf) + Schema Registry on Kafka
                   — messages outlive deploys; registry is the contract
Analytics at rest: Parquet/ORC — columnar; schema evolution rules of
                   the TABLE FORMAT (Iceberg/Delta) apply on top
Storage engines:   internal record formats (slotted pages, LSM entries)
                   — see B-Trees / LSM chapters; WAL records must be
                   versioned too (recovery reads old-format records
                   after an upgrade!)
Config:            YAML/JSON — human-edited, schema-validated in CI
```

The recurring anti-patterns: JSON between internal services at high fan-out (parse cost × 10 hops adds real p99); a custom binary format ("we'll document it later" — you now own evolution, tooling, and debugging forever); protobuf blobs in a database column with no schema version attached (which `.proto` decodes row 40M?); required-field maximalism in any format.

---

## Failure Modes

**Tag/field-number reuse (Protobuf).** Deleting `string nickname = 5;` and later adding `int64 team_id = 5;` makes old messages decode nickname bytes as a team ID — no error, garbage data. This is why `reserved` exists and why schema review must treat tag numbers as append-only. `buf breaking` catches it mechanically.

**JSON 64-bit integers.** Any ID that can exceed 2⁵³ must travel as a string. The failure is silent rounding in whichever consumer parses to double — often discovered as "two different users got the same ID" weeks later.

**Missing-default Avro fields.** A producer team adds a field without a default and pushes with compatibility NONE (or no registry): every consumer with the old reader schema throws on resolution. The registry's whole job is making this impossible; use TRANSITIVE modes so it stays impossible across more than one version gap.

**Schema drift in data lakes.** Streaming JSON into a lake and inferring schema per batch yields columns whose type flip-flops (`user_id`: int in Monday's files, string in Tuesday's). Queries fail months later on the mixed history. Fix: schema-on-write (enforce at ingest with a registry) and a table format (Iceberg/Delta) that owns column identity and type promotion.

**WAL/snapshot format upgrades.** Storage engines and stateful services must read *their own* old formats after an upgrade — recovery replays records written by the previous binary ([WAL](./04-write-ahead-logging.md)). Version every persistent record header, and test upgrade paths with data written by N−1 and N−2, not just fresh state.

**Compression confusion.** Encoding and compression are separate layers: Protobuf is compact but still compresses ~2× with zstd; JSON+zstd can approach protobuf sizes at high CPU cost. Measure end-to-end (CPU + bytes + latency) before concluding either "we need binary" or "gzip is enough."

---

## Decision Framework

| Requirement | Choice |
|-------------|--------|
| Public/external API | JSON (REST or GraphQL); 64-bit IDs as strings |
| Internal service RPC | Protobuf + gRPC, `buf breaking` in CI |
| Kafka / event streams | Avro or Protobuf + Schema Registry, FULL_TRANSITIVE |
| Analytical storage | Parquet/ORC under Iceberg/Delta — encode once, columnar |
| Long-lived stored blobs | Anything *with* an embedded schema version header |
| Hot IPC / mmap, few fields touched | FlatBuffers / Cap'n Proto |
| Schemaless but smaller than JSON | CBOR or MessagePack (accepting JSON's contract gap) |
| Human-edited | YAML/JSON + schema validation in CI; never machine-to-machine |
| Signing/hashing payloads | Canonical form first (JCS for JSON) or sign raw bytes |

---

## Key Takeaways

1. **Encoding is a compatibility problem first, a performance problem second** — data outlives code, and rolling deploys make old-reads-new and new-reads-old permanent operating conditions, not migration events.
2. **The wire identity differs per format**: Protobuf = tag numbers (never reuse; names are free), Avro = names via schema resolution (defaults mandatory), JSON = whatever your most fragile consumer does.
3. **Everything optional, defaults everywhere** — `required` at the wire level is a one-way door every mature schema culture has closed; validate in application code.
4. **Enforce evolution mechanically** — schema registry with TRANSITIVE compatibility, or `buf breaking` in CI; a breaking change should fail a build, not page a consumer team.
5. **JSON numbers are doubles** — 64-bit IDs travel as strings, or they corrupt silently.
6. **Binary-with-schema is 5–10× faster and 3× smaller than JSON**, and it matters at pipeline and storage scale — not for your 50-req/s service.
7. **Zero-copy formats trade size and ergonomics for zero parse time** — right for read-heavy few-field access, wrong as an API default.
8. **Version your storage formats too** — WALs, snapshots, and DB-column blobs are read by future binaries; give every record a schema/version header.

---

## References

- Kleppmann, M. (2017). *Designing Data-Intensive Applications*, Ch. 4 "Encoding and Evolution" — the canonical treatment.
- Protocol Buffers documentation: *Encoding* (varint/wire format) and *Proto Best Practices* (reserved, field numbering).
- Apache Avro specification: *Schema Resolution*.
- Confluent Schema Registry documentation: *Compatibility Types* (incl. transitive modes).
- `buf` documentation: *Breaking Change Detection*.
- RFC 8785: *JSON Canonicalization Scheme (JCS)*; RFC 8949: *CBOR*.
- FlatBuffers and Cap'n Proto design documents (zero-copy layouts).
