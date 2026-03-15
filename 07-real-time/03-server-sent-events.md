# Server-Sent Events (SSE)

## TL;DR

Server-Sent Events (SSE) is a simple, HTTP-based protocol for streaming updates from server to client. Unlike WebSockets, SSE is unidirectional (server to client only), uses standard HTTP, and includes automatic reconnection. It's ideal for dashboards, notifications, feeds, and any scenario where the client only needs to receive updates.

---

## How SSE Works

```
Client                                        Server
  │                                              │
  │──── GET /events ────────────────────────────►│
  │     Accept: text/event-stream                │
  │                                              │
  │◄──── HTTP 200 ───────────────────────────────│
  │      Content-Type: text/event-stream         │
  │      (connection stays open)                 │
  │                                              │
  │◄──── data: {"price": 150.00}\n\n ───────────│
  │                                              │
  │◄──── data: {"price": 151.25}\n\n ───────────│
  │                                              │
  │◄──── data: {"price": 149.50}\n\n ───────────│
  │                                              │
  │              ... (continuous) ...            │
  │                                              │
  │      (connection drops)                      │
  │                                              │
  │──── GET /events ────────────────────────────►│
  │     Last-Event-ID: 42                        │
  │     (automatic reconnection!)                │
```

---

## SSE Message Format

```
Single message:
data: Hello World\n
\n

Multi-line message:
data: first line\n
data: second line\n
data: third line\n
\n

With event type:
event: notification\n
data: {"message": "New follower"}\n
\n

With ID (for reconnection):
id: 42\n
event: update\n
data: {"value": 100}\n
\n

Setting retry interval:
retry: 5000\n

Comment (keepalive):
: this is a comment\n
```

---

## Basic Implementation

### Server-Side (Node.js)

```javascript
import http from 'node:http';

class SSEManager {
  /** Manage SSE connections and broadcasting. */
  constructor() {
    this.clients = new Map();   // clientId -> http.ServerResponse
    this.messageId = 0;
  }

  register(clientId, res) {
    this.clients.set(clientId, res);
  }

  unregister(clientId) {
    this.clients.delete(clientId);
  }

  broadcast(data, event = null) {
    this.messageId += 1;
    const frame = formatSSE(data, event, this.messageId);

    for (const res of this.clients.values()) {
      res.write(frame);
    }
  }

  sendTo(clientId, data, event = null) {
    const res = this.clients.get(clientId);
    if (!res) return;

    this.messageId += 1;
    res.write(formatSSE(data, event, this.messageId));
  }
}

const sseManager = new SSEManager();

function formatSSE(data, event = null, id = null) {
  const lines = [];
  if (id !== null) lines.push(`id: ${id}`);
  if (event) lines.push(`event: ${event}`);
  lines.push(`data: ${JSON.stringify(data)}`);
  return lines.join('\n') + '\n\n';
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // SSE endpoint
  if (req.method === 'GET' && url.pathname === '/events') {
    const clientId = url.searchParams.get('client_id') ?? req.socket.remoteAddress;
    const lastEventId = req.headers['last-event-id']
      ? Number(req.headers['last-event-id'])
      : null;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no', // Disable nginx buffering
    });

    // Replay missed messages if reconnecting
    if (lastEventId) {
      for (const msg of getMessagesSince(lastEventId)) {
        res.write(formatSSE(msg.data, msg.event ?? null, msg.id));
      }
    }

    // Send keepalive comment
    res.write(': connected\n\n');

    sseManager.register(clientId, res);

    // Keepalive interval
    const keepalive = setInterval(() => res.write(': keepalive\n\n'), 30_000);

    req.on('close', () => {
      clearInterval(keepalive);
      sseManager.unregister(clientId);
    });
    return;
  }

  // Publish endpoint
  if (req.method === 'POST' && url.pathname === '/publish') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const data = JSON.parse(body);
      const eventType = data._event ?? null;
      delete data._event;
      sseManager.broadcast(data, eventType);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'published' }));
    });
    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(3000, () => console.log('SSE server listening on :3000'));
```

### Client-Side (JavaScript)

