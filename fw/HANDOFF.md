# GRAPHY-Next 引き継ぎドキュメント

> 更新日: 2026-06-30（最終更新: StrictMode 無効化でCT黒画面/スケールバー暴走を解消・カメラ自己修復 / Fusion整合表示 / IPP表示 / LUT404修正）
> 目的: 別の作業者（Claude 含む）がこのリポジトリの状況を把握し、続きを実装できるようにする。
> このファイル＋ `fw/` 配下の各設計ドキュメントが「ソース・オブ・トゥルース」。
>
> 🔵 **進行中（2026-07-01）の作業状況・次の一手は `fw/roi-mask-progress.md` を参照**
> （シリーズ Sync / リファレンスライン / 2D Viewer メニュー・ツールバー / ROI 計測・ブラシ / ROI マネージャ）。
> 関連設計: `viewer-2d-menu-toolbar.md` `roi-mask-model.md` `roi-manager-design.md` `series-sync-design.md`。
>
> 🟢 **2026-07 追加（GRAPHY 機能移植）**: Analysis>Histogram / Image>コントラスト調整(W/L) / View>Layout(任意 Row×Col) を実装。
> 併せて **HU 校正の二重適用バグ**を是正し `viewer/pixelCalibration.ts` に読取を一元化（再発防止）。
> 詳細: `viewer-2d-menu-toolbar.md` §9 ／ 校正は `viewer-2d-architecture.md`「校正(HU 等)の二重適用に注意」。

---

## 0. これは何か
**GRAPHY**（Java Swing の DICOM ワークステーション。別リポジトリ `../GRAPHY`）の **Web 化版**。
- **2 モード**: **standalone**（Electron + ローカル H2/FS）と **web**（ブラウザ + 外部 PACS via DICOMweb/BFF）。
- スタック: **Spring Boot 3.3.5 / Java 21 / Maven** + **React 18 / TypeScript / Vite 5** + **Electron 31**。
- 画像表示は **Cornerstone3D 3.33.x**（`@cornerstonejs/core` `/tools` `/dicom-image-loader` + `dicom-parser`）。
- ほとんどの新機能は **standalone(Electron) 前提**で実装。web 対応は機能ごとに後追い。

## 1. リポジトリ構成
```
GRAPHY-Next/
  backend/    Spring Boot（DICOM 保管庫=H2+FS、DIMSE、DICOMweb、REST）
  frontend/   React/TS/Vite（UI 全部）
  desktop/    Electron（main.js / preload.js / config.json）
  fw/         設計ドキュメント（重要。下記参照）
  scripts/    dev-desktop.sh など
```

### fw/ の各ドキュメント（必読）
- `development-phases.md` … 全体フェーズ計画
- `dicom-data-layer.md` … standalone=H2索引、web=DICOMweb/BFF の方針、保管庫4原則
- `ui-architecture.md` / `error-handling-logging.md` / `security.md` / `plugin-architecture.md` / `keyboard-shortcuts.md`
- `viewer-2d-architecture.md` … **2D ビューア（Cornerstone3D）の中核設計。最重要。**
- `viewer-2d-screen.md` … 2D Viewer **画面**（マルチスタディ・タイル）の要件・**スライス同期改善案**・段階プラン
- `mainscreen-tools.md` … MainScreen ツールバー/メニューの各機能の計画（Export/Anonymizer 等）

## 2. ビルド / 実行 / テスト
- **frontend ビルド/型チェック**: `cd frontend && npm run build`（`tsc -b && vite build`）。
- **backend コンパイル**: `cd backend && mvn -q -o compile -Dfrontend.skip=true`
  （`-Dfrontend.skip=true` を付けないと frontend-maven-plugin が走る）。
- **backend テスト**: `cd backend && mvn -o test -Dfrontend.skip=true -Dtest='...'`。
  - 主要: `SeriesLayoutBuilderTest`（ZCT 8件）、`DicomStoreIntegrationTest`、`DicomStorageRollbackTest`、
    `DicomTagControllerTest`。全 green。
