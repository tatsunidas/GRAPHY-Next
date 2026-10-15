# スライスの奥行き（間隔）の決め方

最終更新: 2026-10-15。実装: `frontend/src/viewer/sliceGeometry.ts`（決め方・分類）、`depthVolume.ts`（3D/MPR の補間・ROI の体積）、
`roiVolumeMesh.ts`（メッシュの体積）、`maskVolume.ts`（2D の文脈づくり）。

## 1. 目的

画像のスライス間隔は、タグごとに意味が違い、欠けたスライスや間引きでは「間隔は 1 つ」という前提が崩れる。
場所ごとに別々の読み方をしていると、同じ ROI の体積が 2D と 3D で食い違う。
そこで「奥行きの決め方」「並びの分類」「体積の求め方」を 1 か所に決め、各機能はそれを使う。

## 2. 奥行きの優先順位

| 順位 | `source` | 出どころ | 扱い |
|---|---|---|---|
| 1 | `ipp` | ImagePositionPatient (0020,0032) を、ImageOrientationPatient (0020,0037) の行×列で作った法線へ射影した位置 | 実空間の直交距離。mm・mL を出す |
| 2 | `sbs` | SpacingBetweenSlices (0018,0088) | mm・mL を出す。体積はタグの値を信じる |
| 3 | `thickness` | SliceThickness (0018,0050) | 隙間・重なりが無いとした**推定**。mm・mL に「推定」を付ける |
| 4 | `unknown` | 何も無い | 1 mm として描く。mm・mL は出さない |

DICOM の定義と、使い分けの理由:

- **IPP / IOP**: IPP は左上画素の中心の患者座標（mm）、IOP は行方向・列方向の単位ベクトル。法線 = 行 × 列。
  スライスの位置は IPP と法線の内積。スライス番号や InstanceNumber ではなく、実際の位置で並べる。
- **SliceThickness**: 断面の公称の厚み。隣との距離ではない（隙間・重なりがあれば違う）。位置が無いときの最後の手段。
- **SpacingBetweenSlices**: 隣り合うスライスの**中心どうしの距離**（厚みに隙間を足した、または重なりを引いた値）。
  NM では符号付きで、負は最初の画像の手前に並ぶ。大きさだけを間隔に使う。
- **SliceLocation**: 基準点が装置ごとに違うので使わない。

## 3. 並びの分類

許容値 = max(0.01 mm, 公称間隔の 1%)。0.01 mm は IPP の DS 値（16 文字まで）の丸め誤差の大きさ、1% は 1 ボクセルの 1/100。

| `kind` | 条件 |
|---|---|
| `single` | 1 枚 |
| `duplicates` | 隣どうしの距離が 0.01 mm 以下 |
| `uniform` | 先頭からの等間隔の格子とのずれの最大が許容値以内 |
| `missing` | 不均一で、すべての間隔が最小の間隔の整数倍（誤差 10% 以内）。欠けた枚数 = Σ(倍数 − 1) |
| `irregular` | 上のどれでもない |

`missing` の整数倍の許容を 10% にしたのは、装置の位置誤差（数%）を吸収しつつ、1.5 倍のような半端な間隔を整数倍と誤認しないため。

## 4. 各機能の扱い（今回）

### 3D / MPR の体積（`viewer/mpr.ts` `buildMprVolume`）

- `uniform` / `single`: 従来どおり、奥行きの順（`geometry.order`）に並べた imageId でボリュームを作る。
- `missing` / `irregular`: 最小の間隔の均一な格子に取り直し、**奥行き方向だけ**を線形補間したローカルボリュームを作る
  （面内は触らない。値は校正済みのモダリティ値を Float32 で持つ）。元スライスは最寄りの格子にそのまま写し、
  その間の面を前後の元スライスまでの距離で重み付けして補間する。補間した面は画像として存在しない。
  ヘッダに注記を出す（`data-testid="volume-depth-note"`）。
- `duplicates`: ボリュームを作らず、理由を出す（`SliceDuplicatesError`）。
- 結果に `geometry`（SliceGeometry）と、補間したときは `grid`（`count` / `spacing` / `gridIndexOf`）を持たせる。
- CT でガントリチルト補正が要るときは従来の補正経路（補正済みの直交ボリューム）。奥行きの分類は返すが、補正経路は補間しない。

注記の出し分け: `missing`「欠けたスライス（n 枚）を補間」、`irregular`「不規則な間隔を補間（元 n 枚 → m 枚、x mm）」、
`sbs` / `thickness` / `unknown` はその旨。IPP で均一なら出さない。

### 2D の ROI を 3D に取り込む（`maskFrames.framesToLabelVolume` / `rtstructToLabelVolume`）

フレーム・輪郭が参照する画像（SOP）で、元スライスの添字 → 格子の番号（`gridIndexOf`）に当てる。
元スライスの間は**埋めない**。均一なシリーズは従来と同じ。

### 体積（メッシュの規則）

塗りの体積は、スライスごとの輪郭（`maskContour.traceMaskContours`、画素の境界をなぞった多角形）を実際の位置に置いて作る角柱の和。

- 場 F = (0, 0, z)（z は法線方向）に発散定理を使うと、側面は法線が F に直交して寄与 0、上下の面だけが残る。
  角柱 1 つの体積 = **断面の面積 × スライスの幅 wᵢ**。断面の面積は輪郭の符号付き面積（穴は引く）。
