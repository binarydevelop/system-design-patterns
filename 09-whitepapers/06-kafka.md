# Kafka: A Distributed Messaging System for Log Processing

## Paper Overview

- **Title**: Kafka: a Distributed Messaging System for Log Processing
- **Authors**: Jay Kreps, Neha Narkhede, Jun Rao (LinkedIn)
- **Published**: NetDB Workshop 2011
- **Context**: LinkedIn needed high-throughput, low-latency log processing

## TL;DR

Kafka is a distributed commit log that provides:
- **High throughput** through sequential disk I/O and batching
- **Scalability** via partitioned topics
- **Durability** through replication
- **Simple consumer model** with offset-based tracking

## Problem Statement

### Log Processing Challenges

```
┌─────────────────────────────────────────────────────────────────┐
│                   LinkedIn's Requirements                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Activity Data:                                                 │
│  ┌─────────────────────────────────────────────┐                │
│  │  - Page views: billions per day             │                │
│  │  - User actions: clicks, searches, etc.     │                │
│  │  - System metrics: CPU, memory, latency     │                │
│  └─────────────────────────────────────────────┘                │
│                                                                  │
│  Use Cases:                                                     │
│  ┌─────────────────────────────────────────────┐                │
│  │  - Real-time analytics dashboards           │                │
│  │  - Offline batch processing (Hadoop)        │                │
│  │  - Search indexing                          │                │
│  │  - Recommendation systems                   │                │
│  └─────────────────────────────────────────────┘                │
│                                                                  │
│  Existing Solutions Fall Short:                                 │
│  ┌─────────────────────────────────────────────┐                │
│  │  - Traditional MQ: Too slow, not scalable   │                │
│  │  - Log files: No real-time, hard to manage  │                │
│  │  - Custom solutions: Complex, fragile       │                │
│  └─────────────────────────────────────────────┘                │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## Kafka Architecture

### Core Concepts

```
┌─────────────────────────────────────────────────────────────────┐
│                    Kafka Architecture                           │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  TOPIC: Named feed of messages                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                        Topic "clicks"                     │   │
│  │  ┌────────────────────────────────────────────────────┐  │   │
│  │  │ Partition 0:  [M0][M1][M2][M3][M4][M5]...          │  │   │
│  │  └────────────────────────────────────────────────────┘  │   │
│  │  ┌────────────────────────────────────────────────────┐  │   │
│  │  │ Partition 1:  [M0][M1][M2][M3][M4]...              │  │   │
│  │  └────────────────────────────────────────────────────┘  │   │
│  │  ┌────────────────────────────────────────────────────┐  │   │
│  │  │ Partition 2:  [M0][M1][M2][M3][M4][M5][M6]...      │  │   │
│  │  └────────────────────────────────────────────────────┘  │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                  │
│  PARTITION: Ordered, immutable sequence of messages             │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                                                           │   │
│  │   Offset:  0    1    2    3    4    5    6    7          │   │
│  │          ┌────┬────┬────┬────┬────┬────┬────┬────┐       │   │
│  │          │ M0 │ M1 │ M2 │ M3 │ M4 │ M5 │ M6 │ M7 │       │   │
│  │          └────┴────┴────┴────┴────┴────┴────┴────┘       │   │
│  │                                              ▲            │   │
│  │                                          append-only      │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                  │
│  BROKER: Server that stores partitions                          │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  Broker 1        Broker 2        Broker 3                │   │
│  │  ┌──────────┐   ┌──────────┐   ┌──────────┐              │   │
│  │  │ P0, P3   │   │ P1, P4   │   │ P2, P5   │              │   │
│  │  └──────────┘   └──────────┘   └──────────┘              │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Message Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                      Message Flow                               │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Producers                  Kafka Cluster               Consumers│
│  ┌───────┐                  ┌─────────────┐            ┌───────┐│
│  │ App 1 │──────────────────│             │────────────│ App A ││
│  └───────┘                  │             │            └───────┘│
│  ┌───────┐     publish      │   Broker    │   consume  ┌───────┐│
│  │ App 2 │──────────────────│   Cluster   │────────────│ App B ││
│  └───────┘                  │             │            └───────┘│
│  ┌───────┐                  │             │            ┌───────┐│
│  │ App 3 │──────────────────│             │────────────│ App C ││
│  └───────┘                  └─────────────┘            └───────┘│
│                                    │                            │
│                                    │                            │
│                              ┌─────┴─────┐                      │
│                              │ ZooKeeper │                      │
│                              │ (metadata)│                      │
│                              └───────────┘                      │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## Log-Based Storage

