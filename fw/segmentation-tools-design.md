# セグメンテーションツール 設計（GRAPHY → Next 移植 ＋ UX 改良）

GRAPHY オリジナルの 2D Viewer「Image > Segmentation」ツール群を GRAPHY-Next に移植する設計。
GRAPHY 独自の ROI オブジェクト（`FreeFormRoi3D` / `SphereRoi3D`）は **Next の ROI/Mask に読み替える**。
GRAPHY の分かりにくい時系列ワークフロー（開始/終了・ROI インポートのタイミング依存）を**モードレス化**して改良する。

前提: `fw/roi-mask-model.md`（ROI=幾何注釈 / Mask=labelmap）、`fw/roi-manager-design.md`（右パネル・演算）、`fw/roi-mask-progress.md`（実装済みの土台）。
Cornerstone3D 3.x の segmentation/annotation API、既存 MPR の volume 基盤（`viewer/mpr.ts`）を土台にする。

---

## 0. 確定した設計判断（2026-07-01, ユーザー承認済）

| # | 論点 | 決定 | 含意 |
|---|---|---|---|
| **D1** | 3D セグメンテーションの実体 | **軽量ルートで確定（2026-07-01）**（§3.0） | **既存 stack labelmap 基盤・StackViewport 表示のまま**、Cornerstone3D 3.33.5 が 3D ツール時に on-demand で volume 化（`EnsureSegmentationVolumeFor3DManipulation`）。VolumeViewport 大改修は不要。SphereScissors / growCut / 3D region grow / PaintFill が既存基盤で動く。規則的でないシリーズは 2D ツールにフォールバック。MPR 上のマルチプレーン編集のみ将来課題。 |
| **D2** | ワークフロー / UI モデル | **マネージャ右パネル主導・モードレス** | 「＋新規マスク」＝即編集対象。編集対象を常時ハイライト。Brush/Wand は常にアクティブマスクへ。GRAPHY の New/Stop の儀式を廃止。 |
| **D3** | マスク×セグメント粒度 | **1 マスクに複数セグメント** | 1 labelmap に複数 segment index（例: #1 肝臓 / #2 腫瘍）。効率的だがアクティブ index 管理が要る。 |

---

## 1. なぜ GRAPHY の UX が分かりにくいか（診断）

GRAPHY の `Image > Segmentation` は**不可視のグローバルモード**に依存する時系列ワークフロー。

| 問題 | 実装上の根拠 |
|---|---|
| **① 不可視の編集モード** | `Praparat.isSegmentationEditing()` = `activeSegmentation != null`。この状態で矩形/楕円/フリーハンド等の描画ツールが**サイレントにマスクへ焼き込まれる**（`CanvasGlass.bakeRoiIntoActiveSegmentation`）。同じツールが「ROI を作る／マスクを塗る」の二重の意味を持つ。 |
| **② Start/Stop の儀式** | `New segmentation…` で開始 → `Stop editing` で終了（`ViewerMenu`）。塗る行為と時間的に離れた別操作。押し忘れ・状態迷子。 |
| **③ ROI インポートのタイミング依存** | `Import selected ROIs into mask` は**編集中のみ有効**かつ**事前に ROI 選択済み**が前提。「いつ・何を選び・どの順で」が暗黙。 |
| **④ メニューの enable/disable が状態依存** | New/Import SEG は非編集時のみ、Import ROIs/Stop は編集時のみ。メニューを見ても手順が読めない。 |

**Next は既にこの一部を解消済み**（マネージャ右パネル常設、ROI→Mask は per-ROI ボタン `▦` でいつでも、ブール演算は選択式）。
未解消の核心 = 「**どのマスクにブラシが塗られるか**」が固定（`graphy-seg-{viewportId}` の segment #1 一択）で、複数マスク・アクティブ対象・ワンド/しきい値が無いこと。

---

## 2. 改良方針：モードレス化 ＋ アクティブ対象の可視化

原則は「**隠れたモードを無くし、状態を常時見せる**」。

