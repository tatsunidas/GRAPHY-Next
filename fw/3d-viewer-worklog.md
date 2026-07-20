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

### インスタンス C（このセッション）— 3D Cut(#2)/3D計測(#3)/手動endo経路(#6)/AxesGizmo(#9)＋Cinematic P4/P7＋UX修正
- **共通投影基盤**（新規・他レーン非依存）: `viewer3d/volumeCut.ts`（`makeCameraProjector` world→CSS 順投影・`makeActorTransform`・`pointInPolygon`）／`viewer3d/measure3d.ts`（`makeUnprojector` 逆投影レイ・`inverseViewProj` NDC→world 行列[GPU用]・`rayTriangleIntersect` Möller-Trumbore・`pickVolumeSurface`）。pure-vtk カメラ行列を vtk `Renderer.worldToView→viewToProjection` で1:1再現。dpr は CSS 換算で相殺。要件11（cornerstone worldToCanvas 非依存）。
- **✅ #2 3D Cut**: `scene3d.cutRoiLasso`（前景voxel→project→多角形内/外で labelmap 彫刻＋Undo）／`Viewer3DCutOverlay.tsx`（SVG 投げ縄・inside/outside）。
- **✅ #3 3D計測**: `measureStore.ts`／`scene3d.pickSurfacePoint`（全可視表面に交差）＋`addMeasurement3D`/`removeMeasurement3D`（Undo）／`Viewer3DMeasureOverlay.tsx`（カメラ変化で再投影）。**どの表示モードでも計測可**＝`pickVolumeSurface`（現在 LUT/不透明度でボリューム表面を拾う）フォールバック。
- **✅ #6 手動endo経路**: `endoPathStore.ts`／`scene3d.{pickPathPoint,applyEndoPath,commitEndoPath,commitEndoPathAsCenterline}`／`Viewer3DEndoPathOverlay.tsx`（クリック追加/ドラッグ移動/右クリック・Delete削除・Undo）。中心線化で ▶内視鏡/CPR に接続。
- **✅ #9 AxesGizmo**: 旧 cornerstone `OrientationMarkerTool` は pure-vtk 移行で未表示だった→`vtkVolumeView.ts` に `vtkOrientationMarkerWidget`+`vtkAnnotatedCubeActor`（患者LPSラベル・右下・`setAxesEnabled`）。
- **✅ P4 Cinematic v1 強化**: `vtkVolumeView.applyCinematic` に WebGL2 散乱（`setVolumetricScatteringBlending`/`setGlobalIlluminationReach`/`setAnisotropy`/`setLocalAmbientOcclusion`/`setComputeNormalFromOpacity`）。UI=CinematicSettingsDialog「シネマティック(散乱)」。
- **✅ P7 Cinematic v2 パストレース**: `viewer/cinematicPathTracer.ts`（旧 `cinematic.frag`/`present.frag` を WebGL2 GLSL ES 3.00 に1:1移植。R32F 3Dテクスチャ[≤256³]・ping-pong RGBA32F 蓄積・HG+GGX+ソフトシャドウ）＋`vtkVolumeView.getLut256`＋`Viewer3DCinematicOverlay.tsx`（プログレッシブ・カメラ追従リセット）。Viewer3DScreen「パストレース(β)」。`EXT_color_buffer_float` 必須。
- **UX修正**: ColorLegend 右上（`corner="tr"`・AxesGizmo と重なり回避）／EndoscopyControls に Escape 終了／3D計測を全モード対応。
- 共有ファイル配線（相手の同時編集中に fresh-read＋追記で衝突回避）: `Viewer3DScreen.tsx`（各オーバーレイ mount・排他モード・トグル）／`SceneObjectPanel.tsx`（3D Cut/計測トグル/手動endo経路/中心線解析ボタン）／`i18n`（`cut.*`/`measure.*`/`endoPath.*`/`cine2.*`/`viewer3d.cine.scatter*`・en/ja）。
- **実機未検証**（全項目）: 投影整合・カット/計測/経路の目視、AxesGizmo 追従、Cinematic 質感、**P7 は実機GPU必須（float FBO・パラメータチューニング要）**。

## 共有ファイル編集ルール
- `SceneObjectPanel.tsx` / `scene3d.ts` を編集する直前に必ず `git diff <file>` で相手の未コミット変更を取り込み、
  自分の追加は**末尾または独立関数**に置く。衝突したら相手の変更を優先して再適用。
- `i18n/{en,ja}.ts` は名前空間で分離（A=`measure.*`, B=`centerline.*`/`cpr.*`/`straighten.*`）。

## 不具合修正: 3D ビューアが白画面→再オープンで `Cannot create proxy with a non-object`（2026-07-20）

**症状**: 3D 表示中に突然パネルが真っ白になり、以降ウィンドウを開き直しても
`Failed to build 3D view: TypeError: Cannot create proxy with a non-object as target or handler`。

**原因**: WebGL コンテキストのリーク（上限超過）。
- vtk.js `Rendering/OpenGL/RenderWindow.js` の `get3DContext()` は
  `canvas.getContext('webgl2'|'webgl')` の結果を**無検査で** `new Proxy(result, handler)` に渡す。
  取得失敗（null）時にこの TypeError が出る＝**「WebGL コンテキストが作れない」の別名**。
- vtk.js の `deleteGLContext()` は内部カウンタを減らすだけで `WEBGL_lose_context` を呼ばない。
  `grw.delete()` してもコンテキストは canvas が GC されるまで生存する。
- 同様に `viewer/cinematicPathTracer.ts` の `dispose()` も GL リソース削除のみでコンテキストを残していた。
- 結果、3D ビューアの開閉（＋パストレース）を繰り返すと Chromium のコンテキスト上限（≈16/renderer）に達し、
  ブラウザが古いコンテキストを強制ロスト＝**白画面**、以後 `getContext()` が null＝**上記 TypeError**。

**対処**（`viewer/vtkVolumeView.ts` / `viewer/cinematicPathTracer.ts` / `viewer3d/Viewer3DScreen.tsx`）:
1. `destroy()` で `interactor.unbindEvents()` →
   `getApiSpecificRenderWindow().getContext()` から `WEBGL_lose_context.loseContext()` → `grw.delete()` の順で
   **コンテキストを明示解放**（`forceLoseContext`）。パストレーサ `dispose()` も同様。
2. `WebGLContextUnavailableError` / `isWebGLContextUnavailable()` を追加し、Proxy TypeError を
   「GPU コンテキスト喪失」と分かるメッセージ（`viewer3d.glLost`）に変換。
3. `webglcontextlost` を購読し、白画面のまま放置せずビューを破棄してエラー表示＋**［再試行］**ボタン
   （`viewer3d.retry`）で再構築できるようにした。

**注意**: vtk 由来の生の Proxy TypeError を見たら、まずコンテキスト枯渇/GPU プロセス喪失を疑うこと。
