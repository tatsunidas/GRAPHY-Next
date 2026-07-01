# ROI/Mask・2D Viewer 拡張 進捗メモ（セッション引き継ぎ）

更新: 2026-07-01。別セッションで再開するための作業状況サマリ。
関連設計: `fw/viewer-2d-menu-toolbar.md` / `fw/roi-mask-model.md` / `fw/roi-manager-design.md` / `fw/viewer-2d-screen.md` / `fw/segmentation-tools-design.md` / `fw/dicom-seg-rtstruct-design.md` / 検証: `fw/segmentation-verification.md`。

## 📌 セッション実装サマリ（2026-07-01・このセッションの成果一覧）
すべて **build/compile green**。実機は一部確認済み（後述）。詳細は各節参照。

**セグメンテーションツール（GRAPHY→Next 移植＋UX 改良, 設計 `segmentation-tools-design.md`）**
- P0: D1 軽量ルート確定（VolumeViewport 大改修不要）。seg 系ツール登録。
- P1: モードレス化＝アクティブ編集対象（`roiMaskStore` SegEditTarget）＋多セグメント。`segmentation.ts` 再構築（`createNewMask`/`addSegmentToActiveMask`/`activateMask`/`getLastSegViewport`）。パネル再設計（◉編集対象・◉活性 segment・＋新規マスク・＋セグメント・👁表示トグル・segment 色）。`isValidVolume` でツール可否＋理由トースト（`viewer/toast.ts`）。
- **画素プリロード撤廃**（メタプロバイダ `viewer/segMetadata.ts`＝backend `SeriesLayoutDto` から imagePlaneModule 供給。imagePixelModule/generalSeriesModule も実ロード1枚から捕捉。backend `SeriesLayout` に FoR 追加）。
- Wand 刷新（`viewer/wandTool.ts`＋`wandStore.ts`＋`WandDialog.tsx`）＝**ダイアログ駆動・シード記憶・Connectivity(2D:4/8, 3D:6/8/12/26)・Threshold スライダー＋手入力・動的 Update**。2D=面内/3D=ボリューム。旧 wand2d.ts 削除。
- Split 改良（連結性 6/18/26 可変・既定26、元マスクを置換）。OR/MERGE を **MERGE(OR)** に統一。
- Settings に **ROI・マスク**（マスク塗り不透明度・線幅）＋**計測 ROI**（既定色=color 型追加・線幅）。`applyGlobalLabelmapStyle`/`applyGlobalAnnotationStyle`。
- 実機修正: 2D Viewer 開直後の縦長（ResizeObserver 初回フィット）、per-tile ✋ が ROI 解除しない→トースト、Split 後 Eraser 効かない（active 対象判定緩和）、+新規マスク後に塗れない（activateMask に viewportId 明示）、多数。ROI 可視トグルを Mask と同じ 👁 に統一。

**DICOM 永続化（設計 `dicom-seg-rtstruct-design.md`）**
- S1: マスク→**DICOM SEG**（`export/SegExport*`＋`viewer/segExport.ts`）。**dense（全スライス, Fusion 整合）**。読込は既存で往復。
- S2/S3: 2D ROI→**RTSTRUCT** 書込＋読込往復（`export/RtStruct*`＋`viewer/rtstruct{Export,Import}.ts`）。`/api/dicom/{seg,rtstruct}`。
- 生成後の 2D Viewer 検索ツリー自動更新（`viewer/viewerRefresh.ts`）。
- 🐛 **ImageJ ブリッジ起動失敗を修正**: Spring Boot が `java.awt.headless=true` を強制し `GraphicsEnvironment.isHeadless()` が常に true→ImageJ 起動不可だった。`GraphyNextApplication.main` で **ディスプレイ有無に応じ `app.setHeadless(!hasDisplay())`**（Linux は DISPLAY/WAYLAND、mac/win は true）。**要 backend 再起動**。

**実機確認済**: プリロード撤廃で Brush 即時・全スライス塗り／Wand 2D・3D／Split(26)／SEG 書出＋読込（Fusion 整合）／RTSTRUCT 書込＋読込往復。**未確認**: ImageJ headless 修正（再起動後）、細部。


## ★次セッションの主題: セグメンテーションツール
**設計確定: `fw/segmentation-tools-design.md`（2026-07-01）。** GRAPHY「Image>Segmentation」を Next へ移植＋UX 改良。
**確定判断**: D1=**軽量ルート**（P0 完了）。当初の VolumeViewport 大改修は**不要**と判明＝Cornerstone3D 3.33.5 は
stack labelmap から on-demand で volume 化して 3D ツール（SphereScissors/growCut/region grow/球ブラシ）を動かす
（`EnsureSegmentationVolumeFor3DManipulation`／`isValidVolume` 不可なら 2D フォールバック）。**既存 stack 基盤・StackViewport のまま**進む。／
D2=**マネージャ右パネル主導・モードレス**（＋新規マスク=即編集対象、◉で編集対象＆活性 segment を常時可視化、GRAPHY の New/Stop 廃止）／
D3=**1 マスクに複数 segment**。
**P0 完了**: セグメンテーション系ツール 7 種（`PaintFill/RegionSegment/RegionSegmentPlus/Rectangle・Circle・SphereScissors/RectangleROIThreshold`）を
`viewer/cornerstoneSetup.ts` に登録済（ビルド green）。次は **P1(基盤+UX)**→P2(Wand2D/Threshold)→P3(3D ツール)→P4(ROI 結合/SEG 取込)→P5(SEG 書出)。詳細は設計書参照。

