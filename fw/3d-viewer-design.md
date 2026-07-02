# 3D Viewer 設計（GRAPHY-Next）

> 作成: 2026-07-02。旧 GRAPHY `com.vis.core.view.D3` パッケージ（**14,581 行**・LWJGL/OpenGL 3.3 手書き GPU レイマーチャ）を
> GRAPHY-Next（Cornerstone3D 3.33.5 ＋ 同梱 `@kitware/vtk.js` 32.12.1 / React+TS / Spring Boot+dcm4che backend）へ移植する。
> 関連: `fw/mpr-viewer-design.md`（volume 構築・ガントリチルト補正を共有）/ `fw/slicer-design.md`（実画像空間・二層構成の先行事例）/
> `fw/roi-manager-design.md` / `fw/roi-mask-model.md` / `fw/segmentation-tools-design.md` / `fw/viewer-2d-architecture.md`（単一入口の輝度校正）。
> 旧実装: `GRAPHY/src/main/java/com/vis/core/view/D3/{ui,util,roi,endo}/`（主要: `Viewer3DMain`/`GLCanvas`/`VolumeRenderer`/
> `VolumeData`/`VolumeLoader`/`GantryTiltCorrector`/`MarchingCubes`/`MeshVoxelizer`/`cinematic/*`/`endo/*`）、
> `GRAPHY/.../centerline/{Skeletonizer3D,SkeletonGraphExtractor,CenterlineGraph}` ＋ `GRAPHY/.../slicer/{Centerline3D,VolumeSampler,CurvedReformatter,StraightenedVolumeBuilder}`、
> シェーダ `GRAPHY/src/main/resources/shaders/{volume,slice,cinematic,present}.{vert,frag}`。

---

## 1. 目的・要件

DICOM ボリュームを 3D 表示・編集する GRAPHY の 3D Viewer を **TypeScript + VTK.js** で忠実に再現する。

ユーザー指定要件（2026-07-02）:

1. GRAPHY の 3D Viewer を **TS + VTK で忠実に再現**する。
2. **レンダリング必須**: VR（DVR/ボリュームレンダリング）・MIP・Ortho（3 直交スライス）・**Cinematic Rendering**。
3. **メッシュと 3D ROI の管理**（色・透明度・計測）。
4. **3D ROI ↔ メッシュ相互変換**（ROI→メッシュ生成／メッシュ→3D ROI 生成）。
5. **STL 出力・STL インポート**。
6. **LUT の変更**。
7. **3D LUT カーブダイアログ**（不透明度転送関数エディタ）。
8. **内視鏡モード**（fly-through）。
9. **中心線解析**。
10. 各機能で **cornerstone に実装があれば GRAPHY と差分を取り、良い方を採用**。
11. **cornerstone には 3D ジオメトリ絡みのバグがある**（slicer で判明）。**必ず実画像空間（患者 LPS mm）ベースで計算**する。

### 確定・推奨した設計判断（2026-07-02）

| 判断点 | 決定 | 根拠 |
|---|---|---|
| GPU シーン基盤 | **cornerstone `VolumeViewport3D`（`VOLUME_3D`）を土台**＋その内部 vtk.js renderer に**自前アクターを addActor** | RenderingEngine/ツール/VR プリセット/`TrackballRotateTool`/`setBlendMode` を再利用しつつ、mesh・ROI 表面・中心線・内視鏡経路を vtk.js アクターで重畳。両者は同一 vtk.js レンダラ上で共存 |
| 確定計算（メッシュ・ボクセル・中心線・CPR） | **自前 real-space compute（TS + vtk.js フィルタ）** | slicer と同じ二層構成。表示≠確定計算。GPU 表示のピクセルではなく、実 voxel 幾何で決定的に計算 |
| 座標系 | **全て患者 LPS mm。cornerstone の camera/canvas 変換に依存しない** | 要件 11。slicer で発覚した cornerstone 3D 幾何バグを回避。`vtkImageData.setDirection()` に IOP を渡し、実幾何で完結 |
| volume 構築 | **MPR/Slicer と共通の `buildMprVolume`（CT チルト時は `gantryTiltCorrect` 済み直交 volume）** | チルト補正済みの実空間 volume を入力にすることで幾何が閉じる（要件 11）。cornerstone streaming の Z 折返しも解消済み |
| VR/MIP | **cornerstone `VolumeViewport3D` の blendMode（COMPOSITE / MAXIMUM_INTENSITY / MINIMUM_INTENSITY）＋転送関数** | 旧 `volume.frag` の `uRenderMode` と 1:1。MIP の LUT 着色も color TF で等価に再現可能 |
| Cinematic | **段階導入**: v1 = 陰影付き VR（`vtkVolumeProperty.setShade`＋勾配不透明度＋アンビエントオクルージョン近似）／v2 = 旧 `cinematic.frag` を移植した**プログレッシブ・パストレース専用 WebGL2 パス** | vtk.js/cornerstone に path tracer は無い。まず"lit-VR"で臨床上有用な陰影を提供し、忠実なマルチバウンス散乱・ソフトシャドウは専用パスで後追い |
| 3D ROI マスク | **labelmap を `vtkImageData`（origin=IPP・direction=IOP・spacing）で実空間保持** | 旧 `FreeFormRoi3D` の patient-space モデルを踏襲。旧 MC の "voxel×spacing で IOP/IPP を捨てる" 近道は**採用しない**（幾何欠落の元） |
| ROI→メッシュ | **`vtkImageMarchingCubes`/`vtkFlyingEdges3D` を実空間 labelmap に適用 → 真の LPS 頂点** | vtk.js に標準実装あり。旧 Laplacian より `vtkWindowedSincPolyDataFilter`（収縮が少ない）を採用 |
| メッシュ→ROI | **`vtkPolyDataToImageStencil` + `vtkImageStencil`** | 旧スキャンライン parity fill を vtk.js 標準で置換 |
| STL I/O | **`vtkSTLReader`/`vtkSTLWriter`（binary/ascii）。頂点は患者 LPS mm** | 旧はローカル mm（voxel×spacing）出力だったが、実空間統一のため患者座標で出力（相互運用性向上） |
| LUT | **既存 `LutDialog.tsx`＋backend LUT → `vtkColorTransferFunction`** | 既存資産再利用。RGB とオパシティを分離保持（旧 `rebuildAndUploadLut` と同思想） |
| 3D LUT カーブ | **`vtkPiecewiseFunction`＋ヒストグラム編集 UI（HU 軸）** | 旧 `OpacityCurvePanel` を移植。vtk.js `vtkPiecewiseGaussianWidget` を土台候補に |
| 中心線 spline/フレーム | **既存 `viewer/centerline.ts` を再利用**（Catmull-Rom＋弧長＋RMF/FIXED_Z 実装済み） | 旧 `Centerline3D` は既に TS 移植済み。内視鏡カメラの up ベクトルにも RMF を流用 |
| 中心線 自動抽出 | **`itk-wasm` の 3D thinning もしくは Lee-94 の WASM 移植**＋グラフ抽出/DP/Dijkstra は素の TS | 骨格化（`Skeletonize3D_`）のみ vtk.js に等価が無い唯一の重量級。他は直移植 |
| W/L 単位 | **常に HU/SUV（モダリティ値空間）で保持**し TF レンジを駆動 | `pixelCalibration` 単一入口原則（Rescale 二重適用禁止）。旧の正規化 0–1 空間 WL は採らない |
| 初期スコープ | **standalone のみ**（MPR/Slicer と同じ）。web は後続 | 既存パターン踏襲 |

