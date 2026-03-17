# ネットワーク分断

> **翻訳についての注記:** 本ドキュメントは英語原文 `01-foundations/07-network-partitions.md` を日本語に翻訳したものです。コードブロックおよびMermaidダイアグラムは原文のまま維持しています。

## TL;DR

ネットワーク分断は、分散システム内のノードが互いに通信できなくなったときに発生します。分断は十分に大規模なシステムでは不可避です。分断が発生した場合、一貫性（操作を拒否する）と可用性（操作を受け入れ、後でコンフリクトを解決する）のどちらかを選択する必要があります。分断を検出し、耐え、回復するシステムを設計してください。

---

## ネットワーク分断とは

### 定義

ネットワーク分断は、ノードをグループに分割し、グループ内では通信可能ですが、他のグループとは通信できない状態にします。

```
Before partition:
  ┌───────────────────────────────────┐
  │                                   │
  │   A ←──→ B ←──→ C ←──→ D ←──→ E   │
  │                                   │
  └───────────────────────────────────┘

After partition:
  ┌─────────────┐     ┌─────────────┐
  │             │  X  │             │
  │   A ←──→ B  │     │  C ←──→ D ←──→ E  │
  │             │     │             │
  └─────────────┘     └─────────────┘
    Partition 1         Partition 2
```

### 分断の種類

**完全分断：**
グループ間の通信が一切不可能です。

**部分分断：**
一部の経路は機能しますが、他の経路は機能しません。

```
A ←──→ B ←──→ C
│             │
└──────X──────┘
      ↑
A can reach B, B can reach C
A cannot reach C directly
Asymmetric paths possible
```

**非対称分断：**
AはBに送信できますが、BはAに送信できません。

```
A ───────→ B  ✓
A ←─────── B  ✗
```

### 分断の原因

| 原因 | 期間 | 影響範囲 |
|-----|------|---------|
| ネットワークスイッチの障害 | 数分〜数時間 | ラック/データセンター |
| ルーターの設定ミス | 数分 | 可変 |
| BGPの問題 | 数分〜数時間 | データセンター間 |
| 光ファイバーの切断 | 数時間 | リージョン間 |
| データセンターの電源障害 | 数時間 | 単一データセンター |
| クラウドプロバイダーの障害 | 数時間 | リージョン/ゾーン |
| ファイアウォールルールの変更 | 数秒〜数時間 | 可変 |
| DDoS攻撃 | 数時間 | 対象サービス |
| DNS障害 | 数分〜数時間 | 可変 |
| GCポーズ（見かけ上の分断） | 数秒 | 単一ノード |

---

## 分断の頻度

### 実世界のデータ

分断は稀ではありません。

- **Google:** クラスタあたり年間約5回の分断
- **大規模システム:** 毎日複数の部分分断
- **データセンター間:** データセンター内よりも頻繁

### 分断が不可避である理由

```
P(no partition) = P(all components work)
                = P(switch1) × P(switch2) × ... × P(cable_n)

With many components, P(no partition) → low
```

**ノードが多い = 障害点が多い = 分断が多い**

---

## 分断中の動作

### CAPの選択

分断中に選択します。

**可用性（AP）：**
```
Client → [Partition 1] → Response (possibly stale)
Client → [Partition 2] → Response (possibly stale)

Both partitions serve requests
Data may diverge
```

**一貫性（CP）：**
```
Client → [Minority partition] → Error (unavailable)
Client → [Majority partition] → Response (consistent)

Only majority partition serves requests
```

### マイノリティ vs マジョリティ

**マジョリティパーティション**はノードの半数以上を含みます。
- クォーラムを形成できます
- リーダーを選出できます
- 処理を継続できます

**マイノリティパーティション：**
- クォーラムを形成できません
- 自身がマイノリティであることを認識しています（十分なノードに到達できない）
- 書き込みを停止するか（CP）、注意付きで受け入れるか（AP）

```
5-node cluster, partition splits 3/2:

Partition A (3 nodes):
  - Has majority
  - Can elect leader
  - Continues normal operation

Partition B (2 nodes):
  - Minority
  - CP: Reject writes, serve stale reads
  - AP: Accept writes, merge later
```

---

## 分断の検出

### タイムアウトベース

```
if time_since_last_message(node) > timeout:
  suspect_partition(node)

Problem: Can't distinguish:
  - Node crashed
  - Node slow
  - Network partition
  - Our network is the problem
```

### マジョリティチェック付きハートビート

