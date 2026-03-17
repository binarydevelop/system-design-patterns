# デッドレターキュー

> この記事は英語版から翻訳されました。最新版は[英語版](/05-messaging/08-dead-letter-queues)をご覧ください。

## TL;DR

デッドレターキュー（DLQ）は、正常に処理できなかったメッセージをキャプチャします。失敗したメッセージを失ったりキューをブロックしたりする代わりに、調査のために別のキューに移動します。デバッグ、コンプライアンス、データ損失防止に不可欠です。リトライ上限を設定し、DLQの深度を監視し、デッドレターの処理手順を確立してください。

---

## なぜデッドレターキューが必要なのか？

### 問題

```
Message arrives → Processing fails → What now?

Options without DLQ:
  1. Retry forever (blocks queue)
  2. Discard (lose data)
  3. Crash consumer (disrupts service)

None are good!
```

### DLQによる解決策

```
Message arrives → Processing fails → Retry N times → Move to DLQ

Main Queue ──► Consumer ──► Success
                  │
              Failure (after retries)
                  │
                  ▼
              Dead Letter Queue
                  │
                  ▼
          Manual investigation
```

---

## DLQの仕組み

### 基本フロー

```
1. Consumer receives message
2. Processing fails
3. Message returned to queue (nack)
4. Retry counter incremented
5. After N retries, move to DLQ
6. Original queue continues processing
7. DLQ monitored and investigated
```

### メッセージメタデータ

```json
{
  "original_message": {
    "body": "...",
    "headers": {...}
  },
  "dlq_metadata": {
    "original_queue": "orders",
    "failure_reason": "ValidationError: Invalid product ID",
    "failure_timestamp": "2024-01-15T10:30:00Z",
    "retry_count": 3,
    "stack_trace": "..."
  }
}
```

---

## 設定

### RabbitMQ

```python
# Declare DLQ
channel.queue_declare(
    queue='orders-dlq',
    durable=True
)

# Declare main queue with DLQ binding
channel.queue_declare(
    queue='orders',
    durable=True,
    arguments={
        'x-dead-letter-exchange': '',
        'x-dead-letter-routing-key': 'orders-dlq',
        'x-message-ttl': 60000,  # Optional: TTL before DLQ
        'x-max-retries': 3  # Requires plugin
    }
)
```

### Amazon SQS

```python
import boto3

sqs = boto3.client('sqs')

# Create DLQ
dlq = sqs.create_queue(QueueName='orders-dlq')
dlq_arn = sqs.get_queue_attributes(
    QueueUrl=dlq['QueueUrl'],
    AttributeNames=['QueueArn']
)['Attributes']['QueueArn']

# Create main queue with redrive policy
sqs.create_queue(
    QueueName='orders',
    Attributes={
        'RedrivePolicy': json.dumps({
            'deadLetterTargetArn': dlq_arn,
            'maxReceiveCount': '3'  # After 3 failures → DLQ
        })
    }
)
```

### Kafka

```python
# Kafka doesn't have native DLQ
# Implement in consumer

from kafka import KafkaConsumer, KafkaProducer

consumer = KafkaConsumer('orders')
producer = KafkaProducer()

for message in consumer:
    try:
        process(message)
    except Exception as e:
        # Send to DLQ topic
        producer.send(
            'orders-dlq',
            key=message.key,
            value=message.value,
            headers=[
                ('original-topic', b'orders'),
                ('failure-reason', str(e).encode()),
                ('retry-count', str(get_retry_count(message)).encode())
            ]
        )
        consumer.commit()
```

---

## リトライ戦略

### 即時リトライ

```python
def process_with_retry(message, max_retries=3):
    for attempt in range(max_retries):
        try:
            process(message)
            return True
        except RetryableError:
            if attempt < max_retries - 1:
                continue

    # Max retries exceeded
    send_to_dlq(message)
    return False
```

### 指数バックオフ

```python
def process_with_backoff(message, max_retries=3):
    for attempt in range(max_retries):
        try:
            process(message)
            return True
        except RetryableError:
            if attempt < max_retries - 1:
                delay = min(2 ** attempt, 60)  # Cap at 60 seconds
                sleep(delay)

    send_to_dlq(message)
    return False
```

### 遅延リトライキュー

```
Instead of immediate retry, use delay queue

Main Queue → Failure → Delay Queue (5 min) → Main Queue

Delay Queue implementation:
  - Message TTL + DLQ routing back to main queue
  - Or: Scheduled re-delivery
```

---

## デッドレターの処理

### 調査ワークフロー

```
1. Alert on DLQ messages
2. View message content and failure reason
3. Determine root cause
   - Bug in consumer?
   - Invalid message format?
   - External dependency failure?
4. Fix root cause
5. Replay or discard messages
```

### メッセージの検査