### Append-Only Log

```properties
# server.properties — Key broker settings for log-based storage
#
# Kafka's storage is an append-only commit log on disk.
# Key insight: Sequential writes are FAST (~600 MB/s per disk).

# ── Segment & retention ──────────────────────────────────────────
# Each partition is split into segment files of this size (1 GB default).
# When the active segment reaches this limit, Kafka rolls to a new one.
log.segment.bytes=1073741824

# How long to keep data before deletion (7 days default).
log.retention.hours=168

# Alternative: delete segments when total partition size exceeds this.
# log.retention.bytes=-1  # -1 = unlimited

# How often the log cleaner checks for segments to delete.
log.retention.check.interval.ms=300000

# ── Flush policy (usually leave to OS page cache) ────────────────
# Number of messages before forcing a flush to disk.
# Default: rely on OS page cache for best throughput.
# log.flush.interval.messages=10000
# log.flush.interval.ms=1000

# ── Directories ──────────────────────────────────────────────────
# Comma-separated list of directories for log data.
# Spreading across multiple disks increases throughput.
log.dirs=/var/kafka-logs
```

```shell
# Inspect the on-disk log structure for a partition
ls -l /var/kafka-logs/clicks-0/

# Example output:
# 00000000000000000000.index   <- sparse offset index
# 00000000000000000000.log     <- segment file (messages)
# 00000000000000000000.timeindex
# 00000000000052428800.index   <- next segment (rolled at offset 52428800)
# 00000000000052428800.log

# Dump messages from a segment file
kafka-dump-log.sh \
  --files /var/kafka-logs/clicks-0/00000000000000000000.log \
  --print-data-log
```

### Efficient I/O

```
Kafka I/O Optimizations

Zero-copy transfer (sendfile syscall):
  Traditional path:             Zero-copy path:
  1. File → kernel buffer       1. File → kernel buffer
  2. Kernel buf → user buf      2. Kernel buf → NIC (direct)
  3. User buf → socket buf
  4. Socket buf → NIC           Eliminates 2 copies
                                and 2 context switches!

Batched compression:
  Messages are compressed together in batches rather than individually.
  This yields a much better compression ratio because similar messages
  share redundant byte patterns.

Page-cache-friendly writes:
  1. Producer appends to memory-mapped segment file.
  2. OS page cache absorbs writes and flushes asynchronously.
  3. Consumer reads recent data straight from page cache.
  Result: Near-memory speed for recent (tail) data.
```

## Producer

### Publishing Messages

```shell
# ── Topic creation ────────────────────────────────────────────────
kafka-topics.sh --bootstrap-server localhost:9092 \
  --create \
  --topic clicks \
  --partitions 6 \
  --replication-factor 3

# Verify topic configuration
kafka-topics.sh --bootstrap-server localhost:9092 \
  --describe --topic clicks

# ── Producing messages ────────────────────────────────────────────
# Interactive producer (key:value with key separator)
kafka-console-producer.sh --bootstrap-server localhost:9092 \
  --topic clicks \
  --property parse.key=true \
  --property key.separator=:
# > user-123:{"page":"/home","ts":1700000000}
# > user-456:{"page":"/cart","ts":1700000001}

# Produce from a file
kafka-console-producer.sh --bootstrap-server localhost:9092 \
  --topic clicks < clickstream.jsonl

# ── Partitioning behaviour ───────────────────────────────────────
# When a key is provided:
#   partition = murmur2(key) % num_partitions
#   → Messages with the same key always land in the same partition
#     (guarantees per-key ordering).
#
# When no key is provided:
#   The default partitioner uses sticky round-robin (batch-aware)
#   for even load distribution.
#
# Custom partitioning is configured in the Java producer:
#   props.put("partitioner.class",
#             "com.example.RegionPartitioner");
```

