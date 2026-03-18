# Discord System Design

## TL;DR

Discord serves 150M+ monthly active users with real-time voice, video, and text. The architecture centers on: **Elixir for WebSocket gateways** handling millions of concurrent connections, **Rust for CPU-intensive services** (message storage, voice), **guild-based sharding** for horizontal scaling, **Cassandra for message storage** with time-series optimization, and **WebRTC SFU** for voice channels. Key insight: gaming audiences demand ultra-low latency - optimize for sub-100ms message delivery and voice under 50ms.

---

## Core Requirements

### Functional Requirements
1. **Real-time messaging** - Text chat in channels and DMs
2. **Voice channels** - Low-latency voice communication
3. **Video streaming** - Screen share and camera
4. **Server/guild management** - Create and manage communities
5. **Roles & permissions** - Fine-grained access control
6. **Rich presence** - Show what users are playing/doing

### Non-Functional Requirements
1. **Latency** - Message delivery < 100ms, voice < 50ms
2. **Scale** - Millions of concurrent users, 10M+ messages/second
3. **Reliability** - 99.99% uptime
4. **Consistency** - Messages appear in order within channels
5. **Efficiency** - Handle 100k+ member servers ("mega-guilds")

---

## High-Level Architecture

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

## Gateway Architecture (Elixir)

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

### Gateway Implementation

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

## Message Storage with Cassandra

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

### Message Service Implementation (Rust)

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

## Voice Architecture

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

**Protocol Stack:**

- Application (Opus Audio / VP8 Video Codec)
- RTP/RTCP (Real-time Transport Protocol)
- DTLS-SRTP (Encryption)
- UDP/WebRTC

### Voice Server Implementation

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

## Mega-Guild Handling

### GuildService — Member Queries and Chunking (Python)

```python
# GuildService is Python in Discord's architecture
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
    GuildService: DB queries and member chunking for guilds with 100k+ members.
    Lazy loading and chunking to avoid overwhelming clients.
    """

    MEGA_GUILD_THRESHOLD = 100_000
    CHUNK_SIZE = 1000

    def __init__(self, db_client, cache_client):
        self.db = db_client
        self.cache = cache_client

    async def on_guild_available(
        self,
        guild_id: int
    ) -> dict:
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
        guild_id: int,
        query: Optional[str] = None,
        limit: int = 0,
        user_ids: Optional[List[int]] = None,
    ) -> dict:
        """
        Handle REQUEST_GUILD_MEMBERS (opcode 8).
        Returns members matching query or IDs, ready for chunking.
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

        return {"members": members, "not_found": not_found}

    async def get_channel_visible_members(
        self,
        guild_id: int,
        channel_id: int
    ) -> List[int]:
        """Get members who can see this channel based on permissions."""
        return await self._get_channel_visible_members(guild_id, channel_id)

    def chunk_members(
        self,
        members: List[dict],
        chunk_size: int
    ) -> List[List[dict]]:
        """Split members into chunks"""
        return [
            members[i:i + chunk_size]
            for i in range(0, len(members), chunk_size)
        ]
```

### Member List Subscription Tracking (Elixir)

