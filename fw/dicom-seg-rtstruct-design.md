# DICOM SEG / RTSTRUCT 書き出し 設計（ROI・マスクの永続化）

セグメンテーション（マスク）と 2D ROI（ベクタ注釈）を **DICOM 標準形式で保存**し、再読込で復元するための設計。
GRAPHY-Next の ROI/マスクは現状 **セッション（メモリ）保持のみ**（`roi-mask-model.md` §6）。本書はその永続化を扱う。

前提: `fw/roi-mask-model.md`（ROI=注釈 / マスク=labelmap）、`fw/roi-manager-design.md` §6（保存形式一覧）、
`fw/segmentation-tools-design.md`（P5=保存）。backend は **dcm4che 5.34.3** を利用（`pom.xml`）。
SEG **読込**は実装済み（`DicomStorageService.segLayoutIfApplicable` / `multiFrameDicom`、`PerFrameFunctionalGroupsSequence` 解析）。本書の**書込は読込と対称**に作る。

---

## 0. 形式の使い分け（対象 → DICOM 形式）

| 対象 | 実体 | DICOM 形式 | 標準 |
|---|---|---|---|
| **マスク** | ラスタ labelmap（0/1・多値） | **DICOM SEG**（Segmentation Storage） | SOP Class `1.2.840.10008.5.1.4.1.1.66.4` |
| **2D ROI（ベクタ）** | 輪郭（ポリゴン）/図形 | **RT Structure Set（RTSTRUCT）** | SOP Class `1.2.840.10008.5.1.4.1.1.481.3` |

- **SEG=ラスタ専用**。ベクタ ROI をそのまま SEG にはできない（ラスタ化すれば可＝▦ ROI→Mask 経由）。
- **RTSTRUCT=ベクタ輪郭**。閉輪郭（楕円/矩形/自由曲線/円）をスライスごとの `ContourSequence`（患者座標 mm の点列）で保存。
- 代替: GSPS（図形注釈の presentation）・DICOM SR TID1500（計測値＋SCOORD）は将来オプション（本書はスコープ外、§9）。

---

## 1. 目的・スコープ

- **マスク → DICOM SEG 書込**（新規シリーズとして DB 取込 → 再読込で復元）。読込と往復。
- **2D ROI（面積型）→ RTSTRUCT 書込**（輪郭を DICOM 保存）。
- backend（dcm4che）で DICOM を生成 → 既存の取込パイプラインへ ingest（ImageJ ブリッジ/Slicer 保存と同様）。
- frontend は ROI マネージャからエクスポート。DTO で座標/ラベル/色を backend へ渡す。

非スコープ: GSPS/SR、RTSTRUCT の線量/計画情報、SEG の分数（FRACTIONAL）型（当面 BINARY）。

---

## 2. アーキテクチャ（共通）

```
[frontend] ROI マネージャ
  マスク: labelmap voxel（getLabelmapImageIds→voxelManager）→ SegExportDto（per-slice ビット/ラン）
  2D ROI: annotation（world 座標 or 画素→world）→ RtStructExportDto（ROIごとの輪郭点列）
        │  api.exportDicomSeg / api.exportRtStruct
        ▼
[backend] dcm4che で DICOM 生成
  SEG:     SegWriter   → Segmentation SOP（BINARY, PerFrame/Shared FG, bit-pack pixel data）
  RTSTRUCT: RtStructWriter → RT Structure Set SOP（StructureSetROI/ROIContour/RTROIObservations）
        │  参照シリーズの幾何（IOP/IPP/PixelSpacing/FoR）を継承
        ▼
[backend] 生成した DICOM を DB へ ingest（既存 storage 取込）→ 新シリーズとして一覧に出現
        ▼
[frontend] 再読込: SEG=既存読込で labelmap 復元 / RTSTRUCT=輪郭→annotation 復元（読込は新規実装）
```

