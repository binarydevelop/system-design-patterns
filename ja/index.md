---
layout: home

hero:
  name: "<span class='hero-title-line'>システム設計</span><span class='hero-title-line'>パターン</span>"
  text: "<span class='hero-subtitle-line'>分散設計</span><span class='hero-subtitle-line'>リファレンス</span>"
  tagline: 116記事・18セクション。
  image:
    src: /logo.svg
    alt: システムトポロジーマーク
  actions:
    - theme: brand
      text: 基礎から始める
      link: /ja/01-foundations/01-acid-transactions
    - theme: alt
      text: ケーススタディ
      link: /ja/08-case-studies/01-twitter
    - theme: alt
      text: GitHubで見る
      link: https://github.com/babushkai/system-design-patterns

features:
  - icon:
      src: /icons/foundations.svg
    title: 基礎
    details: トランザクション、整合性、分断、時間、障害モード、冪等性。
    link: /ja/01-foundations/01-acid-transactions
  - icon:
      src: /icons/database.svg
    title: 分散データベース
    details: レプリケーション、シャーディング、合意、インデックス、選挙、分散トランザクション。
    link: /ja/02-distributed-databases/01-single-leader-replication
  - icon:
      src: /icons/storage.svg
    title: ストレージエンジン
    details: B木、LSM木、SSTable、WAL、Bloom Filter、エンコーディング、列指向ストレージ。
    link: /ja/03-storage-engines/01-b-trees
  - icon:
      src: /icons/caching.svg
    title: キャッシュ
    details: 戦略、無効化、分散キャッシュ、スタンピード、ウォーミング、多層キャッシュ。
    link: /ja/04-caching/01-cache-strategies
  - icon:
      src: /icons/messaging.svg
    title: メッセージング
    details: キュー、Pub/Sub、順序、配信保証、イベントソーシング、CQRS、Outbox。
    link: /ja/05-messaging/01-message-queues
  - icon:
      src: /icons/scaling.svg
    title: スケーリング
    details: ロードバランシング、シャーディング、CDN、レート制限、サーキットブレーカー、バックプレッシャー。
    link: /ja/06-scaling/01-load-balancing
  - icon:
      src: /icons/realtime.svg
    title: リアルタイムシステム
    details: ポーリング、Long Polling、SSE、WebSocket、WebRTC、プレゼンス。
    link: /ja/07-real-time/01-polling
  - icon:
      src: /icons/casestudies.svg
    title: ケーススタディ
    details: Twitter、Instagram、Uber、Netflix、Slack、Stripeなどの実運用アーキテクチャ。
    link: /ja/08-case-studies/01-twitter
  - icon:
      src: /icons/whitepapers.svg
    title: ホワイトペーパー
    details: MapReduce、Dynamo、Bigtable、Spanner、TAO、Kafka、Raft、Chubby、Aurora。
    link: /ja/09-whitepapers/01-mapreduce
  - icon:
      src: /icons/security.svg
    title: セキュリティ
    details: 認証、OAuth2、JWT、APIセキュリティ、ゼロトラスト、暗号化。
    link: /ja/10-security/01-authentication-fundamentals
  - icon:
      src: /icons/observability.svg
    title: オブザーバビリティ
    details: トレーシング、メトリクス、監視、ロギング、アラート、運用フィードバック。
    link: /ja/11-observability/01-distributed-tracing
  - icon:
      src: /icons/servicemesh.svg
    title: サービスメッシュ
    details: サービスディスカバリ、APIゲートウェイ、サイドカー、実行時トラフィック制御。
    link: /ja/12-service-mesh/01-service-discovery
  - icon:
      src: /icons/datapipelines.svg
    title: データパイプライン
    details: バッチ処理、ストリーム処理、Lambda/Kappaアーキテクチャ。
    link: /ja/13-data-pipelines/01-batch-processing
  - icon:
      src: /icons/search.svg
    title: 検索システム
    details: 転置インデックス、全文検索、ベクトル検索、ランキング、関連性チューニング、タイプアヘッド。
    link: /ja/14-search-systems/01-inverted-indexes
  - icon:
      src: /icons/deployment.svg
    title: デプロイメント
    details: デプロイメント戦略、段階的リリース、ロールバック、フィーチャーフラグ。
    link: /ja/15-deployment/01-deployment-strategies
  - icon:
      src: /icons/llm.svg
    title: LLMシステム
    details: エージェント、オーケストレーション、マルチエージェント、RAG、プロンプト、コンテキスト管理。
    link: /ja/16-llm-systems/01-agent-fundamentals
  - icon:
      src: /icons/graphql.svg
    title: GraphQL
    details: 基礎、スキーマ設計、リゾルバー、キャッシュ、サブスクリプション、フェデレーション。
    link: /ja/17-graphql/01-graphql-fundamentals
  - icon:
      src: /icons/compound.svg
    title: コンパウンドエンジニアリング
    details: AIネイティブアーキテクチャ、コーディングエージェント、ツール設計、コンテキスト、開発ワークフロー。
    link: /ja/18-compound-engineering/01-compound-engineering-fundamentals
