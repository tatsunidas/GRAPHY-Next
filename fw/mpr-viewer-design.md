# MPR Viewer 設計（GRAPHY-Next）

> 作成: 2026-07-01。旧 GRAPHY `SimpleMPRViewer` の改良版を GRAPHY-Next（Cornerstone3D）へ。
> 関連: `fw/viewer-2d-architecture.md` / `fw/roi-mask-model.md` / 旧 `GRAPHY/docs/mpr.md` /
> 旧実装 `GRAPHY/src/main/java/com/vis/core/view/mpr/SimpleMPRViewer.java`(1000行)。

## 1. 目的・要件

DICOM ボリュームを **Axial / Sagittal / Coronal** の 3 断面で同時表示し、クロスヘアで連動スクロール
できる MPR ビューを GRAPHY-Next に実装する。本書はユーザー指定要件を満たす設計を確定する。

ユーザー指定要件（2026-07-01）:
1. **常に Axial を基準**にする。
2. **SAG/COR が src に入力されても、一旦 AX を作り、それを基準に MPR を再構成**する。
3. レイアウトは旧版の 2×2 を **1×3（横並び）** に変更。
4. **FSL Eyes ツールのように、画像ジオメトリ（上下・左右位置）が合うように**表示。
5. **Cornerstone/OHIF に MPR があれば、SimpleMPRViewer 実装との差分を取り、良い方を採用**。

## 2. 現状分析 — 旧 `SimpleMPRViewer`（ImageJ/CPU 抽出方式）

旧版のアルゴリズム（`SimpleMPRViewer.java`）:

- **入力正規化** `normalizeBaseVolume()`: 元シリーズの `ImageOrientation(0020,0037)`/`ImagePosition(0020,0032)`
  を読み、基準断面（AX/SAG/COR）の理想 LPS 方向（AX: row=R→L, col=A→P 等）へ IOP を上書き、
  各スライスの IPP を「新基準の (0,0) に対応する角」へ再計算。**OBLIQUE/UNKNOWN は正規化せず素通し**。
- **断面抽出** `extractPlane()`: 基準ボリュームの**ボクセル格子から軸平行に直接サンプリング**
  （例: AX 基準で SAG = 列 x 固定して (y,z) 平面を取り出す）。取り出した面を pixelSpacing 比で
  `resize(BILINEAR)` してアスペクト補正。
- **クロスヘア**: `currentX/Y/Z`（基準ボリュームのボクセル index）を 3 面で共有し、クリックで更新→
  `reconstructOrthogonalPlanes()` で 2 面を再抽出。`scaleZForDisplay/unscaleZForDisplay` で表示倍率変換。
- ガントリチルトは別途 `GantryTiltCorrector` で事前補正。

**旧版の制約（＝改良動機）**:

| 項目 | 旧 SimpleMPRViewer | 影響 |
|---|---|---|
| 補間 | 軸平行サンプリング＋2D resize のみ | 斜め/非等方ボリュームで幾何が崩れやすい |
| OBLIQUE/UNKNOWN | 正規化スキップ（素通し） | 斜め収集で MPR が破綻 |
| 可変スライス間隔 | 等間隔前提（pixelDepth 一定） | 非等間隔シリーズで Z 歪み |
| ガントリチルト | 外部前処理に依存 | パイプライン依存・二重管理 |
| 世界座標整合 | ピクセル index ベース（真の world 解決なし） | 断面間の上下左右整合が近似 |
| 実装言語 | Java/Swing/ImageJ | GRAPHY-Next（Web/Cornerstone）に非互換 |

## 3. 採用判断 — Cornerstone3D ネイティブ MPR を採用

GRAPHY-Next は **Cornerstone3D 3.33.5** を使用。検証の結果、**ネイティブの volume ベース MPR が完備**
していることを確認した（`node_modules` 実機確認済み）:

- `core.volumeLoader.createAndCacheVolume(volumeId, { imageIds })` ＋内蔵
  `cornerstoneStreamingImageVolumeLoader`（別パッケージ不要）。
