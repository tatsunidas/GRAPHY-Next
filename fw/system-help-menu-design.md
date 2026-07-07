# System / Help メニュー拡張 設計・実装記録

MainScreen と 2D Viewer の **System メニュー**と **Help メニュー**に項目を追加した記録。
対象アプリは Electron デスクトップ（standalone）＋ Web（browser）の 2 モード構成。

- 実装日: 2026-07-02
- 対象: `frontend/`（React + TypeScript）, `desktop/`（Electron）
- 検証: `npm run typecheck` パス / `node --check main.js preload.js` パス

---

## 1. 追加した機能

### System メニュー
| 項目 | 動作 |
| --- | --- |
| **Log** | log.ts のリングバッファに溜まった全ログ（フロント `console.*`＋**バックエンド DIMSE/DICOMweb 等**）をアプリ内フローティングパネルで表示。既に開いていれば最前面へ（ViewTop）。 |
| **MemoryMonitor** | クライアント OS 標準のメモリ/システムモニタを起動（デスクトップのみ。Web は案内表示）。 |

### Help メニュー
| 項目 | 動作 |
| --- | --- |
| **User's community** | GRAPHY Users Google グループ（`https://groups.google.com/g/graphy-users`）を OS 既定ブラウザで開く。 |
| **Contact to developer** | 開発者への連絡ダイアログを開く（メール / バグ報告=GitHub Issues / スポンサード開発=GitHub Sponsors）。 |

MainScreen・2D Viewer 両方に追加。2D Viewer は元々 System / Help メニューが無かったため新規に追加。

---

## 2. 設計判断（ユーザー不在時のデフォルト採用）

- **Log = アプリ内ダイアログ**（別ウィンドウ集約ではない）
  - Electron では MainScreen と 2D Viewer は別ウィンドウ＝別 JS コンテキストのため、各ウィンドウの Log は**そのウィンドウのフロントログ**を表示する。
  - 全ウィンドウの**フロント**ログ集約は main プロセスへの IPC 転送が必要で大掛かりなため見送り。
- **バックエンドログは REST で取り込む**（後日追加。§4.5）
  - backend(Spring Boot/SLF4J) のログは stdout にしか出ず、従来はアプリ内で不可視だった（特に DIMSE の C-MOVE 失敗＝`movescu 失敗 (exit=N)` や DICOMweb エラー）。
  - main プロセス経由の IPC 集約ではなく、**backend 側にインメモリ・リングバッファ＋ `/api/system/logs`** を設け、Log ビューア表示中だけ差分ポーリングして同じバッファに取り込む方式を採用。standalone/web 両モードで動き、web モード（別マシンの backend）でも同じ経路で見える。
- **MemoryMonitor = OS 標準ツール起動**（デスクトップ限定）
  - ブラウザからは OS ツールを起動できないため、Web モードでは「デスクトップ専用」の案内 alert。
- **外部リンク/mailto は `openExternal` IPC 経由**
  - 既存の window ハンドラは `window.open` の http(s) しか外部化しない。`mailto:` を確実に開くため IPC を追加。

---

## 3. 変更ファイル一覧

### 新規
- `frontend/src/system/LogViewer.tsx` — Log ビューア（ホスト＋ダイアログ＋`openLogViewer()` コントローラ）
- `frontend/src/system/memoryMonitor.ts` — `openMemoryMonitor(t)` ヘルパ（デスクトップ橋渡し／Web 案内）
- `frontend/src/help/links.ts` — Help 外部リンク定数＋`openExternal()` / `openUsersCommunity()`
- `frontend/src/help/DeveloperContact.tsx` — 連絡ダイアログ（ホスト＋`openDeveloperContact()` コントローラ）
- `frontend/src/system/backendLog.ts` — backend ログの差分ポーリング取り込み（`startBackendLogPolling()`。§4.5）
- `backend/.../system/SystemLogStore.java` — backend ログのインメモリ・リングバッファ（3000 件、seq カーソル）
- `backend/.../system/SystemLogAppender.java` — Logback イベントを Store へ複製する appender
- `backend/.../system/SystemLogAppenderInstaller.java` — `@PostConstruct` で `com.vis.graphynext` ロガーへ appender を結線
- `backend/.../system/SystemLogController.java` — `GET /api/system/logs?afterSeq&limit` 差分払い出し