1. **ツールの意味を固定** — Brush＝常にマスクを塗る／ROI ツール＝常に ROI を作る。文脈で意味を変えない（①廃止）。
2. **「アクティブマスク（編集対象）＋アクティブセグメント」を明示** — 右パネルに、いま塗られる対象を**◉ ＋太枠**で常時表示。これが GRAPHY「編集中」の代替。Start/Stop 廃止（②廃止）。
3. **マスク生成＝即アクティブ** — 「＋新規マスク」で作った瞬間に編集対象。Brush を選べば塗れる。「開始」ステップ不要。
4. **ROI→Mask はいつでも・対象を選んで** — 「結合▾」で「新規マスクへ／このマスク（アクティブ segment）へ結合」を選べる。ImageJ インポートは ROI を作るだけ、変換タイミングは自由（③④廃止）。
5. **永続化はモード終了ではない** — セッションは常時メモリ保持。`SEG 書出` は「編集終了」ではなく単なるエクスポート。

### ワークフロー比較

```
GRAPHY : New seg… →(描画がサイレントに焼込)→ ROIを選択→Import ROIs →Stop editing → Save SEG
Next案 : [＋新規マスク]=即編集対象 → Brush/Wand/Threshold/Scissors で塗る
         → 任意のROIを「結合▾」でこのマスクへ(いつでも) → (Stop不要) → SEG書出(いつでも)
```

---

## 3. アーキテクチャ：volume labelmap 基盤（D1）

### 3.0 P0 スパイク結果（2026-07-01, 確定）— **VolumeViewport 大改修は不要**

Cornerstone3D **3.33.5**（`@cornerstonejs/core` / `tools`）の実装を調査し、次を確認した。

- **統一セグメンテーションモデル**: labelmap は `imageIds`（stack）で保持したまま、3D 系ツールが**必要時に on-demand で volume を生成**する。
  該当実装 = `tools/segmentation/strategies/compositions/ensureSegmentationVolume.js` の
  `EnsureSegmentationVolumeFor3DManipulation`:
  1. `viewport.getImageIds()`（source）に対し `core.utilities.isValidVolume()` で再構成可否を判定。
  2. 可 → `getOrCreateSegmentationVolume(segmentationId)` が labelmap imageIds から
     `createAndCacheVolumeFromImagesSync` で volume を生成（**同一 imageId のスカラーを共有**するため、
     volume への書き込みが per-slice labelmap へ反映＝全スライスに描画される）。
  3. 不可 → `throw "Volume is not reconstructable for sphere manipulation"`。
- **`isValidVolume`** の条件（`core/utilities/isValidVolume.js`）= 2 枚以上・同一 series/modality/IOP/PixelSpacing/rows/cols/FoR
  かつ `usingDefaultValues` でない。= 規則的ボリューム。**これが 2D フォールバックの境界**（§3.3 と一致）。
- **実在ツール（3.33.5, 登録済 `cornerstoneSetup.ts`）**: `PaintFillTool` / `RegionSegmentTool` / `RegionSegmentPlusTool` /
  `RectangleScissorsTool` / `CircleScissorsTool` / `SphereScissorsTool` / `RectangleROIThresholdTool`。
  `BrushTool` は `FILL/ERASE_INSIDE_CIRCLE`（2D）と `FILL/ERASE_INSIDE_SPHERE`（3D）両ストラテジを持つ。
- **stack⇔volume 変換ヘルパ**も用意: `convertStackToVolumeLabelmap` / `convertVolumeToStackLabelmap`（必要時のみ）。

**結論（D1 の見直し提案）**: 当初の「VolumeViewport 本格導入＝2D Viewer 大改修」は**不要**。
**既存の stack labelmap 基盤（`ensureStackSegmentation`）と StackViewport 表示のまま**、3D ツールは
Cornerstone が on-demand volume 化して動く。実質的に「stack 主体＋（ライブラリ内部の）一時 volume 化」で、
D1 で選んだ機能（球スシザー・3D region grow・growCut）を**大改修なしに**得られる。
VolumeViewport は MPR 上でのマルチプレーン編集を将来やる場合のみ必要（本移植の必須要件ではない）。

**→ 軽量ルートで確定（2026-07-01, ユーザー承認）。以下 §3.1〜3.3 は確定アーキテクチャ。**

### 3.1 現状

