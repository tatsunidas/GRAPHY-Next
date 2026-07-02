# 3D Viewer 並行開発ワークログ（インスタンス間コーディネーション）

> 2 台の Claude が並行で 3D Viewer を実装中。**編集前にこのファイルで担当レーンとホットファイルを確認すること。**
> 共有ファイル（`scene3d.ts` / `scene3dStore.ts` / `SceneObjectPanel.tsx` / `Viewer3DScreen.tsx` / `i18n/{en,ja}.ts`）は
> **追記中心・関数単位で分離**し、既存ブロックの書き換えを避ける。編集直前に `git diff`/mtime で相手の変更を確認。

## レーン割当（2026-07-02）

### インスタンス A — 3D 計測（§15 項目3）
- 所有ファイル（新規）: `viewer3d/measure3d.ts`, `viewer3d/measureStore.ts`, `viewer3d/Viewer3DMeasureOverlay.tsx`
- 共有ファイル編集: `viewer3d/scene3d.ts`（ピッキング）, `viewer3d/SceneObjectPanel.tsx`（計測ボタン）, `i18n`
- 状態: 作業中（〜17:50 に活発に編集）

### インスタンス B（このセッション）— 中心線解析の拡充 + CPR/ストレート化（§15 項目4, 5）
- 所有ファイル（新規予定）:
  - `viewer3d/CenterlineDialog.tsx` — 全グラフ overlay・分枝リスト選択・2ノード間最短路・CPR/ストレート化ボタン
  - `viewer3d/centerlineScene.ts` — 中心線グラフ overlay アクター管理（分枝 polyline＋ノード glyph）。scene3d.ts への侵襲を避けるため独立モジュール化
  - `viewer/straightenedVolume.ts` — 中心線ストレート化 3D（`StraightenedVolumeBuilder` 移植）
- 既存ファイル再利用（読み取り主体）: `viewer/centerlineGraph.ts`, `viewer/centerline.ts`, `viewer/curvedReformat.ts`
- 共有ファイル編集（最小限・追記のみ）: `SceneObjectPanel.tsx`（「中心線解析…」ボタン1つ＋props）, `Viewer3DScreen.tsx`（`<CenterlineDialog>` マウント1箇所＋state）, `i18n`（`centerline.*` 名前空間）
- 状態: **新規ファイル完成（衝突ゼロ）**。
  - ✅ `viewer/straightenedVolume.ts`（`StraightenedVolumeBuilder` 移植・純関数）
  - ✅ `viewer3d/CenterlineDialog.tsx`（グラフ抽出→分枝/最長路/2ノード最短路選択→シーン追加、CPR インラインプレビュー＋派生保存、ストレート化 3D 派生保存）。
    scene3d.ts は**編集せず**既存 getter（`getObjectLabelVolume`/`getObjectPolyData`/`getObjectCenterline`/`addCenterlineObject`）を read のみ。CPR/ストレート化は 3D ビューアの `resliceVolumeFromCache(volumeId)` でインライン実行（幾何整合＝要件11）。
- **✅ 統合完了（A/B 協調, 2026-07-02・tsc 0 エラー）**: B の新規2ファイルの上に、共有配線と 3D グラフ overlay を統合。
  - `viewer3d/centerlineAnalysis.ts`（**A 作成**）= 全グラフ 3D overlay（分枝チューブ＝暗シアン／ノード球＝端点緑・分岐橙／選択ハイライト＝黄）。旧 `CenterlineGraphRenderer` 相当。
  - `CenterlineDialog.tsx` に `view: VtkVolumeView` prop ＋ overlay ライフサイクル（抽出時 `createGraphOverlay`／`setActive` で `setHighlight`／アンマウントで `destroy`）を統合。
  - `SceneObjectPanel.tsx`: `onAnalyzeCenterline` prop ＋「中心線解析…」ボタン（`scene3d.analyze`）。
  - `Viewer3DScreen.tsx`: `analyzeCenterline` コールバック→`analyzeTarget` state→`<CenterlineDialog view=… objectId=… volumeId=… geom=… studyUid/seriesUid/seriesDesc/modality>` マウント。
  - `i18n`: `centerline.*`（44 キー・en/ja 一致）＋`scene3d.analyze`/`scene3d.analyze.hint`。
- **実機未検証**: 骨格化→グラフ→overlay 表示、分枝/最短路選択のハイライト、CPR プレビュー/保存、ストレート化保存の目視は未実施（要 standalone・GPU・実 DICOM）。

