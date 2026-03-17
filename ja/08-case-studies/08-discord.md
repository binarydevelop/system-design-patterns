# Discord システム設計

> **注意:** この記事は英語版からの翻訳です。コードブロック、Mermaidダイアグラム、企業名、技術スタック名は原文のまま記載しています。

## TL;DR

Discordは1億5,000万人以上の月間アクティブユーザーにリアルタイムの音声、ビデオ、テキストを提供しています。アーキテクチャの中心には、数百万の同時接続を処理する**ElixirによるWebSocketゲートウェイ**、CPU集約型サービス（メッセージストレージ、音声）のための**Rust**、水平スケーリングのための**ギルドベースシャーディング**、時系列最適化を施した**Cassandraによるメッセージストレージ**、そして音声チャンネルのための**WebRTC SFU**があります。重要な知見：ゲーミングユーザーは超低レイテンシを要求します。100ms未満のメッセージ配信と50ms未満の音声レイテンシを最適化します。

---

## コア要件

### 機能要件
1. **リアルタイムメッセージング** - チャンネルとDMでのテキストチャット
2. **ボイスチャンネル** - 低レイテンシの音声通信
3. **ビデオストリーミング** - 画面共有とカメラ
4. **サーバー/ギルド管理** - コミュニティの作成と管理
5. **ロールと権限** - きめ細かなアクセス制御
6. **リッチプレゼンス** - ユーザーがプレイ/実行中の内容を表示

### 非機能要件
1. **レイテンシ** - メッセージ配信 < 100ms、音声 < 50ms
2. **スケール** - 数百万の同時ユーザー、毎秒1,000万以上のメッセージ
3. **信頼性** - 99.99%の稼働率
4. **整合性** - チャンネル内でメッセージが順序通りに表示される
5. **効率性** - 10万以上のメンバーを持つサーバー（「メガギルド」）の処理

---

## 上位レベルアーキテクチャ

```mermaid
graph TD
    Clients["Client Applications<br/>(Desktop Electron, Mobile, Web Browser)"]

    Clients -->|"WebSocket / WebRTC / HTTPS"| EdgeLayer

    subgraph EdgeLayer["Edge Layer"]
        CDN["Cloudflare CDN<br/>(Static, API)"]
        GLB["Global Load Balancer<br/>(Geographic, Anycast)"]
    end

    EdgeLayer --> GW1 & GW2 & GW3 & GW4

    subgraph GatewayLayer["Gateway Layer (Elixir)"]
        subgraph WSGateways["WebSocket Gateways<br/>Each gateway: Elixir/OTP for fault tolerance<br/>Handles: Auth, compression, heartbeats, dispatch"]
            GW1["Gateway 1<br/>100K conns"]
            GW2["Gateway 2<br/>100K conns"]
            GW3["Gateway 3<br/>100K conns"]
            GW4["Gateway 4<br/>100K conns ..."]
        end
    end

    GatewayLayer --> GuildSvc & MsgSvc & PresenceSvc

    subgraph ServiceLayer["Service Layer"]
        GuildSvc["Guild Service<br/>(Python)"]
        MsgSvc["Message Service<br/>(Rust)"]
        PresenceSvc["Presence Service<br/>(Elixir)"]
        VoiceSvc["Voice Server<br/>(Rust/C++)"]
        PermSvc["Permission Service"]
        PushSvc["Push Notification"]
        MediaProxy["Media Proxy<br/>(Rust)"]
        SearchSvc["Search<br/>(Elasticsearch)"]
    end

    ServiceLayer --> DataLayer

    subgraph DataLayer["Data Layer"]
        Cassandra[("Cassandra (Messages)<br/>Partitioned by: channel_id, bucket<br/>Bucket = 10 days<br/>Sorted by: message_id (Snowflake)")]
        Postgres[("PostgreSQL<br/>(Guilds, Users)")]
        Redis[("Redis<br/>(Sessions, Pub/Sub)")]
        ScyllaDB[("ScyllaDB<br/>(Attachments, Reactions)")]
    end
```

---

## Gatewayアーキテクチャ（Elixir）

