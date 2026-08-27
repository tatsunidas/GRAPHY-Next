# セキュリティ設定（Electron / デスクトップ）

> 作成日: 2026-06-28
> ステータス: 確定（強化適用済み）

## 方針
Electron のレンダラ無害化（renderer hardening）は**安全な値に固定**し、ユーザーが無効化できないようにする。
無効化は重大なリスクのため、設定ダイアログでは**確認のみ**（read-only）とし、トグルは提供しない。
本当に変更が必要な場合は `desktop/config.json` / 環境変数というアプリ運用者レベルでのみ可能にする。

## 固定している安全設定（`desktop/main.js`・両ウィンドウ）
| 設定 | 値 | 意味 |
|---|---|---|
| `contextIsolation` | **true** | レンダラと preload の JS world を分離 |
| `nodeIntegration` | **false** | レンダラに Node API を露出しない |
| `sandbox` | **true** | レンダラをサンドボックス化 |
| `webSecurity` | **true** | 同一オリジンポリシー等を有効 |

- preload は sandbox 互換にするため `config.json` を require せず、`main.js` が
  `additionalArguments`（`--graphy-api-base=...`）で渡す値を `process.argv` から読む。
- **外部 URL は既定ブラウザで開く**（`setWindowOpenHandler` で新規ウィンドウは deny、`shell.openExternal`）。
- **アプリ内のトップフレーム外部ナビゲーションを禁止**（`will-navigate` ガード）。
- **DevTools** は dev か `config.json` の `security.devTools=true` のときのみ（本番は既定で無効）。

## 確認 UI（環境設定 > セキュリティ）
preload が `window.__GRAPHY_SECURITY__`（`process.contextIsolated` / `process.sandbox` の実値）を公開し、
設定ダイアログの「セキュリティ」カテゴリで Context Isolation / Node Integration / Sandbox の状態を
✓/✕ 表示する（web 版では非対応の旨を表示）。

## 設定可能な項目
- `desktop/config.json` の `security.devTools`（既定 false）。
- 固定の安全設定（contextIsolation 等）は意図的に非設定化。

