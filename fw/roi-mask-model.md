# 2D/3D ROI・マスク データモデル定義

ROI ブラシ・2D/3D ワンド・ImageJ ブリッジの土台となる、ROI（幾何注釈）と Mask（セグメンテーション）の
データモデル・座標系・ZCT 連携・永続化・相互運用の定義。Cornerstone3D 3.x の segmentation/annotation API、
既存の DICOM SEG 読込、ZCT レイアウトを前提とする。

---

## 1. 用語と区分

| 種別 | 実体 | 例 | 算出値 |
|---|---|---|---|
| **ROI（幾何注釈）** | ベクトル（ハンドル座標） | 長さ・角度・楕円・矩形・プローブ・自由曲線 | 距離/角度/面積/周囲長/統計(平均·SD·min·max) |
| **Mask（セグメンテーション）** | ラスタ（labelmap） | ブラシ・ワンド(領域成長)・しきい値・塗りつぶし | 体積/ボクセル数/統計 |

- **2D** = 単一スライス内、**3D** = 複数スライス（ボリューム）にまたがる。
- ROI=`Cornerstone annotation`（Phase C 実装済）、Mask=`Cornerstone segmentation labelmap`。

---

## 2. 座標系・次元（ZCT 連携）

- ROI/Mask は **(study, series, C, T) で決まる Z スタック**に紐づく。**2D=単一 Z**、**3D=同一 (C,T) の Z 範囲**。
- 幾何 ROI: 画像座標(px) を保持し、`FrameOfReferenceUID`＋IPP/IOP で患者座標(mm)へ。計測の mm 換算に PixelSpacing。
- Mask: source 画像と同マトリクスの labelmap。stack labelmap は **source imageId ごとに labelmap imageId** を対応付け。
- **C/T を変えると別スタック**。ROI/Mask は原則 **(C,T) ごとに保持**（同一物理位置でも内容が違うため）。
  - ただし「同一位置の別チャンネルへ ROI/Mask をコピー/共有」は将来オプション（§8 決定事項）。
- mosaic/SEG 由来の合成 imageId（`/frames/{k}/file`）も通常 imageId として扱えるため labelmap 対応可能。

---

## 3. アプリ内データモデル（提案）

```ts
type SeriesKey = { studyUid: string; seriesUid: string; c: number; t: number };

interface RoiItem {
  id: string;
  kind: "length" | "angle" | "ellipse" | "rect" | "probe" | "freehand";
  series: SeriesKey;
  z: number;                 // 2D: 所属スライス
  csAnnotationUID: string;   // Cornerstone annotation の UID（権威データはそちら）
  label?: string;
  visible: boolean;
  color?: string;
}

interface SegmentDef { index: number; label: string; color: [number,number,number]; locked: boolean; visible: boolean; }

interface MaskItem {
  id: string;                // = Cornerstone segmentationId
  series: SeriesKey;
  scope: "2d" | "3d";        // 2d=現在スライスのみ編集 / 3d=スタック全体
  segments: SegmentDef[];    // 多セグメント（segment index）
  // labelmap 実体は Cornerstone segmentation state（stack labelmap）に保持。
}
```

- **権威データ**: ROI=Cornerstone annotation state、Mask=Cornerstone segmentation state。
  アプリ側は **ID・シリーズ(ZCT)紐付け・ラベル/色・表示/ロック**のメタを管理（マネージャ UI 用）。
- レジストリ（`roiMaskStore.ts`）で `SeriesKey ↔ {rois[], masks[]}` を保持。タイル切替/再マウントで再適用。

---

## 4. Cornerstone 実装方針

### ROI（幾何）
- 既存 annotation tools（Length/Angle/EllipticalROI/RectangleROI/Probe、Phase C）。自由曲線は `PlanarFreehandROITool` を追加可。
- ROI 統計は ROI ツール標準＋必要に応じ `utilities` で面積/HU 統計を併記。

### Mask（labelmap）
- `segmentation.addSegmentations([{ segmentationId, representation: { type: Labelmap }, data: stack labelmap imageIds }])`
  → `segmentation.addLabelmapRepresentationToViewport(viewportId, [{segmentationId}])`。
- 編集ツール:
  - **ブラシ** = `BrushTool`（2D=現在スライス。3D=`SphereScissorsTool` か volume labelmap）。ブラシ径・アクティブ segment。
  - **ワンド/領域成長** = `RegionSegmentTool`/`RegionSegmentPlusTool`（grow-cut）。**2D=スライス内、3D=ボリューム**。
  - しきい値 = `RectangleROIThresholdTool`、塗りつぶし = `PaintFillTool`、消しゴム = ブラシの erase。
- **2D vs 3D**: stack labelmap は基本 per-slice 編集（2D）。3D ワンド/球ブラシはスライス間に広がるため、
  対象スタックを volume 化（`computeVolumeLabelmapFromStack`/`convertStackToVolumeViewport`）して処理 →
  stack へ戻す、または最初から VolumeViewport を用いる（§8 決定事項）。

---

## 5. 統計

- **ROI**: 面積(mm²)、長さ/周囲長(mm)、HU 平均/SD/min/max（Modality LUT 適用後）。
- **Mask**: セグメント体積(mm³ = ボクセル数×voxel体積)、ボクセル数、HU 平均/SD/min/max。
- 表示: ROI は注釈テキスト、Mask/集計は **ROI・マスク マネージャ**パネルに一覧（CSV 出力可）。