```
func check_cluster_health():
  reachable = 0
  for node in cluster:
    if ping(node, timeout=1s):
      reachable++

  if reachable < majority_threshold:
    // We might be in minority partition
    enter_degraded_mode()
```

### 外部オブザーバー

```
                    ┌────────────┐
                    │  Observer  │
                    │  (outside  │
                    │  cluster)  │
                    └─────┬──────┘
                          │
              ┌───────────┼───────────┐
              │           │           │
              ▼           ▼           ▼
           [Node A]    [Node B]    [Node C]

Observer can detect:
- Which nodes are reachable
- Potential partition topology
- Who is in minority
```

---

## 分断への対処

### 戦略1：マイノリティの停止

マイノリティパーティションが書き込みの受け入れを停止します。

```
Leader election requires majority:
  if cannot_reach(majority):
    step_down()
    reject_writes()
    serve_stale_reads() or reject_all()
```

**メリット：** データの乖離がない、強い一貫性
**デメリット：** マイノリティが利用不可

### 戦略2：コンフリクト解決による継続

両方のパーティションが書き込みを受け入れ、回復時に解決します。

```
Partition 1: write(x, "A")
Partition 2: write(x, "B")

After heal:
  Conflict: x = "A" or x = "B"?
  Resolution: LWW, merge, or app-specific
```

**メリット：** 常に利用可能
**デメリット：** コンフリクト、複雑性

### 戦略3：ヒンテッドハンドオフ

到達不能なノード向けの操作を保存します。

```
Node A wants to write to Node C (unreachable):
  1. Write to A's hint log for C
  2. When C becomes reachable, replay hints

Hint: {target: C, operation: write(x, 1), timestamp: T}
```

**メリット：** 最終的な配信
**デメリット：** ヒントが蓄積する可能性、順序の問題

---

## スプリットブレインの防止

### フェンシングトークン

単調増加するトークンにより、古いリーダーを防止します。

```
Leader v1: token = 100
  → [partition] →

New leader v2: token = 101

Old leader v1 (stale):
  write(data, token=100)
  → Storage: "Reject: token 100 < current 101"

Storage validates tokens, rejects old leaders
```

### STONITH（Shoot The Other Node In The Head）

競合するノードを強制的に終了させます。

```
Node A detects Node B unresponsive:
  1. Assume B might still be running
  2. Physically power off B (IPMI, cloud API)
  3. Wait for B to be definitely dead
  4. Take over B's resources

Prevents both nodes from acting as primary
```

### 外部アービターを用いたクォーラム

外部サービスを使用してタイブレークを行います。

```
Cluster of 2 nodes (can't have majority):
  Add external arbiter (ZooKeeper, etcd, cloud metadata)

Election:
  if can_reach(peer) and can_reach(arbiter):
    elect_leader()
  elif can_reach(arbiter) but not peer:
    arbiter decides who becomes leader
```

---

## 分断耐性のある設計パターン

### リードリペア

読み取り時に不整合を修正します。

```
Read from replicas A, B, C:
  A returns: x=1, version=5
  B returns: x=1, version=5
  C returns: x=1, version=3  ← stale

After returning x=1 to client:
  Background: update C with version=5
```

### アンチエントロピー

バックグラウンドプロセスがレプリカを同期させます。

```
Periodically:
  for each pair of replicas (A, B):
    diff = compare_merkle_trees(A, B)
    for each differing key:
      sync_latest_version(A, B, key)
```

### マークルツリー

大規模データセットの効率的な比較を可能にします。

```
         [root hash]
         /          \
    [hash L]      [hash R]
    /      \      /      \
 [h1]   [h2]   [h3]   [h4]
  |      |      |      |
 k1     k2     k3     k4

Compare roots:
  Same → data identical
  Different → descend to find differences

O(log n) to find differences
```

### CRDT（コンフリクトフリー複製データ型）

自動的にマージされるデータ構造です。

```
G-Counter (grow-only counter):
  Each node maintains its own count
  Merge = take max per node
  Total = sum all nodes

  Node A: {A:5, B:3}
  Node B: {A:4, B:7}  (B's A count is stale)

  Merge: {A:5, B:7}
  Total: 12
```

---

## 分断の例

### 例1：データベースレプリケーション

```
Primary in DC1, replicas in DC1 and DC2

DC1 ←──[partition]──→ DC2

Synchronous replication:
  DC1: "Cannot ack writes, DC2 unreachable"
  Result: Writes blocked, consistency maintained

Asynchronous replication:
  DC1: Accept writes, queue for DC2
  DC2: Serve stale reads
  Result: Available but inconsistent
```