- **2D Viewer** = StackViewport（`Viewer2D.tsx:519` `ViewportType.STACK`）。per-slice 表示。
- **MPR** = VolumeViewport（`mpr.ts:231` `ViewportType.ORTHOGRAPHIC` ×3）。`buildMprVolume()` が `volumeLoader.createAndCacheVolume`/`createLocalVolume`（CT チルト補正）で volume 構築。volume id = `graphy-mpr-vol:${seriesUid}`。
- **現セグメンテーション** = stack labelmap のみ（`segmentation.ts:55` `createAndCacheDerivedLabelmapImages`）。volume labelmap 系ツール（`SphereScissorsTool` / `RegionSegmentTool` / `RegionSegmentPlusTool` / `PaintFillTool` / `RectangleROIThresholdTool`）は**全て未登録**。
- MPR と 2D は volume/labelmap を共有していない。

### 3.2 確定アーキテクチャ（軽量ルート）

**セグメンテーションの実体は現状どおり stack labelmap（imageIds）。3D ツールはライブラリの on-demand volume に委ねる。**

```
series (imageIds) — StackViewport 表示（現状のまま）
  └─ ensureStackSegmentation(viewportId, imageIds)   … 既存。stack labelmap（多 segment 対応へ拡張）
       ├─ 表示: addLabelmapRepresentationToViewport（StackViewport, 現状）
       ├─ 2D 編集: BrushTool(CIRCLE) / PaintFill / RectangleROIThreshold …スライス内で直接
       └─ 3D 編集: BrushTool(SPHERE) / Sphere/Rectangle/CircleScissors / RegionSegment(Plus) / growCut
            → ツール内部で EnsureSegmentationVolumeFor3DManipulation:
                 isValidVolume(sourceImageIds) ? getOrCreateSegmentationVolume → volume voxel へ書込
                                               : throw（不可）→ アプリ側で 2D フォールバック
            （volume は labelmap imageIds とスカラー共有＝書込は全スライスの labelmap に反映）
```

- **volume 生成は不要**: `createAndCacheDerivedLabelmapVolume` を明示的に呼ぶ必要はなく、3D ツールが `getOrCreateSegmentationVolume` で暗黙生成。VolumeViewport も新設しない。
- **多セグメント**（D3）: 1 stack labelmap に segment index 1..N。`MaskItem.segments[]` を Cornerstone segment index に対応（`setActiveSegmentIndex`）。
- **編集サーフェス**: 既存の 2D StackViewport タイルがそのまま編集面。SphereScissors 等の 3D 操作もスライス上のドラッグで定義し、内部 volume へ 3D 書込→全スライスに反映。
- **MPR 共有は将来課題**: MPR（VolumeViewport, `graphy-mpr-vol:`）上での編集は本移植のスコープ外。やる場合は同 segmentationId を volume 表現でも共有（`convertStackToVolumeLabelmap`）。

### 3.3 volume 化できないシリーズ（フォールバック境界）

mosaic / multiframe / スライス間隔不整合など **volume 化不可のシリーズ**が存在する。方針:
- 可否は Cornerstone の `isValidVolume(sourceImageIds)` で判定（2 枚以上・同一 series/modality/IOP/PixelSpacing/rows/cols/FoR）。UI での事前無効化にも同関数を流用。
- **不可の場合はスライス内ツールのみ**提供（Brush(CIRCLE)/PaintFill/Threshold）。3D ツール（SphereScissors/3D region grow/球ブラシ）は UI で無効化＋理由トースト（内部でも "Volume is not reconstructable" 例外になるため二重防御）。
- → 「volume が基本、stack はフォールバック」の二層。既存 `segmentation.ts` の stack labelmap 実装はフォールバック経路として残す。

### 3.4 マスク生成は「メタデータのみ・画素ロード不要」（P1 で現状のプリロードを撤廃）

**現状の問題**: `ensureStackSegmentation`（`segmentation.ts:54`）は空マスク作成前に**全 source スライスを `loadAndCacheImage`**（wadouri=1スライス1ファイルのため、大シリーズで重い）。

**理由と誤解**: プリロードの目的は各スライスの `imagePlaneModule`（rows/cols/IPP/IOP/spacing）を Cornerstone メタデータへ登録することだけ。`createAndCacheDerivedLabelmapImage` は**メタデータのみ**を読み、空の `Uint8Array(rows*cols)` を確保する（**source 画素は一切読まない**）。= 空マスク作成に画素は不要。

**確定方針（P1）**:
1. **カスタムメタデータプロバイダ**（`metaData.addProvider`）を登録し、**backend の `SeriesLayoutDto`**（`imageOrientationPatient` / `pixelSpacingRow,Col` / `imageWidth,Height` / `zSpatial[].imagePositionPatient` = 既に fetch 済）から各 imageId の `imagePlaneModule` を供給。
   - **backend 追加（小）**: `SeriesLayoutDto` に `FrameOfReferenceUID` を追加（`isValidVolume` の FoR 一致判定用。他項目は既存）。
