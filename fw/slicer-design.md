# Slicer 設計（GRAPHY-Next）

> 作成: 2026-07-01。旧 GRAPHY `com.vis.core.slicer` パッケージ（6,194 行）を GRAPHY-Next（Cornerstone3D 3.33.5 / React+TS / Spring Boot+dcm4che backend）へ移植。
> 関連: `fw/mpr-viewer-design.md`（volume 構築・ガントリチルト補正を共有）/ `fw/dicom-data-layer.md` / `fw/series-sync-design.md` /
> 旧実装 `GRAPHY/src/main/java/com/vis/core/slicer/`（`Slicer.java`/`SlicerWindow.java`/`Slab.java`/`VolumeSampler.java` 他）、
> `GRAPHY/src/main/java/com/vis/core/view/D2/ui/orientation/`（`SlicePlane`/`GeometryOfSlice`/`PlanarSupport`）、旧 `GRAPHY/docs/slicer.md`。

## 1. 目的・要件

DICOM ボリュームを **任意断面角度（オブリーク）** でスライスし、Slab（スライス厚・Gap・枚数・再構成モード）を
適用して再構成した結果を、**セカンダリ（派生）シリーズ**として元シリーズ属性を引き継ぎつつ UID / Image 属性を
更新し、**DB へ保存**する Slicer 機能を GRAPHY-Next に実装する。

ユーザー指定要件（2026-07-01）:
1. GRAPHY の slicer パッケージを移植する。
2. **カットプレーン（切断面）表示**：ベース断面上に切断線を描画・操作、オブリークプレビュー。
3. **スライス厚・Gap・再構成アルゴリズム指定**（SLICECUT/MEAN/MAX(MIP)/MIN(MinIP)/MEDIAN/MODE）。
4. **再構成スタックはセカンダリ扱い**：ソースシリーズの属性を引き継ぎ、Image 属性・UID を更新し、DB 保存可能に。

### 確定した設計判断（2026-07-01・ユーザー確認済み）

| 判断点 | 決定 | 根拠 |
|---|---|---|
| リスライス計算場所 | **フロント（TS）** | volume は既にブラウザ上（MPR で構築）。GRAPHY `VolumeSampler`/`SlicePlane` を TS 移植。ガントリチルト補正済み volume・幾何ユーティリティを再利用。backend 再構築の重複を回避 |
| 出力 Modality | **元 Modality 維持 + DERIVED** | CT/MR を維持し `ImageType=DERIVED\SECONDARY\RESLICE`・Rescale・16bit signed を継承。HU プローブ / W-L / 下流ツールが機能。`SourceImageSequence` で元シリーズにリンク。「セカンダリ扱い」は ImageType＋シリーズ分離で表現 |
| UI 形態 | **独立 Slicer ウィンドウ**（`#slicer`） | GRAPHY 同様。MprScreen の volume 構築を再利用しつつ責務分離 |
| 初期スコープ | **平面オブリークのみ** | 任意角度平面リスライス＋Slab＋スタック生成＋保存まで。Curved/CPR・Straightened は後続フェーズ |

## 2. 旧 GRAPHY Slicer の中核（移植対象の抽出）

旧 slicer の処理は「幾何定義 → ボクセルサンプリング → Slab 集約 → スタック化 → DICOM 保存」。

### 2.1 幾何モデル（移植の心臓部）

- `GeometryOfSlice`（`orientation/GeometryOfSlice.java`）: `row`/`column`（IOP の行・列方向余弦）、`tlhc`（左上隅 = IPP）、
  `voxelSpacing=[行幅, 列幅, スライス厚]`、`sliceThickness`、`dimensions=[行数, 列数, スライス数]`。`normal = row × column`。
- `SlicePlane.computeVoxelCoordinatesInPixelCoords()`（`orientation/SlicePlane.java:159-200`）: 出力ピクセル (x,y) →
  患者座標 (RCS) → 参照ボリュームのボクセル座標 (u,v,w) へ変換。

  ```
  P(x,y) = ipp + row*(x*spacingX) + column*(y*spacingY)          # 出力ピクセル→患者座標(LPS)
  u = dot(P - refIpp, Rr) / pixelSpacingX                        # 患者座標→参照ボクセルindex
  v = dot(P - refIpp, Rc) / pixelSpacingY
  w = dot(P - refIpp, Rs) / sliceThickness                       # Rs は実スタック方向(下記)
  ```

