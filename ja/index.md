---
layout: page
aside: false
sidebar: false
title: システム設計パターン
---

<main class="sdp-home">
  <section class="sdp-hero" aria-labelledby="sdp-title">
    <div class="sdp-shell">
      <p class="sdp-eyebrow"><span>Architecture Fieldbook</span><span>分散 · データ · ML · AI システム</span></p>
      <div class="sdp-hero-grid">
        <header class="sdp-hero-copy">
          <h1 id="sdp-title">約束を守るシステムを<em>設計する。</em></h1>
          <p class="sdp-deck">面接用の図ではなく、設計レビューと本番判断のための技術フィールドブック。整合性、障害、容量、ロールアウト、監視、ML/AIシステムまで、実装上のトレードオフを深掘りする。</p>
          <nav class="sdp-actions" aria-label="主要な導線">
            <a class="sdp-button sdp-button-primary" href="/ja/01-foundations/01-acid-transactions">基礎から始める &rarr;</a>
            <a class="sdp-button" href="/ja/16-ml-systems/01-ml-system-fundamentals">MLシステムを見る</a>
            <a class="sdp-button" href="https://github.com/babushkai/system-design-patterns/releases/latest" target="_blank" rel="noreferrer">PDF / EPUB</a>
          </nav>
        </header>
        <aside class="sdp-console" aria-label="設計レビューのチェックポイント">
          <div class="sdp-console-top"><span>design-review.yaml</span><span>production gate</span></div>
          <ol class="sdp-checks">
            <li><div><strong>不変条件を明確にする。</strong><span>トラフィック急増、時計のずれ、分断、モデル劣化の中でも何を守るのか。</span></div></li>
            <li><div><strong>ホットパスをたどる。</strong><span>リクエスト、ストレージ、キャッシュ、キュー、特徴量取得、デプロイ、ロールバック、監視。</span></div></li>
            <li><div><strong>限界を数値化する。</strong><span>容量、p99レイテンシ、整合性コスト、キュー深度、GPUメモリ、障害時ヘッドルーム。</span></div></li>
            <li><div><strong>退避経路を決める。</strong><span>劣化、シェディング、再試行、補償、fail closed、ユーザー影響前のロールバック。</span></div></li>
          </ol>
          <div class="sdp-console-foot"><span>status: evidence-driven</span><span>bias: trade-offs over slogans</span></div>
        </aside>
      </div>
      <div class="sdp-stats" aria-label="リファレンス統計">
        <p class="sdp-stat"><span class="home-stat-number">165</span><span class="home-stat-label">記事</span></p>
        <p class="sdp-stat"><span class="sdp-stat-number">19</span><span class="sdp-stat-label">設計領域</span></p>
        <p class="sdp-stat"><span class="sdp-stat-number">13</span><span class="sdp-stat-label">本番事例</span></p>
        <p class="sdp-stat"><span class="sdp-stat-number">15</span><span class="sdp-stat-label">論文ノート</span></p>
      </div>
    </div>
  </section>

  <section class="sdp-section" aria-labelledby="sdp-principles-title">
    <div class="sdp-shell">
      <header class="sdp-section-head">
        <p>Positioning</p>
        <h2 id="sdp-principles-title">暗記カードではなく、設計圧力に耐えるための実務マニュアル。</h2>
      </header>
      <div class="sdp-card-grid">
        <article class="sdp-principle"><span>01</span><h3>パターンより先に第一原理</h3><p>障害、レイテンシ、耐久性、協調、負荷、整合性、コスト、運用性から設計を導く。</p></article>
        <article class="sdp-principle"><span>02</span><h3>名前ではなくメカニズム</h3><p>プロトコル、状態機械、データフロー、API契約、スキーマ、ロールアウト経路で説明する。</p></article>
        <article class="sdp-principle"><span>03</span><h3>本番での帰結</h3><p>デプロイ、インシデント、部分障害、スキュー、過負荷、復旧で何が起きるかを基準に判断する。</p></article>
      </div>
    </div>
  </section>

  <section class="sdp-section sdp-section-muted" aria-labelledby="sdp-routes-title">
    <div class="sdp-shell">
      <header class="sdp-section-head">
        <p>Reading routes</p>
        <h2 id="sdp-routes-title">設計で向き合う圧力から読む。</h2>
      </header>
      <nav class="sdp-routes" aria-label="読書ルート">
        <a class="sdp-route" href="/ja/01-foundations/01-acid-transactions"><span>Correctness path</span><strong>トランザクション、分離、CAP、整合性、時間、分断。</strong><small>並行性と障害の中で不変条件を守る設計に。</small><b>&rarr;</b></a>
        <a class="sdp-route" href="/ja/03-storage-engines/01-b-trees"><span>State path</span><strong>ストレージエンジン、複製、索引、シャーディング、エンコーディング。</strong><small>データ配置と読み書き経路が支配的な設計に。</small><b>&rarr;</b></a>
        <a class="sdp-route" href="/ja/05-messaging/01-message-queues"><span>Flow path</span><strong>キュー、順序、配信保証、Saga、バックプレッシャー。</strong><small>スループット、非同期境界、再試行が信頼性を決める設計に。</small><b>&rarr;</b></a>
        <a class="sdp-route" href="/ja/16-ml-systems/01-ml-system-fundamentals"><span>Intelligence path</span><strong>ML基盤、特徴量、サービング、監視、実験、ガバナンス。</strong><small>統計的システムと本番制御プレーンが交わる設計に。</small><b>&rarr;</b></a>
      </nav>
    </div>
  </section>

  <section class="sdp-section" aria-labelledby="sdp-map-title">
    <div class="sdp-shell">
      <header class="sdp-section-head">
        <p>Complete map</p>
        <h2 id="sdp-map-title">19領域を、ひとつの接続されたシステムとして読む。</h2>
      </header>
      <nav class="sdp-domain-map" aria-label="アーキテクチャ領域">
        <a class="sdp-domain" href="/ja/01-foundations/01-acid-transactions"><span>01</span><strong>基礎</strong><small>保証と障害</small></a>
        <a class="sdp-domain" href="/ja/02-distributed-databases/01-single-leader-replication"><span>02</span><strong>分散データベース</strong><small>複製と合意</small></a>
        <a class="sdp-domain" href="/ja/03-storage-engines/01-b-trees"><span>03</span><strong>ストレージエンジン</strong><small>索引と永続化</small></a>
        <a class="sdp-domain" href="/ja/04-caching/01-cache-strategies"><span>04</span><strong>キャッシュ</strong><small>レイテンシと無効化</small></a>
        <a class="sdp-domain" href="/ja/05-messaging/01-message-queues"><span>05</span><strong>メッセージング</strong><small>配信と順序</small></a>
        <a class="sdp-domain" href="/ja/06-scaling/01-load-balancing"><span>06</span><strong>スケーリング</strong><small>負荷と保護</small></a>
        <a class="sdp-domain" href="/ja/07-real-time/01-polling"><span>07</span><strong>リアルタイム</strong><small>ストリームとプレゼンス</small></a>
        <a class="sdp-domain" href="/ja/08-case-studies/01-twitter"><span>08</span><strong>ケーススタディ</strong><small>本番の証拠</small></a>
        <a class="sdp-domain" href="/ja/09-whitepapers/01-mapreduce"><span>09</span><strong>ホワイトペーパー</strong><small>基礎設計</small></a>
        <a class="sdp-domain" href="/ja/10-security/01-authentication-fundamentals"><span>10</span><strong>セキュリティ</strong><small>信頼と認証</small></a>
        <a class="sdp-domain" href="/ja/11-observability/01-distributed-tracing"><span>11</span><strong>オブザーバビリティ</strong><small>追跡と対応</small></a>
        <a class="sdp-domain" href="/ja/12-service-mesh/01-service-discovery"><span>12</span><strong>サービスメッシュ</strong><small>実行時トラフィック</small></a>
        <a class="sdp-domain" href="/ja/13-data-pipelines/01-batch-processing"><span>13</span><strong>データパイプライン</strong><small>バッチとストリーム</small></a>
        <a class="sdp-domain" href="/ja/14-search-systems/01-inverted-indexes"><span>14</span><strong>検索システム</strong><small>検索と順位付け</small></a>
        <a class="sdp-domain" href="/ja/15-deployment/01-deployment-strategies"><span>15</span><strong>デプロイメント</strong><small>リリースと復旧</small></a>
        <a class="sdp-domain" href="/ja/16-ml-systems/01-ml-system-fundamentals"><span>16</span><strong>MLシステム</strong><small>特徴量・サービング・ドリフト</small></a>
        <a class="sdp-domain" href="/ja/17-llm-systems/01-agent-fundamentals"><span>17</span><strong>LLMシステム</strong><small>エージェントと文脈</small></a>
        <a class="sdp-domain" href="/ja/18-workflow-job-systems/01-workflow-system-fundamentals"><span>18</span><strong>ワークフローとジョブ</strong><small>実行と復旧</small></a>
        <a class="sdp-domain" href="/ja/19-compound-engineering/01-compound-engineering-fundamentals"><span>19</span><strong>コンパウンドエンジニアリング</strong><small>AIネイティブワークフロー</small></a>
      </nav>
    </div>
  </section>

  <section class="sdp-section sdp-section-dark" aria-labelledby="sdp-evidence-title">
    <div class="sdp-shell sdp-evidence">
      <header class="sdp-evidence-copy">
        <p>Evidence shelf</p>
        <h2 id="sdp-evidence-title">論文と本番システムを、設計判断のキャリブレーションに使う。</h2>
        <p>目的は図を暗記することではない。負荷を支える判断を見抜き、メカニズム、数値、障害分析で説明できるようにすること。</p>
      </header>
      <nav class="sdp-evidence-list" aria-label="根拠へのリンク">
        <a class="sdp-evidence-card" href="/ja/09-whitepapers/07-raft"><span>Paper trail</span><strong>Raft、Dynamo、Spanner、Kafka、FoundationDB</strong><small>現代インフラの背後にある原論文のメカニズムを読む。</small><b>&rarr;</b></a>
        <a class="sdp-evidence-card" href="/ja/08-case-studies/04-netflix"><span>Production systems</span><strong>Netflix、Slack、Discord、Stripe、Cloudflare</strong><small>抽象化を実トラフィックに耐えたシステムと比較する。</small><b>&rarr;</b></a>
        <a class="sdp-evidence-card" href="/ja/17-llm-systems/04-rag-patterns"><span>Modern systems</span><strong>RAG、エージェント、オーケストレーション、ML制御プレーン</strong><small>古典的なシステム思考をAIネイティブアーキテクチャへ拡張する。</small><b>&rarr;</b></a>
      </nav>
    </div>
  </section>