```python
def inspect_dlq():
    messages = dlq.receive_messages(max_messages=10)

    for msg in messages:
        print(f"Message ID: {msg.id}")
        print(f"Failed at: {msg.attributes['failure_timestamp']}")
        print(f"Reason: {msg.attributes['failure_reason']}")
        print(f"Retry count: {msg.attributes['retry_count']}")
        print(f"Body: {msg.body}")
        print("---")
```

### メッセージのリプレイ

```python
def replay_dlq_messages():
    """Move messages from DLQ back to main queue"""
    while True:
        messages = dlq.receive_messages(max_messages=10)
        if not messages:
            break

        for msg in messages:
            # Send back to original queue
            main_queue.send(
                body=msg.body,
                headers=msg.headers
            )

            # Delete from DLQ
            dlq.delete(msg)

    log.info("DLQ replay complete")
```

### 選択的リプレイ

```python
def replay_if_fixed(message):
    """Only replay if we've fixed the issue"""

    failure_reason = message.attributes['failure_reason']

    if "ValidationError" in failure_reason:
        # Skip - message itself is invalid
        archive_dlq_message(message)
    elif "ServiceUnavailable" in failure_reason:
        # Retry - service might be back
        replay_message(message)
    else:
        # Unknown - manual review
        flag_for_review(message)
```

---

## エラータイプ別のDLQ

### DLQの分離

```
orders-dlq-validation  → Invalid message format
orders-dlq-external    → External service failures
orders-dlq-unknown     → Unknown errors

Benefits:
  - Different handling per type
  - Easier investigation
  - Different retention policies
```

### ルーティングの実装

```python
def send_to_appropriate_dlq(message, error):
    if isinstance(error, ValidationError):
        dlq = "orders-dlq-validation"
    elif isinstance(error, ExternalServiceError):
        dlq = "orders-dlq-external"
    else:
        dlq = "orders-dlq-unknown"

    send_to_dlq(dlq, message, error)
```

---

## 監視

### 主要メトリクス

```
DLQ depth:
  Number of messages in DLQ
  Should be near zero normally

DLQ arrival rate:
  Messages arriving per minute
  Spike indicates processing issue

DLQ age:
  Age of oldest message
  Stale messages indicate neglect

Failure categories:
  Breakdown by error type
  Identify systemic issues
```

### アラート設定

```yaml
alerts:
  - name: DLQDepthHigh
    condition: dlq_depth > 100
    severity: warning

  - name: DLQDepthCritical
    condition: dlq_depth > 1000
    severity: critical

  - name: DLQArrivalSpike
    condition: dlq_arrival_rate > 10/min
    for: 5m

  - name: DLQStaleMessages
    condition: oldest_dlq_message_age > 24h
    severity: warning
```

### ダッシュボード

```
DLQ Dashboard:
  - Current depth (gauge)
  - Arrival rate (time series)
  - Top failure reasons (pie chart)
  - Age distribution (histogram)
  - Recent messages (table)
```

---

## 保持期間とクリーンアップ

### 保持ポリシー

```
Consider:
  - Compliance requirements (must keep N days)
  - Investigation time (allow time to debug)
  - Storage costs (don't keep forever)

Typical: 7-30 days
```

### 自動クリーンアップ

```python
@scheduled(cron="0 0 * * *")  # Daily
def cleanup_old_dlq_messages():
    cutoff = now() - timedelta(days=30)

    while True:
        messages = dlq.receive_messages(
            max_messages=100,
            attributes=['sent_timestamp']
        )

        if not messages:
            break

        for msg in messages:
            if msg.sent_timestamp < cutoff:
                archive_message(msg)  # Optional: archive first
                dlq.delete(msg)
```

### 削除前のアーカイブ

```python
def archive_message(message):
    s3.put_object(
        Bucket='dlq-archive',
        Key=f'{date.today()}/{message.id}.json',
        Body=json.dumps({
            'body': message.body,
            'attributes': message.attributes
        })
    )
```

---

## 一般的なパターン

### ポイズンメッセージの検出

```python
# Message that always fails - detect and sideline quickly

def process_with_poison_detection(message):
    retry_count = get_retry_count(message)

    if retry_count > 10:
        # Poison message - don't even try
        send_to_poison_queue(message)
        return

    try:
        process(message)
    except Exception as e:
        increment_retry_count(message)
        if retry_count >= 3:
            send_to_dlq(message, e)
        else:
            requeue(message)
```

### DLQコンシューマー

```python
# Dedicated service to process DLQ

class DLQConsumer:
    def run(self):
        for message in self.dlq:
            try:
                self.handle_dead_letter(message)
            except Exception:
                # Even DLQ processing can fail!
                log.exception(f"Failed to handle DLQ message: {message.id}")

    def handle_dead_letter(self, message):
        # Attempt auto-fix
        if self.can_auto_fix(message):
            fixed = self.auto_fix(message)
            self.main_queue.send(fixed)
            self.dlq.delete(message)
        else:
            # Create ticket for manual review
            self.create_ticket(message)
```

