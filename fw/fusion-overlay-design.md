# Fusion オーバーレイ設計（GRAPHY-Next 2D Viewer）

> 作成: 2026-07-02。2D Viewer のシリーズ重畳（Fusion）オーバーレイの設計と、LUT 引き継ぎ・オーバーレイ W/L 調整・範囲外消去の実装記録。
> 関連: `fw/viewer-2d-screen.md`（DnD による Fusion 起動）/ `fw/viewer-2d-architecture.md`（pixelCalibration 単一入口）。
> 旧: `GRAPHY/src/main/java/com/vis/core/fusion/ImagePairingEngine.java`（ワールド座標整合の移植元）。

## 1. 概要

タイルヘッダを別タイルの**中央にドロップ**、またはツリーからシリーズを中央ドロップすると、そのシリーズが
**前景（オーバーレイ）**としてベース画像に重畳される。`FusionOverlay`（`Viewer2DScreen.tsx`）が状態を持ち、
`FusionImageViewer`（`viewer/FusionOverlayViewer.tsx`）が base 画像の表示矩形 `rect` に単一 `<canvas>` を重ねて描画する。

## 2. 描画方式（`FusionImageViewer.runFusion`）

- **空間 Fusion**（前景・背景に IOP/IPP がある場合）: `fusionEngine.computeFusionSlice` で前景ボリュームを
  背景スライスの画素グリッドへ **3D trilinear リサンプリング**（実座標整合）。前景範囲外画素は NaN=透明。
- **非空間フォールバック**（IOP/IPP 無し）: base の index を比例 Z にマップして前景 1 スライスを矩形へストレッチ。
- 画素→表示は canvas 2D（`toImageData`）で **W/L＋LUT** を適用。校正は `pixelCalibration.getModalityCalibration`
  に一元化（preScale 二重適用を防止）。
- LUT は canvas 経由（`lut` prop の r/g/b）。opacity は canvas の CSS opacity。

## 3. 実装した機能（2026-07-02）

### 3.1 オーバーレイの LUT 引き継ぎ
- タイルを別タイルへドラッグ重畳したとき、**ドラッグ元タイルで適用中の LUT** を Fusion オーバーレイの初期 LUT に引き継ぐ。
- 仕組み:
  - `Viewer2D` に現在の LUT データ（r/g/b 全体）を保持する `lutDataRef` と、`ViewerCommands.getLutData(): LutData|null` を追加（`applyLut` 時に `lutDataRef` を更新）。
  - `handleDrop`（tile→center）で `queryViewerCommand(payload.tileId, c => c.getLutData())` を取得し、`FusionOverlay.initialLut` として渡す。
  - `TileCell` の fusion 切替 effect で `setFusionLut(tile.fusion?.initialLut ?? null)`。
- ツリーからのシリーズ直ドロップは LUT 未適用のためグレースケール。Fusion 後もコントロールバーの「LUT」で変更可。

### 3.2 Fusion 後のオーバーレイ W/L 調整
- Fusion コントロールバー（`FusionControlBar`）に **W/L 数値入力（WL / WW）＋「自動」ボタン**を追加。
- 仕組み:
  - `FusionImageViewer` に `windowCenter?/windowWidth?`（上書き）と `onAutoWL(center,width)`（既定値通知）を追加。
    `runFusion` の `resolveWL` が「上書き値 > DICOM Window > 自動(平均±2σ)」で解決し、既定使用時は `onAutoWL` で親へ通知。
  - `TileCell` に `fusionWL`（上書き, null=自動）と `fusionAutoWL`（既定表示シード）を保持。入力表示は `fusionWL ?? fusionAutoWL`。
  - 入力の Enter/blur で `onWLChange`→`fusionWL` 上書き（即時再描画）。「自動」で `fusionWL=null`（既定へ復帰）。
- ※ 前景の値域が事前に不明なためスライダーでなく数値入力＋自動を採用。将来、左ドラッグで前景/背景を切替える Fusion 専用 W/L モードも拡張可能。

### 3.3 前景ボリューム範囲外のオーバーレイ消去 ★不具合修正
- **不具合**: 空間 Fusion で背景スライスが前景の z 範囲外でも、`computeFusionSlice` が範囲外を**末端スライスにクランプ描画**し（`iw<0`→先頭 / `iw>=d-1`→末尾）、`FusionImageViewer` も最近傍スライスを描き続けたため、**前景が存在しない断面に末端スライスが残り続けた**。
- **修正**（`FusionImageViewer.runFusion`）: 前景全スライスの法線投影位置から `[minW, maxW]` を求め、背景スライス位置 `w_center` が `[minW − margin, maxW + margin]`（`margin = sliceSpacing/2`）の**外なら `clearCanvas()` して何も描かない**。範囲内では従来どおり重畳。
- `clearCanvas()`（canvas を clearRect）を追加し、範囲外へ出た瞬間に前回描画を消す。

## 4. 関連修正: カーソル輝度値の小数表示（`Viewer2D.tsx`）

- テクスチャ可視化マップ等、**1 未満の小さな特徴値**が `Math.round` で 0 に丸められ「値が更新されない」ように見えた不具合を修正。
- `fmtValue()` を新設: |v|≥100 は整数〜1桁、1≤|v|<100 は3桁、|v|<1 は最大6桁（末尾ゼロ除去）、|v|<1e-4 or ≥1e6 は指数表記（例 `1.000e-5`）。
- SUV 値表示は臨床慣習の 2 桁（`toFixed(2)`）を維持。

## 5. 主なファイル

- `frontend/src/viewer/FusionOverlayViewer.tsx` — オーバーレイ描画・W/L 解決・範囲外消去。
- `frontend/src/viewer/fusionEngine.ts` — `computeFusionSlice`（trilinear 再構成, 範囲外 NaN）/ `toImageData` / `autoWindowLevel`。
- `frontend/src/viewer2d/Viewer2DScreen.tsx` — `FusionOverlay` 型 / `handleDrop`（LUT 引き継ぎ）/ `TileCell`（fusion 状態）/ `FusionControlBar`（opacity・LUT・W/L・C/T）。
- `frontend/src/viewer/Viewer2D.tsx` — `getLutData` コマンド / `lutDataRef` / `fmtValue`。
- `frontend/src/viewer/viewerCommands.ts` — `getLutData` を interface に追加。

## 6. 未対応・今後

- 非空間フォールバックは比例 Z のため厳密な範囲外判定なし（IOP/IPP 無しシリーズ）。
- Fusion 専用の左ドラッグ W/L モード（前景/背景切替）は将来拡張候補。
- 別患者タブ間の Fusion（比較ビューア）は別コンポーネントで将来対応（`fw/viewer-2d-screen.md`）。