**P1 進行中**:
- ✅ **画素プリロード撤廃（メタデータプロバイダ）** — labelmap 生成に source 画素は不要（`createAndCacheDerivedImage` は `imagePlaneModule` のみ読む）。
  - backend: `SeriesLayout` record に `frameOfReferenceUID` 追加＋3 経路（通常/mosaic/seg）の constructor と `noSpatial` を更新（`SeriesLayout.java`, `DicomStorageService.java`）。compile＋`SeriesLayoutBuilderTest` green。
  - front: `viewer/segMetadata.ts` 新規（`registerSegMetadataProvider`＝低優先メタプロバイダ／`registerSegGeometryFromLayout`＝backend 幾何から全 imageId の `imagePlaneModule`・`generalSeriesModule` を供給、画素ロードゼロ）。
  - 🐛 **実機修正（群A検証で発覚）**: 未ロードのスライスへスクロールすると seg の `imageChangeEventListener`→`buildMetadata` が `imagePixelModule.pixelRepresentation` を読めず `Cannot destructure ... undefined` でクラッシュ（従来はプリロードで全スライス登録済みだった）。→ プロバイダに **`imagePixelModule` 供給**を追加（シリーズ均一なのでロード済み1枚から捕捉し全スライスへ、優先度-1・再入ガード `capturing`）。`imageIdsBySeriesUid`／`pixelModuleBySeriesUid`／`capturePixelModule`。**実機で塗れること確認済**。
  - ⚠️ **「数枚塗ると急にBrush無反応（ログ無し）」**を1度観測 → **フル再読込で解消**（機能修正はせず診断のみ追加）。原因は HMR 由来の古いモジュール状態（連続編集での二重登録等）がフル再読込でクリアされた可能性が高い。恒久修正は未。**再発時**は Console で `__graphySegDebug()`（`viewer/segDebug.ts`、`cornerstoneSetup` で `installSegDebug`）を実行し `activeSegHasRepresentationHere`/`activeSegmentColor`/`store_ vs cs_ activeSegmentation` を確認。根因は `getSegmentIndexColor` が null（=その viewport にアクティブ seg の representation が無い）→ `getOperationData` が無言 return。**検証完了後に segDebug は削除**。`SeriesViewer` のレイアウト取得時に登録。`segmentation.ts` の `ensureStackSegmentation` は**全スライスプリロードを撤廃**し、幾何未登録の imageId のみ遅延ロード。`cornerstoneSetup` でプロバイダ登録。ビルド green。**実機未確認**（幾何あり CT/MR で初回ブラシが即時 & 全スライス塗れるか要確認。非空間シリーズは従来どおり遅延ロード）。
- ✅ **3D Wand（P3 前倒し, ユーザー要望=3D-ROI 検証用）** — `RegionSegmentPlusTool`（ワンクリック growCut 領域成長。GRAPHY 3D Wand 相当）を結線。
  - `toolIds.ts` に `region3d`、`Viewer2D.tsx` の `PRIMARY_TOOLS`＋`wireTools`（passive 追加）＋`setActiveTool`（brush 同様 `ensureStackSegmentation` 後 Primary 割当）。Tools メニューに「3D Wand（領域成長）」、i18n(ja/en)。
  - 挙動: クリック1点をシードに growCut で 3D 拡張（島除去自動）。内部で source を on-demand volume 化（`getLabelmapSegmentationData`→`getOrCreateImageVolume`、`isValidVolume` 前提、斜位は非対応）。= P0「stack labelmap＋on-demand volume」の実地検証パス。**実機未確認**。
