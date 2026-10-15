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

## 10. ROI とマスクの統合（2026-10-15 決定）

ROI マネージャには「ROI」だけを見せ、中身の持ち方（注釈＝ベクタ／ラベルマップ＝ラスタ）は内部で使い分ける。
足りない向きは変換で補う。動いているマスク系（Wand・ブラシ・演算・SEG・3D Viewer）は作り替えない。

**ユーザーの決定**
- Wand（2D/3D）の出力は、塗った ROI のまま（中身はラベルマップ）。輪郭線で表示し、ブラシで直す。
  RT・IJ へは書き出すときに輪郭へ変換する。
- segment が複数あるマスクは、segment ごとに 1 つの ROI として扱う。
- 「計測」メニューを作り、計測（長さ・RECIST・角度・Cobb 角・プローブ）と ROI を分ける。
  - ROI の種類は「領域」「線」「点」の 3 つ。
  - 計測はマスクにしない。
  - 計測の行に「ROI にする」を置く（長さ→線 ROI、プローブ→点 ROI）。
- パネルは「ROI」と「計測」の 2 つの欄にする。

**段**
- 0: 2D/3D の判定を狂わせる不整合を直す（本節の規則）。
- 1: マスク→ROI の変換（`viewer/maskContour.ts`）。
- 2: メニューの分割・ROI の種類・パネルの 1 本化。
- 3: 入口をそろえる（RTSTRUCT 読み込みを構造ごとに 1 ROI にする）。
- 4: 出口をそろえる（塗った ROI の RT・IJ・匿名化・`getRois`・保存）。

**段 0 の規則**（`viewer/maskScope.ts`）
- 演算・SPLIT・⬤ の球・ROI→Mask の結果の `scope.z` は、入力のメタを引き継がず、前景を塗ったスライスから決める。
  - 1 枚だけならそのスタック上の番号、2 枚以上なら `"all"`。前景が無ければメタを変えない。
- 1 スライスのマスクは、次の 2 通りの持ち方を許す。
  - シリーズ全体の大きさに 1 枚だけ塗った形（`roiToMask`・RTSTRUCT 読み込み）
  - 1 枚だけのラベルマップ（⬚ 分割）
  - 演算は、各スライスを `referencedImageId` で元のスタックに当てはめて重ねる（`alignToStack`）。
  - `roiToMask` を 1 枚だけにそろえないのは、別のスライスにブラシで塗れなくなるため。
- マスクの ZCT は表示だけにする（押しても変わらない）。ブラシ・Wand で作るマスクはボリューム（`Z:all`）。

**段 1 の変換**（`viewer/maskContour.ts`）
- 画素の境界をなぞる（頂点は画素の角）。4 近傍の成分ごとに、外周（時計回り）と穴（反時計回り）を返す。
- 画素中心の偶奇判定（`fillPolygonsEvenOdd`）で塗り直すと、元と同じ画素に戻る。
  - この往復はテストで固定する。
  - 判定は `rasterizeRoi` の点の内外判定と同じ式。

**段 2 PR 3（パネル）**（`viewer2d/RoiManagerPanel.tsx`、行モデルは `viewer/roiRows.ts`）
- 欄は「ROI」と「計測」の 2 つ。「マスク」「3D 球」の欄は無い。
  - ROI: 1 件 1 行。形の ROI（面積・線・点）、塗りの ROI（**ラベルマップの segment 1 つにつき 1 行**）、パラメトリック球（アイコンで区別）。
  - 計測: Length / Bidirectional / Angle / Cobb / Probe。種別不明のツール（矢印注記など）も落とさずここに出す。
  - 「＋新規 ROI（塗り）」はこれまでの新規マスク（segment 1 の新しいラベルマップ）。「＋セグメント」は無い（segment は SEG 取り込み・SPLIT で生じる）。
- 塗りの ROI の行
  - 行を押す／ラジオ＝その segment を塗り先（`activateMask(id, segIndex)`）。👁・色・不透明度・塗りは segment 単位、輪郭線の太さだけマスク単位（Cornerstone の制約）。
  - 名前は `segmentLabels[segIndex]`。segment が 1 つだけのマスクは `label` も同じ値にそろえる（表示は `label` が優先）。
  - Σ / Σ³ / CSV は segment 単位（`segmentIndex`）。🗑 は `removeSegment` でその segment だけ消し、最後の 1 つならマスクごと消す。
  - ⬚（スライス分割）・RT ⬇ も segment 単位。**SEG ⬇ だけはマスク全体**（同じマスクの ROI すべてを書く。ツールチップに明記）。
  - segment が 1 つだけの行は「行＝マスク全体」として従来どおり非ゼロすべてを前景にする（`segmentIndex` を渡さない）。