- `VolumeViewport`（vtk.js バックの volume レンダリング、core にバンドル）。
- `Enums.OrientationAxis = { AXIAL, SAGITTAL, CORONAL, ACQUISITION }`。
- `tools.CrosshairsTool`（3 面連動十字線）＋ `SynchronizerManager`（W/L 等同期）。

アーキ doc（`fw/viewer-2d-architecture.md` §23）にも *「2D は StackViewport。MPR/3D が要る時だけ
VolumeViewport」* と既に方針が明記されており、本採用は既定路線と整合する。

### 差分比較（旧 vs Cornerstone ネイティブ）

| 観点 | 旧 SimpleMPRViewer | Cornerstone VolumeViewport | 採用 |
|---|---|---|---|
| ボリューム再構成 | 自前 IOP 正規化＋格子抽出 | IPP/IOP から **patient(LPS) world** へ自動構築 | **CS** |
| 基準＝Axial | 基準断面に依存（条件分岐） | world 座標で **常に解剖 AX/SAG/COR が定義**。src が SAG/COR でも自動的に AX 基準 | **CS** |
| 斜め/可変間隔/チルト | 制約あり/外部補正 | streaming volume が world で吸収（要検証: 非等間隔の scaling） | **CS** |
| ジオメトリ整合(FSL eyes 風) | 近似 | 3 viewport が**同一 world・同一 focalPoint 共有→自動整合** | **CS** |
| クロスヘア連動 | 自前 currentX/Y/Z | `CrosshairsTool`（world 投影・回転対応） | **CS** |
| W/L 同期 | 自前 | `Synchronizer、VOISync` | **CS** |
| コード資産 | Java（移植コスト大） | 既存 Cornerstone 基盤を再利用 | **CS** |
| Export（再構成 DICOM 書出し） | あり（`exportDicomSeries`） | 無（要自作） | 旧から**着想のみ移植**（任意・後段） |

**結論: Cornerstone3D ネイティブ MPR（VolumeViewport×3 + CrosshairsTool）を採用**。旧版からは
「常に Axial 基準」「再構成シリーズの DICOM Export」という**仕様意図のみ**を引き継ぐ。

### 要件の充足方法（重要）

- **要件1・2（常に Axial 基準 / SAG・COR src も AX 再構成）**:
  volume は imageIds の IPP/IOP から**患者座標系（LPS）**で構築される。よって取得断面が
  SAG/COR でも、3 つの `VolumeViewport` をそれぞれ `OrientationAxis.AXIAL/SAGITTAL/CORONAL`
  に設定すれば、**解剖学的 AX/SAG/COR が常に正しく**得られる（＝「一旦 AX を作り基準に」を
  volume 構築が自動充足）。旧版のような断面別条件分岐・正規化コードは**不要**。
- **要件3（1×3）**: 親 flex コンテナに 3 つの viewport DIV を `flex:1` 横並び。
- **要件4（FSL eyes 的整合）**: 3 viewport は同一 volume・同一 world を参照し、Crosshairs の
  focal point（jump 位置）を共有するため、**上下左右・拡大率の整合は volume レンダリングで自動**。
  追加で各 viewport の表示方位（patient orientation: L/R/A/P/S/I）ラベルを四辺に出して FSL eyes 同様に。

## 3.5 ガントリチルト補正（CT 前処理）— Cornerstone は非対応

**確認結果（node_modules 実コード）: Cornerstone3D 3.33.5 はガントリチルト補正をしない。**
- `core` / `tools` / `dicom-image-loader` に `tilt`/`gantry`/`shear` 処理は皆無（grep で確認）。
- `utilities/generateVolumePropsFromImageIds.js`: ボリューム第3軸 = `scanAxisNormal = rowCos × colCos`
  （スライス**法線**）で構築。
- `utilities/sortImageIdsAndGetSpacing.js` / `calculateSpacingBetweenImageIds.js`: `zSpacing` =
  「IPP 差の**法線への投影**」/(N−1)。**面内シアー成分（チルト）を捨てる**。
- 帰結: チルト CT をそのまま volume 化すると、スライスが法線方向に真っ直ぐ積まれ、**SAG/COR が歪む**。