- **実スタック方向 Rs**（`SlicePlane.java:109-140`）: `nSlices>1` の時、`Rs = normalize(ippLast - ippFirst)`。
  IOP 由来の法線ではなく **実 IPP 差**を使う（非等間隔・チルト残差を吸収）。

### 2.2 サンプリング（補間）

- `VolumeSampler.sampleTrilinear()`（`slicer/VolumeSampler.java:127-162`）: 8 近傍 LERP。**既定はトリリニア**。
- `Slicer.slice()`（`slicer/Slicer.java:243-355`）: 最近傍（SLICECUT の高速版）。境界外/NaN は `raw_min`（空気 HU）で埋める。
- **移植方針**: TS では **トリリニア**を既定、SLICECUT は単一平面のトリリニア（サブスライス分割なし）。

### 2.3 Slab（厚み・Gap・枚数）

- `Slab.java:56-114`: `slabDepth = thickness*n + gap*(n-1)`。
- サブスライス分割（`Slicer.java:357-381`）: `numOfSubSlice = round(sliceThickness / refZ)`。`≤2` は SLICECUT、
  それ以上はスラブ厚内を `PlanarSupport.divideSlice()` で等分し各サブ平面をサンプリング。

### 2.4 再構成モード（Slab 集約）

`Slicer.applyCalculateMode()`（`slicer/Slicer.java:466-510`）: サブスライス列 `v[z]` を per-pixel 集約。

| モード | 定数 | 集約 | cornerstone blendMode 相当 |
|---|---|---|---|
| SLICECUT | 0 | 単一平面（集約なし） | COMPOSITE（通常） |
| MEAN | 1 | 平均 | AVERAGE |
| MAX | 2 | 最大（MIP） | MAXIMUM_INTENSITY_BLEND |
| MIN | 3 | 最小（MinIP） | MINIMUM_INTENSITY_BLEND |
| MEDIAN | 4 | 中央値 | （無し・TS のみ） |
| MODE | 5 | 最頻値 | （無し・TS のみ） |

### 2.5 出力 DICOM 属性の再計算（旧 `OrthogonalSlice.java:154-177` / `SlicerMenuBar.java`）

- 新 IOP = 切断平面の [row, column]。新法線 = `column × row`。
- 各スライス IPP = `PlanarSupport.getNewImagePositionPatient2D()`（平面原点＋法線×(厚み+Gap)×index）。
- `pixelWidth/Height/Depth` を再構成幾何から再設定。
- 保存: patID/studyUID 維持、SeriesInstanceUID/SOPInstanceUID 新規、DicomWriter で書き出し。

### 2.6 カットプレーン線（`ReferenceLineMPR`/`CenterPositionLine`）

- ベース断面上に切断線（中心線）を描画、**移動ドラッグ＝位置**、**端ハンドルドラッグ＝回転**。
- 平面色分け（AX=赤/COR=緑/SAG=青）。他断面へローカライザー表示。

## 3. cornerstone3D との差分と役割分担

**結論: 「インタラクティブ表示＝cornerstone」「確定スタック生成＝自前 TS サンプラー」の二層構成。**

| 機能 | cornerstone 標準 | 採否 | Slicer での役割 |
|---|---|---|---|
| オブリーク表示 | `VolumeViewport` + `camera.viewPlaneNormal` 自由設定 | **採用** | 切断面のライブプレビュー（1 面） |
| Slab プレビュー | `viewport.setSlabThickness()` + `setBlendMode()`（MIP/MinIP/AVERAGE） | **採用** | 厚み・投影のライブプレビュー（WYSIWYG） |
| クロスヘア回転 | `CrosshairsTool`（回転ハンドル内蔵） | **採用** | 切断面の角度操作 UI |
| 参照線 | 自前 `referenceLines.ts`（交差線描画） | **拡張** | ベース断面上の切断線表示（操作は Crosshairs へ委譲） |
| **スタック再構成** | 無（表示専用） | **自前 TS** | 確定時に N 断面をトリリニアサンプリングして pixel frames 生成 |
| MEDIAN/MODE | 無 | **自前 TS** | blendMode に無いモード（プレビューは AVERAGE で近似） |
| DICOM 書き出し | スコープ外 | **backend 新規** | `DerivedSeriesService` |

**なぜプレビューと生成を分けるか**: cornerstone の blendMode は GPU レンダリング（表示ピクセル）で、DICOM 保存用の
確定的な voxel 値（HU）と 1:1 一致しない。かつ MEDIAN/MODE は blendMode に無い。よって**確定生成は
volume の scalar data を直接トリリニアサンプリング**（GRAPHY 方式）し、プレビューだけ cornerstone に任せる。

