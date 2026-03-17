# データエンコーディング

> この記事は英語版から翻訳されました。最新版は[英語版](/03-storage-engines/07-data-encoding.md)をご覧ください。

## TL;DR

データエンコーディングは、メモリ上のデータ構造をバイト列にシリアライズし、ストレージや通信に利用できるようにします。トレードオフに基づいて選択してください：人間が読みやすいものならJSON/XML、効率性とスキーマ進化ならProtocol Buffers/Thrift、動的スキーマならAvroです。スキーマ進化は長期運用システムにとって重要であり、前方互換性と後方互換性が破壊的変更を防ぎます。

---

## エンコーディングが重要な理由

### 変換の問題

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

### 主要な検討事項

```
1. Efficiency: Size and speed
2. Schema evolution: Can we change the structure?
3. Human readability: Debug-friendly?
4. Language support: Cross-platform?
5. Compatibility: Forward and backward?
```

---

## テキストベースフォーマット

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

**メリット：**
- 人間が読みやすい
- あらゆる言語でサポート
- 自己記述的（キー名が含まれる）
- 柔軟（スキーマ不要）

**デメリット：**
- 冗長（キー名の繰り返し）
- バイナリデータ非対応（base64が必要）
- 数値が曖昧（intかfloatか）
- スキーマの強制なし

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

**メリット：**
- 人間が読みやすい
- 豊富なスキーマサポート（XSD）
- 名前空間による構成

**デメリット：**
- 非常に冗長
- パース処理が複雑
- 他の方式より低速

### サイズ比較

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

## バイナリフォーマット

### Protocol Buffers (Protobuf)

スキーマ定義（`.proto`）:
```protobuf
message User {
  int32 id = 1;
  string name = 2;
  repeated string emails = 3;
  bool active = 4;
  double balance = 5;
}
```

ワイヤフォーマット:
```
Field 1 (id): [tag: 08][value: 7B]  // 123 in varint
Field 2 (name): [tag: 12][length: 05][data: Alice]
Field 3 (emails): [tag: 1A][length: 0D][data: a@example.com]
...
```

**メリット：**
- コンパクトなバイナリフォーマット
- 強い型付け
- スキーマ進化のサポート
- 高速なシリアライゼーション
- コード自動生成

**デメリット：**
- 人間が読めない
- スキーマが必要
- フィールドタグは一意でなければならない

### Thrift

Protobufと似ており、Facebook製です。

```thrift
struct User {
  1: i32 id,
  2: string name,
  3: list<string> emails,
  4: bool active,
  5: double balance
}
```

複数のプロトコル：
- Binary（コンパクト）
- Compact（より小さい）
- JSON（可読性あり）

### Avro

スキーマ:
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

**主な違い：** ワイヤフォーマットにフィールドタグがありません。
- 読み取り時にスキーマが必要
- より小さなペイロード
- バッチ処理（Hadoop）に最適

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

## スキーマ進化

### 問題

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

### 互換性の種類

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

### Protobuf の進化ルール

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

**ルール：**
- フィールド番号を再利用しない
- 新しい番号でフィールドを追加する
- `optional` または `repeated` を使用する（`required` は使わない）
- 削除したフィールドの番号は予約する

### Avro の進化

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

Avroはスキーマ解決を使用します：
- ライタースキーマが埋め込みまたは既知
- リーダースキーマはアプリケーションが指定
- フィールドは名前でマッチング

---

## フィールド識別

### タグ番号による識別（Protobuf、Thrift）

```
Wire format includes field tag:
  [tag=1, value=123][tag=2, value="Alice"]

Old reader sees unknown tag:
  [tag=3, value="new@email.com"]
  → Skip (knows length from type)

Robust to additions
```

### 位置による識別（Avro）

```
Wire format: [value1][value2][value3]
No tags, just values in order

Reader and writer must agree on schema
Schema resolution matches fields by name
Smaller than tagged formats
```

