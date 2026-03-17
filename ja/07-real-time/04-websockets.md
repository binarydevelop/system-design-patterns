# WebSocket

> **注:** この記事は英語版からの翻訳です。コードブロック、Mermaidダイアグラム、およびツール名は原文のまま保持しています。

## TL;DR

WebSocketは、単一のTCP接続上でリアルタイムの双方向データ交換を可能にする全二重通信プロトコルです。HTTPハンドシェイクによって接続がアップグレードされた後、クライアントとサーバーの両方が独立してメッセージを送信できます。WebSocketは、チャット、ゲーム、共同編集、および低レイテンシの双方向通信を必要とするあらゆるアプリケーションに最適です。

---

## WebSocketの仕組み

```
HTTP Handshake (Upgrade):

Client                                        Server
  │                                              │
  │──── GET /chat HTTP/1.1 ─────────────────────►│
  │     Host: server.example.com                 │
  │     Upgrade: websocket                       │
  │     Connection: Upgrade                      │
  │     Sec-WebSocket-Key: dGhlIHNhbXBsZS...    │
  │     Sec-WebSocket-Version: 13                │
  │                                              │
  │◄─── HTTP/1.1 101 Switching Protocols ───────│
  │     Upgrade: websocket                       │
  │     Connection: Upgrade                      │
  │     Sec-WebSocket-Accept: s3pPLMBi...       │
  │                                              │
  │══════════ WebSocket Connection ══════════════│
  │                                              │
  │◄──── "Hello from server" ───────────────────│
  │                                              │
  │──── "Hello from client" ────────────────────►│
  │                                              │
  │◄──── "Real-time update" ────────────────────│
  │                                              │
  │──── "User action" ──────────────────────────►│
  │                                              │
```

---

## WebSocketフレームフォーマット

```
 0                   1                   2                   3
 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
+-+-+-+-+-------+-+-------------+-------------------------------+
|F|R|R|R| opcode|M| Payload len |    Extended payload length    |
|I|S|S|S|  (4)  |A|     (7)     |             (16/64)           |
|N|V|V|V|       |S|             |   (if payload len==126/127)   |
| |1|2|3|       |K|             |                               |
+-+-+-+-+-------+-+-------------+ - - - - - - - - - - - - - - - +
|     Extended payload length continued, if payload len == 127  |
+ - - - - - - - - - - - - - - - +-------------------------------+
|                               |Masking-key, if MASK set to 1  |
+-------------------------------+-------------------------------+
| Masking-key (continued)       |          Payload Data         |
+-------------------------------- - - - - - - - - - - - - - - - +
:                     Payload Data continued ...                :
+ - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - +
|                     Payload Data continued ...                |
+---------------------------------------------------------------+

Opcodes:
  0x0: Continuation frame
  0x1: Text frame
  0x2: Binary frame
  0x8: Connection close
  0x9: Ping
  0xA: Pong
```

---

## 基本的な実装

### サーバー側（Node.js、wsライブラリ使用）

```javascript
import { WebSocketServer } from 'ws';

class Client {
  constructor(ws, userId) {
    this.ws = ws;
    this.userId = userId;
    this.channels = new Set();
  }
}

class WsServer {
  constructor() {
    this.clients = new Map();           // userId -> Client
    this.channels = new Map();          // channel -> Set<userId>
  }

  register(ws, userId) {
    const client = new Client(ws, userId);
    this.clients.set(userId, client);
    console.log(`Client ${userId} connected`);
    return client;
  }

  unregister(userId) {
    const client = this.clients.get(userId);
    if (!client) return;

    for (const channel of client.channels) {
      const members = this.channels.get(channel);
      if (members) members.delete(userId);
    }
    this.clients.delete(userId);
    console.log(`Client ${userId} disconnected`);
  }

  subscribe(userId, channel) {
    const client = this.clients.get(userId);
    if (!client) return;

    client.channels.add(channel);
    if (!this.channels.has(channel)) this.channels.set(channel, new Set());
    this.channels.get(channel).add(userId);
  }

  unsubscribe(userId, channel) {
    const client = this.clients.get(userId);
    if (client) client.channels.delete(channel);

    const members = this.channels.get(channel);
    if (members) members.delete(userId);
  }

  sendToUser(userId, message) {
    const client = this.clients.get(userId);
    if (!client) return;

    try {
      client.ws.send(JSON.stringify(message));
    } catch {
      this.unregister(userId);
    }
  }

  broadcastToChannel(channel, message, exclude = null) {
    const members = this.channels.get(channel);
    if (!members) return;

    for (const userId of members) {
      if (userId !== exclude) this.sendToUser(userId, message);
    }
  }

  broadcastAll(message) {
    for (const userId of this.clients.keys()) {
      this.sendToUser(userId, message);
    }
  }

  handleMessage(client, raw) {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      console.warn(`Invalid JSON from ${client.userId}`);
      return;
    }

    const { type } = message;

    if (type === 'subscribe') {
      this.subscribe(client.userId, message.channel);
      this.sendToUser(client.userId, {
        type: 'subscribed',
        channel: message.channel,
      });
    } else if (type === 'unsubscribe') {
      this.unsubscribe(client.userId, message.channel);
    } else if (type === 'message') {
      this.broadcastToChannel(
        message.channel,
        {
          type: 'message',
          channel: message.channel,
          from: client.userId,
          data: message.data,
        },
      );
    } else if (type === 'ping') {
      this.sendToUser(client.userId, { type: 'pong' });
    }
  }
}

// Run server
const server = new WsServer();
let clientCounter = 0;

const wss = new WebSocketServer({ port: 8765 });

wss.on('connection', (ws, req) => {
  const userId = req.headers['x-user-id'] ?? String(++clientCounter);
  const client = server.register(ws, userId);

  ws.on('message', (data) => server.handleMessage(client, data.toString()));

  ws.on('close', () => server.unregister(userId));

  ws.on('error', (err) => {
    console.error(`Error for ${userId}:`, err.message);
    server.unregister(userId);
  });
});

console.log('WebSocket server listening on ws://localhost:8765');
```

