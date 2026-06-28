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

- `script-src 'self' 'wasm-unsafe-eval'`（WASM=将来の Cornerstone3D コーデック用。eval は不許可）
- `style-src 'self' 'unsafe-inline'`（インライン style 属性のため。script より低リスク）
- `connect-src 'self' http://localhost:* http://127.0.0.1:*`（backend へ接続）
- `worker-src 'self' blob:`（Cornerstone3D 等の Web Worker）
- `img-src 'self' data: blob:` / `object-src 'none'` / `base-uri 'self'` / `frame-src 'none'`

備考: **dev では Electron の CSP 警告が出るが、これは Vite/HMR の eval が原因で回避不可。
Electron はパッケージ後は警告を出さない**（本番は上記 CSP が適用される）。
