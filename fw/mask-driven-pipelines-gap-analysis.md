# マスク駆動パイプライン（仮想内視鏡・Volumetry・中心線解析）ギャップ分析

> 2026-07-15 調査。3D Viewer にマスク（セグメンテーション）を表示する必要のあるパイプライン
> （仮想内視鏡・Volumetry・中心線解析）について、現状の実装・データフローを一次ソース（コード）から
> 洗い出し、実装済み/部分実装/未実装の境界と、導線が切れている箇所を整理する。
> 実装方針の決定は別途行うこと。本ドキュメントは調査結果のみ。

## 1. 対象パイプラインと前提

- **仮想内視鏡（Virtual Endoscopy）**: マスクから抽出した中心線に沿って 3D Viewer 内をフライスルーする機能。
- **Volumetry（体積計測）**: セグメンテーションされた構造物の体積・統計値を算出し、レポート等に残す機能。
- **中心線解析（Centerline Analysis）**: マスクから血管・気道・臓器の中心線を抽出し、CPR（Curved MPR）や
  ストレート化ボリューム、内視鏡パスの生成に用いる機能。

これら3つはいずれも「2D Viewer 等で作成/取り込んだマスクが 3D Viewer 側のパイプラインに到達すること」を
共通の前提とする。本調査はこの前提が現状どこまで成立しているかを中心に行った。

## 2. 現状アーキテクチャの要約

- ローカルでのマスク編集（ブラシ／ワンド／レベルセット: `frontend/src/viewer/segmentation.ts`,
  `wandTool.ts`, `levelSetsTool.ts`）は Cornerstone3D の `segmentation`（labelmap）オブジェクトとして書き込まれ、
  アプリ側メタデータは `frontend/src/viewer/roiMaskStore.ts` が別途保持する。
- 3D Viewer 側では `SceneObjectPanel.tsx` のドロップダウンで明示的にマスクを選択すると、
  `labelVolume.ts`（`buildLabelVolumeFromSegmentation`）で実空間の `LabelVolume` に変換され、
  `roiMesh.ts`（`labelVolumeToMesh`）で marching cubes によりポリゴンメッシュ化され、
  `scene3d.ts`（`addRoiObject`）で `SceneObject` としてシーンに追加される。
- そこから `CenterlineDialog.tsx` / `scene3d.ts`（`extractCenterlineFromObject`）が同じ `LabelVolume` を
  `skeletonize.ts` / `centerlineGraph.ts` で骨格化し、`Centerline3D` を生成する。この `Centerline3D` は
  仮想内視鏡のフライスルー（`endoscopy.ts`）と CPR/ストレート化（`curvedReformat.ts`, `straightenedVolume.ts`）
  の両方から共通に消費される。**中心線解析エンジン自体は、マスク駆動として一貫性のある完成度の高い実装。**
- 一方で、**2D Viewer と 3D Viewer（および MPR / Slicer / Curved MPR）は別ブラウザウィンドウとして起動される**
  （`Viewer2DScreen.tsx:805-848`, `window.open(...)`）。各ウィンドウは独立した Cornerstone `segmentation` の
  インメモリ状態を持ち、ウィンドウ間で同期する仕組みが存在しない。このため「2D で描いたマスクが 3D Viewer の
  マスク選択ドロップダウンに出てこない」という、パイプライン全体の入口を塞ぐ構造的な問題がある。

## 3. 課題一覧

各項目は「現状（実装済み／部分実装／未実装）」「根拠（file:line）」「なぜパイプラインを妨げるか」の順に記載。

### 3.1 【最重要】2D Viewer と 3D Viewer がウィンドウ分離されており、マスクが引き継がれない

- **現状**: 実装済みだが構造的に機能しない。
- **根拠**:
  - `frontend/src/viewer2d/Viewer2DScreen.tsx:805-814`（`launchViewer3D`）: `localStorage["graphy-viewer3d-ctx"]`
    に `{study, series, c, t, ts}` のみを書き込み、`window.open(...,"graphy-viewer3d")` で別ウィンドウを開く。
  - `frontend/src/viewer3d/SceneObjectPanel.tsx:133`: マスク選択肢は `csSeg.state.getSegmentations()`、
    つまり **そのウィンドウ内**の Cornerstone segmentation state から構築される。
  - `frontend/src/viewer/globalRoiSync.ts:38-83` は同一 Cornerstone インスタンス内での ROI 参照画像 ID の
    再ターゲットのみを行い、ウィンドウ間のマスク複製とは無関係。
