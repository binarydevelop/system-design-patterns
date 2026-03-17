# ロングポーリング

> **注:** この記事は英語版からの翻訳です。コードブロック、Mermaidダイアグラム、およびツール名は原文のまま保持しています。

## TL;DR

ロングポーリングは、従来のポーリングの進化形であり、サーバーが新しいデータが利用可能になるかタイムアウトが発生するまでリクエストを保持し続けます。これにより不要なリクエストが削減され、ほぼリアルタイムの更新が可能になります。クライアントは各レスポンスの後すぐに再接続し、WebSocketの複雑さなしに持続的な接続効果を実現します。

---

## ロングポーリングの仕組み

```mermaid
sequenceDiagram
    participant Client
    participant Server

    Note over Client,Server: Traditional Polling (6 round trips for 1 message)
    Client->>Server: GET /updates
    Server-->>Client: { } (no updates)
    Note over Client: wait 5 seconds
    Client->>Server: GET /updates
    Server-->>Client: { } (no updates)
    Note over Client: wait 5 seconds
    Client->>Server: GET /updates
    Server-->>Client: { message: "Hi" }

    Note over Client,Server: Long Polling (1 round trip for 1 message)
    Client->>Server: GET /updates
    Note over Server: waits for data...
    Note over Client,Server: connection held open
    Note over Server: event occurs!
    Server-->>Client: { message: "Hi" }
    Client->>Server: GET /updates (immediately reconnect)
```

---

## 基本的な実装

### サーバー側（Python/Flask）

```python
from flask import Flask, request, jsonify, Response
from threading import Event, Lock
from collections import defaultdict
import time
import uuid
import queue

app = Flask(__name__)

class LongPollingManager:
    def __init__(self, timeout: int = 30):
        self.timeout = timeout
        self.waiters = defaultdict(list)  # channel -> list of Events
        self.messages = defaultdict(queue.Queue)  # channel -> message queue
        self.lock = Lock()

    def wait_for_message(self, channel: str, timeout: float = None) -> dict:
        """
        Wait for a message on the channel.
        Blocks until message arrives or timeout.
        """
        timeout = timeout or self.timeout
        event = Event()
        message_holder = {'message': None}

        with self.lock:
            self.waiters[channel].append((event, message_holder))

        try:
            # Wait for event or timeout
            got_message = event.wait(timeout=timeout)

            if got_message and message_holder['message']:
                return message_holder['message']
            return None
        finally:
            with self.lock:
                self.waiters[channel] = [
                    w for w in self.waiters[channel]
                    if w[0] != event
                ]

    def publish(self, channel: str, message: dict):
        """Publish message to all waiters on channel."""
        with self.lock:
            waiters = self.waiters[channel][:]

        for event, holder in waiters:
            holder['message'] = message
            event.set()

manager = LongPollingManager(timeout=30)

@app.route('/api/poll/<channel>')
def long_poll(channel):
    """
    Long polling endpoint.
    Holds connection until message or timeout.
    """
    since = request.args.get('since', type=float, default=0)
    timeout = request.args.get('timeout', type=float, default=30)
    timeout = min(timeout, 60)  # Cap at 60 seconds

    message = manager.wait_for_message(channel, timeout)

    if message:
        return jsonify({
            'status': 'message',
            'data': message,
            'timestamp': time.time()
        })
    else:
        return jsonify({
            'status': 'timeout',
            'timestamp': time.time()
        })

@app.route('/api/publish/<channel>', methods=['POST'])
def publish(channel):
    """Publish message to channel."""
    message = request.json
    message['id'] = str(uuid.uuid4())
    message['timestamp'] = time.time()

    manager.publish(channel, message)

    return jsonify({'status': 'published', 'message_id': message['id']})
```

### クライアント側（JavaScript）

