# GRAPHY-Next プラグイン アーキテクチャ設計

> 作成日: 2026-06-28（更新: 2026-07-17 — standalone のプラグイン格納先を実装（resolveDataDir）に合わせて訂正）
> ステータス: 骨格実装済み（standalone/web の両モードで疎通確認済み。サンドボックス/署名は将来）
> 関連: [`development-phases.md`](development-phases.md)、[`dicom-data-layer.md`](dicom-data-layer.md)

GRAPHY のプラグイン機構を、standalone / web の 2 モードに対応する形で再設計する。

---

## 1. GRAPHY 現状（出発点）

- `plugins/` フォルダに **Java の JAR**（例: `ComputedDWI`, `LesionEvanesco`）を置く。
- `PluginShelf` ＋ `PluginClassLoader`（URLClassLoader）が起動時にフォルダを走査し、
  **`PlugIn` インターフェース**（`ToolbarPlugIn`＝ツールバー追加、`PlugInFunction` 等）を実装した
  クラスを `Class.getDeclaredConstructor().newInstance()` で生成、`run(args)` で実行。
- つまり **「Java コードを JVM 内に動的ロードし、ツールバー追加＋画像処理を行う」in-process 方式**。

---

## 2. GRAPHY-Next の基本モデル: プラグインは“2 面”

Spring Boot(Java) ＋ React(JS) の分離構成のため、1 プラグインが最大 2 つの成果物を持つ。

| 面 | 中身 | 実行場所 |
|---|---|---|
| **バックエンド面** | 計算・画像処理（Java JAR） | Spring Boot の JVM |
| **フロント面** | ツールバー / パネル等の UI（JS / ES モジュール） | ブラウザ（React） |

両者を **`PluginRegistry` という継ぎ目**で抽象化する（`DicomDataService` と同じ思想）。
フロントは常に **`GET /api/plugins`（マニフェスト）** を叩くだけで、プラグインの出所を意識しない。

```
React  ──fetch /api/plugins──▶ マニフェスト(id, 名前, UIバンドルURL, backend entrypoint, 必要権限)
  │                                    ▲
  └─動的 import(UIバンドル)            │ StandalonePluginRegistry / WebPluginRegistry
                                       │
ツール実行 ──POST /api/plugins/{id}/run──▶ backend の処理（JAR内の処理 or サンドボックス）
```

### プラグイン マニフェスト（案）
```json
{
  "id": "computed-dwi",
  "name": "Computed DWI",
  "version": "0.0.1",
  "frontend": { "bundleUrl": "/api/plugins/computed-dwi/ui.js", "contributes": ["viewer2d.menu"] },
  "backend":  { "entrypoint": "com.vis.plugins.ComputedDwi", "permissions": ["read-pixels"] }
}
```

