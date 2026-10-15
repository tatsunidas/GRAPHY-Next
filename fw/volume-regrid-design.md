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
- 格子の端点（元の先頭・末尾のボクセル中心ちょうど）は、index→world→index の往復で ±1e-15 ほど外れ、`sampleTrilinear` が NaN を返す
  （実測: 斜位で `i=0`・`j=0` の面が NaN になった）。`resampleToGrid` に縁の許容（`edgeTolerance`、保存では `GRID_EDGE_TOLERANCE`＝1e-6 voxel）を
  opt-in で足し、範囲内の格子で NaN を 0 個にする。既定は 0（プラグイン経路の挙動は変えない）。
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

## 7. 結合（複数ベッド・部分撮像のつなぎ合わせ）

> 実装: `frontend/src/viewer/volumeStitch.ts`（純関数のみ。DOM・cornerstone を import しない。`regGeometry.ts` と同じ契約）。上の 1〜6 は `gridResample.ts`（リサンプル）の設計で、結合は別の部品。

同じ座標系（FrameOfReferenceUID）・同じ向きで分けて撮った複数のシリーズを、患者座標で定義した和集合の格子へ引き直して 1 本の派生シリーズにする。重なりは覆っている入力の平均、どれも覆わない位置は余白値とし、PET/NM は減衰の基準が一致する場合に限る。

### 入力の条件（`checkStitchInputs`）

満たさなければ結合せず、違反した条件を返す（黙って通さない）。

| 違反 | 条件 |
|---|---|
| `tooFew` | 入力が 2 本未満 |
| `patient` | PatientID が全入力で同じ |
| `frameOfReference` | FrameOfReferenceUID が空でなく全入力で同じ |
| `orientation` | 行方向同士・列方向同士の内積（正規化後）がどちらも 1 − 1e-6 以上 |
| `modality` | モダリティが全入力で同じ |
| `petReference` | PT/NM を含むとき、減衰補正の種別・基準時刻・Units・半減期・投与量が全入力で同じ。**値が欠けている場合も違反** |

### 格子（`unionGrid`）

- 向き: 入力共通の IOP（列方向 rc・行方向 rr・法線 n = rc × rr）。
- 間隔: 軸ごとに入力の最小値（どの入力も粗くしない）。引数で上書きできる。
- 範囲: 各入力の 8 隅のボクセル中心を rc・rr・n へ射影した区間の和集合。`worldBounds` は LPS 軸平行の箱なので使わない。
- 原点: 法線方向で最も手前の入力の先頭ボクセル中心（その入力は補間なしで写る）。面内は、その入力を基準に他の入力の範囲を覆うまで格子間隔で延ばす。
- 枚数: `n = floor(L/s + 1e-9) + 1`（L は各軸の和集合の長さ）。
- `overlapMm`: 2 本以上が覆う法線方向の長さ。`gapMm`: 和集合の範囲内でどの入力も覆わない長さ（ボクセル中心の区間で測る）。

### 引き直し（`stitchToGrid`）

格子の各点を各入力の `sampleTrilinear` で引き、NaN でない入力だけを算術平均する。全入力が NaN の点は NaN のまま返す（0 にすると空気と区別できない）。NaN を余白値へ置き換えるのは符号化（`derivedSeriesEncode.encodeFrames` の `background`）の側。入力の端（浮動小数の丸めで 1e-6 index 程度はみ出す点）は端へ寄せて NaN にしない。

### 段の分け方

1. 平均のみ（本節）。
2. 線形の重み・優先、機械可読な出所の参照。
3. PET/NM の基準時刻をそろえる補正（扱いは未決）。
4. FrameOfReferenceUID が異なる入力は対象外（位置合わせしてからの結合は未決）。