- ✅ **P1 本体: アクティブ対象＋多セグメント＋パネル再設計（モードレス化 D2/D3）** — **フロント build green**（Slicer の並行編集も解消済み）。
  - `roiMaskStore.ts`: `SegEditTarget`（`segmentationId`/`segmentIndex`）＋ getter/setter（`getSegEditTarget`/`setActiveSegmentationId`/`setActiveSegmentIndexStore`）。多セグメント（`RoiMaskMeta.segments:number[]`＋`getMaskSegments`/`addMaskSegment`）。
  - `segmentation.ts`: 再構築。viewport+stack ごとに複数マスク（`byViewport`＝stackKey＋segIds[]）。`ensureStackSegmentation`＝**アクティブ対象を保証**（既存アクティブがこのスタックにあれば再活性、無ければ先頭 or 新規作成）。`createNewMask`（明示新規＋アクティブ化）、`addSegmentToActiveMask`（次 index 追加）、`activateMask`（CS active＋ストア同期）、`getLastSegViewport`（パネルの新規マスク用）。Brush/Eraser/3D Wand は全て**アクティブ (mask, segment) へ塗る**。
  - `RoiManagerPanel.tsx`: Masks 見出しに **＋新規マスク**、各マスク行に **◉編集対象ラジオ＋青ハイライト**、アクティブマスクに **segment チップ列（クリックで活性 index 切替）＋＋セグメント**。i18n(ja/en)。
  - **実機未確認**（◉で対象切替→Brush が切替先に塗るか、＋新規マスク／＋セグメント、多セグメント塗り分け）。
- ✅ **P1 残 完了**（build green・実機未確認）:
  - **`isValidVolume` によるツール可否**: `Viewer2D.setActiveTool` で 3D Wand 選択時に `core.utilities.isValidVolume(imageIds)` を判定し、不可なら activation を弾いて理由トースト。トースト機構は `viewer/toast.ts`（emit/subscribe）新規＋`Viewer2DScreen` が購読表示。i18n `viewer2d.tool.needVolume`。
  - **segment 単位の色**: `RoiManagerPanel.setMaskColor` が **アクティブ segment** を対象に色設定（非アクティブは #1）。segment チップに現在色（左ボーダー）を表示、アクティブマスク行に **アクティブ segment 用カラーピッカー**追加（`segColorHex`＝`getSegmentIndexColor`）。
  - **フォーカス中タイル追跡**: `segmentation.noteSegViewport` を base ビューポートの `pointerdown` で呼び、`＋新規マスク` の対象を「直近クリックしたタイル」に。

**P2: Wand 2D/3D**
- **Cornerstone3D の region grow 調査（確定）**: growCut ベースの `RegionSegmentTool`（矩形→成長）/`RegionSegmentPlusTool`（1クリック→成長）が **region grow 本体**だが **3D 専用**（近傍探索に z を含む）。`PaintFillTool` は **labelmap の bucket fill**（輝度非依存）で 2D 輝度 Wand には不適。→ **2D 単一スライスの輝度 Wand は Cornerstone 既製に無い**。
- ✅ **3D Wand** = `RegionSegmentPlusTool`（P1 で結線済み）。
- ✅ **2D Wand（自作）** = `viewer/wand2d.ts` `Wand2DTool`（`BaseTool` 継承）。`preMouseDownCallback` でクリック地点をシードに、現在スライスの **source 画素輝度**が「シード値±トレランス」に収まる連結画素を `utilities.segmentation.floodFill`（PaintFill と同探索器、`equals(node,seed)`）で 2D 走査 → アクティブ (mask, segment) の labelmap（`getLabelmapImageIds`→voxelManager.setAtIndex, index=y*cols+x）へ書込 → `triggerSegmentationDataModified`。GRAPHY 2D Wand(ImageJ Wand) 相当。
  - 結線: `cornerstoneSetup`(addTool)、`toolIds.wand2d`、`Viewer2D`（PRIMARY_TOOLS＋wireTools＋setActiveTool は brush 同様 `ensureStackSegmentation` 後 Primary、`setWandTolerance` コマンド）、`viewerCommands`/`Viewer2DScreen`/`Viewer2DToolbar`（🪄 トレランス入力、wand2d 選択時のみ表示、既定 50）、Tools メニュー「2D Wand（輝度領域成長）」、i18n。**ビルド green、実機未確認**。

Cornerstone3D のセグメンテーション系ツール（stack/volume labelmap 編集）を拡充する。現状は `BrushTool`（球ブラシ）
＋消しゴムのみ。**利用可能な内蔵ツール**（`@cornerstonejs/tools`、調査済）:
- **Scissors 系**: `RectangleScissorsTool` / `CircleScissorsTool` / `SphereScissorsTool`（3D 球で fill/erase。※ volume labelmap 前提＝`ensureSegmentationVolume` で stack→volume 化が要る）。
- **しきい値/領域成長**: `RectangleROIThresholdTool` / `RectangleROIStartEndThresholdTool` / `CircleROIStartEndThresholdTool`、`PaintFillTool`（塗りつぶし）、`growCut`、`thresholdSegmentationByRange`。
- **輪郭→labelmap**: `LabelmapEditWithContour`、`contourSegmentation`。
- **補助**: `IslandRemoval`（島除去）、`getStatistics`、`SegmentSelectTool`/`SegmentLabelTool`/`SegmentBidirectionalTool`。
- 既存基盤: `viewer/segmentation.ts`（`ensureStackSegmentation`）、`roiMaskStore`、`RoiManagerPanel`、`roiBooleanOps`/`roi3d`（ラスタ演算・体積統計）を土台に、UI は 2D Viewer の ROI メニュー＋ツールバー＋マネージャに追加していく。
- 検討: stack 編集（現状）中心か、3D 操作時に一時 volume 化するか（`roi-mask-model.md` §確認事項 2）。SphereScissors 等は volume が要るため、VolumeViewport or on-demand volume 化の方針決めが最初の分岐。

