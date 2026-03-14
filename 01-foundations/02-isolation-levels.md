# Isolation Levels

## TL;DR

Isolation levels define what concurrent transactions can see. Higher isolation = fewer anomalies but worse performance. Most OLTP apps use Read Committed (PostgreSQL default) or Repeatable Read (MySQL default). Serializable is the only level that prevents all anomalies, but costs 20-40% throughput under contention. Know the anomalies, know your database's actual implementation, and use application-level patterns (SELECT FOR UPDATE, optimistic locking) to close gaps cheaply.

---

## Why Isolation Levels Exist

The SQL standard defines four isolation levels because full serializability is expensive. The cost comes from two fundamental tensions:

**Readers vs. writers.** A fully serialized system either blocks readers while writers hold locks, or aborts writers when reads conflict. In a typical OLTP workload (95% reads, 5% writes), blocking all readers for every write destroys throughput.

**Throughput vs. correctness.** Consider a payment system processing 10,000 TPS. Under strict two-phase locking (2PL) at Serializable, lock contention on hot rows (account balances, inventory counts) creates convoy effects -- transactions queue behind each other, P99 latency spikes from 5ms to 500ms. Weaker isolation allows concurrent access at the cost of permitting certain anomalies.

**The engineering tradeoff is explicit:** the SQL standard defines exactly which anomalies each level permits, so engineers can choose the cheapest level that their application logic can tolerate.

Most applications don't need full serializability because:
- Many reads are informational (dashboards, listings) where stale data is acceptable
- Business logic often has natural idempotency or compensating transactions
- Critical sections (inventory decrement, balance transfer) can use targeted locking without paying the cost everywhere

> Cross-reference: see [ACID Transactions](01-acid-transactions.md) for WAL, fsync, and undo/redo log mechanics that underpin durability and atomicity.

---

## The Anomalies

### Dirty Read

Reading uncommitted data from another transaction.

```
T1: BEGIN
T1: UPDATE accounts SET balance = 0 WHERE id = 1
                                            T2: SELECT balance FROM accounts WHERE id = 1
                                            T2: Returns 0 (uncommitted!)
T1: ROLLBACK
```

T2 saw data that never existed in committed state. If T2 made a decision based on that balance (e.g., denying a loan), the decision was based on phantom state.

**Prevented by: Read Committed and above**

---

### Non-Repeatable Read (Read Skew)

Reading the same row twice yields different values.

```
T1: BEGIN
T1: SELECT balance FROM accounts WHERE id = 1  -- Returns 100
                                            T2: UPDATE accounts SET balance = 50 WHERE id = 1
                                            T2: COMMIT
T1: SELECT balance FROM accounts WHERE id = 1  -- Returns 50!
T1: COMMIT
```

T1's view of the world changed mid-transaction. This breaks backup operations (inconsistent snapshot), report generation (totals don't add up), and integrity checks (foreign key references shift).

**Prevented by: Repeatable Read and above**

---

### Phantom Read

A query returns different rows when executed twice.

```
T1: BEGIN
T1: SELECT COUNT(*) FROM accounts WHERE balance > 100  -- Returns 3
                                            T2: INSERT INTO accounts VALUES (4, 200)
                                            T2: COMMIT
T1: SELECT COUNT(*) FROM accounts WHERE balance > 100  -- Returns 4!
T1: COMMIT
```

New rows "appeared" mid-transaction. This is distinct from non-repeatable reads because the *set of rows* changed, not just their values. Phantoms break range-based invariants (e.g., "total deposits must equal total withdrawals").

**Prevented by: Serializable** (MySQL RR prevents some phantoms via gap locks, but not all)

---

### Write Skew

Two transactions read overlapping data, make decisions, write non-overlapping data.

```
Constraint: At least one doctor must be on call

T1: SELECT COUNT(*) FROM doctors WHERE on_call = true  -- Returns 2
T1: I can go off-call, there's another doctor
                                            T2: SELECT COUNT(*) FROM doctors WHERE on_call = true  -- Returns 2
                                            T2: I can go off-call, there's another doctor
T1: UPDATE doctors SET on_call = false WHERE id = 1
T1: COMMIT
                                            T2: UPDATE doctors SET on_call = false WHERE id = 2
                                            T2: COMMIT
```

Result: Zero doctors on call. Constraint violated.

Write skew is the most insidious anomaly because each transaction's logic is individually correct. The conflict is invisible without tracking read-write dependencies across transactions.

**Prevented by: Serializable only**

---