---

## 2. 旧 GRAPHY 3D Viewer の構造（移植対象の抽出）

**構造の要点: LWJGL/OpenGL 3.3 core-profile の手書き GPU レイマーチャ**（VTK でもシーングラフでもない）。Swing `AWTGLCanvas` 上で JOML 数学。
GL コンテキストは `paintGL()` 内でのみ有効で、EDT からの状態変更は `pending*` フラグで遅延適用。

### 2.1 サブシステム一覧（移植対象）

| 旧ファイル（`view/D3/`） | 役割 | 移植先の方針 |
|---|---|---|
| `ui/Viewer3DMain.java`(1315) | オーケストレータ（JFrame＋コントロールパネル、モード切替・全 setter 配線） | `Viewer3DScreen.tsx` ＋ 右コントロールパネル |
| `ui/GLCanvas.java`(1851) | GL キャンバス・カメラ・全マウス/キー操作・オーバーレイ束ね | cornerstone `VolumeViewport3D`＋自前アクター＋操作配線 |
| `ui/VolumeRenderer.java`(743)＋`shaders/volume.frag` | VR/MIP レイマーチ・LUT/転送関数・ROI マスク・クリップ | `vtkVolume`+`vtkVolumeMapper`+`blendMode`+color/opacity TF |
| `shaders/slice.frag` | Ortho 3 直交スライス | 3× `vtkImageSlice`/`vtkImageResliceMapper` |
| `ui/VolumeData.java`(323)/`VolumeLoader.java`(366) | DICOM→voxel 配列＋幾何（IPP/IOP/stepZ・min/max・ヒストグラム） | `buildMprVolume`＋`ResliceVolume`（既存）で代替 |
| `ui/GantryTiltCorrector.java`(399)/`util/AxialConverter.java`(192) | チルト de-shear・斜位→軸位リサンプル | 既存 `gantryTiltCorrect.ts`（＋不要な X ミラー/軸位化は VTK の direction で回避） |
| `ui/cinematic/*`＋`shaders/cinematic.frag`,`present.frag` | Monte-Carlo ボリューム・パストレーサ | 段階導入（§6.4） |
| `ui/OpacityCurvePanel.java`(342)/`VolumeOpacityCurveEditorDialog.java`(93) | 不透明度カーブ編集（ヒストグラム＋ドラッグ点） | `vtkPiecewiseFunction`＋React ダイアログ（§7） |
| `ui/MarchingCubes.java`(564) | 3D ROI マスク→表面メッシュ | `vtkImageMarchingCubes`/`vtkFlyingEdges3D`（§8.2） |
| `ui/MeshVoxelizer.java`(112) | メッシュ→3D ROI マスク | `vtkPolyDataToImageStencil`+`vtkImageStencil`（§8.3） |
| `ui/Mesh{Data,Renderer,Loader,Repairer,Validator}.java`/`util/MeshExporter.java`/`AlignMesh.java` | メッシュ格納・描画・STL/OBJ I/O・修復 | `vtkPolyData`+`vtkActor`＋`vtkSTL/OBJ Reader/Writer`＋`vtkCleanPolyData`（§8.4） |
| `util/MeshAnalyzer.java`/`MeshMeasureResult.java`/`RayMeshIntersector.java`/`ui/Measurement3D*` | メッシュ計測（体積/表面積/主径）・ピッキング・3D 計測線 | `vtkMassProperties`＋PCA＋`vtkCellPicker`（§8.5） |
| `roi/{RoiObj3D,SphereRoi3D,FreeFormRoi3D,Editable3D,SegmentationManager}.java` | 3D ROI オブジェクトモデル（patient-space labelmap・色/透明度・編集・ブール・分割） | 実空間 `vtkImageData` labelmap＋既存 `roiMaskStore`/`roiBooleanOps`（§8.1） |
| `ui/{ClipBoxRenderer,ClipBoxInteractor,CutLineRenderer,AxesGizmo}.java` | クリップボックス・カット・向きギズモ | `vtkVolumeMapper` cropping＋box widget＋`vtkOrientationMarkerWidget`（§6.5） |
| `ui/Camera.java` | クォータニオン arcball | `vtkInteractorStyleTrackballCamera`／`TrackballRotateTool` |
| `endo/{EndoCamera,EndoPath3D,EndoPathPoint3D,EndoPathPicker,EndoCommands}.java`＋`ui/{EndoPathRenderer,EndoOrientationIndicator}` | 内視鏡 fly-through | `vtkCamera` 手動駆動＋`vtkPolyLine`／既存 `centerline.ts` フレーム（§9） |
| `ui/CenterlineAnalysisDialog.java`(550)/`CenterlineGraphRenderer.java`(245) | 中心線解析 UI・3D グラフ描画 | React ダイアログ＋vtk.js polyline/glyph（§10） |
| `centerline/{Skeletonizer3D,SkeletonGraphExtractor,CenterlineGraph,CenterlineBranch,CenterlineNode}` | 骨格化・グラフ抽出・prune/最短路 | itk-wasm thinning＋素 TS グラフ（§10） |
| `slicer/{Centerline3D,VolumeSampler,CurvedReformatter,StraightenedVolumeBuilder}` | mm 空間 spline＋フレーム・CPR・ストレート化 | 既存 `centerline.ts`/`curvedReformat.ts`（一部済）＋新規（§10） |
| `ui/UndoManager.java` | コマンド式 undo/redo | zustand/簡易 2 スタック |