### クライアント側（JavaScript）

```javascript
class WebSocketClient {
  constructor(url, options = {}) {
    this.url = url;
    this.options = options;
    this.ws = null;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = options.maxReconnectAttempts || 10;
    this.reconnectDelay = options.reconnectDelay || 1000;
    this.pingInterval = options.pingInterval || 30000;
    this.pingTimer = null;
    this.callbacks = new Map();
    this.messageHandlers = new Map();
    this.messageId = 0;
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);

      this.ws.onopen = () => {
        console.log('WebSocket connected');
        this.reconnectAttempts = 0;
        this.startPingInterval();
        this.emit('connected');
        resolve();
      };

      this.ws.onclose = (event) => {
        console.log(`WebSocket closed: ${event.code}`);
        this.stopPingInterval();
        this.emit('disconnected', event);
        this.handleReconnect();
      };

      this.ws.onerror = (error) => {
        console.error('WebSocket error:', error);
        this.emit('error', error);
        reject(error);
      };

      this.ws.onmessage = (event) => {
        this.handleMessage(event.data);
      };
    });
  }

  handleMessage(data) {
    try {
      const message = JSON.parse(data);

      // Check for response to request
      if (message.id && this.callbacks.has(message.id)) {
        const { resolve, reject } = this.callbacks.get(message.id);
        this.callbacks.delete(message.id);

        if (message.error) {
          reject(new Error(message.error));
        } else {
          resolve(message);
        }
        return;
      }

      // Emit message by type
      const handler = this.messageHandlers.get(message.type);
      if (handler) {
        handler(message);
      }

      this.emit('message', message);
    } catch (error) {
      console.error('Failed to parse message:', error);
    }
  }

  send(data) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    } else {
      throw new Error('WebSocket not connected');
    }
  }

  // Send message and wait for response
  request(data, timeout = 5000) {
    return new Promise((resolve, reject) => {
      const id = ++this.messageId;
      data.id = id;

      const timer = setTimeout(() => {
        this.callbacks.delete(id);
        reject(new Error('Request timeout'));
      }, timeout);

      this.callbacks.set(id, {
        resolve: (response) => {
          clearTimeout(timer);
          resolve(response);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        }
      });

      this.send(data);
    });
  }

  subscribe(channel) {
    return this.request({ type: 'subscribe', channel });
  }

  unsubscribe(channel) {
    this.send({ type: 'unsubscribe', channel });
  }

  publish(channel, data) {
    this.send({ type: 'message', channel, data });
  }

  on(type, handler) {
    this.messageHandlers.set(type, handler);
  }

  emit(event, data) {
    const handler = this.messageHandlers.get(event);
    if (handler) handler(data);
  }

  startPingInterval() {
    this.pingTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.send({ type: 'ping' });
      }
    }, this.pingInterval);
  }

  stopPingInterval() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  handleReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('Max reconnection attempts reached');
      this.emit('reconnect_failed');
      return;
    }

    this.reconnectAttempts++;
    const delay = Math.min(
      this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1),
      30000
    );

    console.log(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
    setTimeout(() => this.connect(), delay);
  }

  close() {
    this.stopPingInterval();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}

// Usage
const ws = new WebSocketClient('wss://api.example.com/ws');

ws.on('connected', () => {
  ws.subscribe('chat:room1');
});

ws.on('message', (msg) => {
  if (msg.type === 'message') {
    displayMessage(msg.from, msg.data);
  }
});

ws.connect();
```

