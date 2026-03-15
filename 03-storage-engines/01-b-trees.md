# B-Trees

## TL;DR

B-trees are the most widely-used index structure in databases. They maintain sorted data with O(log n) reads, writes, and range queries. B+-trees (the common variant) store all data in leaf nodes, making range scans efficient. Understanding page splits, fill factors, and write amplification is key to optimizing B-tree performance.

---

## Why B-Trees?

### The Disk Access Problem

```
Disk characteristics:
  - Sequential read:  100+ MB/s
  - Random read:      100-200 IOPS (spinning disk)
  - SSD random read:  10,000+ IOPS

Memory access: ~100 nanoseconds
Disk access:   ~10 milliseconds (spinning)

Ratio: 100,000x slower for random disk access

Goal: Minimize disk accesses per operation
```

### B-Tree Solution

```
Store data in large blocks (pages) that match disk I/O
Few levels → few disk reads

Height 3 B-tree with 100 keys/node:
  Level 0: 1 node (100 keys)
  Level 1: 100 nodes (10,000 keys)
  Level 2: 10,000 nodes (1,000,000 keys)
  
  3 disk reads to find any of 1 million keys
```

---

## B-Tree Structure

### Node Layout

```
Each node is a fixed-size page (typically 4-16 KB)

     ┌──────────────────────────────────────────┐
     │  [P0] K1 [P1] K2 [P2] K3 [P3] ... Kn [Pn] │
     └──────────────────────────────────────────┘
     
Ki = Key i
Pi = Pointer to child (or data in leaf)

Invariant:
  All keys in subtree P(i-1) < Ki <= All keys in subtree Pi
```

### B-Tree vs B+-Tree

```
B-Tree:
  - Data stored in all nodes
  - Fewer total nodes
  - Range scan requires tree traversal
  
B+-Tree (most common):
  - Data only in leaf nodes
  - Internal nodes = routing only
  - Leaf nodes linked → efficient range scan
  
     [10 | 20 | 30]        ← Internal node (keys only)
     /    |    |    \
    ↓     ↓    ↓     ↓
   [1-9][10-19][20-29][30-39]  ← Leaf nodes (keys + data)
     ↔     ↔     ↔     ↔       ← Sibling pointers
```

### B+-Tree Properties

```
Order m (max children per node):
  - Internal nodes: ⌈m/2⌉ to m children
  - Leaf nodes: ⌈m/2⌉ to m key-value pairs
  - Root: 2 to m children (or 0 if empty)

Typical m = 100-1000+ depending on page size
```

---

## Operations

### Search

```
def search(node, key):
    if node.is_leaf:
        return binary_search(node.keys, key)
    
    # Find child to descend into
    i = binary_search_position(node.keys, key)
    child = read_page(node.pointers[i])
    return search(child, key)

Complexity: O(log_m n) pages read
           O(log n) total key comparisons
```

### Range Scan

```
def range_scan(start, end):
    # Find start position
    leaf = find_leaf(start)
    position = binary_search(leaf.keys, start)
    
    # Scan leaves using sibling pointers
    results = []
    while leaf and leaf.keys[position] <= end:
        results.append(leaf.values[position])
        position += 1
        if position >= len(leaf.keys):
            leaf = leaf.next_sibling
            position = 0
    return results

Efficient: Sequential access after finding start
```

### Insert

```
def insert(key, value):
    leaf = find_leaf(key)
    
    if leaf.has_space():
        leaf.insert(key, value)
    else:
        # Split the leaf
        new_leaf = split(leaf)
        middle_key = new_leaf.first_key
        
        # Insert middle key into parent
        insert_into_parent(leaf.parent, middle_key, new_leaf)

Split may cascade up to root
```

### Leaf Split

```
Before (full leaf, m=4):
  [10, 20, 30, 40]

Insert 25:
  Split into two leaves
  
  [10, 20] → [30, 40]  (new leaf takes upper half)
                ↓
  [30, 40, 25] → sort → [25, 30, 40]
  
  Actually:
  [10, 20, 25] [30, 40]
  
  Promote 30 to parent:
  Parent: [..., 30, ...]
            ↓    ↓
         [leaf1][leaf2]
```

