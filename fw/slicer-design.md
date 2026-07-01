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
- **P2 UI/プレビュー** — ✔ 完了（要実機確認）。**当初の base+recon 2 面案から、MPR 3 面＋
  スラブバンド投影案へ作り替え**（ユーザー指定 2026-07-01: MPR 表示／各スライスを立方体で表示／
  Thickness・Gap 連動／全断面にリファレンス表示／再構成進捗バー）。
  - **断面操作 = Crosshairs で任意 3D オブリーク**（基準面 AX/SAG/COR を UI 選択、既定 AXIAL）。
  - **各スライスの立方体 = 各 MPR 面へ断面バンド（交差ポリゴン）描画**（Thickness=帯幅・Gap=帯間隔・枚数=帯本数）。
  - **進捗 = メインスレッドでスライス毎分割**（`createReslicer.sliceAt(s)` を 1 枚ずつ＋`requestAnimationFrame` yield）。
  - `frontend/src/viewer/reslice.ts`: `createReslicer`（スライス単位実行＝進捗対応）を追加。`reslice`（一括）は
    これをループするだけ（挙動不変・21 テスト維持）。
  - `frontend/src/viewer/slicer.ts`: `setupSlicerMpr`（AX/SAG/COR ORTHOGRAPHIC×3＋CrosshairsTool＋W/L/Pan/Zoom/
    スライス送り＋VOI 同期, Slicer 専用 ID）／`readSlicerGeometry`（基準面カメラ→center/normal/rowDir/colDir）／
    `computeSlabBands`（各スライス箱の 8 頂点・12 辺を対象 MPR 面で切断→交差ポリゴンを `worldToCanvas`→
    canvas 座標へ）／`extractResliceVolume`（direction=[rowCos,colCos,normal] で reslice.ts と一致）／
    `volumeMinSpacing`／`teardownSlicer`。volume 構築は `buildMprVolume`（MPR と共通）。
  - `frontend/src/slicer/SlicerScreen.tsx`: 1×3 MPR＋各セルに SVG バンドオーバーレイ（`pointerEvents:none`＝
    Crosshairs は下のビューポートで操作）、基準面セレクタ、コントロールパネル（FOV 幅/高・スライス厚・Gap・
    枚数・再構成モード）。`CAMERA_MODIFIED`（Crosshairs 回転・スライス送り）と Slab/基準面変更でバンド即時再計算。
    「再構成」ボタンは `extractResliceVolume`＋`buildReslicePlane`＋`createReslicer` で**スライス毎に生成＋進捗バー**
    （枚数/行×列を表示）。「保存」は P3 まで disabled。
  - 配線: `App.tsx`（#slicer ルート）、`MainScreen.tsx`（`handleOpenViewer("slicer")`）、`i18n(ja/en)`（`slicer.*`）。
    Toolbar/MenuBar の Slicer ボタンは既存。
  - ビルド: `cd frontend && npx tsc -b && npx vite build` **green**。reslice 数値検証 21/21。
  - P2 既知の制約: standalone のみ（MPR と同じ）／単一シリーズ／基準面カメラの現在向きに沿ってスタックを積む
    （Crosshairs で任意回転可）。生成スタックの保存は P3。
- **P3 保存** — ✔ 実装（要実機検証）。
  - backend（新規パッケージ `com.vis.graphynext.dicom.derived`）:
    - `DerivedSeriesRequest`（record, frames は Base64 Int16LE）／`DerivedSeriesService.create()`／
      `DerivedSeriesController`（`POST /api/series/derived`, 検証失敗=400）。
    - テンプレート=元シリーズ代表インスタンスのヘッダ（`storage.resolveFiles`→`DicomInputStream` no-bulk）。
      **患者/検査/FrameOfReferenceUID/Modality/SOPClassUID/VOI を引き継ぎ**、SeriesInstanceUID/SOPInstanceUID
      を `UIDUtils.createUID()` で新規、`ImageType=DERIVED\SECONDARY\RESLICE`、IOP/IPP/PixelSpacing/
      SliceThickness/SpacingBetweenSlices を更新、`SourceImageSequence` で元へリンク。
    - 画素=16bit signed MONOCHROME2、`RescaleSlope=1/Intercept=0`（フロント volume 値＝CT は HU をそのまま保存）。
      保存は `DicomStorageService.ingest`（Part-10 一時ファイル→正規パス移動＋H2 索引, トランザクション）。
  - frontend（`SlicerScreen`）: 「保存」ボタン実体化。再構成の canonical 結果を保持し、保存時に
    **reverse を InstanceNumber と IPP の並び順で適用**（IOP 不変）、frames を Base64(Int16LE) 化して
    `POST /api/series/derived`。成功トースト表示。i18n(ja/en) 追加。`backend mvn -o compile` green /
    `tsc -b`＋`vite build` green。
  - 要検証: 実 CT/MR で保存→メインスクリーン更新→2D/MPR で再読込し幾何一致（FrameOfReferenceUID 維持で
    参照線整合）。**backend の再起動が必要**（新エンドポイント反映）。
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

