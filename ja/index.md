---
layout: home

hero:
  name: "Babushkai"
  text: "システム設計パターン"
  tagline: 18セクション · 118記事 · Netflix、Uber、Stripe、Discordで使用されるパターン
  image:
    src: /logo.svg
    alt: Babushkai
  actions:
    - theme: brand
      text: はじめる
      link: /ja/01-foundations/01-acid-transactions
    - theme: alt
      text: GitHubで見る
      link: https://github.com/babushkai/system-design-patterns

features:
  - title: 基礎
    details: ACIDトランザクション、CAP定理、整合性モデル、分散時間
    link: /ja/01-foundations/01-acid-transactions
  - title: 分散データベース
    details: レプリケーション、パーティショニング、合意アルゴリズム
    link: /02-distributed-databases/01-single-leader-replication
  - title: ストレージエンジン
    details: B木、LSM木、SSTable、先行書き込みログ
    link: /03-storage-engines/01-b-trees
  - title: キャッシュ
    details: キャッシュ戦略、キャッシュ無効化、分散キャッシュ
    link: /04-caching/01-cache-strategies
  - title: メッセージング
    details: メッセージキュー、Pub/Sub、イベントソーシング、CQRS
    link: /05-messaging/01-message-queues
  - title: スケーリング
    details: ロードバランシング、シャーディング、サーキットブレーカー
    link: /06-scaling/01-load-balancing
  - title: リアルタイムシステム
    details: ポーリング、WebSocket、WebRTC、プレゼンスシステム
    link: /07-real-time/01-polling
  - title: ケーススタディ
    details: Twitter、Instagram、Uber、Netflix、Slack、Stripe
    link: /08-case-studies/01-twitter-timeline
  - title: ホワイトペーパー
    details: MapReduce、Dynamo、BigTable、Spanner、Raft
    link: /09-whitepapers/01-mapreduce
  - title: セキュリティ
    details: 認証、OAuth 2.0、JWT、ゼロトラストアーキテクチャ
    link: /10-security/01-authentication-fundamentals
  - title: オブザーバビリティ
    details: 分散トレーシング、メトリクス、ロギング、アラート
    link: /11-observability/01-distributed-tracing
  - title: サービスメッシュ
    details: サービスディスカバリ、APIゲートウェイ、サイドカーパターン
    link: /12-service-mesh/01-service-discovery
  - title: データパイプライン
    details: バッチ処理、ストリーム処理、Lambdaアーキテクチャ
    link: /13-data-pipelines/01-batch-processing
  - title: 検索システム
    details: 転置インデックス、全文検索、ベクトル検索
    link: /14-search-systems/01-inverted-indexes
  - title: デプロイメント
    details: デプロイメント戦略、フィーチャーフラグ
    link: /15-deployment/01-deployment-strategies
  - title: LLMシステム
    details: エージェント基礎、オーケストレーション、RAGパターン
    link: /16-llm-systems/01-agent-fundamentals
  - title: GraphQL
    details: 基礎、スキーマ設計、リゾルバー、フェデレーション
    link: /17-graphql/01-graphql-fundamentals
  - title: コンパウンドエンジニアリング
    details: AI駆動開発、コーディングエージェント、コンテキストエンジニアリング
    link: /18-compound-engineering/01-compound-engineering-fundamentals
---

<div class="home-stats-bar">
  <div class="stat-item">
    <span class="stat-number">18</span>
    <span class="stat-label">セクション</span>
  </div>
  <div class="stat-item">
    <span class="stat-number">118</span>
    <span class="stat-label">記事</span>
  </div>
  <div class="stat-item">
    <span class="stat-number">10</span>
    <span class="stat-label">ケーススタディ</span>
  </div>
  <div class="stat-item">
    <span class="stat-number">10</span>
    <span class="stat-label">ホワイトペーパー</span>
  </div>
</div>

<p class="home-about">マトリョーシカ人形のように、優れたシステムは層を重ねて構築されます。各層が内側の複雑さを隠しながら、全体として堅牢で美しいアーキテクチャを形成します。このリポジトリは、Netflix、Uber、Stripe、Discordなどの実際のシステムで使用されている設計パターンを、第一原理から深く掘り下げて解説します。</p>

<style>
.home-stats-bar {
  display: flex;
  justify-content: center;
  gap: 3rem;
  padding: 2rem 1rem;
  margin: 2rem auto;
  max-width: 720px;
  border-radius: 12px;
  background: var(--vp-c-bg-soft);
}

.stat-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.25rem;
}

.stat-number {
  font-size: 2rem;
  font-weight: 700;
  color: var(--vp-c-brand-1);
}

.stat-label {
  font-size: 0.875rem;
  color: var(--vp-c-text-2);
}

.home-about {
  max-width: 720px;
  margin: 0 auto 3rem;
  padding: 0 1.5rem;
  text-align: center;
  font-size: 1.05rem;
  line-height: 1.75;
  color: var(--vp-c-text-2);
}

@media (max-width: 640px) {
  .home-stats-bar {
    gap: 1.5rem;
    padding: 1.5rem 0.75rem;
  }

  .stat-number {
    font-size: 1.5rem;
  }
}
</style>