### Lost Update

Two transactions read the same value, compute a new value, and write it back. One update is silently overwritten.

```
-- Account balance starts at 100

T1: BEGIN
T1: SELECT balance FROM accounts WHERE id = 1  -- Returns 100
                                            T2: BEGIN
                                            T2: SELECT balance FROM accounts WHERE id = 1  -- Returns 100
T1: UPDATE accounts SET balance = 100 + 50 WHERE id = 1  -- Deposit 50
T1: COMMIT
                                            T2: UPDATE accounts SET balance = 100 - 30 WHERE id = 1  -- Withdraw 30
                                            T2: COMMIT

-- Final balance: 70 (should be 120)
-- T1's deposit of 50 was lost
```

This is the classic read-modify-write race. PostgreSQL RR detects this and aborts T2. MySQL RR does NOT -- it silently loses T1's update. Under Read Committed, both databases lose the update.

**Prevented by:**
- Repeatable Read in PostgreSQL (first-updater-wins)
- Serializable in MySQL
- `SELECT FOR UPDATE` at any isolation level
- Atomic operations: `UPDATE accounts SET balance = balance + 50` (no read-modify-write)

---

## MVCC Internals

Multi-Version Concurrency Control is how PostgreSQL, MySQL/InnoDB, and Oracle implement isolation without read locks. Each write creates a new version of the row; readers see the version appropriate for their snapshot.

### PostgreSQL: Heap Tuple Headers (v16)

Every row in PostgreSQL carries version metadata directly in the heap:

```sql
-- Observe MVCC metadata directly
SELECT ctid, xmin, xmax, * FROM accounts;

--  ctid  | xmin | xmax | id | balance
-- -------+------+------+----+---------
--  (0,1) |  100 |    0 |  1 |    500
--  (0,2) |  100 |  105 |  2 |    300
--  (0,3) |  110 |    0 |  3 |    750
```

**Field meanings:**

| Field | Purpose |
|-------|---------|
| `xmin` | Transaction ID that inserted this tuple version |
| `xmax` | Transaction ID that deleted/updated this tuple (0 = still live) |
| `ctid` | Physical location `(page, offset)` within the heap file |
| `t_infomask` | Bitmask flags: `HEAP_XMIN_COMMITTED`, `HEAP_XMAX_INVALID`, etc. |
| `t_infomask2` | Number of attributes, HOT update flag |

When a row is UPDATEd, PostgreSQL does not modify in place. Instead:

```
Before UPDATE:
  (0,1): xmin=100, xmax=0, balance=500        -- live tuple

After UPDATE (by xid 120):
  (0,1): xmin=100, xmax=120, balance=500      -- dead tuple (old version)
  (0,4): xmin=120, xmax=0, balance=600        -- new live tuple
```

The old tuple's `xmax` is set to the updating transaction's ID. The old tuple's `ctid` is updated to point to the new tuple location (forming a version chain).

### Snapshot Construction

When a transaction begins (in RR/Serializable), PostgreSQL takes a snapshot:

```
Snapshot = {
  xmin: 100,            -- oldest active transaction ID
  xmax: 125,            -- first unassigned transaction ID
  xip:  [105, 110, 118] -- transaction IDs that were in-progress at snapshot time
}
```

**Visibility rules for a tuple:**

