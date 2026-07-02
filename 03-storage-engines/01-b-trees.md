# B-Trees

## TL;DR

The B-tree is the default index structure of nearly every OLTP database, and it has survived 50+ years for one reason: it matches the shape of the memory hierarchy. A tree of page-sized nodes with fanout in the hundreds keeps a billion keys reachable in 4 page reads — of which 3 are usually cached, so a point lookup costs one disk I/O or none. The parts the textbook picture omits are where production behavior lives: B-trees are really *buffer-pool structures* (a "disk read" is usually a memory read plus bookkeeping); write amplification is page-sized, not row-sized (a 100-byte update dirties a 8–16KB page, plus WAL, plus possibly a full-page image); concurrent access is governed by latch protocols (crabbing, optimistic descent, B-link sideways pointers) that determine multicore scalability; and key choice — sequential vs random — swings insert throughput and index size by integer factors. This chapter builds the cost model from the page up, covers splits/merges, concurrency, recovery interplay, PostgreSQL/InnoDB specifics, and the failure modes (bloat, UUID keys, over-indexing) that actually page people.

---

## The Cost Model: Pages, Fanout, and the Memory Hierarchy

Storage is read in pages, not bytes. A random read costs roughly the same whether you use 8 bytes of the page or all of it:

```
Access cost (order of magnitude):
  L1/L2 cache hit:      ~1-10 ns
  DRAM (buffer pool):   ~100 ns
  NVMe SSD random 4KB:  ~20-100 μs      (~1,000× DRAM)
  SATA SSD random:      ~100-200 μs
  HDD random (seek):    ~5-10 ms        (~100,000× DRAM)

Design consequence: the only number that matters for a disk-resident
index is PAGE READS PER OPERATION. Comparisons are free by comparison.
```

The B-tree's answer: make each node a full page, so each page read narrows the search by a factor of the *fanout* — the number of children per node — rather than a factor of 2:

```
Fanout arithmetic (8 KB page, ~16-byte keys + 8-byte child pointers):
  entries per internal page ≈ 8192 / 24 ≈ 340 → call it ~300

  Height 1:  ~300 keys
  Height 2:  ~90,000
  Height 3:  ~27,000,000
  Height 4:  ~8,100,000,000

A billion-row table is a 4-level tree. And the top of the tree is tiny:
  root:               1 page
  level 2:          ~300 pages   (~2.4 MB)
  level 3:       ~90,000 pages   (~700 MB)
→ root + level 2 always cached; level 3 mostly cached.
  A point lookup is typically 3 buffer-pool hits + at most 1 real I/O.
```

This is the whole game: **log_fanout(n) page accesses, of which almost all are cache hits because upper levels are microscopic relative to the data**. Binary search trees, skip lists, and hash tables lose on disk not because their asymptotics are worse but because their per-step narrowing factor doesn't pay for a page-sized I/O.

---

## Structure: B+-Trees, Since That's What Everyone Builds

What databases call a "B-tree" is almost always a **B+-tree**: values live only in the leaves; internal nodes hold routing keys and child pointers; leaves are chained with sibling pointers.

```
     ┌─────────────┐
     │  30  |  60   │                ← internal: routing keys only
     └──┬────┬────┬─┘
        ↓    ↓    ↓
   ┌──────┐ ┌──────┐ ┌──────┐
   │10|20 │→│30|40 │→│60|80 │       ← leaves: keys + values, sibling-linked
   └──────┘ └──────┘ └──────┘

Why values-only-in-leaves wins:
  1. Internal nodes stay small (key + pointer, no payload)
     → maximum fanout → minimum height
  2. Every lookup has identical depth → predictable latency
  3. Range scan = locate start leaf, then walk sibling pointers
     sequentially — no re-traversal
  4. Internal keys are only separators: they can be truncated to the
     shortest prefix that still routes correctly ("suffix truncation"),
     raising fanout further
```

The classical B-tree (values in every node) survives mainly in textbooks; SQLite uses it for index b-trees but B+ for tables, and everything else — PostgreSQL nbtree, InnoDB, SQL Server, Oracle, WiredTiger — is B+ with refinements.

