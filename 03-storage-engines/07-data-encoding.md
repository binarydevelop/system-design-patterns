# Data Encoding

## TL;DR

Data encoding serializes in-memory data structures into bytes for storage or transmission. Choose based on trade-offs: JSON/XML for human readability, Protocol Buffers/Thrift for efficiency and schema evolution, Avro for dynamic schemas. Schema evolution is critical for long-lived systems—forward and backward compatibility prevent breaking changes.

---

## Why Encoding Matters

### The Translation Problem

```
In-memory object:
  User {
    id: 123,
    name: "Alice",
    emails: ["a@example.com", "b@example.com"]
  }

Must become bytes for:
  - Disk storage
  - Network transmission
  - Cross-language communication
```

### Key Considerations

```
1. Efficiency: Size and speed
2. Schema evolution: Can we change the structure?
3. Human readability: Debug-friendly?
4. Language support: Cross-platform?
5. Compatibility: Forward and backward?
```

---

## Text-Based Formats

### JSON

```json
{
  "id": 123,
  "name": "Alice",
  "emails": ["a@example.com", "b@example.com"],
  "active": true,
  "balance": 99.99
}
```

**Pros:**
- Human readable
- Universal language support
- Self-describing (keys included)
- Flexible (no schema required)

**Cons:**
- Verbose (repeated key names)
- No binary data (base64 needed)
- Numbers ambiguous (int vs float)
- No schema enforcement

### XML

```xml
<user>
  <id>123</id>
  <name>Alice</name>
  <emails>
    <email>a@example.com</email>
    <email>b@example.com</email>
  </emails>
</user>
```

**Pros:**
- Human readable
- Rich schema support (XSD)
- Namespaces for composition

**Cons:**
- Very verbose
- Complex parsing
- Slower than alternatives

### Size Comparison

```
Same data:
  JSON: 95 bytes
  XML:  153 bytes
  Protocol Buffers: 33 bytes

3-5x size difference affects:
  - Storage costs
  - Network bandwidth
  - Parse time
```

---

## Binary Formats

### Protocol Buffers (Protobuf)

Schema definition (`.proto`):
```protobuf
message User {
  int32 id = 1;
  string name = 2;
  repeated string emails = 3;
  bool active = 4;
  double balance = 5;
}
```

Wire format:
```
Field 1 (id): [tag: 08][value: 7B]  // 123 in varint
Field 2 (name): [tag: 12][length: 05][data: Alice]
Field 3 (emails): [tag: 1A][length: 0D][data: a@example.com]
...
```

**Pros:**
- Compact binary format
- Strong typing
- Schema evolution support
- Fast serialization
- Generated code

**Cons:**
- Not human readable
- Requires schema
- Field tags must be unique

### Thrift

Similar to Protobuf, from Facebook.

```thrift
struct User {
  1: i32 id,
  2: string name,
  3: list<string> emails,
  4: bool active,
  5: double balance
}
```

Multiple protocols:
- Binary (compact)
- Compact (smaller)
- JSON (readable)

### Avro

Schema:
```json
{
  "type": "record",
  "name": "User",
  "fields": [
    {"name": "id", "type": "int"},
    {"name": "name", "type": "string"},
    {"name": "emails", "type": {"type": "array", "items": "string"}},
    {"name": "active", "type": "boolean"},
    {"name": "balance", "type": "double"}
  ]
}
```

**Key difference:** No field tags in wire format.
- Schema must be available at read time
- Smaller payloads
- Excellent for batch processing (Hadoop)

### MessagePack

```
JSON-compatible binary format

JSON: {"name":"Alice","age":30}
MessagePack: 82 A4 6E 61 6D 65 A5 41 6C 69 63 65 A3 61 67 65 1E

50-80% size of JSON
Faster parsing
No schema required
```

---

## Schema Evolution

### The Problem

```
Version 1:
  User { id, name }

Version 2 (add field):
  User { id, name, email }

Version 3 (remove field, add another):
  User { id, email, phone }

Old readers, new writers. New readers, old writers.
Must all continue to work.
```

### Compatibility Types

```
Forward compatible:
  Old code can read new data
  (Ignores unknown fields)

Backward compatible:
  New code can read old data
  (Handles missing fields)

Full compatible:
  Both forward and backward
```

### Protobuf Evolution Rules

