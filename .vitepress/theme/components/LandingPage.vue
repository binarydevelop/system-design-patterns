<script setup lang="ts">
import { computed } from 'vue'
import { withBase } from 'vitepress'

type Locale = 'en' | 'ja'
type LinkCard = {
  eyebrow: string
  title: string
  body: string
  href: string
  external?: boolean
}
type Domain = {
  number: string
  title: string
  body: string
  href: string
}

const props = withDefaults(defineProps<{ locale?: Locale }>(), {
  locale: 'en',
})

const domains: Record<Locale, Domain[]> = {
  en: [
    { number: '01', title: 'Foundations', body: 'Guarantees and failure', href: '/01-foundations/01-acid-transactions' },
    { number: '02', title: 'Distributed Databases', body: 'Replication and consensus', href: '/02-distributed-databases/01-single-leader-replication' },
    { number: '03', title: 'Storage Engines', body: 'Indexes and persistence', href: '/03-storage-engines/01-b-trees' },
    { number: '04', title: 'Caching', body: 'Latency and invalidation', href: '/04-caching/01-cache-strategies' },
    { number: '05', title: 'Messaging', body: 'Delivery and ordering', href: '/05-messaging/01-message-queues' },
    { number: '06', title: 'Scaling', body: 'Load and protection', href: '/06-scaling/01-load-balancing' },
    { number: '07', title: 'Real-Time', body: 'Streams and presence', href: '/07-real-time/01-polling' },
    { number: '08', title: 'Case Studies', body: 'Production evidence', href: '/08-case-studies/01-twitter' },
    { number: '09', title: 'Whitepapers', body: 'Foundational designs', href: '/09-whitepapers/01-mapreduce' },
    { number: '10', title: 'Security', body: 'Trust and identity', href: '/10-security/01-authentication-fundamentals' },
    { number: '11', title: 'Observability', body: 'Trace and response', href: '/11-observability/01-distributed-tracing' },
    { number: '12', title: 'Service Mesh', body: 'Runtime traffic', href: '/12-service-mesh/01-service-discovery' },
    { number: '13', title: 'Data Pipelines', body: 'Batch and streams', href: '/13-data-pipelines/01-batch-processing' },
    { number: '14', title: 'Search Systems', body: 'Retrieve and rank', href: '/14-search-systems/01-inverted-indexes' },
    { number: '15', title: 'Deployment', body: 'Release and recover', href: '/15-deployment/01-deployment-strategies' },
    { number: '16', title: 'ML Systems', body: 'Features, serving, drift', href: '/16-ml-systems/01-ml-system-fundamentals' },
    { number: '17', title: 'LLM Systems', body: 'Agents and context', href: '/17-llm-systems/01-agent-fundamentals' },
    { number: '18', title: 'Workflow & Jobs', body: 'Workers and recovery', href: '/18-workflow-job-systems/01-workflow-system-fundamentals' },
    { number: '19', title: 'Compound Engineering', body: 'AI-native workflows', href: '/19-compound-engineering/01-compound-engineering-fundamentals' },
  ],
  ja: [
    { number: '01', title: '基礎', body: '保証と障害', href: '/ja/01-foundations/01-acid-transactions' },
    { number: '02', title: '分散データベース', body: '複製と合意', href: '/ja/02-distributed-databases/01-single-leader-replication' },
    { number: '03', title: 'ストレージエンジン', body: '索引と永続化', href: '/ja/03-storage-engines/01-b-trees' },
    { number: '04', title: 'キャッシュ', body: 'レイテンシと無効化', href: '/ja/04-caching/01-cache-strategies' },
    { number: '05', title: 'メッセージング', body: '配信と順序', href: '/ja/05-messaging/01-message-queues' },
    { number: '06', title: 'スケーリング', body: '負荷と保護', href: '/ja/06-scaling/01-load-balancing' },
    { number: '07', title: 'リアルタイム', body: 'ストリームとプレゼンス', href: '/ja/07-real-time/01-polling' },
    { number: '08', title: 'ケーススタディ', body: '本番の証拠', href: '/ja/08-case-studies/01-twitter' },
    { number: '09', title: 'ホワイトペーパー', body: '基礎設計', href: '/ja/09-whitepapers/01-mapreduce' },
    { number: '10', title: 'セキュリティ', body: '信頼と認証', href: '/ja/10-security/01-authentication-fundamentals' },
    { number: '11', title: 'オブザーバビリティ', body: '追跡と対応', href: '/ja/11-observability/01-distributed-tracing' },
    { number: '12', title: 'サービスメッシュ', body: '実行時トラフィック', href: '/ja/12-service-mesh/01-service-discovery' },
    { number: '13', title: 'データパイプライン', body: 'バッチとストリーム', href: '/ja/13-data-pipelines/01-batch-processing' },
    { number: '14', title: '検索システム', body: '検索と順位付け', href: '/ja/14-search-systems/01-inverted-indexes' },
    { number: '15', title: 'デプロイメント', body: 'リリースと復旧', href: '/ja/15-deployment/01-deployment-strategies' },
    { number: '16', title: 'MLシステム', body: '特徴量・サービング・ドリフト', href: '/ja/16-ml-systems/01-ml-system-fundamentals' },
    { number: '17', title: 'LLMシステム', body: 'エージェントと文脈', href: '/ja/17-llm-systems/01-agent-fundamentals' },
    { number: '18', title: 'ワークフローとジョブ', body: '実行と復旧', href: '/ja/18-workflow-job-systems/01-workflow-system-fundamentals' },
    { number: '19', title: 'コンパウンドエンジニアリング', body: 'AIネイティブワークフロー', href: '/ja/19-compound-engineering/01-compound-engineering-fundamentals' },
  ],
}