1. If `tuple.xmin` is in `xip` (still in-progress at snapshot time) -> invisible
2. If `tuple.xmin >= snapshot.xmax` (started after snapshot) -> invisible
3. If `tuple.xmin` is committed AND `tuple.xmin < snapshot.xmax` AND `tuple.xmin` not in `xip` -> visible (if `xmax` doesn't hide it)
4. If `tuple.xmax` is committed AND visible by the same rules -> tuple is dead, invisible

Under Read Committed, a new snapshot is taken for *each statement*, which is why it sees newly committed data mid-transaction.

### Dead Tuple Accumulation and VACUUM

Because updates create new tuple versions, old versions accumulate as "dead tuples":

```sql
-- Monitor dead tuple ratio (PostgreSQL 16)
SELECT relname,
       n_live_tup,
       n_dead_tup,
       round(n_dead_tup::numeric / greatest(n_live_tup, 1) * 100, 2) AS dead_pct,
       last_vacuum,
       last_autovacuum
FROM pg_stat_user_tables
WHERE n_dead_tup > 0
ORDER BY n_dead_tup DESC;
```

**Why VACUUM exists:** Dead tuples waste disk space and slow sequential scans (the heap must skip over them). VACUUM marks dead tuple space as reusable. VACUUM FULL rewrites the entire table to reclaim disk space (requires ACCESS EXCLUSIVE lock).

**Autovacuum triggers** (default settings in PostgreSQL 16):

```
autovacuum_vacuum_threshold = 50          -- minimum dead tuples before vacuum
autovacuum_vacuum_scale_factor = 0.2      -- fraction of table size
-- Trigger: dead_tuples > threshold + scale_factor * n_live_tup
-- For a 1M row table: vacuum triggers after 200,050 dead tuples
```

For high-churn tables, lower the scale factor:

```sql
ALTER TABLE hot_table SET (autovacuum_vacuum_scale_factor = 0.01);
-- Now triggers at 10,050 dead tuples for a 1M row table
```

### InnoDB Contrast (MySQL 8.0)

InnoDB takes a different approach to versioning:

| Aspect | PostgreSQL | InnoDB |
|--------|-----------|--------|
| Old versions stored in | Heap (inline) | Undo log segments (separate tablespace) |
| Cleanup mechanism | VACUUM (external process) | Purge thread (background) |
| Version chain direction | Forward (old ctid -> new ctid) | Backward (current row -> undo log) |
| Read overhead of bloat | Heap scan slows down | Undo log traversal slows long-running reads |

InnoDB stores the current version in the clustered index. When a transaction needs an older version, it reconstructs it by applying undo log records in reverse. This means current reads are fast, but old-snapshot reads (from long-running transactions) must traverse the undo chain.

```sql
-- Monitor InnoDB undo log usage (MySQL 8.0)
SELECT count AS undo_log_entries
FROM information_schema.innodb_metrics
WHERE name = 'trx_rseg_history_len';

-- High values (>1M) indicate long-running transactions preventing purge
```

---

## Locking Internals

### Lock Hierarchy

Databases use a hierarchy of lock granularities. Finer granularity = more concurrency but more overhead.

**PostgreSQL lock hierarchy:**

```
ACCESS SHARE          -- SELECT (blocks nothing except ACCESS EXCLUSIVE)
ROW SHARE             -- SELECT FOR UPDATE/SHARE
ROW EXCLUSIVE         -- INSERT/UPDATE/DELETE
SHARE UPDATE EXCLUSIVE -- VACUUM, CREATE INDEX CONCURRENTLY
SHARE                 -- CREATE INDEX (non-concurrent)
SHARE ROW EXCLUSIVE   -- triggers, some ALTER TABLE
EXCLUSIVE             -- blocks ROW SHARE and above
ACCESS EXCLUSIVE      -- ALTER TABLE, DROP, VACUUM FULL
```

Actual row-level locks are separate from these table-level modes. PostgreSQL row locks live in the tuple header (`xmax` + `t_infomask` bits), not in a shared lock table, so millions of row locks have near-zero memory overhead.

```sql
-- View current locks (PostgreSQL 16)
SELECT l.locktype, l.relation::regclass, l.mode, l.granted, l.pid,
       a.query
FROM pg_locks l
JOIN pg_stat_activity a ON l.pid = a.pid
WHERE l.relation IS NOT NULL
ORDER BY l.relation;
```

### InnoDB Gap Locks

In MySQL InnoDB under Repeatable Read, range queries acquire **gap locks** to prevent phantoms:

```sql
-- Session 1 (MySQL 8.0, default RR)
BEGIN;
SELECT * FROM orders WHERE id > 10 AND id < 20 FOR UPDATE;

-- This locks:
--   Record locks on existing rows where 10 < id < 20
--   Gap locks on the gaps between existing keys
--   Next-key lock on the supremum pseudo-record
```

```sql
-- Session 2 (blocked!)
INSERT INTO orders (id, amount) VALUES (15, 100);
-- Waits... blocked by gap lock even though id=15 doesn't exist yet
```

Gap locks prevent phantom inserts but cause unexpected blocking. A `SELECT ... WHERE status = 'pending'` on a secondary index can lock gaps that block unrelated inserts.

```sql
-- Diagnose InnoDB locks (MySQL 8.0)
SELECT * FROM performance_schema.data_locks
WHERE lock_type = 'RECORD'
ORDER BY lock_data;

-- Shows lock_mode: X,GAP  or  X,REC_NOT_GAP  or  X (next-key lock)
```

### PostgreSQL Predicate Locks (SSI)

Under Serializable isolation, PostgreSQL tracks what each transaction reads using **SIReadLock** entries:

```sql
-- Session 1 (Serializable)
BEGIN ISOLATION LEVEL SERIALIZABLE;
SELECT * FROM doctors WHERE on_call = true;

-- PostgreSQL creates SIReadLock entries for the rows and the index range
```

These aren't locks in the blocking sense -- they're markers. SSI doesn't block; it tracks dependencies and aborts when it detects a cycle.

```sql
-- View predicate locks
SELECT locktype, relation::regclass, page, tuple
FROM pg_locks
WHERE mode = 'SIReadLock';

-- locktype | relation | page | tuple
-- ---------+----------+------+-------
-- tuple    | doctors  |    0 |     1
-- tuple    | doctors  |    0 |     3
-- page     | doctors  |    0 |
```

### Deadlock Detection

When two transactions each hold a lock the other needs, a deadlock occurs:

```
T1: UPDATE accounts SET balance = balance - 100 WHERE id = 1;  -- holds lock on id=1
T2: UPDATE accounts SET balance = balance - 50  WHERE id = 2;  -- holds lock on id=2
T1: UPDATE accounts SET balance = balance + 100 WHERE id = 2;  -- waits for T2
T2: UPDATE accounts SET balance = balance + 50  WHERE id = 1;  -- waits for T1 -> DEADLOCK
```

**PostgreSQL** detects deadlocks by building a **waits-for graph** and checking for cycles. The check runs after `deadlock_timeout` (default 1 second). One transaction is aborted with `ERROR: deadlock detected`.

```sql
-- PostgreSQL: tune deadlock detection
SET deadlock_timeout = '500ms';  -- check sooner (more CPU) or later (longer waits)

-- Log deadlocks for analysis
ALTER SYSTEM SET log_lock_waits = on;       -- log waits exceeding deadlock_timeout
ALTER SYSTEM SET deadlock_timeout = '1s';
SELECT pg_reload_conf();
```

**MySQL InnoDB** checks for deadlocks on every lock wait (no timeout delay). It uses a waits-for graph and rolls back the transaction with the fewest undo log records (cheapest to roll back).

```sql
-- MySQL: view last deadlock
SHOW ENGINE INNODB STATUS\G
-- Look for "LATEST DETECTED DEADLOCK" section
```

---

## Serializable Snapshot Isolation (SSI) Deep Dive

SSI (used by PostgreSQL 9.1+ and CockroachDB) is an optimistic concurrency control mechanism. It runs transactions against snapshots (like Repeatable Read) but detects serialization conflicts and aborts offenders at commit.

### rw-Anti-Dependency

The core concept in SSI is the **rw-anti-dependency** (also called rw-conflict):

> Transaction T1 has an rw-anti-dependency on T2 if T1 reads a version of some data item, and T2 later writes a new version of that same item.

```
T1: reads row X (version v1)
T2: writes row X (version v2)
-- T1 has an rw-anti-dependency on T2: T1 read old data that T2 changed
```

A single rw-anti-dependency is fine. The danger is a **cycle of rw-anti-dependencies** involving two (or more) consecutive edges:

```
"Dangerous structure":
T1 --rw--> T2 --rw--> T3  (where T3 committed before T1)

If this pattern forms, one transaction must be aborted to maintain serializability.
```

### When SSI Aborts vs. 2PL Blocks

| Situation | 2PL behavior | SSI behavior |
|-----------|-------------|-------------|
| Read-write conflict | Reader blocks until writer commits | Both proceed; abort at commit if cycle detected |
| Write-write conflict | Second writer blocks | Second writer blocks (same as 2PL) |
| No actual conflict | Still blocks (pessimistic) | No overhead (optimistic) |
| Deadlock possible | Yes (needs detection/timeout) | No deadlocks on reads (only write-write can block) |

SSI's advantage: read-heavy workloads see almost no overhead because reads never block. The cost is occasional aborts that require retry.

### Serialization Failure Retry Pattern (PostgreSQL 16)

When SSI detects a conflict, it raises `ERROR 40001 (serialization_failure)`. Applications **must** retry:

```python
import psycopg2
from psycopg2 import extensions
import time

def execute_with_retry(conn_params, operation, max_retries=5):
    """Execute a serializable transaction with exponential backoff retry.

    Args:
        conn_params: dict of psycopg2 connection parameters
        operation: callable(cursor) -> result, the transaction body
        max_retries: maximum number of retry attempts

    Returns:
        Result of the operation callable

    Raises:
        psycopg2.Error: if max retries exceeded or non-retryable error
    """
    for attempt in range(max_retries):
        conn = psycopg2.connect(**conn_params)
        conn.set_isolation_level(extensions.ISOLATION_LEVEL_SERIALIZABLE)
        try:
            with conn.cursor() as cur:
                result = operation(cur)
                conn.commit()
                return result
        except psycopg2.errors.SerializationFailure:
            conn.rollback()
            if attempt == max_retries - 1:
                raise
            # Exponential backoff with jitter
            delay = (2 ** attempt) * 0.01 * (0.5 + random.random())
            time.sleep(delay)
        except Exception:
            conn.rollback()
            raise  # Non-retryable errors propagate immediately
        finally:
            conn.close()


# Usage
def transfer_funds(cur):
    cur.execute("SELECT balance FROM accounts WHERE id = 1 FOR UPDATE")
    balance = cur.fetchone()[0]
    if balance < 100:
        raise ValueError("Insufficient funds")
    cur.execute("UPDATE accounts SET balance = balance - 100 WHERE id = 1")
    cur.execute("UPDATE accounts SET balance = balance + 100 WHERE id = 2")

execute_with_retry({"dbname": "myapp"}, transfer_funds)
```

Key points:
- The *entire transaction* must be retried, not just the failed statement
- `40001` is the SQLSTATE for serialization failure -- check this code, not the error message
- Exponential backoff with jitter prevents retry storms under contention

---

## Comparison Table

| Level | Dirty Read | Non-Repeatable | Phantom | Write Skew | Lost Update | Performance |
|-------|------------|----------------|---------|------------|-------------|-------------|
| Read Uncommitted | Yes | Yes | Yes | Yes | Yes | Best |
| Read Committed | No | Yes | Yes | Yes | Yes | Good |
| Repeatable Read | No | No | PG: No, MySQL: Partial | PG: Yes, MySQL: Yes | PG: No, MySQL: Yes | Medium |
| Serializable | No | No | No | No | No | Worst |

Notes on the "Maybe" cells:
- PostgreSQL RR prevents phantoms and lost updates via first-updater-wins, but not write skew
- MySQL RR prevents phantoms on *consistent reads* (MVCC snapshot) but not on *locking reads* or DML
- MySQL RR does NOT detect lost updates in read-modify-write patterns

---

## Performance Impact

### Benchmark Ratios

Relative throughput under concurrent workloads (normalized to Read Committed = 1.0). Measured patterns are typical OLTP: 80% point reads, 15% updates, 5% range queries. Based on published benchmarks and common industry observations.

| Workload | RC | RR | Serializable (2PL) | Serializable (SSI) |
|----------|----|----|--------------------|--------------------|
| Low contention (1% hot rows) | 1.0 | 0.95 | 0.85 | 0.92 |
| Medium contention (10% hot rows) | 1.0 | 0.90 | 0.60 | 0.82 |
| High contention (50% hot rows) | 1.0 | 0.85 | 0.30 | 0.65 |
| Read-only | 1.0 | 0.99 | 0.95 | 0.98 |

Key observations:
- SSI (PostgreSQL) significantly outperforms 2PL (MySQL Serializable) under contention because reads don't block
- RR is nearly free for read-only workloads
- Under high contention, Serializable (2PL) can drop to 30% of RC throughput due to lock convoy effects

### Lock Wait Impact on P99 Latency

```
Isolation Level     P50 Latency    P99 Latency    P99/P50 Ratio
-----------------------------------------------------------------
Read Committed      2ms            12ms           6x
Repeatable Read     2ms            18ms           9x
Serializable (2PL)  3ms            150ms          50x
Serializable (SSI)  2ms            25ms           12.5x  (includes retry cost)
```

Under SSI, P99 includes the cost of occasional aborts + retries. Under 2PL, P99 reflects lock wait queuing.

### MVCC Read Overhead at Different Bloat Levels

Dead tuples slow down sequential scans because PostgreSQL must check visibility for every tuple, live or dead.

```
Dead Tuple Ratio    Seq Scan Overhead    Index Scan Overhead
------------------------------------------------------------
0% (freshly vacuumed)   1.0x            1.0x
20%                     1.15x           1.02x
50%                     1.45x           1.05x
80%                     2.5x            1.10x
```

Index scans are relatively unaffected because they go directly to live tuples via the index. Sequential scans must traverse the entire heap, including dead tuples. This is why VACUUM frequency matters more for tables accessed via sequential scans.

---

## Application Patterns

### SELECT FOR UPDATE SKIP LOCKED: Queue-Worker Pattern

Use this to implement a database-backed job queue without external message brokers:

```sql
-- Worker picks up the next unprocessed job (PostgreSQL 16 / MySQL 8.0)
BEGIN;

SELECT id, payload
FROM job_queue
WHERE status = 'pending'
ORDER BY created_at
LIMIT 1
FOR UPDATE SKIP LOCKED;  -- Skip rows locked by other workers

-- Returns a row that no other worker is processing
-- If all pending rows are locked, returns empty set (worker sleeps and retries)

-- Process the job...

UPDATE job_queue SET status = 'completed', completed_at = now() WHERE id = $1;
COMMIT;
```

**Why this works:** `SKIP LOCKED` skips rows currently locked by other transactions, giving each worker a unique job without blocking. This works at *any* isolation level, including Read Committed.

**Advantage over polling:** No row contention, no deadlocks, no duplicate processing. Multiple workers can safely process the queue concurrently.

### Optimistic Locking with Version Columns

Full Python implementation with retry logic:

```python
import psycopg2
from psycopg2.extras import RealDictCursor

class OptimisticLockError(Exception):
    pass

def update_product_price(conn, product_id: int, new_price: float, max_retries: int = 3):
    """Update product price with optimistic concurrency control.

    Works correctly under Read Committed -- no elevated isolation needed.
    """
    for attempt in range(max_retries):
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            # Step 1: Read current state including version
            cur.execute(
                "SELECT id, price, version FROM products WHERE id = %s",
                (product_id,)
            )
            product = cur.fetchone()
            if not product:
                raise ValueError(f"Product {product_id} not found")

            current_version = product["version"]

            # Step 2: Business logic (could be complex computation)
            validated_price = validate_pricing_rules(new_price, product)

            # Step 3: Conditional update -- only succeeds if version unchanged
            cur.execute(
                """UPDATE products
                   SET price = %s, version = version + 1, updated_at = now()
                   WHERE id = %s AND version = %s""",
                (validated_price, product_id, current_version)
            )

            if cur.rowcount == 1:
                conn.commit()
                return  # Success
            else:
                conn.rollback()  # Version changed, retry
                continue

    raise OptimisticLockError(
        f"Failed to update product {product_id} after {max_retries} retries"
    )
```

This pattern works under Read Committed because the `WHERE version = %s` clause acts as a compare-and-swap. No elevated isolation level needed.

### Advisory Locks

PostgreSQL advisory locks are application-level cooperative locks -- the database doesn't enforce them on any table, but they provide a fast, deadlock-detectable mutual exclusion primitive.

```sql
-- Transaction-scoped advisory lock (released at COMMIT/ROLLBACK)
SELECT pg_try_advisory_xact_lock(12345);
-- Returns true if acquired, false if already held by another session

-- Use case: prevent duplicate processing of an event
BEGIN;
SELECT pg_try_advisory_xact_lock(hashtext('order:' || order_id::text));
-- If false, another worker is already processing this order -- skip
-- If true, process the order
COMMIT;  -- Lock automatically released
```

```sql
-- Session-scoped advisory lock (persists until explicit release or disconnect)
SELECT pg_advisory_lock(hash_key);      -- blocks until acquired
SELECT pg_advisory_unlock(hash_key);    -- explicit release required

-- Useful for: singleton cron jobs, schema migrations, cache warming
```

Advisory locks are checked via the same waits-for graph as regular locks, so deadlocks between advisory locks and row locks are detected.

### Anti-Pattern: Read-Modify-Write Under Read Committed

```sql
-- WRONG: This loses updates under Read Committed
-- Two concurrent sessions can read the same balance, compute independently, overwrite

-- Session 1                                    -- Session 2
BEGIN;                                          BEGIN;
SELECT balance FROM accounts WHERE id = 1;      SELECT balance FROM accounts WHERE id = 1;
-- Returns 100                                  -- Returns 100
UPDATE accounts SET balance = 150 WHERE id = 1;
COMMIT;                                         UPDATE accounts SET balance = 70 WHERE id = 1;
                                                COMMIT;
-- Final: 70 (lost Session 1's +50 deposit)
```

```sql
-- FIX Option 1: Atomic expression (no read-modify-write)
UPDATE accounts SET balance = balance + 50 WHERE id = 1;

-- FIX Option 2: SELECT FOR UPDATE (pessimistic)
BEGIN;
SELECT balance FROM accounts WHERE id = 1 FOR UPDATE;  -- acquires row lock
-- Other sessions block on their SELECT FOR UPDATE until this commits
UPDATE accounts SET balance = balance + 50 WHERE id = 1;
COMMIT;

-- FIX Option 3: Optimistic locking (see version column pattern above)
```

Always prefer atomic expressions when possible. They're simpler, faster, and correct at any isolation level.

---

## Database-Specific Notes

### PostgreSQL (v16)

**Isolation implementation:**
- Read Committed: each *statement* gets a fresh snapshot
- Repeatable Read: one snapshot for entire transaction, first-updater-wins for write conflicts
- Serializable: SSI-based, detects rw-anti-dependency cycles

**Monitoring dead tuples and XID health:**

```sql
-- Dead tuple monitoring
SELECT schemaname, relname, n_live_tup, n_dead_tup,
       round(n_dead_tup::numeric / greatest(n_live_tup, 1) * 100, 1) AS bloat_pct,
       last_autovacuum
FROM pg_stat_user_tables
WHERE n_dead_tup > 1000
ORDER BY n_dead_tup DESC;
```

**XID wraparound prevention:**

PostgreSQL transaction IDs are 32-bit (4 billion values). When the XID counter approaches wraparound, PostgreSQL forces aggressive vacuuming and eventually shuts down to prevent data corruption.

```sql
-- Check XID age (how close to wraparound)
SELECT datname,
       age(datfrozenxid) AS xid_age,
       round(age(datfrozenxid)::numeric / 2147483647 * 100, 2) AS pct_to_wraparound
FROM pg_database
ORDER BY xid_age DESC;

-- Danger zone: xid_age > 1 billion (autovacuum_freeze_max_age default: 200 million)
-- Emergency zone: xid_age > 2 billion (database shuts down to prevent wraparound)
```

Long-running transactions prevent VACUUM from advancing the frozen XID horizon. A single idle-in-transaction session can hold back the entire cluster.

### MySQL InnoDB (v8.0)

**Default isolation:** Repeatable Read (unlike PostgreSQL's Read Committed default)

**Key diagnostics:**

```sql
-- Active transactions
SELECT trx_id, trx_state, trx_started,
       timestampdiff(SECOND, trx_started, now()) AS age_seconds,
       trx_rows_locked, trx_rows_modified, trx_isolation_level
FROM information_schema.innodb_trx
ORDER BY trx_started;

-- Lock waits
SELECT r.trx_id AS waiting_trx,
       r.trx_query AS waiting_query,
       b.trx_id AS blocking_trx,
       b.trx_query AS blocking_query
FROM information_schema.innodb_lock_waits w
JOIN information_schema.innodb_trx b ON b.trx_id = w.blocking_trx_id
JOIN information_schema.innodb_trx r ON r.trx_id = w.requesting_trx_id;

-- Detailed lock information (MySQL 8.0+)
SELECT engine_lock_id, lock_type, lock_mode, lock_status,
       lock_data, object_name
FROM performance_schema.data_locks
WHERE lock_status = 'WAITING';
```

**MySQL RR quirks:**
- Consistent reads (plain SELECT) use MVCC snapshot -- no phantoms
- Locking reads (SELECT FOR UPDATE, SELECT FOR SHARE) read the *latest committed version*, not the snapshot
- This inconsistency means the same WHERE clause can match different rows depending on whether you use a locking or non-locking read

### Oracle (21c)

- Supports only Read Committed and Serializable
- No Read Uncommitted, no Repeatable Read
- **"Serializable" is actually Snapshot Isolation** -- it does NOT prevent write skew
- Oracle detects write-write conflicts (ORA-08177: can't serialize access) but not read-write conflicts
- True serializability requires application-level `SELECT FOR UPDATE`

```sql
-- Oracle: set serializable (actually SI)
ALTER SESSION SET ISOLATION_LEVEL = SERIALIZABLE;

-- Write skew IS possible here. Oracle will not detect the doctor on-call anomaly.
```

### CockroachDB (v23.x)

- **Serializable by default** -- only isolation level available (until v23.2 added Read Committed as opt-in)
- Uses a distributed SSI implementation across nodes
- Cross-node transactions incur coordination overhead (~2-5ms per involved range)
- Automatic transaction retries at the gateway node when possible (transparent to client)
- Contention on hot rows causes "transaction retry" errors just like PostgreSQL SSI

```sql
-- CockroachDB: check contention
SELECT * FROM crdb_internal.cluster_contended_tables;
SELECT * FROM crdb_internal.cluster_contended_indexes;
```

---

## Common Mistakes

### 1. Connection Pool Isolation Level Leaking

If you set isolation level on a connection and return it to the pool without resetting, the next borrower inherits it:

```python
# BUG: isolation level leaks through the pool
conn = pool.getconn()
conn.set_isolation_level(ISOLATION_LEVEL_SERIALIZABLE)
# ... do work ...
pool.putconn(conn)
# Next pool.getconn() may return this connection -- still at SERIALIZABLE!
```

**Fix:** Always reset isolation level before returning to pool, or use transaction-level isolation:

```sql
-- Per-transaction isolation (doesn't affect connection default)
BEGIN ISOLATION LEVEL SERIALIZABLE;
-- ... work ...
COMMIT;
-- Connection returns to its default level
```

### 2. MySQL RR Doesn't Prevent Write Skew

A common misconception: "Repeatable Read prevents all anomalies except phantoms." This is only true if you ignore write skew, which the original SQL standard did.

```sql
-- MySQL 8.0, Repeatable Read: write skew succeeds (BUG if you need invariant)
-- The doctor on-call example runs without error on MySQL RR.
-- Both transactions commit successfully. Zero doctors on call.

-- Fix: Use SELECT ... FOR UPDATE to escalate to locking reads
BEGIN;
SELECT * FROM doctors WHERE on_call = true FOR UPDATE;  -- Now this blocks
```

### 3. Long Transactions Blocking VACUUM

The most common PostgreSQL performance disaster in production:

```sql
-- This idle transaction prevents VACUUM from cleaning ANY dead tuples
-- created after its snapshot
BEGIN;  -- snapshot taken
SELECT * FROM tiny_table;  -- harmless-looking query
-- Developer forgets to COMMIT, goes to lunch
-- Meanwhile, heavy UPDATE traffic on big_table creates millions of dead tuples
-- Autovacuum runs but cannot remove tuples newer than this snapshot
-- Table bloats, sequential scans slow down, disk fills up
```

**Prevention:**

```sql
-- PostgreSQL: kill idle-in-transaction sessions automatically
ALTER SYSTEM SET idle_in_transaction_session_timeout = '5min';
SELECT pg_reload_conf();

-- Monitor for long-running transactions
SELECT pid, now() - xact_start AS duration, query, state
FROM pg_stat_activity
WHERE state = 'idle in transaction'
  AND now() - xact_start > interval '1 minute'
ORDER BY duration DESC;
```

### 4. Assuming All Databases Implement the Same Level Identically

The SQL standard defines isolation levels by which anomalies they prevent, but implementations vary dramatically:

| Behavior | PostgreSQL RR | MySQL RR | Oracle "Serializable" |
|----------|--------------|----------|----------------------|
| Phantoms prevented | Yes (MVCC) | Partial (gap locks) | Yes (MVCC) |
| Lost updates prevented | Yes (first-updater-wins) | No | Yes (ORA-08177) |
| Write skew prevented | No | No | No |
| True serializability | No (need Serializable) | No (need Serializable) | No (need app logic) |

---

## Key Takeaways

1. **Higher isolation = fewer bugs, worse throughput.** The cost is real: Serializable (2PL) can drop to 30% of Read Committed throughput under contention
2. **Read Committed is usually good enough.** Pair it with atomic SQL expressions and SELECT FOR UPDATE for critical sections
3. **Repeatable Read is not the same across databases.** PostgreSQL RR prevents lost updates; MySQL RR does not
4. **Serializable (SSI) is practical.** PostgreSQL's SSI is far cheaper than MySQL's lock-based Serializable -- consider it for correctness-critical workloads
5. **Application-level patterns close isolation gaps cheaply.** SELECT FOR UPDATE, optimistic locking with version columns, and advisory locks avoid global Serializable overhead
6. **MVCC is not free.** Dead tuples accumulate, VACUUM must keep up, and long transactions block cleanup. Monitor `n_dead_tup` and `idle_in_transaction_session_timeout`
7. **Database "isolation levels" don't match the SQL standard.** Oracle's "Serializable" is SI. MySQL's "Repeatable Read" has locking-read inconsistencies. Always test your database's actual behavior
8. **Always retry on serialization failure (SQLSTATE 40001).** SSI aborts are expected, not exceptional -- build retry logic into your data access layer

> Cross-reference: see [Consistency Models](04-consistency-models.md) for the linearizability spectrum and distributed consistency guarantees beyond single-node isolation.