## ビルド/検証
- フロント: `cd frontend && npm run build`（`tsc -b && vite build`）。**現在 green**。
  - ⚠️ リポジトリ**ルートで `npm run build` を実行すると Maven が走りエラー**になる。必ず `frontend/` で実行。
- バックエンド: `cd backend && mvn -q -o compile -Dfrontend.skip=true`。
- ⚠️ 多くの新機能（セグメンテーション/ブラシ/マスク色/注釈スタイル）は**実機(描画)確認が未実施**。型/ビルドのみ green。

## 完了済み（このワークストリーム）
1. **シリーズ Sync**: スライス位置（座標=IPP 法線投影±margin / 単純=Δ）、表示状態（自前 presentation sync で zoom/pan/回転/反転）、**W/L 相対同期**（baseline+ΔWC/ΔWW）、Invert/LUT は直接ブロードキャスト。`viewer/sync.ts` `viewer/sliceSync.ts`。
2. **リファレンスライン**: 自前 SVG（core 幾何流用）。all-to-all・ZCT 追従。`viewer/referenceLines.ts`。
3. **2D Viewer メニュー/ツールバー**（Phase A/B/C）: `viewer2d/Viewer2DMenuBar.tsx` `Viewer2DToolbar.tsx` `viewer/viewerCommands.ts` `viewer/toolIds.ts`。
   - 対象モデル=「選択タイル→無ければ全」。per-tile ツールバーは温存。
   - 画像一括（Invert/LUT/回転/反転/Fit/Reset/Undo/Redo）、**W/L プリセット**（`wlPresets.ts`）、操作ツール(W/L/Pan/Zoom)ラジオ、**計測ツール**（ROI メニュー: Length/Angle/Ellipse/Rect/Probe、Clear=確認ダイアログ、個別削除=ROI クリック選択→Delete）。
   - 近日対応メニュー: 3D/MPR/Slicer, Sort, 解析(Histogram/ImageJ), プラグイン（トースト）。