### Delete

```
def delete(key):
    leaf = find_leaf(key)
    leaf.remove(key)
    
    if leaf.is_underfull():
        if can_borrow_from_sibling(leaf):
            borrow(leaf)
        else:
            merge_with_sibling(leaf)
            # May cascade up

Underflow when: < ⌈m/2⌉ keys
```

---

## Page Layout

### Slotted Page Format

```
┌────────────────────────────────────────────────────┐
│ Header │ Slot 1 │ Slot 2 │ ... │ Free │ ... │Data│
├────────┴────────┴────────┴─────┴──────┴─────┴─────┤
│ ◄─── Slots grow →                 ← Data grows ──►│
└────────────────────────────────────────────────────┘

Header: Page ID, number of slots, free space pointer
Slot: Offset to data, length
Data: Variable-length records

Advantages:
  - Variable-length keys/values
  - Easy deletion (mark slot as empty)
  - Efficient compaction
```

### Key Compression

```
Prefix compression in internal nodes:
  Original: ["application", "apply", "approach"]
  Compressed: ["appli", "appr"]  (minimum to distinguish)

Suffix truncation:
  Don't need full key in internal nodes
  Just enough to route correctly
```

---

## Write Amplification

### The Problem

```
Insert one key-value pair (100 bytes):
  1. Read page (4 KB)
  2. Modify page (add 100 bytes)
  3. Write page (4 KB)
  
Write amplification = 4 KB / 100 bytes = 40x

For update in place:
  WAL write + Page write = 2x amplification minimum
```

### Mitigation

```
1. Larger pages (more data per I/O)
2. Buffer pool (cache hot pages in memory)
3. Batch writes (group modifications)
4. Append-only B-trees (COW for reduced random writes)
```

---

## Concurrency Control

### Page-Level Locking

```
Simple approach:
  Lock page during read/write
  Release when done
  
Problem: 
  Page splits acquire locks bottom-up
  Risk of deadlock
```

### Latch Crabbing

```
Traversal with safe release:

1. Acquire latch on child
2. If child is "safe" (won't split/merge):
   Release latch on all ancestors
3. Continue down

Safe node:
  - For insert: has space for one more key
  - For delete: has more than minimum keys
```

```
Search: Read latch → descend → release parent → repeat
        (crab down the tree)

Insert:
  Acquire write latches top-down
  Release ancestors when child is safe
  
Example (insert, safe child):
  [Parent] ← write latch
      ↓
  [Child is safe] ← write latch, release parent
      ↓
  [Leaf] ← write latch, do insert
```

### Optimistic Locking

```
1. Traverse with read latches only
2. At leaf, try to upgrade to write latch
3. If structure changed (version mismatch):
   Restart traversal

Reduces contention for read-heavy workloads
```

---

## Durability and Recovery

### Write-Ahead Logging (WAL)

```
Before modifying page:
  1. Write log record (page ID, old value, new value)
  2. Fsync log
  3. Modify page in buffer pool
  4. Eventually flush dirty page

Recovery:
  Replay log to reconstruct pages
```

### Crash Recovery

```
WAL ensures:
  - Committed transactions' changes applied
  - Uncommitted transactions' changes undone

B-tree specific:
  - Half-completed splits must be completed or undone
  - Log sufficient info to redo split
```

---

## Copy-on-Write B-Trees

### Concept

Never modify pages in place.

```
Original tree:
     [A]
    /   \
  [B]   [C]
  
Update to [B]:
  1. Create new [B'] with modification
  2. Create new [A'] pointing to [B'] and [C]
  3. Update root pointer to [A']
  
Old pages remain until garbage collected
```

### Advantages

```
+ No WAL needed (old version always valid)
+ Readers never blocked
+ Snapshots are free (just keep old root)
+ Simple crash recovery
```

### Disadvantages

```
- Write amplification (entire path to root)
- Fragmentation (new pages not contiguous)
- Garbage collection needed
- Space amplification during updates
```

### Systems Using COW