```protobuf
// Version 1
message User {
  int32 id = 1;
  string name = 2;
}

// Version 2: Add optional field (backward compatible)
message User {
  int32 id = 1;
  string name = 2;
  string email = 3;  // New field, optional by default
}

// Version 3: Remove field (forward compatible)
message User {
  int32 id = 1;
  // name removed - old readers still work
  string email = 3;
  string phone = 4;
}
```

**Rules:**
- Never reuse field numbers
- Add fields with new numbers
- Use `optional` or `repeated` (not `required`)
- Removed fields: Reserve the number

### Avro Evolution

```
Writer schema (v2):
  {id: int, name: string, email: string}

Reader schema (v1):
  {id: int, name: string}

Resolution:
  Reader ignores 'email' (not in reader schema)
  
Reader schema (v3):
  {id: int, name: string, phone: string}

Resolution:
  Reader uses default for 'phone' (not in writer schema)
```

Avro uses schema resolution:
- Writer schema embedded or known
- Reader schema specified by application
- Fields matched by name

---

## Field Identification

### By Tag Number (Protobuf, Thrift)

```
Wire format includes field tag:
  [tag=1, value=123][tag=2, value="Alice"]

Old reader sees unknown tag:
  [tag=3, value="new@email.com"]
  → Skip (knows length from type)

Robust to additions
```

### By Position (Avro)

```
Wire format: [value1][value2][value3]
No tags, just values in order

Reader and writer must agree on schema
Schema resolution matches fields by name
Smaller than tagged formats
```

### By Name (JSON)

```
{"id": 123, "name": "Alice"}

Field names repeated in every record
Verbose but self-describing
```

---

## Encoding Performance

### Benchmarks (Approximate)

| Format | Encode | Decode | Size |
|--------|--------|--------|------|
| JSON | 100 MB/s | 200 MB/s | 100% |
| Protobuf | 500 MB/s | 1 GB/s | 30% |
| Avro | 400 MB/s | 800 MB/s | 25% |
| MessagePack | 300 MB/s | 600 MB/s | 60% |
| FlatBuffers | N/A* | 10 GB/s | 40% |

*FlatBuffers: Zero-copy, no decode step

### Zero-Copy Formats

```
Traditional:
  [bytes on disk] → [parse] → [in-memory objects]
  Must copy and transform

Zero-copy (FlatBuffers, Cap'n Proto):
  [bytes on disk] → [access directly]
  Read fields without full deserialization
  
Benefits:
  - Instant "parsing"
  - Lower memory usage
  - Great for mmap

Trade-offs:
  - More complex access patterns
  - Alignment requirements
```

---

## Database Encoding

### Row-Based

```
PostgreSQL row:
  [header][null bitmap][col1][col2][col3]

Fixed columns at fixed offsets
Variable-length columns use length prefix
```

### Column-Based

```
Each column encoded separately:
  int column: [RLE or bit-packed integers]
  string column: [dictionary + indices]

Different encoding per column type
```

### Log-Structured

```
Key-value entry:
  [key_length][key][value_length][value][sequence][type]

Type: PUT or DELETE
Sequence: For ordering/versioning
```

---

## Network Protocol Encoding

### HTTP APIs

```
Common choices:
  REST + JSON: Ubiquitous, human-friendly
  gRPC + Protobuf: Efficient, typed
  GraphQL + JSON: Flexible queries

JSON for external APIs
Protobuf for internal services
```

### RPC Encoding

```
gRPC:
  HTTP/2 + Protobuf
  Bidirectional streaming
  Generated clients

Thrift:
  Multiple transports (HTTP, raw TCP)
  Multiple protocols (binary, compact, JSON)
```

### Event Streaming

```
Kafka:
  Key + Value, both byte arrays
  Usually Avro or JSON
  Schema Registry for evolution

Common pattern:
  Schema ID in message header
  Registry lookup for schema
  Decode with schema
```

---

## Schema Registry

### Concept

```
Central service storing schemas:
  Schema ID 1 → User v1 schema
  Schema ID 2 → User v2 schema
  Schema ID 3 → Order v1 schema

Producer:
  1. Register schema (if new)
  2. Get schema ID
  3. Send [schema_id][payload]

Consumer:
  1. Read schema_id from message
  2. Fetch schema from registry
  3. Decode with schema
```

### Confluent Schema Registry