- **幾何の権威**: 参照シリーズ（study/series）の IOP/IPP/PixelSpacing/**FrameOfReferenceUID**。SEG/RTSTRUCT とも
  `ReferencedSeriesSequence` / `FrameOfReferenceUID` で元シリーズに紐づける（`segMetadata` で供給済みの幾何と一致）。
- **DB 取込**: ImageJ ブリッジ（`ImageJBridgeService`）/Slicer 保存と同じ「一時 DICOM 生成 → storage ingest」パターンを踏襲。

---

## 3. DICOM SEG 書込（マスク）

### 3.1 生成物
- **Segmentation Storage**（1 SOP Instance）。`SegmentationType = BINARY`。多セグメント（labelmap の segment index 1..N）は
  `SegmentSequence` の各 `SegmentNumber` に対応。
- **Shared/Per-Frame Functional Groups**: `PixelMeasuresSequence`(PixelSpacing/SliceThickness), `PlaneOrientationSequence`(IOP),
  各フレーム `PlanePositionSequence`(IPP) と `SegmentIdentificationSequence`(ReferencedSegmentNumber)。
- **Pixel Data**: BINARY（1bit/pixel, LSB パック）。非空フレームのみ出力（segment×slice）。
- `ReferencedSeriesSequence`＋`FrameOfReferenceUID` で参照シリーズへ紐付け。CIE Lab の `RecommendedDisplayCIELabValue`＝segment 色。

### 3.2 frontend → DTO
```ts
interface SegExportDto {
  studyUid: string; seriesUid: string;         // 参照シリーズ
  frameOfReferenceUID?: string;
  segments: {
    number: number; label: string; color: [number,number,number]; // segment index/ラベル/RGB
    // 非空スライスごとのマスク（画素）。z=参照スライス index、data=行優先の 0/1（または RLE）。
    frames: { z: number; sopInstanceUid: string; ipp: [number,number,number]; mask: Uint8Array | number[] }[];
  }[];
  rows: number; cols: number; pixelSpacing: [number,number]; iop: number[];
}
```
- 生成元: `csSeg.getLabelmapImageIds(segId)` → 各スライス `voxelManager.getAtIndex(i)`。segment index ごとに 0/1 化。
- 転送量削減のため mask は **RLE or bit-pack** で送っても良い（backend で復号）。

### 3.3 backend `SegWriter`
- dcm4che `Attributes` を組み、`SegmentationType=BINARY`、`SegmentSequence`、Functional Groups、`PixelData`(bit-pack) を設定。
- **既存読込と対称**（`DicomStorageService` の `PerFrameFunctionalGroupsSequence`/Segment 解析の逆）。
- 生成 → storage ingest → 新シリーズ。

---

## 4. RTSTRUCT 書込（2D ベクタ ROI）

### 4.1 生成物
- **RT Structure Set Storage**（1 SOP Instance）。
  - `StructureSetROISequence`: ROI ごと（ROINumber, ROIName, ReferencedFrameOfReferenceUID）。
  - `ROIContourSequence`: ROI ごとの色（ROIDisplayColor）と `ContourSequence`。
    - 各 `ContourItem`: `ContourGeometricType=CLOSED_PLANAR`, `NumberOfContourPoints`, `ContourData`（x,y,z... mm, 患者座標）,
      `ContourImageSequence`（該当スライスの ReferencedSOPInstanceUID）。
  - `RTROIObservationsSequence`: ROI 種別（`RTROIInterpretedType` 等、任意）。
  - `ReferencedFrameOfReferenceSequence`: 参照シリーズの FoR・スライス群。
- **面積型 ROI（楕円/円/矩形/自由曲線）** を閉ポリゴンにサンプリングして輪郭点列に。楕円/円は多角形近似、矩形は 4 点、
  自由曲線は polyline。線/角度/点は RTSTRUCT には不向き（→ ImageJ/SR/GSPS 側で扱う）。

### 4.2 frontend → DTO
```ts
interface RtStructExportDto {
  studyUid: string; seriesUid: string; frameOfReferenceUID?: string;
  rois: {
    name: string; color: [number,number,number]; type?: string;
    // スライスごとの閉輪郭（患者座標 mm）。z 面の SOPInstanceUID を参照。
    contours: { sopInstanceUid: string; points: [number,number,number][] }[];
  }[];
}
```
- 生成元: annotation の handle（画素）→ `imageToWorldCoords` で world(mm) へ。楕円/円/矩形は形状式→多角形サンプリング、
  freehand は `data.contour.polyline`。既存 `imagejExport.ts` の座標変換ロジックを流用可。

### 4.3 backend `RtStructWriter`
- dcm4che で StructureSetROI/ROIContour/RTROIObservations と参照 FoR を組む。生成 → ingest → 新シリーズ。

---

## 5. backend 要件・エンドポイント

- **新規**: `com.vis.graphynext.dicom.export`（or 既存 `dicom` 配下）に `SegWriter` / `RtStructWriter`。
- エンドポイント（ImageJ Controller と同流儀 `@PostMapping`）:
  - `POST /api/dicom/seg`（body=SegExportDto）→ 生成＋ingest→新 series UID を返す。
  - `POST /api/dicom/rtstruct`（body=RtStructExportDto）→ 同上。
- **読込（往復）**: SEG は既存表示読込で復元。RTSTRUCT 読込（輪郭→annotation 復元）は**新規**（frontend `rtstructImport.ts`）。
- 重い変換（bit-pack/RLE、輪郭サンプリング）は backend、または frontend 側で前処理。

---

## 6. frontend 連携

- `api.ts`: `exportDicomSeg(dto)` / `exportRtStruct(dto)`。
- ROI マネージャ: **「DICOM SEG 書出」**（マスク見出し）・**「RTSTRUCT 書出」**（ROI 見出し）ボタン。scope/患者でフィルタした対象を送信。
- 生成後トースト（新シリーズはメイン画面に出現）。ImageJ 書出（IJ ⬇）と併存。

---

## 7. 座標・幾何の一貫性

- ROI/マスクの幾何は `segMetadata`（backend `SeriesLayoutDto`: IOP/PixelSpacing/rows/cols/per-Z IPP/**FoR**）と一致させる。
- SEG のフレーム IPP・RTSTRUCT の Contour z は**参照スライスの IPP/SOPInstanceUID** を使う（`layout.zStack`/`ippAt` から解決）。
- FrameOfReferenceUID は参照シリーズのものを継承（SEG/RTSTRUCT とも必須）。

---

## 8. 実装フェーズ

| # | 内容 | 規模 |
|---|---|---|
| S1 | **SEG 書込**（`SegWriter`＋`/api/dicom/seg`＋frontend Export）。BINARY・多セグメント・往復（読込は既存）。 | 大 |
| S2 | **RTSTRUCT 書込**（`RtStructWriter`＋`/api/dicom/rtstruct`＋Export）。面積型 ROI の輪郭化。 | 大 |
| S3 | **RTSTRUCT 読込**（輪郭→PlanarFreehandROI 復元、`rtstructImport.ts`）。 | 中 |
| S4 | （任意）GSPS / DICOM SR TID1500（計測値）・SEG FRACTIONAL。 | 大 |

各フェーズ: backend `mvn -q -o compile`＋テスト、frontend `npm run build`、i18n、`fw/` 反映。

---

## 9. 確認事項・将来

- **2D ROI の SEG 代替**: 面積型 ROI は ▦（ROI→Mask）でラスタ化して SEG 保存も可（ベクタ喪失）。用途で使い分け。
- **線/角度/点 ROI**: RTSTRUCT 不適。**DICOM SR（TID1500 計測）** か **GSPS**（図形 presentation）で将来対応。
- **SEG FRACTIONAL**: 確率/連続値マスクが要る場合（当面は BINARY）。
- **DB 取込の重複回避**: 同一 ROI/マスクの再書出時に新 SOP/Series UID を毎回発行（版管理は将来）。