- スライスの幅 wᵢ = 前後への距離の半分ずつ（端は隣への距離）。均一なら全部が間隔に等しく、合計は N × 間隔。
- 均一な間隔では、ボクセル数 × ボクセルの体積と一致する。不均一では Σ 面積 × wᵢ（均一とみなした値とは違う）。
- 2D の Σ³（行内）、Σ の窓、3D の ROI の体積は、すべてこの計算（`roiVolumeFromSlices`）。
  3D の表示用の滑らかなメッシュ（平滑化後）の体積は見た目だけに使い、体積としては出さない。
- 出せないとき（PixelSpacing が無い、奥行きが `unknown`、位置の重なり）は mL を出さず（0 で埋めない）、理由を警告で出す。
  `thickness` は出すが「推定」の警告を付ける。
- 2D → 3D は、2D 側で求めた値を、ウィンドウ間の受け渡し（`MaskFramesInput.volumeMm3` / `depthSource`）に載せて 3D が「体積」として表示する。
  サーバの SEG・RTSTRUCT を 3D で取り込んだ ROI は、3D 側で、元スライスに当たる格子の面だけを使い、
  ボリュームの SliceGeometry の幅で求める（補間した面は使わない）。
- 計測値（体積・平均など）は常に元のスライスから求める。補間した面は計測に使わない。

### 3D の ROI の見た目も同じ形（`viewer/slabMesh.ts`、2026-10-15）

- 3D の ROI の表示用メッシュは、体積を求めたのと同じ「各スライスを実際の位置と幅 wᵢ で立ち上げた形」にする。
  前景の画素ごとの箱（列 × 行 × その層の奥行きの範囲）の、外に面した面だけを出した閉じた面。
  1 枚だけの ROI も、そのスライスの幅の板として見える。
- 層の奥行きの範囲は、元のスライス i なら前後のスライスとの中点まで（端は隣への距離の半分を外にも）。
  補間で作った層は範囲を持たない（ラベルがあるときだけ、その層の格子の範囲で描く。表示だけ）。
- 以前のマーチングキューブ（等値 0.5）＋平滑化では、1 層の ROI が格子の間隔ぶんの厚みにしかならず、
  端の層は面が閉じず、平滑化でさらに痩せて紙のように見えていた（見た目と体積の幅が食い違っていた）。
- 既定は平滑化しない（階段状）。オブジェクトごとに「なめらかに表示」を選べる。選んだときは形が少し痩せるので、
  体積の横に「平滑化前の形の値」と出す（体積は常に平滑化前の形の値）。
- プラグインにメッシュを渡す口（`pluginMeshApi` → `roiMesh.labelVolumeToMesh`）は、平滑化の回数を選べる公開の約束なので、
  今のマーチングキューブのまま変えていない。

## 5. 呼び出し箇所

### 今回対応

| 箇所 | 内容 |
|---|---|
| `viewer/mpr.ts` `buildMprVolume` | 分類・補間・重なりの拒否 |
| `viewer3d/Viewer3DScreen.tsx` | 注記、SOP → 格子、体積の奥行きの文脈 |
| `mpr/MprScreen.tsx` | 注記、重なりの理由 |
| `viewer/maskFrames.ts` `framesToLabelVolume` | SOP → 格子 |
| `viewer/rtstructToLabelVolume.ts` | SOP → 格子 |
| `viewer/maskFrames.ts` `extractMaskFrames` | 2D の体積をウィンドウ間の受け渡しに載せる |
| `viewer/roi3d.ts` `maskVolumeStats`（Σ³） | メッシュの体積、警告 |
| `viewer/roi3d.ts` `computeMaskStatsAsync`（Σ の窓） | 同上 |
| `viewer3d/scene3d.ts` `addRoiObject` ほか | 3D の ROI の体積 |
| `viewer3d/SceneObjectPanel.tsx` | 「体積」1 つ（ボクセル数は別項目） |
| `viewer/segExport.ts` | SegmentDescription の体積が無いとき `n/a` |

### 次の段

| 箇所 | 現状 |
|---|---|
| ThickSlab（`viewer/thickSlab.ts`） | 間隔を 1 つ仮定 |
| Image Info（`viewer/imageInfo.ts` `computeSliceSpacing`） | 先頭 2 枚だけで決める |
| プラグインの間隔・派生シリーズの保存（`plugins/pluginVolumeApi.ts`、`viewer/derivedVolumeSave.ts`） | 均一前提 |
| SEG の書き出し（バックエンド `SegExportService`） | SliceThickness に SpacingBetweenSlices を入れている |
| 位置合わせのボリューム読み込み（`viewer/regVolumeLoader.ts`） | 最初の 2 枚で間隔を決める。重なりで特異になる |
| フュージョン（`viewer/fusionEngine.ts`） | 既定 5 mm を使う箇所がある |
| Curved MPR（`curvedmpr/`、`viewer/curvedReformat.ts`） | 自前のボリューム構築で、補間しない |
| 斜め断面の画面（`slicer/`） | `buildMprVolume` は通るが注記が無い |
| バックエンドの Radiomics / Texture | 間隔の決め方が別 |
| NIfTI の取り込み（`NiftiToDicom`） | SliceThickness = 間隔 |
| 拡張 CT/MR のマルチフレーム | フレームを展開していない |
| 3D のボリュームの向き（direction 行列） | 行と列の取り違えの疑い。別途確認 |