### 2.2 座標系の三空間問題（**最重要・移植の心臓部**）

旧実装は **3 つの座標空間**を混在させており、これが要件 11 の「実画像空間で計算」の核心。

| 空間 | 定義 | 旧使用箇所 |
|---|---|---|
| **患者 LPS mm（真の DICOM）** | `world = IPP + IOP_row·(i·spX) + IOP_col·(j·spY) + normal·(k·spZ)` | ROI マスク（`FreeFormRoi3D`/`SphereRoi3D`）、CPR/中心線の `VolumeSampler` |
| **ローカル volume mm（"raw mesh"）** | `vertex = (i·spX, j·spY, k·thick)` — 軸整列・原点は voxel(0,0,0)・**IPP 平行移動も IOP 回転も捨てる** | `MarchingCubes` 出力・`MeshAnalyzer`・`MeshExporter` STL・`MeshVoxelizer` 入力 |
| **GL レンダ空間 `[-0.5, +0.5]³`** | 物理範囲で正規化＋中心化（`AlignMesh`）＋**X ミラー**で右手系化 | GPU 描画・`RayMeshIntersector`・内視鏡経路（cube 空間） |

**移植の絶対原則:**
- 旧 `MarchingCubes` は頂点を `voxel_index × spacing` の軸整列格子に置き、**IOP/IPP を捨てる**（自己完結だが患者座標ではない）。
  → 移植では labelmap を **正しい `vtkImageData`（origin/direction/spacing）** で構築し、`vtkImageMarchingCubes` に direction 行列を効かせて**真の LPS 頂点**を得る。"voxel×spacing の近道" は継承しない。
- 旧 GL の **X ミラー**と **AxialConverter の軸位リサンプル**は、右手系 GL の unit-cube に合わせるための小細工。
  → **VTK.js は右手系で `vtkImageData.setDirection()` を持つ**ため、斜位/チルト幾何をそのまま描画でき、ミラーも軸位化も不要（要件 11 に直結）。
- 内視鏡は cube 空間、中心線は LPS mm で、両者は旧 `VolumeSampler.toLocalRenderSpace()` の一点で繋がっていた。
  → 移植では **シーン全体を患者 LPS mm に統一**し、cube ステップを廃止する（`centerline.ts` は既に LPS mm）。

---

## 3. 中核となる設計原則

### 3.1 実画像空間（患者 LPS mm）で全計算 — cornerstone 3D ジオメトリバグ回避

- メッシュ頂点・ROI マスク・中心線点・内視鏡カメラ位置・計測値は**全て患者 LPS mm**。導出元は
  **チルト補正済み volume の origin/direction/spacing**（`buildMprVolume`→`ResliceVolume`）であり、**cornerstone の camera/canvasToWorld ではない**。
- slicer P2 で cornerstone のカメラ焦点・canvasToWorld 依存が幾何崩れ（上下反転/ミラー/面ごとのズレ）を招いた事実を踏まえ、
  **座標変換は自前の real-space ユーティリティ**（`orthoMpr.ts` の `worldToVoxel`/`voxelToWorld`、`reslice.ts` の `makeWorldSampler`）で閉じる。
- GPU 表示のためだけに vtk.js/cornerstone のカメラを使うが、**確定的な幾何・計測は表示系に一切依存しない**。

### 3.2 二層アーキテクチャ（表示 / 確定計算の分離）— slicer と同じ思想

| 層 | 担当 | 実体 |
|---|---|---|
| **表示層（インタラクティブ GPU）** | cornerstone `VolumeViewport3D`（VR/MIP/Ortho プレビュー）＋自前 vtk.js アクター（mesh/ROI 表面/中心線/内視鏡経路） | GPU レンダリング。WYSIWYG プレビュー |
| **確定計算層（決定論的 CPU/GPU compute）** | 実空間サンプラ・marching cubes・voxelize・骨格化・CPR | 保存・計測・エクスポートに使う確定値。表示ピクセルと 1:1 一致しない処理はこちらで |

理由: GPU レイマーチのピクセルは表示用であり、STL 頂点・ROI 体積・SUV 統計などの**決定的な値**とは一致しない。slicer の
「表示＝cornerstone / 確定生成＝自前サンプラー」を 3D にも適用する。

### 3.3 単一入口の輝度校正（HU/SUV）

- 転送関数の入力・W/L・ROI 統計は必ず `viewer/pixelCalibration.ts` の `getModalityCalibration`/`readModalitySlice` 経由。
  **Rescale の二重適用を禁止**（`fw/viewer-2d-architecture.md`・[[pixel-calibration-single-entry]]）。
- W/L は**モダリティ値空間**（CT=HU、PET=Bq/mL、SUV 校正時は SUV）で保持し、TF レンジをその単位で駆動。
  旧実装の「正規化 0–1 テクスチャ空間 WL」は採用しない。PET は既存 `suvStore`（[[suv-calibration-port]]）と合成。

---

## 4. cornerstone3D / VTK.js との差分と役割分担（機能別）

**結論: VR/MIP/Ortho・カメラ・クリップは cornerstone/vtk.js 標準を採用。メッシュ生成・ボクセル化・骨格化・CPR・Cinematic は自前 real-space。**