## Consumer

### Consumer Groups

```
┌─────────────────────────────────────────────────────────────────┐
│                    Consumer Groups                              │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Topic "orders" with 4 partitions                               │
│  ┌────────────────────────────────────────────────────────┐     │
│  │  P0          P1          P2          P3                │     │
│  └──┬───────────┬───────────┬───────────┬─────────────────┘     │
│     │           │           │           │                       │
│     │           │           │           │                       │
│  Consumer Group A                                               │
│  (3 consumers)                                                  │
│  ┌─────────────────────────────────────────────┐                │
│  │  Consumer A1    Consumer A2    Consumer A3  │                │
│  │    (P0, P1)       (P2)          (P3)        │                │
│  └─────────────────────────────────────────────┘                │
│                                                                  │
│  Consumer Group B                                               │
│  (2 consumers)                                                  │
│  ┌────────────────────────────────────┐                         │
│  │  Consumer B1        Consumer B2    │                         │
│  │    (P0, P1)          (P2, P3)      │                         │
│  └────────────────────────────────────┘                         │
│                                                                  │
│  Key Points:                                                    │
│  - Each partition assigned to exactly one consumer in group     │
│  - Consumer can handle multiple partitions                      │
│  - Different groups receive all messages independently          │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Consumer Implementation

```java
import org.apache.kafka.clients.consumer.*;
import org.apache.kafka.common.serialization.StringDeserializer;
import java.time.Duration;
import java.util.*;

/**
 * Kafka consumer with manual offset commit (at-least-once).
 *
 * Partition assignment strategies (set via partition.assignment.strategy):
 *   - RangeAssignor:           consecutive partitions per consumer
 *                              (good for co-partitioned joins)
 *   - RoundRobinAssignor:      even spread across consumers
 *   - CooperativeStickyAssignor: incremental rebalance, minimal partition moves
 */
public class ClickConsumer {

    public static void main(String[] args) {
        Properties props = new Properties();
        props.put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, "localhost:9092");
        props.put(ConsumerConfig.GROUP_ID_CONFIG, "click-analytics");
        props.put(ConsumerConfig.KEY_DESERIALIZER_CLASS_CONFIG,
                  StringDeserializer.class.getName());
        props.put(ConsumerConfig.VALUE_DESERIALIZER_CLASS_CONFIG,
                  StringDeserializer.class.getName());
        props.put(ConsumerConfig.ENABLE_AUTO_COMMIT_CONFIG, "false");
        props.put(ConsumerConfig.AUTO_OFFSET_RESET_CONFIG, "earliest");
        // Use cooperative rebalancing to avoid stop-the-world pauses
        props.put(ConsumerConfig.PARTITION_ASSIGNMENT_STRATEGY_CONFIG,
                  "org.apache.kafka.clients.consumer.CooperativeStickyAssignor");

        try (KafkaConsumer<String, String> consumer = new KafkaConsumer<>(props)) {
            consumer.subscribe(List.of("clicks"));

            while (true) {
                ConsumerRecords<String, String> records =
                    consumer.poll(Duration.ofMillis(1000));

                for (ConsumerRecord<String, String> record : records) {
                    System.out.printf("partition=%d offset=%d key=%s value=%s%n",
                        record.partition(), record.offset(),
                        record.key(), record.value());
                    // ... process record ...
                }

                // Manual synchronous commit after processing
                // If crash between process and commit → messages reprocessed (at-least-once)
                consumer.commitSync();
            }
        }
    }
}
```

```shell
# ── Quick consumption with console consumer ──────────────────────
kafka-console-consumer.sh --bootstrap-server localhost:9092 \
  --topic clicks \
  --group click-analytics \
  --from-beginning \
  --property print.key=true \
  --property print.timestamp=true

# ── Consumer group management ────────────────────────────────────
# List all consumer groups
kafka-consumer-groups.sh --bootstrap-server localhost:9092 --list

