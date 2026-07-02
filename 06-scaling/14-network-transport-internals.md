# Network Transport Internals

## TL;DR

Every distributed-systems number in this book — timeout budgets, replication lag, tail latency — bottoms out in one physical fact: a round trip between two machines has a hard minimum set by the speed of light, and *protocols spend round trips*. A cold HTTPS request pays for TCP's handshake, TLS's handshake, and slow start's cautious ramp before the first useful byte moves; at 80 ms cross-region RTT that is 300+ ms of pure protocol, which is why [connection reuse](./13-dns-and-connection-management.md) is the single highest-leverage optimization in networking. Below the handshakes, *congestion control* decides how fast bytes flow once they do (`throughput ≤ cwnd / RTT`, and under loss, the Mathis ceiling `≈ MSS / (RTT × √p)` — loss and latency multiply), and *head-of-line blocking* keeps resurfacing one layer down from wherever it was last fixed: HTTP/2 fixed HTTP/1.1's request serialization only to inherit TCP's byte-stream blocking, and QUIC fixed that by rebuilding the transport on UDP with per-stream delivery, 1-RTT combined handshakes, and connection IDs that survive IP changes. Underneath it all sits the kernel path — interrupts, `epoll`, socket buffers — which is fine for almost everyone and is bypassed (XDP, DPDK) only by load balancers and proxies whose job is packets, not requests. This chapter builds the cost model from physics up, so you can predict a connection's behavior before you tcpdump it. The policy layers above — pool sizing, DNS, draining — live in [DNS and Connection Management](./13-dns-and-connection-management.md); the fleet view in [Load Balancing](./01-load-balancing.md).

---

## The Physics Bill: RTT Is the Unit of Cost

Light in fiber travels at roughly 2/3 of c — about 200 km per millisecond, or **1 ms of RTT per 100 km of straight-line distance**. Real routes are 20–50% longer than great circles (fiber follows railways and seabeds, not geodesics), so:

| Path | Great circle | Realistic RTT floor | Typical measured |
|---|---|---|---|
| Same datacenter | — | ~0.05–0.5 ms | 0.1–1 ms |
| Same metro (AZ to AZ) | < 100 km | ~1 ms | 1–2 ms |
| US coast to coast | 4,100 km | ~41 ms | 60–70 ms |
| New York → London | 5,570 km | ~56 ms | 70–80 ms |
| US → Asia-Pacific | 10,000+ km | ~100 ms | 130–180 ms |

Two consequences organize everything else:

1. **RTT is a floor, not a target.** No protocol work, hardware upgrade, or vendor product moves it. The only levers are *fewer round trips* (protocol design, caching, connection reuse) and *shorter distances* (edge presence, [CDNs](./04-cdn-architecture.md), [multi-region placement](./09-multi-region-architecture.md)).
2. **Count round trips, not bytes.** For the small payloads that dominate APIs, transfer time is noise next to round-trip count. The cold-connection ledger at 80 ms RTT:

```text
DNS lookup (uncached)           1 RTT-ish     ~80 ms   (resolver-dependent)
TCP handshake (SYN/SYN-ACK/ACK) 1 RTT          80 ms
TLS 1.3 handshake               1 RTT          80 ms   (TLS 1.2: 2 RTTs)
HTTP request + response         1 RTT          80 ms
                                          ─────────
First byte, cold:               ~320 ms — of which 0 ms is your server.

Same request on a warm, pooled connection:  ~80 ms.  (QUIC 0-RTT: also ~80 ms, cold.)
```

The third structural cost is the **bandwidth-delay product (BDP)**: a path can hold `bandwidth × RTT` bytes in flight, and the sender needs a window that large to fill it. A 1 Gbps path at 100 ms RTT holds 12.5 MB — if the sender's congestion window (or the receiver's advertised window, or a mis-sized socket buffer) is smaller, throughput drops proportionally: a 256 KB window on that path caps you at `256 KB / 100 ms ≈ 20 Mbps`, two percent of the pipe, with zero packet loss and no misconfiguration visible anywhere except the window size.