### 変更
- `frontend/src/log.ts` — インメモリのリングバッファ（3000 件）＋ `console.*`/未捕捉例外の捕捉を追加。`getLogEntries` / `subscribeLog` / `clearLogEntries` を公開。後日 `ingestExternal(level, ts, text)`（backend ログ取り込み用。console 非経由）を追加。
- `frontend/src/system/LogViewer.tsx` — 表示中のみ `startBackendLogPolling()` を起動（§4.5）。
- `frontend/src/qr/QrTable.tsx` — リトリーブ失敗セルに失敗理由（`job.message`）をツールチップ＋省略表示（全文は System＞ログ）。
- `frontend/src/App.tsx` — `<LogViewerHost />` / `<DeveloperContactHost />` を全ウィンドウ共通でマウント。
- `frontend/src/mainscreen/MenuBar.tsx` — System に Log/MemoryMonitor、Help に community/contact を追加。
- `frontend/src/viewer2d/Viewer2DMenuBar.tsx` — System メニュー（新規）＋ Help メニュー（新規）を追加。
- `frontend/src/desktopBridge.ts` — `openMemoryMonitor?()` / `openExternal?(url)` を `GraphyDesktop` に追加。
- `frontend/src/i18n/en.ts`, `ja.ts` — `system.*` / `log.*` / `help.*` キーを追加。
- `desktop/preload.js` — `openMemoryMonitor` / `openExternal` を contextBridge で公開。
- `desktop/main.js` — IPC ハンドラ `graphy:open-memory-monitor` / `graphy:open-external` を追加。

---

## 4. 実装詳細

### 4.1 ログ収集（`frontend/src/log.ts`）
- リングバッファ `buffer: LogEntry[]`（上限 3000、超過分は先頭から破棄）。
- `installConsoleCapture()`：`console.debug/info/warn/error/log` をラップし、`record()` でバッファへ記録した後にオリジナルを呼ぶ（多重適用ガードあり）。`record()` は console を呼ばないので再帰しない。
- `window` の `error` / `unhandledrejection` も捕捉。
- 既存の `log.debug/info/warn/error` はラップ済み console 経由でそのまま記録される（挙動不変）。`debug` は `dev` または `localStorage("graphy.debug")==="true"` のときのみ出力する従来仕様を維持。
- 公開 API: `getLogEntries()` / `subscribeLog(listener)` / `clearLogEntries()`（クリアは `seq=-1` の番兵で購読者へ通知）。

### 4.2 Log ビューア（`frontend/src/system/LogViewer.tsx`）
- 非モーダルのフローティングパネル（ヘッダをドラッグで移動可）。
- レベルフィルタ（DEBUG/INFO/WARN/ERROR）、テキスト検索、自動スクロール、Copy、Clear。
- `openLogViewer()`（モジュールレベル）で開閉。再呼び出しで `raise` を増分し zIndex を上げ、最下部へスクロール＝ViewTop 相当。
- `App` に `<LogViewerHost />` を 1 つだけマウント（全ウィンドウで利用可能）。

### 4.3 MemoryMonitor
- フロント `openMemoryMonitor(t)`：`desktop()?.openMemoryMonitor` があれば呼ぶ。失敗時 `system.memoryMonitor.failed`、Web（橋渡し無し）は `system.memoryMonitor.desktopOnly` を alert。
- main プロセス `graphy:open-memory-monitor`：
  - Windows: `taskmgr.exe`
  - macOS: `open -a "Activity Monitor"`
  - Linux: `gnome-system-monitor → plasma-systemmonitor → ksysguard → mate-system-monitor → xfce4-taskmanager → lxtask` を順に試行（`error`=ENOENT で次候補）。
  - 子プロセスは `detached: true` + `unref()` で親から切り離す。

