# GRAPHY-Next プラグイン アーキテクチャ設計

> 作成日: 2026-06-28（更新: 2026-07-30 — **§7 host API の拡張: H1〜H4b すべて実装済み**）
> ステータス: 骨格実装済み（standalone/web の両モードで疎通確認済み。署名は実装済み、サンドボックスは将来）
>
> ✅ **[§7 host API の拡張](#7-host-api-の拡張h1h4b-実装済み) は H1〜H4b すべて実装済み**
> （問い合わせ・画素読み出し・オーバーレイ表示・派生シリーズ保存）。画像処理系プラグインは
> 「読む → 計算する → 見せる → 残す」まで公式契約だけで書ける。
> **残る制約は ①`ui.js` から外部 API を叩けない（本番 CSP）②権限の実強制とサンドボックス（P3）
> ③H4b の web モード（STOW-RS 書き戻し）が未検証**。
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

## 7. host API の拡張（H1〜H9 実装済み）

> 起票: 2026-07-29 ／ ステータス: **H1・H2（2026-07-29）／ H3〜H7（2026-07-30）／ H8（2026-07-31）／ H9（2026-08-02）すべて実装済み**
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
| 描いた ROI / マスク | ROI=✅（H5）／ マスク（labelmap）=✗ |
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
| **H3** ✅ | **画素の読み出し**（本命） | `getPixelData(tileId?, opts?) => Promise<ViewerPixelData \| null>` | **必ず [`pixelCalibration.ts`](../frontend/src/viewer/pixelCalibration.ts) 経由**（`getPixelData()` に直接 slope/intercept を書かない。preScale 既定 ON による二重適用で CT が約 −1024 ずれる既知事故）。シリーズ全スライスは転送量が大きいのでスライス単位を既定にし、範囲指定を任意で | ✅ |
| **H4a** ✅ | **オーバーレイ表示** — 処理結果を表示中スライスに重ねる（保存しない） | `showOverlay(tileId?, overlay)` / `clearOverlay(tileId?)` | 値マップを受け取り**色付けは本体側**で行う。imageId に紐付け | ✅ |
| **H4b** ✅ | **派生シリーズ保存** — 新シリーズとして保管庫（standalone）/ PACS（web）へ | `saveDerivedSeries(tileId?, req)` | 既存 `POST /api/series/derived` を開ける形。**保存ポリシーが本体** | ✅（web も許可） |
| **H5** ✅ | **ROI（計測）の読み出し** — ユーザーが描いた計測をプラグインが使う | `getRois(tileId?)` / `getRoiMeta(roiUid)` / `setRoiMeta(roiUid, patch)` / `subscribeRois(cb)` | 幾何を本体に閉じる（長径・短径をプラグインに算出させない）。ROI は本体が永続化するので `roiUid` はアプリ再起動をまたいで有効。global ROI は `referencedImageId` が表示スライスへ追従する罠あり | ✅ |
| **H6** ✅ | **スタディの検査日** — 時系列評価に要る | `ViewerTarget.studyDate` / `ViewerRoi.studyDate` | DICOM の StudyDate から解決（画面の prop を引き回さない）。**解釈できない値は null**（日付差で結論が変わる評価に怪しい値を渡さない） | ✅ |
| **H7** ✅ | **患者キー** — 患者単位の記録を持つプラグインの鍵 | `ViewerTarget.patientKey` / `ViewerRoi.patientKey` | 本体が ROI を永続化する鍵と同じ値を出す。スタディ UID を鍵にすると同じ患者の別スタディで記録を見失う | ✅ |
| **H9** ✅ | **計測レポート（DICOM SR）** — 計測を保管庫 / PACS へレポートとして残す | `saveStructuredReport(tileId?, req)` | DICOM はプラグインに書かせない（H4b と同じ）。**確認ダイアログ抑止不可**／未知の計測種別は拒否／UNVERIFIED で保存。TID 1500 の形に沿うが完全準拠は主張しない | ✅（standalone。web は未対応） |
| **H8** ✅ | **プラグイン保存領域** — プラグインが計算した内容を患者単位で backend に保管 | `loadStore(patientKey?)` / `saveStore(json, opts?)` / `deleteStore(patientKey?)` | プラグイン id × 患者で領域を分け、**楽観ロックで上書き事故を防ぐ**。backend は中身を解釈しない。`localStorage` だと端末に閉じ、別 PC で過去の回が見えず判定が静かに変わる | ✅ |

| **H10** ✅ | **ボリュームの読み出し** — シリーズ丸ごとを**校正済み値＋患者 LPS の幾何**で読む | `loadVolume(ref, onProgress?)` / `estimateVolume(ref)` | 実装は `plugins/pluginVolumeApi.ts` ＝ **`regVolumeLoader` を公開しただけ**（計算を増やさない）。**1 回 1 ボリューム**（まとめて返すと呼び出し側がメモリを見積もらない）。`studyUid` 省略時は**開いているタイルからのみ**解決＝患者を跨いで読ませない | ✅ |
| **H21** ✅ | **位置合わせの実行とリサンプル** | `registerVolumes(req, onProgress?)` / `resampleVolume(src, transform, target)` | 実装は本体の `regWorkerClient`（剛体・非剛体とも Worker）＋ `registrationToTransform`。**プラグインのボリュームは受け取らない**（Worker へ転送すると呼び出し側の配列が detach される）。リサンプルの向きは pull-back、**範囲外は NaN** | ✅ |
| **H28** ✅ | **多フレーム NM（SPECT）の展開** — 断層をスライスとして開く | （API ではなく本体の挙動） | `NmFrameExpander`（`XaFrameExpander` / `SegFrameExpander` と同じ形）。**NM はルートに IPP/IOP を持たない**ので、`DetectorInformationSequence` ＋ `SpacingBetweenSlices` から per-frame の位置を作る。**間隔が無ければ座標を作らない**（捏造しない） | ✅ |
| **H35** ✅ | **空間校正の値と出自** — 「近似か実測か未校正か」をプラグインが言えるようにする | `getSpatialCalibration(tileId?) => ViewerTileSpatialCalibration \| null` | 実装は `viewer/xaCalibrationProvider.ts` への委譲＋純関数 `xaCalibration.toViewerSpatialCalibration()`（**校正の単一入口**を守る）。🔴 **未校正を数値で埋めない**——検出器面の値は `detectorMmPerPx` に分けて渡し、`mmPerPx*` は null のまま。埋めると受け手は**未校正の画像を mm で測る**（値がそれらしいので誰も気付かない）。⚠️ **書く口は作らない**（校正を確定するのは本体だけ。`fw/angio-design.md` §7.2） | ✅（XA / XRF のみ。他モダリティは出自の概念が無いので null） |
| **H36** ✅ | **XA の表示状態** — DSA（差分）中かどうか・マスク・シフト・フレーム軸 | `getXaState(tileId?) => ViewerTileXaState \| null` | 🔴 **差分中は画素の意味が反転する**（血管が正の大きな値）。合成 imageId（`graphy-dsa:`）は元の URL を持たないので**受け取った側からは見分けられない**——知らずに測ると**例外も警告も出ずに違う径が出る**。実装は `dsaLoader.dsaStateForImageId()`（トークンの解析はローダ内に閉じる） | ✅ |
| **H37** ✅ | **アンギオ解析 SR の保存** — 本体の解析ダイアログと**同じ SR** をプラグインから書く | `saveAngioReport(tileId?, req) => Promise<ViewerSrResult>` | 中身も書き手も本体と同一（`QcaSrWriter` 等）。違うのは**出所の記録が必須**なことだけ（`[Plugin] ` ＋ `ContributingEquipmentSequence`）。🔴 **スタディはプラグインが選べない**（表示中のもの）。参照 SOP が**そのタイルの並びに無ければ拒否**——書き手は参照インスタンスから患者・スタディを継承するので、他患者の SOP を渡せると**その患者の検査にレポートが生える**。知らない `kind` は backend が 400 で拒否（H9 と同じ＝黙って落とさない） | ✅（standalone。web は未確認） |
| **H38** ✅ | **表示状態（XA GSPS）の保存** — DSA のマスク・シフト・VOI・空間校正・描画を残す | `savePresentationState(tileId?, req) => Promise<ViewerSrResult>` | 書き手は本体と同じ `XaPresentationStateWriter`（**XA/XRF GSPS 11.5** のまま＝DSA を保存できる唯一の器）。H37 と同じ制約（スタディは本体が入れる／参照 SOP が開いている並びに無ければ拒否）。⚠️ **読み込み（適用）の口は作らない**——GSPS をビューポートへ当てるのは表示の仕事で、プラグインは当たった結果を H35 / H36 で見れば足りる | ✅（standalone。web は未確認） |
| **H39** ✅ | **解析結果をレポートへ差し込める形で登録する**（A14 の登録簿へ積む） | `publishAnalysisResult(tileId?, input) => { ok, error? }` | **DICOM を書かないので確認ダイアログは出さない**（実際に差し込むのは利用者の操作）。host が入れる: **id の名前空間**（🔴 素通しにすると**プラグインが本体の解析結果を差し替えられる**——登録簿は id が同じ記録を置き換える）／スタディ・シリーズ／出自のプラグイン名と版／研究用の 1 行。🔴 **`caveats` は 1 つ以上必須**——host が研究用の 1 行を足すので形式上は空でも通るが、**その解析に固有の限界を知っているのはプラグイン側だけ** | ✅ |

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

#### H3 の実装（2026-07-30・GRAPHY-Next 0.1.9 以降）

```ts
host.getPixelData(tileId?, opts?): Promise<ViewerPixelData | null>   // opts = { sliceIndex? }
```

| フィールド | 意味 |
|---|---|
| `data` | `Float32Array`（row-major・`data[y * cols + x]`）。**モダリティ値**＝CT なら HU、SUV 校正済み PET なら SUV。表示 W/L は掛かっていない |
| `unit` | `"HU"` / `"SUVbw"` / `""` / カラーは `"raw"`（`imageInfo.calibratedUnit()` ではなく `readModalitySlice()` の判定） |
| `rows` / `cols` | `data.length === rows * cols` |
| `spacing` | `[列方向(x), 行方向(y), スライス方向(z)]` mm。不明な軸は `null` |
| `imageId` / `sliceIndex` | 実際に読んだスライス |

**読み出しは [`pixelCalibration.readModalitySlice()`](../frontend/src/viewer/pixelCalibration.ts) に委譲する**
（＝校正の単一入口。`getPixelData()` に直接 slope/intercept を書くと preScale と二重適用になり
CT が約 −1024 ずれる既知事故。CLAUDE.md のルール 2）。カラー（RGB）は同関数が輝度へ落とす。

**決めたこと**:

- **1 回 1 スライス**。素案にあった「範囲指定」は入れなかった。512×512×500 を Float32 で
  一度に返すと 500MB を超え、プラグインが安易に全巻取得を書けてしまう。シリーズを回したいなら
  `sliceIndex` を変えて `await` を繰り返す（1 枚ずつ解放できる）。
- **範囲外の `sliceIndex` は `null`（拒否）**。`count-1` へ丸めると「999 枚目をくれ」と書いた
  プラグインが末尾スライスの値を掴んだまま気付かない。純関数
  `viewportRead.resolveSliceIndex()` に切り出してテストしてある。
- 面内 spacing は要求スライスの `ImageInfo` から、**スライス間隔はシリーズ単位の値**を流用する
  （非等間隔シリーズの扱いは `ImageInfoPanel` と同じ＝`sliceSpacingSource` を見る運用）。
- **`Float32Array` はコピーせずそのまま渡す**（同一レンダラ内の ES モジュールなので構造化複製は
  発生しない）。プラグインが書き換えても本体の表示には影響しないが、返り値を保持し続ければ
  メモリは掴まれたままになる。

**権限について（P3 との順序を再検討した結果）**: H3 は **`read-pixels` の強制を伴わない**。
理由は、プラグインは既に本体と同じ権限で動いており（JAR 面はファイルシステムにも到達できる、
UI 面もキャンバスから 8bit を読める）、H3 で増えるのは「生 HU が取りやすくなること」だけで、
**信頼境界そのものは変わらない**から。ここで宣言ベースの偽の強制を足すと、
サンドボックス（`plugin-manager-design.md` §8 の P3）が入っているかのような誤解を生む。
代わりに **`plugin.json` の `permissions` に `read-pixels` を宣言する運用**とする
（導入時の同意画面に表示される既存の仕組みに乗る）。実強制は P3 とセットで行う。

#### H4a の実装（2026-07-30・GRAPHY-Next 0.1.9 以降）

```ts
host.showOverlay(tileId?, overlay): boolean     // overlay = { data, rows, cols, window?, colormap?, opacity? }
host.clearOverlay(tileId?): void
```

**プラグインは「値」を渡し、色付けは本体がする。** RGBA を組ませると W/L の意味・LUT・透明度の扱いが
プラグインごとにばらつき、本体の LUT 資産（`/api/luts` の 106 種）も使えない。`colormap` に LUT 名を
渡せば本体が `fetchLutData()` で取って色付けする（取得失敗時はグレースケールで描く＝結果は見える）。

- **`NaN` は透明**。マスクや部分的なマップをそのまま渡せる（α は値で変調せず `opacity` 一定＝
  マスクの縁が半端に薄くならない）。
- `window` 省略時は `NaN` を除く min/max で自動。定数マップ（全部 1 のマスク等）は幅 0 になるので
  一律最大濃度で描く。
- **rows/cols が現在スライスと不一致なら拒否（false）**。勝手に伸縮すると座標の意味が壊れる。
- **オーバーレイは「出したスライス」に紐付く**（`imageId` で束ねる）。他スライスでは自動的に隠れ、
  戻ると再表示。シリーズ / C・T 切替（`stackKey` 変化）では破棄する。
  送った先の画像に他スライスの計算結果が重なって見えるのが最悪なので、そこを構造で防いでいる。
- **出所ラベルを本体が必ず出す**（画像左下に `プラグイン: <マニフェストの表示名>`）。
  ラベル文字列はプラグインに触らせない（host が `m.name` を注入する）。i18n は ja/en 両方。
- 純ロジックは `viewer/overlayRaster.ts`（`autoWindow` / `toGrayLevel` / `rasterizeOverlay`）に
  切り出してテスト。描画は `Viewer2D` 内の canvas を `imageRect` に合わせて重ねるだけで、
  Fusion の `renderOverlay` 経路とは独立（互いに干渉しない）。

#### H4b の実装（2026-07-30・GRAPHY-Next 0.1.9 以降）

```ts
host.saveDerivedSeries(tileId?, {
  seriesDescription, frames: [{ sliceIndex, data }], rows, cols, unit?, derivationDescription?,
}): Promise<{ ok, cancelled?, seriesInstanceUid?, instanceCount?, error? }>
```

**幾何はプラグインに書かせない。** 各フレームは「元シリーズのどのスライスに対応するか」
（`sliceIndex`）だけを申告し、IPP / IOP / PixelSpacing / スライス厚は本体が元シリーズから引き継ぐ。
プラグインに座標を組ませると、**実空間の意味が壊れた派生シリーズを保管庫に作れてしまう**。
`rows`/`cols` は元スライスと一致必須（不一致は拒否）。

**検証は同意より先。** `validateDerivedSeries()` をレジストリに分けて、画面側が
**確認ダイアログを出す前に**通すようにした（通らない要求でユーザーに確認を見せない）。
保存本体でも再度検証する（多重防御）。

**画素の符号化**（`viewer/derivedSeriesEncode.ts`・純関数＋テスト）:

| 入力 | 扱い |
|---|---|
| 整数かつ Int16 に収まる（HU 等） | **恒等**（`slope=1, intercept=0`）＝量子化誤差を足さない |
| それ以外（確率マップ 0〜1、テクスチャ特徴量…） | 値域を Int16 全域へ線形写像し、`slope`/`intercept` を DICOM に書く |
| 定数マップ・有効値なし | 恒等（量子化しても意味が無い） |
| `NaN` | プラグインが `background` で**明示した値**。未指定なら**保存要求を拒否**（下記） |

**`NaN`（データ無し）は背景値を明示させる**（2026-07-30 の人手テストで修正）: 当初は
「有効値の最小値」を既定にしていたが、**閾値マスクでは有効値がすべて閾値以上なので背景が閾値そのものの
値になる**（≧300 HU のマスクで背景が 300 HU＝「何も無い場所」が骨と同程度の HU を持つ）。
実機で保存したシリーズの画素が `[300\300\300…]` になっていて発覚した。
何を背景と呼ぶかはプラグインしか知らないので、**`background` 未指定で `NaN` を含む要求は
（同意を求める前に）拒否**する。範囲外 `sliceIndex` や格子不一致を拒否しているのと同じ方針。
指定された背景は **`PixelPaddingValue`(0028,0120)** としても書くので、ビューアは「データ無し」として
扱える（W/L 自動計算や統計から外せる）。CT のマスクなら空気の −1000 が素直。

**backend 側の変更**（`DerivedSeriesRequest` / `DerivedSeriesService`）:

- `rescaleSlope` / `rescaleIntercept` / `rescaleType` を任意フィールドとして追加
  （**null なら従来どおり恒等**＝Slicer / Curved MPR の既存呼び出しは無変更）。
- `pixelPaddingValue` を追加（`NaN` を埋めた背景の格納値。null なら書かない）。
- `producer`（プラグイン id / 表示名 / 版）を追加。付いていると
  ①`SeriesDescription` に **`[Plugin] ` 接頭辞**（LO 64 文字に収める。接頭辞を優先して末尾を切る）、
  ②`DerivationDescription` に id・版を併記、
  ③`ContributingEquipmentSequence` を書く。
  規則は純メソッドに切り出して `DerivedSeriesDescriptionTest` で固定した。
- `ImageType` は**プラグイン出力では `DERIVED\SECONDARY`**（幾何があっても `RESLICE` を付けない。
  マスクや解析マップに `RESLICE` と書くと他システムを誤らせる）。本体機能（Slicer 等）は従来どおり
  `DERIVED\SECONDARY\RESLICE`。元 SOP への `SourceImageSequence`・Modality / SOPClassUID の維持は
  **既存の派生シリーズ経路そのまま**。

**同意ダイアログ**（`viewer2d/PluginSaveConfirmDialog.tsx`）: **抑止不可**（「次回から表示しない」を
用意しない）。プラグイン名・版・保存後の説明（接頭辞付き）・枚数・保存先（保管庫 / PACS）と、
**診断用に検証されたものではない**旨を提示する。`window.confirm` を使わないのは、Electron の
ネイティブダイアログがレンダラのキーボードフォーカスを奪う既知の問題（特に Linux/GTK）があり、
自動検証からも操作できないため。i18n は ja/en 両方。

**やらないこと**: プラグインが REST（`POST /api/series/derived`）を直接叩く経路は塞いでいない。
プラグインは本体と同じ権限で動く（`ui.js` は同一オリジンに fetch できる）ため、
**host API の外側は信頼境界ではない**。ここを塞ぐ意味が出るのは P3 サンドボックス以降。

#### H4b の方針 — 2026-07-30 に確定（上記の実装はこれに沿っている）

**土台は既にある**: `POST /api/series/derived`（`DerivedSeriesService`）が「元 Study/患者属性・Modality・
SOPClassUID・FrameOfReference を維持、Series/SOP UID を新規採番、`ImageType=DERIVED\SECONDARY`、
元 SOP への参照、`DerivationDescription`」まで実装済みで、Slicer の斜位リスライスと Curved MPR が使用中。
**web も対応済み**（テンプレートを WADO-RS `/metadata` から取り、STOW-RS で PACS へ書き戻す）。
つまり H4b は「DICOM を作る仕組みの新規実装」ではなく**既存経路をプラグインへ開ける作業**。

決定事項:

| 論点 | 決定 |
|---|---|
| 保存時の同意 | **本体が必ず確認ダイアログを出す（抑止不可）**。プラグイン名・バージョン・シリーズ説明・枚数を提示。プラグインが黙って書けるようにはしない |
| 出所の明示 | **機械可読 ＋ 一覧で見える接頭辞**。`ImageType=DERIVED\SECONDARY` ＋ `DerivationDescription` / `ContributingEquipmentSequence` にプラグイン id・版、加えて **`SeriesDescription` に接頭辞**（例 `[Plugin] …`）。他システムで開いても人が気付ける |
| web モード | **許可する**（standalone 限定にしない）。既存の STOW-RS 経路に乗る |
| 画素の符号化 | Float32 → Int16 ＋ **自動 slope/intercept**（プラグインの min/max から算出、`RescaleType` は `unit`）。既存経路は Rescale 恒等固定だが、それだと確率マップやテクスチャ値（0〜1）が 0/1 に潰れる |

**残っている検証**: **web モード（外部 PACS への STOW-RS 書き戻し）は未検証**。
実装は既存の web 分岐に乗るだけ（`DerivedSeriesService` がテンプレートを WADO-RS `/metadata` から取り、
`storeDatasets` で STOW）なので、コード上の追加はないが、実 PACS 相手の確認は
`deploy/dcm4chee/VERIFY-web.md` の手順に足す必要がある。

#### H5 の実装（2026-07-30・GRAPHY-Next 0.1.9 以降）

```ts
host.getRois(tileId?): ViewerTileRoi[]                       // 省略時は対象タイル全部
host.getRoiMeta(roiUid): Record<string, string>              // プラグイン名前空間の属性
host.setRoiMeta(roiUid, patch): boolean
host.subscribeRois(cb): () => void                           // 追加/変更/削除。差分は渡さない
```

**動機**: 計測ドリブンのプラグイン（RECIST 1.1・Choi・mRECIST・PERCIST・RANO…）は例外なく
「ユーザーが画像上に描いた計測値」を入力に取る。H1〜H4b が入っても**そこだけが埋まっていなかった**。
GRAPHY(Java) では `RoiObj.addRoiListener` に相乗りして実現していた部分に対応する。

| 型 | フィールド |
|---|---|
| `ViewerRoi` | `roiUid` / `tool` / `label` / `studyUid` / `seriesUid` / `sopInstanceUid` / `sliceIndex` / `zScope` / `c` / `t` / `points` / `spacing` / `measurements` / `visible` |
| `ViewerRoiMeasurements` | `length` / `shortAxis`（ツール値）／ `longAxisMm` / `shortAxisMm` / `longAxisEnds`（形状から算出）／ `area` / `mean` / `stdDev` / `min` / `max` / `unit` |

**決めたこと**:

- **長径・短径を 2 系統返す**。`Bidirectional` はユーザーが 2 軸を明示的に引くので `length` /
  `shortAxis`（ツール値＝読影医の意図）を、楕円・矩形・自由曲線は `longAxisMm` / `shortAxisMm`
  （形状から本体が算出）を使う。**黙って片方を代入しない**——「ユーザーが引いた軸」と
  「形状から機械的に出した軸」は臨床的に別物で、取り違えると測定値が変わる。
- **形状ベースの長径・短径は「輪郭ツール」にだけ出す**（`roiRead.hasShapeCalipers()` の許可リスト
  ＝ Length / 楕円 / 矩形 / 円 / 自由曲線 / スプライン / Livewire）。`Bidirectional` では出さない:
  ユーザーが引いた 2 軸そのものが計測値であり、しかも交差する 2 線分なので**短軸を長軸の端に寄せて
  引くとハンドル 4 点の最遠距離がユーザーの長軸を超える**（`sqrt(p²+(S/2)²) > L`。テストで実証）。
  Angle / CobbAngle（折れ線）・Probe（1 点）・ArrowAnnotate（注記）も対象外。
  **許可リストにしたのは除外リストで事故ったため**: `RectangleROI` は `angle` を部分一致で含む
  （Rect**angle**ROI）ので、除外正規表現に `angle` を書くと**矩形 ROI が黙って計測不能になる**。
  知らないツールには値を出さない（数値が出ないのは気付けるが、意味の違う数値は気付けない）。
- **幾何は本体に閉じる**（`viewer/roiRead.ts`）。算出は GRAPHY(Java) の `RecistCalculator` と同一
  アルゴリズム（①頂点を mm 空間へ ②最遠 2 点＝長径 ③長径に直交する方向の広がり＝短径）。
  総当たりの前に**凸包へ落としてある**（結果は同一・自由曲線の数千頂点でも重くならない）。
  プラグイン側に書かせると本体の計測値とずれたときどちらが正しいか言えなくなる。
- **短径は「長径に直交する幅」**であって全方位の最小キャリパ幅（ImageJ の MinFeret）ではない。
  RECIST が短径を長径に直交して測ると規定しているため。契約のコメントに明記した。
- **画素間隔が不明なら算出値は `undefined`**（mm を捏造しない）。統計も**取れない項目は `undefined`**
  にして 0 で埋めない（「測っていない」と「0 だった」を区別する）。`cachedStats` は
  Cornerstone が**描画時に**計算するので、まだ描画されていない ROI では空になり得る。
- **単位の取り違えを 2 箇所で塞いだ**（どちらも実機検証で発見）:
  ① `measurements.unit` は**統計値**（mean/stdDev/min/max）の単位なので `modalityUnit` のみを見る。
  Cornerstone の `cachedStats.unit` は**長さの単位**（"mm"）なので、フォールバックに入れると
  「統計の単位が mm」という無意味な値がプラグインへ流れる。
  ② **画素間隔が無いシリーズでは Cornerstone は length を px で計算する**。そのまま mm として
  渡すと単位が壊れるので、`length` / `shortAxis` は `lengthUnit === "mm"` のときだけ出す。
- **`getRois()` の既定対象は「対象タイル全部」**。H1〜H4b の「先頭タイル」と意図的に違える。
  時系列の計測ではベースラインと追跡を並べて開くのが普通で、都度 `getTargets()` を回させるのは
  この API の主用途に対して不便なため。単一タイルが欲しければ `tileId` を渡す。
- **順序を保証する**（スライス → `roiUid`）。Cornerstone の列挙順はツール登録順に依存するので、
  そのまま晒すと本体の内部事情がプラグインの表示順に漏れる。
- **ROI 属性は `plugin.<pluginId>.` 名前空間へ強制的に入れる**（前置は host が行う）。
  プラグインは本体や他プラグインのキーを踏めない。実体は `roiMaskStore` の `custom` で、
  ImageJ / DICOM 書き出し時に保持される既存の仕組みにそのまま乗る（GRAPHY の
  `lesionevanesco.*` プロパティと同じ発想）。
- **`subscribeRois` は差分を渡さない**。何が変わったかを契約にすると本体の annotation 表現に
  縛られるので、「変わった」だけ伝えて読み直させる（`RoiManagerPanel` と同じ流儀）。
  Cornerstone の `ANNOTATION_ADDED/MODIFIED/REMOVED` ＋ `roiMaskStore` の購読を 1 本に束ねている。
  プラグインの listener が投げた例外は host が飲む（本体を巻き込ませない）。

**併せて入れたもの — `BidirectionalTool` の登録**: RECIST 1.1 の計測は「長径＋それに直交する短径」で、
Cornerstone の `BidirectionalTool` がまさにそれなのに**未登録だった**（長さツール 2 本で代用すると
2 軸の対応付けが人手になる）。ROI メニューに「長径・短径（RECIST）」として追加した
（`cornerstoneSetup.ts` / `toolIds.ts` / `Viewer2D.tsx` の `MEASURE_TOOLS` / `toolIcons.ts` / i18n ja・en）。

**⚠ 未解決の制約（プラグイン作者向け）**:

- **ROI の永続化が無い**。本体の ROI は Cornerstone annotation state（メモリ）が権威で、
  再起動すると消える（`roi-manager-design.md` の M5＝ImageJ ROI / RTSTRUCT 往復が未完。
  書き出しはあるが「同じ UID で読み戻す」経路が無い）。したがって **`roiUid` はセッション内でのみ安定**。
  時系列で同じ病変を追うプラグインは `sopInstanceUid` ＋ `points`（画素座標）＋自身が振った ID で
  記録し、`roiUid` を鍵にしてはいけない。ROI 属性（`setRoiMeta`）も ROI と同じ寿命しか持たない。
- **global ROI（`zScope === "all"`）の罠**。本体は scope.z="all" の注釈の `referencedImageId` を
  表示スライスへ追従させる（`globalRoiSync.ts`）ため、`sliceIndex` / `sopInstanceUid` は
  「いまユーザーが見ているスライス」を指すだけで病変の位置ではない。**計測記録では弾くこと**。
  そのために `zScope` を契約に出してある。
- **ROI の書き込み（プラグインから ROI を作る・動かす）は入れていない**。読影医が引いた計測を
  プラグインが書き換えられると、計測の責任の所在が曖昧になる。必要になった時点で別途設計する。
- **マスク（labelmap）の読み出しは未対応**。ROI（ベクタ注釈）のみ。

**実装（フロント面のみ・backend 変更なし）**:

| ファイル | 役割 |
|---|---|
| `viewer/roiRead.ts`（新規） | 純関数。`convexHull` / `computeCalipers`（長径・短径）/ `hasShapeCalipers` / `distanceMm` / `readRoiStats` / `pluginMetaPrefix` ＋ `pickPluginMeta` / `buildPluginMeta`（属性の名前空間）。テストは `roiRead.test.ts`（38 件・解析解と突き合わせ＋名前空間の分離） |
| `viewer/viewerCommands.ts` | 契約 `ViewerRoi` / `ViewerRoiMeasurements` / `ViewerTileRoi`、レジストリに `getRois` / `getRoiMeta` / `setRoiMeta` |
| `viewer/Viewer2D.tsx` | 実装。表示スタックに乗っている annotation だけを返す。幾何は `roiRead` へ委譲 |
| `viewer2d/Viewer2DScreen.tsx` | `ViewerActions.getRois` / `getRoiMeta` / `setRoiMeta` / `subscribeRois`（対象解決は `resolveTargets()` を命令系と共有） |
| `viewer2d/Viewer2DMenuBar.tsx` | host へ配線。**`pluginId` は host が入れる**（属性名前空間をプラグインに選ばせない） |
| `plugins/pluginTypes.ts` | 公開契約に追加 |
| `plugins/mockPlugins.ts` | 配線確認用デモ `demo-rois`（ROI の 2 系統の長径・短径と `zScope` 警告を通知） |

#### 実機検証（2026-07-30・standalone / Linux）

**本物の Electron ＋ 本物の backend ＋ 本物のプラグイン配信経路**（`plugins/` フォルダ直下に置いた
第三者プラグインを `/api/plugins` から ES モジュールとして配信）で **H1〜H4b の 73 項目すべて合格**。
ドライバは `automator/src/spike/hostApiCheck.ts`（`cd automator && npx tsx src/spike/hostApiCheck.ts`）、
検証用プラグインの原本は `automator/plugins/`（`hostapi-check`＝H1〜H4a、`hostapi-save`＝H4b。
実行時に backend の plugins フォルダへコピーされる。fixture は ct-basic）。

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
- **H3 の画素が定量値である**こと: `512×512`・`unit="HU"`・`Float32Array`・
  `spacing=[0.644531, 0.644531, 5]`。腹部中央の画素が **−21 HU（軟部組織）** ＝
  **Rescale の二重適用が起きていない**（二重なら約 −1045 になる）。
  `min=−3024` は空気ではなく **GE の画素パディング**（raw −2000 ＋ intercept −1024）で、
  この fixture の性質。空気側で二重適用を判定しようとして最初に誤検知したので、
  検証は**軟部組織の値**で行うようにした。
- **W/L・階調反転・LUT を変えても同一スライスの画素値は不変**＝表示 8bit ではないことの直接確認。
- `sliceIndex` 明示指定で別スライスが読め、範囲外は `null`。
- **H4a のオーバーレイが実際に焼かれている**こと: `getPixelData()` で読んだ HU から閾値マスク
  （≧300 HU）を作って `showOverlay()` し、**キャンバスの中身を読んで α>0 の画素数 4681 が
  マスク該当数と完全一致**、指定 LUT（`Hot_Iron`）で色が付き、出所ラベルにマニフェストの表示名が出る。
  格子不一致のマップと未知 tileId は拒否。別スライスへ送ると隠れ、戻ると再表示される。
- **H4b が本当に DICOM になっている**こと（UI 越しではなく backend の一覧・タグダンプで確認）:
  確認ダイアログが出る → **拒否するとシリーズは作られない** → 承諾すると保管庫に 1 シリーズ増え、
  `SeriesDescription` が `[Plugin] Bone mask`、`ImageType=DERIVED`、`DerivationDescription` に
  `hostapi-save`、`ContributingEquipmentSequence` あり、**整数マスクなので Rescale は恒等**
  （`slope=1` / `intercept=0`）、`RescaleType=HU`、Modality は元のまま CT、**元シリーズは無変更**。
  格子が合わないフレームは**ダイアログを出す前に**拒否。
- **2026-07-30 の人手テストで H4b のバグを 1 件検出**（自動検証では気付けなかった）:
  保存したマスクの**背景が 300 HU** になっていた（`NaN` → 有効値の最小値という既定が、
  閾値マスクでは閾値そのものを指す）。`background` の明示必須化 ＋ `PixelPaddingValue` 書き出しへ変更し、
  回帰テスト（`derivedSeriesEncode.test.ts` ＋ spike の `PixelPaddingValue` 検証）を追加。
  **自動検証は「保存できたか・出所が残るか」を見ていたが、「背景が意味のある値か」を見ていなかった。**
- **この検証で H4a のバグを 1 件検出**: オーバーレイのキャンバスが `imageRect` 確定後のレンダで
  初めてマウントされるため、`useRef` だと描画 effect が先に走って ref が null のまま
  deps も変わらず、**空のキャンバスが乗ったまま**になっていた（`300×150`・α>0 が 0 個）。
  callback ref（state）へ変更して解消。**「要素が見えている」だけの検証では気付けず、
  キャンバスの中身を読んだことで初めて分かった**。

副産物の修正: `automator/src/driver/desktopDriver.ts` が **DevTools ウィンドウをメイン画面と
誤認する**バグを直した（`window` イベント発火時の url が about:blank だと predicate に外れ、
timeout → `firstWindow()` フォールバックが `devtools://…` を返していた。「MainScreen が出ない」と
2 回誤検知した）。現存ウィンドウを url でポーリングして選ぶ方式に変更。

#### 実在する重いプラグインでの通し確認（2026-07-30・standalone / Linux）

上の `hostapi-check` は host API の**契約**を極小プラグインで網羅する検証だった。それとは別に、
**実在する重いプラグイン 1 本を最初から最後まで動かす**スパイクを足した
（ドライバ `automator/src/spike/aneurysmPluginCheck.ts`。検体は社内の CADe プラグイン
"Aneurysm Detector"＝本体リポジトリ外。公開データ AneuriskWeb C0005 / 3D-RA 256³ を使用）。
**23 項目すべて合格**。契約の網羅では出てこない、次の 3 点が確かめられた。

- **`getPixelData()` の「1 回 1 スライス」設計がシリーズ全体の読み出しに耐える**:
  256 スライスを 1 枚ずつ読んで積み直したボリュームが、取り込んだ枚数・spacing と一致した
  （抜け・取り違え・spacing の欠落なし）。H3 で範囲指定を入れなかった判断（§H3「決めたこと」）は
  実用上も問題ない、ということ。
- **レンダラの Worker で分オーダーの計算を回しても本体の UI が壊れない**
  （解析 100 秒。その間もスライス送り・メニュー操作が効く）。
- **`showOverlay()` が読影に使える**: 候補のスライスへ送ってから重ね、
  **重ねる前後のスクリーンショットが実際に変わる**ところまで確認した。

この検証でプラグイン側のバグを 1 件検出している（オーバーレイに表面だけの値マップを渡していて、
血管断面の内側が値 0 相当で塗り潰され原画像が見えなくなっていた）。
**本体側の不具合は出ていない**＝ H1〜H4a の契約は実用に耐える、というのがこの回の結論。

#### H5 の実機検証（2026-07-30・standalone / Linux）

同じドライバ（`automator/src/spike/hostApiCheck.ts`）に H5 の節を足した。**プラグインから ROI は
作れない設計**なので、`dragOnCanvasHost()` で **canvas 上に実際に計測を描いてから** 読ませている
（読影医の操作と同じ経路）。ROI メニューから Bidirectional と楕円 ROI を 1 本ずつ引いて確認。

確認できたこと:

- ROI が無い状態で **空配列**（null や例外ではない）。未知の `tileId` も空配列。
- 描いた ROI が `sopInstanceUid`（DICOM UID）・`sliceIndex`（描いたスライス）・`spacing` 付きで返る。
  `spacing` は `getPixelData()` の面内間隔と一致。
- **座標系の意味が合っている**: プラグイン側で `points`（画素座標）×`spacing` から独立に計算した
  最遠 2 点間距離が、本体の `longAxisMm` と一致（楕円で `111.26015472412108` 対 `111.2601547241211`）。
- **Bidirectional はツール値だけを返し、形状値は返さない**（`length=83.4mm` / `shortAxis=55.6mm`、
  `longAxisMm`/`shortAxisMm` は `undefined`）。楕円は逆に形状値＋`area`＋`mean` を返し、統計の
  `unit="HU"`。**2 系統が別物として届くことの直接確認**。
- 別スライスへ送っても ROI の `sliceIndex` は**描いたスライスのまま**（local ROI は追従しない）。
  対話的に作った ROI は scope 未登録なので `zScope` は `null`（＝ローカル扱い）。
- ROI 属性の往復とマージ更新（`trackingId` だけ更新して `lymphNode` は残る）、存在しない ROI への
  書き込みは `false`、購読の**解除が効く**こと。

**この検証で本体側の欠陥を 3 件検出した**（いずれも単体テストでは出ない種類）:

1. **`RectangleROI` が除外正規表現の `angle` に部分一致**していた（Rect**angle**ROI）。矩形 ROI が
   黙って長径・短径を返さなくなる。**許可リスト方式へ変更**（`hasShapeCalipers`）。
   なお**同じ罠を検証スクリプト側でも踏んだ**（`/rect/` が Bidi**rect**ional に一致）。
   ツール名の判定は部分一致で書かないこと。
2. **統計値の単位欄に長さの単位 `"mm"` が漏れていた**。Cornerstone の `cachedStats.unit` は
   長さの単位なので、`modalityUnit ?? unit` のフォールバックが「統計の単位は mm」を生んでいた。
   `modalityUnit` のみを見るよう変更し、長さの単位は `lengthUnit` として分離。
3. **画素間隔が無いシリーズでは Cornerstone は length を px で計算する**。そのまま mm として渡すと
   単位が壊れるので、`length` / `shortAxis` は `lengthUnit === "mm"` のときだけ出すようにした。

副産物の修正: `dragOnCanvasHost()` に**始点の指定**（canvas 内相対位置）を足した。既定の中央から
引くと、2 本目以降のドラッグが**既存注釈のハンドルを掴んで「新規作成ではなく移動」になる**
（1 回目の実行で楕円が作られず ROI が 1 本しか出ずに気付いた）。

#### H6 の実装（2026-07-30・GRAPHY-Next 0.1.10 以降）

```ts
host.getTargets()[i].studyDate   // "YYYY-MM-DD" | null
host.getRois()[i].studyDate      // 同上
```

**動機**: 時系列の評価は日付差で結論が変わる。RECIST 1.1 の BOR は「SD をベースラインから
最短 N 週維持したか」「CR/PR が最短 N 日後の検査で維持されたか」で判定が変わるため、
検査日が無いと計算できない。H1〜H5 は UID しか返しておらず、そこだけが埋まっていなかった。

**決めたこと**:

- **DICOM のメタ（`generalStudyModule.studyDate`）から読む**。画面の prop（`Study` オブジェクト）を
  Viewer2D まで引き回す案もあったが、出所が 1 つに定まる方を採った。シリーズ/タイルの構成が
  変わっても壊れず、表示していない情報に依存しない。
- **解釈できない値は `null`**（`viewportRead.dicomDateToIso()`）。空・桁数違い・非数字・
  存在しない日付（2 月 30 日等）はすべて `null`。RECIST の判定は日付差で変わるので、
  怪しい値を通すより「日付が無い」とした方が安全。区切り入り（`YYYY-MM-DD`）も受ける。
- **`ViewerRoi` にも持たせた**。ROI は `studyUid` を持つので `getTargets()` と結合すれば得られるが、
  結合を各プラグインに書かせると取り違えの余地が残る。同じタイルから取るので追加コストはゼロ。

**実装**: `viewer/viewportRead.ts`（`dicomDateToIso` ＋テスト 5 件）/ `viewer/viewerCommands.ts`（契約）/
`viewer/Viewer2D.tsx`（`studyDateOf()`）/ `examples/plugin-template/graphy-plugin.d.ts` / 作成ガイド。

#### H7 の実装（2026-07-30・GRAPHY-Next 0.1.11 以降）

**動機**: 時系列のプラグインは「患者単位の記録」を持つ必要がある。`getRois()` は**開いている
タイルの ROI しか返さない**ため、RECIST の nadir（全期間の和の最小値）と BOR を出すには、
開いていない回をプラグイン自身の記録から補うしかない。その記録の鍵に患者が要る。

スタディ UID を鍵にすると、**同じ患者の別スタディを開いた瞬間に記録を見失う**
（RECIST プラグインの実装中にこの誤りを踏んだ）。本体は ROI 永続化でまさに `patientKey`
（PatientID → PatientName → StudyInstanceUID）を使っているので、同じ値を公開する。

**新たな情報の露出ではない**: プラグインは既に studyUid / seriesUid / SOP UID と生画素へ
到達できる。PatientID はそれらと同じ区分の識別情報である。

**実装**: `viewer/viewerCommands.ts`（契約）/ `viewer/Viewer2D.tsx`（`roiContext.patientKey` を出す）/
`examples/plugin-template/graphy-plugin.d.ts` / 作成ガイド。

#### スライス厚の追加（2026-07-30・GRAPHY-Next 0.1.12 以降）

```ts
(await host.getPixelData())!.sliceThickness   // number | null（DICOM SliceThickness 0018,0050）
```

**動機**: RECIST 1.1 の「測定可能病変の最小サイズは長径 10mm、ただし**スライス厚が 5mm を
超える場合は厚さの 2 倍**」という規則を、プラグインが自分で判定できるようにする。
既存の `spacing[2]` は**スライス間隔**（IPP の差 → `SpacingBetweenSlices` → `SliceThickness` の
順に導出）であり、ギャップのある収集では厚さと一致しない。**規約が厚さを指している**用途で
間隔を代用すると基準そのものが変わる（例: 厚 5mm・間隔 8mm を間隔で判定すると最小サイズが
10mm ではなく 16mm になる）。

**決めたこと**:

- **間隔で代用せず、無ければ `null`。** プラグイン側が「厚さが分からない」と判断して規則の
  適用を保留できるようにする（既定値を置くと、規則が静かに間違った基準で適用される）。
- `spacing[2]` の意味（間隔であって厚さではない）を契約のコメントに明記した。読み違えは
  こちら側の書き方の問題でもある。

**実装**: `viewer/viewerCommands.ts`（契約）/ `viewer/Viewer2D.tsx`（`getPixelData()` の戻り。
`ImageInfo.sliceThickness` から。`ViewerTilePixelData` は継承なので自動）/
`examples/plugin-template/graphy-plugin.d.ts` / `automator/plugins/hostapi-check`。

#### H8 の実装（2026-07-31・GRAPHY-Next 0.1.12 以降）

```ts
await host.loadStore()                       // { json, version, updatedAt }
await host.saveStore(json, { version })      // { ok:true, version } | { ok:false, conflict, message }
await host.deleteStore()
```

**動機**: プラグインが自前で持てる保存先は `localStorage`（端末ローカル）しかない。時系列の評価
（RECIST 等）は**数か月〜数年**にわたる記録なので、端末に閉じると別の PC で開いた読影医には
過去の回が見えず、**判定（nadir・BOR）が静かに変わる**。ROI は本体が永続化するようになったが、
プラグインが計算した内容（評価記録・ROI クロップ画像）はどこにも置き場が無かった。

**決めたこと**:

- **プラグイン id × 患者キーで領域を分ける**。id は host が入れる（プラグインに名乗らせない）。
  分けないと、別プラグインの保存を上書きし得る。
  ただしプラグインは本体と同じ権限で動くので REST を直接叩けば他の領域にも届く。
  **多層防御の 1 枚であって隔離ではない**（サンドボックスは `plugin-manager-design.md` §8 の P3）。
- **ROI 永続化とはテーブルを分ける**（`plugin_document` / `roi_document`）。混ぜると
  「ROI を消す」操作でプラグインの記録まで消える巻き添えが起きる。
- **楽観ロック**（ROI 永続化と同じ規約）。読まずに保存しようとしたら 409。
  衝突は握り潰さず `conflict: true` で返し、プラグインが読み直して統合してから再保存する。
- **backend は中身を解釈しない**。やるのは保管・版管理・壊れた JSON と巨大な入力の拒否だけ。
- **automator の reset で消す**。消し残すと「症例を消したのに評価記録が残る」状態になり、
  検証では前回の実行の記録が次に混ざる（ROI 保存で実際に起きた）。
- 副産物: `http.ts` の失敗は `HttpError`（`status` つき）にした。**メッセージの文字列照合で
  409 を見分けると、backend の文言を変えた途端に競合検出が壊れる**。

**実装**: `plugin/store/`（backend。entity/service/controller ＋テスト 14 件）/
`automator/AutomatorService`（reset で削除）/ `plugins/pluginStoreApi.ts`・`plugins/pluginStore.ts`
（フロント）/ `plugins/pluginTypes.ts`（契約）/ `viewer2d/Viewer2DMenuBar.tsx`（host へ結線）/
`examples/plugin-template/graphy-plugin.d.ts`。

#### H9 の実装（2026-08-02・GRAPHY-Next 0.1.12 以降）

```ts
await host.saveStructuredReport(tileId, {
  seriesDescription: "RECIST 1.1",
  groups: [{ trackingId: "1", findingText: "Target lesion",
             sopInstanceUid, measurements: [{ type: "longAxis", value: 76.0 }] }],
  findings: [{ label: "Best overall response", text: "PR" }],
})   // → { ok, cancelled?, seriesInstanceUid, sopInstanceUid }
```

**動機**: 計測結果を**保管庫 / PACS に残す**手段が画像（H4b の派生シリーズ）しかなかった。
計測は画像ではなくレポートなので、DICOM SR で出せないと他システムから数値として読めない
（CSV はアプリの外では使えるが、PACS に載らない）。

**決めたこと**:

- **DICOM はプラグインに書かせない**（H4b と同じ）。プラグインは「何を測ったか」だけを渡し、
  SR の構造・UID 採番・患者/検査属性の引き継ぎは backend が行う。
- **確認ダイアログは抑止不可**。保管庫に診療データが増える操作なので毎回同意を取る。
  シリーズ保存とは中身が違うので、ダイアログの文言も SR 用に分けた（計測グループ数・所見数）。
- **未知の計測種別は拒否する**（`longAxis` / `shortAxis` のみ）。黙って落とすと
  「入れたはずの計測が無いレポート」ができ、後から見た人には欠損と気付けない。
- **VerificationFlag は UNVERIFIED**。アプリが読影医の確認行為を騙らない。
- **TID 1500 完全準拠は主張しない**。構造は TID 1500 に沿えているが、
  テンプレート識別を付けた完全な検証（dciodvfy 等）は通していない。
  主眼は「計測値と追跡 ID が機械可読に残ること」。
- **効果判定（CR/PR/SD/PD）はコード化していない**（自由文の所見として入れる）。
  手元に PS3.16 の該当 CID を確認できていないため、**確認できないコードを書かない**
  （誤ったコード値は、コードが無いことより有害）。
- 長径・短径は実務で広く使われている SRT の `G-A185` / `G-A186`（dcmjs / OHIF と同じ）。

**実装**: `dicom/sr/`（backend。要求 DTO / 構築 / 保存 ＋テスト 19 件）/
`viewer/viewerCommands.ts`（契約）/ `viewer/Viewer2D.tsx`（中継）/
`viewer2d/Viewer2DScreen.tsx`（同意）/ `viewer2d/PluginSaveConfirmDialog.tsx`（SR 用の文言）/
`plugins/pluginTypes.ts` / `examples/plugin-template/graphy-plugin.d.ts` / i18n（ja・en）。

#### 表示言語の公開（2026-08-02・GRAPHY-Next 0.1.12 以降）

```ts
host.locale   // "ja" | "en"（活性化した時点の値）
```

**動機**: プラグインの UI が**本体の言語に追従できなかった**。host が渡している `t()` は
**本体のキーしか引けない**ため、プラグイン固有の文言（RECIST の用語・警告文）は自前で
持つしかなく、その言語判定の手掛かりが無かった。実機の通し検証で、本体が英語表示なのに
プラグインのパネルだけ日本語、という混在が出た。

**決めたこと**:

- **値は活性化した時点のもの**。プラグインの UI は本体の React ツリーの外（`document.body` 直下）
  にあるため、言語を切り替えても自動では追従しない。**切り替えたら開き直す**契約にした
  （購読 API を足すこともできるが、パネルはメニューから開く一時的な UI なので過剰）。
- **文字列は渡さない**（本体の辞書をプラグインへ開かない）。プラグインは自分の辞書を持つ。

**実装**: `plugins/pluginTypes.ts`（契約）/ `viewer2d/Viewer2DMenuBar.tsx`・`mainscreen/MenuBar.tsx`
（host へ結線）/ `examples/plugin-template/graphy-plugin.d.ts`。

#### H10 / H21 / H28 の実装（2026-08-19・線量評価プラグインからの要求）

**動機**: 線量評価（セラノスティクス）は **4〜5 時点 ×（SPECT ＋ CT）** を扱う。
`getPixelData`（1 枚ずつ・開いているタイルのみ）では**格子の対応が原理的に組めず**、
実データの SPECT（多フレーム NM）はそもそもスライスとして開けなかった。

| # | 何をしたか | 使った既存アセット |
|---|---|---|
| **H10** | `loadVolume` / `estimateVolume` を host へ | `viewer/regVolumeLoader.ts`（`loadRegVolume` / `estimateRegVolume`） |
| **H21** | `registerVolumes` / `resampleVolume` を host へ | `viewer/regWorkerClient.ts`・`viewer/regResult.ts`・`viewer/regGeometry.ts` の `sampleWorld` |
| **H28** | NM 断層の多フレームを Z に展開 | `dicom/SegFrameExpander`（フレーム抽出）・`XaFrameExpander`（展開の作法） |

**実装で分かったこと**:

- 🔴 **`regVolumeLoader` の FrameOfReferenceUID が常に空だった。** `frameOfReferenceModule` という
  provider は dicom-image-loader が返さない（本体の他の箇所はすべて `imagePlaneModule.frameOfReferenceUID`
  から引いている）。**位置合わせの `sameFrameOfReference` が常に false** で、初期化が毎回
  「別 FoR」扱いになっていた。H10 の実機検証で発覚し、同時に直した。
- **NM のフレーム切り出しは SOP UID を決定的にした**（親 SOP ＋ フレーム番号）。毎回ランダムだと
  読み直すたびに別インスタンスに見え、ROI の復元やキャッシュが噛み合わない。
- **プラグインのボリュームを位置合わせに渡させない。** Worker へは画素バッファを*転送*するので、
  渡した側の配列が detach されて壊れる。**仕様で事故を防ぐ**（シリーズ参照だけを受け取る）。

**実機検証**（`automator/src/spike/volumeApiCheck.ts`・**43/0**）: 真値既知のファントム GNBP-D
（線量評価プラグインの `bench/`）で、NM が 48 スライスに展開されること・各スライスに患者座標が付くこと・
`loadVolume` の次元/間隔/患者座標/値が真値と一致すること（肝の (-60,-10,20) で 114580 Bq/mL）・
同一シリーズ同士の位置合わせが移動量ゼロになること・**CT の格子へリサンプルしても値が保たれること**を確認。

### 7.3 副作用（着手時に必ずセットで行うこと）

- ✅ **型定義の同期（本体側 1/5）**: `examples/plugin-template/graphy-plugin.d.ts` に `ViewerTarget` /
  `ViewerViewState` / `getTargets` / `getViewState` を追加済み（README・`ui.js` のコメント例も）。
- ✅ **2026-08-21 に追いつかせた**: テンプレートには **H10 / H21 が丸ごと欠落していた**
  （`loadVolume` / `estimateVolume` / `registerVolumes` / `resampleVolume` ＋ その 6 つの型）。
  併せて `goTo` / `selectRoi`（0.1.13）・`viewer2d.menu.analysis`（0.2.1）・`PluginModule` も追加。
  **「host API を足したのに、作者からは存在しないように見える」状態が半年近く続いていた。**
  🛡 **再発防止**: `frontend/src/plugins/pluginTemplateTypes.test.ts` を追加した。
  `pluginTypes.ts` の `PluginHostBase` / `Viewer2DPluginHost` / `MainScreenPluginHost` の
  メンバ名と `PluginSurface` の語彙を、テンプレートが**全部持っているか**を検査する
  （型の同一性までは見ない。テンプレートは意図的に安定サブセットで型名も違うため）。
  **host API を足すとこのテストが落ちるので、以後は忘れようがない。**
- 🔴 **残: 外部デモ 4 リポジトリの `graphy-plugin.d.ts`**（[demos ハブ](https://github.com/tatsunidas/graphy-next-plugin-demos) /
  hello / mean-filter / gemini-findings）。本体リポジトリからは触れないので**別作業**。
- **`engines.graphy` の下限**: 新 API を使うプラグインは `">=0.1.9"` へ上げる
  （`engines` 互換判定は展開前に効くので、古い本体には入らなくなる＝正しい挙動）。
  テンプレート自身は新 API を使っていないので `">=0.1.0"` のまま据え置いた。
- 🔴 **残: デモの書き換え**: [mean-filter](https://github.com/tatsunidas/graphy-next-plugin-mean-filter) と
  [gemini-findings](https://github.com/tatsunidas/graphy-next-plugin-gemini-findings) の
  `findOpenTiles()`（DOM 依存）を `getTargets()` へ、キャンバス読み取りを `getPixelData()` へ
  差し替える。**H3 が入ったので「canvas の 8bit しか読めない」断り書きは撤回できる**。
  結果表示も自前キャンバスではなく `showOverlay()`（H4a）に、保存は `saveDerivedSeries()`（H4b）に
  置き換えられる。
- ✅ **`fw/plugin-authoring-guide.md` §2-3 の host 表**と [`plugin-explainer.md`](plugin-explainer.md) §7 の
  制約記述を更新済み。

#### H35 / H36 の実装（2026-08-25・アンギオ計測のプラグイン外出しからの要求）

`fw/angio-design.md` §22.3 の **G1 / G2**。**「画素は渡すが意味は渡さない」状態**を埋めるための 2 本で、
どちらも**無いと数値が静かに間違う**種類の欠落だった（残る G3〜G5 は「残せない」＝間違いはしない）。

| 仮番 | 確定 | 委譲先（**計算をここで増やさない**） |
| :- | :- | :- |
| G1 | **H35** | `viewer/xaCalibrationProvider.ts` の `calibrationForImageId()` ＋ 純関数 `xaCalibration.toViewerSpatialCalibration()` |
| G2 | **H36** | `viewer/dsaLoader.ts` の `dsaStateForImageId()`（新規。imageId → セッション状態） |
| G3 | **H37** | `POST /api/angio/plugin-sr`（新規）→ 既存の `QcaSrWriter` / `QvaSrWriter` / `QlvSrWriter` / `Qca3dSrWriter` |
| G4 | **H38** | `POST /api/angio/plugin-presentation-state`（新規）→ 既存の `XaPresentationStateWriter` |
| G5 | **H39** | `report/analysisResults.buildPluginAnalysisRecord()`（新規・純関数）→ 既存の `publishAnalysisResult()` |

#### 実機検証 — ✅ **49/0 合格（2026-08-25）**

`automator/src/spike/angioHostApiCheck.ts` ＋ `automator/plugins/angio-hostapi-check/`。
詳細と、そこで出た 2 件の不具合は `fw/angio-design.md` §22.5。

🔴 **教訓: host API を足したら、その API を使う検証用プラグインまで書いて実機で回す。**
今回出た 2 件（XA の計測が H5 から見えない／XA のフレーム imageId から SOP が取れない）は
**本体の画面では何も壊れて見えない**——計測線は描かれ、本体からの保存も通る。
**プラグイン経路にだけ出る穴は、プラグインを動かさないと見つからない。**

#### H37 の設計で迷ったところ（2026-08-25）

**既存の 4 エンドポイントに `producer` を足す**のではなく、**別エンドポイントを 1 本立てた**。
理由: 既存 record に足すと本体経路では常に null になり、**「付け忘れ」と「本体が書いた」の
区別が型から消える**。経路を分ければプラグイン経路で producer を**必須**にできる（無ければ 400）。
既存 4 record・4 writer・10 か所の呼び出しにも触らずに済んだ。

**H38 も同じ形にそろえた**（別エンドポイント・producer 必須・同じ writer・同じ SOP 突き合わせ）。
突き合わせは `Viewer2D.firstUnopenedSop()` に 1 本化してあるので、**書き込み経路を足すときは
必ずここを通す**。

🔴 **他患者の検査にレポートを生やせない**ようにするのが、これらの API のいちばん重要な仕事。
書き手は**参照インスタンスから患者・スタディを継承する**ので、SOP UID さえ渡せば
保管庫の任意の検査に書けてしまう。プラグインは本体と同じ権限で動く（サンドボックス未実装）ため、
**「開いているタイルの並びに無い SOP は拒否」**をフロント側の入口で掛けた
（H10 の `studyUid` 省略時と同じ考え方）。

- 登録先は **3 か所**（`Viewer2D.tsx` の `commandsRef` 2 本と `registerViewerCommands` の委譲オブジェクト）。
  委譲オブジェクトを忘れると**プラグインからだけ「メソッドが無い」**状態になり、本体の画面は
  正常なので原因に辿り着きにくい。
- テンプレート `examples/plugin-template/graphy-plugin.d.ts` も同時に更新した
  （`pluginTemplateTypes.test.ts` が落ちるので忘れられない。§7.3 の再発防止がそのまま効いた）。

### 7.4 やらないこと（この範囲では）

- **`ui.js` からの外部 API 呼び出し**は依然できない（本番 CSP の `connect-src` が localhost 限定。
  [`security.md`](security.md)）。外部通信は JAR 側に置く方針を変えない。緩めると
  「プラグインが任意の外部へ患者データを送れる」ことになり、CSP を置いた意味が消える。
- **権限（`permissions`）の実強制**とサンドボックスは別課題（`plugin-manager-design.md` §8 の P3）。
  「H3 と P3 の順序を着手時に再検討する」と書いていたが、**再検討の結果 H3 を先に入れた**:
  プラグインは既に本体と同じ権限で動く（JAR 面はファイルシステムへ、UI 面はキャンバスへ到達できる）
  ため、H3 で信頼境界は変わらず、宣言ベースの偽の強制はサンドボックスがあるかのような誤解を生む。
  **`plugin.json` の `permissions` に `read-pixels` を宣言する運用**（同意画面に出る）とし、
  実強制は P3 とセットで行う。上記「H3 の実装」の権限の節も参照。