---

## 6. 永続化・相互運用

| 手段 | 状態 | 用途 |
|---|---|---|
| メモリ（セッション） | v1 | 既定。タブ内保持。 |
| **DICOM SEG**（読込=実装済 / 書込=新規） | 次段 | Mask の保存・再読込・外部連携。`/frames` 配信と対称。 |
| DICOM RT Structure Set / GSPS | 将来 | ROI の標準保存。 |
| **ImageJ ブリッジ** | 別機能 | hyperStack＋ROI/Mask を IJ へ（§別ドキュメント）。 |
| PNG 焼き込み / CSV | 任意 | レポート用。 |

- Mask→DICOM SEG 書込は既存の SEG 読込（BINARY/連続LSB、PerFrame の Segment/Plane）と対称に実装可能。

---

## 7. UI

- **ROI・マスク マネージャ**（右パネル or ダイアログ）: 一覧（種別/ラベル/スライス or 範囲/統計）、表示・色・ロック・削除、CSV 出力。
- **ツール**: ROI（ROI メニュー＝実装済）、ブラシ/ワンド/しきい値/塗りつぶし/消しゴム（Tools メニュー）、ブラシ径・アクティブ segment・しきい値スライダ。

---

## 8. 決定したい事項

1. **(C,T) スコープ**: ROI/Mask は (C,T) ごとに独立保持で良いか（同一位置の別チャンネル共有は将来）。
2. **3D の実体**: stack labelmap（per-slice 中心、3D 操作時に一時 volume 化）で進めるか、最初から VolumeViewport を別途用意するか。
3. **永続化の優先度**: v1 はメモリのみ → 次に **DICOM SEG 書込**（往復）で良いか。
4. **マネージャ UI**: 右サイドパネルに常設か、ダイアログか。
5. **ImageJ ブリッジ起動方式**（別途詳細設計）: (a) backend(Java) が `ij.jar` を埋め込み/起動、(b) Electron が設定パスの ImageJ 実行ファイルを spawn、(c) ファイル書出し＋OS「ImageJ で開く」。「DB 非同期・hyperStack をブリッジするだけ」の要件に対し方針確認。

---

## 8'. 決定事項（2026-06-30）

1. **マスク実体**: **GRAPHY 同様バイナリ管理**。セグメントごとに 0/1 のバイナリボリューム（bit-pack 可）。
   ランタイムは Cornerstone labelmap（Uint8, segment index）で描画し、保存/管理はバイナリ（DICOM SEG BINARY と対称）。3D=ボリューム全体のバイナリマスク。
2. **永続化**: メモリ ＋ **DICOM SEG 書込**（読込は実装済 → 往復）。
3. **マネージャ UI**: **右サイドパネル常設**（一覧・色・表示・ロック・削除・統計・CSV）。
4. **ImageJ ブリッジ**: **backend(Java) が ij.jar を埋め込み/起動**し hyperStack をブリッジ（DB 非同期）。別ドキュメントで詳細設計。

### Cornerstone スタック labelmap 生成レシピ（確認済）
```
const labelmaps = imageLoader.createAndCacheDerivedLabelmapImages(sourceImageIds); // 1スライス=1 labelmap
const labelmapImageIds = labelmaps.map(i => i.imageId);
segmentation.addSegmentations([{ segmentationId, representation: { type: Labelmap, data: { imageIds: labelmapImageIds } } }]);
segmentation.addLabelmapRepresentationToViewport(viewportId, [{ segmentationId, type: Labelmap }]);
segmentation.activeSegmentation.setActiveSegmentation(viewportId, segmentationId);
segmentation.segmentIndex.setActiveSegmentIndex(segmentationId, 1);
// Brush: addTool(BrushTool) → tg.addTool → tg.setToolActive(Primary)。径= utilities.segmentation.setBrushSizeForToolGroup。
```
- バイナリ保存: labelmap(Uint8) の segment index>0 を 1 とみなして bit-pack → DICOM SEG BINARY。

## 9. 実装順（進捗）

1. 本モデル定義（本書）＋決定事項。 ✅
2. **Mask 基盤**（`viewer/segmentation.ts`: `ensureStackSegmentation`=stack labelmap 生成・representation 追加・active segment）。 ✅
3. **ROI ブラシ**（`BrushTool`, 2D。Tools メニューで ブラシ/消しゴム＝FILL/ERASE ストラテジ、ツールバーにブラシ径入力）。 ✅
4. **2D/3D ワンド**（`RegionSegmentTool`/`RegionSegmentPlusTool`。2D→3D）。Cornerstone 登録済み・**メニュー/ツールバー未結線**。 ⬜
5. **ROI・マスク マネージャ**（右サイドパネル常設）＋統計＋ `roiMaskStore.ts`（ZCT 紐付け・再適用）。 ✅
6. **DICOM SEG 書込**（backend。バイナリ管理・往復）。 ✅
7. **ImageJ ブリッジ**（backend ij.jar。別ドキュメントで設計後）。 ✅

> 詳細な進捗・実機確認状況は `fw/roi-mask-progress.md` 参照。残る未実装は 4（ワンドの結線）のみ。
</content>