→ **ユーザー指定どおり「CT は前処理でチルト補正 → Cornerstone MPR」が正しく必須**。

### 実装（済）: `src/viewer/gantryTiltCorrect.ts`
旧 `GantryTiltCorrector.java`（`correctVolume3D` 他）を純関数 TS 移植（typed array 入出力・Cornerstone 非依存）。
- `shearAngleDeg(ippFirst, ippLast, iop)`: スライス法線 N と進行 V の成す実シアー角。
- `needsTiltCorrection(...)`: 既定 0.5° 超で補正要。
- `correctGantryTilt(src, tiltAngleDeg, reconSliceSpacing?)`: 逆マッピング＋Y-Z バイリニアで直交
  Axial へ再サンプリング（X パススルー、FOV 外は padding）。**出力を `createLocalVolume` 形式**
  （`data / dimensions / spacing / origin / direction=純Axial右手系`）で返す。`tiltAngleDeg` は
  DICOM `0018,1120`（符号付き、旧 Java 検証済み入力）。型チェック green。

### Cornerstone へ渡す経路: `createLocalVolume`
`core.volumeLoader.createLocalVolume(volumeId, { metadata, dimensions, spacing, origin, direction, scalarData })`
に補正済み scalarData を直接渡す（imageId 由来ジオメトリを完全バイパス）。3 VolumeViewport に
`setVolumes([{ volumeId }])`。**これで「一旦 AX を作り基準に」が物理的に成立**。

### CT 前処理パイプライン（MprScreen, P1 で配線）
1. series の `modality` を確認。**CT かつ** `needsTiltCorrection(ippFirst, ippLast, iop)` の時のみ補正。
2. imageIds の画素を読み込み（`imageLoader.loadAndCacheImage` → `cache.getImage().voxelManager`）
   z-major の `TiltSourceVolume.data` を組み立てる。padding = 空気 HU の格納値（rescale 逆算）。
3. `tiltAngleDeg = 0018,1120`（無ければ幾何から推定）で `correctGantryTilt` → `createLocalVolume`。
4. **非 CT / チルト無し CT** は通常経路 `createAndCacheVolume({ imageIds })`（streaming）。

## 4. アーキテクチャ設計（GRAPHY-Next 統合）

### 4.1 起動・ルーティング

- MainScreen の `handleOpenViewer("mpr")`（現状 "comingSoon" バナー）を実体化。
- 2D Viewer と同じ別ウィンドウ方式: desktop=`openViewer("mpr")` / web=`window.open("#mpr","graphy-mpr")`。
- 選択中 study/series を `localStorage("graphy-mpr-ctx")` で受け渡し（2D の `graphy-viewer-ctx` に倣う）。
- `App.tsx` のハッシュルートに `#mpr → <MprScreen/>` を追加。

### 4.2 新規ファイル

| ファイル | 役割 |
|---|---|
| `src/viewer/mpr.ts` | volume 構築・3 viewport セットアップ・Crosshairs/同期配線（ロジック中核） |
| `src/viewer2d/MprScreen.tsx`（or `src/mpr/MprScreen.tsx`） | 画面: 1×3 レイアウト・ツールバー・コンテキスト受信 |
| （任意）`src/mpr/MprToolbar.tsx` | W/L プリセット・スラブ厚・Export 等のツールバー |

- **RenderingEngine**: 別ウィンドウのため MPR 専用エンジン `graphy-mpr-engine`（2D の
  `graphy-engine` とは WebGL コンテキストを分離）。3 viewport を `setViewports([...])` で一括登録。
- **imageIds**: 既存データ層を再利用 — `fetchInstances(studyUid, seriesUid)` →
  `imageIdForInstance(mode, sopUid)`（`viewer/imageId.ts`）。volumeLoader が IPP で内部ソート。
- **volume 構築**: `createAndCacheVolume("graphy-mpr-vol:<seriesUid>", { imageIds })` →
  `volume.load()`。3 viewport へ `setVolumes([{ volumeId }])`。

### 4.3 ツール / 同期