```javascript
class LongPollingClient {
  constructor(baseUrl, channel, options = {}) {
    this.baseUrl = baseUrl;
    this.channel = channel;
    this.timeout = options.timeout || 30000;
    this.retryDelay = options.retryDelay || 1000;
    this.maxRetries = options.maxRetries || 5;
    this.isRunning = false;
    this.lastTimestamp = 0;
    this.retryCount = 0;
    this.abortController = null;
    this.callbacks = {
      message: [],
      error: [],
      connected: [],
      disconnected: []
    };
  }

  on(event, callback) {
    if (this.callbacks[event]) {
      this.callbacks[event].push(callback);
    }
  }

  emit(event, data) {
    if (this.callbacks[event]) {
      this.callbacks[event].forEach(cb => cb(data));
    }
  }

  async start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.emit('connected', { channel: this.channel });
    this.poll();
  }

  stop() {
    this.isRunning = false;
    if (this.abortController) {
      this.abortController.abort();
    }
    this.emit('disconnected', { channel: this.channel });
  }

  async poll() {
    while (this.isRunning) {
      try {
        this.abortController = new AbortController();

        const url = `${this.baseUrl}/poll/${this.channel}?` +
          `since=${this.lastTimestamp}&timeout=${this.timeout / 1000}`;

        const response = await fetch(url, {
          signal: this.abortController.signal,
          // Important: set timeout slightly longer than server timeout
          timeout: this.timeout + 5000
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const data = await response.json();
        this.retryCount = 0; // Reset on success

        if (data.status === 'message') {
          this.lastTimestamp = data.timestamp;
          this.emit('message', data.data);
        }
        // On timeout, just continue polling

      } catch (error) {
        if (error.name === 'AbortError') {
          continue; // Normal stop
        }

        this.emit('error', error);
        this.retryCount++;

        if (this.retryCount >= this.maxRetries) {
          this.emit('disconnected', { reason: 'max_retries' });
          this.isRunning = false;
          return;
        }

        // Exponential backoff
        const delay = this.retryDelay * Math.pow(2, this.retryCount - 1);
        await this.sleep(Math.min(delay, 30000));
      }
    }
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Usage
const client = new LongPollingClient('https://api.example.com', 'notifications');

client.on('message', (data) => {
  console.log('Received:', data);
  showNotification(data);
});

client.on('error', (error) => {
  console.error('Long polling error:', error);
});

client.start();
```

---

## ロングポーリングのスケーリング

### Redis Pub/Subバックエンド

```python
import redis
import json
import threading
from typing import Callable, Dict, List
from flask import Flask
import gevent
from gevent import queue as gevent_queue

class RedisLongPollingManager:
    """
    Scalable long polling using Redis pub/sub.
    Works across multiple server instances.
    """

    def __init__(self, redis_url: str = 'redis://localhost:6379'):
        self.redis = redis.from_url(redis_url)
        self.pubsub = self.redis.pubsub()
        self.local_waiters: Dict[str, List] = {}
        self.lock = threading.Lock()

        # Start listener thread
        self.listener_thread = threading.Thread(target=self._listen)
        self.listener_thread.daemon = True
        self.listener_thread.start()

    def _listen(self):
        """Background thread listening to Redis."""
        for message in self.pubsub.listen():
            if message['type'] == 'message':
                channel = message['channel'].decode()
                data = json.loads(message['data'])
                self._notify_local_waiters(channel, data)

    def _notify_local_waiters(self, channel: str, data: dict):
        """Notify all local waiters for this channel."""
        with self.lock:
            waiters = self.local_waiters.get(channel, [])[:]

        for waiter_queue in waiters:
            try:
                waiter_queue.put(data)
            except:
                pass

    def subscribe(self, channel: str):
        """Subscribe to a channel."""
        self.pubsub.subscribe(channel)

    def wait_for_message(self, channel: str, timeout: float = 30) -> dict:
        """Wait for message with gevent-compatible queue."""
        waiter_queue = gevent_queue.Queue()

        with self.lock:
            if channel not in self.local_waiters:
                self.local_waiters[channel] = []
                self.subscribe(channel)
            self.local_waiters[channel].append(waiter_queue)

        try:
            return waiter_queue.get(timeout=timeout)
        except gevent_queue.Empty:
            return None
        finally:
            with self.lock:
                if channel in self.local_waiters:
                    self.local_waiters[channel] = [
                        w for w in self.local_waiters[channel]
                        if w != waiter_queue
                    ]

    def publish(self, channel: str, message: dict):
        """Publish message to Redis (all instances)."""
        self.redis.publish(channel, json.dumps(message))
```

```mermaid
graph TD
    LB[Load Balancer] --> S1["Server 1<br/>Waiters: [A, B]"]
    LB --> S2["Server 2<br/>Waiters: [C, D]"]
    LB --> S3["Server 3<br/>Waiters: [E, F]"]
    S1 --> Redis[("Redis Pub/Sub<br/>publish(ch)<br/>broadcast to all servers")]
    S2 --> Redis
    S3 --> Redis
```

### 接続制限とタイムアウト