```
POST /subjects/user/versions
Content-Type: application/json
{
  "schema": "{\"type\":\"record\",\"name\":\"User\",...}"
}

Response:
{"id": 1}

Message format:
[magic byte: 0][schema_id: 4 bytes][payload]
```

### Compatibility Enforcement

```
Configure compatibility mode:
  BACKWARD: New can read old
  FORWARD: Old can read new
  FULL: Both
  NONE: No checks

Registry rejects incompatible schemas
Prevents accidental breaking changes
```

---

## Choosing an Encoding

### Decision Matrix

| Requirement | Format |
|-------------|--------|
| Human debugging | JSON |
| Maximum efficiency | Protobuf, FlatBuffers |
| Hadoop/Spark | Avro, Parquet |
| External API | JSON |
| Internal RPC | Protobuf, Thrift |
| Schema flexibility | JSON, MessagePack |
| Strong contracts | Protobuf, Avro |
| Zero-copy access | FlatBuffers, Cap'n Proto |

### Questions to Ask

```
1. Who needs to read this data?
   - Machines only → binary
   - Humans → text

2. How long will data live?
   - Short-lived → any format
   - Long-lived → schema evolution critical

3. Cross-language needs?
   - Yes → Protobuf, JSON
   - Single language → native formats OK

4. Size/speed constraints?
   - Critical → binary formats
   - Relaxed → JSON fine
```

---

## Schema Evolution Strategies

### Compatibility in Deployment Context

```
Forward (old code reads new data):  Deploy producers first. Unknown fields skipped.
Backward (new code reads old data): Deploy consumers first. Missing fields defaulted.
Full (both directions):             Deploy independently. Rolling deploys demand this.
```

### Format-Specific Evolution Rules

**Protobuf:**
- Adding `optional` field with new tag → forward + backward compatible
- Removing field → mark tag as `reserved` forever
- Changing `optional` to `repeated` → safe for scalar types
- Never change a field's tag number — silently corrupts data

```protobuf
message User {
  reserved 2, 5;           // field numbers retired forever
  reserved "name", "age";  // field names retired forever
  int32 id = 1;
  string email = 3;
  string phone = 4;
}
```

**Avro:**
- Reader schema + writer schema resolution at deserialization
- Fields matched by name, not position
- Adding field: must have default (backward compatible)
- Removing field: removed field must have had default (forward compatible)
- Renaming: use `aliases` for compatibility

```json
{
  "type": "record", "name": "User",
  "fields": [
    {"name": "id", "type": "int"},
    {"name": "full_name", "type": "string", "aliases": ["name"], "default": ""}
  ]
}
```

**JSON (with JSON Schema):**
- No built-in evolution — schema is external and optional
- `additionalProperties: true` (default) enables forward compatibility
- Use `required` sparingly — every required field is a future migration burden
- Versioning: URL path (`/v2/users`), header, or envelope (`{"version": 2, ...}`)

### Compatibility Comparison

| Feature | Protobuf | Avro | Thrift | JSON Schema |
|---------|----------|------|--------|-------------|
| Schema required? | Yes (.proto) | Yes (JSON/IDL) | Yes (.thrift) | Optional |
| Forward compatible? | Yes (skip unknown tags) | Yes (schema resolution) | Yes (skip unknown tags) | Only with `additionalProperties` |
| Backward compatible? | Yes (defaults for missing) | Yes (defaults required) | Yes (defaults for missing) | Manual handling |
| Human readable wire format? | No | No | No (binary) / Yes (JSON protocol) | Yes |
| Schema in payload? | No (tags only) | Writer schema or ID | No (tags only) | No |

---

## Schema Registry Deep Dive

### Architecture and Workflow

```
Producer → registers schema → Registry assigns ID
Producer → sends message: [magic:1B][schema_id:4B][payload]
Consumer → reads schema_id from message → fetches schema from Registry
Consumer → deserializes payload using fetched schema
```

### Confluent Schema Registry API

```bash
# Register schema → returns global ID
POST /subjects/{subject}/versions  →  {"id": 42}

# Fetch schema by ID
GET /schemas/ids/{id}  →  {"schema": "{...}"}

# Check compatibility before registering
POST /compatibility/subjects/{subject}/versions/latest  →  {"is_compatible": true}

# Set compatibility mode per subject
PUT /config/{subject}  →  {"compatibility": "FULL"}
```