| 機能 | 旧 GRAPHY | cornerstone/vtk.js 標準 | 採否 | 3D Viewer での役割 |
|---|---|---|---|---|
| VR（DVR） | `volume.frag` emission-absorption 合成 | `VolumeViewport3D` + `COMPOSITE_BLEND` + color/opacity TF | **cornerstone** | 主表示。TF は §7 |
| MIP / MinIP | `uRenderMode==0` の maxVal 追跡 | `MAXIMUM_/MINIMUM_INTENSITY_BLEND` | **cornerstone** | MIP も color TF で着色（旧 `maxValColor` と等価） |
| Ortho（3 直交スライス） | `slice.frag` 3 テクスチャ矩形 | 3× `vtkImageSlice`/`vtkImageResliceMapper` を 3D シーンに配置 | **vtk.js** | 実空間スライス面。位置は LPS で駆動 |
| Cinematic | `cinematic.frag` MC パストレーサ | **無し** | **自前**（§6.4 段階） | v1 陰影 VR / v2 移植パストレース |
| 転送関数（色） | `currentLutRgb[256×3]` | `vtkColorTransferFunction` | **vtk.js**＋既存 LUT | §7 |
| 転送関数（不透明度カーブ） | `OpacityCurvePanel` 256byte | `vtkPiecewiseFunction`（＋`vtkPiecewiseGaussianWidget`） | **vtk.js**＋自前 UI | §7 |
| カメラ orbit/zoom | `Camera`（quat arcball） | `TrackballRotateTool` / `vtkInteractorStyleTrackballCamera` | **cornerstone/vtk.js** | 既定操作 |
| W/L | 正規化空間 | TF レンジ（HU） | **自前（HU 単位）** | §3.3 |
| クリップボックス | slab test＋widget | `vtkVolumeMapper` cropping＋box widget | **vtk.js** | §6.5 |
| カット（lasso 彫刻） | `VolumeEditor.calculateCut` | 無し（widget で近い） | **自前** | 後続フェーズ |
| 向きギズモ | `AxesGizmo` | `vtkOrientationMarkerWidget`+`vtkAxesActor` | **vtk.js** | 標準採用 |
| ROI→メッシュ | `MarchingCubes`（Laplacian） | `vtkImageMarchingCubes`/`vtkFlyingEdges3D`＋`vtkWindowedSincPolyDataFilter` | **vtk.js**（良い方） | §8.2 |
| メッシュ→ROI | scanline parity fill | `vtkPolyDataToImageStencil`+`vtkImageStencil` | **vtk.js** | §8.3 |
| STL/OBJ I/O | 手書き binary STL 書き/読み | `vtkSTLReader/Writer`,`vtkOBJReader` | **vtk.js** | §8.4 |
| メッシュ計測 | `MeshAnalyzer`（体積/面積/PCA 径） | `vtkMassProperties`＋PCA | **vtk.js**＋自前 PCA | §8.5 |
| メッシュ描画・色/透明度 | `MeshRenderer`（手書き GL） | `vtkActor`+`vtkMapper`（`setColor/setOpacity`） | **vtk.js** | §8.6 |
| 3D ROI 表面表示 | オーバーレイ塗り | cornerstone `SegmentationRepresentations.Surface` or `vtkActor` | **vtk.js アクター** | §8.1 |
| 3D ROI labelmap | sparse bit-packed per-Z | `vtkImageData` 実空間 labelmap | **自前（実空間）** | §8.1 |
| ブール/連結成分分割 | `or/and/xor`・6 近傍 BFS | 既存 `roiBooleanOps.ts`（OR/AND/XOR・CCL 済） | **既存再利用** | §8.1 |
| 内視鏡カメラ | `EndoCamera`（up 反転バグあり） | `vtkCamera` 手動＋**RMF up**（`centerline.ts`） | **自前**（バグ修正版） | §9 |
| 経路 spline | Catmull-Rom＋弧長 | 既存 `centerline.ts` | **既存再利用** | §9,§10 |
| 中心線 spline/フレーム | `Centerline3D`（RMF/FIXED_Z） | 既存 `centerline.ts`（移植済） | **既存再利用** | §10 |
| 中心線 CPR/ストレート化 | `CurvedReformatter`/`StraightenedVolumeBuilder` | 既存 `curvedReformat.ts`（一部）＋`vtkImageReslice` | **既存＋自前** | §10 |
| 骨格化（自動抽出） | `Skeletonize3D_`（Lee-94） | **無し** | **itk-wasm/WASM 移植** | §10（唯一の重量級） |
| volume 構築・チルト補正 | `VolumeLoader`+`GantryTiltCorrector` | 既存 `buildMprVolume`+`gantryTiltCorrect.ts` | **既存再利用** | §5.3 |

---

## 5. アーキテクチャ

### 5.1 起動・ルーティング（MPR/Slicer に倣う）

- MainScreen: シリーズ右クリック / 2D ビューアメニュー → 「3D Viewer を開く」。`handleOpenViewer("viewer3d")`。
- desktop=`openViewer("viewer3d")` / web=`window.open("#viewer3d","graphy-viewer3d")`（初期 standalone のみ）。
- コンテキスト受け渡し: `localStorage("graphy-viewer3d-ctx")`（`{study, series, c?, t?, ts}`、`graphy-mpr-ctx` に倣う）。
- `App.tsx`: `#viewer3d → <Viewer3DScreen/>`（`status.mode==="standalone"` ゲート）。
- 専用 RenderingEngine `graphy-viewer3d-engine` / ツールグループ `graphy-viewer3d-tg` / viewport `viewer3d-main`（MPR/2D/Slicer と WebGL コンテキスト・ID 分離）。

### 5.2 新規ファイル

| ファイル | 役割 |
|---|---|
| `frontend/src/viewer/volumeRender.ts` | **表示コア**: `VolumeViewport3D` 構築・VR/MIP/Ortho モード切替（blendMode）・TF 適用・クリップ・カメラ・自前アクター addActor 配線 |
| `frontend/src/viewer/transferFunction.ts` | color TF（`vtkColorTransferFunction`）＋opacity TF（`vtkPiecewiseFunction`）の構築・LUT 適用・HU ヒストグラム算出。RGB/オパシティ分離保持 |
| `frontend/src/viewer/mesh3d.ts` | メッシュモデル（`vtkPolyData`）・色/透明度/可視・STL/OBJ I/O・計測（体積/面積/主径）・修復（`vtkCleanPolyData`） |
| `frontend/src/viewer/roiMesh.ts` | **確定変換**: labelmap(`vtkImageData` 実空間)↔メッシュ（`vtkImageMarchingCubes`+smooth / `vtkPolyDataToImageStencil`）。真の LPS 頂点 |
| `frontend/src/viewer/labelVolume.ts` | 既存 per-slice labelmap（`segExport.ts` の反復テンプレ）→**密な実空間 `vtkImageData`** 組み立て＋voxel→world 変換 |
| `frontend/src/viewer/cinematic.ts` | Cinematic v1（shade+勾配不透明度+AO）／v2 パストレースパスのフック |
| `frontend/src/viewer/endoscopy.ts` | fly-through カメラ（`centerline.ts` フレーム＋RMF up）・経路編集・ピッキング・向きインジケータ |
| `frontend/src/viewer/skeletonize.ts` | 3D 骨格化（itk-wasm/WASM）→ボクセル骨格 |
| `frontend/src/viewer/centerlineGraph.ts` | 骨格→グラフ抽出（26 近傍歩行）・Douglas-Peucker・prune・Dijkstra 最短路（LPS mm） |
| `frontend/src/viewer3d/Viewer3DScreen.tsx` | 画面: 3D viewport＋右コントロールパネル＋シーンオブジェクト表・ctx 受信 |
| `frontend/src/viewer3d/Viewer3DControlPanel.tsx` | モード（VR/MIP/Ortho/Cinematic）・LUT・ライティング・材質・クリップ・Ortho スライダ・ROI/メッシュ管理 |
| `frontend/src/viewer3d/OpacityCurveDialog.tsx` | 3D LUT カーブ（不透明度）ダイアログ（ヒストグラム＋ドラッグ点、HU 軸） |
| `frontend/src/viewer3d/CenterlineDialog.tsx` | 中心線解析（抽出・prune・ブランチ選択・CPR/ストレート化・内視鏡経路化） |
| backend（任意・後続） | 骨格化を重い場合に backend 化する余地（初期はフロント完結） |