## 10.5 Reverse Order（スライス順逆転）の設計判断 — 記録（2026-07-01・ユーザー指示）

**決定: Reverse は「IOP・視点（recon 幾何）を統一で固定し、再構成後に表示スライスの並び順だけを反転」する。**

- 実装（`SlicerScreen.onGenerate`）: 再構成は**常に正順（canonical, s=0..N-1）**で実行。recon の
  **IOP（rowDir/colDir）・積層方向 dir3・原点・カメラ視点は reverse に関係なく canonical で固定**
  （dir3 は**正順 IPP の LPS 実空間座標差分** `normalize(ipp[1]−ipp[0])` から導出。スライス番号では決めない）。
  Reverse は**表示フレーム列のみ反転** `displayFrames = reverse ? frames.slice().reverse() : frames`。
- バンドのスライス番号は表示スクロール順に一致させる: `num = reverse ? i+1 : n-i`
  （Cornerstone は volume index をスクロール上で逆向きに見せるため反転式）。

**なぜこの仕様にしたか（重要・忘れないこと）:**

1. **IOP は統一**（ユーザー指示 2026-07-01「ReverseOrderは、IOPは統一で、再構成後にスライスオーダーを
   並び替えるだけ」）。派生シリーズの各スライスは同一 IOP を共有し、順序だけが変わるのが正しい直感。
2. **幾何/視点を反転すると“見た目が変わる”不具合が出る**: 初期実装では reverse 時に積層法線を反転
   （`buildReslicePlane` に −normal を渡す or IPP を反転して dir3=−normal）していた。すると
   - `buildReslicePlane` は右手系維持のため **rowDir を反転 → 面内が 180°回転**、
   - あるいは recon volume の direction 第3軸が反転 → **左手系 → ACQUISITION カメラが反対側から見る
     → 左右ミラー**、
   が発生し、「Reverse Off=上下フリップ / On=180°回転」「番号と画像順が逆」等の症状になった。
   Reverse は**順序だけ**変えたいので、幾何・視点は動かさず表示列のみ反転する方式に確定した。
3. **順序は LPS 実空間座標で決める**（ユーザー指示「スライス番号ではなく、LPSの実空間座標で比較調整」）。
   dir3 を IPP 差分から導出することで、非等間隔・オブリークでも実空間に忠実な積層になる。
4. 併せて `readSlicerGeometry` は **colDir=画面下（−viewUp, DICOM の row 増加方向）** に統一した
   （これを怠ると出力フレームが上下反転する）。

**P3（DICOM 保存）での適用方針:** 保存時も IOP は全スライス共通で固定し、Reverse は
**InstanceNumber と IPP の並び順の反転**として表現する（各スライスは自身の IPP を保持）。幾何の反転や
IOP 変更は行わない。

## 11. 決定事項（確定）

- リスライス計算は**フロント TS**（`reslice.ts`、GRAPHY `VolumeSampler`/`SlicePlane` 移植）。プレビューは cornerstone
  （oblique camera＋slabThickness＋blendMode）。**表示＝cornerstone / 確定生成＝自前サンプラー**の二層。