### Compatibility Modes in Practice

```
BACKWARD (default): New schema reads old data. Consumer-first deploys.
FORWARD:            Old schema reads new data. Producer-first deploys.
FULL:               Both directions. Independent deployment safe.

*_TRANSITIVE variants: Check against ALL prior versions, not just last.
  Use when cold storage may contain very old schema versions.

NONE: No checking. Development only.
```

### Why Schema Registry Matters

```
Without registry:
  - Schema changes coordinated via tickets/Slack → deployment coupling
  - Bad schema change silently corrupts downstream data
  - No audit trail of schema history

With registry:
  - Schemas versioned and immutable once registered
  - Incompatible changes rejected automatically
  - Consumers cache schemas locally — registry not on hot path
```

---

## Encoding Performance Deep Dive

### Benchmark Comparison (Typical 1 KB Object)

| Format | Serialize | Deserialize | Encoded Size | Schema |
|--------|-----------|-------------|--------------|--------|
| JSON | ~100 MB/s | ~200 MB/s | 1000 B (baseline) | No |
| JSON+gzip | ~50 MB/s | ~80 MB/s | ~400 B | No |
| Protobuf | ~800 MB/s | ~1.5 GB/s | ~300 B | Yes |
| Avro | ~600 MB/s | ~1.0 GB/s | ~280 B | Yes |
| MessagePack | ~400 MB/s | ~800 MB/s | ~650 B | No |
| FlatBuffers | ~1.5 GB/s | Zero-copy | ~450 B | Yes |
| Cap'n Proto | Zero-copy | Zero-copy | ~500 B | Yes |

*Numbers are order-of-magnitude guidance; vary by language, hardware, and data shape.*

### Why Protobuf Is Fast

```
1. Varint encoding: Small integers use fewer bytes (1 → 1B, 300 → 2B)
2. No field names on wire: Tags are 1-2 byte ints vs repeating key strings
3. No parsing ambiguity: Types known at compile time from schema
4. Generated code: Direct field access, no reflection or hash map lookups
```

### Zero-Copy Formats: When Parsing Is the Bottleneck

```
FlatBuffers (Google): Access fields directly from buffer, no deserialization.
Cap'n Proto (by Protobuf creator): Zero-copy + built-in RPC system.

Use when:
  - Reading millions of records, accessing 1-2 fields each
  - Memory-mapped file access, latency-sensitive IPC

Avoid when:
  - Data crosses network boundaries (alignment/endianness concerns)
  - Need maximum compression (zero-copy formats are larger)
```

---

## Choosing an Encoding Format

### Decision Tree

```
Human readability needed?        → JSON (or YAML for config)
Schema evolution critical?       → Protobuf or Avro
  ├─ Kafka ecosystem?            → Avro + Schema Registry
  └─ gRPC / internal RPC?        → Protobuf
Browser-facing API?              → JSON
High-performance IPC?            → FlatBuffers or Cap'n Proto
Analytical storage?              → Parquet or ORC (see 06-column-storage.md)
JSON-like flexibility, smaller?  → MessagePack or CBOR
```

### Common Patterns in Practice

```
Typical microservice architecture:
  External API:    JSON over REST / GraphQL
  Internal RPC:    Protobuf over gRPC
  Event streaming: Avro + Schema Registry (Kafka)
  Configuration:   YAML or JSON
  Analytics:       Parquet in object storage
```

### Anti-Patterns to Avoid

```
JSON for internal service-to-service at scale:
  Parsing overhead compounds across 10+ hops → use Protobuf/gRPC.

Custom binary format:
  No evolution, no tooling, maintenance burden → use established formats.

Protobuf without schema versioning:
  Nobody knows which .proto produced old data → use Schema Registry.

required fields everywhere:
  Can never be removed without breaking readers → prefer optional + defaults.
```

---

## Key Takeaways

1. **JSON for readability** - Debug-friendly, universal
2. **Protobuf for efficiency** - Compact, fast, typed
3. **Avro for batch processing** - Schema in data, Hadoop-friendly
4. **Schema evolution is critical** - Plan for change
5. **Field tags enable evolution** - Don't reuse numbers
6. **Compatibility is bidirectional** - Forward and backward
7. **Zero-copy for performance** - FlatBuffers, Cap'n Proto
8. **Schema Registry for coordination** - Centralized schema management