```
LMDB:   Copy-on-write B-tree
BoltDB: Copy-on-write B+-tree
btrfs:  Copy-on-write filesystem
```

---

## B-Tree Variants

### B*-Tree

```
More aggressive node filling:
  - Siblings help before splitting
  - Minimum occupancy: 2/3 (not 1/2)
  - Better space utilization
```

### Bᵋ-Tree (B-epsilon Tree)

```
Buffer at each node for pending updates:
  - Insert writes to buffer
  - Buffer flushed when full
  - Reduces write amplification
  
Trade-off: Faster writes, slower reads
```

### Fractal Tree

```
Similar to Bᵋ-tree:
  - Messages buffered at each level
  - Batch flushes down tree
  
Used by TokuDB (MySQL), PerconaFT
```

---

## Performance Characteristics

### Complexity

| Operation | Average | Worst |
|-----------|---------|-------|
| Search | O(log n) | O(log n) |
| Insert | O(log n) | O(log n) |
| Delete | O(log n) | O(log n) |
| Range | O(log n + k) | O(log n + k) |

k = number of results

### Space Utilization

```
Typical fill factor: 50-70%
  - Splits create half-full nodes
  - Random inserts fill non-uniformly

Bulk loading: 90%+ possible
  - Sort data first
  - Build bottom-up
  - Pack leaves fully
```

### I/O Patterns

```
Read:   Random I/O (traverse nodes)
        Sequential within page
        
Write:  Random I/O (update pages)
        WAL is sequential
        
Range:  Sequential after finding start
        (leaf nodes linked)
```

---

## Practical Considerations

### Page Size Selection

```
Larger pages:
  + Fewer levels (faster traversal)
  + Better for range scans
  + Better for HDDs
  - More write amplification
  - More memory per page

Typical: 4 KB (SSD), 8-16 KB (HDD)
```

### Fill Factor

```
CREATE INDEX ... WITH (fillfactor = 70);

Lower fill factor:
  + Room for inserts without splits
  + Better for write-heavy workloads
  - More space, more pages to read

Higher fill factor:
  + Less space, fewer pages
  + Better for read-heavy workloads
  - More splits on insert
```

### Monitoring

```
Key metrics:
  - Tree height (should be stable)
  - Page splits per second
  - Fill factor / space utilization
  - Cache hit ratio for index pages
  - I/O wait time
```

---

## B-Tree vs B+Tree

### Structural Differences

```
B-Tree:
  - Keys AND values stored in both internal and leaf nodes
  - Any node can satisfy a lookup — no need to reach a leaf
  - Fewer total nodes (values packed into internal nodes)
  - Range scans require in-order tree traversal (expensive)

B+Tree:
  - Values stored ONLY in leaf nodes
  - Internal nodes are pure routing nodes — contain keys and child pointers only
  - Leaf nodes are linked via sibling pointers for sequential access
  - Range scan = find start leaf, then follow links

     ┌─────────────┐
     │  30  |  60   │              ← Internal: routing only
     └──┬────┬────┬─┘
        ↓    ↓    ↓
   ┌──────┐ ┌──────┐ ┌──────┐
   │10|20 │→│30|40 │→│60|80 │    ← Leaves: keys + values + sibling links
   └──────┘ └──────┘ └──────┘
```

### Why Databases Use B+Tree

```
1. Smaller internal nodes → higher fan-out → fewer levels
   B-Tree internal node: key + value + pointer ≈ large
   B+Tree internal node: key + pointer ≈ small

2. Fan-out example (8 KB page, 100-byte keys, 8-byte pointers):
   Keys per internal node: ~80
   Level 0:          1 node  →          80 keys
   Level 1:         80 nodes →       6,400 keys
   Level 2:      6,400 nodes →     512,000 keys
   Level 3:    512,000 nodes →  40,960,000 keys
   → 4 levels covers 40M+ keys

3. Range scans follow leaf links — no tree re-traversal
4. Consistent depth — every lookup touches the same number of pages

Databases using B+Tree variants:
  PostgreSQL:   nbtree (B+Tree with high-key optimization)
  MySQL InnoDB: clustered B+Tree (data in leaf pages)
  SQLite:       B+Tree for tables, B-Tree for indexes
```