2. → `createAndCacheDerivedLabelmapImages` が**画素ロードゼロ**で即座に空 labelmap を生成。**Brush/消しゴムは source 画素を全く要さない**。
3. 画素を要するツール（Threshold/Wand/RegionGrow/HU 統計）だけ**対象スライスを遅延ロード**（or on-demand volume が必要分をロード）。
4. さらなる遅延化（任意）: `createAndCacheDerivedLabelmapImage(..., { skipCreateBuffer:true })` で per-slice バッファも初回ペイント時に確保（密マスクの全スライス Uint8 常駐 = rows×cols×depth を回避）。
- `roi-mask-model.md` の「バイナリ管理（選択ボクセルのみ保持）」決定と一致。空はゼロ、描いたボクセルのみ値を持つ。

---

## 4. データモデル拡張（`roiMaskStore.ts`）

現行 `RoiMaskMeta` / `RoiScope`（`label/scope/origin/patient/custom`）に**編集対象の状態**を追加。

```ts
// 追加: グローバルな編集対象（アクティブ）状態
interface SegEditTarget {
  activeSegmentationId: string | null;  // 編集対象マスク（null=未選択）
  activeSegmentIndex: number;           // 塗り先 segment index（既定 1）
}

// MaskItem を多セグメント対応に（D3）
interface SegmentDef {
  index: number;                 // Cornerstone segment index (1..N)
  meta: RoiMaskMeta;             // ラベル/説明/custom（segment 単位）
  style: { color:[number,number,number]; opacity:number; outlineWidth:number; renderFill:boolean };
  locked: boolean; visible: boolean;
}
interface MaskItem {
  id: string;                    // = Cornerstone segmentationId
  substrate: "volume" | "stack"; // D1: 既定 volume、非対応シリーズは stack
  volumeId?: string;             // substrate=volume のとき束ねる series volume
  scope: RoiScope;               // z="all"（ボリューム）が既定
  segments: SegmentDef[];        // 多セグメント
}
```

- `activeSegmentationId/Index` を `subscribe` 対象にし、パネル・Viewer が購読して**編集対象ハイライト**とブラシ結線を更新。
- 権威データは従来どおり Cornerstone（annotation state / segmentation state）。store はメタ＋アクティブ状態を保持。

---

## 5. UI 設計（D2：マネージャパネル主導・モードレス）

### 5.1 右パネル Segmentation セクション（再設計）

```
┌ ROI・マスク マネージャ ─────────────────────┐
│ ROI …（既存: 一覧/色/線幅/塗り/▦/◎/⬤/Σ/✎/🗑）      │
│ ────────────────────────────────────    │
│ Masks                              [＋新規マスク] │
│ ◉ Mask A                    ← 編集対象(◉＋太枠)   │
│   ├ ◉ #1 肝臓   ■ 40% 幅2 塗☑ 👁 🔒 ✎ 🗑  ← 活性 │
│   ├ ○ #2 腫瘍   ■ 40% …                       │
│   └ [＋セグメント]                              │
│ ○ Mask B                                      │
│   └ ◯ #1 …                                    │
│ ────────────────────────────────────    │
│ 選択: [OR][AND][XOR][Split]  [結合▾: 新規/このマスク] │
│ [SEG 書出] [SEG 取込(編集可)]  [IJ⬇][IJ⬆]         │
└──────────────────────────────────────────┘
```

- **◉（マスク行）** = そのマスクを編集対象に（`activeSegmentationId`）。太枠で強調。
- **◉（segment 行）** = アクティブ segment index（`activeSegmentIndex`）。Brush/Wand/Threshold はここへ塗る。
- **＋新規マスク** = seg volume を作成し即アクティブ（segment #1 自動）。
- **＋セグメント** = アクティブマスクに次の index を追加。
- segment 行に既存の色/不透明/幅/塗り/表示/ロック/メタ編集/削除（現 Mask 行の機能を segment 粒度へ）。
- 既存のブール演算バー・ROI→Mask・統計(Σ)・split(⬚)・球(◎/⬤)・Sphere3D セクションは温存し、**対象を segment 粒度**に合わせて微修正。

