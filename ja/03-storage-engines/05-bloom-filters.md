# ブルームフィルタ

> この記事は英語版から翻訳されました。最新版は[英語版](/03-storage-engines/05-bloom-filters.md)をご覧ください。

## TL;DR

ブルームフィルタは、集合のメンバーシップテストのための確率的データ構造です。実際の要素を格納するよりもはるかに少ないメモリで、「確実に集合に含まれない」または「おそらく集合に含まれる」を判定できます。偽陽性（false positive）は発生しますが、偽陰性（false negative）は発生しません。データベースやキャッシュでの不要なディスク読み取りの回避に不可欠です。

---

## 問題

### コストの高いルックアップ

```
Query: Does key "xyz" exist?

Without Bloom filter:
  Check each SSTable on disk
  Multiple disk reads per lookup
  Slow for non-existent keys

With Bloom filter:
  Check in-memory filter first
  "Definitely not there" → skip disk read
  "Maybe there" → check disk

90%+ of disk reads avoided for negative lookups
```

---

## 仕組み

### 構造

```
Bit array of m bits, initially all 0

┌─────────────────────────────────────────┐
│ 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 │
└─────────────────────────────────────────┘
  0 1 2 3 4 5 6 7 8 9 ...

k hash functions: h₁, h₂, h₃, ...
Each maps element to a bit position
```

### 要素の追加

```
Insert "hello":
  h₁("hello") = 3
  h₂("hello") = 7
  h₃("hello") = 12

Set bits 3, 7, 12 to 1

┌─────────────────────────────────────────┐
│ 0 0 0 1 0 0 0 1 0 0 0 0 1 0 0 0 0 0 0 0 │
└─────────────────────────────────────────┘
        ↑       ↑         ↑
        3       7         12
```

### メンバーシップテスト

```
Query "hello":
  h₁("hello") = 3  → bit 3 is 1 ✓
  h₂("hello") = 7  → bit 7 is 1 ✓
  h₃("hello") = 12 → bit 12 is 1 ✓
  All bits set → "probably yes"

Query "world":
  h₁("world") = 5  → bit 5 is 0 ✗
  At least one bit is 0 → "definitely no"
```

### 偽陽性

```
After many insertions:
┌─────────────────────────────────────────┐
│ 1 0 1 1 0 1 1 1 0 1 0 1 1 0 1 1 0 1 0 1 │
└─────────────────────────────────────────┘

Query "never_inserted":
  h₁("never_inserted") = 3  → bit 3 is 1 ✓
  h₂("never_inserted") = 6  → bit 6 is 1 ✓
  h₃("never_inserted") = 11 → bit 11 is 1 ✓
  All bits set by OTHER elements!
  → False positive: "probably yes" but actually no
```

---

## 数学

### 偽陽性確率

```
m = number of bits
n = number of elements
k = number of hash functions

After inserting n elements:
  Probability a bit is 0: (1 - 1/m)^(kn) ≈ e^(-kn/m)

False positive probability:
  p = (1 - e^(-kn/m))^k
```

### 最適なパラメータ

```
Given n elements and desired false positive rate p:

Optimal bits: m = -n × ln(p) / (ln(2))²
Optimal hash functions: k = (m/n) × ln(2)

Example: n=1 million, p=1%
  m = -1,000,000 × ln(0.01) / (ln(2))² ≈ 9.6 million bits
  k = (9.6M/1M) × ln(2) ≈ 7 hash functions

  ~1.2 MB for 1 million elements with 1% false positive rate
```

### 要素あたりのビット数

```
For p = 1%:   ~10 bits per element
For p = 0.1%: ~15 bits per element
For p = 0.01%: ~20 bits per element

Each ~0.7 additional bits per element → halve false positive rate
```

---

## 実装

### 基本的な実装