# Describe group: see partition assignments, lag, and current offsets
kafka-consumer-groups.sh --bootstrap-server localhost:9092 \
  --describe --group click-analytics

# Reset offsets to earliest (group must be inactive)
kafka-consumer-groups.sh --bootstrap-server localhost:9092 \
  --group click-analytics \
  --topic clicks \
  --reset-offsets --to-earliest --execute

# Reset offsets to a specific timestamp
kafka-consumer-groups.sh --bootstrap-server localhost:9092 \
  --group click-analytics \
  --topic clicks \
  --reset-offsets --to-datetime 2024-01-01T00:00:00.000 --execute
```

### Offset Management

```java
import org.apache.kafka.clients.consumer.*;
import org.apache.kafka.common.TopicPartition;
import java.time.Duration;
import java.util.*;

/**
 * Offset management strategies.
 *
 * Offsets are stored in the internal __consumer_offsets topic.
 */
public class OffsetManagementExamples {

    /** Auto-commit: simplest but may lose messages on crash. */
    static Properties autoCommitConfig() {
        Properties props = new Properties();
        props.put(ConsumerConfig.ENABLE_AUTO_COMMIT_CONFIG, "true");
        props.put(ConsumerConfig.AUTO_COMMIT_INTERVAL_MS_CONFIG, "5000");
        // Risk: crash between poll and next auto-commit → message loss
        return props;
    }

    /** Manual sync commit: at-least-once guarantee. */
    static void manualSyncCommit(KafkaConsumer<String, String> consumer) {
        while (true) {
            ConsumerRecords<String, String> records =
                consumer.poll(Duration.ofMillis(1000));      // 1. poll
            for (ConsumerRecord<String, String> r : records) {
                process(r);                                   // 2. process
            }
            consumer.commitSync();                            // 3. commit
            // If crash between 2 and 3 → messages reprocessed (at-least-once)
        }
    }

    /** Manual async commit: higher throughput, harder error handling. */
    static void manualAsyncCommit(KafkaConsumer<String, String> consumer) {
        while (true) {
            ConsumerRecords<String, String> records =
                consumer.poll(Duration.ofMillis(1000));
            for (ConsumerRecord<String, String> r : records) {
                process(r);
            }
            consumer.commitAsync((offsets, exception) -> {
                if (exception != null) {
                    System.err.println("Commit failed: " + exception.getMessage());
                }
            });
        }
    }

    /**
     * auto.offset.reset strategies (when no committed offset exists):
     *   "earliest" — start from the beginning of the partition
     *   "latest"   — start from the end (new messages only)
     */
    static void resetOffsetConfig(Properties props, String strategy) {
        props.put(ConsumerConfig.AUTO_OFFSET_RESET_CONFIG, strategy);
    }

    private static void process(ConsumerRecord<String, String> r) { /* ... */ }
}
```

## Replication

### Leader-Follower Replication

```
┌─────────────────────────────────────────────────────────────────┐
│                   Partition Replication                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Partition 0 (Replication Factor = 3)                           │
│                                                                  │
│  Broker 1                Broker 2                Broker 3       │
│  ┌─────────────┐        ┌─────────────┐        ┌─────────────┐ │
│  │   LEADER    │        │  FOLLOWER   │        │  FOLLOWER   │ │
│  │             │        │             │        │             │ │
│  │  [0][1][2]  │───────>│  [0][1][2]  │        │  [0][1][2]  │ │
│  │  [3][4][5]  │        │  [3][4][5]  │<───────│  [3][4]     │ │
│  │  [6][7]     │        │  [6]        │        │             │ │
│  │      ▲      │        │             │        │             │ │
│  └──────┼──────┘        └─────────────┘        └─────────────┘ │
│         │                                                       │
│    Producers write                                              │
│    to leader only                                               │
│                                                                  │
│  ISR (In-Sync Replicas): {Broker 1, Broker 2}                  │
│  - Broker 3 is behind, not in ISR                              │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Replication Protocol