## 4. アーキテクチャ

### 4.1 起動・ルーティング（MPR に倣う）

- MainScreen: シリーズ右クリック / 2D ビューアメニュー → 「Slicer を開く」。`handleOpenViewer("slicer")`。
- desktop=`openViewer("slicer")` / web=`window.open("#slicer","graphy-slicer")`。
- コンテキスト受け渡し: `localStorage("graphy-slicer-ctx")`（`graphy-mpr-ctx` に倣う）。
- `App.tsx`: `#slicer → <SlicerScreen/>`。
- 専用 RenderingEngine `graphy-slicer-engine`（MPR/2D と WebGL コンテキスト分離）。

### 4.2 新規ファイル

| ファイル | 役割 |
|---|---|
| `frontend/src/viewer/reslice.ts` | **コア**: 平面幾何（`SlicePlane` 相当）・トリリニアサンプラー（`VolumeSampler` 相当）・Slab 集約（`applyCalculateMode` 相当）・出力幾何/IPP・IOP 計算。純関数・cornerstone 非依存 |
| `frontend/src/viewer/slicer.ts` | ビューポート構築（base + oblique preview）・Crosshairs/切断線配線・プレビュー用 slabThickness/blendMode 設定・`buildResliceStack()`（reslice.ts を駆動して frames+geometry 生成）・保存 POST |
| `frontend/src/slicer/SlicerScreen.tsx` | 画面: base 断面ビュー＋オブリークプレビュー＋コントロールパネル・ctx 受信 |
| `frontend/src/slicer/SlicerControlPanel.tsx` | FOV(幅/高)・スライス厚・Gap・枚数・再構成モード・保存ボタン（旧 `SlicerControlPanel.java` 対応） |
| backend `.../dicom/derived/DerivedSeriesController.java` | `POST /api/series/derived`（新規） |
| backend `.../dicom/derived/DerivedSeriesService.java` | frames+geometry+属性 → DICOM 構築 → `DicomStorageService.ingest` |
| backend `.../dicom/derived/DerivedSeriesRequest.java` | リクエスト DTO |

### 4.3 volume の共有（MPR 再利用）

- `viewer/mpr.ts` の `buildMprVolume()`（CT チルト時 `createLocalVolume` / 他 `createAndCacheVolume`）を**共通化**して
  slicer からも呼ぶ（必要なら `viewer/volume.ts` へ抽出）。
- reslice サンプラーが必要とするのは「scalar data（typed array）＋ dimensions＋spacing＋origin＋direction」。
  - `createLocalVolume` 経路: これらは直接手元にある（`assembleCtSourceVolume` 出力）。
  - `createAndCacheVolume` 経路: `volume.getImageData()`（vtkImageData）＋ `voxelManager` から取得（`probeMpr` と同経路：
    `utilities.transformWorldToIndex` / `voxelManager.getAtIJK`）。**サンプラーは world 座標入力**にして両経路を吸収する。

## 5. リスライスコア（`reslice.ts`）設計

### 5.1 入力

```ts
interface VolumeRef {                    // world(LPS) で完結する参照ボリューム
  sample(worldX: number, worldY: number, worldZ: number): number; // トリリニア。範囲外は airValue
  airValue: number;                      // 空気 HU の格納値（rescale 逆算、padding 用）
}
interface ReslicePlane {
  origin: Vec3;        // 出力(0,0)ピクセルの患者座標(LPS) mm
  rowDir: Vec3;        // 行方向余弦（正規化）
  colDir: Vec3;        // 列方向余弦（正規化）。normal = colDir × rowDir でも row×col でも一貫させる
  cols: number; rows: number;            // 出力面内サイズ（FOV / pixelSpacing）
  pixelSpacing: [number, number];        // [colSpacing, rowSpacing] mm
}
interface SlabSpec {
  numSlices: number;   // 出力スタック枚数
  thickness: number;   // 1 スライス厚 mm
  gap: number;         // スライス間 Gap mm（中心間 = thickness + gap）
  mode: 'SLICECUT'|'MEAN'|'MAX'|'MIN'|'MEDIAN'|'MODE';
  subSampleSpacing?: number; // スラブ内サブサンプル間隔 mm（既定 = min(voxel spacing)）
}
```

### 5.2 出力スタック生成アルゴリズム