- `addTool(CrosshairsTool)` → MPR 専用 ToolGroup に 3 viewport を登録、左ドラッグ=Crosshairs。
- W/L: `WindowLevelTool`（右ドラッグ）＋ `VOI Synchronizer` で 3 面同期（旧版「1 面調整→全面反映」を踏襲）。
- Pan/Zoom: 既存ツールを流用。スクロール=各 viewport のスライス送り（`StackScrollTool` の volume 版）。
- 初期 WL: シリーズの Window Center/Width、無ければ volume レンジから。

### 4.4 表示（FSL eyes 風）

- 1×3、各 viewport に断面名ラベル（AX/SAG/COR）と**四辺の患者方位文字**（L/R/A/P/S/I; `viewer/orientation.ts`
  の方位ロジックを volume 用に流用/拡張）。
- Crosshairs の現在 world 位置（mm）/各面スライス番号をオーバーレイ表示。

## 5. 実装フェーズ

- **P0 設計（本書）** ✔
- **P1 最小 MPR** ✔（実装済・実機確認済み）: 起動導線＋volume 構築＋1×3 で AX/SAG/COR 表示（基準=AXIAL orientation）。
  **CT はガントリチルト補正前処理（§3.5）を配線**。Crosshairs 連動・右=W/L・中=Pan・ホイール=スライス送りも同梱。
  - 実装ファイル: `viewer/mpr.ts`（`buildMprVolume`＝CTチルト時 `createLocalVolume`／他 `createAndCacheVolume`、
    `setupMprViewports`＝ORTHOGRAPHIC×3＋ToolGroup＋Crosshairs）、`mpr/MprScreen.tsx`（1×3 UI・ctx 受信）、
    `cornerstoneSetup.ts`（CrosshairsTool/StackScrollTool 登録）、`App.tsx`（#mpr ルート）、
    `MainScreen.tsx`（`handleOpenViewer("mpr")`→`graphy-mpr-ctx`＋openViewer/window.open）、i18n(ja/en)。
  - 検証: `tsc -b`＋`vite build` green、**実機で −23° チルト CT の補正後 MPR 表示を確認**（§5.5）。
  - 既知の P1 制約: standalone のみ（web は wadors 未対応）／単一シリーズ／WL 手動／シリーズ未指定時は最多枚数を採用。
- **P2 連動** ✔（実装済・要実機検証）: VOI(W/L) 同期・方位ラベル・スライス番号オーバーレイ・W/L プリセット。
  - VOI 同期: `sync.ts` `getOrCreateVoiSync("graphy-mpr-voi")` を 3 面に add（同一ボリュームゆえ絶対値同期でよい）。
    1 面の W/L 調整が 3 面へ反映。teardown で `destroySynchronizer`。
  - 方位ラベル（L/R/A/P/H/F）: 既存 `orientation.ts` `computeOrientationMarkers`（canvasToWorld 由来＝
    VolumeViewport でも動作）を流用し四辺に表示（FSL eyes 風）。`CAMERA_MODIFIED` で追従。
  - スライス番号: `getSliceIndex()`/`getNumberOfSlices()` を各面に「n / 総数」表示。
  - W/L プリセット: `viewer2d/wlPresets.ts`（brain/soft/lung/bone/abdomen/liver）をヘッダの select から
    `applyMprWl`（voiRange 設定）で 3 面適用、Default=`resetMprWl`（metadata VOI へ）。
  - 実装: `viewer/mpr.ts`（`applyMprWl`/`resetMprWl`/`readMprOverlay`/VOI sync）、`mpr/MprScreen.tsx`
    （四辺ラベル・スライス番号・プリセット select）。`tsc -b` ＋ `vite build` green。**実機確認済み**。
- **P2.5 プローブ読み取り** ✔（実装済・実機確認済み）: MPR 上段にマウス直下の**実空間座標 XYZ(mm, LPS)**・
  **ボクセル IJK**・**輝度値（CT=HU）** をライブ表示。
  - `viewer/mpr.ts` `probeMpr(engine, viewportId, canvasX, canvasY)`: `canvasToWorld`→world、
    `getImageData()` の vtkImageData に `utilities.transformWorldToIndex`→IJK、`voxelManager.getAtIJK` で値。
  - `mpr/MprScreen.tsx`: 各面 `onMouseMove/onMouseLeave`＋等幅の読み取りストリップ（ヘッダ直下）。i18n(ja/en)。