---

## Page Splits and Merges

### Splits

```
When a leaf page is full and a new key must be inserted:
  1. Allocate a new page
  2. Move upper half of keys to new page
  3. Insert new routing key into parent
  4. If parent is also full → split parent (cascade upward)
  5. If root splits → new root created, tree grows one level

Before split (page full, 4 keys max):
  Parent: [... 50 ...]
               ↓
  Leaf:   [10, 20, 30, 40]

Insert 25:
  Parent: [... 30 | 50 ...]        ← 30 promoted
            ↓        ↓
  Leaf1: [10, 20, 25]  Leaf2: [30, 40]
```

### Merges

```
When adjacent pages are both less than half full:
  1. Merge two leaf pages into one
  2. Remove routing key from parent
  3. If parent becomes underfull → merge parent (cascade upward)
  4. If root has only one child → root removed, tree shrinks
```

### Fragmentation and Maintenance

```
Splits create half-full pages → up to 50% wasted space
Sequential inserts are better — append to rightmost leaf

PostgreSQL specifics:
  - VACUUM reclaims dead tuples but does NOT defragment B-tree indexes
  - REINDEX rebuilds the index from scratch — reclaims space
  - pg_stat_user_indexes.idx_scan = 0 → unused index, consider dropping

Fill factor (PostgreSQL):
  - Default fillfactor for indexes: 90
  - Leaves 10% headroom per page to delay splits
  - For append-only tables (e.g., time-series): fillfactor = 100 is fine
  - For random updates: fillfactor = 70-80 reduces split frequency
  CREATE INDEX idx_orders ON orders(created_at) WITH (fillfactor = 90);

HOT updates (Heap-Only Tuples):
  - PostgreSQL optimization for UPDATE that does NOT change indexed columns
  - New tuple version stays on the same heap page
  - No new index entry needed → avoids index bloat entirely
  - Check: pg_stat_user_tables.n_tup_hot_upd vs n_tup_upd
```

---

## PostgreSQL Index Internals

### Inspecting B-Tree Pages

```sql
-- Enable pageinspect extension
CREATE EXTENSION IF NOT EXISTS pageinspect;

-- View B-tree metapage (root location, tree height)
SELECT * FROM bt_metap('idx_orders');
--  magic  | version | root | level | fastroot | fastlevel
-- --------+---------+------+-------+----------+-----------
--  340322 |       4 |    3 |     1 |        3 |         1

-- View items on a specific B-tree page
SELECT * FROM bt_page_items('idx_orders', 1) LIMIT 5;
--  itemoffset |  ctid   | itemlen | data
-- ------------+---------+---------+------
--           1 | (0,1)   |      16 | ...
```

### Index Bloat Detection

```sql
-- pgstattuple extension for bloat analysis
CREATE EXTENSION IF NOT EXISTS pgstattuple;

SELECT * FROM pgstatindex('idx_orders');
--  version | tree_level | index_size | root_block_no | internal_pages |
--  leaf_pages | empty_pages | deleted_pages | avg_leaf_density | leaf_fragmentation
--
-- Key metrics:
--   avg_leaf_density < 50% → significant bloat, consider REINDEX
--   leaf_fragmentation > 30% → pages out of order on disk
```

### Index-Only Scans

```sql
-- When all required columns are in the index, PostgreSQL skips heap access
CREATE INDEX idx_orders_status_total ON orders(status, total);

-- This query can be an index-only scan:
EXPLAIN SELECT status, total FROM orders WHERE status = 'shipped';
-- Index Only Scan using idx_orders_status_total

-- Visibility map must be up-to-date (run VACUUM) for index-only scans
-- Monitor: pg_stat_user_indexes.idx_blks_hit (buffer hits vs disk reads)
```

### Covering and Partial Indexes

```sql
-- Covering index: INCLUDE adds non-key columns for index-only scans
-- Included columns are NOT used for ordering or filtering — just payload
CREATE INDEX idx_orders_covering ON orders(customer_id) INCLUDE (status, total);

-- Partial index: index only rows matching a condition — smaller and faster
CREATE INDEX idx_active_orders ON orders(created_at) WHERE status = 'active';
-- Only rows with status='active' are indexed
-- Queries must include WHERE status = 'active' to use this index
```

