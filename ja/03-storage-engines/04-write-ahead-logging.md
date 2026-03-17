# 先行書き込みログ（WAL）

> この記事は英語版から翻訳されました。最新版は[英語版](/03-storage-engines/04-write-ahead-logging.md)をご覧ください。

## TL;DR

先行書き込みログ（WAL）は、データ構造に変更を適用する前にシーケンシャルログに書き込むことで永続性を保証します。システムがクラッシュした場合、ログを再生してコミット済みトランザクションを復旧します。WALはほぼすべてのデータベースシステムの基盤です。主なトレードオフは、fsyncの頻度 vs 永続性、ログサイズ vs リカバリ時間です。

---

## 永続性の問題

### WALなしの場合

```
Transaction:
  1. Update buffer pool (memory)
  2. Eventually flush to disk

Crash between 1 and 2:
  - Data in memory lost
  - Disk has stale data
  - Transaction lost despite "commit"
```

### WALありの場合

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

## WALプロトコル

### WALルール

```
Before modifying any data page on disk:
  1. Write log record describing the change
  2. Ensure log record is on stable storage (fsync)
  3. Then (and only then) modify the data page

"Write-Ahead" = Log before Data
```

### 書き込みパス

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

### ログシーケンス番号（LSN）

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

## ログレコードの種類

### 物理ログ

変更された正確なバイトを記録します。

```
<LSN=100, TxnID=1, PageID=5, Offset=42, OldValue=100, NewValue=200>

Redo: Write 200 at offset 42 on page 5
Undo: Write 100 at offset 42 on page 5

Pros: Simple, fast recovery
Cons: Large logs for big changes
```

### 論理ログ

操作を記録します。

```
<LSN=100, TxnID=1, Operation="UPDATE balance SET balance=200 WHERE id=5">

Redo: Re-execute the operation
Undo: Execute inverse operation

Pros: Compact logs
Cons: Must be deterministic, slower recovery
```

### 生理論理ログ

ハイブリッド方式：ページに対しては物理的、ページ内では論理的です。

```
<LSN=100, TxnID=1, PageID=5, Op="INSERT key=abc at slot=3">

Page-level physical: Know which page
Slot-level logical: Operation within page

Most databases use this approach
```

---

## ARIESリカバリ

### 概要

ARIES（Algorithms for Recovery and Isolation Exploiting Semantics）。
業界標準であり、ほとんどのデータベースで使用されています。

```
Three phases:
  1. Analysis: Determine what needs to be done
  2. Redo: Replay all logged changes
  3. Undo: Rollback uncommitted transactions
```

### 分析フェーズ

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

### Redoフェーズ

```
Scan forward from redo start point:
  For each log record:
    if page not in dirty table: skip
    if page LSN >= log record LSN: skip  # Already applied
    else: Apply redo  # Repeat history

Re-applies ALL changes (committed or not)
This brings database to exact crash state
```

### Undoフェーズ

```
For each active (uncommitted) transaction:
  Scan backward through its log records
  Apply undo for each record
  Write CLR (Compensation Log Record) for each undo

CLR ensures undo is idempotent:
  If crash during undo, CLR prevents re-undoing
```

### リカバリの例

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

## チェックポイント

### 目的

リカバリ時間を制限するために、既知の正常な状態を記録します。

```
Without checkpoint:
  Must replay entire log from beginning
  Could be gigabytes of log

With checkpoint:
  Only replay from last checkpoint
  Bounded recovery time
```

### ファジーチェックポイント

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

### チェックポイントレコード

```
<CHECKPOINT,
  ActiveTxns=[T1, T2, T3],
  DirtyPages=[P5, P8, P12],
  LSN=500>
```

---

## グループコミット

### fsyncの問題

```
Naive approach:
  Each commit → separate fsync
  Fsync: ~10ms on HDD
  Max throughput: 100 commits/sec
```

### 解決策：グループコミット

```
Batch multiple transactions' fsyncs:

Time 0-5ms:  T1, T2, T3 prepare, write to log buffer
Time 5ms:    Single fsync for all three
Time 5-6ms:  All three return "committed"

Amortizes fsync cost across transactions
10,000+ commits/sec possible
```

### 実装

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

## ログの切り詰め

### いつ切り詰めるか

```
Log grows forever without truncation

Can truncate when:
  - All transactions before LSN are committed
  - All dirty pages before LSN are flushed
  - Checkpoint has passed that point

Safe truncation point:
  min(oldest_active_txn_lsn, oldest_dirty_page_lsn)
```

### アーカイブ

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

## WALの設定

### 永続性レベル

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

### バッファサイズ

```
Larger WAL buffer:
  + Better batching
  + Higher throughput
  - More data at risk before fsync
  - More memory usage

Typical: 16 MB - 256 MB
```

### ログファイルサイズ

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

## 各システムでのWAL

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

## パフォーマンス最適化

### WAL専用ディスク

```
Dedicated disk for WAL:
  - Sequential writes only
  - No competition with data reads
  - Consistent latency

NVMe SSD for WAL:
  - High IOPS for fsync
  - Low latency
```

### 圧縮

```
Compress log records:
  - LZ4 for speed
  - Zstd for ratio

Trade-off:
  + Smaller logs, faster I/O
  - CPU overhead
  - Decompression on recovery
```

### 並列WAL

```
Multiple WAL partitions:
  - Transactions hashed to partition
  - Parallel writes
  - More complex recovery

Used in high-throughput systems
```

---

## よくある問題

### WAL満杯 / ディスク満杯

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

### WALによるレプリケーション遅延

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

### 長いリカバリ時間

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

## 重要なポイント

1. **データの前にログ** - WALの基本ルール
2. **LSNが進捗を追跡する** - べき等なリカバリを可能にします
3. **ARIESが標準** - 分析、Redo、Undoの各フェーズ
4. **スループットにはグループコミット** - fsync呼び出しをバッチ処理します
5. **チェックポイントがリカバリを制限する** - チェックポイントコストとリカバリ時間のトレードオフ
6. **チェックポイント後に切り詰め** - ログサイズを制限します
7. **fsyncの頻度が主要なトレードオフ** - 永続性 vs パフォーマンス
8. **専用ディスクを推奨** - WAL I/Oを分離します
