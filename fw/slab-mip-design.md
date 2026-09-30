# Slab MIP（厚板 MIP / MinIP / AvgIP）設計

> 2026-09-26 追加（`feat/slab-mip`）。3 経路に入れた:
> **A. 3D Viewer > モード「Slab」** / **B. MPR 画面ヘッダ「スラブ」** / **C. 2D Viewer の ThickSlab 投影方式＋表示 > Slab MIP**。
> 参考: 角辻「Slab MIP で心臓 CT を診る！」（月刊インナービジョン 2009-10, Ziosoft 転載）
> https://www.innervision.co.jp/suite_ws/ziosoft/cloud/200910_1.html
> ⚠️ 着手前に [`cornerstone-3d-geometry-caveat.md`](cornerstone-3d-geometry-caveat.md) を読むこと。

## 1. 要件（利用者と合意済み）

| 項目 | 決定 |
| :- | :- |
| 入れる場所 | 3D Viewer の新モード・MPR 画面・2D ThickSlab の **3 本すべて** |
| 投影方式 | MIP（最大値）/ MinIP（最小値）/ AvgIP（平均）。型は `slabPresets.ts` `SlabProjection` を 3 経路で共有 |
| 厚み | **常に全幅 mm**（中心面 ±厚/2）。スライス枚数では持たない（非等方シリーズでも臨床的意味が同じになる） |
| プリセット | 文献値ベース `3 / 5 / 8 / 10 / 15 / 20 mm`＋薄い MIP 用 `1 / 2 mm`（2026-09-27 追加）。MPR・3D は任意入力（0.5〜200mm）も可。既定 MIP 5mm・MinIP 3mm・AvgIP 5mm（§6） |
| 保存 | 新規シリーズとしては保存しない（表示のみ） |

## 2. 構成

| ファイル | 役割 |
| :- | :- |
| `frontend/src/viewer/slabPresets.ts` | `SlabProjection`・厚みプリセット・既定厚・任意入力のクランプ |
| **A** `frontend/src/viewer/slabGeometry.ts` | 純関数: スラブ面（=焦点・視線）、深さ `depthAlongView`・`targetForDepth`・`translateCameraTo`、ダブルクリックの奥行き `pickSlabPoint`、シネ `spinStep` |
| **A** `frontend/src/viewer/cameraSnap.ts` | 純関数: 向きスナップ（Axial/Coronal/Sagittal＋反対側）。**全モード共通** |
| **A** `frontend/src/viewer/vtkSlab.ts` | `vtkImageSlice` + `vtkImageResliceMapper`（`setSlabThickness`/`setSlabType`/`setSlicePlane`）。面はカメラの `onModified` で追従 |
| **A** `frontend/src/viewer/vtkVolumeView.ts` | `VtkRenderMode` に `"SLAB"`。`setSlab`/`getSlab`/`setSlabDepth`/`setRotationCenter`/`centerRotation`/`pickSlabCenterAt`/`startSpin`・`stopSpin`/`snapOrientation`。SLAB 中は volume 非表示・**平行投影を強制**（抜けると元へ）・**回転はカメラ周回に固定** |
| **A** `frontend/src/viewer3d/SlabPanel.tsx` | 右パネル: 投影 3 択・厚み・深さ・回転中心座標＋「ボリューム中心へ」・自動回転シネ |
| **A** `frontend/src/viewer3d/Viewer3DScreen.tsx` | 「向き」スナップ（全モード）・ダブルクリック中心指定・中央十字マーカー。Info オーバーレイは Slab 中「回転中心」「スラブ」 |
| **B** `frontend/src/viewer/mpr.ts` `applyMprSlab` | 3 面の `VolumeViewport` に `setBlendMode` + `setSlabThickness`（OFF は `COMPOSITE` + `resetSlabThickness`） |
| **B** `frontend/src/mpr/MprScreen.tsx` | ヘッダに「スラブ」select（OFF/AvgIP/MIP/MinIP）＋厚み。W/L 既定へ戻すと cornerstone がスラブ厚も戻すので掛け直す |
| **C** `frontend/src/viewer/thickSlab.ts` | セッション/トークンに `projection`。累積を純関数 `projectSamples` に切り出し MEAN/MAX/MIN |
| **C** `frontend/src/viewer/SeriesViewer.tsx` | ThickSlab 行に投影 select。MIP/MinIP のときだけ厚み選択肢に 8/10/15/20mm を追加 |
| **C** 接続 | `Viewer2DMenuBar`（表示 > Slab MIP、`testId: menu-slab-*`）→ `ViewerActions.setSlab` → `seriesCommands.setSlab` → 対象タイルの SeriesViewer |

## 3. 数式・サンプリングの約束

- **A（vtk.js ImageResliceMapper）**: シェーダが面法線方向に ±厚/2 を `min(spacing)×0.5` 刻みでサンプル（トリリニア）し、
  MAX/MIN/MEAN を取る。ボリューム外のサンプルは捨てる。面 = 原点 **焦点（＝回転中心）**、法線 `n = 視線方向`（2026-09-27 改訂、§7）。
  色は volume と**同じ色 TF を共有**（`setUseLookupTableScalarRange(true)`）→ W/L・LUT がそのまま効く。
- **B（cornerstone VolumeViewport）**: cornerstone が焦点面 ±厚/2 のクリップ面で切り出し、VolumeMapper のブレンドで投影。
  cornerstone は厚み < 0.1mm を 0.1mm に丸める。