### Multi-Column Index Ordering

```
Leftmost prefix rule for composite index (a, b, c):

  ✓ WHERE a = 1                      → uses index
  ✓ WHERE a = 1 AND b = 2            → uses index
  ✓ WHERE a = 1 AND b = 2 AND c = 3  → uses index
  ✗ WHERE b = 2                      → cannot use index
  ✗ WHERE b = 2 AND c = 3            → cannot use index
  ✓ WHERE a = 1 AND c = 3            → uses index for a, filter c

The index is sorted by (a, then b within a, then c within b).
Skipping a leftmost column breaks the sort order.
```

### When to Use BRIN Instead of B-Tree

```
BRIN (Block Range INdex): stores min/max per block range (e.g., 128 pages)

Use BRIN when:
  - Table is physically sorted by the indexed column (e.g., auto-increment ID)
  - Table is very large (100M+ rows)
  - Exact lookups are rare; range scans are common
  - Time-series data with append-only inserts

BRIN advantages:
  - Tiny index size: ~1000x smaller than B-tree for large tables
  - Near-zero insert overhead

CREATE INDEX idx_events_ts ON events USING brin(created_at) WITH (pages_per_range = 128);
```

---

## B-Tree Performance Characteristics

### Operation Costs

```
Point lookup:
  O(log_B N) page reads, where B = branching factor (fan-out)
  Example: B = 80, N = 40M keys → log_80(40M) ≈ 4 levels
  4 random I/Os per lookup (root page usually cached → 3 in practice)

Range scan:
  O(log_B N + K/B) page reads, where K = result set size
  Find start: same as point lookup
  Then follow leaf links: sequential I/O, reading K/B leaf pages

Insert:
  O(log_B N) amortized — one page write + WAL entry
  Worst case: page split cascades to root → 2× the page writes
  Amortized split cost is low — each page absorbs ~B inserts before splitting

Delete:
  O(log_B N) amortized — mark dead, eventual merge
  Most systems defer merges (PostgreSQL marks tuples dead, VACUUM cleans up)
```

### Sequential vs Random I/O Trade-off

```
B-tree writes are random I/O:
  - Update-in-place means writing to arbitrary page locations
  - Each insert touches a different leaf page (for random key order)

LSM-tree writes are sequential I/O:
  - All writes go to an append-only memtable → flush to sorted files
  - This is the fundamental B-tree vs LSM trade-off
  (see 02-lsm-trees.md for full LSM coverage)

Impact on hardware:
  HDD:  Random I/O ≈ 10ms seek → B-tree writes are expensive
  SSD:  Random I/O ≈ 0.05-0.1ms → penalty is 100x smaller
  NVMe: Random I/O ≈ 0.01ms → B-tree and LSM gap narrows significantly
```

### Write Amplification Comparison

```
B-tree write amplification:
  - 1 WAL write + 1 page write = ~2× per logical write
  - Page splits add occasional extra writes
  - Overall: 2-5× typical

LSM write amplification:
  - Compaction rewrites data across multiple levels
  - Overall: 10-30× typical (varies by compaction strategy)
  (see 02-lsm-trees.md for compaction details)

B-tree wins on write amplification, LSM wins on write throughput.
For read-heavy OLTP (point lookups, short ranges): B-tree is usually better.
For write-heavy ingestion (logs, metrics, events): LSM may be better.
```

---

## Key Takeaways

1. **B+-trees dominate databases** - Leaf nodes contain data, linked for scans
2. **Log(n) operations** - Few disk accesses for any operation
3. **Page splits cascade** - Insert can modify multiple pages
4. **Write amplification is real** - 40x not unusual
5. **Concurrency is complex** - Latch crabbing for safety
6. **COW simplifies recovery** - At cost of more writes
7. **Fill factor is tunable** - Trade space for write performance
8. **Range scans are efficient** - Sequential access after locate