```
normal = normalize(cross(colDir, rowDir))
center-to-center = thickness + gap
for s in 0..numSlices-1:
  sliceCenterOffset = (s - (numSlices-1)/2) * (thickness + gap)   # 中央対称に配置
  if mode == SLICECUT:
    subOffsets = [sliceCenterOffset]
  else:
    k = max(1, round(thickness / subSampleSpacing))               # スラブ内サブスライス数
    subOffsets = [ sliceCenterOffset + (t - (k-1)/2)*(thickness/k) for t in 0..k-1 ]
  for each output pixel (x,y):
    values = []
    for d in subOffsets:
      P = origin + rowDir*(x*pxCol) + colDir*(y*pxRow) + normal*d  # 患者座標
      values.push( volume.sample(P) )                              # トリリニア
    out[s][y][x] = aggregate(values, mode)                        # MEAN/MAX/MIN/MEDIAN/MODE
```

- `aggregate`: MEAN=平均、MAX=最大、MIN=最小、MEDIAN=中央値、MODE=最頻値（旧 `Slicer.java:466-510` 移植）。
- **出力型**: CT=Int16（HU 格納値のまま）、他は volume の格納型を踏襲。W/L・Rescale はそのまま保存側で維持。

### 5.3 出力幾何（各スライスの DICOM 属性）

```
IOP  = [rowDir.x,rowDir.y,rowDir.z, colDir.x,colDir.y,colDir.z]   # 全スライス共通
IPP_s = origin + normal * ((s - (numSlices-1)/2) * (thickness + gap))   # スライス左上隅の患者座標
PixelSpacing         = [rowSpacing, colSpacing]   # DICOM は [row(=between rows), col] 順に注意
SliceThickness       = thickness
SpacingBetweenSlices = thickness + gap
Rows = rows, Columns = cols
```

> **注意（DICOM PixelSpacing 順）**: DICOM `(0028,0030)` は `[行間隔(=隣接行の距離), 列間隔]`。UI の「FOV 幅/高」→
> `pixelSpacing` へのマッピングを reslice.ts と DTO で一貫させる（実装時にユニットテストで固定）。

## 6. カットプレーン UI（`slicer.ts` / `SlicerScreen.tsx`）

- **レイアウト**: 左=ベース断面（AX 既定、Crosshairs＋切断線）、右=オブリークプレビュー（VolumeViewport、
  camera.normal=切断面法線、slabThickness＋blendMode で Slab プレビュー）。下=コントロールパネル。
- **切断線操作**: `CrosshairsTool` の回転ハンドルで角度、中心ドラッグで位置。切断面の row/col/normal を
  camera から算出しプレビュー viewport に反映。
- **プレビュー同期**: パネルの厚み/Gap/枚数/モード変更 → プレビュー viewport の `setSlabThickness` /
  `setBlendMode`（MEDIAN/MODE は AVERAGE 近似＋「プレビューは近似」注記）。
- **確定生成**: 「再構成」ボタン → `buildResliceStack()`（reslice.ts）で frames+geometry 生成 →
  「保存」で backend POST。生成前に枚数×行×列×2byte の概算メモリを表示（大容量ガード）。

## 7. セカンダリシリーズ保存（backend 新規）

### 7.1 エンドポイント

```
POST /api/series/derived
Content-Type: application/json（frames は base64）または multipart（frames を binary）
Request:
{
  sourceSeriesInstanceUid: string,       // 元シリーズ（属性テンプレート取得元）
  seriesDescription: string,             // 例: "Reslice (Oblique)"
  seriesNumber?: number,                 // 省略時は backend で採番
  rows: number, cols: number,
  bitsAllocated: 16, pixelRepresentation: 1,   // CT: signed
  frames: [
    { instanceNumber, imagePositionPatient:[x,y,z], pixels(base64 Int16LE) }, ...
  ],
  shared: {
    imageOrientationPatient:[6], pixelSpacing:[2],
    sliceThickness, spacingBetweenSlices
  }
}
Response: { seriesInstanceUid, sopInstanceUids: string[] }
```

### 7.2 DerivedSeriesService（既存基盤の再利用）

1. `sourceSeriesInstanceUid` の代表インスタンス Attributes を読み込み（テンプレート）。
2. **UID 採番**: `SeriesInstanceUID = UIDUtils.createUID()`、各フレーム `SOPInstanceUID = UIDUtils.createUID()`。
3. **属性引き継ぎ・更新**（`NonDicomConverter.common()` / `blankDicom` パターンを流用）:

| 属性 | 方針 |
|---|---|
| PatientID/Name/BirthDate/Sex | **維持** |
| StudyInstanceUID / StudyDate / StudyDescription / AccessionNumber | **維持** |
| **FrameOfReferenceUID** | **維持**（同一患者空間 → MPR/参照線と整合） |
| SeriesInstanceUID | **新規** |
| SOPInstanceUID | **フレーム毎に新規** |
| SOPClassUID | 元 Modality の Image Storage（CT Image Storage 等）を維持 |
| Modality | **元維持**（CT/MR） |
| SeriesNumber | 新規（UI 指定 or backend 採番） |
| SeriesDescription | UI 指定（例: "Reslice (Oblique)"） |
| ImageType | `DERIVED\SECONDARY\RESLICE` |
| Rescale Slope/Intercept, PhotometricInterpretation, BitsAllocated/Stored, PixelRepresentation, WindowCenter/Width | **維持** |
| ImageOrientationPatient / ImagePositionPatient | **再計算値で更新**（§5.3） |
| PixelSpacing / SliceThickness / SpacingBetweenSlices | **再計算値で更新** |
| InstanceNumber | 1..N 振り直し |
| **SourceImageSequence / ReferencedSeriesSequence** | 元シリーズ・元インスタンスへリンク（トレーサビリティ） |
| DerivationDescription | "Oblique reslice, mode=<...>, thickness=<...>, gap=<...>" |
| DerivationCodeSequence | (113072, DCM, "Multiplanar reformatting") 相当を付与 |

4. **PixelData**: frame の Int16LE を `(0028,0010/0011)=rows/cols`、`(7FE0,0010)` に格納。
5. **書き込み**: `DicomOutputStream`（fmi + dataset）で Part-10 生成 → 一時ファイル。
6. **ingest**: `DicomStorageService.ingest()` で `<storageDir>/<studyUid>/<newSeriesUid>/<sopUid>.dcm` 配置＋
   `DicomInstance` 索引登録（H2、トランザクション：失敗時ロールバック＋孤児ファイル削除）。
7. **応答**: 新 `seriesInstanceUid` を返し、フロントは MainScreen のシリーズ一覧を再取得（または 2D/MPR で開く）。

### 7.3 検証

- 必須タグ・UID 形式・`sourceSeriesInstanceUid` 存在・frames 数と instanceNumber 整合・pixels 長 = rows*cols*2。
- 失敗時は 4xx＋理由。`fw/error-handling-logging.md` 準拠。

## 8. 座標系・チルト整合

- 全て**患者座標系 LPS**で計算（cornerstone volume の world と一致）。
- CT は MPR と同じ **`gantryTiltCorrect.ts` で前処理済み volume**（直交 Axial）を入力にするため、reslice も直交前提で幾何が閉じる。
- `createAndCacheVolume` 経路（非 CT / チルト無し）は `getImageData()` の world 変換で吸収。
- サンプラーは **world → index を volume 側の direction/spacing/origin で解決**（IOP 由来法線ではなく実ジオメトリ）。

## 9. 実装フェーズ

- **P0 設計（本書）** — ✔ 完了。
- **P1 リスライスコア** — ✔ 完了（`frontend/src/viewer/reslice.ts`）。`makeWorldSampler`（トリリニア）／
  `buildReslicePlane`（中心・法線・up→平面）／`reslice`（Slab 集約＋出力幾何）。純関数・cornerstone 非依存。
  数値検証 `scratchpad/verify_reslice.mjs`（esbuild で TS→ESM 変換）: **21/21 パス**
  （軸平行 AX リスライスが元スライスと厳密一致・トリリニア中間補間・Slab MAX/MIN/MEAN・IPP/IOP・
  マルチスライス幾何・buildReslicePlane 正規直交/法線一致・45° オブリークで in-range）。