- **standalone 起動**: `bash scripts/dev-desktop.sh`（Vite を別プロセスグループで起動し、Electron が
  backend jar を spawn）。**必ず 1 つだけ起動**（複数 vite は `.vite` 競合の原因）。
- `mvn` は導入済み（3.6.3 / JDK 21）。
- **⚠️ `main.tsx` を変更したら Vite を完全再起動**（HMR では反映されない。例: StrictMode の有無）。
  `kill $(lsof -t -i :5173)` で停止 → 再起動。
- **React StrictMode は無効（`main.tsx`）**。理由: StrictMode の dev 二重マウント（mount→cleanup→remount）が
  Cornerstone3D（命令的 WebGL / 単一共有 RenderingEngine）と非互換で、同一 element への enableElement→setStack
  競合により**ビューポートのカメラ fit が暴走（parallelScale が ~200倍）→ 真っ黒/点表示・スケールバー異常**になる。
  本番は単一マウントなので影響なし。StrictMode を外し dev を本番挙動に揃えてある。**再導入しないこと**。

### ⚠️ Vite × Cornerstone3D の既知ハマり（`frontend/vite.config.ts` に対処済み・触る時は注意）
1. `worker.format = "es"`（デコードワーカが ES module + 動的 import）。
2. **codec の default export 問題**: `cornerstoneCodecEsm()` プラグインが `@cornerstonejs/codec-*` の
   UMD に `export default` を付与（dev のみ）。
3. **dicom-parser の zlib クラッシュ**: `optimizeDeps.include:["dicom-parser"]` 必須（UMD の `this`
   undefined → `e.zlib` で落ちるのを CJS interop で回避）。
4. dicom-image-loader 本体は `optimizeDeps.exclude`（worker のため）。`build.target:"esnext"`。
   → 症状別の対処は `viewer-2d-architecture.md` の「Vite 連携」節に表で記載。

## 3. 現在の到達点（実装済み）

### backend
- ローカル保管庫（H2 索引 + FS）、C-STORE 受信、C-ECHO/GET/MOVE/FIND（dcm4che CLI 連携）。
- **DICOM Send（C-STORE SCU）**: `DicomStoreScu.storeAll`（単一アソシエーションでスタディ一括送信）＋
  `DicomSendService` ＋ `POST /api/dicom/send` / `GET /api/dicom/remote-aes`。詳細は `fw/mainscreen-tools.md`。
- **Query/Retrieve ウィンドウ**: 常駐別ウィンドウ（`#qr`）。Destination タブ・共有検索(Today既定)・AutoRefresh・
  保存済み判定・**Retrieve は C-MOVE**（standalone=自局SCP取込 / web=dcm4chee宛・QIDO判定）。`qr/DimseQrService`
  拡張＋`qr/QrRetrieveService`＋`/api/dicom/qr/*`、frontend `src/qr/`。設計・検証は **`fw/qr-window.md`**。
- **TagExtractor（GRAPHY 移植）**: タグ/シーケンス(パス編集)/Private を指定し検索リスト全体をシリーズ単位で
  抽出→テーブル→CSV。`extract/TagExtractService.extractTable`＋`/api/extract/table|csv`、
  `/api/dicom/tags`（辞書）、`web/WebDicomDataService.seriesMetadata`（WADO-RS）。frontend
  `mainscreen/TagExtractorDialog`＋`NestedTagBuilder`＋`tagPathUtil`。詳細 `fw/mainscreen-tools.md`。
- **SeriesExtractor（GRAPHY 移植）**: タグ条件(Include/Exclude・=,含む,≥,≤,範囲・SQ/Private)＋平面(AX/SAG/COR)で
  一致シリーズを検証→standalone はフォルダコピー(連番+mapping.csv)、web は ZIP(WADO 取得は未対応)。
  `seriesextract/SeriesConditionEvaluator`/`SeriesExtractService`＋`/api/series-extract/verify|copy|zip`、
  desktop `pickDirectory` IPC。frontend `mainscreen/SeriesExtractorDialog`。詳細 `fw/mainscreen-tools.md`。