---

<div class="home-overview" aria-label="リポジトリ概要">
  <a class="home-stat" href="/ja/01-foundations/01-acid-transactions">
    <span class="home-stat-num">18</span>
    <span class="home-stat-label">セクション</span>
  </a>
  <a class="home-stat" href="/ja/01-foundations/01-acid-transactions">
    <span class="home-stat-num">116</span>
    <span class="home-stat-label">記事</span>
  </a>
  <a class="home-stat" href="/ja/08-case-studies/01-twitter">
    <span class="home-stat-num">10</span>
    <span class="home-stat-label">ケーススタディ</span>
  </a>
  <a class="home-stat" href="/ja/09-whitepapers/01-mapreduce">
    <span class="home-stat-num">10</span>
    <span class="home-stat-label">ホワイトペーパー</span>
  </a>
</div>

<div class="home-paths" aria-label="学習パス">
  <a class="home-path" href="/ja/01-foundations/01-acid-transactions">
    <span>Start here</span>
    <strong>基礎とトレードオフ</strong>
    <small>整合性、障害、時間、分散保証を考えるための語彙を固めます。</small>
  </a>
  <a class="home-path" href="/ja/05-messaging/01-message-queues">
    <span>Build systems</span>
    <strong>メッセージング、キャッシュ、スケーリング</strong>
    <small>概念から、本番サービスを形づくる設計パターンへ進みます。</small>
  </a>
  <a class="home-path" href="/ja/08-case-studies/01-twitter">
    <span>Study production</span>
    <strong>実運用アーキテクチャ</strong>
    <small>具体的なシステムと、その設計判断を生んだ制約を比較します。</small>
  </a>
</div>

<p class="home-about">このリポジトリは、システム設計を単発の知識ではなく、実務で参照できるエンジニアリングリファレンスとして整理します。各セクションは、問題、制約、解決策、運用後に現れるトレードオフに焦点を当てます。</p>

<style>
.home-overview {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 1px;
  max-width: 920px;
  margin: 1.5rem auto 2.25rem;
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  overflow: hidden;
  background: var(--vp-c-divider);
}

.home-stat {
  display: block;
  padding: 1.1rem 1rem;
  text-align: center;
  background: var(--vp-c-bg);
  text-decoration: none;
}

.home-stat:hover {
  background: var(--vp-c-bg-soft);
}

.home-stat-num {
  display: block;
  font-size: 2rem;
  font-weight: 700;
  color: var(--vp-c-brand-1);
  line-height: 1;
}

.home-stat-label {
  display: block;
  margin-top: 0.25rem;
  font-size: 0.875rem;
  color: var(--vp-c-text-2);
}

.home-paths {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 1rem;
  max-width: 920px;
  margin: 0 auto 2rem;
}

.home-path {
  min-height: 150px;
  padding: 1rem;
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  background: var(--vp-c-bg);
  color: inherit;
  text-decoration: none;
}

.home-path:hover {
  border-color: var(--vp-c-brand-1);
  background: var(--vp-c-bg-soft);
}

.home-path span {
  display: block;
  color: var(--vp-c-brand-2);
  font-size: 0.75rem;
  font-weight: 700;
  text-transform: uppercase;
}

.home-path strong {
  display: block;
  margin-top: 0.65rem;
  color: var(--vp-c-text-1);
  font-size: 1rem;
}

.home-path small {
  display: block;
  margin-top: 0.5rem;
  color: var(--vp-c-text-2);
  font-size: 0.875rem;
  line-height: 1.55;
}

.home-about {
  max-width: 760px;
  margin: 0 auto 2.25rem;
  padding: 0 1.5rem;
  text-align: center;
  line-height: 1.75;
  color: var(--vp-c-text-2);
}

@media (max-width: 900px) {
  .home-overview {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .home-paths {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 640px) {
  .home-overview,
  .home-paths {
    margin-left: 1rem;
    margin-right: 1rem;
  }

  .home-stat-num {
    font-size: 1.55rem;
  }
}
</style>