```mermaid
graph TD
    subgraph ElixirGateway["Elixir Gateway Architecture"]
        subgraph OTP["OTP Supervision Tree"]
            GWSup["Gateway Supervisor"]

            GWSup --> ConnSup1["Connection Supervisor"]
            GWSup --> ConnSup2["Connection Supervisor"]
            GWSup --> ConnSup3["Connection Supervisor ..."]

            ConnSup1 --> S1["Session 1<br/>(GenServer)"]
            ConnSup2 --> S2["Session 2<br/>(GenServer)"]
            ConnSup3 --> S3["Session 3<br/>(GenServer) ..."]
        end

        Benefits["Benefits of Elixir/OTP:<br/>- Millions of lightweight processes<br/>- Supervision for fault tolerance<br/>- Hot code upgrades<br/>- Built-in distributed messaging"]
    end
```

### Gateway実装

```elixir
defmodule Discord.Gateway.Session do
  @moduledoc """
  Handles a single WebSocket connection.
  Each user session is an Elixir process.
  """

  use GenServer
  require Logger

  @heartbeat_interval 41_250  # ~41 seconds
  @heartbeat_timeout 60_000   # 60 seconds

  defstruct [
    :user_id,
    :session_id,
    :websocket,
    :guilds,
    :subscribed_channels,
    :last_heartbeat,
    :sequence,
    :shard_id,
    :compress
  ]

  def start_link(websocket, opts) do
    GenServer.start_link(__MODULE__, {websocket, opts})
  end

  @impl true
  def init({websocket, opts}) do
    # Schedule heartbeat check
    Process.send_after(self(), :check_heartbeat, @heartbeat_interval)

    state = %__MODULE__{
      websocket: websocket,
      session_id: generate_session_id(),
      guilds: MapSet.new(),
      subscribed_channels: MapSet.new(),
      last_heartbeat: System.monotonic_time(:millisecond),
      sequence: 0,
      compress: opts[:compress] || false
    }

    # Send HELLO with heartbeat interval
    send_payload(state, %{
      op: 10,  # HELLO
      d: %{heartbeat_interval: @heartbeat_interval}
    })

    {:ok, state}
  end

  @impl true
  def handle_info({:websocket, payload}, state) do
    case Jason.decode(payload) do
      {:ok, %{"op" => op} = data} ->
        handle_opcode(op, data, state)
      {:error, _} ->
        {:noreply, state}
    end
  end

  def handle_info(:check_heartbeat, state) do
    now = System.monotonic_time(:millisecond)

    if now - state.last_heartbeat > @heartbeat_timeout do
      # Connection dead, close it
      Logger.warn("Session #{state.session_id} heartbeat timeout")
      send_close(state, 4009, "Session timed out")
      {:stop, :normal, state}
    else
      Process.send_after(self(), :check_heartbeat, @heartbeat_interval)
      {:noreply, state}
    end
  end

  def handle_info({:dispatch, event_type, payload}, state) do
    # Dispatch event to client
    new_seq = state.sequence + 1

    send_payload(state, %{
      op: 0,  # DISPATCH
      t: event_type,
      s: new_seq,
      d: payload
    })

    {:noreply, %{state | sequence: new_seq}}
  end

  # Handle IDENTIFY (op: 2)
  defp handle_opcode(2, %{"d" => identify_data}, state) do
    token = identify_data["token"]

    case Discord.Auth.validate_token(token) do
      {:ok, user} ->
        # Authenticate successful
        state = %{state | user_id: user.id}

        # Register session globally
        Discord.Sessions.register(user.id, state.session_id, self())

        # Subscribe to user's guilds
        guilds = Discord.Guilds.get_user_guilds(user.id)

        Enum.each(guilds, fn guild ->
          Discord.PubSub.subscribe("guild:#{guild.id}")
        end)

        # Send READY event
        ready_payload = %{
          v: 10,  # Gateway version
          user: serialize_user(user),
          guilds: Enum.map(guilds, &serialize_guild_stub/1),
          session_id: state.session_id,
          resume_gateway_url: get_resume_url()
        }

        send_dispatch(state, "READY", ready_payload)

        # Lazy load guild data
        Enum.each(guilds, fn guild ->
          send_dispatch(state, "GUILD_CREATE", serialize_guild(guild))
        end)

        {:noreply, %{state | guilds: MapSet.new(Enum.map(guilds, & &1.id))}}

      {:error, :invalid_token} ->
        send_close(state, 4004, "Authentication failed")
        {:stop, :normal, state}
    end
  end

  # Handle HEARTBEAT (op: 1)
  defp handle_opcode(1, %{"d" => seq}, state) do
    # Respond with HEARTBEAT_ACK
    send_payload(state, %{op: 11})

    {:noreply, %{state | last_heartbeat: System.monotonic_time(:millisecond)}}
  end

  # Handle RESUME (op: 6)
  defp handle_opcode(6, %{"d" => resume_data}, state) do
    session_id = resume_data["session_id"]
    seq = resume_data["seq"]

    case Discord.Sessions.get_missed_events(session_id, seq) do
      {:ok, events} ->
        # Replay missed events
        Enum.each(events, fn {event_type, payload, event_seq} ->
          send_payload(state, %{
            op: 0,
            t: event_type,
            s: event_seq,
            d: payload
          })
        end)

        send_dispatch(state, "RESUMED", %{})
        {:noreply, %{state | sequence: List.last(events) |> elem(2)}}

      {:error, :session_expired} ->
        # Force re-identify
        send_payload(state, %{op: 9, d: false})  # INVALID_SESSION
        {:noreply, state}
    end
  end

  defp send_payload(state, payload) do
    data = Jason.encode!(payload)

    data = if state.compress do
      :zlib.compress(data)
    else
      data
    end

    send(state.websocket, {:send, data})
  end

  defp send_dispatch(state, event_type, payload) do
    send(self(), {:dispatch, event_type, payload})
  end
end

defmodule Discord.Gateway.Dispatcher do
  @moduledoc """
  Routes events to connected sessions.
  Uses ETS for O(1) lookups and pub/sub for distribution.
  """

  def dispatch_to_guild(guild_id, event_type, payload) do
    # Publish to all gateways that have members in this guild
    Discord.PubSub.broadcast("guild:#{guild_id}", {event_type, payload})
  end

  def dispatch_to_channel(channel_id, event_type, payload) do
    Discord.PubSub.broadcast("channel:#{channel_id}", {event_type, payload})
  end

  def dispatch_to_user(user_id, event_type, payload) do
    # Get all sessions for user
    sessions = Discord.Sessions.get_user_sessions(user_id)

    Enum.each(sessions, fn {_session_id, pid} ->
      send(pid, {:dispatch, event_type, payload})
    end)
  end
end
```