## CSP（Content-Security-Policy）— 対応済み
dev(Vite/HMR は unsafe-eval を使う) と本番(file://)で要件が異なるため、
**本番ビルド時のみ** `index.html` に厳格な CSP メタタグを注入する
（`vite.config.ts` の `cspPlugin`, `apply: "build"`）。dev には注入せず HMR を壊さない。

- `script-src 'self' 'wasm-unsafe-eval' http://localhost:* http://127.0.0.1:*`
  （WASM=将来の Cornerstone3D コーデック用。eval は不許可。localhost はプラグインの UI バンドル用）
- `style-src 'self' 'unsafe-inline'`（インライン style 属性のため。script より低リスク）
- `connect-src 'self' http://localhost:* http://127.0.0.1:*`（backend へ接続）
- `worker-src 'self' blob:`（Cornerstone3D 等の Web Worker）
- `img-src 'self' data: blob:` / `object-src 'none'` / `base-uri 'self'` / `frame-src 'none'`

🔴 **`import()` は `connect-src` ではなく `script-src` に支配される**（2026-08-24 に実機で踏んだ）。
プラグインの UI バンドルは `http://localhost:8080/api/plugins/{id}/ui.js` を動的 import で読むため、
`connect-src` だけ localhost を許可しても `script-src 'self'` が **file:// 由来のパッケージ版で**
これを止め、`TypeError: Failed to fetch dynamically imported module` になる。
**dev は CSP を注入しないので再現しない**——つまり**パッケージ版でだけプラグインが読めない**状態が
v0.2.1 まで続いていた（`fw/plugin-explainer.md` の「守れていないこと」に相当）。
許可範囲は `connect-src` と同じホストに揃えてある（backend と同じ信頼境界。プラグインは設計上
アプリと同じ権限で動くので、ここを広げても信頼モデルは変わらない）。

⚠️ **この CSP 修正（v0.2.2）は必要だったが十分ではなかった。** 同じ症状の裏に
**backend の CORS 設定（下記 §CORS）**という第 2 の原因が重なっており、v0.2.2 を入れても
まったく同じエラー文で失敗し続けた。**「直したはずのものが同じエラーで再発したら、
同じ原因の直し漏れではなく別の原因が背後にある」**と疑うこと——この件では
CSP を完全に外しても失敗したことで、CSP が原因でないと確定できた。

備考: **dev では Electron の CSP 警告が出るが、これは Vite/HMR の eval が原因で回避不可。
Electron はパッケージ後は警告を出さない**（本番は上記 CSP が適用される）。

## CORS — Electron のレンダラが送る Origin は `file://`（`null` ではない）

> 追記: 2026-08-24（v0.2.2 のあとに発覚した第 2 の原因。正本はここ）

許可オリジンは `graphy.cors.allowed-origin-patterns`（`backend/src/main/resources/application.yml`）。
`WebConfig#addCorsMappings` が `/api/**` に適用する。

| パターン | 用途 |
|---|---|
| `http://localhost:*` / `http://127.0.0.1:*` | dev の Vite、および web モード |
| **`file://`** | **Electron のレンダラ（パッケージ版）** |
| `null` | sandbox iframe 等の不透明オリジン |

🔴 **`file://` を足すまで、パッケージ版のプラグインは 100% 導入後に起動できなかった。**
設定のコメントは以前「Electron file:// = null を想定」と書いていたが、**実測では
`Origin: file://` という文字列がそのまま来る**。Spring の CORS はこれを許可リスト外と判定し
**403 `Invalid CORS request`** を返していた。

**なぜ気付きにくかったか** — ここが本質:

- **`file://` ページからの通常の `fetch`/XHR は Origin ヘッダを送らない。** Origin が無ければ
  CORS フィルタは素通りする。だから**アプリ本体の API 呼び出しは全部 200 で通る**。
- **Origin を送るのは module script の取得（動的 `import()`）だけ**（`Sec-Fetch-Dest: script`）。
  つまり **403 になるのはプラグインの `ui.js` ただ 1 本**。
- ブラウザ側に出るのは `TypeError: Failed to fetch dynamically imported module` のみで、
  **HTTP ステータスもサーバ側の理由も表に出ない**。`curl` で叩くと（Origin を付けないので）200 が
  返るため、「サーバは正しく配信できている」と誤読する。

**切り分けの型**（同種の不具合はこの順で潰す）:

1. `fetch(url)` と `import(url)` を**同じページで並べて**試す。**片方だけ落ちるなら CORS か CSP**。
2. **CSP を完全に外して**再試行。それでも落ちるなら CSP は無罪。
3. **同じバイト列を自前のローカルサーバから配信**して import する。通るならサーバ側の応答が原因。
4. **記録用プロキシを挟む**（`req.headers` と upstream のステータスを出す）。ここで初めて
   `origin: file://` → `403` が見える。**この 4 段目まで行かないと真因は見えなかった。**

再発防止: `backend/src/test/java/com/vis/graphynext/web/CorsConfigTest.java`
（`file://` / `null` / `http://localhost:5173` は 200、外部サイトは 403 を固定）。

---

## 🚨 「CORS エラー」に見えるが CORS ではない — URL が長すぎる（2026-08-27・PR #155）

上の §CORS とは**別の原因**で、ブラウザには**まったく同じ顔**で出る。先に疑うべきはこちら
（設定は正しいのに CORS を疑って時間を溶かす）。

**症状**:

```
Access to fetch at 'http://localhost:8080/api/reports/study-counts?studyUids=…（8KB 超）'
  from origin 'http://localhost:5173' has been blocked by CORS policy:
  No 'Access-Control-Allow-Origin' header is present on the requested resource.
GET …  net::ERR_FAILED 400 (Bad Request)
```

**原因**: Tomcat の `maxHttpRequestHeaderSize`（既定 **8KB**）はリクエストラインとヘッダの合計。
ID を並べたクエリがこれを超えると、**Tomcat がパース段階で 400 を返す**。
🔴 **Spring まで到達しないので CORS フィルタが動かず、`Access-Control-Allow-Origin` が付かない。**
ブラウザは「CORS ヘッダが無い」としか言えない。

**見分け方**: backend のログに次が出ているか。**これが唯一の決め手**。

```
o.apache.coyote.http11.Http11Processor : Error parsing HTTP request header
java.lang.IllegalArgumentException: Request header is too large
	at ...Http11InputBuffer.parseRequestLine
```

`parseRequestLine` で落ちていれば**ヘッダではなく URL（リクエストライン）が長い**。

**実測**: スタディ一覧の全 UID を 1 本の URL に詰めていた
（`GET /api/reports/study-counts?studyUids=a,b,c,…`）。
Study Instance UID 63 文字 × **131 件** ≒ **8,383 バイト**で破綻。
**126 件あたりが分水嶺**なので、開発中の少件数では絶対に踏まない。

🔴 **さらに気付けなかった理由**: 呼び出し側（`hooks/useStudies.ts`）が
`.catch(() => {})` で握り潰していたので、**MainScreen のレポート ●/○ が黙って出なくなる**だけ。
`http.ts` が `log.warn` は出すので**開発者コンソールには残る**が、**画面にもトーストにも
何も出ない**ので、コンソールを開いていない利用者には「そういう仕様」に見える。
**「補助情報だから失敗しても無視」は、失敗が常態化したとき誰も気付けない**
（`fw/error-handling-logging.md` の「失敗は握り潰さない」に反していた例）。

**対策**（`frontend/src/urlChunk.ts` の `chunkForQuery()`）:

- 🔴 **件数ではなくエンコード後のバイト長で切る**。UID の長さはデータ源で違う
  （`1.2.826.0.1.3680043.10.1338.…` は 60 字超、`2.25.…` は 40 字前後）ので、
  固定件数だと**ある施設のデータでだけ落ちる**。
- 単体で上限を超える ID は 1 件のかたまりにして落とさない（進まなくなるのを防ぐ）。
- 🔴 **Tomcat の上限を上げる対処は採らない。** データが増えれば必ずまた超える。
  「URL に載せる件数をこちらで制御する」が正しい直し方。

**同じ形が他にもある**。ID を `join(",")` してクエリに載せる GET は**すべて**この対象:

| 経路 | 状態 |
|---|---|
| `GET /api/reports/study-counts?studyUids=` | ✅ 分割済み |
| `GET /api/anonymizer/masks?seriesUids=` | ✅ 分割済み（**シリーズはスタディより数が多く、より早く踏む**） |

**新しく足すときは `chunkForQuery()` を通すこと。** 単体テストは `frontend/src/urlChunk.test.ts`。