- **C（2D ThickSlab）**: 従来どおり Z 方向 1D 線形補間でサブサンプル（最大 64 点）し、そのサンプル値に対して投影。
  欠けた面は MIP/MinIP に寄与しない（全欠けは 0）。平均の分母は全サンプル数（従来の平均と同一）。
  デジタル Z 写像（厚み単位で送る）は投影方式に依存しないので**そのまま**（厚みごとに重ならないスラブ送り）。

## 4. 制約・既知の限界

- **A**: スラブは**クロップ箱を無視**する（入力は crop 前の imageData）。embedded な mesh/ROI は 3D のまま重なる。
  Actor 回転モードでもスラブ中は**カメラ周回**になる（Actor を回すとスラブ面とボリュームの幾何がずれるため）。
  ImageResliceMapper はボリュームのテクスチャを別に持つ可能性がある（GPU メモリ 2 倍）。実機で要確認。
- **B**: 表示専用。上段の probe 値は**中心面の値**（MIP 値ではない）なので「（中心面の値）」と注記。
  `caveat` 文書は `VolumeViewport3D` で blend/slab が no-op と記録しているが、MPR は ORTHOGRAPHIC の `VolumeViewport` で別物。**実機で要確認**。
- **C**: 厚い MIP（20mm/0.5mm 間隔＝約 40 枚）は 1 枚ごとに近傍を読むので送りが重くなりうる。ROI・計測は従来どおりブロック。

## 5. 検証

- vitest: `thickSlab.test.ts`（投影 MAX/MIN/MEAN・補間後に投影・欠け面・トークンに投影方式・選択肢）、
  `slabGeometry.test.ts`（面・depth クランプ）。`npm run typecheck && npm test && npm run build` green（2026-09-26）。
- 実機（`make dev-desktop`・未実施）: ①2D で MIP 10mm・MinIP 3mm と送り・メニュー ②MPR 3 面で厚み変更が反映されるか
  ③3D Slab で回転・Shift+ホイール・W/L・LUT・メモリ。PET 等の非 CT でも崩れないこと。

## 6. 文献（厚みプリセットの根拠）

- STS-MIP の原点: Napel/Rubin ら（Radiology 1993）。びまん性肺疾患の微小結節 https://pubmed.ncbi.nlm.nih.gov/8685322/
- Gruden 2002 / Coakley 2001: スライディングスラブ MIP で結節検出向上 https://pubmed.ncbi.nlm.nih.gov/11519541/
- Kawel 2009 AJR: 5/8/11mm 比較で **8mm MIP の感度最高** https://pubmed.ncbi.nlm.nih.gov/19380557/
- AJR 2019（221 例）: 充実性 **10mm MIP**、亜充実性 **3mm MinIP** が最良 https://www.ajronline.org/doi/10.2214/AJR.19.21325
- Zheng 2020（DL-CAD）: 1→10mm で感度上昇、15mm 超で低下 https://www.sciencedirect.com/science/article/pii/S016926072031453X
- Chen（QIMS 2025–26）: MPVR が MIP/MinIP より検出で優位 https://pmc.ncbi.nlm.nih.gov/articles/PMC12780691
- 角辻（Ziosoft 記事）: 冠動脈長軸 **5mm**、左室 5–10mm、短軸プラーク評価は最薄（MPR）。
- 実装参照: vtk.js ImageResliceMapper（v27+）、Cornerstone3D `setSlabThickness`/`setBlendMode`、OHIF PR #6268、
  3D Slicer SlabReconstruction（`vtkImageReslice` SlabMode）。

## 7. 改訂 2026-09-27 — スラブ中心 ≡ 回転中心（3D Slab）

初版は Shift+ホイールで**スラブ面だけ**を動かしていた（面中心 = 焦点 + 視線×depth）ため、depth≠0 で回すとスラブが
回転中心のまわりを公転し、関心点が外れた。利用者の方針「Ziosoft より扱いやすく」で次のとおり改めた。

| 操作 | 挙動 |
| :- | :- |
| Shift+ホイール / 深さスライダー | カメラの**焦点と位置を同じベクトルだけ視線方向へ平行移動**＝回転中心とスラブが一緒に前後。表示値はボリューム中心からの視線方向距離 `dot(f−c, n)`（回すと値が変わる） |
| ダブルクリック | クリックのレイ上でスラブ内の **MIP=最大／MinIP=最小の深さ**（AvgIP は中心面）を拾い、そこを回転中心に（画面中央へ寄る）。計測モード中は無効 |
| 左ドラッグ / 中ドラッグ | 回転中心まわりの回転 / 面内 Pan（回転中心も面内で動く） |
| 自動回転 | 回転中心まわり。左右（azimuth）/上下（elevation）、360° 連続 / ±30° / ±60° 往復、15/30/60°/s。マウス押下・モード切替で停止 |
| 向きスナップ（全モード） | Axial=足側から（上=A）、Coronal=前から（上=S）、Sagittal=左から（上=S、前が画面左）。「反対」で視線反転。焦点・距離・ズーム保持、Actor 回転リセット |
| 表示 | パネルに回転中心（LPS mm）、Info の「回転中心」「スラブ」行、画面中央の十字（平行投影では焦点が常に中央） |

- Slab を抜けても焦点は移動後のまま（VR/MIP の回転中心もそこ）。`Reset View` で初期に戻る。
- 奥行きの拾い方は最近傍サンプル（`fine/2` 刻み）。表示（GPU トリリニア）とは最大半ボクセルずれうる。
- vitest: `slabGeometry.test.ts`（14 件: 深さ・平行移動・pickSlabPoint の MIP/MinIP/AVG・spinStep 往復・スナップの画面右）。