---

## Cassandraによるメッセージストレージ

```
┌─────────────────────────────────────────────────────────────────────────┐
│                   Cassandra Message Schema                               │
│                                                                          │
│   Partition Key: (channel_id, bucket)                                   │
│   Clustering Key: message_id DESC                                       │
│                                                                          │
│   ┌──────────────────────────────────────────────────────────────────┐  │
│   │                    Partition: (#general, 2024-01)                 │  │
│   │                                                                   │  │
│   │   message_id          | author_id | content      | created_at    │  │
│   │   ────────────────────────────────────────────────────────────   │  │
│   │   123456789012345678  | user_1    | "Hello!"     | 2024-01-15    │  │
│   │   123456789012345677  | user_2    | "Hi there"   | 2024-01-15    │  │
│   │   123456789012345676  | user_1    | "How are you"| 2024-01-14    │  │
│   │   ...                                                             │  │
│   └──────────────────────────────────────────────────────────────────┘  │
│                                                                          │
│   Why Bucket by Time:                                                   │
│   - Prevents hot partitions (all writes to one channel)                │
│   - Enables efficient time-range queries                                │
│   - Automatic data aging (delete old buckets)                          │
│   - Bucket size: 10 days of messages                                   │
│                                                                          │
│   Snowflake ID Benefits:                                                │
│   - Globally unique                                                     │
│   - Time-sortable                                                       │
│   - Cluster column ordering = chronological                             │
└─────────────────────────────────────────────────────────────────────────┘
```

### メッセージサービス実装（Rust）

