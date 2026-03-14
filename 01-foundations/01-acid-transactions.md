# ACID Transactions

## TL;DR

ACID is a set of properties that guarantee database transactions are processed reliably. But "ACID" is a marketing term — the actual guarantees vary wildly between databases. Each letter hides real engineering tradeoffs: undo logs vs redo logs, fsync latency vs durability, isolation cost vs throughput. Understanding the machinery behind each letter is the difference between a system that survives crashes and one that silently corrupts data.

---

## The Problem ACID Solves

Consider a bank transfer: move $100 from Account A to Account B.

```text
1. Read balance of A: $500
2. Subtract $100 from A: $400
3. Write new balance to A
4. Read balance of B: $200
5. Add $100 to B: $300
6. Write new balance to B
```

What can go wrong without transactional guarantees?

**Crash failures:**
- Crash after step 3 → A lost $100, B gained nothing. Money vanished from the system.
- Crash during step 6 → Disk has partial write. B's balance is corrupted bytes, not $200 or $300.

**Concurrency failures:**
- Two transfers from A execute concurrently. Both read $500, both subtract $100, both write $400. A should be $300, but is $400. The bank created $100 from nothing.
- A reporting query runs between steps 3 and 6. It sees A debited but B not yet credited. The books don't balance.

**Durability failures:**
- The database says COMMIT succeeded. Power dies. The kernel had the write in its page cache but never called fsync. On restart, the write is gone.
- The disk firmware acknowledged the write but the data was in the disk's volatile write buffer. Power loss means the "confirmed" write never reached the platter.

These aren't theoretical. Every production database team has war stories for each category. ACID is the set of guarantees that, when correctly implemented and configured, prevents all of them.

---

## Atomicity — Deep Dive

### What It Actually Means

Atomicity does NOT mean "all operations happen instantaneously." That is closer to isolation.

**Atomicity means: all-or-nothing execution.** If a transaction commits, all its writes are applied. If it aborts (or the system crashes before commit), none of its writes are visible.

### Why It Matters

Without atomicity, every multi-statement operation is a potential source of data corruption. Any crash, network timeout, or constraint violation mid-transaction leaves the database in an inconsistent intermediate state. The alternative — writing manual cleanup and rollback logic in application code — is prohibitively error-prone.

### Undo Log vs Redo Log

Databases use two fundamentally different logging strategies for atomicity and durability. Most production systems use one or both.

**Undo log (rollback log):**
- Before modifying a page, write the *old value* to the undo log
- On ROLLBACK or crash recovery: replay the undo log to restore original values
- Used by InnoDB (MySQL) as the primary mechanism for atomicity
- InnoDB stores undo logs in the system tablespace or dedicated undo tablespaces

**Redo log (write-ahead log / WAL):**
- Before modifying a page, write the *new value* to the redo log
- On crash recovery: replay the redo log to reapply committed changes
- Used by PostgreSQL as the primary mechanism (pg_wal directory)
- PostgreSQL WAL is append-only, sequential I/O — much faster than random page writes

**InnoDB uses both simultaneously (PostgreSQL 16):**

```text
InnoDB transaction lifecycle:
1. BEGIN
2. Write old values to undo log (in buffer pool)
3. Write new values to redo log (ib_logfile0/ib_logfile1)
4. Modify buffer pool pages in memory (dirty pages)
5. On COMMIT: fsync redo log → return success to client
6. Checkpoint: flush dirty pages to tablespace files (async)
7. Purge: clean up undo log entries after no transaction needs them
```

```text
PostgreSQL transaction lifecycle (v16):
1. BEGIN
2. Write WAL records (new values) to WAL buffer
3. Modify pages in shared buffer pool (with before-images kept via MVCC)
4. On COMMIT: flush WAL buffer to pg_wal segment file → fsync → return success
5. Checkpoint: flush dirty buffers to data files (async, configurable interval)
6. Old row versions cleaned up by autovacuum (async)
```

The key difference: InnoDB needs undo logs for rollback because it updates pages in-place. PostgreSQL uses MVCC — old row versions remain in the heap until vacuumed — so it doesn't need a separate undo log for atomicity.

### How ROLLBACK Works: LSN Traversal and Undo Chains

Every log record has a **Log Sequence Number (LSN)** — a monotonically increasing identifier.

**InnoDB rollback (MySQL 8.0):**

```text
Transaction T1 modifies rows R1, R2, R3:
  LSN 1001: undo record for R1 (old value), prev_undo_ptr → NULL
  LSN 1002: undo record for R2 (old value), prev_undo_ptr → 1001
  LSN 1003: undo record for R3 (old value), prev_undo_ptr → 1002

ROLLBACK T1:
  1. Find T1's last undo record (LSN 1003)
  2. Restore R3 to old value
  3. Follow prev_undo_ptr to LSN 1002
  4. Restore R2 to old value
  5. Follow prev_undo_ptr to LSN 1001
  6. Restore R1 to old value
  7. Follow prev_undo_ptr to NULL → done
```