const content = {
  en: {
    titleHtml: 'Design systems that keep their <em>promises.</em>',
    eyebrow: ['Architecture Fieldbook', 'Distributed · Data · ML · AI Systems'],
    deck: 'A deeply technical field guide for engineers who need more than interview diagrams: invariants, trade-offs, failure modes, capacity math, rollout mechanics, and production case studies.',
    edition: {
      badge: 'Exclusive deluxe documentation',
      title: 'Claude Fable edition',
      body: 'Forged with a rare Claude Fable build. Curated into a production-grade architecture fieldbook.',
      stamp: 'Rare build'
    },
    heroPills: ['Invariants', 'Failure modes', 'Capacity math', 'Rollout mechanics'],
    primaryCta: { label: 'Start with foundations →', href: '/01-foundations/01-acid-transactions' },
    secondaryCta: { label: 'Explore ML systems', href: '/16-ml-systems/01-ml-system-fundamentals' },
    downloadCta: { label: 'Download PDF / EPUB', href: 'https://github.com/babushkai/system-design-patterns/releases/latest', external: true },
    consoleLabel: 'Design review checkpoints',
    consoleTop: ['design-review.yaml', 'production gate'],
    checks: [
      ['State the invariant.', 'What must remain true when traffic spikes, clocks drift, replicas split, or models degrade?'],
      ['Trace the hot path.', 'Request, storage, cache, queue, feature fetch, deployment, rollback, and observability.'],
      ['Quantify the envelope.', 'Capacity, p99 latency, consistency cost, queue depth, GPU memory, and failure headroom.'],
      ['Name the escape hatch.', 'Degrade, shed, retry, compensate, fail closed, or roll back before users absorb the blast radius.'],
    ],
    consoleFoot: ['status: evidence-driven', 'bias: trade-offs over slogans'],
    statsLabel: 'Reference statistics',
    stats: [
      ['167', 'Articles'],
      ['19', 'Design domains'],
      ['13', 'Case studies'],
      ['15', 'Paper notes'],
    ],
    principlesHeading: ['Positioning', 'Not flashcards. A field manual for real design pressure.'],
    principles: [
      ['01', 'First principles before patterns', 'Each topic starts from constraints: failure, latency, durability, coordination, load, consistency, cost, and operability.'],
      ['02', 'Mechanisms over names', 'Patterns are explained through protocols, state machines, data flows, API contracts, schemas, and rollout paths.'],
      ['03', 'Production consequences', 'Every design is judged by what happens during deploys, incidents, partial failure, skew, overload, and recovery.'],
    ],
    routesHeading: ['Reading routes', 'Choose the pressure you are designing against.'],
    routes: [
      { eyebrow: 'Correctness path', title: 'Transactions, isolation, CAP, consistency, time, partitions.', body: 'Use when the system must preserve invariants under concurrency and failure.', href: '/01-foundations/01-acid-transactions' },
      { eyebrow: 'State path', title: 'Storage engines, replication, indexes, sharding, encoding.', body: 'Use when data layout and write/read paths dominate the architecture.', href: '/03-storage-engines/01-b-trees' },
      { eyebrow: 'Flow path', title: 'Queues, ordering, delivery guarantees, sagas, backpressure.', body: 'Use when throughput, asynchronous boundaries, and retries decide reliability.', href: '/05-messaging/01-message-queues' },
      { eyebrow: 'Intelligence path', title: 'ML platforms, features, serving, monitoring, experiments, governance.', body: 'Use when statistical systems meet production control planes.', href: '/16-ml-systems/01-ml-system-fundamentals' },
    ] satisfies LinkCard[],
    mapHeading: ['Complete map', 'Nineteen domains, one connected system.'],
    evidenceHeading: 'Use papers and production systems as calibration data.',
    evidenceEyebrow: 'Evidence shelf',
    evidenceBody: 'The goal is not to memorize diagrams. The goal is to recognize load-bearing decisions and defend them with mechanisms, numbers, and failure analysis.',
    evidenceLinks: [
      { eyebrow: 'Paper trail', title: 'Raft, Dynamo, Spanner, Kafka, FoundationDB', body: 'Read the original mechanisms behind modern infrastructure.', href: '/09-whitepapers/07-raft' },
      { eyebrow: 'Production systems', title: 'Netflix, Slack, Discord, Stripe, Cloudflare', body: 'Compare abstractions against systems that served real traffic.', href: '/08-case-studies/04-netflix' },
      { eyebrow: 'Modern systems', title: 'RAG, agents, orchestration, ML control planes', body: 'Extend classic systems thinking into AI-native architectures.', href: '/17-llm-systems/04-rag-patterns' },
    ] satisfies LinkCard[],
  },
  ja: {
    titleHtml: '約束を守るシステムを<em>設計する。</em>',
    eyebrow: ['Architecture Fieldbook', '分散 · データ · ML · AI システム'],
    deck: '面接用の図ではなく、設計レビューと本番判断のための技術フィールドブック。整合性、障害、容量、ロールアウト、監視、ML/AIシステムまで、実装上のトレードオフを深掘りする。',
    edition: {
      badge: 'Exclusive deluxe documentation',
      title: 'Claude Fable edition',
      body: '希少なClaude Fableビルドで鍛え、プロダクション級のアーキテクチャ・フィールドブックとして磨き込んだドキュメント。',
      stamp: 'Rare build'
    },
    heroPills: ['不変条件', '障害モード', '容量見積もり', 'ロールアウト'],
    primaryCta: { label: '基礎から始める →', href: '/ja/01-foundations/01-acid-transactions' },
    secondaryCta: { label: 'MLシステムを見る', href: '/ja/16-ml-systems/01-ml-system-fundamentals' },
    downloadCta: { label: 'PDF / EPUB', href: 'https://github.com/babushkai/system-design-patterns/releases/latest', external: true },
    consoleLabel: '設計レビューのチェックポイント',
    consoleTop: ['design-review.yaml', 'production gate'],
    checks: [
      ['不変条件を明確にする。', 'トラフィック急増、時計のずれ、分断、モデル劣化の中でも何を守るのか。'],
      ['ホットパスをたどる。', 'リクエスト、ストレージ、キャッシュ、キュー、特徴量取得、デプロイ、ロールバック、監視。'],
      ['限界を数値化する。', '容量、p99レイテンシ、整合性コスト、キュー深度、GPUメモリ、障害時ヘッドルーム。'],
      ['退避経路を決める。', '劣化、シェディング、再試行、補償、fail closed、ユーザー影響前のロールバック。'],
    ],
    consoleFoot: ['status: evidence-driven', 'bias: trade-offs over slogans'],
    statsLabel: 'リファレンス統計',
    stats: [
      ['167', '記事'],
      ['19', '設計領域'],
      ['13', '本番事例'],
      ['15', '論文ノート'],
    ],
    principlesHeading: ['Positioning', '暗記カードではなく、設計圧力に耐えるための実務マニュアル。'],
    principles: [
      ['01', 'パターンより先に第一原理', '障害、レイテンシ、耐久性、協調、負荷、整合性、コスト、運用性から設計を導く。'],
      ['02', '名前ではなくメカニズム', 'プロトコル、状態機械、データフロー、API契約、スキーマ、ロールアウト経路で説明する。'],
      ['03', '本番での帰結', 'デプロイ、インシデント、部分障害、スキュー、過負荷、復旧で何が起きるかを基準に判断する。'],
    ],
    routesHeading: ['Reading routes', '設計で向き合う圧力から読む。'],
    routes: [
      { eyebrow: 'Correctness path', title: 'トランザクション、分離、CAP、整合性、時間、分断。', body: '並行性と障害の中で不変条件を守る設計に。', href: '/ja/01-foundations/01-acid-transactions' },
      { eyebrow: 'State path', title: 'ストレージエンジン、複製、索引、シャーディング、エンコーディング。', body: 'データ配置と読み書き経路が支配的な設計に。', href: '/ja/03-storage-engines/01-b-trees' },
      { eyebrow: 'Flow path', title: 'キュー、順序、配信保証、Saga、バックプレッシャー。', body: 'スループット、非同期境界、再試行が信頼性を決める設計に。', href: '/ja/05-messaging/01-message-queues' },
      { eyebrow: 'Intelligence path', title: 'ML基盤、特徴量、サービング、監視、実験、ガバナンス。', body: '統計的システムと本番制御プレーンが交わる設計に。', href: '/ja/16-ml-systems/01-ml-system-fundamentals' },
    ] satisfies LinkCard[],
    mapHeading: ['Complete map', '19領域を、ひとつの接続されたシステムとして読む。'],
    evidenceEyebrow: 'Evidence shelf',
    evidenceHeading: '論文と本番システムを、設計判断のキャリブレーションに使う。',
    evidenceBody: '目的は図を暗記することではない。負荷を支える判断を見抜き、メカニズム、数値、障害分析で説明できるようにすること。',
    evidenceLinks: [
      { eyebrow: 'Paper trail', title: 'Raft、Dynamo、Spanner、Kafka、FoundationDB', body: '現代インフラの背後にある原論文のメカニズムを読む。', href: '/ja/09-whitepapers/07-raft' },
      { eyebrow: 'Production systems', title: 'Netflix、Slack、Discord、Stripe、Cloudflare', body: '抽象化を実トラフィックに耐えたシステムと比較する。', href: '/ja/08-case-studies/04-netflix' },
      { eyebrow: 'Modern systems', title: 'RAG、エージェント、オーケストレーション、ML制御プレーン', body: '古典的なシステム思考をAIネイティブアーキテクチャへ拡張する。', href: '/ja/17-llm-systems/04-rag-patterns' },
    ] satisfies LinkCard[],
  },
}