- 出力は**元 Modality 維持＋`ImageType=DERIVED\SECONDARY\RESLICE`**、Rescale/16bit signed 継承、`SourceImageSequence` でリンク。
- **独立 Slicer ウィンドウ**（`#slicer`）。volume 構築は MPR と共通化。
- 初期スコープは**平面オブリークのみ**（Curved/CPR は P4）。
- 保存は backend **`POST /api/series/derived`** ＋ `DerivedSeriesService`。UID 採番=`UIDUtils`、保存=`DicomStorageService.ingest`、
  属性引き継ぎ=`NonDicomConverter.common`/`blankDicom` パターン流用。**StudyInstanceUID / FrameOfReferenceUID / 患者・検査属性は維持**。

## 12. 現況・作業記録（2026-07-01 完了時点）

**状態: P0〜P3 ＋ 追加対応（マルチ C/T 単一スタック抽出・SAG/COR 妥当性確認）まで実装＋実機確認済み
（断面調整→再構成→保存往復→MainScreen 自動更新まで動作確認）。P4 は未着手。全変更は未コミット。**

**未コミット変更（2026-07-01 時点）:**
- frontend（変更）: `viewer/reslice.ts`・`viewer/slicer.ts`・`slicer/SlicerScreen.tsx`・`viewer/mpr.ts`・
  `App.tsx`・`mainscreen/MainScreen.tsx`・`settings/registry.ts`・`i18n/{ja,en}.ts`
- backend（新規）: `dicom/derived/`（`DerivedSeriesRequest`/`DerivedSeriesService`/`DerivedSeriesController`）
- doc: `fw/slicer-design.md`（本書）／メモリ `slicer-feature-status.md`・`slicer-reverse-order-decision.md`
- ※ `frontend/src/viewer2d/*`・`wand2d.ts` 等の変更は**別ワーカーの 2D/3D Wand 作業**で Slicer とは無関係。

### 完了フェーズ
- **P0 設計**（本書）／**P1 リスライスコア**（`reslice.ts`, 数値検証 21/21）／**P2 UI・操作**（MPR 3面＋スラブ箱＋
  ハンドル操作＋2×2＋再構成スタック表示＋進捗バー）／**P2追補**（XYZ回転角・中心IJK 表示＆手入力、
  スライス番号、Reverse、Settings 補間指定、CT チルト自動補正）／**P3 DICOM 保存**（派生シリーズ生成＋
  MainScreen 自動再検索）。

### 実装ファイル一覧
| ファイル | 役割 |
|---|---|
| `frontend/src/viewer/reslice.ts` | コア: `makeWorldSampler`(trilinear/nearest)・`buildReslicePlane`・`planeFromGeometry`・`createReslicer`(スライス単位=進捗)・`reslice` |
| `frontend/src/viewer/slicer.ts` | cornerstone グルー: `setupSlicerMpr`・`readSlicerGeometry`(colDir=画面下)・`computeSlabBands`/`computeSlabHandles`・`translateGeomInPlane`/`rotateGeomInPlane`・`anglesToGeometry`/`geometryToAngles`・`worldToIndex`/`indexToWorld`・`extractResliceVolume`(voxelManager フォールバック)・`displayReconStack`(ACQUISITION 表示)・`teardownSlicer` |
| `frontend/src/slicer/SlicerScreen.tsx` | 2×2 UI・ハンドル操作・回転/中心の表示&手入力・Reverse・進捗バー・保存(→`POST /api/series/derived`＋`emitDbChanged`) |
| `frontend/src/viewer/mpr.ts` | 共有 `buildMprVolume`（streaming 経路に**メタ先読み＋IPP 空間ソート＋`volume.load()`** を追加＝Z折返し/未表示を解消） |
| `frontend/src/App.tsx` | `#slicer` ルート＋`subscribeDbChanged`→`dbVersion` で全ウィンドウ一覧を現在条件で再検索 |
| `frontend/src/mainscreen/MainScreen.tsx` | `handleOpenViewer("slicer")` 起動導線 |
| `frontend/src/settings/registry.ts` | `slicer.interpolation`（linear/nearest） |
| `frontend/src/i18n/{ja,en}.ts` | `slicer.*` キー |
| `backend/.../dicom/derived/DerivedSeriesRequest.java` | 保存リクエスト DTO（frames=Base64 Int16LE） |
| `backend/.../dicom/derived/DerivedSeriesService.java` | 属性引き継ぎ(`copyTag` 個別コピー)＋幾何/画素更新＋`ingest` |
| `backend/.../dicom/derived/DerivedSeriesController.java` | `POST /api/series/derived`（検証失敗=400） |