```python
from dataclasses import dataclass
from typing import Dict, Set
import time

@dataclass
class ConnectionLimit:
    max_per_client: int = 6      # Max concurrent connections per client
    max_per_channel: int = 10000  # Max concurrent per channel
    max_total: int = 100000       # Max total connections

class ConnectionManager:
    """Manage connection limits for long polling."""

    def __init__(self, limits: ConnectionLimit = None):
        self.limits = limits or ConnectionLimit()
        self.connections_by_client: Dict[str, Set[str]] = {}
        self.connections_by_channel: Dict[str, int] = {}
        self.total_connections = 0
        self.lock = threading.Lock()

    def can_connect(self, client_id: str, channel: str) -> tuple[bool, str]:
        """Check if new connection is allowed."""
        with self.lock:
            # Check total limit
            if self.total_connections >= self.limits.max_total:
                return False, "Server at capacity"

            # Check per-client limit
            client_conns = self.connections_by_client.get(client_id, set())
            if len(client_conns) >= self.limits.max_per_client:
                return False, "Too many connections from client"

            # Check per-channel limit
            channel_count = self.connections_by_channel.get(channel, 0)
            if channel_count >= self.limits.max_per_channel:
                return False, "Channel at capacity"

            return True, ""

    def add_connection(self, client_id: str, channel: str, conn_id: str):
        """Register new connection."""
        with self.lock:
            if client_id not in self.connections_by_client:
                self.connections_by_client[client_id] = set()
            self.connections_by_client[client_id].add(conn_id)

            self.connections_by_channel[channel] = \
                self.connections_by_channel.get(channel, 0) + 1

            self.total_connections += 1

    def remove_connection(self, client_id: str, channel: str, conn_id: str):
        """Unregister connection."""
        with self.lock:
            if client_id in self.connections_by_client:
                self.connections_by_client[client_id].discard(conn_id)
                if not self.connections_by_client[client_id]:
                    del self.connections_by_client[client_id]

            if channel in self.connections_by_channel:
                self.connections_by_channel[channel] -= 1
                if self.connections_by_channel[channel] <= 0:
                    del self.connections_by_channel[channel]

            self.total_connections = max(0, self.total_connections - 1)

# Use in endpoint
conn_manager = ConnectionManager()

@app.route('/api/poll/<channel>')
def long_poll_with_limits(channel):
    client_id = request.headers.get('X-Client-ID') or request.remote_addr
    conn_id = str(uuid.uuid4())

    # Check limits
    allowed, reason = conn_manager.can_connect(client_id, channel)
    if not allowed:
        return jsonify({'error': reason}), 429

    conn_manager.add_connection(client_id, channel, conn_id)

    try:
        message = manager.wait_for_message(channel, timeout=30)
        return jsonify({'data': message, 'timestamp': time.time()})
    finally:
        conn_manager.remove_connection(client_id, channel, conn_id)
```

---

## 信頼性のためのメッセージキューイング

```python
from collections import deque
from dataclasses import dataclass
from typing import List, Optional
import time

@dataclass
class QueuedMessage:
    id: str
    data: dict
    timestamp: float
    delivered_to: set  # Client IDs that received this message

class MessageQueue:
    """
    Message queue for reliable long polling.
    Clients can catch up on missed messages.
    """

    def __init__(self, max_age: float = 300, max_size: int = 1000):
        self.max_age = max_age
        self.max_size = max_size
        self.messages: deque = deque(maxlen=max_size)
        self.lock = threading.Lock()

    def add_message(self, message_id: str, data: dict) -> QueuedMessage:
        """Add message to queue."""
        msg = QueuedMessage(
            id=message_id,
            data=data,
            timestamp=time.time(),
            delivered_to=set()
        )

        with self.lock:
            self.messages.append(msg)
            self._cleanup()

        return msg

    def get_messages_since(
        self,
        since_id: Optional[str],
        since_timestamp: float,
        client_id: str
    ) -> List[dict]:
        """Get messages since given point."""
        with self.lock:
            self._cleanup()

            result = []
            found_since = since_id is None

            for msg in self.messages:
                if not found_since:
                    if msg.id == since_id:
                        found_since = True
                    continue

                if msg.timestamp > since_timestamp:
                    result.append(msg.data)
                    msg.delivered_to.add(client_id)

            return result

    def _cleanup(self):
        """Remove expired messages."""
        cutoff = time.time() - self.max_age
        while self.messages and self.messages[0].timestamp < cutoff:
            self.messages.popleft()

class ReliableLongPolling:
    """
    Long polling with message queue for reliability.
    """

    def __init__(self):
        self.queues: Dict[str, MessageQueue] = {}
        self.waiters: Dict[str, List] = {}
        self.lock = threading.Lock()

    def get_or_create_queue(self, channel: str) -> MessageQueue:
        if channel not in self.queues:
            self.queues[channel] = MessageQueue()
        return self.queues[channel]

    def poll(
        self,
        channel: str,
        client_id: str,
        last_message_id: Optional[str],
        timeout: float = 30
    ) -> dict:
        """
        Poll for messages.
        First returns any missed messages, then waits for new ones.
        """
        queue = self.get_or_create_queue(channel)

        # Check for missed messages first
        missed = queue.get_messages_since(
            last_message_id,
            time.time() - queue.max_age,
            client_id
        )

        if missed:
            return {
                'status': 'messages',
                'messages': missed,
                'count': len(missed)
            }

        # Wait for new message
        event = threading.Event()
        message_holder = {'message': None}

        with self.lock:
            if channel not in self.waiters:
                self.waiters[channel] = []
            self.waiters[channel].append((event, message_holder, client_id))

        try:
            if event.wait(timeout=timeout):
                return {
                    'status': 'message',
                    'messages': [message_holder['message']],
                    'count': 1
                }
            return {'status': 'timeout', 'messages': [], 'count': 0}
        finally:
            with self.lock:
                self.waiters[channel] = [
                    w for w in self.waiters.get(channel, [])
                    if w[0] != event
                ]
```