---

## WebSocketのスケーリング

### 水平スケーリングのためのRedis Pub/Sub

```javascript
import { WebSocketServer } from 'ws';
import { createClient } from 'redis';

/**
 * WebSocket server that scales horizontally using Redis pub/sub.
 * Each server instance handles its own connections but broadcasts
 * messages through Redis to reach all clients.
 */
class ScalableWsServer {
  constructor(redisUrl = 'redis://localhost:6379') {
    this.redisUrl = redisUrl;
    this.pub = null;
    this.sub = null;

    // Local connections only
    this.localClients = new Map();          // userId -> ws
    this.localSubscriptions = new Map();    // channel -> Set<userId>
    this.serverId = `server-${process.pid}`;
  }

  async connectRedis() {
    this.pub = createClient({ url: this.redisUrl });
    this.sub = this.pub.duplicate();
    await Promise.all([this.pub.connect(), this.sub.connect()]);
  }

  async _deliverLocally(channel, message) {
    const subscribers = this.localSubscriptions.get(channel);
    if (!subscribers) return;

    for (const userId of subscribers) {
      const ws = this.localClients.get(userId);
      if (ws) {
        try { ws.send(JSON.stringify(message)); } catch { /* noop */ }
      }
    }
  }

  async subscribe(userId, channel) {
    if (!this.localSubscriptions.has(channel)) {
      this.localSubscriptions.set(channel, new Set());
      // Subscribe to Redis channel
      await this.sub.subscribe(channel, (raw) => {
        const data = JSON.parse(raw);
        this._deliverLocally(channel, data);
      });
    }
    this.localSubscriptions.get(channel).add(userId);
  }

  async publish(channel, message) {
    await this.pub.publish(channel, JSON.stringify(message));
  }

  async register(ws, userId) {
    this.localClients.set(userId, ws);

    // Store connection info in Redis for presence
    await this.pub.hSet(
      'ws:connections',
      userId,
      JSON.stringify({ server: this.serverId, connectedAt: Date.now() }),
    );
  }

  async unregister(userId) {
    this.localClients.delete(userId);

    // Remove from all local subscriptions
    for (const subscribers of this.localSubscriptions.values()) {
      subscribers.delete(userId);
    }

    // Remove from Redis
    await this.pub.hDel('ws:connections', userId);
  }
}
```

```
水平スケーリングアーキテクチャ:

                    ┌─────────────────────────────────────┐
                    │           Load Balancer             │
                    │     (WebSocket aware, sticky)       │
                    └─────────────────┬───────────────────┘
                                      │
          ┌───────────────────────────┼───────────────────────────┐
          │                           │                           │
          ▼                           ▼                           ▼
    ┌───────────┐               ┌───────────┐               ┌───────────┐
    │  Server 1 │               │  Server 2 │               │  Server 3 │
    │           │               │           │               │           │
    │ Clients:  │               │ Clients:  │               │ Clients:  │
    │ [A, B, C] │               │ [D, E]    │               │ [F, G, H] │
    └─────┬─────┘               └─────┬─────┘               └─────┬─────┘
          │                           │                           │
          └───────────────────────────┼───────────────────────────┘
                                      │
                                      ▼
                            ┌─────────────────┐
                            │      Redis      │
                            │    Pub/Sub      │
                            └─────────────────┘

ユーザーAがチャンネル "room1" にメッセージを送信:
1. Server 1がAからWebSocketメッセージを受信
2. Server 1がRedisチャンネル "room1" にパブリッシュ
3. すべてのサーバーがRedisから受信
4. 各サーバーが "room1" をサブスクライブしているローカルクライアントに配信
```

### Redisによる接続状態管理