Each transaction maintains a linked list of its undo records. Rollback traverses this chain in reverse order. This is why rolling back a transaction that modified millions of rows can take as long as the transaction itself — it must undo each change individually.

**PostgreSQL rollback** is cheaper: it simply marks the transaction as aborted in the commit log (pg_xact). The dead tuples left behind are invisible to subsequent transactions via visibility rules and get cleaned up by autovacuum later.

### Savepoints and Partial Rollback

Savepoints allow rolling back part of a transaction without aborting the entire thing. This is critical for complex business logic with conditional paths.

```sql
-- PostgreSQL 16
BEGIN;

INSERT INTO orders (id, customer_id, total) VALUES (1001, 42, 299.99);

SAVEPOINT before_inventory;

UPDATE inventory SET quantity = quantity - 1 WHERE product_id = 7;
-- Suppose this violates a CHECK constraint (quantity >= 0)

ROLLBACK TO SAVEPOINT before_inventory;
-- The order INSERT is still intact
-- Only the inventory UPDATE was undone

-- Try alternative fulfillment
UPDATE inventory SET quantity = quantity - 1 WHERE product_id = 7 AND warehouse = 'secondary';

COMMIT;
```

**Implementation detail:** savepoints create a sub-transaction (subtransaction in PostgreSQL). Each subtransaction gets its own transaction ID. PostgreSQL tracks subtransaction state in pg_subtrans. InnoDB creates a new undo log segment for each savepoint.

**Warning:** deeply nested savepoints have overhead. PostgreSQL's pg_subtrans can become a bottleneck with thousands of subtransactions. If you need savepoints in a loop, reconsider your transaction design.

### Distributed Atomicity: Two-Phase Commit (2PC)

When a transaction spans multiple database nodes, local undo logs are not enough. The classic solution is the **two-phase commit protocol**.

```text
Coordinator (transaction manager)
├── Participant A (shard holding Account A)
└── Participant B (shard holding Account B)

Phase 1 — Prepare (vote):
  Coordinator → A: "PREPARE transaction T1"
  Coordinator → B: "PREPARE transaction T1"
  A: writes all changes to durable log, acquires locks, responds YES
  B: writes all changes to durable log, acquires locks, responds YES

Phase 2 — Commit (decision):
  Coordinator: all voted YES → writes COMMIT decision to its own durable log
  Coordinator → A: "COMMIT T1"
  Coordinator → B: "COMMIT T1"
  A: commits, releases locks
  B: commits, releases locks
```

```sql
-- PostgreSQL 16 native 2PC (used by connection poolers, ORMs, distributed systems)
-- On participant:
BEGIN;
UPDATE accounts SET balance = balance - 100 WHERE id = 'A';
PREPARE TRANSACTION 'transfer_1001_partA';

-- Later, coordinator decides:
COMMIT PREPARED 'transfer_1001_partA';
-- or
ROLLBACK PREPARED 'transfer_1001_partA';
```

**The coordinator failure problem:**

The critical vulnerability of 2PC is coordinator failure between phases. If the coordinator crashes after receiving all YES votes but before broadcasting the COMMIT decision:

```text
Timeline:
  t0: Coordinator sends PREPARE to A and B
  t1: A votes YES, B votes YES (both holding locks, changes durable)
  t2: Coordinator writes COMMIT to its log
  t3: *** Coordinator crashes ***

  A and B are now "in-doubt" — they cannot safely commit or abort:
  - Committing risks inconsistency if coordinator actually decided ABORT
  - Aborting risks inconsistency if coordinator actually decided COMMIT
  - Locks are held indefinitely until coordinator recovers
```

**In-doubt transactions** are operationally dangerous. They hold locks, block other transactions, and require manual intervention if the coordinator cannot recover.

```sql
-- PostgreSQL: find in-doubt transactions
SELECT gid, prepared, owner, database
FROM pg_prepared_xacts;

-- Manual resolution (ONLY when you've confirmed the correct outcome):
COMMIT PREPARED 'transfer_1001_partA';
```

**Mitigations for coordinator failure:**
- Coordinator writes the decision to a replicated, durable log before phase 2
- Participants timeout and query the coordinator (or its replicas) for the decision
- Three-phase commit (3PC) adds a pre-commit phase but is rarely used in practice due to complexity and network partition vulnerability
- Most modern distributed databases (CockroachDB, YugabyteDB) use Raft/Paxos for the commit decision, avoiding the single-coordinator failure mode

**2PC performance cost:** every distributed transaction requires at minimum 2 extra network round-trips and 3 forced log flushes (one per participant in prepare, one for coordinator decision). This typically adds 5–20ms of latency compared to a local transaction.

---

## Consistency — The Weakest Letter

### What the Database Enforces vs What It Can't

**Consistency means: transactions move the database from one valid state to another.** But "valid" is defined entirely by the constraints you've declared.

The database enforces:
- NOT NULL, CHECK constraints
- UNIQUE and PRIMARY KEY
- FOREIGN KEY referential integrity
- EXCLUDE constraints (PostgreSQL)
- Trigger-based invariants