### 例2：リーダー選出

```
5-node Raft cluster: [A, B, C, D, E]
Leader: A
Partition: [A, B] | [C, D, E]

Minority [A, B]:
  A: Cannot reach majority, steps down
  No leader, no writes

Majority [C, D, E]:
  C, D, E hold election
  New leader elected (say, C)
  Continue serving writes
```

### 例3：ショッピングカート

```
User adds item in Region 1
User adds item in Region 2 (partition active)

Region 1 cart: [item_a, item_b]
Region 2 cart: [item_a, item_c]

On heal:
  Merge carts: [item_a, item_b, item_c]

  Using OR-Set CRDT:
    Add wins over concurrent remove
    Duplicates handled by unique IDs
```

---

## 分断のテスト

### ネットワークシミュレーション

```bash
# Linux tc (traffic control)
# Add 100% packet loss to specific host
tc qdisc add dev eth0 root netem loss 100%

# iptables - block specific traffic
iptables -A INPUT -s 10.0.0.5 -j DROP
iptables -A OUTPUT -d 10.0.0.5 -j DROP
```

### カオスエンジニアリングツール

| ツール | アプローチ |
|-------|----------|
| Jepsen | ブラックボックス分断テスト |
| Chaos Monkey | ランダムなインスタンス終了 |
| Toxiproxy | プログラマブルなネットワークプロキシ |
| tc + netem | Linuxカーネルのネットワークシミュレーション |
| Docker network disconnect | コンテナレベルの分離 |

### Jepsenテスト

```
1. Start cluster
2. Begin workload (reads, writes)
3. Inject partition (various topologies)
4. Continue workload
5. Heal partition
6. Verify consistency invariants

Common checks:
  - No lost acknowledged writes
  - Linearizable history
  - Read-your-writes maintained
```

---

## 分断からの復旧

### 回復プロセス

```
1. Detect partition healed
   - Nodes can communicate again
   - Heartbeats resume

2. Synchronize state
   - Anti-entropy runs
   - Hinted handoffs delivered
   - Merkle tree comparison

3. Resolve conflicts
   - LWW or vector clocks
   - CRDT merge
   - Application-level resolution

4. Resume normal operation
   - Leader re-established (if needed)
   - Quorums restored
```

### コンフリクト解決戦略

| 戦略 | 仕組み | トレードオフ |
|------|-------|------------|
| Last-Writer-Wins | より新しいタイムスタンプが勝つ | 書き込みが失われる可能性がある |
| First-Writer-Wins | より古いタイムスタンプが勝つ | 書き込みが失われる可能性がある |
| マルチバリュー | すべてのバージョンを保持する | アプリケーションが解決する必要がある |
| カスタムマージ | アプリケーション固有のロジック | 複雑性 |
| CRDT | 自動マージ | 対応データ型が限定的 |

### 分断後の検証

```
After heal:
  1. Compare checksums across replicas
  2. Run anti-entropy scan
  3. Verify no orphaned data
  4. Check referential integrity
  5. Alert on unresolved conflicts
```

---

## グレー障害

### 定義

グレー障害とは、完全にダウンしているわけでも完全に正常でもない部分的な障害のことです。システムは機能し続けますが、従来の二値ヘルスチェックでは検出が困難な劣化した動作を示します。

```
Failure spectrum:

  Fully healthy        Gray failure zone        Fully failed
      |                  |         |                  |
      ├──────────────────┤─────────┤──────────────────┤
   All requests      5% packet   One-way          No responses
   succeed quickly   loss, high  failure           at all
                     p99 latency
```

### 例

- **低率のパケットロス：** 2〜5%のパケットロスはヘルスチェックを通過します。TCPの再送信がそれを隠しますが、テールレイテンシがスパイクします。
- **片方向障害：** A→Bは通信可能、B→Aは通信不可。BはAが死んでいると思い、AはBが正常だと思います。クラスタメンバーシップの見解が食い違います。
- **間欠的な接続性：** リンクが数秒ごとにフラップします。タイムアウト検出には短すぎますが、全体的な可用性は低い状態です。

### グレー障害が完全障害より厄介な理由

| 特性 | 完全障害 | グレー障害 |
|-----|---------|----------|
| 検出時間 | 数秒 | 数分〜数時間 |
| 確信度 | 高（応答なし） | 低（一部の応答は成功） |
| フェイルオーバーの判断 | 明確（レプリカを昇格） | 曖昧（フェイルオーバーは時期尚早か） |
| 影響範囲 | 障害ノードに限定 | カスケード（遅いノードがキューを詰まらせる） |
| 復旧 | 再起動して再参加 | 根本原因が不明確、再発の可能性 |