### 5.3 volume 構築の共有（MPR/Slicer 再利用）

- `viewer/mpr.ts` の `buildMprVolume(imageIds, modality, volumeId)` を共通利用。CT チルト時は `gantryTiltCorrect.ts` で
  **直交軸位 volume**（`direction=[1,0,0,0,1,0,0,0,1]`）を `createLocalVolume`、他は `createAndCacheVolume`（IPP 空間ソート＋`volume.load()`）。
- 確定計算は **`resliceVolumeFromCache(volumeId)` → `ResliceVolume`**（`slicer.ts`）で cache volume を実空間 typed-array に持ち上げ、
  `makeWorldSampler`（`reslice.ts`）でトリリニアサンプリング。骨格化・CPR・voxelize はこの `ResliceVolume` 幾何で完結。
- **VTK.js は `setDirection()` で斜位を直接扱えるため、旧 `AxialConverter` の軸位化と X ミラーは不要**（要件 11）。
  ただし CT チルト補正だけは `buildMprVolume` の既存経路（`gantryTiltCorrect`）を通す（cornerstone がチルト volume を正しく描けないため）。

### 5.4 GPU シーンの構成（VolumeViewport3D ＋ 自前アクター共存）

- `RenderingEngine.enableElement({viewportId, type: VOLUME_3D, element})` → `setVolumes([{volumeId}])`。
- モード = `viewport.setBlendMode(BlendModes.COMPOSITE|MAXIMUM_INTENSITY_BLEND|MINIMUM_INTENSITY_BLEND)`。
- VR プリセット = `CONSTANTS.viewportPresets`（CT-Bone 等）を初期値に、以後 §7 の TF で上書き。
- **自前アクター重畳**: `VolumeViewport3D` 内部の vtk.js renderer を取得し、mesh（`vtkActor`）・ROI 表面・中心線 polyline・
  内視鏡経路を `renderer.addActor()`。同一 vtk.js シーンに共存させることで、深度・カメラを cornerstone と共有。
- `cornerstoneSetup.ts` に 3D ツール（`TrackballRotateTool`・必要に応じ `VolumeCroppingTool`）を追加登録。

---

## 6. レンダリングモード

### 6.1 VR（DVR / ボリュームレンダリング）

- `COMPOSITE_BLEND`。`vtkVolumeProperty` に color TF（`vtkColorTransferFunction`）＋scalar opacity（`vtkPiecewiseFunction`）を設定。
- 勾配不透明度（`setGradientOpacity`）で面強調（旧 `surfaceGradientThreshold` に相当）。
- W/L は TF レンジを HU で駆動（§3.3）。旧 256 固定ステップ → `mapper.setSampleDistance()`。

### 6.2 MIP / MinIP

- `MAXIMUM_INTENSITY_BLEND` / `MINIMUM_INTENSITY_BLEND`。color TF を通すことで LUT 着色 MIP（旧 `maxValColor` 相当）を実現。
- スラブ厚 `setSlabThickness()` で薄板 MIP も可能。

### 6.3 Ortho（3 直交スライス）

- 旧 `slice.frag` は unit-cube 内に X/Y/Z テクスチャ矩形を配置し、スライダで位置を動かす方式。
- 移植: 3× `vtkImageSlice`（`vtkImageResliceMapper`）を **患者 LPS の直交面**（Axial=Z, Coronal=Y, Sagittal=X）として 3D シーンに配置。
  スライス位置は world mm で駆動（`orthoMpr.ts` の FRAMES/`voxelToWorld` を流用）。cornerstone のカメラ変換に依存しない。
- ROI の"埋め込み表示"（スライス壁までボリュームを見せる旧 `uIsEmbedded`）はクリップ面併用で近似（後続）。

### 6.4 Cinematic Rendering（段階導入）

旧 `cinematic.frag` は unit-cube 上の **Monte-Carlo ボリューム・パストレーサ**（プログレッシブ蓄積・Cook-Torrance GGX 面 BRDF＋
Henyey-Greenstein 位相関数のボリューム散乱・ソフトシャドウ・Reinhard トーンマップ）。vtk.js/cornerstone に等価は無い。

- **v1（早期・実用優先）— "lit VR"**: `vtkVolumeProperty.setShade(true)`＋`setAmbient/Diffuse/Specular`（Phong）＋勾配不透明度＋
  アンビエントオクルージョン近似（vtk.js LAO/SSAO）。マルチバウンス散乱は無いが、臨床的に有用な陰影を即提供。
  ライト方位/仰角/強度・アンビエント・露出は旧 `CinematicParams` の既定（azimuth 45°/elevation 60°/intensity 1.5/ambient 0.25/exposure 1.5）を UI に踏襲。
- **v2（忠実）— 専用パストレースパス**: 旧 `cinematic.frag`（GLSL 330）を **GLSL ES 3.0 / WebGPU（WGSL）** へ移植し、
  `RGBA32F` FBO へ加算蓄積 → `present.frag`（÷frameCount×exposure→Reinhard→gamma）を別パスで実行。
  蓄積リセットのフィンガープリント（MVP＋W/L＋LUT 世代＋ライト＋クリップ）も移植。`MAX_BOUNCES=4`/`PRIMARY_STEPS=128`/`SHADOW_STEPS=48`。
  cornerstone の viewport とは別に**オフスクリーン vtk.js/WebGL2 レンダーウィンドウ**を用意し、同じ volume テクスチャ・TF・カメラを共有。
- CUDA バックエンド（旧 `CinematicRendererCuda`）はブラウザでは不可 → **WebGL2/WebGPU のみ**。GPU 検出は `CinematicGpuDetector` 相当を WebGPU 可否で代替。

### 6.5 クリップボックス・向きギズモ