The database cannot enforce:
- "Account balance should match the sum of all transaction entries" (unless you write a trigger)
- "Every order must have at least one line item" (cross-table invariant)
- "The total across all accounts must remain constant" (global invariant)
- Any business rule that lives only in application code

**Consistency is therefore the weakest ACID guarantee** — it's largely an application-level responsibility. The database provides tools (constraints, triggers), but correctness depends on the developer using them.

### The "C" Overloading Problem

The letter C means completely different things in different contexts:

| Context | "Consistency" means | Enforced by |
|---------|-------------------|-------------|
| ACID | Data satisfies declared constraints | Database constraints |
| CAP theorem | All nodes see the same data at the same time (linearizability) | Consensus protocols |
| Replicas | Replicas converge to the same state | Replication protocol |

→ see [Consistency Models](04-consistency-models.md) for linearizability, causal consistency, and eventual consistency.

These are three fundamentally different concepts sharing one word. When someone says "this system is consistent," always ask which definition they mean.

### Deferred Constraints

Some constraints can't be checked row-by-row. Consider mutual foreign keys:

```sql
-- PostgreSQL 16
-- departments references employees.head, employees references departments
-- Inserting either first violates the FK of the other

-- Solution: deferred constraints
ALTER TABLE employees
  ADD CONSTRAINT fk_department
  FOREIGN KEY (department_id) REFERENCES departments(id)
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE departments
  ADD CONSTRAINT fk_head
  FOREIGN KEY (head_employee_id) REFERENCES employees(id)
  DEFERRABLE INITIALLY DEFERRED;

BEGIN;
INSERT INTO departments (id, name, head_employee_id) VALUES (1, 'Engineering', 100);
INSERT INTO employees (id, name, department_id) VALUES (100, 'Alice', 1);
-- Constraints checked HERE, at COMMIT time, not at each INSERT
COMMIT;
```

You can also defer constraints per-transaction:

```sql
BEGIN;
SET CONSTRAINTS fk_department DEFERRED;
-- ... operations that temporarily violate the constraint ...
COMMIT;  -- constraint checked here
```

**Use cases for deferred constraints:**
- Circular foreign keys (as above)
- Bulk data loading where intermediate states violate uniqueness
- Graph structures with parent-child self-references
- Schema migrations that reorder data

**Caveat:** deferred unique constraints in PostgreSQL use a different index mechanism and can have performance implications on large tables. Test with production-scale data.

### Foreign Keys Across Shards

Once you shard your database, ACID consistency for cross-shard foreign keys is effectively impossible at the database layer.

```text
Shard A (users 1-1000):
  users table, orders table for these users

Shard B (users 1001-2000):
  users table, orders table for these users

Problem: order on Shard A references a product catalog on Shard B.
  - No cross-shard FK enforcement
  - Shard B could delete the product while Shard A's order references it
  - No transaction spans both shards without 2PC (which is slow)
```

**Practical approaches:**
- **Denormalize:** copy referenced data into the local shard (accept eventual staleness)
- **Application-level enforcement:** check before write, accept race conditions
- **Event-driven cleanup:** detect and repair broken references asynchronously
- **Avoid cross-shard references:** co-locate related data on the same shard

This is a fundamental reason why distributed systems often relax consistency. → see [CAP Theorem](03-cap-theorem.md)

### Why Distributed Systems Dropped C

In a single-node database, consistency is a transaction-level property — if all your constraints are declared, the DB enforces them. In a distributed database, the cost of validating cross-shard constraints inside a transaction is prohibitive:

- Every cross-shard constraint check adds network round-trips
- Distributed deadlock detection is expensive
- Global constraint validation doesn't scale

This is why Google Spanner, CockroachDB, and YugabyteDB support ACID transactions but don't support cross-shard foreign keys with the same guarantees as a single-node PostgreSQL. The C in their ACID means "constraints that can be checked locally on a single shard."

---

## Isolation — The Expensive Letter

### The Core Challenge

Isolation answers: "What do concurrent transactions see?" The ideal (serializability) means transactions behave as if they ran one-at-a-time. The reality: full isolation is expensive, so databases offer weaker levels.

### Isolation Levels Summary

| Level | Dirty Reads | Non-Repeatable Reads | Phantom Reads | Write Skew |
|-------|-------------|----------------------|---------------|------------|
| Read Uncommitted | Yes | Yes | Yes | Yes |
| Read Committed | No | Yes | Yes | Yes |
| Repeatable Read | No | No | Yes (InnoDB: No) | Yes |
| Serializable | No | No | No | No |

**Implementation approaches:**
1. **Locking (2PL):** transactions acquire locks, block each other. Used by SQL Server for Serializable.
2. **MVCC:** keep multiple row versions, readers don't block writers. Used by PostgreSQL, InnoDB for most levels.
3. **OCC (Optimistic Concurrency Control):** assume no conflicts, validate at commit time. Used by some in-memory databases.
4. **SSI (Serializable Snapshot Isolation):** MVCC + dependency tracking. PostgreSQL's Serializable implementation since 9.1.