- 前景の定義は `isSegmentForeground(value, segmentIndex?)` の 1 か所（`maskStatsCore.ts`）。統計・ボクセル CSV・ブール演算・SPLIT が共有する。
- 演算バー（MERGE(OR) / AND / XOR / SPLIT）は、**選択した ROI 行**（形・塗りの両方にチェックボックス）に働く。
  - 塗りの行は `value === segIndex` のボクセルだけを前景にする（マスク全体ではない）。
  - 形の ROI は先に `roiToMask` で**一時マスク**にラスタ化して計算し、**演算が終わったら一時マスクを取り除く**（結果の新規 ROI だけを残す。パネルに中間物を残さないため）。面積型でない形が混ざると失敗（null）。
  - SPLIT は塗りの ROI 1 件に対して、その segment のボクセルだけを連結成分に分け、元の segment を置き換える。

### 段 2 PR 4（3D ビューワ）
3D ビューワは別 BrowserWindow で、2D とメモリを共有しない。2D の ROI は `BroadcastChannel`（`viewer/maskBridge.ts`）で渡す。純関数は `viewer/maskBridgeCore.ts`。
- **一覧（announce）は ROI 単位**。要求は `{studyUid, seriesUid, c, t}`、応答は次のどちらかの配列。
  - `{kind:"painted", segmentationId, segmentIndex, label, color, c, t}` … 塗りの ROI（segment 1 つ）。名前は 2D の行と同じ規則（`paintedRowName`）。名前が無ければ中立の `ROI n`。
  - `{kind:"sphere", sphereId, label, color, center, radiusMm, c, t}` … パラメトリック球。
  - 絞り込みは study/series と C/T の両方。scope の c/t が `"all"` か未設定なら、どの C/T にも一致する。
- **フレーム取得（frames-request）は `segmentIndex` を受け取り**、その segment だけを返す（`extractMaskFrames(id, segIndex)`）。球はフレームを使わず、3D 側で中心＋半径を表示ボリュームの格子へラスタ化して ROI（kind "roi"）にする（`viewer/sphereRaster.ts`。メッシュではない）。
- **取り込みの入口は 1 つ**「2D ビューアの ROI から 3D ROI を追加…」。ROI を 1 件ずつ、または「すべて追加」。⟳ で再取得。3D パネルと同じウィンドウ（モバイル）にある ROI は同じ一覧に混ぜ、`segmentationId + segmentIndex` で重複を落とす。
- **取り込み元の参照**: `SceneObject.source`（`seriesUid / c / t / segmentationId / segmentIndex / sphereId / origin: "2d" | "server"`）。一覧では取り込み済みに印を付け、「すべて追加」は取り込み済みを飛ばす。
- **サーバの SEG/RTSTRUCT** は、表示中シリーズを参照するものだけ。backend は参照シリーズ UID を返さないので、フレーム/輪郭の `referencedSopInstanceUid` が表示中シリーズのインスタンス集合に含まれるかで判定する（参照が 1 つも無いものは除外）。
- **体積は 2 つ並べる**。ボクセル体積＝前景ボクセル数 × ボクセル体積（2D の Σ³ と同じ定義。格子が一致すれば同じ値）と、表示メッシュ（平滑化後）の体積。後者はメッシュ由来なので 2D の数値とは一致しない。
- **再起動**: 3D ウィンドウが開いたまま 2D が `graphy-viewer3d-ctx` を別の study/series/C/T で書き直したら、`storage` イベントで検知して画面ごと再読込する（`viewer3d/viewer3dCtx.ts`。`ts` だけの違いは無視）。
- 2D 側: 新しい塗りの ROI の既定名は `ROI n`（`label` と `segmentLabels["1"]` を作成時に設定）。塗りの行は 🗑 を 1 行目に移し、操作ボタンを 3 行目に分けた。