- クリップ = `vtkVolumeMapper` の cropping（`setCroppingRegionPlanes`+`setCropping(true)`）＋box widget（`vtkImageCroppingRegionsWidget`）。
  旧はレイマーチの slab test がクリップ本体で、`ClipBoxRenderer` は視覚ウィジェットのみ → vtk.js では cropping が本体。
- 向きギズモ = `vtkOrientationMarkerWidget`+`vtkAxesActor`（旧 `AxesGizmo` を標準機能で代替）。

---

## 7. LUT / 転送関数 / 3D LUT カーブダイアログ

- **色 LUT**: 既存 `LutDialog.tsx`＋backend LUT（`fetchLutNames/fetchLutData` → `{r[256],g[256],b[256]}`）を
  `vtkColorTransferFunction` に流し込む。グレースケール＋名前付き LUT。**RGB とオパシティを分離保持**（旧 `rebuildAndUploadLut` 思想：
  色を変えてもオパシティカーブは保持、逆も同様）。
- **不透明度カーブ（3D LUT カーブダイアログ）**: `OpacityCurveDialog.tsx`。
  - **ヒストグラム**を HU 軸で描画（空気ビンでの潰れ回避に peak-clip）。`readModalitySlice`/`ResliceVolume` から算出。
  - ドラッグ可能な制御点（value, opacity）→ `vtkPiecewiseFunction.addPoint(HU, opacity)`。ダブルクリック追加・右クリック削除・端点固定。
  - 変更即時反映（`volumeProperty.setScalarOpacity`）。既定は線形 `[(min,0),(max,1)]`。
  - vtk.js の `vtkPiecewiseGaussianWidget`/`vtkPiecewiseControlWidget` を土台候補（ヒストグラム＋カーブ編集が標準装備）。
- W/L は HU 単位で TF レンジを駆動（§3.3）。PET は `suvStore` と合成し SUV 単位表示。

---

## 8. メッシュ & 3D ROI 管理

### 8.1 3D ROI（実空間 labelmap モデル）

- **モデル**: 旧 `FreeFormRoi3D` の patient-space labelmap を踏襲。移植では **密な `vtkImageData`**（`origin=IPP`・
  `direction=IOP 由来 3×3`・`spacing=[spX,spY,spZ]`）を確定計算層の正とする。表示は cornerstone Segmentation または `vtkActor`。
- **既存資産の再利用**:
  - 既存 labelmap は per-slice 2D スタック（`segExport.ts:118-135` の反復で全スライスを走査可能）。
    → `labelVolume.ts` で**密な実空間 `vtkImageData`** に組み立て＋voxel→world 変換を付与（メッシュ化の入力）。
  - `roiMaskStore.ts`（ラベル・ZCT scope・segments・アクティブ編集対象）・`sphere3dStore.ts`（解析的球）・`roi3d.ts`（統計）を UI/管理に流用。
  - ブール（OR/AND/XOR）・連結成分分割は既存 `roiBooleanOps.ts`（6/18/26 近傍 CCL）をそのまま利用。
- **色/透明度/可視・計測**: シーンオブジェクトごとに色・不透明度・可視。体積は voxel 数×`spX·spY·spZ`（球は解析的 `4/3πr³`）。
  統計（mean/sd/min/max）は `roi3d.ts` の `maskVolumeStats`（HU/SUV は `getModalityCalibration` 経由）。
- **編集**: ブラシ add/erase（旧 `editWithBrush` の or/andNot 相当）、剛体移動（origin のみ更新）、ブール、分割。undo/redo はコマンドスタック。

### 8.2 ROI → メッシュ（marching cubes）

- 入力: `labelVolume.ts` の実空間 `vtkImageData` labelmap（0/1 または 0/255）。
- `vtkImageMarchingCubes`（または高速な `vtkFlyingEdges3D`）を **isovalue 0.5（0/1）/ 127.5（0/255）** で実行。
  `vtkImageData` の direction が効くため**頂点は真の LPS mm**（旧の "voxel×spacing で IOP/IPP 破棄" は不採用）。
- 平滑化 = `vtkWindowedSincPolyDataFilter`（旧 Laplacian iterations=3/alpha=0.5 より収縮が少ない）。法線 = `vtkPolyDataNormals`。
- 任意でデシメーション（新機能）= `vtkQuadricDecimation`/`vtkDecimatePro`（旧は無し）。

### 8.3 メッシュ → 3D ROI（voxelize）

- `vtkPolyDataToImageStencil` → `vtkImageStencil` で、対象 `vtkImageData` 幾何（既存参照シリーズの origin/direction/spacing）に
  ラスタライズ。旧スキャンライン parity fill を標準フィルタで置換。出力値を labelmap 規約（1）に正規化。
- 結果は `labelVolume.ts` 経由で per-slice labelmap／`roiMaskStore` に反映し、2D ビューアや SEG エクスポートと整合。

### 8.4 STL / OBJ I/O

- 出力: `vtkSTLWriter`（binary/ascii。旧は binary のみ）。**頂点は患者 LPS mm**（旧はローカル mm。実空間統一のため患者座標に変更）。
- 入力: `vtkSTLReader`（binary/ascii 自動判定）・`vtkOBJReader`。読込後 `vtkCleanPolyData`（重複/退化除去）＋`vtkPolyDataNormals`。
  旧 `MeshValidator`/`MeshRepairer` 相当は `vtkCleanPolyData`＋`vtkFeatureEdges`（非多様体/穴診断）で代替。
- STL は座標系メタを持たないため、**インポート時に「患者座標 mm として扱う」旨を UI 明示**（旧のローカル mm 出力 STL との相互運用に注意）。

### 8.5 メッシュ計測

- 体積（mm³）・表面積（mm²）= `vtkMassProperties`（旧 divergence-theorem 体積・Σ½|cross| 面積と等価、回転/平行移動不変）。
- 主径（long/mid/short diameter）= 頂点共分散の PCA（Jacobi）＋各固有ベクトル方向の投影範囲（旧 `MeshAnalyzer` を直移植）、または `vtkOBBTree`。
- ピッキング/計測線 = `vtkCellPicker`（旧 Möller-Trumbore＋unproject の代替）。計測点は world mm で保持、距離は真の mm。

### 8.6 色/透明度・シーンオブジェクト管理

- 各メッシュ/ROI = `vtkActor`＋`vtkMapper`。色 `property.setColor`、不透明度 `setOpacity`、可視 `actor.setVisibility`、
  per-vertex 色は mapper scalars。背面カリング/ブレンドは property。
