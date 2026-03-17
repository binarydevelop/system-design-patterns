# キャッシングとパフォーマンス

> **注:** この記事は英語版からの翻訳です。コードブロック（Python、JavaScript、GraphQL SDL）およびMermaidダイアグラムは原文のまま保持しています。

## TL;DR

GraphQLのキャッシングはRESTよりも複雑です。リクエストがさまざまなクエリで単一のエンドポイントに送信されるためです。主要な戦略には、レスポンスキャッシング（完全なクエリ結果）、正規化キャッシング（エンティティレベル）、Persisted Queries（事前登録クエリ）、CDNキャッシングがあります。Automatic Persisted Queries（APQ）は帯域幅を削減し、キャッシュコントロールディレクティブはフィールドごとのきめ細かいTTLを可能にします。

---

## キャッシングの課題

### GraphQLのキャッシングが異なる理由

```mermaid
graph LR
    subgraph REST["REST Caching"]
        R1["GET /users/123"]
        R2["GET /users/123/posts"]
        R3["Different URLs per resource<br/>HTTP caching works<br/>CDN-friendly by default<br/>Cache key = URL"]
    end

    subgraph GQL["GraphQL Caching"]
        G1["POST /graphql"]
        G2["query: '...'"]
        G3["Single endpoint<br/>HTTP caching doesn't work<br/>POST = not cacheable<br/>Cache key = query hash?"]
    end

    GQL --> C["Challenges:<br/>1. POST not cached by HTTP<br/>2. Same query, different data (variables)<br/>3. Overlapping data across queries<br/>4. Field-level cache control needed<br/>5. Query complexity varies wildly"]
```

---

## Persisted Queries

### Persisted Queriesの動作原理

```mermaid
graph TD
    subgraph BUILD["BUILD TIME (Ahead of time)"]
        B1["Extract queries<br/>from client code"] --> B2["Generate hash<br/>for each query"]
        B2 --> B3["Register hash-to-query<br/>mapping on server"]
    end

    subgraph RUNTIME["RUNTIME (Query by hash)"]
        C1["Client sends<br/>sha256Hash: abc123...<br/>variables: {id: 123}"]
        C1 --> S1["Server looks up<br/>query by hash"]
        S1 --> S2["Execute query"]
    end

    BUILD --> RUNTIME

    RUNTIME --> BEN["Benefits:<br/>Smaller payloads<br/>Whitelist allowed queries<br/>CDN caching via GET<br/>Prevent arbitrary execution"]
```

### Automatic Persisted Queries（APQ）

```mermaid
sequenceDiagram
    participant C as Client
    participant S as Server

    Note over C,S: First request (query not registered)
    C->>S: {hash: "abc123"}
    S->>C: PersistedQueryNotFound
    C->>S: {hash: "abc123", query: "{ user {...} }"}
    Note over S: Registers query
    S->>C: Returns data

    Note over C,S: Subsequent requests
    C->>S: {hash: "abc123"}
    Note over S: Looks up query by hash
    S->>C: Returns data
```

メリット: ビルドステップ不要、初回使用時に自動登録、ユニークなクエリあたり1回の追加ラウンドトリップのみ、動的生成クエリでも動作

---

## クライアントサイドキャッシング

### 正規化キャッシュ（Apollo Client）

```mermaid
graph LR
    subgraph RESULT["Query Result"]
        QR["post: {id: 1, title: Hello,<br/>author: {id: 100, name: Alice}}"]
    end

    QR -->|Normalize| CACHE

    subgraph CACHE["Normalized Cache"]
        P1["Post:1<br/>id: 1<br/>title: Hello<br/>author: __ref User:100"]
        U1["User:100<br/>id: 100<br/>name: Alice"]
        P1 -.->|reference| U1
    end

    CACHE --> B1["Updates to User:100<br/>reflected everywhere"]
    CACHE --> B2["Deduplication of data"]
    CACHE --> B3["Automatic cache updates<br/>on mutations"]
```

---

## パフォーマンス最適化

### 遅延実行（@defer）

```graphql
query GetPost($id: ID!) {
  post(id: $id) {
    id
    title
    content

    # Defer expensive fields
    ... @defer {
      comments {
        id
        text
        author {
          name
        }
      }
      relatedPosts {
        id
        title
      }
    }
  }
}
```

---

## ベストプラクティス

```
レスポンスキャッシング:
□ フィールドレベルのTTLにキャッシュコントロールディレクティブを使用する
□ フィールドヒントから全体のキャッシュポリシーを計算する
□ パブリックとプライベートのキャッシュデータを分離する
□ ミューテーション時にキャッシュを無効化する

Persisted Queries:
□ 自動登録にAPQを使用する
□ 本番環境では静的抽出を検討する
□ CDNキャッシングのためにGETリクエストを有効にする
□ 高セキュリティ環境ではクエリをホワイトリスト化する

クライアントキャッシング:
□ 適切なキーフィールドで正規化キャッシュを設定する
□ ページネーションマージのための型ポリシーを定義する
□ より良いUXのためにオプティミスティック更新を使用する
□ ログアウト/ユーザー切替時にキャッシュをクリーンアップする

パフォーマンス:
□ クエリ複雑度/コスト分析を実装する
□ 適切な制限を設定する（深度、複雑度、バッチサイズ）
□ 高コストなフィールドには@deferを使用する
□ リゾルバのパフォーマンスを監視する
□ 遅いクエリをログに記録し分析する
```

---

## 参考文献

- [Apollo Server Caching](https://www.apollographql.com/docs/apollo-server/performance/caching/)
- [Automatic Persisted Queries](https://www.apollographql.com/docs/apollo-server/performance/apq/)
- [Apollo Client Cache](https://www.apollographql.com/docs/react/caching/overview/)
- [GraphQL CDN Caching (Fastly)](https://www.fastly.com/blog/caching-graphql-apis)
- [GraphQL Persisted Documents](https://github.com/apollographql/graphql-persisted-document-loader)
