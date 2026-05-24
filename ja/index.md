---
layout: page
aside: false
sidebar: false
title: システム設計パターン
---

<main class="sdp-shell">
  <section class="sdp-cover" aria-labelledby="sdp-title">
    <div class="sdp-cover-main">
      <p class="sdp-kicker">分散システムリファレンス</p>
      <h1 id="sdp-title">設計判断、障害モード、本番運用のトレードオフ。</h1>
      <p class="sdp-lede">システムアーキテクチャを設計し、レビューするための高密度なフィールドガイドです。保証から始め、ストレージとメッセージングをたどり、実運用システムと論文で判断を比較します。</p>
      <div class="sdp-cover-actions" aria-label="主要な導線">
        <a class="sdp-primary" href="/system-design-patterns/ja/01-foundations/01-acid-transactions">ガイドを始める</a>
        <a href="/system-design-patterns/ja/08-case-studies/01-twitter">ケーススタディ</a>
        <a href="https://github.com/babushkai/system-design-patterns/releases/latest" target="_blank">PDF / EPUB</a>
      </div>
    </div>
    <aside class="sdp-system-board" aria-label="システムマップ">
      <div class="sdp-board-header">
        <span>System map</span>
        <strong>18セクション</strong>
      </div>
      <div class="sdp-node-grid">
        <a class="sdp-node is-core" href="/system-design-patterns/ja/01-foundations/01-acid-transactions">基礎</a>
        <a class="sdp-node is-data" href="/system-design-patterns/ja/02-distributed-databases/01-single-leader-replication">レプリケーション</a>
        <a class="sdp-node is-data" href="/system-design-patterns/ja/03-storage-engines/01-b-trees">ストレージ</a>
        <a class="sdp-node is-runtime" href="/system-design-patterns/ja/04-caching/01-cache-strategies">キャッシュ</a>
        <a class="sdp-node is-runtime" href="/system-design-patterns/ja/05-messaging/01-message-queues">メッセージング</a>
        <a class="sdp-node is-runtime" href="/system-design-patterns/ja/06-scaling/01-load-balancing">スケーリング</a>
        <a class="sdp-node is-edge" href="/system-design-patterns/ja/07-real-time/01-polling">リアルタイム</a>
        <a class="sdp-node is-edge" href="/system-design-patterns/ja/10-security/01-authentication-fundamentals">セキュリティ</a>
        <a class="sdp-node is-edge" href="/system-design-patterns/ja/11-observability/01-distributed-tracing">運用</a>
      </div>
      <div class="sdp-board-footer">
        <span>116記事</span>
        <span>10ケーススタディ</span>
        <span>10論文</span>
      </div>
    </aside>
  </section>

  <section class="sdp-lanes" aria-label="学習レーン">
    <a href="/system-design-patterns/ja/01-foundations/01-acid-transactions">
      <span>01</span>
      <strong>保証から考える</strong>
      <small>ACID、CAP、整合性、クロック、分断、冪等性。</small>
    </a>
    <a href="/system-design-patterns/ja/04-caching/01-cache-strategies">
      <span>02</span>
      <strong>データ経路を選ぶ</strong>
      <small>ストレージエンジン、キャッシュ、キュー、ストリーム、インデックス、検索。</small>
    </a>
    <a href="/system-design-patterns/ja/06-scaling/01-load-balancing">
      <span>03</span>
      <strong>負荷の中で運用する</strong>
      <small>スケーリング、リアルタイム配信、セキュリティ、オブザーバビリティ、デプロイ。</small>
    </a>
    <a href="/system-design-patterns/ja/08-case-studies/01-twitter">
      <span>04</span>
      <strong>本番システムで比較する</strong>
      <small>ケーススタディ、ホワイトペーパー、LLMシステムの現代的な設計パターン。</small>
    </a>
  </section>

  <section class="sdp-section-matrix" aria-labelledby="sdp-matrix-title">
    <div class="sdp-section-heading">
      <p class="sdp-kicker">判断領域で探す</p>
      <h2 id="sdp-matrix-title">Architecture map</h2>
    </div>
    <div class="sdp-matrix">
      <a href="/system-design-patterns/ja/01-foundations/01-acid-transactions"><span>01</span><strong>基礎</strong><small>トランザクション、整合性、時間、障害、分断</small></a>
      <a href="/system-design-patterns/ja/02-distributed-databases/01-single-leader-replication"><span>02</span><strong>分散データベース</strong><small>レプリケーション、シャーディング、インデックス、合意</small></a>
      <a href="/system-design-patterns/ja/03-storage-engines/01-b-trees"><span>03</span><strong>ストレージエンジン</strong><small>B木、LSM、WAL、エンコーディング、Bloom Filter</small></a>
      <a href="/system-design-patterns/ja/04-caching/01-cache-strategies"><span>04</span><strong>キャッシュ</strong><small>無効化、スタンピード、ウォーミング、多層キャッシュ</small></a>
      <a href="/system-design-patterns/ja/05-messaging/01-message-queues"><span>05</span><strong>メッセージング</strong><small>キュー、Pub/Sub、順序、Outbox、DLQ</small></a>
      <a href="/system-design-patterns/ja/06-scaling/01-load-balancing"><span>06</span><strong>スケーリング</strong><small>ロードバランシング、レート制限、サーキットブレーカー、バックプレッシャー</small></a>
      <a href="/system-design-patterns/ja/07-real-time/01-polling"><span>07</span><strong>リアルタイム</strong><small>Polling、SSE、WebSocket、WebRTC、プレゼンス</small></a>
      <a href="/system-design-patterns/ja/08-case-studies/01-twitter"><span>08</span><strong>ケーススタディ</strong><small>Twitter、Uber、Netflix、Slack、Stripe、Discord</small></a>
      <a href="/system-design-patterns/ja/09-whitepapers/01-mapreduce"><span>09</span><strong>ホワイトペーパー</strong><small>MapReduce、Dynamo、Spanner、Raft、Kafka</small></a>
      <a href="/system-design-patterns/ja/10-security/01-authentication-fundamentals"><span>10</span><strong>セキュリティ</strong><small>認証、OAuth2、JWT、APIセキュリティ、ゼロトラスト</small></a>
      <a href="/system-design-patterns/ja/11-observability/01-distributed-tracing"><span>11</span><strong>オブザーバビリティ</strong><small>トレーシング、メトリクス、ログ、アラート、運用</small></a>
      <a href="/system-design-patterns/ja/12-service-mesh/01-service-discovery"><span>12</span><strong>サービスメッシュ</strong><small>ディスカバリ、ゲートウェイ、サイドカー、トラフィック制御</small></a>
      <a href="/system-design-patterns/ja/13-data-pipelines/01-batch-processing"><span>13</span><strong>データパイプライン</strong><small>バッチ、ストリーム、Lambda、Kappa</small></a>
      <a href="/system-design-patterns/ja/14-search-systems/01-inverted-indexes"><span>14</span><strong>検索システム</strong><small>インデックス、関連性、ランキング、オートコンプリート</small></a>
      <a href="/system-design-patterns/ja/15-deployment/01-deployment-strategies"><span>15</span><strong>デプロイメント</strong><small>戦略、フィーチャーフラグ、ロールアウト</small></a>
      <a href="/system-design-patterns/ja/16-llm-systems/01-agent-fundamentals"><span>16</span><strong>LLMシステム</strong><small>エージェント、RAG、プロンプト、基盤、コンテキスト</small></a>
      <a href="/system-design-patterns/ja/17-graphql/01-graphql-fundamentals"><span>17</span><strong>GraphQL</strong><small>スキーマ、リゾルバー、キャッシュ、フェデレーション</small></a>
      <a href="/system-design-patterns/ja/18-compound-engineering/01-compound-engineering-fundamentals"><span>18</span><strong>コンパウンドエンジニアリング</strong><small>AIネイティブ設計、コーディングエージェント、ワークフロー</small></a>
    </div>
  </section>

  <section class="sdp-reference-rail" aria-label="参照ショートカット">
    <a href="/system-design-patterns/ja/09-whitepapers/07-raft"><span>Paper trail</span><strong>Raft、Dynamo、Spanner、Kafka</strong></a>
    <a href="/system-design-patterns/ja/08-case-studies/04-netflix"><span>Production systems</span><strong>Netflix、Slack、Discord、Stripe</strong></a>
    <a href="/system-design-patterns/ja/16-llm-systems/04-rag-patterns"><span>Modern systems</span><strong>RAG、エージェント、オーケストレーション</strong></a>
  </section>