```properties
# server.properties — Replication & durability settings
#
# acks behaviour (set on the producer side):
#   acks=0    Fire and forget (fastest, may lose data)
#   acks=1    Wait for leader write only (balanced)
#   acks=all  Wait for ALL in-sync replicas (safest)

# ── Replication factor (topic-level default) ─────────────────────
default.replication.factor=3

# ── In-sync replica (ISR) controls ──────────────────────────────
# Minimum replicas that must acknowledge before a produce with
# acks=all succeeds. Set to 2 with replication.factor=3 to
# tolerate 1 broker failure without blocking writes.
min.insync.replicas=2

# How far behind a follower can fall before being removed from ISR.
replica.lag.time.max.ms=30000

# ── Unclean leader election ─────────────────────────────────────
# If true, an out-of-sync replica can become leader (risks data loss).
# Keep false for strong durability.
unclean.leader.election.enable=false
```

```
High Watermark (HWM)

  Leader       Follower-1   Follower-2
  [0–7]        [0–7]        [0–5]      ← Log End Offset (LEO)
       ▲
       HWM = min(LEO of all ISR replicas) = 5

  - Consumers can only read up to HWM (offset < 5).
  - This ensures consumers never see uncommitted data.
  - Follower-2 is behind; if it falls beyond replica.lag.time.max.ms
    it is evicted from the ISR.
```

```shell
# Inspect ISR and leader assignment for a topic
kafka-topics.sh --bootstrap-server localhost:9092 \
  --describe --topic clicks

# Example output:
# Topic: clicks  Partition: 0  Leader: 1  Replicas: 1,2,3  Isr: 1,2

# Alter min.insync.replicas at the topic level
kafka-configs.sh --bootstrap-server localhost:9092 \
  --alter --entity-type topics --entity-name clicks \
  --add-config min.insync.replicas=2
```

## ZooKeeper Integration

### Metadata Management

```shell
# ── ZooKeeper-based metadata (pre-KRaft, Kafka < 3.3) ───────────

# List registered brokers
zookeeper-shell.sh localhost:2181 ls /brokers/ids

# Get broker details
zookeeper-shell.sh localhost:2181 get /brokers/ids/0

# Get partition state (leader, ISR)
zookeeper-shell.sh localhost:2181 \
  get /brokers/topics/clicks/partitions/0/state

# Get current controller
zookeeper-shell.sh localhost:2181 get /controller

# ── KRaft mode (Kafka 3.3+, no ZooKeeper) ────────────────────────

# Generate a cluster ID
kafka-storage.sh random-uuid

# Format storage directories for KRaft
kafka-storage.sh format \
  --config server.properties \
  --cluster-id <generated-uuid>

# Describe the cluster metadata (KRaft)
kafka-metadata.sh --snapshot /var/kafka-logs/__cluster_metadata-0/00000000000000000000.log \
  --cluster-id <cluster-id>

# List brokers in KRaft mode
kafka-broker-api-versions.sh --bootstrap-server localhost:9092
```

## Performance Optimizations

### Batching and Compression

```shell
# ── Producer batching & compression tuning ───────────────────────
# These are set as producer properties (or via command-line overrides).

kafka-console-producer.sh --bootstrap-server localhost:9092 \
  --topic clicks \
  --producer-property batch.size=16384 \
  --producer-property linger.ms=5 \
  --producer-property compression.type=lz4

# Batching benefits:
#   - Fewer network round trips
#   - Better compression ratio (similar messages share patterns)
#   - More efficient sequential disk writes

# ── Compression codec comparison ─────────────────────────────────
#   Codec   | Ratio     | CPU cost | Notes
#   --------|-----------|----------|------------------------------
#   gzip    | Best      | Highest  | Best for cold/archival data
#   snappy  | Moderate  | Low      | Good general-purpose default
#   lz4     | Good      | Lowest   | Best for latency-sensitive
#   zstd    | Very good | Moderate | Best balance of ratio & speed

# ── Why Kafka is fast: Sequential I/O ────────────────────────────
#   Random I/O:     ~100 ops/sec  (disk seek time dominates)
#   Sequential I/O: ~600 MB/sec   (no seeks, full disk bandwidth)
#
#   Kafka only appends — it never modifies existing data.
#   This enables sustained high throughput on commodity hardware.
```

