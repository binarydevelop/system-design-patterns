# Write-Ahead Logging (WAL)

## TL;DR

Write-Ahead Logging ensures durability by writing changes to a sequential log before applying them to data structures. If the system crashes, the log is replayed to recover committed transactions. WAL is fundamental to almost every database system. Key trade-offs: fsync frequency vs durability, log size vs recovery time.

---

## The Durability Problem

### Without WAL

```
Transaction:
  1. Update buffer pool (memory)
  2. Eventually flush to disk
  
Crash between 1 and 2:
  - Data in memory lost
  - Disk has stale data
  - Transaction lost despite "commit"
```

### With WAL

```
Transaction:
  1. Write to log (sequential, fast)
  2. Fsync log (durable)
  3. Update buffer pool (memory)
  4. Return commit to client
  
  [Later: Flush buffer pool to disk]
  [Even later: Truncate log]

Crash at any point:
  - Replay log on recovery
  - All committed transactions restored
```

---

## WAL Protocol

### The WAL Rule

```
Before modifying any data page on disk:
  1. Write log record describing the change
  2. Ensure log record is on stable storage (fsync)
  3. Then (and only then) modify the data page

"Write-Ahead" = Log before Data
```

### Write Path

```
┌────────────────────────────────────────────────────────┐
│ Transaction: UPDATE account SET balance = 500         │
└────────────────────────────────────────────────────────┘
                          │
                          ▼
┌────────────────────────────────────────────────────────┐
│ 1. Write log record to WAL buffer                     │
│    <TxnID, PageID, Offset, OldValue, NewValue>        │
└────────────────────────────────────────────────────────┘
                          │
                          ▼
┌────────────────────────────────────────────────────────┐
│ 2. On commit: Flush WAL buffer to disk (fsync)        │
└────────────────────────────────────────────────────────┘
                          │
                          ▼
┌────────────────────────────────────────────────────────┐
│ 3. Modify data page in buffer pool (memory)           │
│    (Disk write happens later, asynchronously)         │
└────────────────────────────────────────────────────────┘
                          │
                          ▼
┌────────────────────────────────────────────────────────┐
│ 4. Return "Commit OK" to client                       │
└────────────────────────────────────────────────────────┘
```

### Log Sequence Numbers (LSN)

```
Every log record has unique, monotonically increasing LSN

Log:
  LSN=100: <Txn1, Update, Page5, ...>
  LSN=101: <Txn1, Update, Page8, ...>
  LSN=102: <Txn1, Commit>
  LSN=103: <Txn2, Update, Page5, ...>
  ...

Page header tracks:
  page_lsn = LSN of last applied log record
  
Recovery:
  If log_lsn > page_lsn: apply log record
  If log_lsn <= page_lsn: skip (already applied)
```

---

## Log Record Types

### Physical Logging

Log exact bytes changed.

```
<LSN=100, TxnID=1, PageID=5, Offset=42, OldValue=100, NewValue=200>

Redo: Write 200 at offset 42 on page 5
Undo: Write 100 at offset 42 on page 5

Pros: Simple, fast recovery
Cons: Large logs for big changes
```

### Logical Logging

Log the operation.

```
<LSN=100, TxnID=1, Operation="UPDATE balance SET balance=200 WHERE id=5">

Redo: Re-execute the operation
Undo: Execute inverse operation

Pros: Compact logs
Cons: Must be deterministic, slower recovery
```

### Physiological Logging

Hybrid: Physical to a page, logical within.

```
<LSN=100, TxnID=1, PageID=5, Op="INSERT key=abc at slot=3">

Page-level physical: Know which page
Slot-level logical: Operation within page

Most databases use this approach
```

---

## ARIES Recovery

### Overview

Algorithms for Recovery and Isolation Exploiting Semantics.
Industry standard, used by most databases.

```
Three phases:
  1. Analysis: Determine what needs to be done
  2. Redo: Replay all logged changes
  3. Undo: Rollback uncommitted transactions
```

### Analysis Phase