### Inside a page: the slotted layout

```
┌──────────────────────────────────────────────────────┐
│ header │ slot array →   ...free space...   ← records │
└──────────────────────────────────────────────────────┘
  header: page LSN, record count, free-space pointers
  slots:  (offset, length) pairs, kept sorted by key
  records: variable-length, grow from the end

Binary search runs over the slot array (fixed-width, cache-friendly);
records never move on insert — only slots do. Deletion marks a slot
dead; space is reclaimed by in-page compaction when needed.
```

The page LSN in the header is the hook into [Write-Ahead Logging](./04-write-ahead-logging.md): recovery compares it against log records to decide which changes are already on the page — the mechanism that makes redo idempotent.

### Clustered vs. secondary: what a "value" is

```
Heap tables (PostgreSQL):
  index leaf holds (key → TID), a pointer into the heap
  every index on the table is equal; row lives in the heap

Clustered index (InnoDB, SQL Server default):
  the PRIMARY KEY B+-tree's leaves ARE the rows
  secondary index leaves hold (key → primary key value)
  → secondary lookup = two B-tree descents (secondary, then PK)
  → a fat primary key silently fattens EVERY secondary index
```

That last line is a recurring production surprise: a 36-byte UUID-string primary key in InnoDB adds 36 bytes to every entry of every secondary index on the table.

---

## Operations, and Where the Cost Actually Is

### Search and range scan

```
Point lookup:  descend root → leaf, binary search each page
  cost = height page accesses ≈ 3-4, nearly all cached

Range scan [a, b):  descend to leaf containing a,
  then walk sibling pointers until b
  cost = height + ⌈K / entries_per_leaf⌉ sequential page reads
  — sequential after the seek, which is why B-trees serve
    ORDER BY ... LIMIT and time-range queries so well
```

### Insert and the split cascade

```
insert(k, v):
  descend to leaf; if room → write into page (common case: 1 dirty page)
  if full → SPLIT:
    allocate new page, move upper half of entries there,
    insert separator key into parent
    if parent full → split parent … possibly up to the root
    root split → tree grows one level (the ONLY way height increases,
    which is why B-trees stay balanced with no rebalancing pass)
```

Two facts keep splits cheap in aggregate. First, they're rare: a leaf absorbs on the order of `entries_per_leaf / 2` inserts between splits, so amortized cost per insert is a fraction of a page write. Second, engines special-case the pattern that would be worst: **rightmost splits for sequential keys**. Inserting monotonically increasing keys always hits the rightmost leaf; a naive half split would leave a trail of half-empty pages. Instead, engines split "at the insertion point" (PostgreSQL's fastpath, InnoDB's sequential-insert heuristic), leaving left pages ~full and packing the index to 90%+ density for append-only keys.

```
Split economics, 8 KB leaves, ~150 entries/leaf:

  Sequential keys (timestamps, sequences):
    splits only at right edge, pages left ~100% full
    index density ~90-100%, minimal page count

  Random keys (UUIDv4):
    every leaf equally likely to split; steady-state fill ≈ 2/3 (ln 2 ≈ 69%)
    → ~1.4× more leaf pages for the same data
    → 1.4× more buffer-pool pressure, 1.4× more pages to WAL-image
    AND: every insert touches a random page → the working set is the
    ENTIRE leaf level; with a 700 MB leaf level and a smaller buffer
    pool, every insert is a read-modify-write with a real disk read.
```

That second block is the "UUID primary keys are slow" phenomenon, quantified. Time-ordered IDs (ULID, UUIDv7, Snowflake IDs) restore the sequential pattern while keeping distributed generation — usually the right fix.

### Delete: lazier than the textbook

CLRS merges underfull nodes eagerly. Real systems mostly don't: PostgreSQL marks index tuples dead and lets VACUUM recycle *empty* pages only (it never merges partially-full ones); InnoDB merges only when a page drops below a threshold (`MERGE_THRESHOLD`, default 50%). Rationale: workloads that delete often re-insert in the same range, and merge-then-resplit thrashing costs more than carrying slack. Consequence: **B-tree indexes only grow tighter via rebuild** — a mass-delete leaves the index the same size until `REINDEX` / `OPTIMIZE TABLE`.