- **Anonymizer（GRAPHY 移植・PS3.15）**: Basic Confidentiality Profile（X/Z/D/K/C/U・各オプション・UID一貫・
  safe-private・SR clean・method tagging・新PatientID）＋Pixel 焼き込み(矩形)。検索リスト全体→ZIP/フォルダ(standalone)。
  `anonymize/*`＋`/api/anonymizer/*`、CSV辞書は `resources/dicom_dict/`。frontend `mainscreen/AnonymizerDialog`。
  **焼き込みの viewer『焼き込みに使用』ボタンは保留**（マスクAPI完成・viewer競合回避）。詳細 `fw/mainscreen-tools.md`。
- REST: `/api/studies`（検索: patientId/Name 部分一致, 日付範囲, modality複数, accession）、`/series`、
  `/instances`、`/instances/{sop}/file`（standalone の画像配信=wadouri 用）、
  `/studies/{study}/series/{series}/layout`（**5D ZCT 導出**）、`/dicom/tag`（タグ→keyword/VR）、
  `/import/paths`、`/settings`。
- 5D ZCT 導出 = `SeriesLayoutBuilder`（純アルゴリズム・単体テスト済10件）+ `DicomStorageService.seriesLayout`（ヘッダのみ読取）。
  - **次元の意味づけ**: **Z**=空間スライス（IPP·法線）。**T(時間)**=繰り返し/経時 = `TemporalPositionIdentifier/Index`・
    `TriggerTime`・**`AcquisitionNumber`**（＝一定時間の連続データ収集＝本質的に時間軸。造影フェーズ/fMRI 繰り返し等）。
    **C(チャンネル)**=同一位置・同一時相で「見ているものが違う」= `EchoNumbers`・`DiffusionBValue`・`EchoTime`・
    `ComplexImageComponent`(MAGNITUDE/PHASE/REAL/IMAGINARY→"Complex" 数値コード)。`T_TAGS`/`C_TAGS` 参照。
  - **Siemens MOSAIC 対応（GRAPHY Praparat 準拠 / Cornerstone は非対応なので自前デモザイク）**:
    `DicomStorageService.mosaicLayoutIfApplicable` が `ImageType` に MOSAIC を含むシリーズを検出。
    **判定は ImageType に MOSAIC があることが必須**（`NumberOfImagesInMosaic(0019,100a)` 私的タグの
    有無だけでは発火しない）。localizer 等が当該私的タグを持つ／creator ブロック走査が誤検出する場合の
    誤デモザイク（例: 位置決め 5 枚が Z=53×T=5 と誤認）を防ぐ。frame 配信(`frameDicom`)の分岐も同条件。
    N=`NumberOfImagesInMosaic(0019,100a)`、grid=ceil(√N)、tile=Cols/grid×Rows/grid。
    **各モザイク=1時相、N タイル=Z スライス → Z×T 4D**（nC=1, tDim=Temporal）。
    per-tile IPP = mosaicIPP + index·spacing·normal。タイル配信は `mosaicTileDicom`＋
    エンドポイント `GET /instances/{sop}/frames/{frame}/file`（タイルを切り出して単一フレーム DICOM で返す。
    **非圧縮 TS のみ**）。frontend は `Cell.frame>=0` のとき `imageIdForFrame`→`/frames/{k}/file` を wadouri で読む。
    既存の Cornerstone 描画経路は不変。※タイル毎に親モザイクを再パースするため巨大シリーズは将来キャッシュ検討。
  - **グローバルキー判別**（`globalDimKey`）: 上記タグ分割（全位置で同一値集合が必要）に加え、
    **値→index のグローバル写像**で割当（GRAPHY の SeriesInstanceUID 多次元写像と同発想）。**非均一**
    （端スライスが片方の収集のみ等の CT 多収集）にも対応。T 候補(`T_TAGS`)を先に試して T へ、次に C 候補(`C_TAGS`)を C へ。
    条件=全フレームに値あり・distinct≥2・各 Z 位置内で値重複なし。判別キーが無い非均一は純スタック
    （テスト `pureStack_whenGroupsUneven`）。例: 物理範囲の違う CT 2収集 → `Acq` で **T=2**（断面は Z で揃い、
    範囲外は frontend がブランク埋め）。magnitude/phase → `Complex` で **C=2**。