```elixir
defmodule Discord.Guild.MemberListSubscription do
  @moduledoc """
  Tracks member list subscriptions for mega-guilds.
  Each guild channel's member sidebar is managed by a GenServer process.
  Syncs only the visible portion of the member list to subscribed sessions.
  """

  use GenServer
  require Logger

  @chunk_size 1000
  @cache_ttl_ms 60_000

  defstruct [
    :guild_id,
    :channel_id,
    subscribed_sessions: %{},   # session_id => pid
    member_groups: [],           # [{group_id, count, items}]
    online_count: 0,
    member_count: 0,
    last_refreshed: 0
  ]

  # --- Public API ---

  def start_link({guild_id, channel_id}) do
    GenServer.start_link(
      __MODULE__,
      {guild_id, channel_id},
      name: via(guild_id, channel_id)
    )
  end

  def subscribe(guild_id, channel_id, session_id, session_pid) do
    GenServer.call(
      via(guild_id, channel_id),
      {:subscribe, session_id, session_pid}
    )
  end

  def unsubscribe(guild_id, channel_id, session_id) do
    GenServer.cast(
      via(guild_id, channel_id),
      {:unsubscribe, session_id}
    )
  end

  def sync_range(guild_id, channel_id, session_id, range_start, range_end) do
    GenServer.call(
      via(guild_id, channel_id),
      {:sync_range, session_id, range_start, range_end}
    )
  end

  # --- Callbacks ---

  @impl true
  def init({guild_id, channel_id}) do
    # Monitor subscribed sessions so we can clean up on disconnect
    state = %__MODULE__{
      guild_id: guild_id,
      channel_id: channel_id
    }

    {:ok, state, {:continue, :load_members}}
  end

  @impl true
  def handle_continue(:load_members, state) do
    {:noreply, refresh_member_groups(state)}
  end

  @impl true
  def handle_call({:subscribe, session_id, session_pid}, _from, state) do
    Process.monitor(session_pid)

    new_subs = Map.put(state.subscribed_sessions, session_id, session_pid)
    state = %{state | subscribed_sessions: new_subs}

    # Fetch visible members from GuildService (Python) via RPC
    visible_ids =
      Discord.GuildService.get_channel_visible_members(
        state.guild_id,
        state.channel_id
      )

    # Request initial chunk from GuildService and dispatch
    result =
      Discord.GuildService.request_guild_members(
        state.guild_id,
        user_ids: Enum.take(visible_ids, @chunk_size)
      )

    chunks = chunk_members(result.members, @chunk_size)

    Enum.with_index(chunks, fn chunk, i ->
      payload = %{
        guild_id: state.guild_id,
        members: chunk,
        chunk_index: i,
        chunk_count: length(chunks),
        not_found: if(i == 0, do: result.not_found, else: []),
        nonce: nil
      }

      send(session_pid, {:dispatch, "GUILD_MEMBERS_CHUNK", payload})
    end)

    {:reply, :ok, state}
  end

  @impl true
  def handle_call({:sync_range, _session_id, range_start, range_end}, _from, state) do
    state = maybe_refresh(state)

    ops =
      state.member_groups
      |> Enum.reduce({0, []}, fn {group_id, count, items}, {idx, acc} ->
        group_start = idx
        group_end = idx + count

        acc =
          if group_end > range_start and group_start < range_end do
            vis_start = max(0, range_start - group_start)
            vis_end = min(count, range_end - group_start)

            op = %{
              op: "SYNC",
              items: Enum.slice(items, vis_start, vis_end - vis_start),
              range: [group_start + vis_start, group_start + vis_end]
            }

            [op | acc]
          else
            acc
          end

        {group_end, acc}
      end)
      |> elem(1)
      |> Enum.reverse()

    reply = %{
      ops: ops,
      online_count: state.online_count,
      member_count: state.member_count
    }

    {:reply, reply, state}
  end

  @impl true
  def handle_cast({:unsubscribe, session_id}, state) do
    new_subs = Map.delete(state.subscribed_sessions, session_id)
    {:noreply, %{state | subscribed_sessions: new_subs}}
  end

  @impl true
  def handle_info({:DOWN, _ref, :process, pid, _reason}, state) do
    # Clean up when a session process exits
    new_subs =
      state.subscribed_sessions
      |> Enum.reject(fn {_sid, p} -> p == pid end)
      |> Map.new()

    {:noreply, %{state | subscribed_sessions: new_subs}}
  end

  # --- Internals ---

  defp maybe_refresh(state) do
    now = System.monotonic_time(:millisecond)

    if now - state.last_refreshed > @cache_ttl_ms do
      refresh_member_groups(state)
    else
      state
    end
  end

  defp refresh_member_groups(state) do
    members =
      Discord.GuildService.get_channel_members(state.guild_id, state.channel_id)

    groups =
      members
      |> Enum.group_by(&get_member_group/1)
      |> Enum.map(fn {group_id, items} ->
        {group_id, length(items), items}
      end)

    online = Enum.count(members, fn m -> m[:status] != "offline" end)

    %{state |
      member_groups: groups,
      online_count: online,
      member_count: length(members),
      last_refreshed: System.monotonic_time(:millisecond)
    }
  end

  defp get_member_group(member) do
    member[:highest_role_id] || "online"
  end

  defp chunk_members(members, size) do
    Enum.chunk_every(members, size)
  end

  defp via(guild_id, channel_id) do
    {:via, Registry, {Discord.MemberListRegistry, {guild_id, channel_id}}}
  end
end
```