4. **ROI ブラシ/消しゴム**（segmentation labelmap）: `viewer/segmentation.ts`（`ensureStackSegmentation`=全 source プリロード→`createAndCacheDerivedLabelmapImages`→addSegmentations→representation→active segment）。BrushTool, FILL/ERASE, ブラシ径。**実機で塗れることはユーザー確認済み**。
5. **ROI マネージャ（右サイドパネル, M1+M2 一部）**: `viewer2d/RoiManagerPanel.tsx`。
   - ROI/Mask 一覧、表示/非表示、削除、**色/線幅/塗り**、マスク不透明度、**マスク色**（getViewportIdsWithSegmentation+setSegmentIndexColor）、**ラベル/メタ編集**（`viewer/roiMaskStore.ts`）。
   - **患者単位フィルタ＋ZCT スコープ表示**（`viewer/viewerContext.ts` で作成時 patient/series/zct を捕捉。ROI=ANNOTATION_COMPLETED、Mask=ensureStackSegmentation で `roiMaskStore` に紐付け）。
   - **scope の Z global/local トグル**（チップクリック。`origin` で原本 index 復元）。
   - **属性編集ダイアログ（M2 完了）**: `viewer2d/RoiMetaEditDialog.tsx`。ラベル/説明/**ZCT scope を z・c・t 各次元で local(index)↔global("all") 編集**（`origin` で local 既定値復元）/カスタム属性(key-value)。各行の ✎ ボタンで起動。ビルド green。
   - **global ROI のライブ全スライス描画（実装）**: `viewer/globalRoiSync.ts`。Cornerstone stack は `referencedImageId===currentImageId` 完全一致でのみ annotation を描画するため、scope.z="all" の注釈はスライス/チャンネル変更時に `referencedImageId` を**現在 imageId へ追従**させ全スライス可視化。local 復元（z=index）/ c,t="all" 投影も対応。`Viewer2D` の slice 変更 effect＋store 購読＋マウント時に `reconcileGlobalAnnotations` を呼ぶ（`compact`/`syncGroupId` は対象外）。ビルド green、**実機未確認**。
     - ⚠️ 既知の限界: annotation は単一実体を「現在スライスへ追従」させる方式のため、**同一シリーズを別スライスで同時表示する複数ビューポートでの全スライス同時描画は不可**（要 per-imageId 複製。将来課題）。
6. **M3 ブール演算（実装）**: `viewer/roiBooleanOps.ts` ＋ `RoiManagerPanel` の選択チェック＋演算バー。
   - **OR/AND/XOR/マージ(=OR)**: 選択 2 件以上の Mask を labelmap ラスタのまま合成（前景=非ゼロ。and=全件、xor=前景数の奇偶）→ **新規 Mask（segment 1）**。
   - **SPLIT**: 単一 Mask を **3D 6 近傍連結成分**（明示スタック flood fill）でラベリング→成分ごと segment index(1..N, 上限 64)の新規 Mask。
   - 共通: `getLabelmapImageIds`→cache image の `voxelManager`(getAtIndex/setAtIndex) で読み書き、`createAndCacheDerivedLabelmapImages` で結果生成、`triggerSegmentationDataModified` で反映。source(referencedImageId)列が一致＝同一スタックの Mask のみ可（不一致は失敗トースト）。メタ(patient/series/scope)は入力から継承。ビルド green、**実機未確認**。
   - **ROI→Mask ラスタ化（M3 残り①）**: `roiToMask(uid)`。エリア型 ROI（楕円/円/矩形/フリーハンド=`isAreaRoi`）を作成スライスへラスタ化し新規 Mask 化（→以後 Mask 演算の対象に）。`worldToImageCoords`([x列,y行]、imageToWorldCoords の逆で確認)で world→画素。楕円/円=形状式、矩形=bbox 塗り、フリーハンド=`data.contour.polyline` を多角形塗り（レイキャスト）。source スタック/cols/rows は ROI 表示中の stack viewport(`getRenderingEngines`)から解決。各エリア ROI 行の **▦ ボタン**で実行。ビルド green、**実機未確認**。
7. **M4 3D（一部, GRAPHY 整合）**: `viewer/roi3d.ts`。
   - **方針確認: GRAPHY の 3D ROI は Next に素直に対応**。FreeFormRoi3D（`Map<z,long[]>` ビットパック 3D バイナリ）= **既存の Mask（labelmap, scope.z="all"）がそのまま相当**（`roi-mask-model.md` の「バイナリ管理/3D=ボリューム」決定どおり）。SphereRoi3D（中心 IPP+半径 mm）= **パラメトリック→labelmap ラスタ化**で対応。
   - **SphereRoi3D 相当（実装）**: `sphereFromCircleRoi(uid)`。円 ROI（中心 world=handle0, 半径=|handle1−handle0| mm）を **3D 球**としてボリューム labelmap にラスタ化（各スライス平面と球の交差円 √(r²−d²) を塗る。d=球中心〜スライス平面の法線距離、平面幾何は `imagePlaneModule` の IPP/IOP/spacing）。円 ROI 行の **⬤ ボタン**。異方性 spacing 対応。
   - **体積統計（実装）**: `maskVolumeStats(segId)`＝前景ボクセル数×ボクセル体積（row×col×slice 間隔。slice 間隔=隣接 IPP の法線距離→無ければ sliceThickness）＋**HU 統計**（source 画素×slope+intercept で mean/SD/min/max。CT は単位 HU）。Mask 行の **Σ ボタン**でインライン表示。
   - **3D→2D split（実装）**: `splitMaskToSlices(segId)`。ボリューム Mask を**非空スライスごとの単一スライス Mask**（source 1 枚から派生する軽量 labelmap、scope.z=index）に分解（上限 64）。Mask 行の **⬚ ボタン**。
   - **2D→3D 積層**: 単一スライス Mask 群の **OR マージ（M3 の Merge）で実現可**（結果は全スライス充填のボリューム）。専用ボタンは冗長のため未追加。ビルド green、**実機未確認**。
   - **パラメトリック 3D 球（SphereRoi3D 完全相当, 実装）**: `viewer/sphere3dStore.ts`（中心 world+半径 mm+C/T を**非破壊保持**, subscribe）＋ `roi3d.ts` の `createSphere3DFromCircleRoi`/`bakeSphere3D`/`rasterizeSphereToMask`。
     - **全スライスライブ断面円プレビュー**: `sphereCanvasCircle`(断面半径 √(r²−d²)、`worldToCanvas` で zoom/pan/回転追従)を `Viewer2D` の SVG オーバーレイに描画（camera/slice/store/mount で再計算、`compact`/`syncGroupId` 除外）。
     - パネル: 円 ROI 行の **◎ ボタン**でパラメトリック球を定義（保持）、**⬤**で即 Mask 焼き込み。**「3D 球」セクション**で表示/ラベル/色/**半径 mm 編集（即プレビュー更新）**/**Mask 焼き込み(⬤)**/削除。GRAPHY の「パラメトリック保持＋マスク変換」を再現。ビルド green、**実機未確認**。