### frontend MainScreen
- スタディ検索（日付範囲・Today/Yesterday/1週間・モダリティ チェックグリッド・件数表示・50件ページング）。
- **メニュー**: File(Import/Export/**Send**/NonDicomImporter) / Function(Anonymizer/TagExtractor/SeriesExtractor) /
  Image(2D/3D/MPR/Slicer) / System(Settings/DB) / Help。
- **ツールバー**: 同上のツール群＋ビューア群。**2D Viewer のみ実装**、他は「近日対応予定」バナー。
- 環境設定（スキーマ駆動＋カスタムパネル: セキュリティ／**画像オーバーレイ**）。DB管理。i18n(ja/en)。

### frontend 2D ビューア（`frontend/src/viewer/`）— ほぼここが主戦場
- `Viewer2D.tsx`: Cornerstone StackViewport。`imageIds[]`+`imageIndex`。**単一 RenderingEngine 共有**。
  - 表示変換は **affine（ViewPresentation）**。Fit=1.0/中央、zoom/pan/flip/rotation/再Fit。
    flip は setViewPresentation がOFFにできないバグがあるため **setCamera で双方向**（`transform.ts`）。
  - 左ドラッグ=**W/L**(WindowLevelTool)、中=Pan、右=Zoom（ホイールはスライス送りに解放）。
  - **初期 Window 明示適用**: `setStack` 後に DICOM の WindowCenter/Width を `setProperties({voiRange})` で適用
    （CT は自動 VOI が生16bit パディング(-2048 等)に引っ張られ真っ黒になりやすいため）。
  - **カメラ暴走の自己修復**: `onCameraModified` で parallelScale が画像フィット規模の 50倍超を検知したら
    `resetCamera`+再描画で復帰（再入ガード＋最大3回）。スライス切替例外時も `resetCamera`+render フォールバック。
  - **リサイズ追従**: 共有エンジンの自動再フィット(`engine.resize(true,false)`)は誤フィットするため、
    `engine.resize(true,true)`(canvas のみ)＋viewport 単位 `resetCamera`＋妥当性ガードで処理。実サイズ変化時のみ。
  - 輝度キャリブレーション（Modality LUT/VOI は Cornerstone が GPU 自動適用）。カーソル値は
    **OffScreen 座標で逆変換**して取得（`canvasToWorld`→`transformWorldToIndexContinuous`）。
    signed/unsigned・8/16bit・カラーRGB 対応。値は RescaleType(0028,1054) の単位を併記。
  - 右パネル(`ImageInfoPanel`)＝ボクセルサイズ/FOV/Rescale/Window 等。**Info ボタンで On/Off**（Off で画像拡張）。
  - 画像上: **DICOM テキスト4隅**（設定可能, `overlayConfig`/`overlayText`/`OverlayConfigPanel`）、
    **患者の向き A/P/R/L/H/F**（`orientation.ts`）、**スケールバー(Caliper)**（`scaleBar.ts`, 校正有=黄/mm, 無=灰/px）。
  - 画像外の上部ラベル: Zoom% / W/L / カーソル値 / OffScreen XY（必須情報・常時）。
  - **表示状態 Undo/Redo**（クライアント履歴。DICOM 不要）: Mod+Z / Mod+Shift+Z、ツールバーにボタン。
  - `compact`/`height`/`syncGroupId` props（グリッドセル用）。