```
Scan log from last checkpoint:
  - Build list of active transactions (not committed/aborted)
  - Build dirty page table (pages with unflushed changes)

Input: Log + Last checkpoint
Output: 
  - Redo start point
  - Active transactions to undo
  - Dirty pages
```

### Redo Phase

```
Scan forward from redo start point:
  For each log record:
    if page not in dirty table: skip
    if page LSN >= log record LSN: skip  # Already applied
    else: Apply redo  # Repeat history

Re-applies ALL changes (committed or not)
This brings database to exact crash state
```

### Undo Phase

```
For each active (uncommitted) transaction:
  Scan backward through its log records
  Apply undo for each record
  Write CLR (Compensation Log Record) for each undo

CLR ensures undo is idempotent:
  If crash during undo, CLR prevents re-undoing
```

### Example Recovery

```
Log:
  100: <T1, Update, P1, old=A, new=B>
  101: <T1, Update, P2, old=C, new=D>
  102: <T2, Update, P3, old=E, new=F>
  103: <T1, Commit>
  104: <T2, Update, P4, old=G, new=H>
  [CRASH]

Analysis:
  Active transactions: {T2}
  Need to undo T2

Redo (forward scan):
  Apply all records 100-104 to disk

Undo (backward for T2):
  Undo 104: Set P4 back to G, write CLR
  Undo 102: Set P3 back to E, write CLR
  
Result:
  T1's changes preserved (committed)
  T2's changes undone (was active at crash)
```

---

## Checkpointing

### Purpose

Limit recovery time by recording a known good state.

```
Without checkpoint:
  Must replay entire log from beginning
  Could be gigabytes of log

With checkpoint:
  Only replay from last checkpoint
  Bounded recovery time
```

### Fuzzy Checkpoint

```
1. Pause new transactions briefly
2. Record:
   - Active transactions list
   - Dirty pages table
   - Current LSN
3. Resume transactions
4. [Background: Flush dirty pages]

Called "fuzzy" because:
  - Doesn't wait for all pages to flush
  - Some dirty pages may still be in memory
  - Redo phase handles this
```

### Checkpoint Record

```
<CHECKPOINT, 
  ActiveTxns=[T1, T2, T3],
  DirtyPages=[P5, P8, P12],
  LSN=500>
```

---

## Group Commit

### The Fsync Problem

```
Naive approach:
  Each commit → separate fsync
  Fsync: ~10ms on HDD
  Max throughput: 100 commits/sec
```

### Solution: Group Commit

```
Batch multiple transactions' fsyncs:

Time 0-5ms:  T1, T2, T3 prepare, write to log buffer
Time 5ms:    Single fsync for all three
Time 5-6ms:  All three return "committed"

Amortizes fsync cost across transactions
10,000+ commits/sec possible
```

### Implementation

```python
class GroupCommit:
    def __init__(self):
        self.pending = []
        self.commit_interval = 10  # ms
        
    def request_commit(self, txn):
        # Add to pending batch
        self.pending.append(txn)
        
        # Wait for batch leader to fsync
        event = txn.create_event()
        return event.wait()
    
    def background_flush(self):
        while True:
            sleep(self.commit_interval)
            
            if self.pending:
                batch = self.pending
                self.pending = []
                
                # Single fsync for entire batch
                self.wal.fsync()
                
                # Notify all waiting transactions
                for txn in batch:
                    txn.event.signal()
```

---

## Log Truncation

### When to Truncate

```
Log grows forever without truncation

Can truncate when:
  - All transactions before LSN are committed
  - All dirty pages before LSN are flushed
  - Checkpoint has passed that point

Safe truncation point:
  min(oldest_active_txn_lsn, oldest_dirty_page_lsn)
```

### Archiving

```
For point-in-time recovery:
  1. Don't delete old logs
  2. Archive to cheap storage (S3, tape)
  3. Retain for days/months

Recovery:
  1. Restore base backup
  2. Replay archived logs to desired point
```

---

## WAL Configurations

### Durability Levels