### サーキットブレーカーとの統合

```python
from circuitbreaker import circuit

@circuit(failure_threshold=5, recovery_timeout=60)
def call_external_service(data):
    return external_api.process(data)

def process_message(message):
    try:
        result = call_external_service(message.body)
        return result
    except CircuitBreakerError:
        # Service unhealthy - delay processing
        delay_message(message, seconds=300)
        raise
```

---

## DLQ処理戦略

### 手動レビュー

```
Who:     Human operator via dashboard or CLI
When:    Low-volume DLQs, compliance-sensitive data, unknown failure types
How:     Operator inspects message body + failure reason → decides replay or discard

Workflow:
  1. Alert fires on DLQ depth
  2. Operator opens DLQ dashboard
  3. Reads failure reason + stack trace
  4. Determines root cause
  5. Fixes consumer or upstream data
  6. Replays or archives the message

Tradeoff: Slow, doesn't scale. But safest for critical financial or PII data.
```

### 自動リトライ

```
A scheduler periodically reads DLQ and re-publishes messages to the original queue.

Schedule: Every 15 min, pick up to 50 messages, republish with exponential backoff.

Backoff formula:
  delay = min(base_delay * 2^retry_count, max_delay)
  Example: 1s → 2s → 4s → 8s → ... → cap at 5 min

Risk: Infinite retry loop.
  If the message is permanently invalid (bad schema, missing required field),
  it will bounce between main queue and DLQ forever.

Mitigation:
  - Set a max lifetime (e.g., 24h from first failure). After that → archive.
  - Distinguish retryable vs non-retryable errors before republishing.
```

### 条件付きリプレイ

```
Inspect each DLQ message, apply a transformation or data correction, then replay.

Example:
  Original message has { "price": -5 }  → validation failure
  Fix: set price to 0 or fetch correct price from source system
  Replay corrected message to main queue

Use when:
  - Upstream producer sent bad data but the intent is recoverable
  - Schema evolved and old messages need field backfill
  - External reference data was temporarily wrong (e.g., currency rate)

Caution: Transformations must be idempotent. Replayed message may be processed
         alongside newer messages — ensure no duplicate side effects.
```

### DLQコンシューマーサービス

```
A dedicated microservice consumes the DLQ as its primary input.

Responsibilities:
  - Classify failure type (validation, timeout, auth, unknown)
  - Apply programmatic fixes per failure type
  - Re-publish fixed messages to original queue
  - Escalate unfixable messages (create ticket, send Slack alert)
  - Track repair metrics (auto-fixed %, escalation %)

Architecture:
  Main Queue ──► Consumer ──► DLQ ──► DLQ Consumer Service
                                          │
                              ┌────────────┼────────────┐
                              ▼            ▼            ▼
                         Auto-fix     Create Ticket   Archive
                         & Replay
```

---

## DLQスキーマとメタデータ

### メタデータが重要な理由

```
Without failure context, a DLQ is a black hole.

You see a message in the DLQ. Questions you need answered:
  - Which queue did it come from?
  - Why did it fail?
  - How many times was it retried?
  - When did it first fail? When did it last fail?
  - What does the stack trace say?

Without this metadata, triage is guesswork. Engineers waste hours
reproducing failures that a stack trace would have explained in seconds.
```

### 必須メタデータスキーマ

```json
{
  "dlq_envelope": {
    "message_id": "msg-a1b2c3d4",
    "original_topic": "orders.placed",
    "original_queue": "order-processing",
    "original_partition": 3,
    "original_offset": 884201,
    "failure_reason": "ValidationError: field 'quantity' must be > 0",
    "failure_category": "VALIDATION",
    "stack_trace": "Traceback (most recent call last):\n  File \"consumer.py\", line 42 ...",
    "retry_count": 3,
    "first_failure_at": "2025-11-10T08:15:22Z",
    "last_failure_at": "2025-11-10T08:17:44Z",
    "consumer_instance": "order-consumer-pod-7b4d9",
    "consumer_version": "2.4.1"
  },
  "original_headers": {
    "correlation_id": "corr-x9y8z7",
    "content_type": "application/json"
  },
  "original_body": {
    "order_id": "ORD-12345",
    "quantity": -1,
    "product_id": "SKU-999"
  }
}
```

### メタデータのガイドライン

```
- Always capture failure_reason: the exception message, not just the class name.
- Always capture stack_trace: truncate to last 20 frames if needed for storage.
- Track first vs last failure timestamps: shows how long the message has been bouncing.
- Include consumer_version: critical for debugging issues introduced by a specific deploy.
- Keep original headers intact: correlation IDs enable end-to-end tracing.
```