- **P3 統合**: W/L プリセット（`viewer/wlPresets.ts`）流用、計測/ROI の MPR 対応可否を検討、
  スラブ厚(MIP/平均)オプション。
- **P4 拡張**: 再構成シリーズの **DICOM Export**（旧 `exportDicomSeries` の意図を移植）、
  oblique/曲面 MPR、4D（C/T）対応。

## 5.5 実機検証（2026-07-01・済）

- **数値検証（チルト補正）**: 合成 20° シアーを `correctGantryTilt` で復元 → 直交 Axial・内側 918 ボクセルで
  maxAbsErr=0（線形ファントムを厳密再現）。検証スクリプト `scratchpad/verify_tilt.mjs`。
- **実データ MPR（standalone :8080）**: `gantry_tilt_sample`（Toshiba/Canon CT・**Gantry Tilt −23.0°**）で
  **チルト補正後の 1×3 MPR が正しく表示**（ユーザー確認済み）。幾何導出 `atan2(Cz,Cy)=−23.0°` が
  DICOM `0018,1120` と完全一致。
- **テストデータ整備**: `gantry_tilt_sample` はプリアンブル無し Implicit VR（PS3.10 非準拠）で `looksDicom`
  が正しく除外 → dcm4che `dcm2dcm` で Part-10 化して **`~/graphy_sample_images/gantry_tilt_sample_part10/`**
  （28 枚・単一シリーズ）を作成。バックエンド `looksDicom` は変更しない方針。
- **不具合修正**: MprScreen が起動時 `status=null` を "web" と誤判定 → `status` 確定後に 1 度起動へ修正。

## 6. リスク・要検証

- **単一スライス/少数スライスは MPR 不可**（旧 doc 同様）。最小スライス数チェック＋ガード（バナー）。
- **ガントリチルト（CT）**: Cornerstone 非対応（§3.5）。`gantryTiltCorrect.ts` で前処理補正 →
  `createLocalVolume`。**チルト角の符号**（0018,1120 vs 幾何）と、原点/方向の Cornerstone 受け渡しは
  実 CT（チルトあり）で要検証。タグ欠落時の幾何推定もフォールバックとして要検証。
- **非等間隔スライス**: streaming 通常経路は均一 spacing 前提。非等間隔シリーズは要検証（必要なら
  同様に `createLocalVolume` 経路で等間隔再サンプリング）。
- **メモリ**: volume はフル 3D を確保（512²×500 ≈ 数百 MB）。大シリーズで遅延/上限の検討（旧 doc の注意点と同じ）。
- **WebGL コンテキスト**: MPR 専用エンジンで 2D とコンテキスト分離。同時起動時の GPU メモリに注意。
- **マルチフレーム/4D**: 初期スコープは単一 3D volume。enhanced MF・C/T 切替は P4。
- **React StrictMode 無効前提**（`fw/roi-mask-progress.md` 注記）を踏襲。

## 7. 決定事項（確定）

- MPR 実装は **Cornerstone3D ネイティブ VolumeViewport ×3 + CrosshairsTool** を採用。旧 ImageJ
  抽出方式は**不採用**（仕様意図＝「常に Axial 基準」「再構成 DICOM Export」のみ継承）。
- レイアウトは **1×3（AX | SAG | COR 横並び）**。
- 「常に Axial 基準 / SAG・COR src も AX 再構成」は **volume の world(LPS) 構築で自動充足**し、
  各面の OrientationAxis を解剖断面に固定することで実現する。