`contributes` は「UI のどの面にプラグインを出すか」を示す **surface（挿入先）** の配列。
詳細は [§2.1 挿入先（surface）と 2 つの Plug-Ins メニュー](#21-挿入先surfaceと-2-つの-plug-ins-メニュー)。

---

## 2.1 挿入先（surface）と 2 つの Plug-Ins メニュー

GRAPHY と同様、プラグインは **どの画面のどのメニューに出るか** で 2 系統に分かれる。
これを `contributes` の **surface 語彙**で表現する（1 プラグインが複数 surface を指定してもよい）。

| surface 値 | 出る場所 | 用途（GRAPHY 対応） |
|---|---|---|
| `viewer2d.menu` | **2D Viewer の「Plug-ins」メニュー** | 表示中の画像に対する処理・ツール追加（旧 `ToolbarPlugIn` 相当） |
| `viewer2d.toolbar` | 2D Viewer のツールバー | 同上（ボタンとして常設したい場合） |
| `mainscreen.menu` | **MainScreen の「Plug-Ins」メニュー** | DB・その他機能に関するプラグイン（旧 `PlugInFunction` 相当） |

> 将来 surface は追加可能（例 `mpr.menu`, `slicer.menu`）。フロントは未知の surface を
> 無視する（前方互換）。

### 2 面 × 2 メニューの整理

- **2D Viewer 系プラグイン**（`viewer2d.menu` / `viewer2d.toolbar`）
  表示中のシリーズ／選択タイルに対して処理する。フロント面 UI は既存の
  `viewerCommands.ts` の `runViewerCommand(tileIds, cmds => …)` に乗り、必要なら
  バックエンド面（`POST /api/plugins/{id}/run`）で重い計算を行う。
- **MainScreen 系プラグイン**（`mainscreen.menu`）
  スタディ／DB・エクスポート等、画像ビューアに依存しない機能。フロント面 UI は
  MainScreen のコンテキスト（選択スタディ等）を受け取り、バックエンド面を呼ぶ。

### フロント側の実装ポイント（両画面共通の仕組み）

両画面ともメニューは **データ駆動の配列**（`{ id, label, items[] }`）で定義済みのため、
`/api/plugins` の結果を該当 surface で絞って `items[]` に流し込むだけで組み込める。

- **2D Viewer**: `frontend/src/viewer2d/Viewer2DMenuBar.tsx` に既に `plugins` メニューの
  プレースホルダ（`viewer2d.menu.plugins` / `viewer2d.menu.pluginsNone`）がある。
  → `contributes` に `viewer2d.menu` を含むマニフェストを列挙し、`onClick` で
  `import(bundleUrl)` した UI を起動する。プラグインが無ければ従来どおり「（プラグインなし）」。
- **MainScreen**: `frontend/src/mainscreen/MenuBar.tsx` は現状 Plug-Ins メニュー未追加。
  → 新規に `plugins` メニュー（i18n キー `mainscreen.menu.plugins` 等）を追加し、
  `contributes` に `mainscreen.menu` を含むものを列挙する。
- 読み込みコード（`fetch("/api/plugins")` → surface 振り分け → 動的 `import()`）は
  **両画面・両モード共通**。1 箇所（例 `frontend/src/plugins/`）に集約する。

---

## 3. モード別の設計

### standalone（Electron + 同梱 Spring Boot）
- backend が **ローカルの `plugins/` フォルダを走査し JAR をクラスローダで読み込む**（GRAPHY と同じ）。
  単一ユーザー＝自分のマシンなので任意 JAR ロードは許容範囲。
- フロント面の JS バンドルも backend がそのフォルダから配信 → React が動的 import。
- **実装済みの解決方法**: `graphy.plugins.dir` の起動引数は渡していない。代わりに
  `desktop/main.js` の `resolveDataDir()` が backend の CWD 自体を、パッケージ版では
  **ユーザー書込可能な OS 標準データ領域**（Windows: `%APPDATA%\GRAPHY-Next`、macOS:
  `~/Library/Application Support/GRAPHY-Next`、Linux: `~/.config/GRAPHY-Next`）に固定する。
  `plugins/` は既定の相対パス（`./plugins`）のままこのデータ領域配下に作られるため、Electron の
  AppImage 等が読み取り専用でも書き込み可能な場所に自然と収まる（未パッケージの開発時は
  `process.cwd()`＝通常 `desktop/` を使う）。手順の詳細は
  [`plugin-authoring-guide.md` §4-1](plugin-authoring-guide.md#4-1-格納先ディレクトリ)。

### web（共有サーバー）
backend が**共有サーバー（マルチユーザーになり得る）**である点が決定的な違いを生む。

**① ユーザーが JAR をサーバーへ落として動的ロード、は不可（セキュリティ）**
共有 JVM に任意 JAR を読み込ませると、そのプラグインは**サーバー権限で全実行**＝他患者データ読み取り・
サーバー停止・他テナント侵害が可能。standalone の「フォルダから自由にロード」を web に持ち込めない。

**② web のバックエンド面プラグインは「運営が審査・配備」する**
- **管理者キュレーション方式（推奨・現実的）**: 運営（病院IT）が審査済み JAR をサーバー側へ配備。
  エンドユーザーはアップロード不可。`WebPluginRegistry` は「配備済み一覧」を返すだけ。
- **サンドボックス方式（自由だが重い）**: 信頼できないプラグインも動かすなら、別プロセス / 別コンテナ
  （gVisor 等）/ サイドカー マイクロサービスとして隔離実行し、定義済み API 越しに呼ぶ。共有 JVM には load しない。
- **テナント単位**: 各病院が自分のサーバーインスタンスを持つなら、その plugins はテナント管理者が配備＝実質①。

**③ フロント面は web も standalone も同じ**
UI バンドルは backend が ES モジュールとして配信し、React が `import()` で動的ロード。
`/api/plugins` の契約が同一なので、**フロントのプラグイン読み込みコードは両モード共通**。

**④ （将来オプション）クライアント側 WASM プラグイン**
web で計算もクライアント完結させたい場合、プラグインを **WebAssembly** で配布しブラウザ内サンドボックスで
実行する選択肢。サーバー負荷・隔離問題を回避できるが現時点では将来候補。

---

## 4. 対比まとめ

| | standalone | web |
|---|---|---|
| バックエンド面の入手元 | ローカル `plugins/` フォルダ（ユーザー書込可） | **運営配備 or サンドボックス**（ユーザーアップロード不可） |
| 信頼モデル | 単一ユーザー＝自己責任で任意ロード可 | 共有＝審査必須・隔離 |
| フロント面 | backend 配信の JS を動的 import | **同左（共通）** |
| 継ぎ目 | `PluginRegistry` + `/api/plugins` | **同左（共通）** |

**要点**: フロント面と契約（`/api/plugins`）は両モード共通。違いは
バックエンド面の「どこから・どの信頼レベルで load するか」だけ。standalone はローカルフォルダ、
web は運営配備 / サンドボックス。

---

## 5. 実装ステップ（将来）

1. `PluginRegistry` インターフェース + `PluginManifest` DTO。
2. `StandalonePluginRegistry`: `graphy.plugins.dir` を走査、URLClassLoader で JAR ロード、
   `PlugIn` 実装を検出（GRAPHY の `PluginShelf` を移植・整理）。
3. `WebPluginRegistry`: サーバー配備済みプラグインの一覧を返す（ユーザーアップロード不可）。
4. REST: `GET /api/plugins`（マニフェスト、`contributes` surface 付き）、
   `GET /api/plugins/{id}/ui.js`（UIバンドル配信）、`POST /api/plugins/{id}/run`（backend 処理実行）。
5. フロント: `/api/plugins` を取得 → surface で振り分けて動的 import で組み込む（両モード共通、`frontend/src/plugins/` に集約）。
   - `viewer2d.menu` / `viewer2d.toolbar` → 2D Viewer（既存プレースホルダを差し替え）。
   - `mainscreen.menu` → MainScreen（Plug-Ins メニューを新規追加）。
6. UI Phase 2 のツールバー／メニューは最初からこの契約に乗せる（後付けより楽）。
7. （後続）サンドボックス実行・権限モデル・署名検証・WASM 対応。

## 6. 実装状況（2026-07-02 時点）

ステップ 1〜5 の骨格を実装し、standalone / web 両モードで疎通確認済み。

**backend**（`com.vis.graphynext.plugin`）
- `PluginRegistry`（継ぎ目）/ `PluginManifest`（配信 DTO）/ `PluginDescriptor`（ディスク上 `plugin.json`）
- `FileSystemPluginRegistry`（フォルダ走査・UI 配信の共通基底）
- `StandalonePluginRegistry`（`@Profile("standalone")`。`graphy.plugins.dir` を走査し
  URLClassLoader で JAR ロード、`spi.GraphyPlugin` 実装を実行）
- `WebPluginRegistry`（`@Profile("web")`。一覧＋UI 配信のみ。`run()` は 501=サンドボックス未実装）
- `PluginController`: `GET /api/plugins`、`GET /api/plugins/{id}/ui.js`、`POST /api/plugins/{id}/run`
- SPI: `com.vis.graphynext.plugin.spi.GraphyPlugin`（`Object run(Map args)`。プラグイン JAR が実装）
- 設定: `graphy.plugins.{enabled,dir}`（`PluginProperties`、既定 `./plugins`）

**ディスク上のプラグイン形式**: `<dir>/<pluginId>/plugin.json`（`id,name,version,contributes[],ui?,entrypoint?,permissions[]?`）＋任意で `ui.js` / `*.jar`。例: リポジトリ直下 `plugins/sample-hello/`（UI のみ・両モード動作）。

**frontend**（`frontend/src/plugins/`）
- `pluginTypes.ts`（`PluginManifest`/`PluginSurface`/ホスト型/`PluginModule`）
- `pluginRegistry.ts`（起動時 `GET /api/plugins` 取得＋キャッシュ、動的 `import()`、`runPluginBackend`、
  フック `usePluginManifests`/`usePluginMenu`）
- `mockPlugins.ts`（backend 未起動時のフォールバックデモ。`MOCK_ENABLED`）
- 配線: `Viewer2DMenuBar.tsx`（`viewer2d.menu`）、`mainscreen/MenuBar.tsx`（`mainscreen.menu` を新設）

**残（将来）**: web のサンドボックス実行、権限モデルの強制、署名検証、WASM、ツールバー surface の描画。