```rust
use std::time::{SystemTime, UNIX_EPOCH};
use cassandra_cpp::{Cluster, Session, Statement};
use serde::{Deserialize, Serialize};

/// Discord Snowflake ID generator
/// Format: timestamp (42 bits) | worker_id (5 bits) | process_id (5 bits) | increment (12 bits)
pub struct SnowflakeGenerator {
    worker_id: u64,
    process_id: u64,
    sequence: u64,
    last_timestamp: u64,
}

impl SnowflakeGenerator {
    const DISCORD_EPOCH: u64 = 1420070400000; // 2015-01-01

    pub fn new(worker_id: u64, process_id: u64) -> Self {
        Self {
            worker_id: worker_id & 0x1F,  // 5 bits
            process_id: process_id & 0x1F, // 5 bits
            sequence: 0,
            last_timestamp: 0,
        }
    }

    pub fn generate(&mut self) -> u64 {
        let mut timestamp = self.current_timestamp();

        if timestamp == self.last_timestamp {
            self.sequence = (self.sequence + 1) & 0xFFF; // 12 bits

            if self.sequence == 0 {
                // Wait for next millisecond
                while timestamp <= self.last_timestamp {
                    timestamp = self.current_timestamp();
                }
            }
        } else {
            self.sequence = 0;
        }

        self.last_timestamp = timestamp;

        ((timestamp - Self::DISCORD_EPOCH) << 22)
            | (self.worker_id << 17)
            | (self.process_id << 12)
            | self.sequence
    }

    fn current_timestamp(&self) -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Message {
    pub id: u64,
    pub channel_id: u64,
    pub author_id: u64,
    pub content: String,
    pub timestamp: i64,
    pub edited_timestamp: Option<i64>,
    pub tts: bool,
    pub mention_everyone: bool,
    pub mentions: Vec<u64>,
    pub attachments: Vec<Attachment>,
    pub embeds: Vec<Embed>,
    pub reactions: Vec<Reaction>,
    pub nonce: Option<String>,
    pub pinned: bool,
    pub message_type: i32,
}

pub struct MessageService {
    cassandra: Session,
    snowflake: SnowflakeGenerator,
    cache: redis::Client,
    bucket_size_days: i64,
}

impl MessageService {
    /// Calculate bucket for a given timestamp
    fn calculate_bucket(&self, timestamp: i64) -> i64 {
        let days_since_epoch = timestamp / (24 * 60 * 60 * 1000);
        (days_since_epoch / self.bucket_size_days) * self.bucket_size_days
    }

    /// Create a new message
    pub async fn create_message(
        &mut self,
        channel_id: u64,
        author_id: u64,
        content: String,
        attachments: Vec<Attachment>,
    ) -> Result<Message, Error> {
        let message_id = self.snowflake.generate();
        let timestamp = chrono::Utc::now().timestamp_millis();
        let bucket = self.calculate_bucket(timestamp);

        let message = Message {
            id: message_id,
            channel_id,
            author_id,
            content,
            timestamp,
            edited_timestamp: None,
            tts: false,
            mention_everyone: false,
            mentions: self.extract_mentions(&content),
            attachments,
            embeds: vec![],
            reactions: vec![],
            nonce: None,
            pinned: false,
            message_type: 0,
        };

        // Insert into Cassandra
        let query = r#"
            INSERT INTO messages (
                channel_id, bucket, message_id, author_id, content,
                timestamp, edited_timestamp, tts, mention_everyone,
                mentions, attachments, embeds, pinned, message_type
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        "#;

        let mut statement = Statement::new(query, 14);
        statement.bind_int64(0, channel_id as i64)?;
        statement.bind_int64(1, bucket)?;
        statement.bind_int64(2, message_id as i64)?;
        statement.bind_int64(3, author_id as i64)?;
        statement.bind_string(4, &message.content)?;
        // ... bind remaining fields

        self.cassandra.execute(&statement).await?;

        // Update channel's last_message_id
        self.update_channel_last_message(channel_id, message_id).await?;

        // Invalidate cache
        self.cache.del(&format!("channel:{}:messages", channel_id)).await?;

        Ok(message)
    }

    /// Get messages from a channel with pagination
    pub async fn get_messages(
        &self,
        channel_id: u64,
        before: Option<u64>,
        after: Option<u64>,
        limit: i32,
    ) -> Result<Vec<Message>, Error> {
        // Check cache first
        let cache_key = format!("channel:{}:messages:latest", channel_id);
        if before.is_none() && after.is_none() {
            if let Some(cached) = self.cache.get(&cache_key).await? {
                return Ok(serde_json::from_str(&cached)?);
            }
        }

        // Determine which buckets to query
        let buckets = self.get_relevant_buckets(channel_id, before, after).await?;

        let mut messages = Vec::new();

        for bucket in buckets {
            let query = if let Some(before_id) = before {
                r#"
                    SELECT * FROM messages
                    WHERE channel_id = ? AND bucket = ? AND message_id < ?
                    ORDER BY message_id DESC
                    LIMIT ?
                "#
            } else if let Some(after_id) = after {
                r#"
                    SELECT * FROM messages
                    WHERE channel_id = ? AND bucket = ? AND message_id > ?
                    ORDER BY message_id ASC
                    LIMIT ?
                "#
            } else {
                r#"
                    SELECT * FROM messages
                    WHERE channel_id = ? AND bucket = ?
                    ORDER BY message_id DESC
                    LIMIT ?
                "#
            };

            let mut statement = Statement::new(query, 4);
            statement.bind_int64(0, channel_id as i64)?;
            statement.bind_int64(1, bucket)?;

            if let Some(id) = before.or(after) {
                statement.bind_int64(2, id as i64)?;
                statement.bind_int32(3, limit)?;
            } else {
                statement.bind_int32(2, limit)?;
            }

            let result = self.cassandra.execute(&statement).await?;

            for row in result.iter() {
                messages.push(self.row_to_message(&row)?);
            }

            if messages.len() >= limit as usize {
                break;
            }
        }

        messages.truncate(limit as usize);

        // Cache if fetching latest
        if before.is_none() && after.is_none() {
            let cached = serde_json::to_string(&messages)?;
            self.cache.setex(&cache_key, 60, &cached).await?;
        }

        Ok(messages)
    }

    /// Handle message deletion - Discord keeps tombstones for sync
    pub async fn delete_message(
        &self,
        channel_id: u64,
        message_id: u64,
    ) -> Result<(), Error> {
        // Get message to find bucket
        let message = self.get_message(channel_id, message_id).await?;
        let bucket = self.calculate_bucket(message.timestamp);

        // Soft delete - mark as deleted rather than removing
        let query = r#"
            UPDATE messages
            SET deleted = true, content = ''
            WHERE channel_id = ? AND bucket = ? AND message_id = ?
        "#;

        let mut statement = Statement::new(query, 3);
        statement.bind_int64(0, channel_id as i64)?;
        statement.bind_int64(1, bucket)?;
        statement.bind_int64(2, message_id as i64)?;

        self.cassandra.execute(&statement).await?;

        // Invalidate cache
        self.cache.del(&format!("channel:{}:messages", channel_id)).await?;

        Ok(())
    }
}
```