const page = computed(() => content[props.locale])
const domainList = computed(() => domains[props.locale])

function hrefFor(card: { href: string; external?: boolean }) {
  return card.external ? card.href : withBase(card.href)
}

function linkRel(card: { external?: boolean }) {
  return card.external ? 'noreferrer' : undefined
}

function linkTarget(card: { external?: boolean }) {
  return card.external ? '_blank' : undefined
}
</script>

<template>
  <main class="sdp-home" :lang="locale">
    <section class="sdp-hero" aria-labelledby="sdp-title">
      <div class="sdp-shell">
        <aside class="sdp-edition-banner" aria-label="Exclusive edition note">
          <span class="sdp-edition-mark" aria-hidden="true"><span>CF</span></span>
          <div class="sdp-edition-copy">
            <span>{{ page.edition.badge }}</span>
            <strong>{{ page.edition.title }}</strong>
            <small>{{ page.edition.body }}</small>
          </div>
          <span class="sdp-edition-stamp">{{ page.edition.stamp }}</span>
        </aside>
        <p class="sdp-eyebrow">
          <span>{{ page.eyebrow[0] }}</span>
          <span>{{ page.eyebrow[1] }}</span>
        </p>
        <div class="sdp-hero-grid">
          <header class="sdp-hero-copy">
            <h1 id="sdp-title" v-html="page.titleHtml" />
            <p class="sdp-deck">{{ page.deck }}</p>
            <ul class="sdp-hero-pills" aria-label="Content strengths">
              <li v-for="pill in page.heroPills" :key="pill">{{ pill }}</li>
            </ul>
            <nav class="sdp-actions" aria-label="Primary paths">
              <a class="sdp-button sdp-button-primary" :href="hrefFor(page.primaryCta)">{{ page.primaryCta.label }}</a>
              <a class="sdp-button" :href="hrefFor(page.secondaryCta)">{{ page.secondaryCta.label }}</a>
              <a
                class="sdp-button"
                :href="hrefFor(page.downloadCta)"
                :target="linkTarget(page.downloadCta)"
                :rel="linkRel(page.downloadCta)"
              >{{ page.downloadCta.label }}</a>
            </nav>
          </header>
          <div class="sdp-hero-visual">
            <aside class="sdp-console" :aria-label="page.consoleLabel">
              <div class="sdp-console-top">
                <span>{{ page.consoleTop[0] }}</span>
                <span>{{ page.consoleTop[1] }}</span>
              </div>
              <ol class="sdp-checks">
                <li v-for="check in page.checks" :key="check[0]">
                  <div>
                    <strong>{{ check[0] }}</strong>
                    <span>{{ check[1] }}</span>
                  </div>
                </li>
              </ol>
              <div class="sdp-console-foot">
                <span>{{ page.consoleFoot[0] }}</span>
                <span>{{ page.consoleFoot[1] }}</span>
              </div>
            </aside>
            <div class="sdp-system-card" aria-hidden="true">
              <div class="sdp-orbit">
                <span class="sdp-orbit-core">invariant</span>
                <span class="sdp-orbit-node sdp-node-data">data</span>
                <span class="sdp-orbit-node sdp-node-flow">flow</span>
                <span class="sdp-orbit-node sdp-node-ml">ml</span>
                <span class="sdp-orbit-node sdp-node-risk">risk</span>
              </div>
              <div class="sdp-signal-row">
                <span>p99 bounded</span>
                <span>rollback ready</span>
                <span>evidence logged</span>
              </div>
            </div>
          </div>
        </div>
        <div class="sdp-stats" :aria-label="page.statsLabel">
          <p v-for="stat in page.stats" :key="stat[1]" class="sdp-stat">
            <span class="home-stat-number">{{ stat[0] }}</span>
            <span class="home-stat-label">{{ stat[1] }}</span>
          </p>
        </div>
      </div>
    </section>

    <section class="sdp-section" aria-labelledby="sdp-principles-title">
      <div class="sdp-shell">
        <header class="sdp-section-head">
          <p>{{ page.principlesHeading[0] }}</p>
          <h2 id="sdp-principles-title">{{ page.principlesHeading[1] }}</h2>
        </header>
        <div class="sdp-card-grid">
          <article v-for="principle in page.principles" :key="principle[0]" class="sdp-principle">
            <span>{{ principle[0] }}</span>
            <h3>{{ principle[1] }}</h3>
            <p>{{ principle[2] }}</p>
          </article>
        </div>
      </div>
    </section>

    <section class="sdp-section sdp-section-muted" aria-labelledby="sdp-routes-title">
      <div class="sdp-shell">
        <header class="sdp-section-head">
          <p>{{ page.routesHeading[0] }}</p>
          <h2 id="sdp-routes-title">{{ page.routesHeading[1] }}</h2>
        </header>
        <nav class="sdp-routes" aria-label="Curated reading routes">
          <a v-for="route in page.routes" :key="route.eyebrow" class="sdp-route" :href="hrefFor(route)">
            <span>{{ route.eyebrow }}</span>
            <strong>{{ route.title }}</strong>
            <small>{{ route.body }}</small>
            <b aria-hidden="true">→</b>
          </a>
        </nav>
      </div>
    </section>

    <section class="sdp-section" aria-labelledby="sdp-map-title">
      <div class="sdp-shell">
        <header class="sdp-section-head">
          <p>{{ page.mapHeading[0] }}</p>
          <h2 id="sdp-map-title">{{ page.mapHeading[1] }}</h2>
        </header>
        <nav class="sdp-domain-map" aria-label="Architecture sections">
          <a v-for="domain in domainList" :key="domain.number" class="sdp-domain" :href="withBase(domain.href)">
            <span>{{ domain.number }}</span>
            <strong>{{ domain.title }}</strong>
            <small>{{ domain.body }}</small>
          </a>
        </nav>
      </div>
    </section>

    <section class="sdp-section sdp-section-dark" aria-labelledby="sdp-evidence-title">
      <div class="sdp-shell sdp-evidence">
        <header class="sdp-evidence-copy">
          <p>{{ page.evidenceEyebrow }}</p>
          <h2 id="sdp-evidence-title">{{ page.evidenceHeading }}</h2>
          <p>{{ page.evidenceBody }}</p>
        </header>
        <nav class="sdp-evidence-list" aria-label="Evidence links">
          <a v-for="link in page.evidenceLinks" :key="link.eyebrow" class="sdp-evidence-card" :href="hrefFor(link)">
            <span>{{ link.eyebrow }}</span>
            <strong>{{ link.title }}</strong>
            <small>{{ link.body }}</small>
            <b aria-hidden="true">→</b>
          </a>
        </nav>
      </div>
    </section>
  </main>