```
Level 1: Fsync every commit
  - Strongest durability
  - Slowest
  - PostgreSQL: synchronous_commit = on
  
Level 2: Fsync every N ms
  - Lose up to N ms on crash
  - Better throughput
  - PostgreSQL: synchronous_commit = off
  
Level 3: OS decides when to flush
  - May lose significant data
  - Fastest
  - Never use for production
```

### Buffer Size

```
Larger WAL buffer:
  + Better batching
  + Higher throughput
  - More data at risk before fsync
  - More memory usage

Typical: 16 MB - 256 MB
```

### Log File Size

```
PostgreSQL: wal_segment_size (16 MB - 1 GB)
MySQL: innodb_log_file_size

Larger files:
  + Fewer file switches
  + Better sequential I/O
  - Longer recovery time
  - More disk space
```

---

## WAL in Different Systems

### PostgreSQL

```
WAL location: pg_wal/
Log format: Binary, 16 MB segments
Replication: Streaming replication uses WAL

Key settings:
  wal_level = replica  # Logging detail
  synchronous_commit = on  # Durability
  checkpoint_timeout = 5min
  max_wal_size = 1GB
```

### MySQL InnoDB

```
Log files: ib_logfile0, ib_logfile1
Circular log with two files

Key settings:
  innodb_log_file_size = 256M
  innodb_flush_log_at_trx_commit = 1  # Fsync each commit
  innodb_log_buffer_size = 16M
```

### RocksDB

```
WAL directory: configurable
Used for MemTable durability

Settings:
  Options::wal_dir
  Options::WAL_ttl_seconds
  Options::WAL_size_limit_MB
  Options::manual_wal_flush
```

---

## Performance Optimization

### Separate WAL Disk

```
Dedicated disk for WAL:
  - Sequential writes only
  - No competition with data reads
  - Consistent latency

NVMe SSD for WAL:
  - High IOPS for fsync
  - Low latency
```

### Compression

```
Compress log records:
  - LZ4 for speed
  - Zstd for ratio

Trade-off:
  + Smaller logs, faster I/O
  - CPU overhead
  - Decompression on recovery
```

### Parallel WAL

```
Multiple WAL partitions:
  - Transactions hashed to partition
  - Parallel writes
  - More complex recovery

Used in high-throughput systems
```

---

## Common Issues

### WAL Full / Disk Full

```
Problem: WAL fills disk
Symptoms: 
  - Writes blocked
  - Database unavailable

Prevention:
  - Monitor disk space
  - Configure max_wal_size
  - Faster checkpointing
  - Archive old WAL files
```

### Replication Lag from WAL

```
Problem: Replica can't keep up with WAL
Causes:
  - Slow replica disk
  - Network bottleneck
  - Large transactions

Solutions:
  - Faster replica
  - More frequent checkpoints (less WAL)
  - Throttle primary writes
```

### Long Recovery Time

```
Problem: Crash recovery takes hours
Causes:
  - Infrequent checkpoints
  - Large dirty page table
  - Huge log to replay

Solutions:
  - More frequent checkpoints
  - Smaller checkpoint_completion_target
  - Archive and truncate logs
```

---

## Torn Pages: The Atomicity Gap Under the WAL

The WAL protocol assumes a data-page write either happens or doesn't. Hardware breaks that assumption:

```
Database page: 8 KB (PostgreSQL) / 16 KB (InnoDB)
Device atomic write unit: 4 KB sector (often 512B logically)

Crash mid-page-write → a TORN page: first 4 KB new, last 4 KB old.
Page checksum detects it — but redo may not be able to FIX it:
physiological log records ("insert key at slot 3") assume the page's
prior state is intact. A torn page has no valid prior state.
```

Two production defenses:

