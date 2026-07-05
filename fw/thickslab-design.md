# ThickSlab（デジタルスライス厚）設計

> 作成日: 2026-07-05
> 対象: 2D Slice ビューア（`SeriesViewer` → `Viewer2D` = Cornerstone `StackViewport`）。
> 参照: 本家 `../GRAPHY` `Praparat.computeThickSlabProcessor` / RadiomicsJ `Utils.TrilinearInterpolation`。
> ⚠️ 着手前に [`cornerstone-3d-geometry-caveat.md`](cornerstone-3d-geometry-caveat.md) を読むこと。

## 1. 概要

現在スライス位置を中心に、スライス法線方向 ±(厚み/2) の範囲を近傍ネイティブスライスから
**Trilinear 補間（面内格子が共通なので Z 方向 1D 線形補間に縮退）**でサブサンプルし、
**平均合成（Average projection）**して 1 枚に畳む。MIP/MinIP は本家 ThickSlab に無いため平均のみ。

- On/Off ＋ 厚み選択（`0.1, 0.3, 0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 4.5, 5.0` mm）。
- **実スライス厚に一致する厚みが選ばれたら Original（合成しない）**（`|厚み − 間隔| < 0.01mm`）。
- **2D Slice(SliderView) のみ**。MPR / Slicer / Curved MPR は別ウィンドウ・別経路で**無効**（下記 §5）。
- **動画(MPEG 含む) SOP・単一スライス・カラー(RGB) では無効**（`isThickSlabAvailable`）。

## 2. Z インデックスモデル = デジタル再サンプル（本家 Praparat 準拠）

ON 時、スライダー母数を**デジタルスライス数**へ変える。`slicesPerStep = 厚み / 実スライス間隔`、
`digitalCount = ceil(nZ / slicesPerStep)`。厚み<間隔なら `slicesPerStep<1`（アップサンプリング）も許容。

| 写像 | 定義 |
|---|---|
| `digitalToFractionalOriginalZ(dz)` | `clamp((dz+0.5)*slicesPerStep, 0, nZ-1)`（合成の中心・連続値） |
| `digitalToNativeZ(dz)` | `round(digitalToFractionalOriginalZ)`（IPP/参照線/同期/onDimChange の native 位置） |
| `originalToDigitalZ(oz)` | `round(oz/slicesPerStep − 0.5)`（ON/OFF・厚み変更時に同じ物理位置を保つ逆写像） |

## 3. Cornerstone への注入（`viewer/thickSlab.ts`）

合成スライスは **`graphy-thickslab:` スキームのカスタム画像ローダ**で `StackViewport` へオンデマンド供給。
これにより W/L・ROI・LUT・affine・スライス同期・参照線の既存 2D パイプラインを**そのまま流用**する。

- imageId: `graphy-thickslab:<token>#<digitalZ>`。`token` = `encodeURIComponent(series|c|t|厚み|間隔|nZ|stackHash)`。
  同一パラメータ＝同一トークン＝imageId 配列が安定＝**StackViewport を再初期化しない**。
- ローダ: セッション（`nativeIds/spacingZ/厚み/slicesPerStep`）を引き、`readModalitySlice`（=
  `pixelCalibration` 単一入口）で**必要な近傍スライスだけ**校正済み float 取得 → Z 方向線形補間で
  サブサンプル（`n = clamp(round(rangeMm/等方ステップ),1,64)`）→ 平均 → `Float32Array` の IImage。
  `cache.putImageSync` は呼ばない（cornerstone の `putImageLoadObject` が resolve 時にキャッシュする）。
- メタデータ: **高優先プロバイダで中心ネイティブスライスへ委譲**。ただし
  **`modalityLutModule` だけ恒等（slope1/intercept0）**にして GPU 側 Modality LUT の**二重適用を回避**
  （合成は既に HU 等のモダリティ値空間。[[pixel-calibration-single-entry]]）。`imagePlaneModule` は
  中心スライスをそのまま継承（厚みのみ上書き）＝参照線・向き・座標同期が native と一致（単一幾何）。

## 4. ご質問への設計方針