```javascript
import { createClient } from 'redis';

class ConnectionState {
  /** Manage WebSocket connection state in Redis. */
  constructor(redis, serverId) {
    this.redis = redis;
    this.serverId = serverId;
    this.connectionTtl = 300; // 5 minutes
  }

  async setConnected(userId, metadata = {}) {
    const data = {
      server: this.serverId,
      connectedAt: Date.now(),
      ...metadata,
    };

    const multi = this.redis.multi();
    multi.hSet('ws:connections', userId, JSON.stringify(data));
    multi.sAdd(`ws:server:${this.serverId}`, userId);
    multi.setEx(`ws:heartbeat:${userId}`, this.connectionTtl, '1');
    await multi.exec();
  }

  async heartbeat(userId) {
    await this.redis.setEx(`ws:heartbeat:${userId}`, this.connectionTtl, '1');
  }

  async setDisconnected(userId) {
    const multi = this.redis.multi();
    multi.hDel('ws:connections', userId);
    multi.sRem(`ws:server:${this.serverId}`, userId);
    multi.del(`ws:heartbeat:${userId}`);
    await multi.exec();
  }

  async isConnected(userId) {
    return (await this.redis.exists(`ws:heartbeat:${userId}`)) === 1;
  }

  async getConnection(userId) {
    const data = await this.redis.hGet('ws:connections', userId);
    return data ? JSON.parse(data) : null;
  }

  async getServerConnections() {
    return await this.redis.sMembers(`ws:server:${this.serverId}`);
  }

  async cleanupStale() {
    const connections = await this.redis.sMembers(`ws:server:${this.serverId}`);

    for (const userId of connections) {
      if (!(await this.isConnected(userId))) {
        await this.setDisconnected(userId);
      }
    }
  }
}
```

---

## メッセージプロトコル設計

```javascript
// Message types
const MessageType = Object.freeze({
  // Control
  CONNECT:     'connect',
  DISCONNECT:  'disconnect',
  PING:        'ping',
  PONG:        'pong',
  ERROR:       'error',
  // Pub/Sub
  SUBSCRIBE:   'subscribe',
  UNSUBSCRIBE: 'unsubscribe',
  PUBLISH:     'publish',
  MESSAGE:     'message',
  // Request/Response
  REQUEST:     'request',
  RESPONSE:    'response',
});

class Message {
  constructor({ type, id = null, channel = null, data = null, error = null, timestamp = null }) {
    this.type = type;
    this.id = id;
    this.channel = channel;
    this.data = data;
    this.error = error;
    this.timestamp = timestamp;
  }

  toJSON() {
    return JSON.stringify({
      type: this.type,
      id: this.id,
      channel: this.channel,
      data: this.data,
      error: this.error,
      timestamp: this.timestamp ?? Date.now(),
    });
  }

  static fromJSON(raw) {
    const obj = JSON.parse(raw);
    return new Message(obj);
  }
}

class MessageHandler {
  /** Route messages to handlers based on type. */
  constructor() {
    this.handlers = new Map();
  }

  register(msgType, fn) {
    this.handlers.set(msgType, fn);
  }

  async handle(client, message) {
    const handler = this.handlers.get(message.type);
    if (handler) {
      return await handler(client, message);
    }
    return new Message({
      type: MessageType.ERROR,
      id: message.id,
      error: `Unknown message type: ${message.type}`,
    });
  }
}

// Usage
const handler = new MessageHandler();

handler.register(MessageType.SUBSCRIBE, async (client, message) => {
  await server.subscribe(client.userId, message.channel);
  return new Message({
    type: MessageType.RESPONSE,
    id: message.id,
    data: { subscribed: message.channel },
  });
});

handler.register(MessageType.PUBLISH, async (client, message) => {
  await server.broadcastToChannel(
    message.channel,
    new Message({
      type: MessageType.MESSAGE,
      channel: message.channel,
      data: message.data,
    }),
    client.userId,
  );
  return new Message({
    type: MessageType.RESPONSE,
    id: message.id,
    data: { published: true },
  });
});
```

---

## 認証とセキュリティ

```javascript
import jwt from 'jsonwebtoken';

class WebSocketAuth {
  /** WebSocket authentication middleware. */
  constructor(secretKey) {
    this.secretKey = secretKey;
  }

  authenticate(ws, req) {
    return new Promise((resolve, reject) => {
      // Method 1: Token in query string
      const url = new URL(req.url, `http://${req.headers.host}`);
      let token = url.searchParams.get('token');

      // Method 2: Token in Sec-WebSocket-Protocol header
      if (!token) {
        const protocols = req.headers['sec-websocket-protocol'] ?? '';
        for (const proto of protocols.split(',')) {
          if (proto.trim().startsWith('auth.')) {
            token = proto.trim().slice(5);
            break;
          }
        }
      }

      // Method 3: Send token as first message
      if (!token) {
        const timeout = setTimeout(() => {
          reject(new Error('Authentication timeout'));
        }, 5000);

        ws.once('message', (raw) => {
          clearTimeout(timeout);
          try {
            const authData = JSON.parse(raw.toString());
            if (authData.type === 'auth') token = authData.token;
          } catch { /* ignore */ }

          if (!token) return reject(new Error('No authentication token provided'));
          resolve(this._verify(token));
        });
        return;
      }

      resolve(this._verify(token));
    });
  }

  _verify(token) {
    try {
      return jwt.verify(token, this.secretKey, { algorithms: ['HS256'] });
    } catch (err) {
      if (err.name === 'TokenExpiredError') throw new Error('Token expired');
      throw new Error('Invalid token');
    }
  }
}