---

## 音声アーキテクチャ

```mermaid
graph TD
    subgraph VoiceRegion["Voice Region Selection<br/>Regions: us-west, us-east, eu-west, eu-central, brazil, sydney, singapore, japan"]
        ClientLoc["Client Location"] --> NearestRegion["Nearest Voice Region"] --> VS["Voice Server"]
    end

    subgraph SFU["SFU (Selective Forwarding Unit)"]
        UserA_in["User A"] --> VoiceServer["Voice Server<br/>Mixes audio for each recipient (server-side)"]
        UserB_in["User B"] --> VoiceServer
        UserC_in["User C"] --> VoiceServer
        VoiceServer --> UserA_out["User A"]
        VoiceServer --> UserB_out["User B"]
        VoiceServer --> UserC_out["User C"]
    end

    SFUBenefits["Benefits vs P2P mesh:<br/>- Scales to many participants<br/>- Bandwidth efficient (upload once)<br/>- Enables moderation<br/>- Consistent quality"]
```

**プロトコルスタック:**

- Application (Opus Audio / VP8 Video Codec)
- RTP/RTCP (Real-time Transport Protocol)
- DTLS-SRTP (Encryption)
- UDP/WebRTC

### ボイスサーバー実装

```rust
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;
use webrtc::peer_connection::RTCPeerConnection;
use webrtc::track::track_remote::TrackRemote;

/// Voice channel state
pub struct VoiceChannel {
    pub id: u64,
    pub guild_id: u64,
    pub participants: HashMap<u64, Participant>,
    pub speaking: HashMap<u64, bool>,
}

pub struct Participant {
    pub user_id: u64,
    pub session_id: String,
    pub peer_connection: Arc<RTCPeerConnection>,
    pub audio_track: Option<Arc<TrackRemote>>,
    pub video_track: Option<Arc<TrackRemote>>,
    pub muted: bool,
    pub deafened: bool,
    pub self_muted: bool,
    pub self_deafened: bool,
}

pub struct VoiceServer {
    channels: RwLock<HashMap<u64, VoiceChannel>>,
    region: String,
    opus_encoder: OpusEncoder,
}

impl VoiceServer {
    pub async fn join_channel(
        &self,
        channel_id: u64,
        user_id: u64,
        session_id: String,
    ) -> Result<VoiceConnectionInfo, Error> {
        let mut channels = self.channels.write().await;

        let channel = channels
            .entry(channel_id)
            .or_insert_with(|| VoiceChannel {
                id: channel_id,
                guild_id: 0, // Set from metadata
                participants: HashMap::new(),
                speaking: HashMap::new(),
            });

        // Create WebRTC peer connection
        let config = RTCConfiguration {
            ice_servers: vec![
                RTCIceServer {
                    urls: vec!["stun:stun.discord.com:3478".to_string()],
                    ..Default::default()
                },
            ],
            ..Default::default()
        };

        let peer_connection = Arc::new(
            RTCPeerConnection::new(&config).await?
        );

        // Set up audio/video receivers
        peer_connection.on_track(Box::new(move |track, receiver, transceiver| {
            let track = track.clone();
            Box::pin(async move {
                Self::handle_incoming_track(channel_id, user_id, track).await;
            })
        }));

        // Add participant
        channel.participants.insert(user_id, Participant {
            user_id,
            session_id: session_id.clone(),
            peer_connection: peer_connection.clone(),
            audio_track: None,
            video_track: None,
            muted: false,
            deafened: false,
            self_muted: false,
            self_deafened: false,
        });

        // Notify other participants
        self.broadcast_voice_state(channel_id, user_id, VoiceState::Joined).await;

        // Create offer for client
        let offer = peer_connection.create_offer(None).await?;
        peer_connection.set_local_description(offer.clone()).await?;

        Ok(VoiceConnectionInfo {
            endpoint: format!("wss://{}.discord.media:443", self.region),
            session_id,
            sdp: offer.sdp,
            user_id,
        })
    }

    async fn handle_incoming_track(
        channel_id: u64,
        user_id: u64,
        track: Arc<TrackRemote>,
    ) {
        // Read incoming audio/video
        tokio::spawn(async move {
            let mut buf = vec![0u8; 1500];

            while let Ok((n, _)) = track.read(&mut buf).await {
                let packet = &buf[..n];

                // Forward to other participants (SFU pattern)
                Self::forward_media(channel_id, user_id, packet).await;
            }
        });
    }

    async fn forward_media(channel_id: u64, sender_id: u64, packet: &[u8]) {
        let channels = VOICE_SERVER.channels.read().await;

        if let Some(channel) = channels.get(&channel_id) {
            for (user_id, participant) in &channel.participants {
                if *user_id != sender_id && !participant.deafened {
                    // Send packet to this participant
                    if let Some(ref track) = participant.audio_track {
                        // Write to participant's track
                        let _ = track.write(packet).await;
                    }
                }
            }
        }
    }

    pub async fn set_speaking(
        &self,
        channel_id: u64,
        user_id: u64,
        speaking: bool,
    ) {
        let mut channels = self.channels.write().await;

        if let Some(channel) = channels.get_mut(&channel_id) {
            channel.speaking.insert(user_id, speaking);

            // Broadcast speaking indicator
            self.broadcast_speaking(channel_id, user_id, speaking).await;
        }
    }

    async fn broadcast_speaking(&self, channel_id: u64, user_id: u64, speaking: bool) {
        // Send to all participants via WebSocket
        let payload = VoiceEvent::Speaking {
            user_id,
            speaking,
            ssrc: self.get_ssrc(user_id),
        };

        // Dispatch through gateway
        Gateway::dispatch_to_channel(channel_id, "SPEAKING", payload).await;
    }
}

/// Audio processing with Opus codec
pub struct AudioProcessor {
    encoder: opus::Encoder,
    decoder: opus::Decoder,
    jitter_buffer: JitterBuffer,
}

impl AudioProcessor {
    pub fn new() -> Result<Self, Error> {
        let encoder = opus::Encoder::new(
            48000,  // Sample rate
            opus::Channels::Stereo,
            opus::Application::Voip,
        )?;

        let decoder = opus::Decoder::new(48000, opus::Channels::Stereo)?;

        Ok(Self {
            encoder,
            decoder,
            jitter_buffer: JitterBuffer::new(200), // 200ms buffer
        })
    }

    pub fn encode(&mut self, pcm: &[i16]) -> Result<Vec<u8>, Error> {
        let mut output = vec![0u8; 4000];
        let len = self.encoder.encode(pcm, &mut output)?;
        output.truncate(len);
        Ok(output)
    }

    pub fn decode(&mut self, opus_data: &[u8]) -> Result<Vec<i16>, Error> {
        let mut output = vec![0i16; 5760]; // Max frame size
        let len = self.decoder.decode(opus_data, &mut output, false)?;
        output.truncate(len * 2); // Stereo
        Ok(output)
    }
}
```