</main>

<style>
:root {
  --sdp-c-data: #2563EB;
  --sdp-c-stream: #0F766E;
  --sdp-c-decision: #D97706;
}

.VPDoc .content,
.VPDoc .content-container {
  width: 100% !important;
  min-width: 0 !important;
  max-width: none !important;
  box-sizing: border-box;
  overflow-x: clip;
}
.VPDoc .container {
  width: 100% !important;
  min-width: 0 !important;
  padding: 0 !important;
  max-width: none !important;
  box-sizing: border-box;
  overflow-x: clip;
}
.VPDoc .main {
  width: 100% !important;
  min-width: 0 !important;
  padding: 0 !important;
  box-sizing: border-box;
  overflow-x: clip;
}
.VPDoc {
  width: 100% !important;
  min-width: 0 !important;
  padding: 0 !important;
  overflow-x: clip;
}
.vp-doc h1,
.vp-doc h2,
.vp-doc p {
  margin: 0;
}
.sdp-shell {
  box-sizing: border-box;
  min-height: 100vh;
  width: 100%;
  margin: -32px 0 0;
  padding: 72px clamp(20px, 4vw, 64px) 56px;
  overflow-x: clip;
  color: var(--vp-c-text-1);
  background:
    linear-gradient(90deg, color-mix(in srgb, var(--vp-c-brand-1) 10%, transparent) 1px, transparent 1px),
    linear-gradient(0deg, color-mix(in srgb, var(--vp-c-brand-2) 8%, transparent) 1px, transparent 1px),
    var(--vp-c-bg);
  background-size: 44px 44px;
}
.sdp-cover {
  display: grid;
  width: 100%;
  min-width: 0;
  grid-template-columns: minmax(0, 1.2fr) minmax(320px, 0.8fr);
  gap: clamp(28px, 5vw, 72px);
  align-items: stretch;
  max-width: 1240px;
  margin: 0 auto;
}
.sdp-cover-main {
  min-width: 0;
  padding: clamp(28px, 5vw, 64px);
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  background: color-mix(in srgb, var(--vp-c-bg) 92%, var(--vp-c-bg-soft));
}
.sdp-kicker {
  color: var(--vp-c-brand-2);
  font-size: 0.8rem;
  font-weight: 800;
  letter-spacing: 0;
  text-transform: uppercase;
}
.sdp-cover h1 {
  white-space: normal;
  max-width: 900px;
  margin-top: 18px;
  font-size: clamp(2.6rem, 6vw, 6.2rem);
  line-height: 0.95;
  letter-spacing: 0;
}
.sdp-lede {
  max-width: 720px;
  margin-top: 24px !important;
  color: var(--vp-c-text-2);
  font-size: clamp(1rem, 1.5vw, 1.22rem);
  line-height: 1.7;
}
.sdp-cover-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-top: 34px;
}
.sdp-cover-actions a,
.sdp-reference-rail a {
  display: block;
  padding: 0.82rem 1rem;
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  color: var(--vp-c-text-1);
  text-decoration: none;
  background: var(--vp-c-bg);
}
.sdp-cover-actions a:hover,
.sdp-reference-rail a:hover,
.sdp-lanes a:hover,
.sdp-matrix a:hover {
  border-color: var(--vp-c-brand-1);
}
.sdp-cover-actions .sdp-primary {
  border-color: var(--vp-c-brand-1);
  color: #fff;
  background: var(--vp-c-brand-1);
}
.sdp-system-board {
  display: flex;
  min-width: 0;
  min-height: 460px;
  flex-direction: column;
  justify-content: space-between;
  overflow: hidden;
  padding: 22px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  background: color-mix(in srgb, var(--vp-c-bg-soft) 80%, transparent);
}
.sdp-board-header,
.sdp-board-footer {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 12px;
  color: var(--vp-c-text-2);
  font-size: 0.85rem;
}
.sdp-board-header strong {
  color: var(--vp-c-text-1);
}
.sdp-board-footer {
  grid-template-columns: repeat(3, 1fr);
}
.sdp-node-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
  margin: 28px 0;
}
.sdp-node {
  min-height: 84px;
  padding: 12px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  color: var(--vp-c-text-1);
  font-weight: 700;
  overflow-wrap: anywhere;
  text-decoration: none;
  background: var(--vp-c-bg);
}
.sdp-node.is-core { border-top: 4px solid var(--vp-c-brand-1); }
.sdp-node.is-data { border-top: 4px solid var(--sdp-c-data); }
.sdp-node.is-runtime { border-top: 4px solid var(--sdp-c-stream); }
.sdp-node.is-edge { border-top: 4px solid var(--sdp-c-decision); }
.sdp-lanes,
.sdp-reference-rail {
  display: grid;
  min-width: 0;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 1px;
  max-width: 1240px;
  margin: 28px auto 0;
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  overflow: hidden;
  background: var(--vp-c-divider);
}
.sdp-lanes a {
  display: block;
  min-height: 160px;
  padding: 20px;
  background: var(--vp-c-bg);
  color: var(--vp-c-text-1);
  text-decoration: none;
}
.sdp-lanes span,
.sdp-matrix span,
.sdp-reference-rail span {
  display: block;
  color: var(--vp-c-brand-2);
  font-size: 0.75rem;
  font-weight: 800;
  text-transform: uppercase;
}
.sdp-lanes strong,
.sdp-matrix strong,
.sdp-reference-rail strong {
  display: block;
  margin-top: 10px;
  font-size: 1.04rem;
}
.sdp-lanes small,
.sdp-matrix small {
  display: block;
  margin-top: 12px;
  color: var(--vp-c-text-2);
  line-height: 1.6;
}
.sdp-section-matrix {
  max-width: 1240px;
  margin: 72px auto 0;
}
.sdp-section-heading {
  display: flex;
  align-items: end;
  justify-content: space-between;
  gap: 24px;
  margin-bottom: 18px;
}
.sdp-section-heading h2 {
  font-size: clamp(2rem, 4vw, 4rem);
  line-height: 1;
  letter-spacing: 0;
}
.sdp-matrix {
  display: grid;
  min-width: 0;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 1px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  overflow: hidden;
  background: var(--vp-c-divider);
}
.sdp-matrix a {
  min-height: 150px;
  padding: 18px;
  color: var(--vp-c-text-1);
  text-decoration: none;
  background: var(--vp-c-bg);
}
.sdp-reference-rail {
  grid-template-columns: repeat(3, minmax(0, 1fr));
  margin-bottom: 20px;
}
@media (max-width: 1080px) {
  .sdp-cover {
    grid-template-columns: 1fr;
  }
  .sdp-system-board {
    min-height: auto;
  }
  .sdp-lanes {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .sdp-matrix {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
@media (max-width: 680px) {
  .sdp-shell {
    margin-top: -24px;
    padding: 32px 16px 40px;
    background-size: 32px 32px;
  }
  .sdp-cover-main {
    padding: 22px;
  }
  .sdp-cover h1 {
    font-size: clamp(1.82rem, 9.4vw, 2.3rem);
    line-height: 1.02;
    overflow-wrap: anywhere;
    word-break: break-word;
  }
  .sdp-lede {
    font-size: 0.98rem;
  }
  .sdp-cover-actions {
    flex-direction: column;
  }
  .sdp-cover-actions a {
    text-align: center;
  }
  .sdp-node-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .sdp-board-footer,
  .sdp-board-header,
  .sdp-lanes,
  .sdp-matrix,
  .sdp-reference-rail {
    grid-template-columns: 1fr;
  }
  .sdp-section-heading {
    display: block;
  }
  .sdp-section-heading h2 {
    margin-top: 10px;
  }
  .sdp-matrix a,
  .sdp-lanes a {
    min-height: auto;
  }
}
</style>