- **Rotation/Zoom/Pan を無効化するか** → **しない**。スラブ合成は患者空間のスライス法線方向で行われ
  画面 affine と独立。無効化は技術的必要が無く UX 劣化。本家も同方針。**代わりに ROI・計測・ブラシ・
  Wand の作成/編集をブロック**（合成画像は単一 SOP に紐づかず注釈を安全に保存できない。
  `Viewer2D.setActiveTool` で `series.thickSlab.roiBlocked` を toast）。
- **ON 時に既存の表示状態（非デフォルト）を保つか** → **保つ**。`setStack` はカメラをリセットするため、
  `Viewer2D` が再構築の直前に `getViewPresentation`+`voiRange` を退避し、**同一シリーズ幾何
  （rows/cols/modality 一致）**のときだけ再適用する（別シリーズには持ち越さない）。副次的に C/T 切替の
  表示状態維持も改善（従来の既知の制限を解消）。

## 5. 他ビューモードへの影響（波及ゼロ）

5 モードは別ウィンドウ・別コンポーネント・別描画経路。2D=`StackViewport`、MPR=`VolumeViewport`、
Slicer/CurvedMPR=自前 canvas。ThickSlab は 2D 経路にのみ追加。

- **Slicer**: 既に `reslice.ts` `SlabSpec`（thickness/gap/numSlices/mode=MEAN/MAX/MIN/MEDIAN/MODE）で
  デジタルスライス厚を装備 → 委譲（変更なし）。
- **Curved MPR**: 既に `bandHalfWidthMm`＋`ProjectionMode`(MIP/MINIP/AVERAGE) を装備 → 委譲（変更なし）。
- **MPR**: 現状スラブ非対応の `VolumeViewport`。今回は対象外（将来 cornerstone ネイティブの
  `setSlabThickness`/`setBlendMode` で MPR 側だけに後付け可能。2D 実装とは無関係）。

## 6. 既存機能への影響と対応

- **ZCT インデックス**: ON 時は Z のみデジタルドメインへ（C/T は不変）。`digitalToNativeZ` で
  currentImageId・`ippAt`・`onDimChange`・参照線を native 位置へ写像。C/T スタックは native のまま。
- **スライス同期(`sliceSync`)**: `getState` を ON 時デジタル枚数＋`ipps[dz]=ippAt(digitalToNativeZ(dz))`
  に切替。他シリーズはテーブル位置 mm で一致判定するため native と整合。
- **プリフェッチ**: 専用機構は元々無い（オンデマンド）。ThickSlab は近傍数枚を `readModalitySlice` で
  読むのみ＝既存に非依存。
- **GridView / シネ / Undo/Redo / Fusion**: 送り母数は `activeCount`（ON=デジタル）。GridView は
  ThickSlab 無効（`thickAvailable` は `!gridOn`）。Undo/Redo は表示状態のみで不変。

## 7. 実装ファイル

- `frontend/src/viewer/thickSlab.ts`（新規）: 写像純関数・利用可否・セッション登録・合成ローダ・メタデータ委譲。
- `frontend/src/viewer/cornerstoneSetup.ts`: `registerThickSlabLoader()` を init で 1 回。
- `frontend/src/viewer/SeriesViewer.tsx`: state(On/厚み/間隔)・デジタル写像・合成 imageId・sync 写像・UI。
- `frontend/src/viewer/Viewer2D.tsx`: `thickSlab` prop（ROI/計測ブロック）・表示状態の退避/再適用。
- `frontend/src/i18n/{ja,en}.ts`: `series.thickSlab*`。

## 8. 未確認・将来

- **実機確認**: Float32 の合成 StackViewport の描画（WebGL2 float テクスチャ）、W/L・カーソル HU の一致、
  デジタル送り・同期・参照線の追従。tsc は green。
- PET SUV シリーズの ThickSlab は SUV 窓/値が合成 id に載らない（`suvForImageId` は実 id キー）。要検討。
- `sessions` Map は (series×C/T×厚み×スタック) 分たまる（実質小）。長時間運用で気になれば LRU 化。
- MIP/MinIP を選べる拡張（本家 ThickSlab には無いが要望次第）。