- **影響**: 2D で描いた／取り込んだマスクは、3D Viewer を開いた瞬間には存在しない。ユーザーが手動で
  同一ウィンドウ内に両方の操作を収める運用回避策以外に、現行のナビゲーションモデル
  （2D/3D/MPR/Slicer/CurvedMPR がそれぞれ別ウィンドウ、`App.tsx:126-153`）では解決しない。
  **3パイプラインすべての入口を塞ぐ最上位の課題。**

### 3.2 DICOM SEG のフロントエンド取り込み（インポート）が存在しない

- **現状**: 未実装。
- **根拠**: `frontend/src/api.ts:391` は `POST /api/dicom/seg`（エクスポートのみ、`segExport.ts`）。
  フロントエンドに SEG 読込処理は見当たらず、バックエンドにも `RtStructReadService` はあるが
  `SegReadService` に相当するものは存在しない（`backend/src/main/java/com/vis/graphynext/dicom/export/` 配下）。
- **影響**: 3.1 の回避策となる「2D でエクスポート → 3D で再インポート」という標準的な DICOM 相互運用経路が
  片側（エクスポート）しか実装されていない。外部AIセグメンテーション由来の SEG も同様に取り込めない。

### 3.3 RTSTRUCT インポートは注釈（アノテーション）止まりで、労量計データ（labelmap）に自動変換されない

- **現状**: 部分実装（要手動ステップ、かつ同一ウィンドウ内限定）。
- **根拠**: `frontend/src/viewer/rtstructImport.ts:75-116`（`reconstruct`）は
  `csAnnotation.state.addAnnotation` で `PlanarFreehandROI` 注釈を生成するのみで、
  `csSeg.addSegmentations` は呼ばれない。`SceneObjectPanel.tsx` のマスク一覧は
  `csSeg.state.getSegmentations()` のみを見るため、インポート直後の RTSTRUCT はここに現れない。
  ユーザーは `RoiManagerPanel.tsx:508`（「▦」ボタン → `runRoiToMask` → `roiBooleanOps.ts:roiToMask`）で
  明示的にラスタ化する必要がある。
- **影響**: 外部で作成された RTSTRUCT（AIセグメンテーション等）が 3D パイプラインに乗るまでに、
  正しいウィンドウで2段階の手動操作が必要。自動導線がない。

### 3.4 Volumetry は計算ロジックとしては存在するが、算出方法が2系統に分裂し、結果は永続化・出力されない

- **現状**: 部分実装（画面表示止まり、レポート/エクスポート未連携）。
- **根拠**:
  - `frontend/src/viewer/labelVolume.ts:289-361`（`maskVolumeStats`）: ボクセル数×スペーシングによる
    体積・HU統計。2D 側 `RoiManagerPanel.tsx:411-419,551-562`（「Σ」ボタン）で表示。
  - `frontend/src/viewer/mesh3d.ts:75-129`（`measureMesh`）: 三角メッシュからの体積/表面積/径計測。
    3D 側 `SceneObjectPanel.tsx:416-435` で表示。
  - 両者は独立実装で、スムージング（`roiMesh.ts:71-85`）の影響等により値が微妙に一致しない可能性がある。
  - いずれの結果も React コンポーネント state または非永続の `SceneObject` メタデータ
    （`scene3dStore.ts:24-49`）にしか残らず、`roiMaskStore` のメタデータ・SEG セグメント記述・
    レポートのいずれにも書き戻されない。
- **影響**: Volumetry を「患者記録に紐づく再利用可能な数値」として扱えない。ウィンドウを閉じると消える。

### 3.5 Volumetry・中心線解析の結果を DICOM SR / レポートへ書き込む導線がない