### 実機で解決した不具合（記録）
- **stale HMR チャンク**（`cache is not defined`）→ dev サーバ再起動/ハードリロードで解消（並行作業由来）。
- **streaming で Crosshairs が `Missing imagePositionPatient`／MPR 未表示** → `buildMprVolume` 先読み＋`volume.load()`。
- **Z 方向の折り返し** → cornerstone は **wadouri を空間ソートしない**ため、`createAndCacheVolume` 前に **IPP 法線投影で空間ソート**。
- **再構成が走らない（Failed to build）** → streaming の `getImageData().scalarData` は throw する getter。`voxelManager.getCompleteScalarDataArray()` を優先。
- **再構成のストライプ状の途切れ** → recon 表示を `OrientationAxis.ACQUISITION` に（斜め束を world-Axial で切っていた）。
- **上下反転／Reverse の見た目変化** → `readSlicerGeometry` colDir=画面下、`planeFromGeometry` 直接構成、Reverse は表示列のみ反転（§10.5）。
- **保存 `study=null`** → `Attributes.addSelected(int...)` が期待通り copy せず。`copyTag` で個別コピー。
- **保存後に MainScreen ツリーが更新されない** → `emitDbChanged`（Slicer）＋`subscribeDbChanged→dbVersion`（App）で現在条件のまま自動再検索。

### 検証
- `frontend`: `npx tsc -b` ＋ `npx vite build` green（Slicer 関連ファイルはエラー無し。並行作業の `wand2d.ts`/`Viewer2D.tsx` の型エラーは別担当・dev 実行は非ブロック）。
- `backend`: `mvn -o compile` green。
- reslice 数値検証: `scratchpad/verify_reslice.mjs` 21/21。
- 実機（standalone）: MR「Gad Ax T2 Straight」で断面調整→再構成→保存→MainScreen 自動更新→新シリーズ出現を確認。CT チルトサンプルでチルト補正チップ表示。

### 追加対応（2026-07-01・完了後）
- **マルチ C/T シリーズのソース対応**: ソースが C(チャンネル)/T(時相) 次元を持つ場合、`fetchSeriesLayout`
  （ZCT レイアウト, `cells[{c,z,t,sop,frame}]`）から **単一 (c,t) の Z スタックを抽出**してから volume 化・
  リスライスする。初期 (c,t) は slicer ctx（`ctx.c`/`ctx.t`）→無ければ 0。マルチ次元時はコントロールバーに
  **C/T セレクタ**を表示し `applyCT` で単一スタック差し替え（幾何は保持）。レイアウト取得失敗/セル不足は
  `fetchInstances` 全件へフォールバック。実装: `SlicerScreen`（`imageIdsForCT`/`applyCT`）。
  ※現状 MainScreen 起動では ctx に C/T が無いため初期 0。2D ビューアから表示中 C/T を渡す配線は将来対応。
- **SAG/COR ソースの妥当性**: 設計上リスライス可能（volume は患者 LPS world 構築、`makeWorldSampler` は
  任意正規直交 direction を内積で逆写像、geom は world axial 由来で取得方向非依存）。ただし **CT ガントリ
  チルト補正は軸位収集前提**（SAG/COR CT は streaming 経路）。SAG/COR 実データは未検証（目視推奨）。

### P4（未着手・残タスク）
- Curved MPR / CPR（`CurvedReformatter`）・Straightened（`StraightenedVolumeBuilder`）・Centerline 編集。
- 2D ビューアからの Slicer 起動で表示中 C/T を ctx 経由で渡す（現状は Slicer 内セレクタで選択）。
- web(wadors/STOW-RS) の読込・保存経路（現状 standalone のみ）。
- 複数シリーズ選択 UI。
- recon プレビューのスクロール方向とバンド番号の厳密一致（現状は表示順に合わせた番号式で対応）。
- 実 CT での保存往復（HU 一致）の追加検証。