---

## DLQのアンチパターン

### DLQの無視

```
Symptom:  DLQ has 50,000 messages. Nobody noticed.
Cause:    No monitoring, no alerts, no ownership.
Fix:      Alert on DLQ depth > 0 (warning), > 100 (critical).
          Assign a team to own DLQ triage as part of on-call rotation.
```

### 修正せずにリプレイ

```
Symptom:  Message fails → goes to DLQ → replayed → fails again → DLQ → replay → ...
Cause:    Blind replay script with no root cause analysis.
Fix:      Never replay without understanding the failure reason.
          Gate replay behind a check: has the consumer bug been fixed?
          Has the invalid data been corrected?
          Track replay count — if a message has been replayed 3+ times, escalate.
```

### DLQメッセージにTTLがない

```
Symptom:  DLQ contains messages from 2 years ago. Nobody knows what they are.
Cause:    No retention policy, no cleanup job.
Fix:      Set retention between 7-30 days depending on compliance needs.
          Archive to cold storage (S3, GCS) before deletion if audit trail is required.
          Messages older than retention are not actionable — delete or archive them.
```

### DLQを機能として使用する

```
Symptom:  Producer intentionally sends messages to a queue knowing they'll fail,
          so they end up in the DLQ for "later processing."
Cause:    Misunderstanding DLQ purpose. Treating it as a delay queue.
Fix:      Use a dedicated delay queue or scheduled queue instead.
          DLQs are for unexpected failures, not intentional routing.
          Delay mechanisms: RabbitMQ message TTL + dead-letter routing to a processing
          queue, SQS delay queues, Kafka topic with timestamp-based consumer pause.
```

---

## 実際のシステムにおけるDLQ

### AWS SQS

```
Configuration:
  Main queue has a RedrivePolicy:
    { "maxReceiveCount": 5, "deadLetterTargetArn": "arn:aws:sqs:...:orders-dlq" }

Behavior:
  - After 5 failed receive+process cycles (no deletion), message moves to DLQ.
  - SQS tracks receive count automatically — no application code needed.
  - Use RedriveAllowPolicy on DLQ to restrict which queues can target it.
  - Redrive to source: SQS console supports moving messages back to original queue.

Gotcha: maxReceiveCount includes visibility timeout expiries. If your consumer
        is slow and the visibility timeout expires, that counts as a receive.
```

### Apache Kafka

```
Kafka has no native DLQ mechanism. You implement it yourself.

Common pattern:
  - Failed messages are produced to a separate topic: orders.dlq
  - Consumer catches exception → writes to DLQ topic with failure headers
  - A DLQ consumer service reads orders.dlq for triage

Spring Kafka integration:
  - DeadLetterPublishingRecoverer: auto-publishes to <topic>.DLT after retries
  - DefaultErrorHandler with BackOff: configurable retry + DLT routing
  - Retains original headers + adds exception headers automatically

Naming convention: <original-topic>.dlq or <original-topic>.DLT (dead letter topic)
```

### RabbitMQ

```
Native DLQ support via exchange routing:

Queue arguments:
  x-dead-letter-exchange: "dlx-exchange"
  x-dead-letter-routing-key: "orders.dlq"

Messages are dead-lettered when:
  - Consumer nacks (basic.reject / basic.nack) with requeue=false
  - Message TTL expires
  - Queue max-length exceeded

The dead-letter exchange routes the message to the DLQ based on the routing key.
Original death metadata is added to x-death header array (queue, reason, count, time).
```

### GCP Pub/Sub

```
Configuration:
  Subscription has a deadLetterPolicy:
    { "deadLetterTopic": "projects/.../topics/orders-dlq",
      "maxDeliveryAttempts": 5 }

Behavior:
  - After 5 failed delivery attempts (nack or ack deadline expiry), message
    is forwarded to the dead letter topic.
  - Pub/Sub adds CloudPubSubDeadLetterSourceDeliveryCount attribute automatically.
  - The DLQ topic needs a separate subscription for consumers to read from it.

Gotcha: The service account needs pubsub.publisher role on the DLQ topic
        and pubsub.subscriber role on the source subscription.
```

---

## まとめ

1. **DLQはメッセージの損失を防ぎます** - 失敗したメッセージが保持されます
2. **リトライ上限を設定してください** - 永遠にリトライしてはいけません
3. **障害メタデータを含めてください** - 理由、タイムスタンプ、リトライ回数
4. **DLQの深度を監視してください** - 蓄積に対してアラートを設定します
5. **処理手順を確立してください** - 調査、リプレイ、アーカイブ
6. **エラーの種類ごとに異なるDLQを使用してください** - 分類が容易になります
7. **保持ポリシーは重要です** - コンプライアンスとストレージコスト
8. **可能な限り自動化してください** - リプレイ、クリーンアップ、アラート