```python
import mmh3  # MurmurHash3

class BloomFilter:
    def __init__(self, expected_elements, fp_rate):
        self.size = self._optimal_size(expected_elements, fp_rate)
        self.hash_count = self._optimal_hash_count(self.size, expected_elements)
        self.bit_array = bytearray((self.size + 7) // 8)

    def _optimal_size(self, n, p):
        return int(-n * math.log(p) / (math.log(2) ** 2))

    def _optimal_hash_count(self, m, n):
        return int((m / n) * math.log(2))

    def _hash(self, item, seed):
        return mmh3.hash(str(item), seed) % self.size

    def add(self, item):
        for i in range(self.hash_count):
            idx = self._hash(item, i)
            self.bit_array[idx // 8] |= (1 << (idx % 8))

    def might_contain(self, item):
        for i in range(self.hash_count):
            idx = self._hash(item, i)
            if not (self.bit_array[idx // 8] & (1 << (idx % 8))):
                return False  # Definitely not present
        return True  # Probably present
```

### 2つのハッシュ関数の使用

```python
# Optimization: Use only 2 hash functions
# Combine them to create k hash functions

def hash_i(item, i, h1, h2, m):
    return (h1 + i * h2) % m

h1 = hash(item)
h2 = hash2(item)

for i in range(k):
    idx = hash_i(item, i, h1, h2, m)
    # use idx
```

---

## バリエーション

### カウンティングブルームフィルタ

ビットをカウンタに置き換えます。

```
Standard:   [0][1][0][1][1][0]  (bits)
Counting:   [0][2][0][1][3][0]  (counters, e.g., 4-bit)

Supports deletion:
  add("x")    → increment positions
  remove("x") → decrement positions

Trade-off: 4x+ more space
```

### スケーラブルブルームフィルタ

要素数が不明な場合に対応します。

```
Start with small filter
When too full (high FP rate):
  Create new, larger filter
  New elements go to new filter
  Query checks all filters

Maintains target FP rate as data grows
```

### カッコウフィルタ

より優れた特性を持つ代替手法です。

```
Supports deletion (without counting)
Better space efficiency at <3% FP rate
Similar lookup speed

Structure: Hash table with cuckoo hashing
Stores fingerprints (not bits)
```

### クォーシェントフィルタ

キャッシュフレンドリーな代替手法です。

```
Good locality of reference
Supports deletion and merging
Slightly higher memory than Bloom

Stores quotient and remainder of hash
Uses linear probing
```

---

## ユースケース

### データベース / LSM木

```
Each SSTable has a Bloom filter
Before reading SSTable from disk:
  if bloom_filter.might_contain(key):
      read_sstable()  # ~1% false positive
  else:
      skip()  # Definitely not there

Huge savings for point lookups
```

### 分散システム

```
Cache stampede prevention:
  Before expensive computation:
    if bloom_filter.might_contain(request):
        might_be_in_cache = True
    else:
        definitely_not_cached = True

Routing decisions:
  Which server has this data?
  Check each server's Bloom filter
```

### Webクローラー

```
Have we seen this URL before?
  if bloom_filter.might_contain(url):
      # Probably seen, skip or verify in DB
  else:
      # New URL, definitely crawl

Billions of URLs with modest memory
```

### スペルチェッカー

```
Is this a valid word?
  if dictionary_bloom.might_contain(word):
      # Probably valid
  else:
      # Definitely misspelled

Fast first-pass check
```

### CDN / キャッシング

```
Is this content in cache?
  if cache_bloom.might_contain(content_id):
      check_actual_cache()
  else:
      fetch_from_origin()

Avoid cache misses going to disk
```

---

## 運用上の考慮事項

### サイジングガイドライン

```
Too small:
  - High false positive rate
  - Defeats the purpose

Too large:
  - Wasted memory
  - Possibly slower (cache misses)

Rule of thumb:
  10 bits per element → ~1% FP
  15 bits per element → ~0.1% FP
```

### メモリ計算

```
For 10 million keys with 1% FP:
  Bits needed: 10M × 10 = 100M bits = 12.5 MB
  Hash functions: ~7

For 1 billion keys with 0.1% FP:
  Bits needed: 1B × 15 = 15B bits = 1.875 GB
  Hash functions: ~10
```