### 5.2 Tools メニュー / ツールバー

現行 Tools メニュー（Brush/Eraser）にセグメンテーションツールを追加。ツールはラジオ選択、常にアクティブマスク/segment へ作用。

| Tools メニュー | ツール | Cornerstone | コンテキスト UI（ツールバー） |
|---|---|---|---|
| Brush | 球/円ブラシ塗り | `BrushTool` FILL | ブラシ径（既存） |
| Eraser | ブラシ消去 | `BrushTool` ERASE | ブラシ径 |
| Wand (2D) | スライス内 flood fill | `PaintFillTool` | トレランス |
| Region Grow (3D) | ボリューム領域成長 | `RegionSegmentPlusTool`/growCut | トレランス/シード |
| Threshold | しきい値塗り | `RectangleROIThresholdTool`＋range | 下限/上限スライダ |
| Scissors ▾ | 矩形/円/球で fill・erase | `Rectangle/Circle/SphereScissorsTool` | fill/erase トグル |

- コンテキスト UI は現行「ブラシ径はブラシ選択時のみ表示」パターンを踏襲（`Viewer2DToolbar`）。
- **アクティブマスク未選択で塗りツールを選んだ場合** = 自動で「＋新規マスク」して即アクティブ（モードレスに直行）。トーストで通知。

### 5.3 GRAPHY メニューは廃止/読み替え

GRAPHY `Image > Segmentation`（New/Import ROIs/Save SEG/Import SEG/Stop）は**専用メニューを作らず**、次へ読み替え:

| GRAPHY メニュー項目 | Next での置き場所 |
|---|---|
| New segmentation… | パネル「＋新規マスク」 |
| Import selected ROIs into mask | パネル「結合▾」（選択 ROI をアクティブ segment へ） |
| Save as DICOM SEG | パネル「SEG 書出」 |
| Import DICOM SEG… | パネル「SEG 取込(編集可)」 |
| Stop editing | **廃止**（編集対象の◉解除で代替。永続はセッション常時） |

---

## 6. GRAPHY → Next ツール対応表（総括）

| GRAPHY | 機能 | Next 実装 | 状態 |
|---|---|---|---|
| Brush（Alt=消去） | 手描き塗り/消去 | `BrushTool` FILL/ERASE（対象を選べるよう拡張） | ✅→拡張 |
| Wand 2D（ImageJ Wand flood fill） | スライス内領域成長 | `PaintFillTool`（トレランス） | ✅ |
| Wand 3D（BFS region grow） | ボリューム領域成長 | `RegionSegmentPlusTool`/`growCut`（内部 on-demand volume） | 登録済→未結線 |
| （しきい値ダイアログ相当） | しきい値塗り | `RectangleROIThresholdTool`＋`thresholdSegmentationByRange` | 登録済→未結線 |
| （Scissors 相当なし） | 矩形/円/球で fill-erase | `Rectangle/Circle/SphereScissorsTool`（球は内部 on-demand volume） | 登録済→未結線 |
| Import selected ROIs→mask | ROI ラスタ化→結合 | 既存 `roiToMask` を「アクティブ segment へ結合」に拡張・複数選択バッチ | ◐ |
| New segmentation | 空マスク作成 | パネル「＋新規マスク」＝作成＋アクティブ | ✅ |
| Stop editing | 編集終了 | **廃止**（◉解除） | — |
| Save as DICOM SEG | SEG 書込 | backend SEG writer（読込 SegReader と対称） | ✅（`SegExportService`, `roi-mask-progress.md` S1） |
| Import DICOM SEG（編集可） | SEG→編集可マスク | backend SEG→stack labelmap 復元 | ◐（表示のみ→編集化） |
| ROI Manager: AND/OR/XOR/Split | ブール演算 | 既存 `roiBooleanOps`（segment 粒度へ） | ✅ |
| Sphere3D（パラメトリック保持） | 球 ROI 保持→焼込 | 既存 `sphere3dStore`/`roi3d`（volume へ焼込に統一） | ✅→調整 |

---

## 7. 実装フェーズ

各フェーズ末に `frontend/` で `npm run build`（green 維持）、i18n（`ja/en`）、`fw/` 反映。**実機描画確認**を各フェーズで必須（型/ビルドだけでは不十分な領域）。