→ see [Isolation Levels](02-isolation-levels.md) for MVCC internals, locking protocols, SSI implementation details, and anomaly deep dives.

### Connection Pool Gotcha: SET TRANSACTION per Connection

A common production bug when using connection pools (PgBouncer, HikariCP):

```sql
-- Developer intends Serializable for this one critical transaction:
SET TRANSACTION ISOLATION LEVEL SERIALIZABLE;
BEGIN;
SELECT balance FROM accounts WHERE id = 42;
UPDATE accounts SET balance = balance - 100 WHERE id = 42;
COMMIT;
```

**The problem:** if the connection pool returns this connection to the pool and gives it to another request, the isolation level setting may persist (depending on the pool mode and database). In PgBouncer transaction-mode pooling, `SET` commands leak between sessions.

**Correct approach:**

```sql
-- Use BEGIN with isolation level (scoped to the transaction)
BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE;
SELECT balance FROM accounts WHERE id = 42;
UPDATE accounts SET balance = balance - 100 WHERE id = 42;
COMMIT;
-- Isolation level automatically resets after COMMIT/ROLLBACK
```

In application code, always set isolation level as part of BEGIN, never as a separate SET command, when using connection pools.

---

## Durability — The Latency Letter

### Why It Matters

Durability is the promise that keeps users trusting databases. When COMMIT returns success, the data must survive process crashes, OS crashes, and power failures. Breaking this promise means silent data loss — the worst kind of bug because nobody knows it happened until the data is needed.

### fsync Deep Dive