### 4.4 Help リンク / 連絡ダイアログ
- リンク定数（`frontend/src/help/links.ts`）
  - usersCommunity: `https://groups.google.com/g/graphy-users`
  - contactEmail: `customerservices@vis-ionary.com`
  - githubIssues: `https://github.com/tatsunidas/GRAPHY-Next/issues`（git remote から導出）
  - sponsors: `https://github.com/sponsors/accounts`
- `openExternal(url)`：`desktop()?.openExternal` があれば IPC 経由、無ければ `window.open`。
- main プロセス `graphy:open-external`：`http(s):` / `mailto:` のみ許可して `shell.openExternal`（任意コマンド実行を避けるためスキーム制限）。
- 連絡ダイアログ：メール（mailto 送信ボタン）、GitHub Issues、GitHub Sponsors への導線。`App` に `<DeveloperContactHost />` をマウント。

### 4.5 バックエンドログ取り込み（DIMSE / DICOMweb）
- 動機：backend(SLF4J) のログは stdout にしか出ず、Electron main が拾って main プロセスの stdout に流すだけ。パッケージ版ではどこにも残らず、**QR の C-MOVE 失敗（`movescu 失敗 (exit=N): <末尾>`）や DICOMweb エラーがアプリ内で不可視**だった。
- backend 側（`com.vis.graphynext.system`）:
  - `SystemLogStore`：インメモリ・リングバッファ（3000 件、`AtomicLong` の seq カーソル、`synchronized`）。`Entry(seq, ts, level, logger, message)`。
  - `SystemLogAppender`（Logback `AppenderBase`）：整形済みメッセージ＋例外先頭を 1 行に畳んで Store へ。ロガー名は `qr.QrRetrieveService` のように短縮。
  - `SystemLogAppenderInstaller`（`@PostConstruct`）：`logback-spring.xml` を足さず、`com.vis.graphynext` ロガーへプログラム的に appender を addAppender。既定の stdout 出力は維持（additivity true）＝配下（`dicom.qr` 等）のイベントも伝播。二重付与ガードあり。
  - `SystemLogController`：`GET /api/system/logs?afterSeq=<seq>&limit=<n>` → `{ entries, lastSeq }`（`seq > afterSeq` を返し、超過は新しい方から limit 件）。Spring Security 無し＝他 `/api` 同様に公開。
- frontend:
  - `backendLog.ts`：`startBackendLogPolling()` が 2 秒間隔で差分ポーリング（開始時 1 回即時＝履歴バックフィル）。`lastSeq` はモジュール保持で開閉をまたいで重複回避。**素の `fetch`** を使い、取得失敗は握り潰す（`httpGet` は失敗を warn するためログを汚さない）。取得行は `«server» <logger>: <msg>` の接頭辞で `ingestExternal()` により log.ts バッファへ。
  - `LogViewer.tsx`：ダイアログ表示中のみ `startBackendLogPolling()` を起動（`useEffect` の cleanup で停止）。レベル色/フィルタ/検索/コピー/クリアは既存機構をそのまま流用（新規 i18n 不要）。
- レベル対応：ERROR→error / WARN→warn / DEBUG・TRACE→debug / それ以外→info。`com.vis.graphynext` の実効レベルは既定 INFO（`application.yml`）なので DEBUG は既定では乗らない。
- 実機検証：偽 PACS への retrieve で `WARN qr.QrRetrieveService - QR C-MOVE 失敗 job=…: movescu 失敗 (exit=2): … Connection refused` がエンドポイントに出ることを確認済み。

---

## 5. i18n キー（en / ja）
```
system.log / system.memoryMonitor / system.memoryMonitor.desktopOnly / system.memoryMonitor.failed
log.count / log.autoscroll / log.copy / log.clear / log.empty
help.community / help.contact
help.contact.title / .intro / .emailLabel / .emailDesc / .emailBtn
help.contact.bugLabel / .bugDesc / .bugBtn
help.contact.sponsorLabel / .sponsorDesc / .sponsorBtn
```
- メニューラベル `help.community` = "User's community"、`help.contact` = "Contact to developer" は依頼どおり両ロケールとも英語表記。

---