class AuthenticatedWsServer extends WsServer {
  /** WebSocket server with authentication. */
  constructor(auth) {
    super();
    this.auth = auth;
  }

  listen(port) {
    const wss = new WebSocketServer({ port });

    wss.on('connection', async (ws, req) => {
      let userId;
      try {
        const userInfo = await this.auth.authenticate(ws, req);
        userId = userInfo.user_id;

        // Send auth success
        ws.send(JSON.stringify({ type: 'authenticated', user_id: userId }));

        // Continue with normal handling
        const client = this.register(ws, userId);
        client.userInfo = userInfo;

        ws.on('message', (data) => this.handleMessage(client, data.toString()));
        ws.on('close', () => this.unregister(userId));
      } catch (err) {
        ws.send(JSON.stringify({ type: 'error', error: err.message }));
        ws.close(4001, 'Authentication failed');
      }
    });
  }
}
```

---

## レート制限

```javascript
class WebSocketRateLimiter {
  /** Rate limit WebSocket messages per client. */
  constructor({ messagesPerSecond = 10, burstSize = 20, disconnectOnExceed = false } = {}) {
    this.rate = messagesPerSecond;
    this.burst = burstSize;
    this.disconnectOnExceed = disconnectOnExceed;
    this.tokens = new Map();
    this.lastUpdate = new Map();
  }

  checkRate(userId) {
    const now = Date.now() / 1000;

    if (!this.tokens.has(userId)) {
      this.tokens.set(userId, this.burst);
      this.lastUpdate.set(userId, now);
    }

    // Refill tokens
    const elapsed = now - this.lastUpdate.get(userId);
    this.tokens.set(userId, Math.min(this.burst, this.tokens.get(userId) + elapsed * this.rate));
    this.lastUpdate.set(userId, now);

    if (this.tokens.get(userId) >= 1) {
      this.tokens.set(userId, this.tokens.get(userId) - 1);
      return { allowed: true, reason: '' };
    }
    return { allowed: false, reason: 'Rate limit exceeded' };
  }

  reset(userId) {
    this.tokens.set(userId, this.burst);
    this.lastUpdate.set(userId, Date.now() / 1000);
  }
}

// Integration
const rateLimiter = new WebSocketRateLimiter({ messagesPerSecond: 10 });

function handleMessage(server, client, message) {
  const { allowed, reason } = rateLimiter.checkRate(client.userId);

  if (!allowed) {
    server.sendToUser(client.userId, { type: 'error', error: reason });

    if (rateLimiter.disconnectOnExceed) {
      client.ws.close(4008, 'Rate limit exceeded');
    }
    return;
  }

  // Process message normally
  server._processMessage(client, message);
}
```

---

## ロードバランサーの設定

### nginx（WebSocketサポート）

```nginx
upstream websocket_backend {
    # Sticky sessions required for WebSocket
    ip_hash;

    server backend1:8765;
    server backend2:8765;
    server backend3:8765;
}

server {
    listen 443 ssl;

    location /ws {
        proxy_pass http://websocket_backend;

        # WebSocket upgrade
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

        # Headers
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;

        # Timeouts
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;

        # Disable buffering
        proxy_buffering off;
    }
}
```

---

## 重要なポイント

1. **双方向通信**: WebSocketは単一の接続上でリアルタイムの双方向メッセージングを可能にします

2. **適切なハンドシェイク**: 接続はHTTPアップグレードで開始されます。認証はハンドシェイクの前または最中に処理します

3. **接続管理**: 接続を追跡し、切断を適切に処理し、ハートビート/ping-pongを実装します

4. **水平スケーリング**: Redis Pub/Subまたは同様の仕組みを使用して、サーバーインスタンス間でメッセージをブロードキャストします

5. **レート制限**: クライアントごとのレート制限でメッセージフラッディングから保護します

6. **再接続ロジック**: クライアントはエクスポネンシャルバックオフによる再接続を実装するべきです

7. **ロードバランサーの設定**: スティッキーセッションとWebSocket対応の設定が必要です