---

## ロードバランサーの設定

```nginx
# nginx.conf for long polling

upstream backend {
    # Use IP hash for sticky sessions
    # (same client goes to same server)
    ip_hash;

    server backend1:8080;
    server backend2:8080;
    server backend3:8080;
}

server {
    listen 80;

    location /api/poll/ {
        proxy_pass http://backend;

        # Extended timeouts for long polling
        proxy_read_timeout 60s;
        proxy_send_timeout 60s;
        proxy_connect_timeout 5s;

        # Disable buffering
        proxy_buffering off;

        # Keep connection alive
        proxy_http_version 1.1;
        proxy_set_header Connection "";

        # Pass client info
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }

    # Regular API endpoints with normal timeouts
    location /api/ {
        proxy_pass http://backend;
        proxy_read_timeout 30s;
    }
}
```

---

## 他の手法との比較

```
                    ポーリング  ロングポーリング    SSE         WebSocket
────────────────────────────────────────────────────────────────────────
レイテンシ           高         低〜中            低          非常に低
                    (間隔依存)  (~100ms)         (~10ms)     (~1ms)

サーバーリソース      低         中               中          高
                    (ステートレス)(接続)          (接続)      (接続)

帯域幅              高         低               低          非常に低
                    (多数のリクエスト)(少ないリクエスト)(ストリーミング)(バイナリ)

双方向通信           不可        不可              不可         可能

ファイアウォール対応  ✓✓✓        ✓✓              ✓✓          ✓

実装の複雑さ         シンプル     中程度            中程度       複雑

再接続              N/A        手動              自動         手動

メッセージ順序       ✓          ✓               ✓           ✓（手動）
────────────────────────────────────────────────────────────────────────

ロングポーリングを使うべき場面:
• ポーリングよりも低いレイテンシが必要
• WebSocket/SSEが利用不可（プロキシの問題）
• 中程度の更新頻度（1〜10回/秒）
• 信頼性の高いメッセージ配信が必要
• 双方向通信が不要

ロングポーリングを避けるべき場面:
• 非常に高い更新頻度
• 双方向通信が必要
• WebSocket/SSEのサポートがある
• サーバーリソースに制約がある
```

---

## 重要なポイント

1. **ポーリングよりも低いレイテンシ**: メッセージは固定間隔ではなく、利用可能になった時点で即座に配信されます

2. **再接続を適切に処理する**: クライアントは各レスポンス後に即座に再接続するべきです

3. **タイムアウトを適切に実装する**: サーバーのタイムアウトはクライアントのタイムアウトよりわずかに短くし、クリーンなレスポンスを保証します

4. **スケーリングにはRedisを使用する**: Pub/Subにより、複数のサーバーインスタンス間でのロングポーリングが可能になります

5. **信頼性のためにメッセージをキューイングする**: 切断後にクライアントが未受信メッセージに追いつけるようにします

6. **接続制限を管理する**: オープンな接続が多すぎることによるリソース枯渇を防止します

7. **インフラストラクチャを設定する**: ロードバランサーには拡張されたタイムアウトとスティッキーセッションが必要です