## 6. 要確認事項 / TODO
- **Sponsors URL**：依頼値 `https://github.com/sponsors/accounts` は GitHub Sponsors の汎用ページ。開発者個別ページ（例 `https://github.com/sponsors/tatsunidas`）にする場合は `frontend/src/help/links.ts` の `HELP_LINKS.sponsors` を変更。
- **Linux のシステムモニタ**：環境にインストール済みのツール名が候補リストに含まれるか要確認（`which gnome-system-monitor plasma-systemmonitor ksysguard ...`）。
- **Log のスコープ**：現状は各ウィンドウ個別。全ウィンドウ集約が必要なら main プロセスにログ集約バッファ＋IPC 転送を追加する拡張余地あり。
- **Help メニューのショートカット項目**：2D Viewer の Help には keyboard shortcuts 項目を入れていない（グローバルショートカットからは利用可）。必要なら追加。

---

# 追記: 起動時のプラグインロード確認 & スプラッシュ表示

同一セッションの追加作業（2026-07-02）。検証: `mvn -o compile` = BUILD SUCCESS。

## 調査結果（従来の挙動）
- スプラッシュの進捗プロトコルは `{ step, state, message }`（`__GRAPHY_PROGRESS__{json}` を backend stdout → Electron main が解析）。step: `init/folders/database/plugins/scp/ready/error`、state: `running/ok/error`。
- **プラグインの `plugins` ステップはプレースホルダだった**：`StartupProgressListener.java` が `running` → `ok` を実処理なしで連続 emit（明示的 TODO）。
- プラグインは**遅延ロードのみ**：`FileSystemPluginRegistry.discoverAll()`（`<root>/*/plugin.json` 走査）や JAR ロードは `PluginController` の REST 呼び出し時にだけ実行。起動時に走査・検証していない。
- `/api/status` にもプラグイン情報は無い。ヘルスチェックはプラグインを待たない。
- **スプラッシュは backend の動的 message を無視**していた（`T[step] || message` の順で、既知 step は常に固定ラベル表示）。

## 変更内容
### backend: `StartupProgressListener.java`
- `ApplicationStartedEvent` で `reportPlugins(ctx)` を呼び、実際に `PluginRegistry#manifests()`（= `discoverAll()`）を走査。
- コンテキスト refresh 済みの `started.getApplicationContext().getBeanProvider(PluginRegistry.class)` から bean を取得（listener は Spring bean ではないためイベントの context 経由で解決）。
- `plugins` → `ok` の message に**件数（数値）のみ**を送り、表示文言はスプラッシュ側でローカライズ。例外時は `error` 状態＋例外メッセージ。
- 「ロード確認」は manifests 走査・検証まで（JAR 実体化は従来どおり実行時遅延ロードのままにし起動を重くしない）。プラグイン失敗は起動をブロックしない（error 表示のまま `ready` へ進む）。

### desktop: `splash.html`
- I18N に `pluginsDone / pluginsNone / pluginsFailed`（ja/en）を追加。
- `labelFor(step, state, message)` を新設し `plugins` を状態＋件数から動的表示：
  - `ok` かつ n>0 → 「プラグインを読み込みました (n)」/「Plugins loaded (n)」
  - `ok` かつ n=0 → 「プラグインはありません」/「No plugins」
  - `error` → 「プラグインの読み込みに失敗しました: <msg>」
  - `running` → 「プラグインを読み込んでいます」/「Loading plugins」
  - その他の step は従来どおり `T[step] || message || step`。

## 変更ファイル
- `backend/src/main/java/com/vis/graphynext/startup/StartupProgressListener.java`
- `desktop/splash.html`

## 補足 / TODO
- 現状は「発見できたマニフェスト件数」を成功として表示。`discoverAll()` は壊れた `plugin.json` を warn ログでスキップするため、**スキップ件数はスプラッシュに出ない**。厳密な失敗検知が必要なら `discoverAll()` に総数/失敗数を返す口を足す拡張余地あり。
- 必要なら `/api/status` にプラグイン件数を載せてヘルスポール側でも検証可能にできる（今回は未対応）。