---

## Key Metrics & Scale

| Metric | Value |
|--------|-------|
| **Monthly Active Users** | 150M+ |
| **Concurrent Users** | 10M+ |
| **Messages/Second** | 10M+ |
| **Voice Minutes/Day** | 4B+ |
| **Guilds (Servers)** | 19M+ |
| **Largest Guilds** | 1M+ members |
| **WebSocket Connections** | Millions concurrent |
| **Message Latency** | < 100ms |
| **Voice Latency** | < 50ms |
| **Gateway Uptime** | 99.99% |

---

## Key Takeaways

1. **Elixir for WebSocket gateways** - OTP supervision provides fault tolerance. Millions of lightweight processes handle connections. Hot code upgrades for zero-downtime deploys.

2. **Rust for CPU-intensive services** - Message storage, voice mixing, media processing use Rust for performance and memory safety.

3. **Cassandra with time-bucketed partitions** - Channel messages partitioned by (channel_id, bucket). Prevents hot partitions in active channels.

4. **Snowflake IDs** - Time-sortable, globally unique IDs. Natural chronological ordering as clustering key.

5. **SFU for voice** - Selective Forwarding Unit scales better than P2P mesh. Upload once, server forwards to others. Enables moderation.

6. **Lazy member loading** - Large guilds don't send full member list. Clients request visible members on demand with chunking.

7. **Regional voice servers** - Voice routes to nearest region for lowest latency. Separate from API gateway infrastructure.

8. **Presence optimization** - Only broadcast presence to channels where user is visible. Reduces event volume for mega-guilds.

---

## Production Insights

### Lazy Presence for Mega-Guilds

Servers with 1M+ members cannot fan out presence updates to every connected client. Discord uses **lazy presence**: clients only receive presence updates for members visible in the current channel's member sidebar. When a user scrolls the member list, the client sends `LAZY_REQUEST` with the visible range, and the gateway syncs only that slice.

For guilds exceeding ~75k online members, the gateway skips full presence dispatch entirely at `GUILD_CREATE` time. Instead, presence is fetched on-demand per channel via `MemberListSubscription`. This reduces presence event volume from O(n^2) to O(visible_range * active_channels).

```elixir
defmodule Discord.Presence.LazyFanOut do
  @moduledoc """
  Lazy presence fan-out for mega-guilds.
  Instead of broadcasting to all guild members, only notify
  sessions that have the target user in their visible member list range.
  """

  @lazy_threshold 75_000

  def broadcast_presence_update(guild_id, user_id, new_status) do
    online_count = Discord.Presence.online_count(guild_id)

    if online_count >= @lazy_threshold do
      # Only notify sessions subscribed to channels where this user is visible
      subscribed_sessions =
        Discord.MemberListRegistry
        |> Registry.select([{{:"$1", :"$2", :"$3"}, [], [{{:"$1", :"$2"}}]}])
        |> Enum.filter(fn {{gid, _cid}} -> gid == guild_id end)

      Enum.each(subscribed_sessions, fn {{_gid, channel_id}} ->
        Discord.Guild.MemberListSubscription.notify_presence(
          guild_id, channel_id, user_id, new_status
        )
      end)
    else
      # Small guild: broadcast to all subscribed sessions
      Discord.PubSub.broadcast("guild:#{guild_id}", {"PRESENCE_UPDATE", %{
        user: %{id: user_id},
        status: new_status,
        guild_id: guild_id
      }})
    end
  end
end
```