| # | 内容 | 規模 | 主眼 |
|---|---|---|---|
| **P0 スパイク** ✅ | Cornerstone3D 3.33.5 の on-demand volume 機構（`EnsureSegmentationVolumeFor3DManipulation` / `getOrCreateSegmentationVolume` / `isValidVolume`）を確認。**VolumeViewport 大改修不要**を確定（§3.0）。セグメンテーション系ツール 7 種を `cornerstoneSetup.ts` に登録（ビルド green）。 | 中 | **D1 の技術リスク潰し（完了）** |
| **P1 基盤＋UX** | **メタデータプロバイダで画素プリロードを撤廃**（§3.4、backend `SeriesLayoutDto` から `imagePlaneModule`、FoR 追加）。`roiMaskStore` にアクティブ対象（`activeSegmentationId/Index`）/多セグメント追加。パネル再設計（◉編集対象・◉活性 segment・＋新規マスク・＋セグメント）。Brush/Eraser を stack labelmap のアクティブ segment へ結線（2D 円ブラシ）。`isValidVolume` でツール可否判定。 | 大 | **D2/D3 の核＋生成の即時化** |
| **P2 スライス内ツール** | Wand2D（`PaintFillTool`）＋ Threshold（`RectangleROIThreshold`＋range）。ツールバーにトレランス/range のコンテキスト UI。 | 中 | |
| **P3 3D ツール** | 球ブラシ（`BrushTool` SPHERE）＋ Scissors（矩形/円/球）＋ Region Grow（`RegionSegment(Plus)`/growCut）。内部 on-demand volume。不可シリーズは UI 無効化＋トースト。 | 大 | on-demand volume 実機確認 |
| **P4 ROI 連携/SEG 取込** | 「結合▾」= 選択 ROI をアクティブ segment へバッチ結合（既存 `roiToMask` 拡張）。DICOM SEG を**編集可 stack labelmap** として取込（現状 表示のみ）。 | 中 | |
| **P5 SEG 書出** | backend DICOM SEG writer（BINARY、`SegReader` と対称）。パネル「SEG 書出」。 | 大 | GRAPHY 保存対称性 |

- 既存資産（`roiBooleanOps`/`roi3d`/`sphere3dStore`/`globalRoiSync`/ImageJ 入出力）は温存し、**segment 粒度**へ寄せる調整のみ。
- ImageJ 関連はユーザー要件完了済（`roi-mask-progress.md` §5）。本設計では触らない。

---

## 8. 主要リスク・確認事項（P0 後・軽量ルート）

1. **3D ツールの初回コスト**: `getOrCreateSegmentationVolume` は 3D 操作の初回に labelmap imageIds から volume を同期生成（`createAndCacheVolumeFromImagesSync`）。大シリーズで初回のみ待ちが出る。source volume の事前 warm-up 検討。
2. **書込の全スライス反映確認**: volume voxel への 3D 書込が per-slice labelmap（`triggerSegmentationDataModified` の再描画）に確実に反映されるか、P3 実機で確認（スカラー共有前提）。
3. **volume 化不可シリーズ**（mosaic/multiframe/不整合）: `isValidVolume` false で 3D ツール無効化＋理由トースト（内部でも例外）。2D ツールは動く。
4. **多セグメント UI 複雑化**（D3）: アクティブ segment index の取り違え防止。パネルの◉表示と `setActiveSegmentIndex` の一貫性。
5. **メモリ/性能**: 画素プリロードは P1 で撤廃（§3.4、メタデータプロバイダ）→ **空マスク作成は即時**。残るのは密マスクの Uint8 バッファ（rows×cols×depth）常駐で、`skipCreateBuffer` の per-slice 遅延確保で軽減可。3D 操作の初回のみ on-demand volume 構築コスト。
6. **MPR 編集との将来共有**: MPR（VolumeViewport）で同 seg を編集する場合の `convertStackToVolumeLabelmap` 往復。今回スコープ外。

---

## 9. 未確定（次セッションで詰める）

- segment カラーパレット（GRAPHY は 12 色循環 `SegmentationManager.defaultColor`）を踏襲するか。
- 3D ツールのコンテキスト UI（トレランス/threshold range/scissors fill-erase トグル）の具体レイアウト。
- DICOM SEG 書出の backend 実装詳細（dcm4che、`SegReader` 対称、BINARY bit-pack）。
- ブラシの 2D 円 / 3D 球 の切替 UI（同一 Brush の strategy トグル）。