- **シーンオブジェクト表**（旧 `SceneObjectTableModel`）: React テーブルで ROI/メッシュ一覧・色・透明度・可視・統計・CSV エクスポート。

---

## 9. 内視鏡モード（fly-through）

- **経路**: 手動制御点（Catmull-Rom）または中心線由来（§10）。既存 `viewer/centerline.ts`（Catmull-Rom α=0.5・弧長テーブル・
  RMF/FIXED_Z フレーム）をそのまま経路プリミティブに使用。中心線由来は 1mm 等間隔リサンプル＋**線形補間**（旧 `setEndoPathFromCenterline` の
  異方性 cube 空間ドリフト対策を patient mm では単純な線形で継承）。
- **カメラ**: `vtkCamera` を毎フレーム手動駆動（`setPosition/setFocalPoint/setViewUp`、interactor 無効）。
  位置=経路上の弧長 `u`、前方=接線。**up ベクトルは `centerline.ts` の RMF 法線を流用**し、旧 `EndoCamera` の
  「接線が +Y に近いと up が反転する」既知バグを**設計段階で回避**（旧はコメントで RMF 未実装と明記）。
  マウスルック（yaw/pitch、pitch ±85° クランプ）は quaternion で追加。FOV は旧 45° より広角（90–120°）を既定に検討。
- **ピッキング**: unproject→ray→plane 交差（旧 `EndoPathPicker`）を gl-matrix で直移植、または `vtkCellPicker`。
- **オーバーレイ**: 経路 polyline（cyan）＋制御点 glyph＋カメラマーカー（`vtkPolyLine`/`vtkGlyph3D`）。
  向きインジケータ（world-up の画面投影矢印）は HTML/SVG オーバーレイ（旧 `EndoOrientationIndicator` を 2D で）。
- undo/redo（挿入/移動/削除/カメラ u）はコマンドスタック。ドラッグは gesture 終了時に 1 コマンド。

---

## 10. 中心線解析

**パイプライン**（旧 `CenterlineAnalysisDialog.runExtraction` を踏襲）:

```
FreeFormRoi3D マスク（実空間 vtkImageData labelmap）
  → 占有 bbox でクロップ（高速化）
  → skeletonize.ts : 3D 細線化（itk-wasm thinning / Lee-94 WASM）→ 1-voxel 骨格
  → centerlineGraph.ts : 骨格→グラフ抽出（26 近傍歩行, endpoint deg=1 / bifurcation deg≥3）→ LPS mm
     → Douglas-Peucker 簡略化（simplifyEpsilonMm 既定 0.5）
     → pruneShortLeafBranches（minLengthMm 既定 5.0, 非破壊）
     → extractBranch(id) / extractPath(a,b)（Dijkstra 最短路, ブランチ長重み）
        → Centerline3D（既存 centerline.ts）
           → CPR 2D（curvedReformat.ts）| ストレート化 3D（新規）| 内視鏡経路（§9）
```

- **骨格化のみ vtk.js/cornerstone に等価が無い唯一の重量級**。`itk-wasm` の binary thinning、もしくは旧が使う
  Fiji `Skeletonize3D_`（Lee-Kashyap-Chu 1994 3D parallel thinning）を WASM/JS 移植。他（グラフ抽出・DP・prune・Dijkstra）は素の TS で直移植。
- **グラフ/フレーム**: `centerlineGraph.ts`（グラフ・ノード分類・最短路・prune）＋既存 `centerline.ts`（Catmull-Rom＋弧長＋
  FIXED_Z/RMF フレーム。RMF=Wang 2008 double-reflection は移植済）。
- **CPR/ストレート化**: 既存 `curvedReformat.ts`（X=弧長, Y=法線方向オフセット, MIP/MINIP/AVG バンド投影）を CPR に流用。
  ストレート化 3D（frame.normal×binormal の円板を弧長方向に積む）は新規（旧 `StraightenedVolumeBuilder`。
  **出力座標系は合成的で LPS へ剛体写像できない**旨を UI/メタに明示＝旧の注意を継承）。
- **注記**: 旧 `CenterlineNode.radiusMm`/`CenterlineBranch.radiusMmPerControlPoint` は**スタブで未実装**（径-弧長プロットは無い）。
  `CenterlineGraphRenderer` は 2D プロットではなく **3D グラフオーバーレイ**（ブランチ polyline＋ノード glyph）。移植も 3D オーバーレイとし、
  径/断面積の計測（距離変換推定）は**新機能候補**として後続に置く。
- **表示**: グラフを LPS mm のまま vtk.js polyline/glyph アクターで重畳（旧 cube 変換は不要）。ブランチ選択・最短路ハイライト。

---

## 11. 座標系・チルト整合（詳細）

- **全て患者 LPS mm**（cornerstone volume の world と一致）で計算。導出元はチルト補正済み volume の origin/direction/spacing。
- **VTK.js は右手系＋`vtkImageData.setDirection()`** を持つため、旧実装の **X ミラー**（左手系 LPS→右手系 cube）と
  **AxialConverter の軸位リサンプル**は**不要**。斜位/回転収集は direction 行列で直接描画（要件 11）。
- **CT ガントリチルト**のみ既存 `gantryTiltCorrect.ts`（inverse-map bilinear で Y-Z を de-shear、`direction=I` の直交 volume 生成）を通す。
  検出は IOP 由来法線と実 IPP 差ベクトルの `acos(|N·V|)`（>0.5° で補正）＝実幾何ベース（タグ値のみに依存しない）。
- 確定サンプラは **world→index を volume の direction/spacing/origin で解決**（`makeWorldSampler`）。IOP 由来法線ではなく実ジオメトリ。
- 非 CT/斜位は `createAndCacheVolume` の `getImageData()`＋`voxelManager` 経路で吸収（slicer と同一・[[slicer-feature-status]]）。

---

## 12. 実装フェーズ