8. **M5 保存＝ImageJ（最優先, Export 実装）**: backend `com.vis.graphynext.imagej`（**ij.jar=net.imagej:ij:1.54p** を pom＋SciJava リポジトリ追加）。
   - `ImageJRoiService`: DTO(画素座標)↔`ij.gui.Roi` を `RoiEncoder.saveAsByteArray`/`RoiDecoder` で相互変換。`encodeRoiSet`(→`RoiSet.zip`, 名前重複は連番)/`encodeSingle`(→`.roi`)/`decode`(.roi/.zip)。`ImageJController`: `POST /api/imagej/roiset`(Export zip)・`POST /api/imagej/import`(.roi/.zip→DTO)。
   - フロント: `viewer/imagejExport.ts`＝Cornerstone アノテーション(world)→DTO(画素、`worldToImageCoords`)。tool→IJ 種別マップ（楕円/円=oval, 矩形=rect, freehand, length/line=polyline, angle, probe=point, その他 polygon）。`api.ts` に `exportImageJRoiSet`/`importImageJRoiSet`。ROI セクション見出しの **「IJ ⬇」ボタン**で全 ROI を RoiSet.zip ダウンロード。
   - **backend テスト green**（`ImageJRoiServiceTest` 4 件: polygon/oval/rect/single/重複名の往復）。フロントビルド green。**実機未確認**。
9. **ImageJ 要件（ユーザ確定=リッチ不要）**: ①ROI を .roi/RoiSet.zip 出力 ②表示中シリーズを HyperStack で ImagePlus にブリッジ ③IJ ROI を Next ROI に Import。**3 点とも実装済**。
   - **HyperStack ブリッジ（実装）**: backend `ImageJBridgeService`＋`POST /api/imagej/bridge`。`SeriesLayout`(Z×C×T)順で `ImagePlus`（`setDimensions(nC,nZ,nT)`＋`setOpenAsHyperStack`）を組み、pixelSpacing をキャリブレーションし **ローカル ImageJ（`new ImageJ(STANDALONE)`＋`imp.show()`）** に表示。ピクセルは ImageJ `Opener` で DICOM を開く（mosaic/multiframe=`frameDicom`→一時ファイル）。**headless は 409**。フロント: `api.bridgeImageJHyperStack`、2D Viewer の **解析メニュー「ImageJ…」**＝対象（選択→先頭）タイルのシリーズをブリッジ（結果トースト）。
   - **ROI Import（実装）**: backend `/api/imagej/import`(.roi/.zip→DTO)＋フロント `viewer/imagejImport.ts`＝DTO(画素)→`imageToWorldCoords`→**Cornerstone アノテーション再構築**（oval→EllipticalROI, rect→RectangleROI, polygon/freehand/polyline→**PlanarFreehandROI**（閉/開輪郭））。position→スライス、`roiMaskStore` にメタ紐付け。**`PlanarFreehandROITool` をグローバル/ツールグループに追加登録**（描画の受け皿、メニュー非公開）。ROI マネージャ見出しの **「IJ ⬆」ボタン**（.roi/.zip 選択）。
   - **ROI Export**: 前項 M5（「IJ ⬇」）。backend compile green・フロントビルド green。**実機未確認**。

## 決定事項（確定）
- マスクは **GRAPHY 同様バイナリ管理**（ランタイム=Cornerstone labelmap、保存=DICOM SEG BINARY と対称）。3D=ボリュームバイナリ。
- ROI マネージャ=**右サイドパネル常設**。ブール演算/マージ出力=**Mask(ラスタ)統一**。
- 保存優先=**ImageJ ROI(.roi/RoiSet.zip) 最優先** → DICOM SEG → RTSTRUCT → JSON/CSV。
- **ImageJ ブリッジ=backend(Java) が ij.jar を埋め込み/起動**、hyperStack をブリッジ（DB 非同期）。