---

## メガギルドの処理

```python
from dataclasses import dataclass
from typing import List, Dict, Set, Optional
import asyncio

@dataclass
class GuildMemberChunk:
    """Chunk of guild members for lazy loading"""
    guild_id: int
    members: List[dict]
    chunk_index: int
    chunk_count: int
    not_found: List[int]  # Requested but not found IDs
    nonce: Optional[str]


class MegaGuildHandler:
    """
    Special handling for guilds with 100k+ members.
    Uses lazy loading and chunking to avoid overwhelming clients.
    """

    MEGA_GUILD_THRESHOLD = 100_000
    CHUNK_SIZE = 1000

    def __init__(self, db_client, cache_client, gateway_dispatcher):
        self.db = db_client
        self.cache = cache_client
        self.dispatcher = gateway_dispatcher

    async def on_guild_available(
        self,
        session_id: str,
        guild_id: int
    ):
        """Called when client connects and guild becomes available"""
        member_count = await self._get_member_count(guild_id)

        if member_count >= self.MEGA_GUILD_THRESHOLD:
            # Don't send full member list
            # Client must request specific members
            return {
                "id": str(guild_id),
                "member_count": member_count,
                "large": True,
                "members": [],  # Empty - use request_guild_members
                "presences": [],
            }
        else:
            # Small guild - send full member list
            members = await self._get_all_members(guild_id)
            presences = await self._get_online_presences(guild_id)

            return {
                "id": str(guild_id),
                "member_count": member_count,
                "large": False,
                "members": members,
                "presences": presences,
            }

    async def request_guild_members(
        self,
        session_id: str,
        guild_id: int,
        query: Optional[str] = None,
        limit: int = 0,
        presences: bool = False,
        user_ids: Optional[List[int]] = None,
        nonce: Optional[str] = None
    ):
        """
        Handle REQUEST_GUILD_MEMBERS (opcode 8).
        Returns members matching query or IDs in chunks.
        """
        if user_ids:
            # Fetch specific users
            members = await self._get_members_by_ids(guild_id, user_ids)

            # Find which IDs weren't found
            found_ids = {m["user"]["id"] for m in members}
            not_found = [uid for uid in user_ids if uid not in found_ids]

        elif query is not None:
            # Search by username prefix
            members = await self._search_members(guild_id, query, limit or 100)
            not_found = []
        else:
            # Get all members (chunked)
            members = await self._get_all_members(guild_id)
            not_found = []

        # Add presences if requested
        if presences:
            member_ids = [m["user"]["id"] for m in members]
            presence_data = await self._get_presences(member_ids)
            for member in members:
                member["presence"] = presence_data.get(member["user"]["id"])

        # Split into chunks
        chunks = self._chunk_members(members, self.CHUNK_SIZE)

        # Send chunks
        for i, chunk in enumerate(chunks):
            chunk_data = GuildMemberChunk(
                guild_id=guild_id,
                members=chunk,
                chunk_index=i,
                chunk_count=len(chunks),
                not_found=not_found if i == 0 else [],
                nonce=nonce
            )

            await self.dispatcher.dispatch_to_session(
                session_id,
                "GUILD_MEMBERS_CHUNK",
                chunk_data.__dict__
            )

            # Rate limit chunking to avoid overwhelming client
            if len(chunks) > 1:
                await asyncio.sleep(0.1)

    async def subscribe_to_guild_member_list(
        self,
        session_id: str,
        guild_id: int,
        channel_ids: List[int]
    ):
        """
        Subscribe to member sidebar for specific channels.
        Only sends members visible in channel based on permissions.
        """
        visible_members = set()

        for channel_id in channel_ids:
            # Get members who can see this channel
            channel_members = await self._get_channel_visible_members(
                guild_id,
                channel_id
            )
            visible_members.update(channel_members)

        # Subscribe session to updates for these members
        await self._subscribe_session_to_members(
            session_id,
            guild_id,
            list(visible_members)
        )

        # Send initial member list
        await self.request_guild_members(
            session_id,
            guild_id,
            user_ids=list(visible_members)[:1000],
            presences=True
        )

    def _chunk_members(
        self,
        members: List[dict],
        chunk_size: int
    ) -> List[List[dict]]:
        """Split members into chunks"""
        return [
            members[i:i + chunk_size]
            for i in range(0, len(members), chunk_size)
        ]


class MemberListOptimizer:
    """
    Optimizes member list updates for large guilds.
    Uses groups (roles) and syncs only visible portions.
    """

    def __init__(self, cache_client):
        self.cache = cache_client

    async def get_member_list_state(
        self,
        guild_id: int,
        channel_id: int
    ) -> dict:
        """
        Get optimized member list state for a channel.
        Groups members by role, only includes visible roles.
        """
        cache_key = f"member_list:{guild_id}:{channel_id}"

        cached = await self.cache.get(cache_key)
        if cached:
            return json.loads(cached)

        # Build member list grouped by role
        members = await self._get_channel_members(guild_id, channel_id)

        # Group by highest role
        groups = {}
        for member in members:
            group_id = self._get_member_group(member)
            if group_id not in groups:
                groups[group_id] = {
                    "id": group_id,
                    "count": 0,
                    "items": []
                }
            groups[group_id]["count"] += 1
            groups[group_id]["items"].append(member)

        state = {
            "guild_id": str(guild_id),
            "groups": list(groups.values()),
            "online_count": sum(1 for m in members if m.get("status") != "offline"),
            "member_count": len(members)
        }

        await self.cache.setex(cache_key, 60, json.dumps(state))

        return state

    async def sync_member_list_ops(
        self,
        session_id: str,
        guild_id: int,
        channel_id: int,
        range_start: int,
        range_end: int
    ):
        """
        Send member list sync operations for visible range.
        Client specifies which range of the list is visible.
        """
        state = await self.get_member_list_state(guild_id, channel_id)

        # Calculate which items are in range
        ops = []
        current_index = 0

        for group in state["groups"]:
            group_start = current_index
            group_end = current_index + group["count"]

            if group_end > range_start and group_start < range_end:
                # This group is visible
                visible_start = max(0, range_start - group_start)
                visible_end = min(group["count"], range_end - group_start)

                ops.append({
                    "op": "SYNC",
                    "items": group["items"][visible_start:visible_end],
                    "range": [
                        group_start + visible_start,
                        group_start + visible_end
                    ]
                })

            current_index = group_end

        return {
            "ops": ops,
            "online_count": state["online_count"],
            "member_count": state["member_count"]
        }
```