- **現状**: 未実装。
- **根拠**: `backend/src/main/java/com/vis/graphynext/report/ReportService.java`,
  `SrWriter.java` を `volume|centerline|segment|Mask|ROI|Measurement` で検索してもヒットなし。
  `ReportService.java:34-41,66-80` は自由記述の Markdown 本文（＋キー画像）を
  Comprehensive SR / Key Object Selection に変換するのみで、TID 1500 系の構造化計測レポートの
  エンコード機構自体が存在しない。
- **影響**: Volumetry・中心線長・分岐情報などの数値を、機械可読な形でレポートに残す手段が一切ない。
  現状は自由記述欄に手動転記するしかない。

### 3.6 中心線解析エンジン自体はマスク駆動として完成度が高い（相対的に良好な部分）

- **現状**: 実装済み。
- **根拠**: `frontend/src/viewer/skeletonize.ts:55`（`skeletonizeLabelVolume`）でマスクの実ボクセル3D細線化を行い、
  `frontend/src/viewer/centerlineGraph.ts:427`（`extractCenterlineGraph`）で分岐グラフを構築、
  最長路／分岐／最短路抽出をサポート（`centerlineGraph.ts:70+`）。
  `frontend/src/viewer3d/scene3d.ts:791-812`（`extractCenterlineFromObject`）と
  `CenterlineDialog.tsx:156-208`（`runExtract`）がこれを呼び出し、共通の `Centerline3D` 型
  （`frontend/src/viewer/centerline.ts:83`）に集約する。手動クリックで作る内視鏡パス
  （`endoPathStore.ts` → `scene3d.ts:696-702` `commitEndoPathAsCenterline`）も同じ型に収束するため、
  フライスルー（`scene3d.ts:819-830` `startEndoscopy`）と CPR/ストレート化
  （`CenterlineDialog.tsx:264-532`）はマスク由来／手動どちらの中心線も等しく扱える。
- **評価**: 中心線解析そのものはアルゴリズム上のギャップではなく、上流（3.1〜3.3、マスクがシーンに
  到達するまで）と下流（3.5、結果の永続化）がボトルネック。

### 3.7 独立した「Curved MPR」画面がマスク由来中心線を一切消費しない、重複実装になっている

- **現状**: 実装済みだが、マスク駆動経路から切り離されている（重複）。
- **根拠**: `frontend/src/curvedmpr/CurvedMprScreen.tsx` は 2D Viewer のメニューから
  `localStorage("graphy-curvedmpr-ctx")` 経由で別ウィンドウとして起動され
  （`Viewer2DScreen.tsx:839-848`）、参照スライス上のダブルクリックのみで `Centerline3D` を構築する。
  `curvedReformat.ts`/`centerline.ts` という共通プリミティブは再利用しているが、
  `scene3d.ts` やマスクデータへの参照は一切ない。
- **影響**: 「Curved MPR」という最も発見されやすいメニュー項目からは、セグメンテーションされた血管等に
  沿った CPR を作れない。マスク駆動の CPR は `CenterlineDialog.tsx` 内の別導線からしか到達できず、
  ユーザーにとって分かりにくい。将来の中心線サンプリング改善が2実装間で乖離するリスクもある。

### 3.8 仮想内視鏡のレンダリングはマスク表面ではなく生のCTボリュームを描画している（パス生成のみマスク利用）

- **現状**: 部分実装（パスはマスク対応、描画はマスク非対応）。
- **根拠**: `vtkVolumeView.ts:372-389` はしきい値／不透明度伝達関数で駆動する単一の
  `vtkVolumeMapper`/`vtkVolume` アクターを持ち、`scene3d.ts:100-114`（`attachSceneRenderer`）が
  メッシュ／ROIアクターと同一レンダラーに追加する。`endoscopy.ts:133-162`（`updateCamera`）は
  `Centerline3D` に沿ってカメラを移動させるのみで、ボリュームの不透明度やマスクアクターの可視性には
  触れない。`scene3d.ts:822-830`（`startEndoscopy`）が非表示にするのは中心線チューブ自体のみ。