---

## Write Amplification: Page-Sized, Plus the Log

The unit of B-tree I/O is the page, so the write amplification for small rows is structural:

```
UPDATE of a 100-byte row, 8 KB pages, worst case (PostgreSQL-flavored):
  WAL record:                        ~150 bytes
  full-page image (first touch of the page after a checkpoint):
                                     ~8 KB into the WAL
  heap page write (at checkpoint):    8 KB
  index page write (if index updated): 8 KB
  ────────────────────────────────────────────
  ~24 KB of I/O for 100 logical bytes ≈ 240×  (worst case)

Steady state is far better: pages absorb many updates between
checkpoints (one page write amortizes over all of them), and only the
first touch per checkpoint pays the full-page image. Realistic WA for
OLTP: ~2-10×. But the WORST case is what sizes your disks and your
checkpoint tuning — spiky WAL volume right after each checkpoint is
the visible symptom.
```

Full-page images exist because of **torn pages** — an 8 KB page write is not atomic on 4 KB-sector devices; the defenses (FPIs, InnoDB's doublewrite buffer) are covered in [Write-Ahead Logging](./04-write-ahead-logging.md).

Contrast with the [LSM tree](./02-lsm-trees.md): the LSM converts random page-sized writes into sequential batched writes (great for ingest) but pays repeatedly at compaction (10–30× WA on the *logical data*, spread over time). B-tree WA is per-update and immediate; LSM WA is deferred and background. Which is cheaper depends on update locality: hot rows updated repeatedly are nearly free in a B-tree (same page, one eventual write) and expensive in an LSM (every version rewritten through every level).

### Mitigations engines actually use

```
- Buffer pool absorbs re-writes: dirty page written once per checkpoint,
  not per update — checkpoint interval is a WA knob
- Group/async commit amortize the WAL fsync (see WAL chapter)
- HOT updates (PostgreSQL): update that changes no indexed column
  rewrites only the heap page — zero index writes
- Change buffering (InnoDB): secondary-index modifications for pages
  not in memory are buffered and merged later — turns random index I/O
  into batched I/O
- B^ε-trees push this to the limit: each internal node carries a buffer
  of pending messages flushed downward in batches — write-optimized
  B-trees (TokuDB/PerconaFT lineage), trading read latency for write WA
```

---

## Concurrency: Latches, Crabbing, and Going Sideways

A B-tree under concurrent access must protect physical page integrity (latches, microsecond-scale) separately from transactional isolation (locks, transaction-scale). The interesting engineering is in the latches — with hundreds of cores, how you latch determines whether the index scales.

```
Latch crabbing (the classical protocol):
  descend holding parent latch until child latch acquired;
  release parent as soon as child is "safe"
  (safe = can't split for insert / can't underflow for delete)

  Readers: shared latches, release immediately → cheap
  Writers: exclusive latches; the root is the choke point —
  a pessimistic writer holds it until it knows no split will cascade
```

```
Optimistic descent (what modern engines do):
  descend with SHARED (or no) latches assuming no split will happen
  latch exclusively only the leaf; if it turns out to split,
  restart the descent pessimistically
  → splits are rare, so the fast path wins almost always
  Optimistic Lock Coupling generalizes this with per-page version
  counters: readers don't latch at all, they validate versions —
  reads scale linearly with cores
```

```
B-link trees (Lehman & Yao 1981): every node gets a HIGH KEY and a
RIGHT-SIBLING pointer. A split first creates the right sibling, then
updates the parent — and a concurrent reader that lands on the old
page mid-split detects (key > high key) and simply follows the sibling
pointer sideways. Readers never block on splits; writers latch at most
2-3 pages. This is PostgreSQL's actual implementation, and the reason
its index scans don't stall behind concurrent inserts.
```

Recovery interacts here too: a crash mid-split must not leave an unreachable page. PostgreSQL WAL-logs the split as one atomic record plus a deferred parent insert that is completed on redo; InnoDB uses mini-transactions (atomic multi-page redo groups). The invariant: **structural changes are atomic in the log even when they span pages** — see [Write-Ahead Logging](./04-write-ahead-logging.md).

### Copy-on-write B-trees: the other road

LMDB, BoltDB, and btrfs skip latching-for-writers entirely: never modify a page in place; write new copies of the changed leaf and its path to the root, then atomically swap the root pointer.

```
+ readers need NO latches ever (any root they hold is a consistent snapshot)
+ crash recovery is free — old root is always valid, no WAL required
+ snapshots/MVCC are a pointer copy
- every logical write rewrites height pages (WA multiplied by tree height)
- single writer at a time (LMDB), space reclamation needs GC
→ superb for read-dominated embedded workloads; wrong shape for
  write-heavy multi-writer OLTP
```

---

## PostgreSQL and InnoDB: The Knobs That Matter

```
PostgreSQL nbtree:
  fillfactor (default 90): headroom per leaf to absorb inserts without
    splitting — drop to 70-80 for heavy random-update columns
  HOT updates: keep frequently-updated columns OUT of indexes so
    updates skip index maintenance entirely
    (check pg_stat_user_tables.n_tup_hot_upd / n_tup_upd)
  B-tree deduplication (PG 13+): duplicate keys stored once with a
    TID list — low-cardinality indexes shrink 3-10×
  Bottom-up index deletion (PG 14+): kills dead index tuples at the
    moment a page would split, preventing bloat from update churn
  REINDEX CONCURRENTLY: the only way to un-bloat; VACUUM never
    merges partially-empty index pages
  Diagnostics: pgstatindex() → avg_leaf_density (<50% = bloated),
    bt_metap() for height; pg_stat_user_indexes.idx_scan = 0 → drop it
```

```
InnoDB:
  clustered PK: keep it SHORT and MONOTONIC (bigint auto-inc or UUIDv7)
    — every secondary index carries a copy of it
  change buffer: batches secondary-index updates for cold pages
  adaptive hash index: hash shortcut over hot B-tree pages, built
    automatically (and sometimes worth disabling under contention)
  innodb_fill_factor, MERGE_THRESHOLD per index
```

```
When a B-tree is the wrong index (PostgreSQL menu):
  BRIN: physically-ordered append-only data (time series) —
    min/max per block range, ~1000× smaller than B-tree
  GIN: contains-style queries (arrays, JSONB, full text)
  Hash: equality-only, marginal wins; rarely worth it
  Partial/covering indexes: cheaper than another full B-tree —
    index only the rows (WHERE ...) or add INCLUDE payload columns
    to enable index-only scans
Multi-column indexes route by leftmost prefix: (a,b,c) serves
  a / a,b / a,b,c — never b alone. Order columns by equality-first,
  then range; a range predicate stops index use for later columns.
```

---

## Failure Modes

**Index bloat from update/delete churn.** Dead index tuples accumulate; pages sit half-empty; the same logical index costs 2–5× the pages, cache hit rate falls, and scans slow down *gradually* — no error, just drift, exactly like an overfilled bloom filter. Watch `avg_leaf_density`, and schedule `REINDEX CONCURRENTLY` for write-churned indexes. The PG 13/14 dedup + bottom-up-deletion features cut this dramatically; on older versions bloat management is a standing operational duty.

**Random-key insertion working sets.** UUIDv4 keys make every insert touch a uniformly random leaf. Once the leaf level exceeds the buffer pool, each insert = 1 random read + eventually 1 random write, and throughput falls off a cliff that looks like "the database got slow at 200 GB". Fix the key (UUIDv7/ULID), not the hardware.

**The hot right edge.** Monotonic keys concentrate all inserts on the rightmost leaf — a latch hotspot under high concurrency (SQL Server's "last page insert contention", mitigated with OPTIMIZE_FOR_SEQUENTIAL_KEY; PostgreSQL's fastpath relieves most of it). Ironically the opposite pathology of the previous one: sequential keys stress one latch, random keys stress the whole cache.

**Over-indexing.** Every index is a full extra B-tree maintained on every write: 5 secondary indexes ≈ 6 page-dirtying operations per insert plus their WAL. Write-heavy tables with double-digit index counts spend most of their I/O maintaining indexes nobody queries. Audit `idx_scan` and delete.

**Long-running transactions defeating cleanup.** HOT pruning, bottom-up deletion, and VACUUM all respect the oldest visible snapshot; one forgotten `idle in transaction` session holds back index cleanup database-wide and converts churn directly into bloat.

**Fat keys.** Wide text keys shrink fanout (fewer separators per page → taller tree → more I/O per lookup) and, in InnoDB, replicate into every secondary index. Index a hash or prefix of long strings; keep PKs to 8–16 bytes.

---

## Decision Framework

| Situation | Reach for |
|---|---|
| OLTP point lookups + short range scans, moderate write rate | B+-tree (the default for a reason) |
| Write-heavy ingest, few point reads, key-ordered data | [LSM tree](./02-lsm-trees.md) — sequential writes beat page RMW |
| Append-only time series, range scans by time | BRIN (PostgreSQL) or LSM with time-ordered keys |
| Distributed ID generation + B-tree PK | UUIDv7/ULID/Snowflake — never UUIDv4 as a PK |
| Read-mostly embedded store, snapshot reads | COW B-tree (LMDB/BoltDB) |
| Update-heavy columns | Keep them out of indexes (enable HOT); lower fillfactor |
| Low-cardinality index (status, type) | PG 13+ dedup B-tree, or partial index per hot value |
| Index larger than buffer pool, random access | Expect I/O-bound behavior; shrink keys, drop unused indexes, or accept the cache-miss economics |

---

## Key Takeaways

1. **Count page reads, and count which of them are cached** — a B-tree lookup is height accesses, of which the top 2–3 levels are effectively free; the whole design exists to maximize fanout.
2. **B+ everywhere**: values in leaves, truncated separators in internal nodes, sibling-linked leaves for scans.
3. **Write amplification is page-sized plus log-sized** — worst case ~hundreds×, amortized 2–10×; checkpoint frequency and full-page images set the spikes.
4. **Key order is a first-class design decision** — sequential keys pack pages and cache beautifully (but contend on the right edge); random UUIDs bloat the tree ~1.4× and turn the whole leaf level into the working set.
5. **Deletes don't shrink B-trees** — only rebuilds do; bloat is a monitored, managed quantity, not an anomaly.
6. **Modern concurrency is optimistic + sideways** — version-validated descents and B-link sibling pointers, not root-latch convoys.
7. **In clustered designs the PK is part of every index** — short, monotonic primary keys are a storage decision, not a style preference.
8. **The B-tree/LSM choice is about update locality** — repeated updates to hot rows favor B-trees; high-volume unique-key ingest favors LSMs.

---

## References

- Bayer, R., & McCreight, E. (1972). *Organization and Maintenance of Large Ordered Indexes*. Acta Informatica.
- Comer, D. (1979). *The Ubiquitous B-Tree*. ACM Computing Surveys.
- Lehman, P., & Yao, S. B. (1981). *Efficient Locking for Concurrent Operations on B-Trees*. TODS. (B-link trees.)
- Graefe, G. (2011). *Modern B-Tree Techniques*. Foundations and Trends in Databases. (The comprehensive survey.)
- Leis, V., et al. (2019). *Optimistic Lock Coupling: A Scalable and Efficient General-Purpose Synchronization Method*. IEEE Data Eng. Bulletin.
- Brodal, G., & Fagerberg, R. (2003); Bender, M., et al. — B^ε-tree / write-optimization line of work behind TokuDB/PerconaFT.
- PostgreSQL documentation: *nbtree README*, B-tree deduplication (13), bottom-up deletion (14); `pageinspect`, `pgstattuple`.
- MySQL/InnoDB documentation: clustered indexes, change buffer, adaptive hash index.