## Exactly-Once Semantics

### Idempotent Producer

```java
import org.apache.kafka.clients.producer.*;
import org.apache.kafka.common.serialization.StringSerializer;
import java.util.Properties;

/**
 * Idempotent producer (Kafka 0.11+).
 *
 * The broker tracks (producer_id, partition, sequence_number).
 * Duplicate records from retries are detected and deduplicated automatically.
 * Setting enable.idempotence=true is the only change needed.
 */
public class IdempotentProducerExample {

    public static void main(String[] args) {
        Properties props = new Properties();
        props.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "localhost:9092");
        props.put(ProducerConfig.KEY_SERIALIZER_CLASS_CONFIG,
                  StringSerializer.class.getName());
        props.put(ProducerConfig.VALUE_SERIALIZER_CLASS_CONFIG,
                  StringSerializer.class.getName());
        // Enable idempotent writes (implied by enable.idempotence=true):
        //   acks=all, retries=Integer.MAX_VALUE, max.in.flight.requests.per.connection<=5
        props.put(ProducerConfig.ENABLE_IDEMPOTENCE_CONFIG, "true");

        try (KafkaProducer<String, String> producer = new KafkaProducer<>(props)) {
            ProducerRecord<String, String> record =
                new ProducerRecord<>("clicks", "user-123", "{\"page\":\"/home\"}");

            // The broker deduplicates any retried send with the same sequence number.
            producer.send(record, (metadata, exception) -> {
                if (exception == null) {
                    System.out.printf("Sent to partition=%d offset=%d%n",
                        metadata.partition(), metadata.offset());
                } else {
                    exception.printStackTrace();
                }
            });
        }
    }
}
```

```java
import org.apache.kafka.clients.consumer.*;
import org.apache.kafka.clients.producer.*;
import org.apache.kafka.common.serialization.*;
import java.time.Duration;
import java.util.*;

/**
 * Transactional producer for atomic writes across multiple partitions.
 *
 * Enables exactly-once semantics in consume-transform-produce patterns.
 */
public class TransactionalProducerExample {

    public static void main(String[] args) {
        // ── Producer with transactions ──────────────────────────
        Properties producerProps = new Properties();
        producerProps.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "localhost:9092");
        producerProps.put(ProducerConfig.KEY_SERIALIZER_CLASS_CONFIG,
                         StringSerializer.class.getName());
        producerProps.put(ProducerConfig.VALUE_SERIALIZER_CLASS_CONFIG,
                         StringSerializer.class.getName());
        producerProps.put(ProducerConfig.TRANSACTIONAL_ID_CONFIG, "order-processor-1");
        // enable.idempotence is automatically true when transactional.id is set

        KafkaProducer<String, String> producer = new KafkaProducer<>(producerProps);
        producer.initTransactions();

        // ── Consumer (read-committed isolation) ─────────────────
        Properties consumerProps = new Properties();
        consumerProps.put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, "localhost:9092");
        consumerProps.put(ConsumerConfig.GROUP_ID_CONFIG, "order-processor");
        consumerProps.put(ConsumerConfig.KEY_DESERIALIZER_CLASS_CONFIG,
                         StringDeserializer.class.getName());
        consumerProps.put(ConsumerConfig.VALUE_DESERIALIZER_CLASS_CONFIG,
                         StringDeserializer.class.getName());
        consumerProps.put(ConsumerConfig.ENABLE_AUTO_COMMIT_CONFIG, "false");
        consumerProps.put(ConsumerConfig.ISOLATION_LEVEL_CONFIG, "read_committed");

        KafkaConsumer<String, String> consumer = new KafkaConsumer<>(consumerProps);
        consumer.subscribe(List.of("orders"));

        // ── Consume-transform-produce loop ──────────────────────
        while (true) {
            ConsumerRecords<String, String> records =
                consumer.poll(Duration.ofMillis(1000));
            if (records.isEmpty()) continue;

            producer.beginTransaction();
            try {
                for (ConsumerRecord<String, String> r : records) {
                    // Transform and produce to output topic
                    String enriched = enrich(r.value());
                    producer.send(new ProducerRecord<>(
                        "enriched-orders", r.key(), enriched));
                }
                // Commit consumer offsets within the same transaction
                producer.sendOffsetsToTransaction(
                    currentOffsets(records), consumer.groupMetadata());
                producer.commitTransaction();
            } catch (Exception e) {
                producer.abortTransaction();
            }
        }
    }

    private static String enrich(String value) { return value; /* ... */ }

    private static Map<org.apache.kafka.common.TopicPartition, OffsetAndMetadata>
            currentOffsets(ConsumerRecords<String, String> records) {
        Map<org.apache.kafka.common.TopicPartition, OffsetAndMetadata> offsets = new HashMap<>();
        records.partitions().forEach(tp ->
            offsets.put(tp, new OffsetAndMetadata(
                records.records(tp).get(records.records(tp).size() - 1).offset() + 1)));
        return offsets;
    }
}
```