Microsoft Research（2017年）の調査では、大規模クラウドシステムの最も深刻な障害のほとんどが、フェイルストップクラッシュではなくグレー障害に起因することが判明しました。二値のアップ/ダウン状態を前提としたシステムは、その間のスペクトラムを見逃します。

### 検出戦略

- **マルチパスプロービング：** 複数のオブザーバーから各ノードをプローブします。1つだけが障害を報告する場合、問題は経路固有の可能性があります。
- **アプリケーションレベルのヘルスチェック：** TCPの生存確認だけでは不十分です。エンドツーエンドのリクエスト処理を検証してください。
- **ピアツーピアの障害報告：** ノードがピアの健全性についてゴシップします。同じ劣化したピアに関する複数の報告は確信度を高めます（Cassandraで使用されています）。

```
GET /health      → 200 OK                     // shallow — misses gray failures
GET /health/deep → { "db_latency_ms": 2400,   // ← abnormally high
                     "cache_hit_rate": 0.12,   // ← abnormally low
                     "error_rate_1m": 0.04 }   // ← above threshold
```

---

## 実際の分断インシデント

### AWS US-East-1（2011年4月）

ルーチンのネットワーク変更により、EBSストレージノードが接続を失い、再ミラーリングストームが発生しました。カスケード的な再レプリケーションが利用可能な容量を消費しました。MySQLクラスタでは、プライマリとレプリカが接続を失った際にスプリットブレインが発生しました。復旧には12時間以上を要しました。Reddit、Foursquare、Quoraが完全にオフラインになりました。

### GitHub（2018年10月）

障害を起こした100Gネットワークリンクの交換により、米国東海岸のデータベースプライマリとそのレプリカの間で43秒間の接続断が発生しました。オーケストレーションツールが西海岸のレプリカをプライマリに昇格させました。接続が復旧した際、新旧のプライマリは乖離しており、24時間の劣化したサービスが続きました。自動化ツールでは双方向レプリケーションのコンフリクトを解決できませんでした。

### Cloudflare（2020年7月）

バックボーンプロバイダーのBGP設定ミスにより、Cloudflareのルートがインターネットの一部から撤回されました。27分間、影響を受けたネットワークからのトラフィックはCloudflareのエッジサーバーに到達できませんでした。障害は外部的なものでした。Cloudflareのノードは内部的には正常でしたが、ユーザーとエッジ間の分断はネットワーク分断と機能的に同一でした。

### Google Cloud（2019年6月）

設定変更によりバックボーンリンクの利用可能な帯域幅が減少し、複数のGCPリージョンでパケットロスが発生しました。カスケード効果がCompute Engine、Cloud Storage、BigQueryに約4時間にわたって影響を与えました。帯域幅レベルのグレー障害がサービス境界を越えてどのように伝播するかを示す事例です。

### 教訓

| インシデント | 根本原因 | 予防策 |
|------------|---------|-------|
| AWS 2011 | 再ミラーリングストーム | リカバリのレート制限、容量の確保 |
| GitHub 2018 | タイムアウトベースの昇格 | クォーラムベースの昇格 |
| Cloudflare 2020 | 外部BGPの撤回 | マルチプロバイダーBGP、エニーキャスト |
| Google 2019 | 帯域幅の設定変更 | ネットワーク変更のカナリアリリース |

**共通テーマ：** すべてのインシデントは、予期しない分断を引き起こしたルーチン操作が関係していました。障害を引き起こしたのは分断そのものではなく、分断に対するシステムの反応でした。

---

## 高度な分断耐性パターン

### 分断認識型サーキットブレーカー

タイムアウト（分断の可能性）と明示的なエラー（確定的な障害）を区別します。それぞれに異なるフォールバック戦略を適用します。

```
func call_remote_service(request):
  try:
    response = send(request, timeout=2s)
    breaker.record_success()
    return response
  catch TimeoutError:
    breaker.record_timeout()
    if breaker.timeout_rate > 0.5:
      return serve_from_cache(request)  // partition — use cached data
  catch ConnectionRefused:
    breaker.record_error()
    if breaker.error_rate > 0.5:
      return error("Service unavailable")  // definite failure — fail fast
```

タイムアウトはリモート側がまだ処理中の可能性を意味します。リトライは重複のリスクがあります。明示的なエラーは拒否を意味します。冪等であればリトライは安全です（`08-idempotency.md` を参照）。