- **P0 設計（本書）** — ✔ 完了。
- **P1 表示コア** — ✔ 実装（要実機検証）。`VolumeViewport3D`（`VOLUME_3D`）で VR/MIP/MinIP。
  - `frontend/src/viewer/transferFunction.ts`: `RenderMode`（VR/MIP/MINIP/AVG）→`blendModeFor`（COMPOSITE/MAX/MIN/AVG）、
    VR プリセットカタログ（Cornerstone `VIEWPORT_PRESETS` 名の CT/MR サブセット）、`presetsForModality`/`defaultPreset`。
  - `frontend/src/viewer/volumeRender.ts`: `setup3DViewport`（VOLUME_3D 有効化＋`setVolumes`＋プリセット＋`setBlendMode`＋
    ツールグループ: Trackball(primary)/Pan(middle)/Zoom(secondary)）・`setRenderMode`・`applyPreset`・`applyVrWl`（voiRange=HU）・
    `reset3DCamera`・`resetVrProperties`・`teardown3D`。volume は MPR 共通 `buildMprVolume`（CT チルト補正済み）。
  - `frontend/src/viewer3d/Viewer3DScreen.tsx`: 単一 3D ビューポート＋右コントロールパネル（モード VR/MIP/MinIP・
    レンダリングプリセット・W/L プリセット・視点リセット）。ctx=`graphy-viewer3d-ctx`、engine=`graphy-viewer3d-engine`。
    VR 色プリセットは `preset` state に保持し MIP 切替で失わない。
  - 配線: `App.tsx`（`#viewer3d`）、`MainScreen.tsx`（`handleOpenViewer("3d")`）、`cornerstoneSetup.ts`（`TrackballRotateTool` 登録）、
    `i18n(ja/en)`（`viewer3d.*`）。
  - ビルド: `npx tsc -b` green ／ `npx vite build` green（2026-07-02）。**実機（standalone・GPU/DICOM）での VR/MIP 目視は未実施**。
  - P1 既知の制約: 単一シリーズ／standalone のみ／PET は CT プリセット流用（HU 前提のため近似）。色/不透明度の任意カーブ編集は P2。
- **P2 Ortho ＋ LUT ＋ 3D LUT カーブ**: 3 直交スライス（実空間）、`LutDialog` 連携、`OpacityCurveDialog`（ヒストグラム＋カーブ）。クリップボックス・向きギズモ。
- **P3 メッシュ & 3D ROI**: `labelVolume.ts`（密実空間 labelmap）、`roiMesh.ts`（MC/voxelize）、`mesh3d.ts`（STL I/O・計測・色/透明度）、
  シーンオブジェクト表。ROI↔メッシュ往復・STL 往復を数値検証（体積・座標一致）。既存 `roiBooleanOps`/`roi3d`/`roiMaskStore` 連携。
- **P4 Cinematic v1（lit VR）**: shade＋勾配不透明度＋AO、ライト/材質 UI。
- **P5 内視鏡**: `endoscopy.ts`（RMF up カメラ・経路編集・ピッキング・オーバーレイ）。
- **P6 中心線解析**: `skeletonize.ts`（itk-wasm）＋`centerlineGraph.ts`（抽出/DP/prune/Dijkstra）＋`CenterlineDialog.tsx`。CPR/ストレート化。
- **P7 Cinematic v2（パストレース）**: `cinematic.frag` → WebGL2/WebGPU 移植・プログレッシブ蓄積。
- **P8 拡張**: カット彫刻（lasso）、径-弧長計測、web(wadors) 経路、backend 骨格化オフロード、メッシュ↔SEG/RTSTRUCT 連携。

## 13. リスク・要検証

- **メモリ/性能**: 大 volume の VR＋密 labelmap＋メッシュ同時保持。生成前概算＋上限ガード（slicer 同様）。marching cubes/骨格化は Web Worker 化検討。
- **cornerstone `VolumeViewport3D` への自前アクター addActor**: 内部 renderer API の安定性・cornerstone 3.33.x での互換要検証。破綻時は
  **純 vtk.js の `vtkGenericRenderWindow` へ全面移行**（slicer が cornerstone 3 面から自前 world 描画へ回帰した前例あり・[[slicer-feature-status]]）をフォールバックに。
- **座標系**: `vtkImageData.setDirection()` の斜位描画・実 IPP 差ベースの幾何が cornerstone/vtk 3.33 で正しいか、実データ（斜位 MR・チルト CT）で目視。
- **Cinematic v2** は WebGL2/WebGPU 移植の難度が高い（GLSL 330→ES 3.0/WGSL、RGBA32F 蓄積、精度）。v1 で臨床要件を満たせるか先に評価。
- **骨格化**: itk-wasm 依存の追加・バンドルサイズ・実行時間。分岐血管での過剰分割/spur を prune で吸収できるか。
- **STL 座標系**: 患者 LPS mm 出力への変更が旧 GRAPHY（ローカル mm）STL との相互運用に与える影響。UI 明示＋インポート基準の一貫。
- **単一入口輝度校正**: TF/ヒストグラム/統計が全て `pixelCalibration` 経由で HU/SUV 一貫（Rescale 二重適用禁止）。
- **web モード**: 初期 standalone のみ。WebGPU 可否でモード分岐。

## 14. 決定事項（確定）

- **土台 = cornerstone `VolumeViewport3D`（VR/MIP/MinIP・カメラ・プリセット・ツール）＋その vtk.js renderer に自前アクター重畳**。破綻時は純 vtk.js へ移行可能な設計。
- **確定計算（メッシュ生成・voxelize・骨格化・CPR・計測）は自前 real-space（TS＋vtk.js フィルタ）**。表示≠確定計算の二層（slicer 踏襲）。
- **全計算は患者 LPS mm**。`vtkImageData.setDirection()` で斜位/チルトを実幾何で扱い、旧の X ミラー/軸位化は排除。CT チルトのみ `gantryTiltCorrect` 経由（要件 11）。
- **VR/MIP/Ortho は cornerstone/vtk.js 標準**、**Cinematic は段階導入**（v1 lit-VR / v2 移植パストレース）。
- **ROI↔メッシュは `vtkImageMarchingCubes`/`vtkPolyDataToImageStencil`（実空間 labelmap→真 LPS 頂点）**、STL は `vtkSTL Reader/Writer`。
- **LUT=既存 `LutDialog`→`vtkColorTransferFunction`**、**3D LUT カーブ=`vtkPiecewiseFunction`＋HU ヒストグラム UI**。RGB/オパシティ分離保持。
- **中心線 spline/フレームは既存 `centerline.ts` 再利用**、**骨格化のみ itk-wasm/WASM**、内視鏡カメラ up は **RMF 法線流用で旧バグを回避**。
- **W/L は HU/SUV 単位**で TF 駆動（`pixelCalibration` 単一入口）。
- **volume 構築は MPR/Slicer と共通の `buildMprVolume`**（`#viewer3d` ルート・`graphy-viewer3d-*` ID・`graphy-viewer3d-ctx`）。初期 standalone のみ。