---

## 主要メトリクスとスケール

| メトリクス | 値 |
|--------|-------|
| **月間アクティブユーザー** | 1億5,000万以上 |
| **同時ユーザー数** | 1,000万以上 |
| **毎秒のメッセージ数** | 1,000万以上 |
| **1日あたりの音声通話時間** | 40億分以上 |
| **ギルド（サーバー）数** | 1,900万以上 |
| **最大ギルドのメンバー数** | 100万以上 |
| **WebSocket接続数** | 数百万の同時接続 |
| **メッセージレイテンシ** | < 100ms |
| **音声レイテンシ** | < 50ms |
| **Gateway稼働率** | 99.99% |

---

## 重要なポイント

1. **WebSocketゲートウェイにElixir** - OTPスーパービジョンがフォールトトレランスを提供します。数百万の軽量プロセスで接続を処理します。ホットコードアップグレードでゼロダウンタイムデプロイを実現します。

2. **CPU集約型サービスにRust** - メッセージストレージ、音声ミキシング、メディア処理はパフォーマンスとメモリ安全性のためにRustを使用します。

3. **時間バケットパーティションを持つCassandra** - チャンネルメッセージは(channel_id, bucket)でパーティショニングされます。アクティブなチャンネルでのホットパーティションを防止します。

4. **Snowflake ID** - 時間ソート可能でグローバルに一意のIDです。クラスタリングキーとしての自然な時系列順序を提供します。

5. **音声のためのSFU** - Selective Forwarding UnitはP2Pメッシュよりもスケールします。一度アップロードすれば、サーバーが他に転送します。モデレーションが可能になります。

6. **メンバーの遅延読み込み** - 大規模ギルドは完全なメンバーリストを送信しません。クライアントはチャンキングでオンデマンドに可視メンバーをリクエストします。

7. **リージョン別の音声サーバー** - 音声は最低レイテンシのために最も近いリージョンにルーティングされます。APIゲートウェイインフラストラクチャとは分離されています。

8. **プレゼンスの最適化** - ユーザーが可視のチャンネルにのみプレゼンスをブロードキャストします。メガギルドのイベントボリュームを削減します。