</template>

<style>
.VPDoc:has(.sdp-home) .content,
.VPDoc:has(.sdp-home) .content-container,
.VPDoc:has(.sdp-home) .container,
.VPDoc:has(.sdp-home) .main,
.VPDoc:has(.sdp-home) {
  width: 100% !important;
  min-width: 0 !important;
  max-width: none !important;
  box-sizing: border-box;
  padding: 0 !important;
  overflow-x: clip;
}
.VPDoc:has(.sdp-home) .vp-doc h1,
.VPDoc:has(.sdp-home) .vp-doc h2,
.VPDoc:has(.sdp-home) .vp-doc h3,
.VPDoc:has(.sdp-home) .vp-doc p {
  margin: 0;
}
</style>

<style scoped>
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
  --sdp-violet: #a78bfa;
  --sdp-amber: #fbbf24;
  --sdp-red: #fb7185;
  --sdp-halo: rgba(34, 211, 238, 0.2);
  --sdp-shadow: 0 28px 90px rgba(2, 6, 23, 0.24);
  --sdp-radius: 30px;
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
  width: min(1240px, calc(100% - 48px));
  margin: 0 auto;
}
.sdp-hero {
  position: relative;
  isolation: isolate;
  overflow: hidden;
  padding: clamp(72px, 8vw, 104px) 0 52px;
  border-bottom: 1px solid rgba(148, 163, 184, 0.18);
  background:
    radial-gradient(920px circle at 8% -12%, rgba(96, 165, 250, 0.18), transparent 58%),
    radial-gradient(760px circle at 90% 8%, rgba(34, 211, 238, 0.12), transparent 62%),
    linear-gradient(135deg, #050712 0%, #080d19 46%, #0d1625 100%);
}
.sdp-hero::before {
  position: absolute;
  inset: 0;
  z-index: -2;
  content: "";
  pointer-events: none;
  opacity: 0.3;
  background-image:
    linear-gradient(rgba(148, 163, 184, 0.1) 1px, transparent 1px),
    linear-gradient(90deg, rgba(148, 163, 184, 0.1) 1px, transparent 1px);
  background-size: 56px 56px;
  mask-image: linear-gradient(to bottom, black, transparent 78%);
}
.sdp-hero::after {
  position: absolute;
  inset: auto -12% -36% -12%;
  z-index: -1;
  height: 52%;
  content: "";
  pointer-events: none;
  background: radial-gradient(closest-side, rgba(34, 211, 238, 0.14), transparent 74%);
  filter: blur(36px);
}
.sdp-hero .sdp-shell {
  position: relative;
  z-index: 1;
}
.sdp-edition-banner {
  position: relative;
  display: grid;
  grid-template-columns: 52px minmax(0, 1fr) auto;
  gap: 16px;
  align-items: center;
  width: 100%;
  min-height: 82px;
  margin-bottom: 34px;
  border: 1px solid transparent;
  border-radius: 24px;
  padding: 14px 16px 14px 14px;
  overflow: hidden;
  color: #e2e8f0;
  background:
    linear-gradient(112deg, rgba(2, 6, 23, 0.88), rgba(15, 23, 42, 0.8) 58%, rgba(30, 41, 59, 0.68)) padding-box,
    linear-gradient(118deg, rgba(246, 213, 141, 0.58), rgba(34, 211, 238, 0.42), rgba(167, 139, 250, 0.38)) border-box;
  box-shadow:
    0 22px 68px rgba(2, 6, 23, 0.34),
    inset 0 1px 0 rgba(255, 255, 255, 0.08);
  backdrop-filter: blur(20px);
}
.sdp-edition-banner::before,
.sdp-edition-banner::after {
  position: absolute;
  content: "";
  pointer-events: none;
}
.sdp-edition-banner::before {
  inset: 0 0 auto;
  z-index: 0;
  height: 1px;
  background: linear-gradient(90deg, transparent, rgba(246, 213, 141, 0.64), rgba(34, 211, 238, 0.46), transparent);
  opacity: 0.9;
}
.sdp-edition-banner::after {
  inset: 0;
  z-index: 0;
  border-radius: inherit;
  background:
    radial-gradient(circle at 9% 20%, rgba(246, 213, 141, 0.12), transparent 34%),
    radial-gradient(circle at 92% 18%, rgba(34, 211, 238, 0.14), transparent 36%),
    linear-gradient(90deg, rgba(255, 255, 255, 0.045), transparent 34%, rgba(255, 255, 255, 0.035));
  opacity: 0.95;
}
.sdp-edition-mark {
  position: relative;
  z-index: 1;
  display: grid;
  width: 52px;
  height: 52px;
  place-items: center;
  border: 1px solid rgba(246, 213, 141, 0.34);
  border-radius: 18px;
  color: #f8dfa4;
  background:
    linear-gradient(180deg, rgba(246, 213, 141, 0.12), rgba(15, 23, 42, 0.72)),
    rgba(2, 6, 23, 0.46);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.08), 0 12px 26px rgba(2, 6, 23, 0.32);
  font-size: 0.82rem;
  font-weight: 900;
  letter-spacing: 0.08em;
}
.sdp-edition-mark::before {
  position: absolute;
  inset: 7px;
  border: 1px solid rgba(246, 213, 141, 0.18);
  border-radius: 13px;
  content: "";
}
.sdp-edition-mark::after {
  display: none;
}
.sdp-edition-mark span {
  position: relative;
  z-index: 1;
}
.sdp-edition-copy {
  position: relative;
  z-index: 1;
  display: grid;
  gap: 4px;
  min-width: 0;
}
.sdp-edition-copy span {
  width: fit-content;
  color: #f8dfa4;
  font-size: 0.62rem;
  font-weight: 850;
  letter-spacing: 0.14em;
  text-transform: uppercase;
}
.sdp-edition-copy strong {
  width: fit-content;
  color: #f8fafc;
  font-size: clamp(1rem, 1.6vw, 1.18rem);
  font-weight: 820;
  letter-spacing: 0.02em;
}
.sdp-edition-copy small {
  max-width: 76ch;
  color: #aab8cc;
  font-size: 0.88rem;
  line-height: 1.5;
}
.sdp-edition-stamp {
  position: relative;
  z-index: 1;
  display: inline-flex;
  min-width: 92px;
  min-height: 34px;
  align-items: center;
  justify-content: center;
  border: 1px solid rgba(246, 213, 141, 0.28);
  border-radius: 999px;
  padding: 0 12px;
  color: #f8dfa4;
  background: rgba(246, 213, 141, 0.07);
  font-size: 0.62rem;
  font-weight: 850;
  letter-spacing: 0.14em;
  text-align: center;
  text-transform: uppercase;
  white-space: nowrap;
}