- **P2 UI/プレビュー** — ✔ 完了（要実機確認）。
  - `frontend/src/viewer/slicer.ts`: `setupSlicerViewports`（base=AXIAL＋recon=ORTHOGRAPHIC）／
    `setReslicePreview`（カットライン 2 端点を `canvasToWorld` で world 化→法線=lineDir×axialNormal、
    recon カメラへ `setCamera`＋Slab を `setSlabThickness`/`setBlendMode` でプレビュー）／
    `blendModeFor`（MAX→MAXIMUM, MIN→MINIMUM, MEAN/MEDIAN/MODE→AVERAGE）／`extractResliceVolume`
    （VolumeViewport→`ResliceVolume`, direction は [rowCos,colCos,normal] で reslice.ts と一致）／
    `volumeMinSpacing`／`teardownSlicer`。volume 構築は `buildMprVolume`（MPR と共通）。
  - `frontend/src/slicer/SlicerScreen.tsx`: 左=ベース断面＋カットライン SVG オーバーレイ（端点ドラッグ=回転、
    本体ドラッグ=移動）、右=斜め断面プレビュー、下=コントロールパネル（FOV 幅/高・スライス厚・Gap・枚数・
    再構成モード）。「再構成」ボタンは `extractResliceVolume`＋`buildReslicePlane`＋`reslice` で
    **クライアント側スタック生成**まで実施（枚数/行×列を表示）。「保存」は P3 まで disabled。
    MEDIAN/MODE 選択時は「プレビューは AVERAGE 近似」チップを表示。
  - 配線: `App.tsx`（#slicer ルート）、`MainScreen.tsx`（`handleOpenViewer("slicer")`→`graphy-slicer-ctx`＋
    openViewer/window.open）、`i18n(ja/en)`（`slicer.*`）。Toolbar/MenuBar の Slicer ボタンは既存。
  - ビルド: `cd frontend && npx tsc -b && npx vite build` **green**。
  - P2 既知の制約: standalone のみ（web は wadors 未対応, MPR と同じ）／単一シリーズ／カットラインは
    「ベース断面に垂直な斜め断面」（ライン方向とベース法線が張る平面）のみ＝完全自由 3D 回転は P4。
- **P3 保存**: backend `DerivedSeriesController`/`DerivedSeriesService`＋`POST /api/series/derived`。
  属性引き継ぎ・UID 採番・ingest。フロント「保存」ボタン実体化＋一覧再取得。実 CT で往復検証（保存→再読込→MPR で幾何一致）。
- **P4 拡張**: Curved MPR / CPR（`CurvedReformatter`）・Straightened（`StraightenedVolumeBuilder`）・Centerline 編集、
  完全自由 3D 回転（Crosshairs 連動）、複数シリーズ、web(wadors/STOW) 保存経路。

## 10. リスク・要検証

- **メモリ**: 出力スタック（例 512²×200×2byte ≈ 100MB）＋元 volume の同時保持。生成前概算＋上限ガード。
- **PixelSpacing 順序**（§5.3 注記）: UI FOV → pixelSpacing → DICOM `(0028,0030)` の順序不一致による幾何崩れ。ユニットテストで固定。
- **プレビュー≠生成**: MEDIAN/MODE は cornerstone に無く AVERAGE 近似表示（UI で明示）。MIP/MinIP/MEAN は blendMode で近い。
- **非等間隔・チルト残差**: 実 IPP 差ベースの Rs（§2.1）を volume ジオメトリで吸収するが、非 CT 斜め収集で要検証。
- **往復整合**: 保存したセカンダリを再読込し MPR/2D で元と幾何一致するか（FrameOfReferenceUID 維持で参照線整合）。
- **SOPClassUID/Modality 維持**の妥当性: 一部 PACS が DERIVED CT を厳格検証する可能性 → `ImageType` と `SourceImageSequence` を正しく付与。
- **web モード保存**: 初期は standalone のみ。web(STOW-RS) は P4。

## 11. 決定事項（確定）

- リスライス計算は**フロント TS**（`reslice.ts`、GRAPHY `VolumeSampler`/`SlicePlane` 移植）。プレビューは cornerstone
  （oblique camera＋slabThickness＋blendMode）。**表示＝cornerstone / 確定生成＝自前サンプラー**の二層。
- 出力は**元 Modality 維持＋`ImageType=DERIVED\SECONDARY\RESLICE`**、Rescale/16bit signed 継承、`SourceImageSequence` でリンク。
- **独立 Slicer ウィンドウ**（`#slicer`）。volume 構築は MPR と共通化。
- 初期スコープは**平面オブリークのみ**（Curved/CPR は P4）。
- 保存は backend **`POST /api/series/derived`** ＋ `DerivedSeriesService`。UID 採番=`UIDUtils`、保存=`DicomStorageService.ingest`、
  属性引き継ぎ=`NonDicomConverter.common`/`blankDicom` パターン流用。**StudyInstanceUID / FrameOfReferenceUID / 患者・検査属性は維持**。