### シリアライゼーション

```python
# Save to disk
def save(self, filename):
    with open(filename, 'wb') as f:
        f.write(struct.pack('II', self.size, self.hash_count))
        f.write(self.bit_array)

# Load from disk
@classmethod
def load(cls, filename):
    with open(filename, 'rb') as f:
        size, hash_count = struct.unpack('II', f.read(8))
        bit_array = bytearray(f.read())
    # Reconstruct filter
```

### フィルタのマージ

```
Two Bloom filters with same size and hash functions:
  merged = filter1.bit_array | filter2.bit_array

Result contains union of elements
FP rate increases
```

---

## 制限事項

### 削除不可（標準版）

```
Why can't we delete?
  Element A sets bits: 3, 7, 12
  Element B sets bits: 3, 8, 15

Delete A: Clear bits 3, 7, 12
  But bit 3 was also set by B!
  Now B shows "not present" → false negative!

Use counting Bloom filter if deletion needed
```

### 列挙不可

```
Cannot list elements in filter
Filter only answers: "Is X present?"
To enumerate, need separate storage
```

### 偽陽性率の増加

```
As filter fills up:
  More bits set
  Higher FP rate

If n grows beyond expected:
  FP rate degrades
  Need to resize (rebuild with larger filter)
```

---

## 実際のシステムでのブルームフィルタ

### RocksDB

```
Per-SST bloom filter. Each SSTable file gets its own bloom filter stored
in the file's metadata block.

Configuration: bits_per_key (default 10 → ~1% FPR)
  options.filter_policy.reset(NewBloomFilterPolicy(10));

Impact:
  - Point lookup on non-existent key: 1 bloom check vs reading index + data block
  - Reduces read amplification by ~100× for negative lookups
  - Full filter (not block-based) avoids index lookup to find filter block
  - Bloom filter is loaded into block cache on first access

Tuning:
  - bits_per_key = 10 → good default for most workloads
  - bits_per_key = 15-20 → for workloads with many point lookups on missing keys
  - Bloom filters do NOT help range scans — only point lookups (Get/MultiGet)
```

### Cassandra

```
Partition-level bloom filter. One filter per SSTable, keyed on partition key.

Configuration: bloom_filter_fp_chance per table (default 0.01)
  ALTER TABLE users WITH bloom_filter_fp_chance = 0.001;

Guidelines:
  - Read-heavy table (95%+ reads): set to 0.001 — memory cost is marginal
  - Write-heavy table (high compaction): set to 0.1 — saves memory, writes
    will naturally consolidate SSTables
  - Counter tables: default 0.01 is fine
  - Tables accessed primarily by range scan: set to 1.0 to disable entirely

Memory impact:
  bloom_filter_fp_chance = 0.01 → ~10 bits/partition key
  bloom_filter_fp_chance = 0.001 → ~15 bits/partition key
  Monitor via nodetool tablestats → "Bloom filter space used"
```

### HBase

```
Per-StoreFile bloom filter. Configurable granularity per column family.

Schema configuration:
  create 'my_table', {NAME => 'cf', BLOOMFILTER => 'ROW'}

Granularity options:
  NONE       — no bloom filter
  ROW        — bloom on row key (default, best for row-level gets)
  ROWCOL     — bloom on row + column qualifier (for wide rows with column gets)

ROW vs ROWCOL:
  ROW:    good when you read entire rows, 1 entry per row
  ROWCOL: good when you read specific columns from wide rows,
          1 entry per (row, column) pair — more memory, fewer false positives
```

### PostgreSQL

```
No built-in bloom filter for heap tables, but the bloom extension provides
multi-column bloom indexes.

  CREATE EXTENSION bloom;
  CREATE INDEX idx_bloom ON orders USING bloom (customer_id, product_id)
    WITH (length=80, col1=2, col2=4);

Use case: ad-hoc queries filtering on arbitrary column combinations.
Traditional B-tree index only helps if query matches the leftmost prefix.
Bloom index handles any subset of indexed columns.

Trade-off: higher false positive rate than B-tree (requires recheck),
but single index covers all column combinations.
```