## 次の一手（未着手）
1. **global ROI 全スライス描画の複数ビューポート対応**（単一ビューポートは実装済）。同一シリーズを別スライスで同時表示する全ビューポートに同時描画するには、annotation の per-imageId 複製（または Mask 同様 FoR ボリューム化）が必要。あわせて **global Mask（z="all"）の全スライス labelmap 化**も検討。
2. **M3 残り**: ① ROI→Mask は実装済（▦）。② AND/合成結果が**空のときの通知**（現状は空 Mask を生成）。③ 結果 Mask の**輪郭化**（kind:"shape" ベクタ復帰, 任意）。④ ラスタ化の **scope.z="all" 対応**（現状は作成スライスのみ。全スライス投影は未対応）。
3. **M4 3D 残り**: ① **インタラクティブ球定義ツール**（現状は円 ROI 経由の間接定義。ビューポート上で中心ドラッグ＋半径ハンドルの直接作成/リサイズは未。移動/半径ドラッグ編集も未＝現状は数値のみ）。② 2D→3D の**補間オプション**（スライス間の欠損補間）。③ SPLIT/球/Mask の **3D 表示**（VolumeViewport/Surface 連携）。④ **FreeForm3D 相当のパラメトリック保持**（現状 Mask=labelmap で保持。球のような非破壊パラメトリック freeform は未＝labelmap 直編集）。※ ライブ球プレビュー・3D→2D split・2D→3D 積層(OR)・体積/HU 統計は実装済。
4. **M5/保存 残り（任意）**: ① **Mask→ImageJ**（labelmap 輪郭トレース→polygon ROI、or ImageJ ラベル画像）。② **DICOM SEG 書込**（読込は実装済 `DicomStorageService.segLayoutIfApplicable`/`multiFrameDicom` と対称）。③ RTSTRUCT・JSON/CSV。※ ROI Import(.roi/.zip→Cornerstone) はユーザ要件として**完了**。
   - **設計: `fw/dicom-seg-rtstruct-design.md`（2026-07-01）** — DICOM SEG（マスク＝BINARY）＋ RTSTRUCT（2D ベクタ ROI）の書き出し。dcm4che 5.34.3、`/api/dicom/seg`・`/api/dicom/rtstruct`、参照シリーズ幾何/FoR 継承、DB 取込→新シリーズ。
   - ✅ **S1: マスク→DICOM SEG 書込 実装済（2026-07-01, GRAPHY SegWriter 移植）**。
     - backend `com.vis.graphynext.dicom.export`: `SegExportRequest`（DTO: 参照 study/series・rows/cols・IOP・pixelSpacing[row,col]・FoR・segments[{number,label,color,frames[{sop,ipp,mask=Base64 0/1}]}）／`SegExportService`（BINARY SEG 生成: SegmentSequence＋RecommendedDisplayCIELabValue(RGB→CIELab)＋Shared(PlaneOrientation/PixelMeasures)＋PerFrame(FrameContent/PlanePosition/SegmentIdentification/DerivationImage)＋DimensionOrganization/Index＋**LSB-first ビットパック PixelData**＋ReferencedSeries、患者/検査を参照ヘッダから継承、`storage.ingest`）／`DicomExportController` `POST /api/dicom/seg`。**compile green**。
     - front `viewer/segExport.ts`（`exportMaskAsSeg`＝labelmap 各 segment の非空スライスを 0/1 平面→Base64、referencedImageId から source の SOP/IPP/幾何を解決）／`api.ts` `exportDicomSeg`＋型／`RoiManagerPanel` 各マスク行 **SEG ボタン**＋トースト／i18n。**build green、実機未確認**。読込は既存 `segLayoutIfApplicable` で往復。
   - ✅ **SEG は dense（全スライス分フレーム）を既定**に変更（2026-07-01, ユーザー指摘）。sparse（非空のみ）だと `segLayoutIfApplicable` の nZ が減り **Fusion 重ね合わせがズレる**ため。`segExport.ts` は幾何が引ける全 z を frame 化（マスク無しは全0平面）。設計 `dicom-seg-rtstruct-design.md` §3.1'。
   - ✅ **SEG 作成後に 2D Viewer 検索ツリーを自動再取得**（`viewer/viewerRefresh.ts` emit/subscribe、`Viewer2DScreen` の TreePanel が再検索＋StudyNode 再マウント）。
   - ✅ **S2: ROI→RTSTRUCT 書込 実装済（2026-07-01）**。
     - backend `RtStructExportRequest`／`RtStructExportService`（StructureSetROI＋ROIContour[ContourGeometricType=CLOSED_PLANAR, ContourData=患者座標 mm]＋RTROIObservations＋ReferencedFrameOfReference→RTReferencedStudy/Series/ContourImage、患者/検査継承、`storage.ingest`）／`DicomExportController` `POST /api/dicom/rtstruct`。**compile green**。
     - front `viewer/rtstructExport.ts`（面積型 ROI のみ: 楕円/円=ポリゴン近似、矩形=4隅角度ソート、freehand=polyline。world 3D 点列を flatten）／`api.ts` `exportDicomRtStruct`＋型／`RoiManagerPanel` ROI 見出しの **RT ⬇ ボタン**＋トースト＋ツリー再取得／i18n。**build green、実機未確認**。
   - ✅ **S3: RTSTRUCT 読込→ROI 復元 実装済（2026-07-01）**。
     - backend `RtStructRoiDto`／`RtStructReadService`（StructureSetROI/ROIContour/RTROIObservations を解析→ROI名/色/種別/輪郭[refSOP＋患者座標 mm]）／`DicomExportController` `GET /api/dicom/rtstruct?study&series`。compile green。
     - front `viewer/rtstructImport.ts`（`importRtStructForCurrentView`＝表示中スタディの RTSTRUCT シリーズ[modality=RTSTRUCT]を全読み込み→表示中 source シリーズへ **PlanarFreehandROI(closed)** 復元。輪郭は既に world 座標。スライスは ContourImage の refSOP を表示中スタックの imageId に対応付け。色は `setAnnotationStyles`）／`api.ts` `readDicomRtStruct`＋型／`RoiManagerPanel` ROI 見出しの **RT ⬆ ボタン**＋トースト。**build green、実機未確認**。
     - → **RTSTRUCT 往復（S2 書込＋S3 読込）完成**。SEG は書込(S1 dense)＋既存読込で往復済み。
   - ⬜ S4: GSPS / DICOM SR（線/角度/点 ROI 用, 任意）。未実装。
5. **ImageJ**: ✅ **ユーザ要件（①ROI .roi/.zip 入出力 ②HyperStack ブリッジ ③IJ ROI Import）3 点とも完了。これ以上の深掘り不要**（確定）。残は任意: Mask→ImageJ ラベル画像、ブリッジ編集 ROI の Next 往復。

## このワークストリームで追加した主なファイル（オリエンテーション用）
フロント（`frontend/src/`）:
- `viewer/roiMaskStore.ts` … ROI/Mask のアプリ側メタ（label/scope/patient/custom）。
- `viewer/viewerContext.ts` … viewport→患者/シリーズ/現在 ZCT 捕捉。
- `viewer/globalRoiSync.ts` … global(scope.z="all") ROI の現在スライス追従描画。
- `viewer/roiBooleanOps.ts` … OR/AND/XOR/SPLIT、ROI→Mask ラスタ化、`createResultSeg`/`resolveRoiStack`（共有）。
- `viewer/roi3d.ts` … 球→Mask ラスタ化、3D→2D split、体積/HU 統計。
- `viewer/sphere3dStore.ts` … パラメトリック 3D 球ストア＋断面円幾何。
- `viewer/imagejExport.ts` / `viewer/imagejImport.ts` … Cornerstone アノテーション ↔ ImageJ DTO。
- `viewer2d/RoiManagerPanel.tsx` / `viewer2d/RoiMetaEditDialog.tsx` … 右パネル UI。
- 既存改変: `viewer/Viewer2D.tsx`（球プレビュー/global 追従/PlanarFreehand 登録）、`viewer/cornerstoneSetup.ts`、`viewer2d/Viewer2DScreen.tsx`/`Viewer2DMenuBar.tsx`/`Viewer2DToolbar.tsx`、`api.ts`、`i18n/{ja,en}.ts`。
バックエンド（`backend/src/main/java/com/vis/graphynext/imagej/`）:
- `ImageJRoiDto` / `ImageJRoiService` / `ImageJBridgeService` / `ImageJController`、テスト `imagej/ImageJRoiServiceTest`。pom に `net.imagej:ij:1.54p`＋SciJava repo。

## 実機確認 TODO（未実施。features は型/ビルドのみ green）
- ROI マネージャ: マスク色/不透明度/線幅/塗り、ROI 色/線幅/塗り、ラベル保持、患者フィルタ、ZCT チップ＆Z トグル、✎ メタ編集ダイアログ。
- ブラシ/消しゴム/計測の描画と削除（Delete キー個別削除、Clear 確認）。
- **M3**: OR/AND/XOR/マージ/SPLIT の結果 Mask、ROI→Mask(▦)。
- **M4**: 円→球(⬤/◎)、**球断面円ライブプレビュー**（zoom/pan/回転/スライス追従）、半径 mm 編集の即反映、体積/HU 統計(Σ)、3D→2D split(⬚)。
- **global ROI**: scope.z="all" にした ROI が全スライスに追従表示されるか。
- **ImageJ**: 「IJ ⬇」Export→ImageJ で開けるか、「IJ ⬆」Import→ROI 復元、解析メニュー「ImageJ…」で HyperStack がローカル ImageJ に開くか（**要デスクトップ表示環境。headless 不可**）。

## 注意・既知
- React StrictMode は無効のまま（再導入不可）。`main.tsx` 変更時は Vite 完全再起動。
- セグメンテーションの初回ブラシ起動は全スライスをプリロードするため大シリーズで重い。**→ P1 で撤廃予定**: 空マスク作成に source 画素は不要（`createAndCacheDerivedLabelmapImage` は `imagePlaneModule` メタのみ読む）。backend `SeriesLayoutDto`（IOP/spacing/rows/cols/per-Z IPP、要 FoR 追加）から `metaData.addProvider` で `imagePlaneModule` を供給し画素ロードゼロで即時生成。詳細 `segmentation-tools-design.md` §3.4。
- QRScreen は別作業者が編集中。エラーを見ても触らない。
- 座標規約: `worldToImageCoords(imageId,[x,y,z])` は **[x=列, y=行]** を返す（`imageToWorldCoords` の逆算で確認済）。labelmap index = y*cols + x。
- ビルド: フロントは必ず `frontend/` で `npm run build`（ルートだと Maven が走る）。backend は `backend/` で `mvn -q -o compile -Dfrontend.skip=true`、テストは `-Dtest=ImageJRoiServiceTest`。
</content>