- `SeriesViewer.tsx`: **シリーズ管理コントローラ**。Viewer2D を内包。
  - **5D(ZCT)**: backend layout を取得し C/T スライダー（次元>1で表示, DICOM由来併記）。
  - スライス送り: スライダー＋↑↓/Home/End キー＋ホイール。シネ(▶, **fps は環境設定 viewer.cineFps**)。
  - オーバーレイ On/Off（テキスト/キャリパー/向き/ROI[将来]）。
  - **GridView(FilmGrid)**: 列数指定で格子表示。Slider/Grid トグル＋列数セレクト(先頭=Slider)。
    Grid 中はスライダー非表示、スクロール可。各セルは compact Viewer2D。100枚超は確認ポップアップ。
    **マルチチャンネル(nC>1)/動画(Video SOP)/1枚 は無効化**。
  - **GridView リンク**: 共有ツールグループ＋camera/VOI Synchronizer（`sync.ts`）で W/L/Pan/Zoom/Rotate/Flip
    をシリーズ全体連動。
- 各種ショートカットは `shortcuts/registry.ts`。**実装済み機能のみ配線**（nav/disp(I/O)/undo/redo）。

### LUT（カラーマップ）機能（`frontend/src/viewer/LutDialog.tsx` / `Viewer2D.tsx`）
- `backend/src/main/resources/luts/` に GRAPHY の .lut ファイル 106 枚をコピー。
- **バックエンド**: `LutController.java`（`GET /api/luts`、`GET /api/luts/{name}`）+ `LutService.java`。
  - フォーマット自動判別: **ICOL**（32 バイトヘッダ + R/G/B 各 256 バイト）、**Raw バイナリ**（768 バイト）、
    **テキスト**（`index\tR\tG\tB` 4列 または `R\tG\tB` 3列、256 行）。
- **フロントエンド `api.ts`**: `LutData { name, r[], g[], b[] }` 型、`fetchLutNames()` / `fetchLutData(name)`。
- **`LutDialog.tsx`**: LUT 名＋カラーバー（256×1 canvas）並列リスト、IntersectionObserver で遅延ロード。
  グレースケールリセット行を先頭に常時表示。ダブルクリック即適用、Esc/バックドロップで閉じる。
  `ColorBar` コンポーネントは `export` 済み（FusionControlBar でも使用）。
- **`Viewer2D.tsx`**: ツールバーに「LUT」ボタン（適用中は青ハイライト）。右クリックコンテキストメニューは削除済み。
  `applyLut(lut | null)`: Cornerstone3D の `utilities.colormap.registerColormap` → `setProperties({colormap})` で適用。
- **ツールバー横スクロール化**: `overflow-x: auto`, `flex-wrap: nowrap`, ボタン `flex-shrink: 0`。

### Fusion（画像重畳合成）機能
#### DnD によるトリガー（`Viewer2DScreen.tsx`）
- `getDropZone`: タイル幅を左25%/右25%/中50% で分割。中央ドロップ → Fusion。
- シリーズ行（左ツリー）は既ロード済みでも draggable（以前は未ロードのみ）。
- タイルヘッダのドラッグも中央ドロップで Fusion トリガー（別タイル→Fusion）。
- ドロップ時の視覚フィードバック: 「Fusion オーバーレイ」ラベル付き青枠ハイライト。

#### FusionControlBar（`Viewer2DScreen.tsx`）
- Fusion 設定時にタイル下部に表示: `🔀 [シリーズ名] / 透過度スライダー / LUTボタン / ×`。
- **LUTボタン**: `LutDialog` を開き選択した LUT を Fusion オーバーレイに適用。選択中はカラーバーをプレビュー。
- 透過度スライダー（0–100%）、C/T スライダー（マルチチャンネル/時系列時）、× で Fusion 解除。

#### FusionImageViewer / FusionEngine（`FusionOverlayViewer.tsx` / `fusionEngine.ts`）
- **base 画像と同じ表示矩形に重畳（GRAPHY FusionDisplay 踏襲）**: オーバーレイは独立配置ではなく、
  **base の Viewer2D 内（`wrap`, overflow:hidden）に単一 `<canvas>` を描画**し、base 画像の表示矩形
  `rect` にぴったり重ねる。→ 原点一致・画像領域にクリップ・**zoom/pan/fit に追従**。
  - `rect` は `Viewer2D` が `getImageData().imageData.indexToWorld(画像四隅) → worldToCanvas` で算出し、
    `CAMERA_MODIFIED` ごとに更新（`renderOverlay` prop 経由で `{rect, imageId, index, count}` を供給）。
  - 配線: `Viewer2DScreen`(useMemo `renderFusionOverlay`) → `SeriesViewer.renderFusionOverlay`
    → `Viewer2D.renderOverlay` → `FusionImageViewer`。