- **影響**: フライスルー中に見えているのは、ユーザーが設定した VR/MIP/WL しきい値による従来型の
  閾値ベース仮想内視鏡描画であり、セグメンテーション面（管腔壁の強調表示等）は主要な描画対象になっていない。
  マスクの役割は現状「パス生成」のみ。

### 3.9 「Volumetry」「仮想内視鏡」という名前の付いた専用ワークフローが存在しない

- **現状**: 機能としては未定義（既存の汎用3Dビューア部品の寄せ集め）。
- **根拠**: `frontend/src/i18n/ja.ts` / `en.ts` を `体積計測|volumetry|仮想内視鏡|virtual endoscopy` で
  検索してもヒットなし。関連する文字列は `SceneObjectPanel.tsx` の汎用パネルに付随する
  `scene3d.volume`（＝「体積」）、`scene3d.flyThrough`（＝「▶ 内視鏡（fly-through）」）、
  `scene3d.analyze`（＝「中心線解析…」）のみ。
- **影響**: 臨床ユーザーが「臓器の体積を計測する」「仮想内視鏡を開始する」ために一箇所に集約された
  ガイド付きワークフロー／画面が存在しない。`RoiManagerPanel` / `SceneObjectPanel` / `CenterlineDialog` に
  機能が分散している。

### 3.10 ストア（状態管理）が画面ごとに分断されており、アドホックにしか統合されていない

- **現状**: 設計上の分断が確認された。
- **根拠**: `frontend/src/viewer/sphere3dStore.ts` は `RoiManagerPanel.tsx`（2D側の球体ROIプレビュー）
  でのみ使用され、`scene3d.ts` から一切参照されない。パラメトリック球は
  `roi3d.ts:188-202`（`bakeSphere3D`）でマスクに焼き込んだ上、他のマスクと同様に手動インポート
  （3.1 の制約下）しない限り、実際の 3D Viewer シーンには現れない。
  `scene3dStore.ts` / `endoPathStore.ts` / `measureStore.ts` / `undoStore.ts` はいずれも
  `viewer3d` ローカルで、相互参照は `scene3d.ts` を唯一のコントローラとして経由する。
  `roiMaskStore.ts` は `viewer3d` からは `SceneObjectPanel.tsx:17` の読み取り専用ラベル参照でしか
  到達されない。
- **影響**: アプリ全体が合意する単一の「マスクレジストリ」が存在せず、開発者が個別に配線した箇所以外は
  連携しない。今後の機能追加のたびに同種の導線切れが再発するリスクがある。

## 4. UI導線の到達可否まとめ

| やりたいこと | 現状 |
|---|---|
| (a) マスクを3Dサーフェスとして表示 | 実装済み（`SceneObjectPanel.tsx:281-299` のドロップダウン）。ただし 3.1 によりマスクが同一ウィンドウ内にある場合のみ機能 |
| (b) マスクから中心線を抽出 | 実装済み（`SceneObjectPanel.tsx:381-400`, `CenterlineDialog.tsx`）。マスクがシーンに到達していれば完全に機能 |
| (c) マスク由来パスで仮想内視鏡を開始 | 実装済み（`SceneObjectPanel.tsx:411-415`）。ただし描画は生ボリューム（3.8） |
| (d) Volumetry値の閲覧／出力 | 閲覧は実装済み（2D「Σ」/3D計測パネル）。**出力（レポート/SEG/永続化）は未実装**（3.5） |

## 5. 優先順位付き対応課題（影響度が高い順）

1. **ウィンドウ間でのマスクデータ橋渡し（3.1）** — (a) 2D/3D/MPR/Slicer/CurvedMPR を同一ウィンドウ・
   同一JSランタイムに統合する（最大規模の構成変更）、または (b) `BroadcastChannel`/`SharedWorker` 等で
   `csSeg` の labelmap を実際に同期する、もしくはバックエンド経由で作業中マスクを永続化する、
   のいずれかの実装がない限り、3パイプラインとも実運用のエンドツーエンド導線が成立しない。
2. **DICOM SEG インポートのフロントエンド実装（3.2）** — `rtstructImport.ts` に倣い、実際に
   `csSeg` labelmap を生成するインポータを実装する。3.1 の標準規格ベースの回避策になると同時に、
   外部AIセグメンテーションの取り込み口にもなる。