### Redis（RedisBloomモジュール）

```
Server-side bloom filter via BF.* commands.

  BF.RESERVE usernames 0.001 1000000    # 0.1% FPR, 1M capacity
  BF.ADD usernames "alice"
  BF.EXISTS usernames "alice"           # → 1
  BF.EXISTS usernames "bob"             # → 0

  BF.MADD usernames "bob" "charlie"     # bulk insert
  BF.MEXISTS usernames "bob" "dave"     # bulk check

Auto-scaling: BF.ADD without BF.RESERVE creates a default filter (capacity
100, FPR 0.01) that scales automatically via sub-filters.

Use case: rate limiting, username uniqueness pre-check, deduplication
in streaming pipelines.
```

---

## ブルームフィルタのバリエーション

### カウンティングブルームフィルタ

```
Replaces single bits with n-bit counters (typically 4 bits).

  Add:    increment counters at hash positions
  Delete: decrement counters at hash positions
  Query:  check all counters > 0

Trade-offs:
  + Supports deletion
  - 4× more memory (4 bits per counter vs 1 bit)
  - Counter overflow risk with 4-bit counters (max 15)
  - Rarely used in production — cuckoo filter is usually better for deletion
```

### カッコウフィルタ

```
Uses cuckoo hashing with fingerprints stored in a hash table.

  Insert: store fingerprint at one of two candidate buckets
          if both full, evict an existing entry and relocate it
  Delete: remove fingerprint from its bucket
  Query:  check both candidate buckets for fingerprint

Trade-offs:
  + Supports deletion without extra memory overhead
  + Better space efficiency than counting bloom at FPR < 3%
  + Constant-time lookups (check exactly 2 buckets)
  - Insertion can fail at high load factor (>95%)
  - Duplicate insertions require tracking (same item inserted twice)
```

### リボンフィルタ（RocksDB）

```
Newer filter designed for static datasets (write-once, read-many).
Used in RocksDB since v6.15 as an alternative to standard bloom.

  How: solves a system of linear equations over GF(2) during construction
  Result: ~30% more space-efficient than standard bloom for same FPR

Trade-offs:
  + 30% smaller than standard bloom at same FPR
  + Same query speed as standard bloom
  - 3-4× slower to build (acceptable for SSTable write path)
  - Not suitable for dynamic sets (no incremental add)

RocksDB usage:
  options.filter_policy.reset(NewRibbonFilterPolicy(10));
```

### クォーシェントフィルタ

```
Cache-friendly alternative using open addressing.

  Stores quotient and remainder of hash in a compact hash table.
  Uses linear probing — sequential memory access pattern.

Trade-offs:
  + Cache-friendly (sequential access, good for CPU cache lines)
  + Supports merging two filters (useful for LSM compaction)
  + Supports deletion and resizing
  - ~10-25% more space than standard bloom for same FPR
  - More complex implementation
```

### 比較表

```
┌─────────────────┬──────────┬──────────────────┬────────────┬─────────────┐
│ Filter          │ Deletion │ Space Efficiency  │ Build Time │ Query Time  │
├─────────────────┼──────────┼──────────────────┼────────────┼─────────────┤
│ Standard Bloom  │ No       │ Baseline         │ Fast       │ O(k)        │
│ Counting Bloom  │ Yes      │ 3-4× worse       │ Fast       │ O(k)        │
│ Cuckoo Filter   │ Yes      │ Better at <3% FPR│ Fast       │ O(1)        │
│ Ribbon Filter   │ No       │ 30% better       │ 3-4× slower│ O(k)        │
│ Quotient Filter │ Yes      │ 10-25% worse     │ Fast       │ Amortized   │
└─────────────────┴──────────┴──────────────────┴────────────┴─────────────┘

Selection guide:
  - Default choice for storage engines → Standard Bloom or Ribbon
  - Need deletion → Cuckoo filter
  - Need merging (e.g., compaction) → Quotient filter
  - Need deletion + memory constrained → Cuckoo filter (not counting bloom)
```