- **空間 Fusion**: 前景・背景に IOP/IPP がある場合、`computeFusionSlice`（trilinear）で前景を
  **背景グリッド(bgCols×bgRows)に再構成**。canvas は CSS で `rect` に伸縮 → ピクセル単位で base に整合。
- **非空間フォールバック**: IOP/IPP が無い場合（CR/DX 等）は比例 Z（`baseIndex/baseCount`）で前景スライスを
  選び、`rect` にストレッチ。フォールバック Viewer2D は廃止 → **LUT が常に canvas 経由で効く**。
- **値0は透明（`toImageData`）**: 8bit 化で 0（窓下限以下＝背景）になった画素は alpha=0。
  GRAPHY の `ImageRoi.setZeroTransparent(true)` 相当。base が黒く暗転せず信号部のみ重畳。
- **LUT**: `toImageData(values, cols, rows, wc, ww, lut?)` の第 6 引数。`fusionLut` 変更で再描画（即反映）。
- **不透明度**: canvas の CSS `opacity`（再描画不要）。
- **注意**: `rect` は軸並行 BBox 算出のため base を**回転**させると厳密でない（fit/zoom/pan/flip は追従）。
  カラー(RGB)前景の非空間フォールバックは未対応。

#### Fusion 設定（`settings/registry.ts`）
- viewer カテゴリに「フュージョン」セクション追加:
  - `viewer.fusionOpacity` (number 0–100, 既定 50): DnD 起動時のデフォルト透明度（参照値として保存、現状は自動適用なし）。
  - `viewer.fusionLut` (text, 既定 ""): デフォルト LUT 名（同上）。
- i18n: `settings.sec.fusion` / `settings.field.fusionOpacity(.help)` / `settings.field.fusionLut(.help)` / `viewer2d.fusion.lut`。

#### Fusion FW（将来課題）
- 2D/3D **剛体（Rigid）位置合わせ**（6 DOF または 3 DOF 最適化）: 未実装。
- 2D/3D **非剛体（Deformable）位置合わせ**（B-spline / demons 等）: 未実装。
- 詳細は `~/.claude/.../memory/project_fusion_fw.md` 参照。

### frontend 2D Viewer 画面（`frontend/src/viewer2d/Viewer2DScreen.tsx`）— Phase 1 のみ
- **別 Electron ウィンドウ**で開く（`main.js` の `createViewerWindow` + ipc `graphy:open-viewer`、
  `preload` の `openViewer`、App は `location.hash==="#2dviewer"` で分岐）。
- 左=スタディ/シリーズツリー（検索→展開→＋でタイル追加）、右=**タイル格子**（各タイル＝SeriesViewer）。
- タイル: ヘッダ（DnD ハンドル / **エクスポート(⤓)** / Sync トグル / ×）＋コンテンツ（SeriesViewer + Fusion オーバーレイ）＋ FusionControlBar。
- **画像の外部ドラッグ保存**: タイルヘッダの **⤓ ボタン**で、画像を PNG として外部（デスクトップ/他アプリ）へ
  **Electron ネイティブドラッグ**保存。クリックでダウンロードも可（web フォールバック兼用）。
  - 仕組み: `desktop()?.startDrag(dataUrl, filename)` → preload `graphy:start-drag` → main で一時 PNG 書出 +
    `webContents.startDrag({file, icon})`。OS が本物のファイルドラッグとして扱うため **禁止カーソルが出ない**。
  - 旧実装の「ウィンドウ外ドラッグ→dragover 途絶検出→auto-capture」タイマー群は撤去（禁止カーソル/不安定の原因）。
    ヘッダ/シリーズ行の DnD はウィンドウ内（並び替え/Fusion）専用に簡素化。