3. **Volumetry・中心線解析結果の永続化（3.4, 3.5）** — マスク体積・統計値、中心線長・分岐サマリーを
   SEGセグメント記述、または `SrWriter.java`/`ReportService.java` を拡張した TID 1500 系構造化計測、
   最低でも `roiMaskStore` のメタデータに書き込み、SEGエクスポート/インポートを跨いで保持されるようにする。
4. **インポート済み RTSTRUCT/SEG が手動ラスタ化なしにパイプラインへ到達するようにする（3.3）** — SEG直接
   インポート（3.2）でカバーするか、RTSTRUCTインポート直後に「▦ マスク化」を自動提案する。
5. **2系統の Curved MPR UI の統合（3.7）** — 3.1 解決後、独立した `CurvedMprScreen.tsx` がマスク由来の
   中心線を受け付けられるようにするか、`CenterlineDialog.tsx` の CPR 機能に一本化する。
6. **仮想内視鏡の描画をマスクと連携させる（3.8）** — データフロー上の課題より優先度は低いが、
   閾値ベースのボリュームレンダリングではなく、セグメンテーション面を反映した本来の
   「マスク駆動仮想内視鏡」にするには、`startEndoscopy` 開始時に元ROI表面を強調表示／生ボリュームを
   減衰させる等の連携が必要。
7. **ストアモデルの統合（3.10）** — 最低限、`sphere3dStore` の結果を焼き込み・再インポートなしに
   `scene3d`/`scene3dStore` へ反映できるようにする。3.1 解決後は、2D/3D/MPR/CurvedMPR が共通で参照する
   単一の「セッション内マスクレジストリ」の検討が望ましい。

## 6. 調査方法・参照ファイル

一次調査は general-purpose subagent によるコード読解（file:line 引用付き）を行い、以下の重要主張については
本セッションで直接ファイルを再確認し裏取り済み:

- `Viewer2DScreen.tsx:805-848` の `window.open` によるウィンドウ分離。
- `SceneObjectPanel.tsx:133` の `csSeg.state.getSegmentations()` によるマスク一覧のスコープ。
- `ReportService.java` / `SrWriter.java` に体積・中心線関連の実装が存在しないこと。

主な参照ファイル一覧:

- マスク/ROI/セグメンテーション: `frontend/src/viewer/roiMaskStore.ts`, `roi3d.ts`, `mesh3d.ts`,
  `labelVolume.ts`, `segmentation.ts`, `segMetadata.ts`, `segExport.ts`, `rtstructImport.ts`,
  `rtstructExport.ts`, `levelSets*.ts`, `wandTool.ts`, `roiBooleanOps.ts`, `sphere3dStore.ts`,
  `globalRoiSync.ts`, `frontend/src/viewer2d/RoiManagerPanel.tsx`
- 3D Viewer: `frontend/src/viewer3d/scene3d.ts`, `scene3dStore.ts`, `Viewer3DScreen.tsx`,
  `SceneObjectPanel.tsx`, `undoStore.ts`, `Viewer3DEndoPathOverlay.tsx`, `Viewer3DMeasureOverlay.tsx`,
  `EndoscopyControls.tsx`, `endoPathStore.ts`, `CenterlineDialog.tsx`, `centerlineAnalysis.ts`
- 中心線/CPR/内視鏡エンジン: `frontend/src/viewer/centerline.ts`, `centerlineGraph.ts`, `skeletonize.ts`,
  `curvedReformat.ts`, `straightenedVolume.ts`, `endoscopy.ts`, `volumeRender.ts`,
  `frontend/src/curvedmpr/CurvedMprScreen.tsx`, `frontend/src/viewer/SeriesViewer.tsx`
- バックエンド: `RtStructExportService.java`, `RtStructReadService.java`, `SegExportService.java`,
  `SegFrameExpander.java`, `report/ReportService.java`, `report/SrWriter.java`
- 既存設計ドキュメント（参考）: `fw/roi-mask-model.md`, `fw/3d-viewer-design.md`,
  `fw/segmentation-tools-design.md`, `fw/dicom-seg-rtstruct-design.md`