### 名前による識別（JSON）

```
{"id": 123, "name": "Alice"}

Field names repeated in every record
Verbose but self-describing
```

---

## エンコーディングのパフォーマンス

### ベンチマーク（概算値）

| フォーマット | エンコード | デコード | サイズ |
|--------|--------|--------|------|
| JSON | 100 MB/s | 200 MB/s | 100% |
| Protobuf | 500 MB/s | 1 GB/s | 30% |
| Avro | 400 MB/s | 800 MB/s | 25% |
| MessagePack | 300 MB/s | 600 MB/s | 60% |
| FlatBuffers | N/A* | 10 GB/s | 40% |

*FlatBuffers: ゼロコピー、デコードステップなし

### ゼロコピーフォーマット

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

## データベースのエンコーディング

### 行ベース

```
PostgreSQL row:
  [header][null bitmap][col1][col2][col3]

Fixed columns at fixed offsets
Variable-length columns use length prefix
```

### カラムベース

```
Each column encoded separately:
  int column: [RLE or bit-packed integers]
  string column: [dictionary + indices]

Different encoding per column type
```

### ログ構造化

```
Key-value entry:
  [key_length][key][value_length][value][sequence][type]

Type: PUT or DELETE
Sequence: For ordering/versioning
```

---

## ネットワークプロトコルのエンコーディング

### HTTP API

```
Common choices:
  REST + JSON: Ubiquitous, human-friendly
  gRPC + Protobuf: Efficient, typed
  GraphQL + JSON: Flexible queries

JSON for external APIs
Protobuf for internal services
```

### RPCエンコーディング

```
gRPC:
  HTTP/2 + Protobuf
  Bidirectional streaming
  Generated clients

Thrift:
  Multiple transports (HTTP, raw TCP)
  Multiple protocols (binary, compact, JSON)
```

### イベントストリーミング

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

## スキーマレジストリ

### コンセプト

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

### 互換性の強制

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

## エンコーディングの選択

### 判断マトリクス

| 要件 | フォーマット |
|-------------|--------|
| 人間によるデバッグ | JSON |
| 最大効率 | Protobuf、FlatBuffers |
| Hadoop/Spark | Avro、Parquet |
| 外部API | JSON |
| 内部RPC | Protobuf、Thrift |
| スキーマの柔軟性 | JSON、MessagePack |
| 強い契約 | Protobuf、Avro |
| ゼロコピーアクセス | FlatBuffers、Cap'n Proto |

### 問うべき質問

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

## スキーマ進化の戦略

### デプロイコンテキストにおける互換性

```
Forward (old code reads new data):  Deploy producers first. Unknown fields skipped.
Backward (new code reads old data): Deploy consumers first. Missing fields defaulted.
Full (both directions):             Deploy independently. Rolling deploys demand this.
```

### フォーマット固有の進化ルール

**Protobuf:**
- 新しいタグで `optional` フィールドを追加 → 前方＋後方互換
- フィールド削除 → タグを永久に `reserved` にする
- `optional` から `repeated` への変更 → スカラー型では安全
- フィールドのタグ番号は絶対に変更しない — データが暗黙的に破損する

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
- デシリアライゼーション時にリーダースキーマ＋ライタースキーマで解決
- フィールドは位置ではなく名前でマッチング
- フィールド追加：デフォルト値が必要（後方互換）
- フィールド削除：削除するフィールドにデフォルト値が必要（前方互換）
- リネーム：互換性のために `aliases` を使用

```json
{
  "type": "record", "name": "User",
  "fields": [
    {"name": "id", "type": "int"},
    {"name": "full_name", "type": "string", "aliases": ["name"], "default": ""}
  ]
}
```

**JSON（JSON Schema使用時）:**
- 組み込みの進化機能なし — スキーマは外部でオプション
- `additionalProperties: true`（デフォルト）で前方互換性を有効化
- `required` は控えめに — 必須フィールドは将来のマイグレーション負担になる
- バージョニング：URLパス（`/v2/users`）、ヘッダー、またはエンベロープ（`{"version": 2, ...}`）