## 4. 次にやること（優先度つき・未実装）
1. **2D Viewer 画面 Phase 2: 同期**（`viewer-2d-screen.md`）
   - 表示状態 Sync（camera/VOI Synchronizer 流用）→ **空間スライス同期(FoR/IPP, mm 位置)** →
     **Relative モード**（任意スライスから揃えて送る・Off 不要）。→ Phase 3 リファレンスライン(ReferenceLinesTool)。
2. **C/T 切替（別スタック）をまたぐ transform/VOI 維持**（保存 presentation/voiRange の再適用）。
3. **PET SUV**（PT scaling: Radiopharmaceutical/体重/時刻）。
4. **ROI / Length ツール**（ROI 管理は SeriesViewer に集約。GRAPHY のセグメンテーション設計はメモリ参照）。
5. MainScreen ツール群の実装（`mainscreen-tools.md`）: Export(+Burn CD/DVD)、NonDicomImporter、Anonymizer、
   TagExtractor、SeriesExtractor。
6. 3D Viewer / MPR Viewer / Slicer 画面（ツールバー/メニューのボタンは設置済み）。
7. **web(wadors) 対応**: 画像 imageId・layout 導出（現状 standalone のみ。`imageId.ts` は web で throw）。
8. Enhanced 多フレーム（DimensionIndexValues/StackID/InStackPositionNumber、wadouri `frame=`）。
9. **Fusion 改善**:
   - `viewer.fusionOpacity` / `viewer.fusionLut` を DnD 起動時に自動適用（現状は Settings に保存するのみ）。
   - base 回転時の `rect` 厳密化（現状は軸並行 BBox。回転対応は CSS transform 行列が必要）。
   - カラー(RGB)前景の非空間フォールバック対応。
   - 2D/3D 剛体・非剛体位置合わせ（FW: `~/.claude/.../memory/project_fusion_fw.md` 参照）。

## 5. 重要な注意・既知の制限
- **ブラウザ/Electron 実機での目視確認は未了の機能あり**（このセッションは build/tsc/backend test まで）。
  特に: 回転/反転の見え方、GridView リンクの同期、5D の C/T、Undo/Redo、別ウィンドウ起動。
- **Fusion の実機確認状況**:
  - DnD → FusionControlBar 表示 / 透過度スライダー / × 解除: 動作確認済み（タイル→タイル, シリーズ→タイル）。
  - オーバーレイ描画は base 画像の表示矩形に重畳（原点一致・画像領域クリップ・zoom/pan 追従）。**要実機目視**。
  - LUT は canvas 経由で常時適用（フォールバック含む）。透過度・LUT とも即反映。
  - 既知の限界: base 回転時の矩形は軸並行 BBox（厳密でない）。RGB 前景の非空間フォールバックは未対応。
- **LUT ファイル**: `backend/src/main/resources/luts/*.lut`（106 枚）。
  フォーマット判別順: ICOL マジック確認 → 768 バイト Raw → テキスト（tab 区切り）。
- **GridView/タイルは viewport を多数生成**するため巨大シリーズで負荷大。将来 仮想化/`loadImageToCanvas`
  軽量描画/ContextPool エンジンを検討（`viewer-2d-architecture.md` 参照）。
- **Viewer2D ツールバー**: 横スクロール式（`overflow-x: auto`）。ボタン追加で自動スクロール対応。
- `desktop/data/` はランタイムデータ（**.gitignore 済み**。誤コミット注意）。
- 既存メモリ（`~/.claude/.../memory/`）にも GRAPHY/GRAPHY-Next の重要事項あり（UI操作・ビルド・テスト等）。
  Fusion FW は `project_fusion_fw.md`、プロジェクト概要は `project_graphy_next.md` 参照。

## 6. 作業の進め方（このセッションの慣習）
- 変更ごとに **frontend `npm run build`（tsc込）/ backend `mvn compile`・該当テスト**を通してからコミット。
- 機能追加は **fw に設計/状態を追記**。i18n は ja/en 両方必ず。
- コミットはユーザ依頼時。`Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` を付与。
- ブランチは `main`（このプロジェクトの慣習で直接コミット）。