### インスタンス B（追加レーン）— メッシュ修復/検証（§15 #7）＋カラーレジェンド（§15 #8）
- 所有ファイル（新規予定）:
  - `viewer/meshRepair.ts` — 重複頂点溶接・退化/重複三角形除去・境界/非多様体エッジ診断（旧 `MeshRepairer`/`MeshValidator`）。`mesh3d.ts` は編集せず `getMeshArrays` を read。
  - `viewer3d/MeshRepairDialog.tsx` — 検証レポート＋「修復して新規メッシュ追加」（既存 `addMeshObject` 再利用＝scene3d 非編集）。
  - `viewer3d/ColorLegend.tsx` — VR カラーマップ/VOI のカラーバー overlay（旧 `LegendConfig`/`LegendPosition`）。
- 共有ファイル編集（最小・追記）: `SceneObjectPanel.tsx`（メッシュ「修復…」ボタン）, `Viewer3DScreen.tsx`（レジェンド＋修復ダイアログ mount）, `i18n`（`meshRepair.*`/`legend.*`）。
- **✅ 完了（tsc 0 エラー, 2026-07-02）**:
  - `viewer/meshRepair.ts`（`validateMesh`/`repairMesh`。溶接 tol 格子・退化/重複三角形除去・境界/非多様体エッジ集計・非参照頂点圧縮。`mesh3d.ts` の `getMeshArrays`/`withNormals` を read のみ）。
  - `viewer3d/MeshRepairDialog.tsx`（検証レポート表・tol 入力・「修復→新規メッシュ」＝既存 `addMeshObject` 再利用で scene3d 非編集）。
  - `viewer3d/ColorLegend.tsx`（縦カラーバー overlay。LUT=`fetchLutData`/グレースケール、VOI=`view.getState()`＋`onStateChanged` 追従、単位 CT=HU/PT=SUV、四隅配置）。
  - 共有配線（相手の同時編集中に fresh-read＋追記で衝突回避）: `SceneObjectPanel`（mesh に「修復…」＋`onRepairMesh` prop）／`Viewer3DScreen`（`repairTarget`/`legendOn` state・`<MeshRepairDialog>`/`<ColorLegend>` mount・レジェンドトグル）／`i18n`（`scene3d.repair*`/`meshRepair.*`/`legend.*`・en/ja 25 一致）。
- **実機未検証**: 検証レポートの数値正確性（合成メッシュでの穴/非多様体）、修復前後の体積/外観、レジェンドの色/値域の目視は未実施。

### インスタンス B（追加レーン）— アンフォールド CPR「展開図」（回転 CPR）
- **✅ 完了（tsc 0 エラー, 2026-07-02）**: 中心線の周り 360° 掃引で管腔を開いた展開図（X=弧長, Y=角度）。腸管の仮想展開/血管壁の全周展開。
  - `viewer/curvedReformat.ts` に追記: `unfoldReformat`/`defaultUnfoldParams`/`UnfoldParams`/`UnfoldResult`。方向 `dir(θ)=cosθ·normal + sinθ·binormal`、単一半径 or 径帯 [rMin,rMax] を MIP/MINIP/AVG 投影。既存 `reformat` は不変。
  - `viewer3d/CenterlineDialog.tsx` に「展開図（回転 CPR）」セクション追記（角度分割・半径 min/max・径サンプル・投影・フレーム、プレビュー＋派生シリーズ保存）。既存 CPR/ストレート化と同骨格・W/L 共有。合成空間のため IPP/IOP なし。
  - `i18n`: `centerline.{unfoldTitle,angleStep,radiusMin,radiusMax,radialCount,saveUnfold,unfoldInfo,unfoldNote}`（en/ja 8 一致）。
  - CPR 3 方式が出揃った: 投影/ストレッチ CPR（`reformat`）／ストレート化 3D（`straightenedVolume`）／**アンフォールド展開図（`unfoldReformat`）**。
- **実機未検証**: 展開図の角度整合・半径既定値（血管 vs 腸管）・巻き込み（曲率が半径を超える箇所）の目視は未実施。

## 共有ファイル編集ルール
- `SceneObjectPanel.tsx` / `scene3d.ts` を編集する直前に必ず `git diff <file>` で相手の未コミット変更を取り込み、
  自分の追加は**末尾または独立関数**に置く。衝突したら相手の変更を優先して再適用。
- `i18n/{en,ja}.ts` は名前空間で分離（A=`measure.*`, B=`centerline.*`/`cpr.*`/`straighten.*`）。
