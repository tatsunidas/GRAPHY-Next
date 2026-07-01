# ROI/Mask・2D Viewer 拡張 進捗メモ（セッション引き継ぎ）

更新: 2026-07-01。別セッションで再開するための作業状況サマリ。
関連設計: `fw/viewer-2d-menu-toolbar.md` / `fw/roi-mask-model.md` / `fw/roi-manager-design.md` / `fw/viewer-2d-screen.md`。

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
  - front: `viewer/segMetadata.ts` 新規（`registerSegMetadataProvider`＝低優先メタプロバイダ／`registerSegGeometryFromLayout`＝backend 幾何から全 imageId の `imagePlaneModule`・`generalSeriesModule` を供給、画素ロードゼロ）。`SeriesViewer` のレイアウト取得時に登録。`segmentation.ts` の `ensureStackSegmentation` は**全スライスプリロードを撤廃**し、幾何未登録の imageId のみ遅延ロード。`cornerstoneSetup` でプロバイダ登録。ビルド green。**実機未確認**（幾何あり CT/MR で初回ブラシが即時 & 全スライス塗れるか要確認。非空間シリーズは従来どおり遅延ロード）。
- ⬜ 次: `roiMaskStore` にアクティブ対象（`activeSegmentationId/Index`）/多セグメント、パネル再設計（◉編集対象・◉活性 segment・＋新規マスク・＋セグメント）、Brush/Eraser 結線、`isValidVolume` 可否判定。

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