### Guild Sharding

Every guild is assigned to a shard using consistent hashing: `shard_id = guild_id % num_shards`. Each gateway node owns a range of shards, so all events for a given guild are processed by the same node (or a small set of nodes). This avoids cross-node coordination for intra-guild operations like permission checks and member list updates.

When a guild grows beyond what a single shard can handle (e.g., 1M+ members), Discord splits hot operations across sub-shards while keeping the routing key stable. The client receives `shard_id` and `num_shards` in the `IDENTIFY` response and reconnects to the correct gateway.

```elixir
defmodule Discord.Guild.ShardRouter do
  @moduledoc """
  Routes guild operations to the correct shard.
  Uses guild_id % num_shards for deterministic assignment.
  """

  def shard_for(guild_id, num_shards) do
    rem(guild_id, num_shards)
  end

  def route(guild_id, operation, payload) do
    shard_id = shard_for(guild_id, Discord.Config.num_shards())
    node = Discord.ShardMap.node_for_shard(shard_id)

    :rpc.call(node, Discord.Guild.Shard, :handle, [guild_id, operation, payload])
  end
end
```

### ScyllaDB Migration from Cassandra (2023)

Discord migrated message storage from Cassandra to ScyllaDB in 2023. The primary driver was **p99 tail latency**: Cassandra's JVM-based garbage collection caused periodic latency spikes up to several seconds under heavy compaction. ScyllaDB, written in C++, uses a shard-per-core architecture with no GC pauses.

Key migration outcomes:
- **p99 read latency**: dropped from ~40-200ms (Cassandra, GC-dependent) to ~15ms (ScyllaDB)
- **p99 write latency**: dropped from ~5-70ms to ~5ms, with far fewer outliers
- **Compaction**: ScyllaDB's incremental compaction eliminated the multi-second stalls that Cassandra's size-tiered compaction could cause
- **Operational cost**: fewer nodes required for the same throughput due to ScyllaDB's shard-per-core efficiency
- **Schema compatibility**: ScyllaDB is wire-compatible with Cassandra's CQL, so the partition key design `(channel_id, bucket)` and Snowflake clustering key carried over unchanged

The migration was performed live with dual-writes: new messages written to both clusters, reads gradually shifted to ScyllaDB with checksum validation.

### BEAM Scheduler Tuning for 5M+ Connections

Each Elixir gateway node handles ~100k-200k WebSocket connections. At Discord's scale (~50+ gateway nodes), tuning the BEAM VM scheduler is critical.

Key tuning parameters:
- **`+S` (schedulers)**: pinned to the number of physical cores, not hyperthreads. Hyperthreading causes scheduler thread contention under high connection counts
- **`+SDcpu`**: dirty CPU schedulers set equal to physical cores for NIF-heavy operations (zlib compression, JSON encoding)
- **`+SDio`**: dirty I/O schedulers set to 2x cores for blocking operations like DNS resolution and certificate validation
- **`+sbwt` (scheduler busy wait threshold)**: set to `none` in production. Default busy-waiting wastes CPU cycles across 200k mostly-idle connections
- **`+zdbbl` (distribution buffer busy limit)**: increased to 32MB for inter-node Erlang distribution traffic. Default 1MB causes backpressure during presence fan-out storms
- **`+hms` (heap min size)**: tuned per process type. Session processes start at 2586 words to reduce early GC cycles for long-lived connections
- **Large ETS tables**: member lookup tables use `read_concurrency: true` and `write_concurrency: true` to avoid scheduler lock contention

```elixir
# vm.args tuning for a 200k-connection gateway node
# +P 5000000         Max processes (well above 200k connections + internal)
# +S 16:16           Schedulers pinned to 16 physical cores
# +SDcpu 16:16       Dirty CPU schedulers
# +SDio 32:32        Dirty I/O schedulers
# +sbwt none         Disable scheduler busy-wait
# +zdbbl 33554432    32MB distribution buffer
# +hms 2586          Min heap for session processes
```