```javascript
class SSEClient {
  constructor(url, options = {}) {
    this.url = url;
    this.options = options;
    this.eventSource = null;
    this.callbacks = {};
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = options.maxReconnectAttempts || 10;
    this.reconnectDelay = options.reconnectDelay || 1000;
  }

  connect() {
    // EventSource handles reconnection automatically
    this.eventSource = new EventSource(this.url);

    // Default message handler (no event type)
    this.eventSource.onmessage = (event) => {
      this.handleEvent('message', event);
    };

    // Connection opened
    this.eventSource.onopen = () => {
      console.log('SSE connected');
      this.reconnectAttempts = 0;
      this.emit('connected');
    };

    // Error handling
    this.eventSource.onerror = (error) => {
      console.error('SSE error:', error);
      
      if (this.eventSource.readyState === EventSource.CLOSED) {
        this.emit('disconnected');
        this.handleReconnect();
      }
    };

    return this;
  }

  // Listen for specific event types
  on(eventType, callback) {
    if (!this.callbacks[eventType]) {
      this.callbacks[eventType] = [];
      
      // Register with EventSource for custom event types
      if (this.eventSource && eventType !== 'message' && 
          eventType !== 'connected' && eventType !== 'disconnected') {
        this.eventSource.addEventListener(eventType, (event) => {
          this.handleEvent(eventType, event);
        });
      }
    }
    
    this.callbacks[eventType].push(callback);
    return this;
  }

  handleEvent(eventType, event) {
    const data = JSON.parse(event.data);
    this.emit(eventType, data, event.lastEventId);
  }

  emit(eventType, data, id) {
    const callbacks = this.callbacks[eventType] || [];
    callbacks.forEach(cb => cb(data, id));
  }

  handleReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('Max reconnection attempts reached');
      return;
    }

    this.reconnectAttempts++;
    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);
    
    console.log(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
    setTimeout(() => this.connect(), delay);
  }

  close() {
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
  }
}

// Usage
const sse = new SSEClient('/events?client_id=user123');

sse.on('connected', () => {
  console.log('Connected to event stream');
});

sse.on('message', (data) => {
  console.log('Received:', data);
});

// Custom event types
sse.on('notification', (data) => {
  showNotification(data);
});

sse.on('price-update', (data) => {
  updatePriceDisplay(data);
});

sse.connect();
```

---

## Scaling SSE with Redis