### 互換性の比較

| 機能 | Protobuf | Avro | Thrift | JSON Schema |
|---------|----------|------|--------|-------------|
| スキーマ必須？ | はい（.proto） | はい（JSON/IDL） | はい（.thrift） | オプション |
| 前方互換？ | はい（未知のタグをスキップ） | はい（スキーマ解決） | はい（未知のタグをスキップ） | `additionalProperties` のみ |
| 後方互換？ | はい（不足分はデフォルト） | はい（デフォルト必須） | はい（不足分はデフォルト） | 手動対応 |
| ワイヤフォーマットが人間可読？ | いいえ | いいえ | いいえ（バイナリ）/はい（JSONプロトコル） | はい |
| ペイロード内にスキーマ？ | いいえ（タグのみ） | ライタースキーマまたはID | いいえ（タグのみ） | いいえ |

---

## スキーマレジストリの詳細

### アーキテクチャとワークフロー

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

### 実践における互換性モード

```
BACKWARD (default): New schema reads old data. Consumer-first deploys.
FORWARD:            Old schema reads new data. Producer-first deploys.
FULL:               Both directions. Independent deployment safe.

*_TRANSITIVE variants: Check against ALL prior versions, not just last.
  Use when cold storage may contain very old schema versions.

NONE: No checking. Development only.
```

### スキーマレジストリが重要な理由

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

## エンコーディングパフォーマンスの詳細

### ベンチマーク比較（典型的な1KBオブジェクト）

| フォーマット | シリアライズ | デシリアライズ | エンコードサイズ | スキーマ |
|--------|-----------|-------------|--------------|--------|
| JSON | ~100 MB/s | ~200 MB/s | 1000 B（基準） | なし |
| JSON+gzip | ~50 MB/s | ~80 MB/s | ~400 B | なし |
| Protobuf | ~800 MB/s | ~1.5 GB/s | ~300 B | あり |
| Avro | ~600 MB/s | ~1.0 GB/s | ~280 B | あり |
| MessagePack | ~400 MB/s | ~800 MB/s | ~650 B | なし |
| FlatBuffers | ~1.5 GB/s | ゼロコピー | ~450 B | あり |
| Cap'n Proto | ゼロコピー | ゼロコピー | ~500 B | あり |

*数値はオーダー（桁数）の目安です。言語、ハードウェア、データ形状により異なります。*

### Protobuf が高速な理由

```
1. Varint encoding: Small integers use fewer bytes (1 → 1B, 300 → 2B)
2. No field names on wire: Tags are 1-2 byte ints vs repeating key strings
3. No parsing ambiguity: Types known at compile time from schema
4. Generated code: Direct field access, no reflection or hash map lookups
```

### ゼロコピーフォーマット：パースがボトルネックの場合

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

## エンコーディングフォーマットの選択

### 判断ツリー

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

### 実践における一般的なパターン

```
Typical microservice architecture:
  External API:    JSON over REST / GraphQL
  Internal RPC:    Protobuf over gRPC
  Event streaming: Avro + Schema Registry (Kafka)
  Configuration:   YAML or JSON
  Analytics:       Parquet in object storage
```

### 避けるべきアンチパターン

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

## まとめ

1. **可読性ならJSON** - デバッグしやすく、ユニバーサル
2. **効率性ならProtobuf** - コンパクトで高速、型付き
3. **バッチ処理ならAvro** - データにスキーマを含み、Hadoop向き
4. **スキーマ進化は不可欠** - 変更に備えた設計を
5. **フィールドタグが進化を可能にする** - 番号を再利用しない
6. **互換性は双方向** - 前方と後方の両方
7. **パフォーマンスにはゼロコピー** - FlatBuffers、Cap'n Proto
8. **スキーマレジストリで連携** - 一元的なスキーマ管理