---

## ブルームフィルタのサイジング

### 基本の公式

```
Given:
  n = expected number of elements
  p = desired false positive rate (e.g., 0.01 for 1%)

Optimal bit array size:
  m = -(n × ln(p)) / (ln(2))²

Optimal number of hash functions:
  k = (m / n) × ln(2)
```

### 計算例

```
Goal: Store 10 million elements with 1% false positive rate

Step 1 — Compute m (bits):
  m = -(10,000,000 × ln(0.01)) / (ln(2))²
  m = -(10,000,000 × (-4.605)) / (0.4805)
  m = 95,850,584 bits ≈ 95.9M bits ≈ 12 MB

Step 2 — Compute k (hash functions):
  k = (95,850,584 / 10,000,000) × ln(2)
  k = 9.585 × 0.693
  k ≈ 6.64 → round to 7 hash functions

Result: 12 MB of memory, 7 hash functions, 1% FPR
  Compare: storing 10M 64-byte keys directly = 640 MB
  Bloom filter uses ~53× less memory
```

### 異なるFPR目標でのメモリ使用量

```
┌──────────────────┬──────────────────┬────────────────────────┬───────────┐
│ Target FPR       │ Bits per Element │ Memory for 10M entries │ k (hashes)│
├──────────────────┼──────────────────┼────────────────────────┼───────────┤
│ 10%   (0.1)      │  4.8 bits        │  6.0 MB                │  3        │
│ 1%    (0.01)     │  9.6 bits        │ 12.0 MB                │  7        │
│ 0.1%  (0.001)    │ 14.4 bits        │ 18.0 MB                │ 10        │
│ 0.01% (0.0001)   │ 19.2 bits        │ 24.0 MB                │ 13        │
│ 0.001%(0.00001)  │ 24.0 bits        │ 30.0 MB                │ 17        │
└──────────────────┴──────────────────┴────────────────────────┴───────────┘

Key insight: each additional 4.8 bits/element buys you one order of magnitude
improvement in false positive rate. Diminishing returns beyond 0.01%.
```

### 実用的なサイジングチェックリスト

```
1. Estimate n conservatively — overcount by 20-30% for growth headroom
2. Pick p based on workload:
   - Read-heavy, point lookups → 0.01 (1%) is usually fine
   - Expensive downstream operations → 0.001 (0.1%) worth the extra memory
   - Cheap downstream operations → 0.1 (10%) saves memory
3. Verify m fits in memory budget
4. Round k to nearest integer — off-by-one has negligible impact
```

---

## 本番環境での落とし穴

### サイズ不足のブルームフィルタ

```
Symptom: FPR climbs well above configured target
Cause:   more elements inserted than planned capacity (n)

Example:
  Filter sized for 1M elements at 1% FPR
  Actually inserted 5M elements
  Effective FPR: ~18% — filter is nearly useless

Fix: monitor actual FPR → (false positives / total negative queries)
  If actual FPR > 2× target, rebuild with larger capacity.
  Proactive: size for 1.5-2× expected growth from the start.
```

### ハッシュ関数の品質

```
Poor hash functions produce correlated bit positions.
Effective FPR becomes much worse than theoretical.

Bad choices:
  - MD5 / SHA-256: cryptographic, slow, overkill — not designed for bloom
  - Java .hashCode(): poor avalanche properties, correlated outputs
  - Simple modular hashing: clustering

Good choices:
  - MurmurHash3: fast, excellent distribution, standard in most systems
  - xxHash: fastest option, good distribution, used in newer systems
  - CityHash/FarmHash: Google's family, excellent for strings

Double hashing technique:
  Compute h1 and h2 once, derive k hashes as h_i = h1 + i × h2
  Proven to preserve theoretical FPR guarantees (Kirsch & Mitzenmacher, 2006)
```

### スケール時のメモリプレッシャー