### クランブリングウォール

非クリティカルな機能を段階的に削減し、コアとなるユーザージャーニーを維持します。

```
if partition_detected():
  disable(priority_3)  // A/B tests, personalization, ads
  if sustained_partition(duration > 5m):
    disable(priority_2)  // Recommendations, reviews, analytics
  serve_priority_1_with_local_data()  // Checkout, auth, order status
```

削減の順序はインシデント中ではなく、分断が発生する前に定義してください。

### 分断中のセッションアフィニティ

ユーザーをセッション中に分断の同じ側に固定し続けます。これにより、最悪のユーザー体験であるown writeの消失を回避します。

```
User on Partition A: reads/writes A → consistent view
User rerouted to B mid-session:     → cart items vanish, order reverts

Solution: sticky sessions via session ID hash during detected partition
```

### コンフリクトフリーな操作

コンフリクト解決なしで両側で安全な書き込みを設計します。

- **可換性：** `set(counter, 15)` ではなく `increment(counter, 5)` — 合計により結合
- **冪等性：** `set_if_absent(key, value)` — 2回適用しても安全
- **追記専用：** `add_to_set(cart, item_id)` — 和集合はコンフリクトフリー

### 分断復旧プロトコル

マージ戦略は分断が発生する前に定義してください。分断中では手遅れです。

```
Pre-partition contract:
  1. Each partition logs mutations with vector clock timestamps
  2. On heal, compare mutation logs from both sides
  3. Apply merge per data type:
     Counters → sum deltas | Sets → union | Registers → LWW
  4. Verify merged state against invariants
  5. If invariants violated → flag for manual resolution
```

---

## 体系的な分断テスト

### カオスエンジニアリングツール

**Toxiproxy** — アプリケーションとその依存先の間に配置するTCPプロキシで、プログラマブルな障害注入を行います。

```bash
# Create proxy for database connection
toxiproxy-cli create pg --listen 0.0.0.0:15432 --upstream db-primary:5432

# Gray failure: 5s latency with jitter
toxiproxy-cli toxic add pg --type latency --attribute latency=5000 --attribute jitter=1000

# Total partition: drop all traffic
toxiproxy-cli toxic add pg --type timeout --attribute timeout=0
```

**iptables** — カーネルレベルの非対称分断シミュレーションです。

```bash
iptables -A INPUT -s 10.0.1.0/24 -j DROP  # block incoming only → one-way partition
```

### Jepsenによる分断検証

Jepsenは分散システムの分断テストを自動化します（CAPのコンテキストについては `03-cap-theorem.md` を参照）。並行ワークロードを生成し、障害を注入し、形式的なモデルに対して一貫性を検証します。

主な発見：多くの「CP」データベースは分断中に確認済みの書き込みを失い、多くの「AP」データベースは回復後に収束しません。クロックスキューと分断の組み合わせが最悪のバグを生み出します。

### ゲームデイ

制御された環境でインシデント対応を練習するための計画的な分断シミュレーション演習です。

```
Game day: announce window → inject partition → observe alerting
  → respond per runbook → verify data consistency → retro on gaps
```

NetflixがChaos Monkey（インスタンスの終了）とChaos Kong（リージョンの退避）で先駆けとなりました。目的は、システムが正しく壊れるかどうかを発見することです。

### 検証チェックリスト

| チェック項目 | 方法 |
|------------|------|
| 確認済み書き込みの損失がないこと | 書き込みログと最終状態を比較 |
| 重複処理がないこと | 冪等性キーの検証、副作用のカウント |
| 正しいフェイルオーバー/フェイルバック | プライマリの昇格とレプリカの再参加を確認 |
| データの一貫性 | レプリカ間のチェックサム比較 |
| 参照整合性 | 外部キー/エンティティ間のバリデーション |

---

## 重要なポイント

1. **分断は不可避である** - 分断を回避するのではなく、分断に備えて設計してください
2. **選択が必要である** - 分断中は可用性か一貫性のどちらかを選ぶ必要があります
3. **マジョリティは処理を継続できる** - マイノリティは慎重に行動すべきです
4. **スプリットブレインは危険である** - フェンシング、クォーラム、またはアービターを使用してください
5. **検出は不完全である** - タイムアウトベースであり、誤検知の可能性があります
6. **回復を計画する** - アンチエントロピー、コンフリクト解決、検証
7. **分断をテストする** - カオスエンジニアリング、Jepsenテスト
8. **CRDTが有効である** - 適切なデータ型に対する自動マージ