```javascript
import http from 'node:http';
import { createClient } from 'redis';
import { randomUUID } from 'node:crypto';

/**
 * Scalable SSE using Redis pub/sub.
 * Works across multiple server instances.
 */
class RedisSSEManager {
  constructor(redisUrl = 'redis://localhost:6379') {
    this.pub = createClient({ url: redisUrl });
    this.sub = this.pub.duplicate();
    this.localClients = new Map();   // channel -> Map<clientId, res>
    this.subscriptions = new Set();
    this.idKey = 'sse:message_id';
  }

  async connect() {
    await Promise.all([this.pub.connect(), this.sub.connect()]);
  }

  _distributeLocally(channel, data) {
    const clients = this.localClients.get(channel);
    if (!clients) return;

    const frame = formatSSE(data.data, data.event ?? null, data.id);
    for (const res of clients.values()) {
      res.write(frame);
    }
  }

  async subscribe(channel, clientId, res) {
    if (!this.localClients.has(channel)) {
      this.localClients.set(channel, new Map());
      await this.sub.subscribe(channel, (raw) => {
        this._distributeLocally(channel, JSON.parse(raw));
      });
      this.subscriptions.add(channel);
    }
    this.localClients.get(channel).set(clientId, res);
  }

  unsubscribe(channel, clientId) {
    const clients = this.localClients.get(channel);
    if (!clients) return;

    clients.delete(clientId);
    if (clients.size === 0) {
      this.localClients.delete(channel);
      this.sub.unsubscribe(channel);
      this.subscriptions.delete(channel);
    }
  }

  async publish(channel, data, event = null) {
    const messageId = await this.pub.incr(this.idKey);

    const message = {
      id: messageId,
      event,
      data,
      timestamp: Date.now(),
    };

    // Store in Redis for reconnection support
    await this._storeMessage(channel, message);

    // Publish to all instances
    await this.pub.publish(channel, JSON.stringify(message));
    return messageId;
  }

  async _storeMessage(channel, message, ttl = 300) {
    const key = `sse:history:${channel}`;
    await this.pub.zAdd(key, { score: message.id, value: JSON.stringify(message) });
    await this.pub.expire(key, ttl);
    // Trim to last 1000 messages
    await this.pub.zRemRangeByRank(key, 0, -1001);
  }

  async getMessagesSince(channel, lastId) {
    const key = `sse:history:${channel}`;
    const raw = await this.pub.zRangeByScore(key, `(${lastId}`, '+inf');
    return raw.map((m) => JSON.parse(m));
  }
}

// Usage with Node.js http server
const redisSSE = new RedisSSEManager();
await redisSSE.connect();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const channelMatch = url.pathname.match(/^\/events\/(.+)$/);

  if (req.method === 'GET' && channelMatch) {
    const channel = channelMatch[1];
    const clientId = url.searchParams.get('client_id') ?? randomUUID();
    const lastId = req.headers['last-event-id']
      ? Number(req.headers['last-event-id'])
      : null;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
    });

    // Replay missed messages
    if (lastId) {
      for (const msg of await redisSSE.getMessagesSince(channel, lastId)) {
        res.write(formatSSE(msg.data, msg.event ?? null, msg.id));
      }
    }

    res.write(': connected\n\n');

    await redisSSE.subscribe(channel, clientId, res);

    const keepalive = setInterval(() => res.write(': keepalive\n\n'), 30_000);

    req.on('close', () => {
      clearInterval(keepalive);
      redisSSE.unsubscribe(channel, clientId);
    });
    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(3000, () => console.log('SSE server listening on :3000'));
```

---

## Common Use Cases

### Real-Time Dashboard

```javascript
import os from 'node:os';

class SystemMetricsPublisher {
  /** Publish system metrics via SSE. */
  constructor(sseManager, interval = 1000) {
    this.sse = sseManager;
    this.interval = interval;
    this.timer = null;
  }

  start() {
    this.timer = setInterval(() => this._publish(), this.interval);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  _publish() {
    const cpus = os.cpus();
    const totalIdle = cpus.reduce((sum, c) => sum + c.times.idle, 0);
    const totalTick = cpus.reduce(
      (sum, c) => sum + c.times.user + c.times.nice + c.times.sys + c.times.irq + c.times.idle,
      0,
    );
    const cpuPercent = ((1 - totalIdle / totalTick) * 100).toFixed(1);
    const mem = os.totalmem() - os.freemem();

    const metrics = {
      cpu_percent: Number(cpuPercent),
      memory_percent: Number(((mem / os.totalmem()) * 100).toFixed(1)),
      timestamp: Date.now(),
    };

    this.sse.publish('metrics', metrics, 'system-metrics');
  }
}

// Start publishing
const publisher = new SystemMetricsPublisher(redisSSE);
publisher.start();
```

```javascript
// Dashboard client
const dashboard = new SSEClient('/events/metrics');

dashboard.on('system-metrics', (data) => {
  document.getElementById('cpu').textContent = `${data.cpu_percent}%`;
  document.getElementById('memory').textContent = `${data.memory_percent}%`;
  
  updateChart('cpu-chart', data.timestamp, data.cpu_percent);
  updateChart('memory-chart', data.timestamp, data.memory_percent);
});

dashboard.connect();
```

### Live Activity Feed

```javascript
class ActivityFeedPublisher {
  /** Publish user activity events. */
  constructor(sseManager) {
    this.sse = sseManager;
  }

  async publishActivity(userId, action, details) {
    const eventData = {
      user_id: userId,
      action,
      details,
      timestamp: Date.now(),
    };

    // Publish to user's followers
    const followers = await this.getFollowers(userId);
    for (const followerId of followers) {
      await this.sse.publish(`feed:${followerId}`, eventData, 'activity');
    }

    // Publish to global feed
    await this.sse.publish('feed:global', eventData, 'activity');
  }

  async getFollowers(userId) {
    // Fetch from database
    return db.getFollowers(userId);
  }
}

// Usage
const feed = new ActivityFeedPublisher(redisSSE);

// POST /api/posts handler (inside your http server request handler)
async function handleCreatePost(req, res) {
  const body = await readBody(req);
  const post = await createPostInDb(JSON.parse(body));

  await feed.publishActivity(
    currentUser.id,
    'created_post',
    { postId: post.id, title: post.title },
  );

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(post));
}
```

### Stock Price Ticker

```javascript
class StockTickerPublisher {
  /** Simulate stock price updates. */
  constructor(sseManager) {
    this.sse = sseManager;
    this.stocks = {
      AAPL: 150.0,
      GOOGL: 2800.0,
      MSFT: 300.0,
      AMZN: 3400.0,
    };
  }

  start() {
    setInterval(() => {
      for (const [symbol, price] of Object.entries(this.stocks)) {
        const change = (Math.random() - 0.5);                       // -0.5 .. +0.5
        const newPrice = Math.round((price + change) * 100) / 100;
        this.stocks[symbol] = newPrice;

        this.sse.publish(
          `stocks:${symbol}`,
          {
            symbol,
            price: newPrice,
            change: Math.round(change * 100) / 100,
            change_percent: Math.round((change / price) * 10000) / 100,
          },
          'price-update',
        );
      }
    }, 100); // 10 updates/second
  }
}
```

---

## Infrastructure Configuration

### Nginx

```nginx
location /events {
    proxy_pass http://backend;
    
    # SSE-specific settings
    proxy_http_version 1.1;
    proxy_set_header Connection '';
    
    # Disable buffering
    proxy_buffering off;
    proxy_cache off;
    
    # Extended timeouts
    proxy_read_timeout 86400s;  # 24 hours
    proxy_send_timeout 86400s;
    
    # Chunked transfer encoding
    chunked_transfer_encoding on;
    
    # Disable nginx's event buffer
    proxy_set_header X-Accel-Buffering no;
}
```

### AWS ALB

```yaml
# CloudFormation
Resources:
  TargetGroup:
    Type: AWS::ElasticLoadBalancingV2::TargetGroup
    Properties:
      HealthCheckPath: /health
      HealthCheckIntervalSeconds: 30
      # Extended idle timeout for SSE
      TargetGroupAttributes:
        - Key: deregistration_delay.timeout_seconds
          Value: '30'
        - Key: stickiness.enabled
          Value: 'true'
        - Key: stickiness.type
          Value: 'lb_cookie'
          
  Listener:
    Type: AWS::ElasticLoadBalancingV2::Listener
    Properties:
      LoadBalancerArn: !Ref LoadBalancer
      DefaultActions:
        - Type: forward
          TargetGroupArn: !Ref TargetGroup

  LoadBalancer:
    Type: AWS::ElasticLoadBalancingV2::LoadBalancer
    Properties:
      LoadBalancerAttributes:
        - Key: idle_timeout.timeout_seconds
          Value: '3600'  # 1 hour idle timeout
```

---

## Comparison with Alternatives

```
Feature              SSE          WebSocket     Long Polling
────────────────────────────────────────────────────────────
Direction            Server→Client  Bidirectional  Server→Client

Protocol             HTTP          WebSocket      HTTP

Reconnection         Automatic     Manual         Manual

Event Types          Built-in      Manual         Manual

Message ID/Replay    Built-in      Manual         Manual

Binary Data          No            Yes            Yes

Proxy/Firewall       Excellent     Good           Excellent

Complexity           Low           High           Medium

Browser Support      Good*         Excellent      Excellent

Max Connections      ~6/domain     Unlimited      ~6/domain

* IE not supported, use polyfill
```

---

## Key Takeaways

1. **Simple and standard**: SSE uses HTTP, works with existing infrastructure, and has built-in browser support

2. **Automatic reconnection**: EventSource API handles reconnection with Last-Event-ID for message recovery

3. **Event types**: Built-in support for named events enables routing different message types

4. **Unidirectional only**: Use WebSocket if you need bidirectional communication

5. **Disable buffering**: Configure nginx/proxies to disable response buffering for real-time delivery

6. **Scale with Redis**: Use pub/sub to broadcast events across multiple server instances

7. **Connection limits**: Browsers limit connections per domain (~6); consider HTTP/2 or connection pooling