```
Bloom filters live in memory for fast access. At scale, they add up.

Example budget:
  100 GB dataset, average key size 64 bytes → ~1.6B keys
  10 bits/key bloom filter = 16 Gbit = 2 GB of bloom filters
  That's 2 GB of memory just for bloom filters

Mitigation:
  - Tiered bloom filters: keep L0-L1 bloom filters in memory, load
    deeper levels on demand from block cache
  - RocksDB: bloom filters stored in block cache, subject to eviction
  - Cassandra: bloom filters loaded at startup, monitor heap usage
    via nodetool tablestats

Rule of thumb: budget 1-2% of dataset size for bloom filters at 1% FPR
```

### リサイズ後の偽陰性

```
Standard bloom filters CANNOT be resized in place.

If dataset grows beyond planned capacity:
  1. FPR degrades silently (no error, just more false positives)
  2. Must rebuild: create new larger filter, re-insert all elements
  3. Rebuilding requires access to all original elements (or re-scan data)

Alternatives for growing datasets:
  - Scalable Bloom Filter (SBF): chain of filters with tightening FPR
    Each new sub-filter uses stricter p to keep aggregate FPR bounded
  - Partitioned approach: one bloom filter per partition/SSTable
    As new SSTables are created, each gets a correctly sized filter
    (This is exactly what LSM-tree storage engines do)
```

### ブルームフィルタの有効性モニタリング

```
Key metrics to track:

  1. Bloom filter hit rate = true negatives / total queries
     - "How often does the filter save a disk read?"
     - Healthy: >90% for workloads with many missing-key lookups
     - Low hit rate → workload is mostly positive lookups, filter adds overhead

  2. Actual FPR = false positives / (false positives + true negatives)
     - Compare against configured FPR
     - Significantly higher → filter is overfull, needs rebuild

  3. Useful reads saved = bloom true negatives × avg disk read cost
     - Quantifies the value of the bloom filter in latency or IOPS terms

  4. Memory overhead ratio = bloom filter memory / total memory budget
     - Keep under 5% of total memory as a guideline

RocksDB exposes: rocksdb.bloom.filter.useful, rocksdb.bloom.filter.full.positive
Cassandra exposes: BloomFilterFalsePositives, BloomFilterFalseRatio per table
```

---

## RocksDBの設定

```cpp
Options options;
options.filter_policy.reset(NewBloomFilterPolicy(
    10,    // bits per key
    false  // use full filter (not block-based)
));
```

### Cassandraの設定

```yaml
# In table schema
bloom_filter_fp_chance: 0.01  # 1% false positive rate

# Trade-off:
# Lower FP → more memory, fewer disk reads
# Higher FP → less memory, more disk reads
```

### Redis

```
# Using RedisBloom module
BF.ADD myfilter item1
BF.EXISTS myfilter item1  # Returns 1
BF.EXISTS myfilter item2  # Returns 0 (definitely not)
```

---

## 比較

| 構造 | 空間 | ルックアップ | 挿入 | 削除 | FP率 |
|------|------|------------|------|------|------|
| HashSet | O(n) | O(1) | O(1) | O(1) | 0% |
| ブルームフィルタ | O(n) bits | O(k) | O(k) | 不可 | 約1% |
| カウンティングブルーム | O(n) × 4 | O(k) | O(k) | O(k) | 約1% |
| カッコウフィルタ | O(n) bits | O(1) | O(1)* | O(1) | 約1% |

*カッコウフィルタの挿入はリハッシュが必要な場合があります

---

## 重要なポイント

1. **偽陽性はあるが偽陰性はない** - 「おそらくはい」または「確実にいいえ」
2. **1%のFPに要素あたり10ビット** - シンプルなサイジングルール
3. **LSM木に不可欠** - ディスク読み取りを回避します
4. **カウンタなしでは削除不可** - 標準ブルームフィルタは挿入専用です
5. **空間効率の良い集合近似** - ビット vs 完全な要素
6. **ORでマージ** - フィルタの和集合は簡単です
7. **事前にサイズを決定** - リビルドなしではリサイズできません
8. **削除にはカッコウフィルタ** - 現代的な代替手法
