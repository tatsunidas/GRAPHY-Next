# ボリュームの再格子化（リサンプル）と派生保存 設計

表示中のシリーズを、患者座標（LPS mm）で定義した新しい格子（等方間隔・軸ごとの間隔）へ線形補間で引き直し、
派生シリーズとして保存する。範囲外は NaN とし、保存時に余白値（PixelPaddingValue）で埋める。

## 1. 段の分け
- **第 1 段（本書の実装範囲）**: 元の範囲全体を、等方または軸ごとの間隔へ。補間は線形のみ。
- 第 2 段: 切り抜き・余白付加・自動クロップ（範囲欄）。必要なら Worker 化。
- 第 3 段: 別シリーズの格子（同じ FoR のみ）と最近傍補間。
- 第 4 段（判断待ち）: 縮小時の平滑化。
- 変換行列の適用は含めない（空間変換の管理側で扱う）。

## 2. 構成
| 部品 | 場所 | 役割 |
|---|---|---|
| 格子と再サンプル | `viewer/gridResample.ts` | 純関数。cornerstone を import しない。`isotropicGrid` / `axisGrid` / `resampleToGrid` / `estimateGridBytes` |
| 保存要求の組み立て | `viewer/derivedVolumeSave.ts` | 純関数 `buildDerivedVolumeRequest` と POST `saveDerivedVolume` |
| UI | `viewer2d/ResampleDialog.tsx` | 2D ビューア > 画像 > リサンプル・切り抜き… |
| プラグイン用 | `plugins/pluginResample.ts` | `resampleToGrid` へ委譲するだけ（答えを 2 つにしない） |

読み込みは `loadRegVolume`（校正は `pixelCalibration` 経由、法線方向で並べ替え）。サンプルは `regGeometry.sampleWorld`。
符号化は `encodeFrames`、保存は既存の `POST /api/series/derived`（backend は変えない）。

## 3. 格子
- 向き: 元の IOP の列方向・行方向と、その外積の法線（正規直交）。原点: 元の先頭ボクセル中心。
  ガントリチルトの元は法線方向へ直交化される（出力は直交格子。チルトの角で元の範囲外になる点は NaN）。
- 各軸の長さ L（先頭〜末尾ボクセル中心間）: 列・行は `(n-1)·間隔`、スライスは `(末尾IPP−先頭IPP)·法線`。
- 出力点数 `n = floor(L/s + 1e-9) + 1`。`sampleTrilinear` は index が `n-1` を僅かでも超えると NaN になるので、末尾は内側に収める。
- `s <= 0` や非有限値は例外。
- データ順は `data[k·ny·nx + j·nx + i]`。`spacing = [列方向, 行方向, スライス]`。DICOM の `PixelSpacing = [行間隔, 列間隔]` とは順が逆なので保存層で入れ替える。

## 4. 保存
- k 枚目の IPP = `indexToWorld·(0,0,k)`、IOP = 元の IOP（DICOM 規約の順）。
- `pixelSpacing = [行間隔, 列間隔]`、`spacingBetweenSlices = s_k`、`sliceThickness` は元の値（補間で取得時の厚みは薄くならない）。無ければ出力間隔。
- `encodeFrames(frames, background)` で Int16 + Rescale。NaN は `background` で埋め、`pixelPaddingValue` に格納値を記録する。0 では埋めない。
- **背景値の既定**: 元の有限最小値。`loadRegVolume` は PixelPaddingValue を返さないため、元の PixelPaddingValue は使えない
  （第 1 段は元の範囲内だけを扱うので、斜位では NaN は出ず、チルトの角でだけ使われる）。
- **SUV 校正中の PET**: `loadRegVolume` は SUV 乗数込みの値を返す。保存前に `suvForImageId(firstImageId).scale` で割り、
  モダリティ値（Bq/mL）へ戻す。そうしないと Units と値が食い違い、開き直すと二重に SUV 化される。

## 5. メモリ・確認
出力の Float32 の大きさを `estimateGridBytes` で出す。`getAppliedVolumeMaxMb()` を超えるなら `window.confirm`。
キャンセルで何も保存しない。Worker 化は第 2 段。

## 6. 既知の限界（第 1 段）
- `loadRegVolume` は読めなかったスライスを黙って飛ばし、スライス間隔を先頭 2 枚の IPP 差で決める。
  ダイアログに「読み込めた枚数 / シリーズの枚数」を並べて出す。保存を拒否するかは未決定。
- 縮小は平滑化なしの点サンプル（エイリアスが出る）。SUVmax・最大値は格子で変わる。
- 600 枚級の JSON 送信と 512×512×600 の処理時間は未測定。
- 研究・解析の前処理であり、診断値を作る機能ではない。派生であることは ImageType と DerivationDescription に残る。
