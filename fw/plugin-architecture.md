# GRAPHY-Next プラグイン アーキテクチャ設計

> 作成日: 2026-06-28（更新: 2026-07-29 — **§7 host API の拡張（優先度 高・未着手）を追加**）
> ステータス: 骨格実装済み（standalone/web の両モードで疎通確認済み。署名は実装済み、サンドボックスは将来）
>
> ⚠ **次に着手すべきはここ → [§7 host API の拡張](#7-host-api-の拡張優先度-高未着手)**。
> 2D ビューアのプラグインが「いま何を見ているか」を問い合わせられない状態で、
> 画像処理系プラグインが成立しない。
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
  エンドユーザーはアップロード不可。`WebPluginRegistry` は「配備済み一覧」を返すだけ
  （`run()` は常に `UnsupportedOperationException`＝501。JAR バックエンド実行はサンドボックス実装まで
  web では一切できず、動くのは UI のみプラグインだけ）。
- **サンドボックス方式（自由だが重い）**: 信頼できないプラグインも動かすなら、別プロセス / 別コンテナ
  （gVisor 等）/ サイドカー マイクロサービスとして隔離実行し、定義済み API 越しに呼ぶ。共有 JVM には load しない。
- **テナント単位**: 各病院が自分のサーバーインスタンスを持つなら、その plugins はテナント管理者が配備＝実質①。
- **実際のデプロイ（demo.vis-ionary.com）で確認した制約**: `deploy/demo/Dockerfile` は `WORKDIR /app` +
  `mkdir -p /app/plugins` でイメージに空フォルダを焼き込むが、`deploy/demo/docker-compose.yml` は
  `/app/data`（H2/DICOM 用の名前付きボリューム）だけをマウントし、`/app/plugins` はマウントしていない。
  さらにコンテナは `read_only: true`（`cap_drop: [ALL]` 含むハードニング済み）。したがって**現状、
  コンテナ起動後に `/app/plugins` へ書き込む手段が無い**——実行時アップロードはおろか、稼働中コンテナへ
  `docker cp` する運用も `read_only` により不可。プラグインを追加するには
  `Dockerfile` に `COPY <plugin-dir> /app/plugins/<id>` を追加してイメージへ焼き込み、`/demo-deploy` の
  手順でビルド・再デプロイするしかない（＝プラグイン追加そのものがコードの変更・デプロイ扱いになる）。
  実行時に差し替え可能にしたい場合は `/app/plugins` 用の別ボリュームマウントを追加する必要があるが、
  2026-07-17 時点ではまだ対応していない（将来課題）。

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

**残（将来）**: web のサンドボックス実行、権限モデルの強制、WASM、ツールバー surface の描画。
（署名検証は 2026-07-28 に実装済み → [`plugin-manager-design.md`](plugin-manager-design.md) §5.2）

---

## 7. host API の拡張（優先度 高・H1/H2 実装済み）

> 起票: 2026-07-29 ／ ステータス: **H1・H2 実装済み（2026-07-29）／ H3・H4 未着手** ／ 優先度: **高**
> 経緯: プラグイン デモ 3 本（[`plugin-explainer.md`](plugin-explainer.md) §6）を書いた過程で、
> **2D ビューアのプラグインには「いま何を見ているか」を答える手段が一つも無い**ことが判明した。

### 7.1 問題

`Viewer2DMenuBar.tsx` が組み立てる host の中身は次だけである。

```ts
{ surface, pluginId, t, notify, runBackend, actions }
```

`actions`（`Viewer2DToolbar.tsx` の `ViewerActions`）は 30 個ほどあるが、**すべて `void` を返すコマンド**で、
「対象タイルにこれをやれ」と命令できるだけ。**問い合わせが一切できない。**

| プラグインが知りたいこと | いまの host |
|---|---|
| どのシリーズを見ているか（study / series UID） | ✗ |
| いま何スライス目か | ✗ |
| 画素（生の HU / SUV、あるいは 8bit でも） | ✗ |
| 適用中の W/L | ✗（`setWindowLevel` はあるが getter が無い） |
| 描いた ROI / マスク | ✗ |
| 処理結果をビューアへ戻す | ✗ |

比較として `MainScreenPluginHost` には `selectedStudyUid` がある（`pluginTypes.ts`）。**2D ビューア側だけが
それすら持っていない**という非対称になっている。

**現に起きている実害**: デモ 2・3 は本体の内部 DOM（`data-tile-id` 属性）とキャンバス読み取りで
代替している。これは公式契約ではないのでタイルの実装が変われば黙って壊れる。しかも canvas から取れるのは
**W/L 適用後の 8bit RGBA** なので、平均化フィルタの結果は「見た目の平滑化」にしかならず、
**HU に対する定量処理には使えない**（デモ 2 の README で断り書きにせざるを得なかった）。

**能力自体は既にある**: `frontend/src/viewer/debugApi.ts` の `window.__graphyDebug` が、
ビューポート列挙・現在 `imageId`・カメラ幾何・W/L・colormap の取得をすべて実装している。
ただし `import.meta.env.DEV` ガード付きで**配布ビルドには入らない**（automator 専用のため）。
H1・H2 は実質「これを本番向けの契約として切り出す」作業である。

### 7.2 フェーズ

| # | 内容 | 追加する host API | 依存・難所 | 両モード |
|---|---|---|---|---|
| **H1** ✅ | **対象タイルの識別情報**。DOM 依存（`data-tile-id`）を公式契約へ置換 | `getTargets() => ViewerTarget[]` | 「対象」の定義を `runViewerCommand` と揃える（選択タイル→無ければ全タイル） | ✅ |
| **H2** ✅ | **表示状態の問い合わせ**。`debugApi` の相当機能を本番契約へ昇格 | `getViewState(tileId?) => ViewerViewState \| null` | `debugApi.ts` から共有ロジックを切り出し、DEV ガードの外へ | ✅ |
| **H3** | **画素の読み出し**（本命） | `getPixelData(tileId, opts?) => Promise<{ data: Float32Array, rows, cols, spacing, unit }>` | **必ず [`pixelCalibration.ts`](../frontend/src/viewer/pixelCalibration.ts) 経由**（`getPixelData()` に直接 slope/intercept を書かない。preScale 既定 ON による二重適用で CT が約 −1024 ずれる既知事故）。シリーズ全スライスは転送量が大きいのでスライス単位を既定にし、範囲指定を任意で | ✅ |
| **H4** | **書き戻し** — 処理結果をオーバーレイ表示 / 新シリーズとして保管庫へ | 未定（`showOverlay()` / `saveDerivedSeries()`） | 設計判断が要る（派生シリーズの UID 生成・SEG との棲み分け・web での書き戻し先）。**H1〜H3 とは分けて扱う** | 要検討 |

H1〜H3 は**フロント面だけで完結**するため、web モードでも同じように動く（backend の契約 `/api/plugins` は不変）。

#### H1・H2 の実装（2026-07-29・GRAPHY-Next 0.1.9 以降）

```ts
host.getTargets(): ViewerTarget[]              // 選択タイル→無ければ全タイル（actions と同じ対象）
host.getViewState(tileId?): ViewerViewState | null   // 省略時は対象の先頭タイル
```

| 型 | フィールド |
|---|---|
| `ViewerTarget` | `tileId` / `studyUid` / `seriesUid` / `seriesLabel` / `imageId` / `sliceIndex` / `sliceCount` / `c` / `t` / `modality` |
| `ViewerViewState` | `tileId` / `windowCenter` / `windowWidth` / `unit` / `colormap` / `invert` / `flipH` / `flipV` / `rotation` / `zoom` / `pan` |

**起票時の素案から変えた点（意図的）**:

- `targets` を**配列プロパティではなく関数**にした。host はメニュークリック時に 1 度組み立てられるが、
  プラグインはダイアログを開いたまま残る。スナップショットを配ると、ユーザーがスライスを送った後に
  **黙って古いスライスを指す**。同じ理由で `getViewState` も毎回読む。
- `frameIndex` の代わりに **ZCT モデルの `c` / `t`** を出す（本体の多次元モデルがそれ）。
  併せて `seriesLabel` / `imageId` / `sliceCount` / `modality` を足した（いずれも取得コストゼロで、
  プラグインが「何を見ているか」を人に見せる・H3 のキーにするのに要る）。
- 表示状態は生の `camera` ではなく `zoom` / `pan` / `rotation` / `flipH` / `flipV`
  （`viewer/transform.ts` の `ViewTransform`＝Fit を 1.0 とする本体のモデル）で出す。
  Cornerstone のカメラをそのまま晒すと、3D ジオメトリの既知バグ（`cornerstone-3d-geometry-caveat.md`）と
  同じ罠をプラグイン作者に押し付けることになる。
- **W/L はモダリティ値空間**（CT なら HU、単位は `unit`）。表示 8bit ではない。
- `colormap` は**本体の内部名を出さない**。①グレースケール（`graphy-gray`）は `null` に畳む
  — 本体は「LUT 解除」を線形グレースケールの明示適用で表現しているが（Cornerstone が
  `colormap: undefined` を no-op にするため）、プラグインから見ればそれは「LUT 未適用」である。
  ②LUT は登録名 `graphy-lut-<LUT 名>` の接頭辞を剥がし、**ユーザーが LUT ダイアログで選んだ名前**
  （`"10_Percent"` 等）で返す。接頭辞は本体の実装詳細（`LUT_COLORMAP_PREFIX`）で、
  シリーズ Sync で伝播した colormap も同じ規則なので剥がすだけで済む。
  automator 側（`debugApi`）は生の名前のまま。

**実装（フロント面のみ・backend 変更なし）**:

| ファイル | 役割 |
|---|---|
| `viewer/viewportRead.ts`（新規） | DEV ガードの外へ出した読み取り専用ヘルパ（`voiToWindow` / `readVoiWindow` / `readColormapName` / `readInvert` / `readCamera`）。`debugApi.ts` と共用。テストは `viewportRead.test.ts` |
| `viewer/viewerCommands.ts` | タイル単位の問い合わせ `getTargetInfo()` / `getViewState()` をレジストリ契約に追加 |
| `viewer/Viewer2D.tsx` | 上記の実装（`roiContext` ＋ `imageIdsRef`/`indexRef`/`infoRef` ＋ `readTransform`）。表示単位は `imageInfo.ts` の `calibratedUnit()` に一本化しカーソル表示と共用 |
| `viewer2d/Viewer2DScreen.tsx` | `ViewerActions.getTargets` / `getViewState`（対象解決は `resolveTargets()` を命令系と共有） |
| `viewer2d/Viewer2DMenuBar.tsx` | host へ配線 |
| `plugins/pluginTypes.ts` | 公開契約 `ViewerTarget` / `ViewerTileViewState` を re-export し `Viewer2DPluginHost` に追加 |
| `plugins/mockPlugins.ts` | 配線確認用デモ `demo-context`（DOM を見ずにシリーズ名・スライス・W/L を通知） |

**未登録タイルは黙って除外される**（`queryViewerCommand` が null を返す）: Fusion の子ビューポートや
アンマウント途中のタイルは `getTargets()` に現れない。プラグイン側は**空配列を必ず扱う**こと。

#### 実機検証（2026-07-30・standalone / Linux）

**本物の Electron ＋ 本物の backend ＋ 本物のプラグイン配信経路**（`plugins/` フォルダ直下に置いた
第三者プラグインを `/api/plugins` から ES モジュールとして配信）で 26 項目すべて合格。
ドライバは `automator/src/spike/hostApiCheck.ts`（`cd automator && npx tsx src/spike/hostApiCheck.ts`）、
検証用プラグインは `automator/.results/run-data/desktop/plugins/hostapi-check/`（fixture は ct-basic）。

確認できたこと:

- Plug-ins メニューに出て、`ui.js` が **DOM を一切覗かずに** シリーズ/スライス/W/L を取得できる
  （`data-tile-id` もキャンバス読み取りも使っていない）。
- 値が画面表示と一致する: パネルの `slice=1/50` `W/L=250/40 HU` が
  スライダー `Z 1/50`・オーバーレイ `W/L 40/250` と一致。
- **毎回読み直している**: スライダーで 13 枚目へ送り、W/L プリセット（brain）と階調反転を当てて
  再実行すると `sliceIndex=12` / `imageId` 変化 / `W/L=80/40` / `invert=true` に追従。
  ＝ 素案のスナップショット方式なら古い値を返していた箇所。
- LUT 適用後の `colormap` が `"10_Percent"`（内部名 `graphy-lut-10_Percent` ではない）。
  **この実機確認で内部名の漏れを見つけて上記の接頭辞剥がしを入れた**。
- 未知の `tileId` は `null`（例外にしない）。

副産物の修正: `automator/src/driver/desktopDriver.ts` が **DevTools ウィンドウをメイン画面と
誤認する**バグを直した（`window` イベント発火時の url が about:blank だと predicate に外れ、
timeout → `firstWindow()` フォールバックが `devtools://…` を返していた。「MainScreen が出ない」と
2 回誤検知した）。現存ウィンドウを url でポーリングして選ぶ方式に変更。

### 7.3 副作用（着手時に必ずセットで行うこと）

- ✅ **型定義の同期（本体側 1/5）**: `examples/plugin-template/graphy-plugin.d.ts` に `ViewerTarget` /
  `ViewerViewState` / `getTargets` / `getViewState` を追加済み（README・`ui.js` のコメント例も）。
- 🔴 **残: 外部デモ 4 リポジトリの `graphy-plugin.d.ts`**（[demos ハブ](https://github.com/tatsunidas/graphy-next-plugin-demos) /
  hello / mean-filter / gemini-findings）。本体リポジトリからは触れないので**別作業**。
- **`engines.graphy` の下限**: 新 API を使うプラグインは `">=0.1.9"` へ上げる
  （`engines` 互換判定は展開前に効くので、古い本体には入らなくなる＝正しい挙動）。
  テンプレート自身は新 API を使っていないので `">=0.1.0"` のまま据え置いた。
- 🔴 **残: デモの書き換え**: [mean-filter](https://github.com/tatsunidas/graphy-next-plugin-mean-filter) と
  [gemini-findings](https://github.com/tatsunidas/graphy-next-plugin-gemini-findings) の
  `findOpenTiles()`（DOM 依存）を `getTargets()` へ差し替え、README の「できないこと」節を更新する。
  ただし**画素の定量処理は H3 が要る**ので、「canvas の 8bit しか読めない」旨の断り書きは H3 まで残る。
- ✅ **`fw/plugin-authoring-guide.md` §2-3 の host 表**と [`plugin-explainer.md`](plugin-explainer.md) §7 の
  制約記述を更新済み。

### 7.4 やらないこと（この範囲では）

- **`ui.js` からの外部 API 呼び出し**は依然できない（本番 CSP の `connect-src` が localhost 限定。
  [`security.md`](security.md)）。外部通信は JAR 側に置く方針を変えない。緩めると
  「プラグインが任意の外部へ患者データを送れる」ことになり、CSP を置いた意味が消える。
- **権限（`permissions`）の実強制**とサンドボックスは別課題（`plugin-manager-design.md` §8 の P3）。
  H3 で画素が読めるようになるほど `read-pixels` の実強制の必要性は上がるので、**H3 と P3 の順序は
  着手時に再検討する**。