`fsync()` is the system call that makes durability real. Understanding what it does (and doesn't do) is critical.

```text
Application writes data:
  1. write() → data goes to kernel page cache (RAM) → returns immediately
  2. fsync() → kernel flushes page cache to disk controller → waits for ack
  3. Disk controller writes to persistent media (platter or NAND cells)

What fsync actually forces:
  - Flush kernel page cache dirty pages for this file to the disk controller
  - Flush the disk's volatile write buffer to persistent storage
  - Wait for the disk to confirm the write is on stable media
```

**Where fsync can lie:**

```text
Failure point 1: Disk write buffer
  - Some disks report fsync complete before data leaves volatile write buffer
  - Enterprise SSDs have capacitor-backed write buffers (safe)
  - Consumer SSDs may not (unsafe for databases)
  - Check: hdparm -W /dev/sda (Linux), 0 = write cache disabled

Failure point 2: RAID controller cache
  - Battery-backed (BBU) or flash-backed: safe
  - No battery: fsync lies, data in volatile controller RAM

Failure point 3: Filesystem behavior
  - ext4 with data=ordered (default): metadata journaled, data flushed before metadata
  - XFS: metadata journaled, data may have holes after crash on older kernels
  - ZFS: copy-on-write, checksums — most reliable for databases
```

**PostgreSQL and fsync — the 2018 incident:**

PostgreSQL before v12 had a critical bug: if fsync() failed, PostgreSQL retried the fsync, assuming the dirty page was still in the kernel page cache. But some Linux kernels (pre-5.2) removed the dirty page from the page cache on fsync failure. The retry fsync'd a clean page — succeeding without writing anything. This meant PostgreSQL thought data was durable when it wasn't.

PostgreSQL 12+ responds to fsync failure by performing a PANIC (crash recovery) rather than retrying, because the kernel state is untrustworthy.

### WAL Mechanics

The Write-Ahead Log is the cornerstone of durability in PostgreSQL (and redo logs serve the same role in InnoDB).

**WAL segment files (PostgreSQL 16):**

```text
$PGDATA/pg_wal/
├── 000000010000000000000001   (16 MB segment, default)
├── 000000010000000000000002
├── 000000010000000000000003
└── archive_status/

Segment naming: TimelineID + (LSN >> 24)
Default segment size: 16 MB (configurable at initdb with --wal-segsize)
```

**WAL record structure:**

```text
Each WAL record contains:
  - LSN (Log Sequence Number): unique, monotonically increasing position
  - Transaction ID
  - Resource manager ID (heap, btree, hash, etc.)
  - Record type (insert, update, delete, commit, etc.)
  - Before/after images of modified data (depending on full_page_writes setting)
  - CRC checksum
```

**Checkpoint frequency and crash recovery:**

Checkpoints write all dirty buffers from shared_buffers to data files, then record the checkpoint LSN. On crash recovery, PostgreSQL only needs to replay WAL from the last checkpoint forward.

```text
Crash recovery time ≈ (WAL generated since last checkpoint) / (sequential read throughput)

Example:
  checkpoint_timeout = 5 min (default)
  WAL generation rate = 50 MB/s (busy OLTP)
  Max WAL since checkpoint = 50 MB/s × 300s = 15 GB
  SSD sequential read = 500 MB/s
  Recovery time ≈ 15 GB / 500 MB/s = 30 seconds

Tuning tradeoffs:
  - Shorter checkpoint interval → faster recovery, more I/O during normal operation
  - Longer checkpoint interval → slower recovery, less I/O overhead
  - max_wal_size controls when a checkpoint is forced (default: 1 GB)
```

**InnoDB redo log (MySQL 8.0):**

```text
InnoDB uses a circular redo log (ib_logfile0, ib_logfile1 in older versions;
  #ib_redo directory with multiple files in MySQL 8.0.30+):

  - Fixed total size: innodb_redo_log_capacity (default 100 MB in 8.0.30+)
  - Circular buffer: head advances as new records are written
  - Tail advances as checkpoints flush dirty pages
  - If head catches tail: all transactions stall until checkpoint completes

  Sizing rule of thumb:
  - Redo log should hold ~1 hour of writes for busy systems
  - Too small: frequent checkpoint stalls, spiky latency
  - Too large: longer crash recovery time
```

### Group Commit: Batching WAL Flushes

Every COMMIT requires an fsync of the WAL. fsync has fixed overhead regardless of data size, so fsyncing once for 10 transactions is nearly as fast as fsyncing once for 1 transaction.

**Group commit** batches multiple concurrent commits into a single WAL flush.

```text
Without group commit:
  T1: write WAL → fsync (2ms) → return
  T2: write WAL → fsync (2ms) → return
  T3: write WAL → fsync (2ms) → return
  Total: 6ms, max throughput ≈ 500 commits/sec per disk

With group commit:
  T1: write WAL → wait
  T2: write WAL → wait
  T3: write WAL → wait
  Leader: fsync all three → return to T1, T2, T3
  Total: 2ms for all three, throughput scales with concurrency
```

**PostgreSQL group commit tuning (v16):**

```text
# postgresql.conf

# How long to delay before flushing WAL, hoping more commits arrive
commit_delay = 10          # microseconds (default: 0 = disabled)

# Only delay if at least this many transactions are active
commit_siblings = 5        # (default: 5)

# Effect: if ≥ 5 concurrent transactions, wait 10μs before fsync
# This batches more commits into each fsync, improving throughput
# at the cost of 10μs additional latency per commit
```

**When to tune group commit:**
- High commit rate (>1000 commits/sec) with commit latency dominated by fsync
- Storage with high fsync latency (network-attached, cloud volumes)
- Workloads with many small transactions

**InnoDB group commit (MySQL 8.0):**

```text
InnoDB implements group commit in three stages:
1. FLUSH stage: write redo log to OS buffer
2. SYNC stage: fsync the redo log (where batching happens)
3. COMMIT stage: update transaction status

# my.cnf
innodb_flush_log_at_trx_commit = 1  # 1 = fsync every commit (default, safest)
                                     # 2 = write to OS buffer every commit, fsync once/sec
                                     # 0 = write+fsync once/sec (data loss on crash)
binlog_group_commit_sync_delay = 0   # microseconds to wait for more transactions
binlog_group_commit_sync_no_delay_count = 0  # commit immediately if this many waiting
```

### synchronous_commit = off: When Acceptable

PostgreSQL's `synchronous_commit` controls whether COMMIT waits for WAL fsync.

```sql
-- Per-transaction override (PostgreSQL 16)
SET LOCAL synchronous_commit = off;
-- Subsequent COMMIT returns immediately, WAL fsynced asynchronously
-- Risk window: ~10ms of data loss (3 × wal_writer_delay)
```

**What you lose:** if PostgreSQL crashes within ~10ms of commit, that transaction's changes may be lost. The database remains consistent (no corruption), but committed transactions may vanish.

**When this is acceptable:**
- Logging/analytics inserts where losing a few seconds of data is tolerable
- Session state or cache writes that can be reconstructed
- High-throughput event ingestion with downstream consumers that handle replays

**When this is NOT acceptable:**
- Financial transactions
- Any write where the application has already acknowledged success to the user
- Writes that trigger irreversible side effects (sent emails, API calls)

```text
Performance impact (typical SSD):
  synchronous_commit = on:  ~3,000 commits/sec
  synchronous_commit = off: ~30,000 commits/sec (10x improvement)

The gap widens on high-latency storage (cloud EBS, network-attached).
```

### Cloud Gotchas: Not All fsync Is Equal

Cloud block storage introduces a layer of abstraction that changes durability guarantees.

**AWS EBS volumes:**

```text
Volume Type    | IOPS (baseline) | fsync latency  | Durability notes
---------------|-----------------|----------------|------------------
gp3            | 3,000           | 0.5–2ms        | Replicated within AZ
io2 Block Expr | up to 256,000   | 0.2–0.5ms      | 99.999% durability SLA
io1            | up to 64,000    | 0.3–1ms        | 99.8–99.9% durability
st1 (HDD)     | 500 (throughput) | 5–20ms         | Not suitable for WAL

Key insight: EBS replicates within a single AZ. An AZ outage can
lose EBS volumes. Cross-AZ replication (RDS Multi-AZ, streaming
replication) is your second tier of durability.
```

**GCP Persistent Disk:**
- pd-ssd: similar to EBS gp3 performance
- Local SSD: lowest latency but **ephemeral** — data lost on VM stop/migration. Never use for WAL without replication.

**General cloud storage rule:** assume the cloud provider's fsync is correct, but verify with a tool like `diskchecker.pl` or `fio` with `fsync=1`. Some VM types or hypervisor configs may not honor fsync properly.

### Replication as Second Tier of Durability

A single disk (or single EBS volume) is not enough for production durability. Disks fail, AZs go offline, and entire regions can have outages.

```text
Durability tiers (PostgreSQL):

Tier 0: synchronous_commit = off
  - WAL in memory only, fsynced asynchronously
  - Risk: lose ~10ms of commits on crash
  - Use: ephemeral data

Tier 1: synchronous_commit = on (default)
  - WAL fsynced to local disk before COMMIT returns
  - Risk: disk failure loses data; AZ failure loses data
  - Use: single-node development, small deployments

Tier 2: Synchronous streaming replication
  - WAL shipped to standby AND fsynced on standby before COMMIT returns
  - synchronous_standby_names = 'standby1'
  - Risk: simultaneous failure of primary + standby
  - Cost: commit latency includes network RTT to standby (~1ms same AZ)
  - Use: production databases requiring durability

Tier 3: Synchronous replication to multiple standbys across AZs
  - synchronous_standby_names = 'FIRST 2 (standby1, standby2, standby3)'
  - Risk: simultaneous AZ failure (extremely rare)
  - Cost: commit latency = max(RTT to required standbys) (~2-5ms cross-AZ)
  - Use: critical financial/healthcare systems
```

---

## Production Failure Modes (Transaction-Specific)

These are failure patterns specific to transaction misuse. → see [Failure Modes](06-failure-modes.md) for the general taxonomy.

### Lost Update Without Proper Isolation

The most common transaction bug in production.

**The pattern (read-then-write):**

```python
# DANGEROUS: Python with psycopg2 (PostgreSQL 16)
# Two concurrent requests both try to increment a counter

# Request 1                          # Request 2
cur.execute("SELECT count            cur.execute("SELECT count
  FROM counters WHERE id=1")           FROM counters WHERE id=1")
count = cur.fetchone()[0]  # 10      count = cur.fetchone()[0]  # 10
count += 1                            count += 1
cur.execute("UPDATE counters          cur.execute("UPDATE counters
  SET count=%s WHERE id=1",             SET count=%s WHERE id=1",
  (count,))                             (count,))
# Final value: 11 (should be 12)
```

**The fix — atomic UPDATE:**

```sql
-- Correct: single atomic statement, no read-then-write race
UPDATE counters SET count = count + 1 WHERE id = 1;
```

**When you must read-then-write (complex logic):**

```sql
-- Use SELECT FOR UPDATE to acquire a row lock
BEGIN TRANSACTION ISOLATION LEVEL READ COMMITTED;
SELECT balance FROM accounts WHERE id = 42 FOR UPDATE;
-- Row is now locked; concurrent transactions block here
-- ... compute new balance in application ...
UPDATE accounts SET balance = 350.00 WHERE id = 42;
COMMIT;
```

### Partial Commit Visibility in Read Committed

Read Committed is the default in PostgreSQL. Each **statement** in a transaction sees a fresh snapshot. This causes subtle bugs in long transactions.

```sql
-- Session 1 (reporting query)
BEGIN;
SELECT sum(balance) FROM accounts WHERE region = 'US';
-- Returns $1,000,000

-- Meanwhile, Session 2 commits: moves $50,000 from US to EU account

SELECT sum(balance) FROM accounts WHERE region = 'EU';
-- This SELECT sees Session 2's commit! Different snapshot than the first SELECT.
-- The report shows $50,000 appearing from nowhere.
COMMIT;
```

**The fix:** use Repeatable Read for reporting queries that must see a consistent snapshot.

```sql
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ;
SELECT sum(balance) FROM accounts WHERE region = 'US';
-- ... even if other transactions commit here ...
SELECT sum(balance) FROM accounts WHERE region = 'EU';
-- Both SELECTs see the same snapshot
COMMIT;
```

### Long-Running Transactions Holding Resources

```text
Symptoms:
  - Lock wait timeouts on unrelated queries
  - Bloated table sizes (PostgreSQL: dead tuples not vacuumed)
  - Replication lag (slot can't advance past long tx)
  - "too many clients already" connection exhaustion

Root causes:
  - BEGIN with no matching COMMIT (idle in transaction)
  - Application exception skipping COMMIT/ROLLBACK
  - Batch jobs running in a single transaction

Monitoring (PostgreSQL 16):
```

```sql
-- Find long-running transactions
SELECT pid, now() - xact_start AS duration, state, query
FROM pg_stat_activity
WHERE state = 'idle in transaction'
  AND now() - xact_start > interval '5 minutes'
ORDER BY duration DESC;

-- Nuclear option: terminate the session
SELECT pg_terminate_backend(pid);
```

**Prevention:**

```text
# postgresql.conf
idle_in_transaction_session_timeout = '30s'   # kill idle-in-transaction after 30s
statement_timeout = '60s'                      # kill any statement after 60s
lock_timeout = '5s'                            # fail fast on lock waits
```

### Autocommit Misuse

Most database drivers default to autocommit=on, wrapping each statement in its own transaction. This is correct for simple queries but causes problems when developers don't realize multi-statement logic needs explicit transactions.

```python
# DANGEROUS: each statement is a separate transaction
conn.autocommit = True
cur.execute("UPDATE accounts SET balance = balance - 100 WHERE id = 1")
# ← crash here means money vanished
cur.execute("UPDATE accounts SET balance = balance + 100 WHERE id = 2")
```

```python
# CORRECT: explicit transaction
conn.autocommit = False
try:
    cur.execute("UPDATE accounts SET balance = balance - 100 WHERE id = 1")
    cur.execute("UPDATE accounts SET balance = balance + 100 WHERE id = 2")
    conn.commit()
except Exception:
    conn.rollback()
    raise
```

**SQLAlchemy context manager pattern (recommended):**

```python
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

engine = create_engine("postgresql+psycopg2://localhost/mydb")

with Session(engine) as session, session.begin():
    # All operations in this block are a single transaction
    session.execute(text("UPDATE accounts SET balance = balance - 100 WHERE id = 1"))
    session.execute(text("UPDATE accounts SET balance = balance + 100 WHERE id = 2"))
# Automatic COMMIT on clean exit, ROLLBACK on exception
```

---

## Decision Framework

### Isolation Level Selection

| Use Case | Recommended Level | Why | Performance Cost |
|----------|------------------|-----|-----------------|
| Simple CRUD web app | Read Committed | Sufficient for non-overlapping writes | Baseline (1x) |
| Financial transfers | Serializable | Prevents write skew, phantom reads | 2–5x slower under contention |
| Reporting/analytics | Repeatable Read | Consistent snapshot across statements | ~1x (MVCC snapshot is cheap) |
| Inventory (stock counts) | Read Committed + SELECT FOR UPDATE | Row-level locking for specific rows | 1x + lock wait time |
| Counter increments | Read Committed + atomic UPDATE | Single statement, no race window | 1x |
| On-call ledger balancing | Serializable | Must prevent all anomalies | 2–5x, retry on serialization failure |

### When to Use 2PC vs Saga vs Outbox

| Pattern | Guarantees | Latency | Complexity | Use When |
|---------|-----------|---------|------------|----------|
| **2PC** | Atomicity across participants | +5–20ms per participant | Medium | Databases that support PREPARE TRANSACTION; low participant count (<5) |
| **Saga** | Eventual consistency with compensating actions | Low (async steps) | High (compensations are hard to get right) | Microservices, long-lived workflows, third-party API calls |
| **Outbox** | At-least-once delivery, local atomicity | Low (poll/CDC delay) | Medium | Single DB → message broker; event-driven architectures |

**Decision heuristic:**
- Can all participants be in the same database? → Use a local transaction. No 2PC needed.
- Are all participants databases you control? → 2PC is viable if latency is acceptable.
- Does the workflow involve external services (payment, email, APIs)? → Saga.
- Do you need to publish an event atomically with a database write? → Outbox pattern.

---

## Code Examples

### PostgreSQL: Two Sessions Showing Isolation

Open two `psql` sessions connected to the same PostgreSQL 16 database.

**Setup:**

```sql
CREATE TABLE accounts (id INT PRIMARY KEY, balance NUMERIC NOT NULL);
INSERT INTO accounts VALUES (1, 500), (2, 200);
```

**Demo: Read Committed prevents dirty reads but allows non-repeatable reads:**

```text
Session A (default Read Committed):      Session B:
─────────────────────────────────────     ──────────────────────────────
BEGIN;                                    BEGIN;
UPDATE accounts SET balance = 400
  WHERE id = 1;
                                          SELECT balance FROM accounts
                                            WHERE id = 1;
                                          -- Returns 500 (not 400!)
                                          -- Dirty read prevented ✓
COMMIT;
                                          SELECT balance FROM accounts
                                            WHERE id = 1;
                                          -- Returns 400
                                          -- Non-repeatable read! The
                                          -- value changed within the
                                          -- same transaction.
                                          COMMIT;
```

**Demo: Repeatable Read provides snapshot consistency:**

```text
Session A:                                Session B (Repeatable Read):
─────────────────────────────────────     ──────────────────────────────
                                          BEGIN TRANSACTION ISOLATION
                                            LEVEL REPEATABLE READ;
                                          SELECT balance FROM accounts
                                            WHERE id = 1;
                                          -- Returns 500
BEGIN;
UPDATE accounts SET balance = 400
  WHERE id = 1;
COMMIT;
                                          SELECT balance FROM accounts
                                            WHERE id = 1;
                                          -- Still returns 500!
                                          -- Snapshot is frozen at BEGIN
                                          COMMIT;
```

### Python SQLAlchemy: SELECT FOR UPDATE Pattern

```python
# Python 3.11+ / SQLAlchemy 2.0 / PostgreSQL 16
from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session

engine = create_engine(
    "postgresql+psycopg2://user:pass@localhost:5432/mydb",
    pool_size=10,
    pool_pre_ping=True,  # detect stale connections
)

def transfer(from_id: int, to_id: int, amount: float) -> None:
    """Transfer funds between accounts with proper locking.

    Acquires row locks in consistent order (lower ID first) to prevent deadlocks.
    """
    # Lock ordering: always lock lower ID first to prevent deadlock
    first_id, second_id = sorted([from_id, to_id])

    with Session(engine) as session, session.begin():
        # Acquire row locks in deterministic order
        rows = session.execute(
            text("""
                SELECT id, balance FROM accounts
                WHERE id IN (:id1, :id2)
                ORDER BY id
                FOR UPDATE
            """),
            {"id1": first_id, "id2": second_id},
        ).fetchall()

        balances = {row.id: row.balance for row in rows}

        if balances[from_id] < amount:
            raise ValueError(f"Insufficient funds: {balances[from_id]} < {amount}")

        session.execute(
            text("UPDATE accounts SET balance = balance - :amt WHERE id = :id"),
            {"amt": amount, "id": from_id},
        )
        session.execute(
            text("UPDATE accounts SET balance = balance + :amt WHERE id = :id"),
            {"amt": amount, "id": to_id},
        )
    # COMMIT happens here; ROLLBACK on exception
```

Key details in this example:
- **Lock ordering** (`sorted([from_id, to_id])`) prevents deadlocks when two concurrent transfers go in opposite directions
- **`FOR UPDATE`** acquires row-level exclusive locks, blocking concurrent modifications
- **`session.begin()` context manager** ensures ROLLBACK on exception
- **`pool_pre_ping=True`** handles connections dropped by PgBouncer or network timeouts

---

## ACID in Practice

| Database | Version | Default Isolation | Durability Mechanism | WAL/Redo Size Default | Gotchas |
|----------|---------|------------------|---------------------|-----------------------|---------|
| PostgreSQL | 16 | Read Committed | WAL + fsync | max_wal_size=1GB | `synchronous_commit=on` by default; `idle_in_transaction_session_timeout` is off by default |
| MySQL InnoDB | 8.0 | Repeatable Read | Redo log + doublewrite buffer | innodb_redo_log_capacity=100MB | `innodb_flush_log_at_trx_commit=1` is safe default but verify after provisioning |
| MongoDB | 7.0 | Read Committed (snapshot in replica set) | Journal (WiredTiger WAL) | 100MB journal | Default write concern `w:1` means no replication wait; use `w:majority` for durability |
| SQLite | 3.44 | Serializable | WAL mode or rollback journal | N/A | WAL mode requires shared memory; doesn't work on network filesystems |
| CockroachDB | 23.2 | Serializable (only level) | Raft consensus + RocksDB WAL | N/A | No weaker isolation available; serialization retries required in application |
| SQL Server | 2022 | Read Committed | Transaction log | Autogrow | `READ_COMMITTED_SNAPSHOT` is off by default (uses locking, not MVCC) |

### Warning: Check Your Defaults

Production databases ship with defaults optimized for safety on a single node. But managed services, containers, and provisioning scripts often override them. After every deployment, verify:

```sql
-- PostgreSQL: verify critical durability settings
SHOW synchronous_commit;         -- should be 'on' for critical data
SHOW fsync;                       -- should be 'on' (NEVER disable in production)
SHOW full_page_writes;            -- should be 'on' (prevents torn pages)
SHOW wal_level;                   -- 'replica' or 'logical' for replication

-- MySQL: verify InnoDB settings
SHOW VARIABLES LIKE 'innodb_flush_log_at_trx_commit';  -- should be 1
SHOW VARIABLES LIKE 'innodb_doublewrite';               -- should be ON
SHOW VARIABLES LIKE 'sync_binlog';                      -- should be 1 for durability
```

---

## Key Takeaways

1. **Atomicity** is implemented via undo logs (InnoDB) or WAL + MVCC (PostgreSQL). Rollback cost is proportional to transaction size in InnoDB, nearly free in PostgreSQL.
2. **Consistency** is the weakest letter — it only enforces constraints you've declared. Cross-shard foreign keys are effectively impossible. Distributed systems silently weaken this guarantee.
3. **Isolation** has levels with real performance costs. Default Read Committed is almost never wrong for OLTP, but reporting queries need Repeatable Read. Always set isolation level inside BEGIN, not with SET.
4. **Durability** is a stack: WAL → fsync → disk firmware → replication. Each layer can lie. Verify your fsync behavior, use synchronous replication for critical data, and don't trust cloud storage without testing.
5. **2PC** enables distributed atomicity but has a coordinator single point of failure. Use it for database-to-database transactions; use sagas for anything involving external services.
6. **Group commit** is free throughput — tune `commit_delay` and `commit_siblings` on high-throughput systems.
7. **The most common production bug** is read-then-write without locking. Use atomic UPDATE statements or SELECT FOR UPDATE with deterministic lock ordering.