---

## TCP: Handshake, Slow Start, and the Window Machinery

TCP presents a reliable, ordered byte stream over an unreliable packet network. Everything below is the price of that abstraction.

**The handshake** (SYN → SYN-ACK → ACK) costs one RTT before any data, and exists to synchronize sequence numbers and defend the server's memory: half-open connections consume state, which is why SYN floods attack it and SYN cookies (encoding the state into the sequence number so the server stores nothing) defend it. TCP Fast Open tried to send data on the SYN and mostly failed in the wild — middleboxes dropped the unfamiliar packets — which became the canonical lesson in *protocol ossification*: the deployed internet calcifies around observable protocol behavior, and the only way to evolve a transport now is to encrypt it beyond middleboxes' sight (QUIC's actual master stroke, below).

**Slow start.** A new connection doesn't know the path's capacity, so it probes: the congestion window (`cwnd`) starts at 10 segments (~14.6 KB, RFC 6928) and doubles every RTT until loss or a threshold. Reaching a 12.5 MB BDP from 14.6 KB takes ~10 RTTs — a full second at 100 ms RTT *before TCP can even use the pipe*. This is why short flows never reach full bandwidth, why "our throughput is fine in `iperf` but slow for real requests" is expected (iperf runs long flows; your RPCs run short ones), and why connection reuse matters twice: a pooled connection has already paid both the handshake *and* the ramp. (One caveat: `cwnd` idles back down after inactivity unless `slow_start_after_idle` is disabled — a warm connection is only warm if it's been talking.)

**The window rules everything:**

```text
throughput ≤ min(cwnd, receiver_window) / RTT

Sustained throughput under random loss (Mathis et al., 1997):
throughput ≈ (MSS / RTT) × (1 / √p)        p = loss probability

1460 B MSS, 80 ms RTT, 0.1% loss:  1460/0.08 × 1/√0.001  ≈ 0.58 MB/s ≈ 4.6 Mbps
Same loss at 1 ms RTT (intra-DC):                        ≈ 370 Mbps
```

Read that table twice: **the same 0.1% loss rate costs 80× more throughput at 80× the RTT.** Loss and latency multiply. This is why a "slightly lossy" WAN link devastates cross-region replication while the same loss intra-DC goes unnoticed, and why loss-based congestion control had to be rethought (next section).

Two small timers cause an outsized share of grief. **Nagle's algorithm** batches small writes until the previous packet is ACKed; **delayed ACK** holds ACKs up to 40 ms hoping to piggyback. Each is sensible alone; together, a write-write-read pattern deadlocks into 40 ms stalls — the classic mystery latency in RPC systems. Every serious RPC stack sets `TCP_NODELAY`; you should assume it and verify it.

---

## Congestion Control: CUBIC, BBR, and Bufferbloat

Congestion control answers "how fast may I send?" continuously, and is the internet's actual admission-control system — [backpressure](./07-backpressure.md) implemented planet-wide.

**Loss-based control (Reno, then CUBIC — the Linux default)** treats packet loss as the congestion signal: grow `cwnd` until loss, cut, regrow (CUBIC regrows on a cubic curve so long-BDP paths recover faster). The model has two structural flaws. First, it *requires* creating loss to find capacity — it fills queues until they overflow. Second, it can't distinguish congestion loss from random loss (radio interference, a flaky optic), so it slashes throughput for losses that signal nothing — the Mathis penalty above.

Filling queues has a name: **bufferbloat**. Deep buffers in routers and home gateways don't drop packets; they absorb them into seconds of queueing delay. The pipe is "fully utilized" while every packet sits in line — latency climbs 10–100× under load with zero loss. If ping times balloon whenever a bulk transfer runs, that's bufferbloat, and it's a queueing-theory fact ([the utilization curve](../01-foundations/10-capacity-planning.md)), not a bandwidth shortage. Fixes live in the network (AQM: CoDel/FQ-CoDel drop *early* to signal *sooner*; ECN marks instead of dropping) and in the sender's model of the world:

**BBR (Google, 2016; v3 current)** abandons loss as the signal entirely. It continuously estimates the path's *bottleneck bandwidth* and *minimum RTT*, and paces sends at exactly `estimated_bw`, keeping in-flight data near one BDP — the operating point loss-based control structurally overshoots. Consequences: BBR barely reacts to random loss (huge on lossy WAN paths — this alone can be a 10× cross-region throughput win), doesn't fill buffers (low queueing delay), but pays costs: it must periodically *probe* (briefly send more to discover capacity), early versions starved CUBIC flows sharing a link, and its RTT-sensitivity gives lower-latency flows an edge. Google runs it for google.com and YouTube; it's a `sysctl` away on Linux. For cross-region, loss-exposed paths, measuring CUBIC vs BBR is one of the cheapest large wins available.

Inside a datacenter the problem inverts: RTTs are microseconds, flows are short, and the failure mode is **incast** — a scatter-gather fan-out ([the fan-out pattern](../08-case-studies/01-twitter.md)) where 100 servers answer one query simultaneously and the synchronized burst overflows the top-of-rack switch's shallow buffer in microseconds. Random loss models don't help; the answers are ECN-based control (DCTCP reacts to the *fraction* of marked packets, keeping queues near-empty), jittering responses, and capping fan-out width. If your p99 for scatter-gather queries has a hard step function in it, look at switch buffer occupancy before blaming any server.

---

## TLS 1.3: Pay Once, Resume Free

TLS 1.3 (RFC 8446) cut the handshake from two round trips to one — key exchange, cipher negotiation, and certificate delivery compressed into a single flight, with everything after the first message encrypted (including the certificate, removing a passive observer's view of *which* site you are — completed by Encrypted Client Hello). Removing legacy ciphers also removed entire vulnerability classes; there is no reason to negotiate anything older.

Resumption is where the systems design lives. A returning client presents a **session ticket** and resumes in one RTT — or zero: **0-RTT** sends application data *with* the first flight, encrypted under the previous session's key. The catch is fundamental, not implementational: a 0-RTT packet can be **replayed** by an attacker who captured it, and the server cannot tell. The rule: only idempotent requests in 0-RTT ([Idempotency](../01-foundations/08-idempotency.md)) — CDNs accept `GET`s and reject unsafe methods into 0-RTT; your API gateway must enforce the same or disable it.

Two operational notes. Session-ticket keys are fleet-wide secrets that must rotate (a leaked long-lived ticket key retroactively decrypts resumed sessions — this is a [key-rotation problem](../10-security/06-encryption.md), and it silently breaks forward secrecy if ignored). And in service meshes, mTLS per hop means the handshake tax is paid *per sidecar hop* — the mesh's connection pooling ([Sidecar Pattern](../12-service-mesh/03-sidecar-pattern.md)) is what keeps that affordable.

---

## HTTP/1.1 → HTTP/2 → HTTP/3: Head-of-Line Blocking Moves Down

The lineage is one bug being chased down the stack.

**HTTP/1.1** allows one in-flight request per connection. Pipelining (send several, receive in order) failed in deployment — one slow response blocks all behind it, *application-level* head-of-line blocking — so browsers opened 6 parallel connections per host and paid 6× handshakes and 6× slow starts. Domain sharding was this hack scaled up.

**HTTP/2** multiplexes concurrent streams over one connection with binary framing and header compression (HPACK — headers are highly repetitive across requests; compressing them matters at high request rates). One connection, one handshake, one congestion window shared across all streams. But TCP guarantees *in-order byte delivery for the whole connection*: lose one packet and every stream stalls until retransmission, including streams whose bytes already arrived. HTTP/2 fixed application HOL and **inherited transport HOL** — strictly worse than HTTP/1.1's 6 connections under high loss, because those 6 fates were at least independent. On clean networks H2 wins decisively; on lossy ones the single shared connection is the weakness. (H2 server push, meant to pre-send resources, was removed from Chrome years later — cache-aware clients beat server guesses; pushing data nobody asked for wastes the very bandwidth it tried to save.)

**HTTP/3** maps the same semantics onto QUIC streams, which fail independently. The bug finally dies at the transport layer — where it was actually located all along.

For internal RPC, gRPC-over-H2 remains the standard: datacenter networks are low-loss (transport HOL rarely bites), and the mesh manages connections. The H2 detail that does bite internally is stream-concurrency limits (`MAX_CONCURRENT_STREAMS`, commonly 100): a chatty client hits the ceiling and requests queue *at the client* — invisible to the server, visible only as client-side latency. Watch for it before adding server capacity.

---

## QUIC: The Transport, Rebuilt Above UDP

QUIC (RFC 9000) is TCP's second draft, written with 40 years of hindsight, deployed over UDP because deploying a new IP protocol number through the world's middleboxes is impossible — ossification again. What the redesign buys:

- **1-RTT combined handshake, 0-RTT resumption.** Transport and TLS 1.3 handshakes are merged, not stacked; TLS is a component of QUIC, not a layer above it. Cold connection in 1 RTT, resumed in 0 (same replay rules as above).
- **Streams as first-class transport objects.** Loss on stream A never stalls stream B — retransmission and flow control are per-stream. This is the HOL fix, and it's also a better RPC substrate: one request per stream means no request ever waits on another's packets.
- **Connection IDs instead of the 4-tuple.** A TCP connection *is* its (src IP, src port, dst IP, dst port); change any and it dies. A QUIC connection is an ID, so it **survives address changes** — WiFi to cellular mid-request, or more prosaically, a NAT rebinding its port (which silently kills idle TCP connections all day long; ask anyone who runs [WebSockets](../07-real-time/04-websockets.md) at scale). For load balancers, the connection ID is also the routing key: QUIC-aware L4 balancers route on it so a client's migration doesn't land on the wrong backend ([Load Balancing](./01-load-balancing.md)).
- **Encrypted transport headers.** Sequence numbers, ACKs, and connection state are invisible to the network — not (only) for privacy, but so middleboxes *cannot* grow dependencies on them, keeping the protocol evolvable. The bill: network operators lose passive RTT/loss observability (the spin bit is the negotiated crumb), and DDoS scrubbing gets harder.
- **Better loss recovery.** Monotonic packet numbers (retransmissions get *new* numbers) eliminate TCP's retransmission ambiguity; richer ACK ranges tighten RTT estimates.

The costs are real. QUIC burns 2–3× the CPU of TCP for the same bytes — decades of TCP hardware offload (segmentation, checksums, kTLS) don't apply, though UDP GSO and emerging NIC support narrow the gap. Every packet is encrypted per-packet in userspace. Amplification defense caps a server at 3× the client's initial bytes until the address is validated (why QUIC mandates ≥1200-byte initial packets). And some networks still block or throttle UDP: every HTTP/3 deployment keeps a TCP fallback, with Alt-Svc/HTTPS-RR steering clients to H3 — watch your fallback rate; a rising one silently converts your fleet back to TCP's behavior.

When it matters most: mobile and lossy last miles (independent streams + migration), short-flow-dominated workloads (1-RTT setup), high-RTT paths. When it matters least: warm pooled connections on clean datacenter networks — which is why internal gRPC hasn't moved.

---

## The Kernel Path — and When to Bypass It

A packet's arrival is a gauntlet: NIC DMA → interrupt → driver poll (NAPI) → IP/TCP processing in softirq → socket buffer → `epoll` wakeup → `read()` copy into userspace. Each stage has a budget, and knowing them tells you which optimizations are real:

- **Interrupt moderation and RSS.** NICs coalesce interrupts (latency vs CPU trade) and hash flows across CPU queues (RSS) so one core isn't the bottleneck. One elephant flow still lands on one core — per-core softirq saturation with idle siblings is the signature.
- **Syscalls cost ~1 μs** (more post-Spectre). At 1M packets/s, per-packet syscalls are the workload. Batching (`sendmmsg`), `epoll` (readiness for 100K sockets in one call — the C10K answer, and the engine inside every event loop from nginx to Node to Tokio), and `io_uring` (submit/complete rings shared with the kernel; batches syscalls away entirely) are escalating answers to the same tax.
- **Copies cost bandwidth.** `read()`+`write()` of a file to a socket crosses the user/kernel boundary twice for bytes the CPU never inspects; `sendfile()` keeps them in the kernel, and kTLS lets that hold even for TLS (Netflix serves its video this way). GSO/GRO batch segmentation to amortize per-packet stack costs.
- **conntrack is state you didn't order.** Kernel connection tracking (NAT, stateful firewalls, kube-proxy) is a hash table with a hard cap; at high connection rates it fills, and new connections fail node-wide with `nf_conntrack: table full` as the only clue. The [invisible-ceilings](./13-dns-and-connection-management.md) logic, one layer down.

Past roughly 1M packets/s/core of need, the stack itself is the cost, and the escape hatches are **XDP/eBPF** (run verified programs at the driver, before the stack — drop, rewrite, or redirect packets in ~100 ns; how Cloudflare drops DDoS floods and how Katran, Meta's L4 balancer, forwards at line rate on commodity servers) and **DPDK** (deliver the NIC to userspace and poll: maximum throughput, one core pinned at 100% forever, and you reimplement everything TCP gave you). The decision rule is honest self-classification: if your job is *requests* (parse, decide, respond), the kernel path is nowhere near your bottleneck — profile your application. If your job is *packets* (balance, filter, forward — per-unit work in nanoseconds), the stack is your bottleneck, and XDP is the modern default. This is exactly the [L4/L7 split](./01-load-balancing.md): L4 balancers are packet jobs and get built on XDP or kernel bypass; L7 proxies are request jobs and live happily on epoll.

---

## Failure Modes

**The MTU black hole.** A tunnel (VPN, VXLAN, IPsec) shrinks the path MTU below 1500; full-size packets need fragmentation, the router's ICMP "too big" signal is blocked by an overzealous firewall, and the sender never learns. Signature: **small requests succeed, large ones hang forever** — handshakes (small) work, payloads (full-MSS) vanish. Health checks stay green. Fixes: allow ICMP type 3/4, clamp MSS at the tunnel edge, or PLPMTUD. QUIC sidesteps the worst by never sending initial packets above 1200 bytes.

**The idle-timeout ambush.** A NAT or firewall silently drops an idle connection's state; neither endpoint learns until the next write times out — minutes later, deep in a request. TCP keepalives default to two hours (useless); databases, message-broker clients, and anything long-lived need application-level heartbeats or aggressive keepalive tuning. (QUIC's connection IDs and PINGs were designed for exactly this.) See also the [idle-timeout race](./13-dns-and-connection-management.md) among your *own* layers.

**Retransmission-timeout cliffs.** Most loss recovers in ~1 RTT via fast retransmit, but a lost *last packet* of a response (nothing after it to trigger duplicate ACKs) waits for the full RTO — 200 ms minimum on Linux. A bimodal p99.9 with a hard bump at ~200 ms is RTO, not your application. Tail-sensitive systems [hedge](./10-retries-timeouts-hedging.md) precisely because of this floor.

**Bufferbloat masquerading as capacity shortage.** Latency climbs under load, loss stays near zero, bandwidth graphs look "healthy and full." Adding bandwidth doesn't help because the queue refills. Diagnose with latency-under-load tests; fix with AQM/BBR/pacing, not provisioning.

**0-RTT replay.** A crafted 0-RTT `POST` is captured and replayed five times. If the endpoint isn't idempotent and the edge doesn't filter methods into 0-RTT, you've built a replay attack into your TLS config. Audit what your CDN and gateway actually allow.

**The H3→TCP silent downgrade.** A network change (UDP throttling, a new firewall) pushes your H3 traffic onto the TCP fallback. Nothing errors; mobile tail latency quietly regresses to H2-over-lossy-TCP behavior. Alert on protocol mix, not just error rate.

**Incast collapse.** Widening a scatter-gather from 50 to 200 shards tanks p99 despite every shard being fast: synchronized responses overflow the ToR buffer. The fix is architectural (cap fan-out, jitter, DCTCP/ECN) — no host tuning survives a full switch buffer.

---

## Decision Framework

| Situation | Reach for |
|---|---|
| Cross-region latency budget blown | Count round trips first: connection reuse, TLS 1.3 + resumption, 0-RTT (idempotent only), regional termination — before touching application code |
| High-RTT or lossy path throughput | BBR; verify socket buffers ≥ BDP; then question the path itself |
| Mobile / flaky last mile | HTTP/3 — stream independence + connection migration are built for exactly this |
| Internal RPC fleet | gRPC/H2 with `TCP_NODELAY`, mesh-managed pools; watch `MAX_CONCURRENT_STREAMS`; H3 is not urgent here |
| Public edge | H3 enabled with TCP fallback monitored; 0-RTT restricted to safe methods |
| Scatter-gather p99 cliffs intra-DC | Fan-out caps, response jitter, DCTCP/ECN — it's incast, not a slow server |
| Building an L4 balancer / DDoS filter / packet gateway | XDP/eBPF first, DPDK if you must own the NIC — packet job, not request job |
| Building basically anything else | The kernel stack, `epoll`/`io_uring`, and a profiler pointed at your own code |
| "Large requests hang, small ones fine" through a tunnel | MTU/PMTUD black hole: ICMP rules, MSS clamp |
| Long-lived idle connections dying mysteriously | Application heartbeats shorter than every middlebox timeout on the path |

---

## Key Takeaways

1. **RTT is the currency; protocols spend it.** Count round trips before bytes — a cold cross-region HTTPS request is ~4 RTTs of pure protocol, which is the entire case for connection reuse.
2. **Throughput is `window / RTT`, and loss multiplies with latency.** The Mathis ceiling means the same loss rate that's invisible intra-DC destroys cross-region throughput; BBR exists because loss was always a bad congestion signal.
3. **Head-of-line blocking migrates down the stack.** HTTP/2 fixed the application layer and inherited TCP's; QUIC fixed the transport. Know which layer yours is at before tuning.
4. **Full buffers are a failure mode, not a success metric.** Bufferbloat and incast are queueing pathologies — latency under load is the test that finds them; bandwidth graphs won't.
5. **Ossification is a design constraint.** TCP can no longer evolve in the open; QUIC encrypts its transport headers so it can. This is why the future of transport ships in userspace over UDP.
6. **0-RTT is a replay surface.** Idempotent requests only — enforced at the edge, audited, not assumed.
7. **Classify jobs as packets or requests.** Packet jobs (L4, DDoS, forwarding) justify XDP/DPDK; request jobs never do — the kernel path is not your bottleneck, your application is.

## References

- Ilya Grigorik — *High Performance Browser Networking* (free online) — the canonical latency/handshake/HTTP treatment
- RFC 9000 (QUIC), RFC 9114 (HTTP/3), RFC 8446 (TLS 1.3), RFC 6928 (IW10), RFC 2308 (negative caching, for ch. 13)
- Mathis et al. — *The Macroscopic Behavior of the TCP Congestion Avoidance Algorithm* (1997) — the √p ceiling
- Cardwell et al. — *BBR: Congestion-Based Congestion Control* (ACM Queue, 2016)
- Alizadeh et al. — *Data Center TCP (DCTCP)* (SIGCOMM 2010); Nichols & Jacobson — *Controlling Queue Delay* (CoDel, 2012)
- Langley et al. — *The QUIC Transport Protocol: Design and Internet-Scale Deployment* (SIGCOMM 2017) — Google's deployment numbers
- Eisenbud et al. — *Maglev: A Fast and Reliable Software Network Load Balancer* (NSDI 2016); Meta's Katran (github.com/facebookincubator/katran)
- Høiland-Jørgensen et al. — *The eXpress Data Path* (CoNEXT 2018)
- Cloudflare blog: *How to receive a million packets per second*; *The story of one latency spike* — kernel-path forensics worth imitating