```
PostgreSQL — full-page writes (full_page_writes = on):
  the FIRST modification to a page after each checkpoint logs the
  ENTIRE page image into the WAL. Redo restores the image, then
  applies records on top — no dependence on the on-disk page state.
  Cost: WAL volume spikes right after every checkpoint (the FPI
  burst); this is the hidden coupling between checkpoint_timeout
  and WAL bandwidth.

InnoDB — doublewrite buffer:
  pages are first written sequentially to a doublewrite area, synced,
  then written to their final locations. Torn final write → recover
  the page from the doublewrite copy. Cost: ~2× page write volume
  (mitigated by batching; can be disabled ONLY on filesystems/devices
  with guaranteed atomic writes — e.g., ZFS, or NVMe devices exposing
  atomic write units ≥ page size).
```

If you run on storage that genuinely guarantees page-sized atomic writes, both defenses are pure overhead — which is why "can we turn off doublewrite/FPW?" is a real tuning conversation, and why the answer must come from the storage stack's documentation, not optimism.

---

## Does fsync Actually Sync?

The durability of the entire design rests on one syscall telling the truth. It often doesn't, at three layers:

```
1. Volatile drive caches: consumer SSDs/HDDs ack writes into DRAM
   cache. A power cut loses "durable" data unless the OS issues cache
   flush / FUA commands — which filesystem barriers do, but
   misconfigured stacks (some virtualized disks, RAID controllers
   without BBU set to write-back) silently don't.

2. fsync error semantics (fsyncgate, 2018): on Linux, if a background
   writeback fails, fsync() returns EIO ONCE — and marks the pages
   CLEAN. A process that retries fsync gets SUCCESS while the data
   never reached disk. PostgreSQL had assumed retry-until-success was
   safe for ~20 years; the fix (PG 11+) is to PANIC on fsync failure
   and recover from WAL, never retry.

3. fdatasync vs fsync vs directory sync: creating a new WAL segment
   requires fsyncing the DIRECTORY too, or the file itself may vanish
   after crash. Metadata (size changes) needs fsync; fdatasync
   suffices for in-place data and is cheaper.

Verification, not vibes: pull the power plug under load
(diskchecker.pl-style tests) or use dm-flakey/dm-log-writes to
simulate. Storage stacks that "lose" acked fsyncs are common enough
that serious databases treat this as a qualification test.
```

---

## WAL as Replication Substrate

The same byte stream that provides crash recovery is the natural replication feed — and this dual use creates most WAL operational issues:

```
Physical replication (PostgreSQL streaming, InnoDB redo shipping):
  replica applies page-level records → byte-identical standby.
  Fast, simple; replica must run the same major version and
  architecture.

Logical replication / CDC: decode WAL back into row-level changes
  (pgoutput, Debezium). Enables cross-version, selective, and
  cross-system replication ([CDC pipelines](../13-data-pipelines/04-change-data-capture.md)) —
  at the cost of decoding CPU and ordering complexity.

The operational trap — replication slots pin WAL:
  a slot guarantees the WAL a consumer hasn't read yet is retained.
  A dead/abandoned consumer (a decommissioned replica, a stalled
  Debezium connector) pins WAL forever → disk fills → database down.
  This is among the most common self-inflicted PostgreSQL outages.
  Defense: monitor slot lag bytes; set max_slot_wal_keep_size (PG 13+)
  to cap retention and sacrifice the slot instead of the database.

Synchronous replication couples commit latency to the network:
  synchronous_commit = on → wait for local flush
                       remote_write / remote_apply → wait for standby
  Group commit still applies — batches of transactions share both the
  local fsync AND the replication round trip ([Consensus](../02-distributed-databases/08-consensus-algorithms.md)
  makes the same amortization under quorum acks).
```

---

## Key Takeaways

1. **Log before data** - Fundamental WAL rule
2. **LSN tracks progress** - Enables idempotent recovery
3. **ARIES is standard** - Analysis, Redo, Undo phases
4. **Group commit for throughput** - Batch fsync calls
5. **Checkpoint bounds recovery** - Trade checkpoint cost for recovery time
6. **Truncate after checkpoint** - Keep log size bounded
7. **Fsync frequency is key trade-off** - Durability vs performance
8. **Separate disk recommended** - Isolate WAL I/O