## Key Results

### Production Performance

```
┌─────────────────────────────────────────────────────────────────┐
│                    Kafka Performance                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Throughput (per broker):                                       │
│  ┌─────────────────────────────────────────────┐                │
│  │  Producer: 200,000+ messages/sec            │                │
│  │  Consumer: 400,000+ messages/sec            │                │
│  │  Aggregate: 2 million+ msg/sec (cluster)    │                │
│  └─────────────────────────────────────────────┘                │
│                                                                  │
│  Latency:                                                       │
│  ┌─────────────────────────────────────────────┐                │
│  │  Produce (acks=1): 2-5ms                    │                │
│  │  Produce (acks=all): 5-15ms                 │                │
│  │  Consume: 1-2ms                             │                │
│  └─────────────────────────────────────────────┘                │
│                                                                  │
│  Storage Efficiency:                                            │
│  ┌─────────────────────────────────────────────┐                │
│  │  With compression: 5-10x reduction          │                │
│  │  Sequential writes: ~600 MB/sec per disk    │                │
│  └─────────────────────────────────────────────┘                │
│                                                                  │
│  At LinkedIn (2011):                                            │
│  ┌─────────────────────────────────────────────┐                │
│  │  10+ billion messages per day               │                │
│  │  1+ TB of data per day                      │                │
│  └─────────────────────────────────────────────┘                │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## Influence and Legacy

### Impact on Industry

1. **Log-centric architecture**: Made append-only logs mainstream
2. **Stream processing**: Enabled Kafka Streams, ksqlDB
3. **Event sourcing**: Foundation for event-driven systems
4. **Microservices**: Standard for inter-service communication

### Evolution

```
┌──────────────────────────────────────────────────────────────┐
│                    Kafka Evolution                           │
├──────────────────────────────────────────────────────────────┤
│                                                               │
│  2011: Original Paper                                        │
│  - Basic pub/sub                                             │
│  - Simple consumer model                                     │
│                                                               │
│  2015: Kafka 0.9                                             │
│  - New consumer API                                          │
│  - Security (SSL, SASL)                                      │
│                                                               │
│  2017: Kafka 0.11                                            │
│  - Exactly-once semantics                                    │
│  - Idempotent producer                                       │
│  - Transactions                                              │
│                                                               │
│  2022: Kafka 3.3 (KRaft)                                     │
│  - Remove ZooKeeper dependency                               │
│  - Self-managed metadata                                     │
│  - Simplified operations                                     │
│                                                               │
└──────────────────────────────────────────────────────────────┘
```

## Key Takeaways

1. **Sequential I/O is fast**: Append-only enables high throughput
2. **Batch everything**: Messages, compression, network I/O
3. **Simple consumer model**: Offset-based is elegant and efficient
4. **Partitioning for scale**: Horizontal scaling via partitions
5. **Replication for durability**: ISR ensures no data loss
6. **Consumer groups for parallelism**: Easy to scale consumption
7. **Log as truth**: All data in the log, everything else derived