</main>

<style>
.VPDoc .content,
.VPDoc .content-container,
.VPDoc .container,
.VPDoc .main,
.VPDoc {
  width: 100% !important;
  min-width: 0 !important;
  max-width: none !important;
  box-sizing: border-box;
  padding: 0 !important;
  overflow-x: clip;
}
.vp-doc h1,
.vp-doc h2,
.vp-doc h3,
.vp-doc p {
  margin: 0;
}
.sdp-home {
  --sdp-bg: #070b12;
  --sdp-panel: rgba(15, 23, 42, 0.78);
  --sdp-panel-strong: #0f172a;
  --sdp-paper: #f8fafc;
  --sdp-paper-soft: #eef2f7;
  --sdp-ink: #f8fafc;
  --sdp-ink-dark: #0f172a;
  --sdp-muted: #94a3b8;
  --sdp-muted-dark: #536179;
  --sdp-line: rgba(148, 163, 184, 0.24);
  --sdp-line-dark: #d9e1ec;
  --sdp-blue: #60a5fa;
  --sdp-cyan: #22d3ee;
  --sdp-green: #34d399;
  --sdp-amber: #fbbf24;
  --sdp-red: #fb7185;
  --sdp-radius: 28px;
  width: 100%;
  margin: -32px 0 0;
  color: var(--sdp-ink);
  background: var(--sdp-bg);
  font-feature-settings: "ss01" on, "cv01" on;
}
.sdp-home a {
  color: inherit;
  text-decoration: none;
}
.sdp-shell {
  width: min(1180px, calc(100% - 40px));
  margin: 0 auto;
}
.sdp-hero {
  position: relative;
  overflow: hidden;
  padding: clamp(54px, 8vw, 98px) 0 54px;
  border-bottom: 1px solid var(--sdp-line);
  background:
    radial-gradient(circle at 18% 18%, rgba(96, 165, 250, 0.23), transparent 28%),
    radial-gradient(circle at 82% 8%, rgba(34, 211, 238, 0.15), transparent 28%),
    linear-gradient(135deg, #070b12 0%, #0b1020 52%, #101827 100%);
}
.sdp-hero::before {
  position: absolute;
  inset: 0;
  content: "";
  pointer-events: none;
  opacity: 0.45;
  background-image:
    linear-gradient(rgba(148, 163, 184, 0.12) 1px, transparent 1px),
    linear-gradient(90deg, rgba(148, 163, 184, 0.12) 1px, transparent 1px);
  background-size: 44px 44px;
  mask-image: linear-gradient(to bottom, black, transparent 85%);
}
.sdp-hero .sdp-shell {
  position: relative;
  z-index: 1;
}
.sdp-eyebrow {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
  margin-bottom: 30px !important;
  color: #cbd5e1;
  font-size: 0.78rem;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}
.sdp-eyebrow span {
  display: inline-flex;
  min-height: 30px;
  align-items: center;
  border: 1px solid var(--sdp-line);
  border-radius: 999px;
  padding: 0 12px;
  background: rgba(15, 23, 42, 0.5);
}
.sdp-eyebrow span:first-child {
  color: var(--sdp-green);
  border-color: rgba(52, 211, 153, 0.34);
}
.sdp-hero-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.05fr) minmax(360px, 0.75fr);
  gap: clamp(34px, 6vw, 72px);
  align-items: center;
}
.sdp-hero-copy h1 {
  max-width: 780px;
  color: var(--sdp-ink);
  font-size: clamp(3.25rem, 8vw, 7.8rem);
  font-weight: 820;
  line-height: 0.9;
  letter-spacing: -0.075em;
}
.sdp-hero-copy h1 em {
  color: var(--sdp-cyan);
  font-style: normal;
}
.sdp-deck {
  max-width: 690px;
  margin-top: 28px !important;
  color: #cbd5e1;
  font-size: clamp(1.05rem, 2vw, 1.28rem);
  line-height: 1.65;
}
.sdp-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-top: 34px;
}
.sdp-button {
  display: inline-flex;
  min-height: 46px;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--sdp-line);
  border-radius: 999px;
  padding: 0 18px;
  color: #dbeafe;
  background: rgba(15, 23, 42, 0.56);
  font-size: 0.95rem;
  font-weight: 700;
  transition: transform 0.16s ease, border-color 0.16s ease, background 0.16s ease;
}
.sdp-button:hover {
  border-color: rgba(96, 165, 250, 0.72);
  background: rgba(30, 41, 59, 0.92);
  transform: translateY(-1px);
}
.sdp-button-primary {
  border-color: transparent;
  color: #06111f;
  background: linear-gradient(135deg, var(--sdp-green), var(--sdp-cyan));
}
.sdp-button-primary:hover {
  color: #06111f;
  background: linear-gradient(135deg, #6ee7b7, #67e8f9);
}
.sdp-console {
  position: relative;
  border: 1px solid rgba(148, 163, 184, 0.26);
  border-radius: var(--sdp-radius);
  overflow: hidden;
  background: linear-gradient(180deg, rgba(15, 23, 42, 0.94), rgba(15, 23, 42, 0.58));
  box-shadow: 0 24px 80px rgba(0, 0, 0, 0.34);
}
.sdp-console::before {
  position: absolute;
  inset: 0;
  content: "";
  pointer-events: none;
  background: radial-gradient(circle at 82% 12%, rgba(34, 211, 238, 0.18), transparent 28%);
}
.sdp-console-top,
.sdp-console-foot {
  position: relative;
  z-index: 1;
  display: flex;
  justify-content: space-between;
  gap: 16px;
  padding: 16px 18px;
  border-bottom: 1px solid var(--sdp-line);
  color: var(--sdp-muted);
  font-family: var(--vp-font-family-mono, ui-monospace, monospace);
  font-size: 0.72rem;
}
.sdp-console-foot {
  border-top: 1px solid var(--sdp-line);
  border-bottom: 0;
}
.sdp-checks {
  position: relative;
  z-index: 1;
  display: grid;
  gap: 12px;
  margin: 0;
  padding: 20px;
  list-style: none;
  counter-reset: checks;
}
.sdp-checks li {
  display: grid;
  grid-template-columns: 34px 1fr;
  gap: 12px;
  align-items: start;
  border: 1px solid rgba(148, 163, 184, 0.18);
  border-radius: 18px;
  padding: 14px;
  background: rgba(2, 6, 23, 0.32);
  counter-increment: checks;
}
.sdp-checks li::before {
  display: grid;
  width: 34px;
  height: 34px;
  place-items: center;
  border-radius: 50%;
  color: #06111f;
  background: var(--sdp-green);
  content: counter(checks, decimal-leading-zero);
  font-size: 0.68rem;
  font-weight: 850;
}
.sdp-checks strong {
  display: block;
  color: var(--sdp-ink);
  font-size: 0.96rem;
}
.sdp-checks span {
  display: block;
  margin-top: 5px;
  color: var(--sdp-muted);
  font-size: 0.84rem;
  line-height: 1.45;
}
.sdp-stats {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 1px;
  margin-top: 48px;
  border: 1px solid var(--sdp-line);
  border-radius: 24px;
  overflow: hidden;
  background: var(--sdp-line);
}
.sdp-stat {
  display: grid;
  gap: 4px;
  min-height: 104px;
  align-content: center;
  padding: 22px;
  background: rgba(15, 23, 42, 0.7);
}
.home-stat-number,
.sdp-stat-number {
  color: var(--sdp-ink);
  font-size: clamp(2rem, 4vw, 3rem);
  font-weight: 820;
  letter-spacing: -0.05em;
}
.home-stat-label,
.sdp-stat-label {
  color: var(--sdp-muted);
  font-size: 0.75rem;
  font-weight: 750;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.sdp-section {
  padding: clamp(58px, 8vw, 96px) 0;
  background: var(--sdp-paper);
  color: var(--sdp-ink-dark);
}
.sdp-section-muted {
  background: var(--sdp-paper-soft);
}
.sdp-section-dark {
  background: #0b1020;
  color: var(--sdp-ink);
}
.sdp-section-head {
  display: grid;
  grid-template-columns: minmax(150px, 0.28fr) minmax(0, 0.72fr);
  gap: clamp(20px, 5vw, 74px);
  align-items: end;
  margin-bottom: clamp(30px, 5vw, 54px);
}
.sdp-section-head p:first-child {
  color: #2563eb;
  font-size: 0.76rem;
  font-weight: 850;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}
.sdp-section-dark .sdp-section-head p:first-child {
  color: var(--sdp-green);
}
.sdp-section-head h2 {
  max-width: 780px;
  font-size: clamp(2rem, 4.6vw, 4.15rem);
  font-weight: 780;
  line-height: 1;
  letter-spacing: -0.055em;
}
.sdp-card-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 16px;
}
.sdp-principle,
.sdp-route,
.sdp-domain,
.sdp-evidence-card {
  border: 1px solid var(--sdp-line-dark);
  border-radius: 24px;
  background: rgba(255, 255, 255, 0.72);
  transition: border-color 0.16s ease, box-shadow 0.16s ease, transform 0.16s ease;
}
.sdp-principle:hover,
.sdp-route:hover,
.sdp-domain:hover,
.sdp-evidence-card:hover {
  border-color: #9bb4d4;
  box-shadow: 0 18px 46px rgba(15, 23, 42, 0.08);
  transform: translateY(-2px);
}
.sdp-principle {
  padding: 24px;
}
.sdp-principle span,
.sdp-route span,
.sdp-domain span,
.sdp-evidence-card span {
  color: #2563eb;
  font-size: 0.72rem;
  font-weight: 850;
  letter-spacing: 0.1em;
  text-transform: uppercase;
}
.sdp-principle h3,
.sdp-route strong,
.sdp-domain strong,
.sdp-evidence-card strong {
  display: block;
  margin-top: 12px;
  color: var(--sdp-ink-dark);
  font-size: 1.08rem;
  line-height: 1.25;
}
.sdp-principle p,
.sdp-route small,
.sdp-domain small,
.sdp-evidence-card small {
  display: block;
  margin-top: 10px;
  color: var(--sdp-muted-dark);
  font-size: 0.94rem;
  line-height: 1.55;
}
.sdp-routes {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}
.sdp-route {
  display: grid;
  min-height: 178px;
  grid-template-columns: 1fr auto;
  align-content: space-between;
  gap: 20px;
  padding: 24px;
}
.sdp-route b,
.sdp-evidence-card b {
  align-self: start;
  color: #2563eb;
  font-size: 1.5rem;
  font-weight: 400;
}
.sdp-domain-map {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
}
.sdp-domain {
  min-height: 126px;
  padding: 18px;
}
.sdp-domain span {
  color: #64748b;
}
.sdp-domain:hover span,
.sdp-domain:hover strong {
  color: #2563eb;
}
.sdp-evidence {
  display: grid;
  grid-template-columns: 0.75fr 1.25fr;
  gap: clamp(26px, 6vw, 82px);
  align-items: start;
}
.sdp-evidence-copy p:first-child {
  color: var(--sdp-green);
  font-size: 0.76rem;
  font-weight: 850;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}
.sdp-evidence-copy h2 {
  margin-top: 14px;
  font-size: clamp(2rem, 4.8vw, 4rem);
  font-weight: 780;
  line-height: 1;
  letter-spacing: -0.055em;
}
.sdp-evidence-copy p:last-child {
  margin-top: 18px;
  color: #cbd5e1;
  font-size: 1rem;
  line-height: 1.65;
}
.sdp-evidence-list {
  display: grid;
  gap: 12px;
}
.sdp-evidence-card {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 18px;
  padding: 22px;
  border-color: rgba(148, 163, 184, 0.22);
  background: rgba(15, 23, 42, 0.72);
}
.sdp-evidence-card strong {
  color: var(--sdp-ink);
}
.sdp-evidence-card small {
  color: var(--sdp-muted);
}
.sdp-evidence-card span,
.sdp-evidence-card b {
  color: var(--sdp-green);
}
@media (max-width: 980px) {
  .sdp-hero-grid,
  .sdp-section-head,
  .sdp-evidence {
    grid-template-columns: 1fr;
  }
  .sdp-console {
    max-width: 620px;
  }
  .sdp-card-grid,
  .sdp-domain-map {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
@media (max-width: 680px) {
  .sdp-home {
    margin-top: -24px;
  }
  .sdp-shell {
    width: min(100% - 28px, 1180px);
  }
  .sdp-hero {
    padding: 36px 0 34px;
  }
  .sdp-eyebrow {
    margin-bottom: 22px !important;
  }
  .sdp-hero-copy h1 {
    font-size: clamp(3rem, 16vw, 4.15rem);
    letter-spacing: -0.07em;
  }
  .sdp-deck {
    margin-top: 20px !important;
    font-size: 1rem;
  }
  .sdp-actions {
    margin-top: 24px;
  }
  .sdp-button {
    width: 100%;
  }
  .sdp-console {
    border-radius: 22px;
  }
  .sdp-checks {
    padding: 14px;
  }
  .sdp-stats,
  .sdp-card-grid,
  .sdp-routes,
  .sdp-domain-map {
    grid-template-columns: 1fr;
  }
  .sdp-stat {
    min-height: 82px;
  }
  .sdp-section {
    padding: 48px 0;
  }
  .sdp-section-head {
    margin-bottom: 26px;
  }
  .sdp-section-head h2,
  .sdp-evidence-copy h2 {
    font-size: 2.15rem;
  }
  .sdp-route {
    min-height: 150px;
  }
}
@media (prefers-reduced-motion: reduce) {
  .sdp-button,
  .sdp-principle,
  .sdp-route,
  .sdp-domain,
  .sdp-evidence-card {
    transition: none;
  }
  .sdp-button:hover,
  .sdp-principle:hover,
  .sdp-route:hover,
  .sdp-domain:hover,
  .sdp-evidence-card:hover {
    transform: none;
  }
}
</style>