- ジオメトリ整合（FSL eyes 風）は同一 world・focalPoint 共有で自動。方位ラベルを補助表示。
- **ガントリチルト補正は Cornerstone 非対応**のため、**CT は前処理**（`src/viewer/gantryTiltCorrect.ts`：
  旧 `GantryTiltCorrector` の TS 移植・実装済）で直交 Axial へ再サンプリング → `createLocalVolume` で
  MPR へ。非 CT／チルト無しは `createAndCacheVolume` 通常経路。

## 8. 現況・引き継ぎ（2026-07-01 セッション終了時点）

**状態: P0〜P2.5 実装＋実機確認済み。P1/P2 はコミット済み、P2.5 プローブ＋本doc更新は未コミット。**

### コミット状況
- **`de8a475 "update"` にコミット済み**（P1+P2）: `gantryTiltCorrect.ts`・`mpr.ts`・`MprScreen.tsx`（新規）、
  `App.tsx`・`MainScreen.tsx`・`cornerstoneSetup.ts`・`i18n(ja/en)`（変更）、`fw/mpr-viewer-design.md`。
- **未コミット（P2.5 プローブ読み取り＋doc）**:
  - `frontend/src/viewer/mpr.ts`（`probeMpr` 追加, +47）
  - `frontend/src/mpr/MprScreen.tsx`（マウス読み取り UI, +84）
  - `frontend/src/i18n/ja.ts`・`en.ts`（`mpr.value`/`mpr.voxel`/`mpr.probeHint`, +3/+3）
  - `fw/mpr-viewer-design.md`（本更新）

### MPR 実装ファイル一覧
| ファイル | 内容 |
|---|---|
| `frontend/src/viewer/gantryTiltCorrect.ts` | 旧 `GantryTiltCorrector` の TS 移植（`correctGantryTilt`/`needsTiltCorrection`/`shearAngleDeg`）。純関数。数値検証済み |
| `frontend/src/viewer/mpr.ts` | MPR 中核: `buildMprVolume`/`setupMprViewports`/`applyMprWl`/`resetMprWl`/`readMprOverlay`/`probeMpr`/`teardownMpr` |
| `frontend/src/mpr/MprScreen.tsx` | 1×3 UI・方位/スライス/プローブ表示・W/L プリセット・ctx 受信 |
| `frontend/src/viewer/cornerstoneSetup.ts` | `CrosshairsTool`/`StackScrollTool` 登録（※`PlanarFreehandROITool` は別ワーカー分） |
| `frontend/src/App.tsx` | `#mpr → <MprScreen/>` ルート |
| `frontend/src/mainscreen/MainScreen.tsx` | `handleOpenViewer("mpr")` 実体化 |
| `frontend/src/i18n/ja.ts`・`en.ts` | `mpr.*` キー |

- 注: `RoiManagerPanel.tsx`/`Viewer2D.tsx`・`roi3d.ts`/`sphere3dStore.ts` 等は**別ワーカーの sphere3d 作業**（`de8a475` に混在）。MPR とは無関係。
- ビルド: `cd frontend && npx tsc -b && npx vite build` で green。**ルートで `npm run build` 実行禁止**（Maven が走る）。

### 実機検証（§5.5 参照・完了）
- チルト補正 MPR を実 CT（−23°, `gantry_tilt_sample_part10`）で確認済み。数値検証 maxAbsErr=0。
- テストデータは `~/graphy_sample_images/gantry_tilt_sample_part10/`（原本はプリアンブル無しで import 不可 → `dcm2dcm` で Part-10 化。メモリ `mpr-tilt-test-data` 参照）。

### 次の一手
1. **P2.5 プローブ分をコミット**（上記 4 ファイル未コミット）。`main` 直コミット（`Co-Authored-By` 付き）。
2. **追加の実機確認**: MR（非CT）・3D-FLAIR（サジタル収集 `~/graphy_sample_images/dicom_samples/3DFLAIR/3D-FLAIR`）で AX 基準再構成の目視。
3. **P3**: 計測/ROI の MPR 対応・スラブ厚（MIP/平均）。
4. **P4**: 再構成シリーズの DICOM Export（旧 `exportDicomSeries` 移植）・oblique・4D（C/T）。
5. **P1 制約の解消**: web モード（wadors）対応・複数シリーズ選択 UI。