.sdp-eyebrow {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
  margin-bottom: 24px !important;
  color: #94a3b8;
  font-size: 0.72rem;
  font-weight: 760;
  letter-spacing: 0.14em;
  text-transform: uppercase;
}
.sdp-eyebrow span {
  display: inline-flex;
  align-items: center;
}
.sdp-eyebrow span + span::before {
  width: 4px;
  height: 4px;
  margin-right: 10px;
  border-radius: 999px;
  background: rgba(246, 213, 141, 0.78);
  box-shadow: 0 0 14px rgba(246, 213, 141, 0.38);
  content: "";
}
.sdp-eyebrow span:first-child {
  color: #f8dfa4;
}
.sdp-hero-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(360px, 0.72fr);
  gap: clamp(44px, 6vw, 82px);
  align-items: start;
}
.sdp-hero-copy h1 {
  max-width: 780px;
  color: var(--sdp-ink);
  font-size: clamp(3.35rem, 7.4vw, 7.05rem);
  font-weight: 820;
  line-height: 0.94;
  letter-spacing: -0.075em;
  text-wrap: balance;
}
.sdp-hero-copy h1 :deep(em) {
  color: transparent;
  background: linear-gradient(100deg, #f8dfa4, var(--sdp-cyan) 48%, #c4b5fd);
  background-clip: text;
  font-style: normal;
}
.sdp-deck {
  max-width: 650px;
  margin-top: 24px !important;
  color: #b9c5d6;
  font-size: clamp(1.02rem, 1.7vw, 1.18rem);
  line-height: 1.68;
  text-wrap: pretty;
}
.sdp-hero-pills {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 26px 0 0;
  padding: 0;
  list-style: none;
}
.sdp-hero-pills li {
  border: 1px solid rgba(148, 163, 184, 0.18);
  border-radius: 999px;
  padding: 7px 10px;
  color: #cfdae9;
  background: rgba(15, 23, 42, 0.36);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.045);
  font-size: 0.7rem;
  font-weight: 760;
  letter-spacing: 0.075em;
  text-transform: uppercase;
}
.sdp-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-top: 32px;
}
.sdp-button {
  display: inline-flex;
  min-height: 48px;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--sdp-line);
  border-radius: 999px;
  padding: 0 20px;
  color: #dbeafe;
  background: rgba(15, 23, 42, 0.58);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.06);
  font-size: 0.95rem;
  font-weight: 740;
  transition: transform 0.18s ease, border-color 0.18s ease, background 0.18s ease, box-shadow 0.18s ease;
}
.sdp-button:hover {
  border-color: rgba(96, 165, 250, 0.72);
  background: rgba(30, 41, 59, 0.92);
  box-shadow: 0 12px 34px rgba(15, 23, 42, 0.28), inset 0 1px 0 rgba(255, 255, 255, 0.08);
  transform: translateY(-2px);
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
.sdp-hero-visual {
  position: relative;
  display: grid;
  gap: 14px;
}
.sdp-hero-visual::before {
  position: absolute;
  inset: -20px -16px 34px 16%;
  z-index: -1;
  border-radius: 38px;
  content: "";
  background:
    linear-gradient(135deg, rgba(96, 165, 250, 0.12), transparent 42%),
    radial-gradient(circle at 78% 22%, rgba(246, 213, 141, 0.1), transparent 42%);
  filter: blur(4px);
}
.sdp-console {
  position: relative;
  border: 1px solid rgba(148, 163, 184, 0.22);
  border-radius: 26px;
  overflow: hidden;
  background:
    linear-gradient(180deg, rgba(15, 23, 42, 0.92), rgba(15, 23, 42, 0.68)),
    radial-gradient(circle at 76% 12%, rgba(34, 211, 238, 0.11), transparent 38%);
  box-shadow: 0 24px 74px rgba(0, 0, 0, 0.34), inset 0 1px 0 rgba(255, 255, 255, 0.055);
  backdrop-filter: blur(18px);
}
.sdp-console::before {
  position: absolute;
  inset: 0;
  content: "";
  pointer-events: none;
  background:
    linear-gradient(90deg, rgba(246, 213, 141, 0.24), transparent 24%, transparent 78%, rgba(34, 211, 238, 0.18)),
    radial-gradient(circle at 82% 12%, rgba(34, 211, 238, 0.15), transparent 30%);
  opacity: 0.38;
}
.sdp-console::after {
  position: absolute;
  inset: 0;
  content: "";
  pointer-events: none;
  background-image: linear-gradient(rgba(255, 255, 255, 0.028) 1px, transparent 1px);
  background-size: 100% 14px;
  mix-blend-mode: screen;
  opacity: 0.2;
}
.sdp-console-top,
.sdp-console-foot {
  position: relative;
  z-index: 1;
  display: flex;
  justify-content: space-between;
  gap: 16px;
  padding: 15px 18px;
  border-bottom: 1px solid rgba(148, 163, 184, 0.18);
  color: #93a3b8;
  font-family: var(--vp-font-family-mono, ui-monospace, monospace);
  font-size: 0.68rem;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.sdp-console-foot {
  border-top: 1px solid var(--sdp-line);
  border-bottom: 0;
}
.sdp-system-card {
  position: relative;
  display: grid;
  grid-template-columns: 148px 1fr;
  gap: 16px;
  align-items: center;
  border: 1px solid rgba(148, 163, 184, 0.18);
  border-radius: 24px;
  padding: 14px;
  background: rgba(2, 6, 23, 0.36);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.045);
  backdrop-filter: blur(16px);
}
.sdp-orbit {
  position: relative;
  width: 136px;
  aspect-ratio: 1;
  border: 1px solid rgba(96, 165, 250, 0.24);
  border-radius: 50%;
  background:
    radial-gradient(circle, rgba(34, 211, 238, 0.14), transparent 35%),
    conic-gradient(from 140deg, rgba(246, 213, 141, 0.22), rgba(96, 165, 250, 0.08), rgba(167, 139, 250, 0.2), rgba(246, 213, 141, 0.22));
}
.sdp-orbit::before,
.sdp-orbit::after {
  position: absolute;
  inset: 22px;
  border: 1px dashed rgba(226, 232, 240, 0.22);
  border-radius: 50%;
  content: "";
}
.sdp-orbit::after {
  inset: 48px;
  border-style: solid;
  border-color: rgba(52, 211, 153, 0.26);
}
.sdp-orbit-core {
  position: absolute;
  top: 50%;
  left: 50%;
  display: grid;
  width: 64px;
  height: 64px;
  place-items: center;
  border-radius: 50%;
  color: #06111f;
  background: linear-gradient(135deg, #f8dfa4, var(--sdp-cyan));
  box-shadow: 0 0 30px rgba(34, 211, 238, 0.24);
  font-size: 0.64rem;
  font-weight: 850;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  transform: translate(-50%, -50%);
}
.sdp-orbit-node {
  position: absolute;
  display: grid;
  min-width: 46px;
  min-height: 24px;
  place-items: center;
  border: 1px solid rgba(226, 232, 240, 0.22);
  border-radius: 999px;
  color: #dbeafe;
  background: rgba(15, 23, 42, 0.82);
  font-size: 0.62rem;
  font-weight: 760;
  text-transform: uppercase;
}
.sdp-node-data { top: 8px; left: 50%; transform: translateX(-50%); }
.sdp-node-flow { top: 50%; right: -12px; transform: translateY(-50%); }
.sdp-node-ml { bottom: 8px; left: 50%; transform: translateX(-50%); }
.sdp-node-risk { top: 50%; left: -12px; transform: translateY(-50%); }
.sdp-signal-row {
  display: grid;
  gap: 8px;
  color: #cbd5e1;
  font-family: var(--vp-font-family-mono, ui-monospace, monospace);
  font-size: 0.74rem;
  text-transform: uppercase;
}
.sdp-signal-row span {
  display: flex;
  align-items: center;
  gap: 8px;
}
.sdp-signal-row span::before {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--sdp-green);
  box-shadow: 0 0 16px rgba(52, 211, 153, 0.7);
  content: "";
}
.sdp-checks {
  position: relative;
  z-index: 1;
  display: grid;
  gap: 10px;
  margin: 0;
  padding: 18px;
  list-style: none;
  counter-reset: checks;
}
.sdp-checks li {
  display: grid;
  grid-template-columns: 32px 1fr;
  gap: 12px;
  align-items: start;
  border: 1px solid rgba(148, 163, 184, 0.15);
  border-radius: 16px;
  padding: 13px;
  background: rgba(2, 6, 23, 0.26);
  counter-increment: checks;
}
.sdp-checks li::before {
  display: grid;
  width: 32px;
  height: 32px;
  place-items: center;
  border: 1px solid rgba(248, 223, 164, 0.34);
  border-radius: 50%;
  color: #f8dfa4;
  background: rgba(246, 213, 141, 0.08);
  content: counter(checks, decimal-leading-zero);
  font-size: 0.64rem;
  font-weight: 850;
}
.sdp-checks strong {
  display: block;
  color: #f8fafc;
  font-size: 0.92rem;
}
.sdp-checks span {
  display: block;
  margin-top: 5px;
  color: #97a6ba;
  font-size: 0.8rem;
  line-height: 1.46;
}
.sdp-stats {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 1px;
  margin-top: 44px;
  border: 1px solid rgba(148, 163, 184, 0.18);
  border-radius: 24px;
  overflow: hidden;
  background: rgba(148, 163, 184, 0.18);
  box-shadow: 0 18px 58px rgba(2, 6, 23, 0.18);
}
.sdp-stat {
  display: grid;
  gap: 3px;
  min-height: 92px;
  align-content: center;
  padding: 20px 22px;
  background:
    linear-gradient(180deg, rgba(15, 23, 42, 0.72), rgba(15, 23, 42, 0.54));
}
.home-stat-number {
  color: var(--sdp-ink);
  font-size: clamp(1.82rem, 3.2vw, 2.58rem);
  font-weight: 780;
  letter-spacing: -0.045em;
}
.home-stat-label {
  color: #93a3b8;
  font-size: 0.68rem;
  font-weight: 760;
  letter-spacing: 0.1em;
  text-transform: uppercase;
}
.sdp-section {
  position: relative;
  padding: clamp(68px, 9vw, 112px) 0;
  background:
    radial-gradient(circle at 10% 0%, rgba(96, 165, 250, 0.08), transparent 38%),
    var(--sdp-paper);
  color: var(--sdp-ink-dark);
}
.sdp-section-muted {
  background:
    linear-gradient(180deg, #eef2f7, #f7f9fc 48%, #eef2f7);
}
.sdp-section-dark {
  background:
    radial-gradient(circle at 18% 16%, rgba(52, 211, 153, 0.12), transparent 36%),
    radial-gradient(circle at 86% 34%, rgba(96, 165, 250, 0.14), transparent 40%),
    #0b1020;
  color: var(--sdp-ink);
}
.sdp-section-head {
  display: grid;
  grid-template-columns: minmax(150px, 0.28fr) minmax(0, 0.72fr);
  gap: clamp(20px, 5vw, 74px);
  align-items: end;
  margin-bottom: clamp(30px, 5vw, 54px);
}
.sdp-section-head p:first-child,
.sdp-evidence-copy p:first-child {
  color: #2563eb;
  font-size: 0.76rem;
  font-weight: 850;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}
.sdp-section-dark .sdp-section-head p:first-child,
.sdp-evidence-copy p:first-child {
  color: var(--sdp-green);
}
.sdp-section-head h2,
.sdp-evidence-copy h2 {
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
  position: relative;
  border: 1px solid var(--sdp-line-dark);
  border-radius: 26px;
  overflow: hidden;
  background:
    linear-gradient(180deg, rgba(255, 255, 255, 0.92), rgba(248, 250, 252, 0.72));
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.9);
  transition: border-color 0.18s ease, box-shadow 0.18s ease, transform 0.18s ease;
}
.sdp-principle::before,
.sdp-route::before,
.sdp-domain::before,
.sdp-evidence-card::before {
  position: absolute;
  inset: 0 0 auto;
  height: 3px;
  content: "";
  background: linear-gradient(90deg, var(--sdp-green), var(--sdp-cyan), var(--sdp-violet));
  opacity: 0;
  transition: opacity 0.18s ease;
}
.sdp-principle:hover,
.sdp-route:hover,
.sdp-domain:hover,
.sdp-evidence-card:hover {
  border-color: #9bb4d4;
  box-shadow: 0 22px 58px rgba(15, 23, 42, 0.11);
  transform: translateY(-3px);
}
.sdp-principle:hover::before,
.sdp-route:hover::before,
.sdp-domain:hover::before,
.sdp-evidence-card:hover::before {
  opacity: 1;
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
  gap: 12px;
}
.sdp-domain {
  min-height: 132px;
  padding: 19px;
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
.sdp-evidence-copy h2 {
  margin-top: 14px;
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
  padding: 24px;
  border-color: rgba(148, 163, 184, 0.22);
  background:
    linear-gradient(180deg, rgba(15, 23, 42, 0.84), rgba(15, 23, 42, 0.58));
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.06);
  backdrop-filter: blur(14px);
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
  .sdp-hero-visual {
    max-width: 640px;
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
  .sdp-edition-banner {
    grid-template-columns: 44px minmax(0, 1fr);
    gap: 12px;
    width: auto;
    min-height: 0;
    border-radius: 24px;
    padding: 13px;
    margin-bottom: 22px;
  }
  .sdp-edition-mark {
    width: 44px;
    height: 44px;
    border-radius: 15px;
    font-size: 0.78rem;
  }
  .sdp-edition-mark::after {
    top: -7px;
    right: -7px;
    width: 18px;
    height: 18px;
    font-size: 0.58rem;
  }
  .sdp-edition-copy span {
    width: auto;
    font-size: 0.56rem;
  }
  .sdp-edition-copy strong {
    font-size: 1rem;
  }
  .sdp-edition-copy small {
    font-size: 0.82rem;
  }
  .sdp-edition-stamp {
    grid-column: 2;
    justify-self: start;
    min-width: 0;
    min-height: 28px;
    border-radius: 999px;
    padding: 0 10px;
    font-size: 0.56rem;
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
  .sdp-system-card {
    grid-template-columns: 1fr;
  }
  .sdp-orbit {
    width: min(150px, 62vw);
    margin: 0 auto;
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
  .sdp-evidence-card,
  .sdp-principle::before,
  .sdp-route::before,
  .sdp-domain::before,
  .sdp-evidence-card::before {
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
