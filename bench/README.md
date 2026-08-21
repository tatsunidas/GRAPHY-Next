# GNBP — GRAPHY-Next Benchmark Phantom

GRAPHY-Next の性能・正確性を評価するためのデジタルファントムと、その生成器・計測ハーネス。

読み込み時間・フレームレート・メモリといった負荷の測定だけでなく、**解析的に真値が既知**の
データを使って計測そのものの正確性（HU 校正・座標変換・体積・**レジストレーション**）も
検証できるようにしてある。

| 系列 | 目的 | 正本 |
| :- | :- | :- |
| **GNBP-1A / 1B** | 正確性（体積・距離・HU）／ 性能（負荷スケーリング） | この README |
| **GNBP-2R** | **レジストレーション精度**（剛体・アフィン・非剛体・マルチモーダル） | この README ＋ `fw/registration-design.md` §9.1 |
| **GNBP-5N** | **縦断 SPECT の位置合わせ**（腫瘍が出現・変化・消失する） | この README ＋ `fw/registration-design.md` §9.5 |
| **GNBP-4D** | **劣化系列**（属性をわざと欠落させたデータ） | この README |
| **GNBP-XA** | **アンギオ（XA）**: QCA 精度・DSA・空間校正の分岐 | この README ＋ `fw/angio-design.md` §16.3 / §16.4 |

## なぜ2系列あるのか

性能試験と正確性試験は、データに求める性質が正反対のため分けてある。

| | GNBP-1A | GNBP-1B |
| :- | :- | :- |
| 目的 | **正確性**（体積・距離・HU） | **性能**（負荷スケーリング） |
| 中身 | 3D Shepp-Logan ＋ HU ステップウェッジ | ノイズ入り腹部様＋螺旋血管＋高コントラスト構造 |
| ノイズ | 無し（真値が厳密に決まる） | σ = 20 HU（実再構成に近い負荷） |
| ジオメトリ | 512×512×180、0.5 mm、スライス厚 1.0 mm | 512×512×{64,128,256,512}、0.78125 mm、スライス厚 5.0 mm |
| 真値 | 楕円体の解析体積・主軸長・HU | 血管中心線の閉形式のみ |

- Shepp-Logan は滑らかで低コントラスト・ノイズ無しのため、**圧縮もレンダリングも軽い**。
  これで fps を測ると実臨床より良い値が出るので、性能評価には使わない。
- 逆にノイズを載せると HU の真値が統計的になり、正確性の基準にならない。

## GNBP-XA — アンギオ（X 線投影）

```bash
python3 make_phantom_xa.py --out ./phantom        # 17 ファイル
cd ../automator && npx tsx src/spike/xaPhantomCheck.ts     # QCA・校正の精度
cd ../bench && python3 check_xa3_geometry.py               # 3D の幾何整合
cd ../bench && python3 check_xa2_motion.py                 # DSA: 体動が回収できる形か
cd ../automator && npx tsx src/spike/xaDsaPhantomCheck.ts  # DSA: 体動の自動推定の精度
```

| 系列 | 中身 | 与える真値 |
| :- | :- | :- |
| **GNBP-XA-1** | 直管 3.0mm ＋ 既知 %DS（0/30/50/70/90）・既知長（5/10/20mm）・ぼけ 2 段・ノイズ 3 段の **11 フレーム** | MLD・RVD・%DS・病変長の解析解 |
| **GNBP-XA-2** | 背景（骨相当＝斜めの帯・脊椎・椎体の切れ目・点状の塊）＋マスク 5 ＋造影 20 フレーム、**既知の平行移動**を注入（整数 (3,−2) ／ 探索半径超え (−4,5) ／ **端数 (1.4,−0.6)**） | マスクフレーム・造影到達フレーム・注入したシフト量 |
| **GNBP-XA-3** | **1.1 回転する先細りの螺旋＋分岐**を既知の 4 方向で順投影（単一フレーム × 4 シリーズ）。同じ画像で**タグの角度にだけ既知誤差（±1〜3°）を混ぜた版**も作る | 3D 中心線（患者 LPS mm）・枝ごとの長さと径・注入した角度誤差 |
| **GNBP-XA-4** | 同一画像に**タグの書かれ方 5 変種**（FIDUCIAL / GEOMETRY / Imager と同値 / PixelSpacing 無し / 幾何タグも無し） | mm/px の真値と、`§7.2` が通るべき経路 |
| **GNBP-XA-6** | 既知の拡張（瘤）。紡錘状／嚢状／軽度／拡張無しの 6 フレーム（⚠ XA-5 は左室に予約済み） | 最大径・拡張比・瘤長・偏心度 |
| **GNBP-XA-7** | **断面の形だけを変えた 5 フレーム**（円／横長楕円／縦長楕円／三日月／D 型）。前 3 つは**断面積が厳密に同じでシルエットの幅だけ違う** | 断面積・**面積等価直径**・**シルエット幅**の両方（どちらを測る方式かで正解が変わるため） |
| **GNBP-XA-8** | **健常部は円柱・病変部だけ非円形**の 5 フレーム。**5 本とも病変の断面積は同じ**（健常部の 50%）で、**シルエットの幅だけ 1.50〜3.00mm と 2 倍違う** | 病変の断面積・面積等価直径・シルエット幅・**面積で見た %DS と外形で見た %DS の両方** |

> 🚨 **XA-2 の背景を、向きの揃った構造だけで作らないこと**（2026-08-18 に実測して判明）。
> 斜めの帯は**帯の向きへ平行移動しても像が変わらない**（アパーチャ問題）ので、その向きの
> 体動は画像から**原理的に回収できない**。旧版はこれで、「体動を 0.2px で当てられるか」を
> 測っているつもりが**答えの無い問いを投げていた**。`python3 check_xa2_motion.py` が
> 「どの向きへ 0.5px ずらしても残差が上がる」ことを毎回測る（旧背景 −2.0% / 新背景 +12.6%、
> 閾値 +2%＝**この検査が旧版を落とせること**も測ってある）。
> **注入する体動に端数を必ず混ぜる**こと——整数だけだと推定器の「詰め」の段が一度も
> 試されないまま「達成」になる。
>
> **XA-7 は「エッジ検出と密度計測のどちらを採るか」を決めるための系列**（設計 §16.5）。
> 円柱では シルエット幅 ＝ 面積等価直径 になってしまい、**方式の違いが出ない**。
> 実験は `python experiment_qca_edge.py`。
>
> **XA-8 は「決めた方式がアプリの運用で本当に効くか」を測るための系列**（設計 §16.5.3）。
> ⚠️ **XA-7 では測れない**——あちらは各フレームが一様な非円形断面なので、アプリのように
> 「健常部に円柱を当てはめて μ を得る」運用だと**健常部の当てはめが必ず外れる**。
> XA-8 は健常部を円柱に保つので、アプリを一切変えずに通せる。
> 形のパラメータは「面積が目標になる」ように**二分法で解いて**いる（形ごとに解析解を書くと
> 真値が形ごとに別の近似で決まる）。検証は `automator/src/spike/xaLesionShapeCheck.ts`。

### GNBP-XA-3 で気をつけたこと

- 🚨 **直線や単純な円弧で作らない**。三角測量は対応点さえ正しければ厳密に解けるので、
  対応付けが自明な形状では**再構成器ではなく三角測量の式を検算しているだけ**になる。
  投影で**自己交差**し、**曲率が場所で変わる**形にしてある。
- 🚨 **画像は真の角度で描き、タグの角度だけ狂わせる**。こうしないとバンドル調整が
  回収すべきものが存在しない。
- ⚠️ **角度誤差版で「中心線が血管から外れること」を合否にしてはいけない**。主枝は径 3.5mm
  （≈15px）あるので、数度のずれでも中心線は血管の内側に留まる（最初にそう書いて誤って
  失敗した）。`check_xa3_geometry.py` は**変位量を px で測る**（実測 平均 2.0〜7.5px）。
- ⚠️ **このファントムは DICOM の角度定義そのものを検証できない**。生成側と再構成側が
  同じ規約を共有しているので、**規約が間違っていても一致する**。検証できるのは
  「その規約のもとで三角測量とバンドル調整が正しく働くか」まで。

**なぜ要るのか**: 公開されている冠動脈アンギオのデータセットは、患者情報除去のため
ほとんどが **DICOM から PNG/npz へ変換済み**で、`ImagerPixelSpacing` や `DistanceSourceTo*`
といった**幾何タグが失われている**。実 DICOM が手に入る Rubo のサンプルも空間校正タグを
一切持たない。つまり **QCA の精度も校正の分岐も、公開実データでは検証できない**。

**分かったこと**（詳細は `fw/angio-design.md` §16.4）:

- ✅ 空間校正は **5 変種すべて期待どおりの経路に解決、mm/px 誤差 0%**。
  実データでは踏めない P1〜P4 をここで初めて通した。
- 🔴 **半値法では径の絶対値が 13% 過小**（真値 3.000mm → 2.609mm）。実装ミスではなく、
  **半値法を円柱投影に当てたときの解析的な帰結**（半値点は √3/2·r ≈ 0.866·r）。
  %DS は比なので大部分が打ち消されるが、MLD/RVD の絶対値には効く。
  ✅ **2026-08-18 に解消**（A4c・`fw/angio-design.md` §16.5.1）。報告する径を**密度計測**に
  したので、アプリ通しの実測で **3.001mm / 真値 3.000** まで合うようになった。
  ⚠️ **「13% 過小」を定数として持ち回らない**——係数は断面の形で **0.745〜0.918** まで動く
  （GNBP-XA-7 で実測）。0.870 は**円柱に固有の値**。
- 🔴 **半値法は「面積が半分の狭窄」を見落とすことがある**（**GNBP-XA-8**・2026-08-18）。
  健常部を円柱に保ち病変部だけ形を変えた系列で、**5 本とも断面積は同じ（健常部の 50%）**
  なのに半値法の %DS は **1.7〜51.7** に散った。**ellipse-wide と d-shape は「狭窄なし」**
  （%DS 0.1）に見える。密度計測は 5 本とも 29.1〜30.0（真値 29.3）で、**MLD の幅は 0.025mm**。
- 🔴 **アプリ側の実バグを 3 件検出**: ①XA の 1 枚目が「次のフレーム」の画素になる競走
  （プリウォームのガードが未配線）②単一フレーム XA で校正・QCA の導線がまるごと出ない
  ③解析失敗時に検証用スナップショットが前の値のまま残る。
  **どれもフレームごとに中身が違うファントムでしか見えない**。

## 再現性

生成物は**バイト単位で決定的**。UID は固定ルート＋パラメータの SHA-256 から導出し、
ノイズは固定シード、Implementation Class UID も固定してある（ここを `generate_uid()` に
すると毎回変わって再現性が壊れる。実際に一度踏んだ）。

検証済み: 同じコマンドで2回生成し、全ファイルの MD5 が一致することを確認。

```
GNBP-1A            180 files   90.2 MiB  md5 325737ca08213ffa5f9d024620f32d6a
GNBP-1B_64          64 files   32.1 MiB  md5 d2e21d18f4b984973e1cb6de2315869b
GNBP-1B_128        128 files   64.2 MiB  md5 3027c530c11791c79fb72cfee0a7e0c4
GNBP-1B_256        256 files  128.5 MiB  md5 5bbd10354392e8efa448dca9b7c8267d
GNBP-1B_512        512 files  257.0 MiB  md5 19814798810c9d42fe0fe703f78e565b
GNBP-2R-fixed      176 files   22.3 MiB  md5 a67bac27fa078ac69ce57a455e962a32
GNBP-2R-rigid      176 files   22.3 MiB  md5 53f43afd928d1f9e32b8ce5d2e84630d
GNBP-2R-affine     176 files   22.3 MiB  md5 a34a21b9c684b33a523a6b1ef069323b
GNBP-2R-deform     176 files   22.3 MiB  md5 883342f536fb9381c99c89567ba2cd87
GNBP-2R-multimodal  88 files    2.9 MiB  md5 c2ad865f77eab00e2a3163fc029f5008
```

（MD5 は系列内の全ファイルをファイル名昇順に連結したものに対する値。
正典は `phantom/GNBP-1A_ground_truth.json`・`phantom/GNBP-1B_manifest.json`・
`phantom/GNBP-2R_ground_truth.json`。）

第三者は外部データセットのダウンロードを要さず、生成器を実行するだけで同一のデータを得られる。

## DICOM 属性

実 CT と同等の属性を書いている。最小限のヘッダだと、ビューアのメタデータ経路が検証されず、
また他ツールへ持ち込んだときに「このファントムだから動かないのか、実装が悪いのか」の切り分けが
できなくなるため。

- **Image Plane**: `ImageOrientationPatient (0020,0037)` = `1\0\0\0\1\0`（純アキシャル・傾き無し）、
  `ImagePositionPatient (0020,0032)`、`SliceLocation`、`PixelSpacing`、`SliceThickness`、
  `SpacingBetweenSlices`、`FrameOfReferenceUID (0020,0052)`
- **General Series**: `PatientPosition` = `HFS`（IOP と整合）、`BodyPartExamined`（A=HEAD / B=ABDOMEN）、
  `ProtocolName`、`Laterality`
- **General Image**: `AcquisitionNumber`、`PatientOrientation` = `L\P`、`BurnedInAnnotation` = `NO`、
  `LossyImageCompression` = `00`、`ImageComments`
- **CT Image**: `RescaleIntercept/Slope/Type`、`WindowCenter/Width` とその説明、`KVP`、
  `GantryDetectorTilt` = 0、`ConvolutionKernel`、`ScanOptions`、`FilterType`、`RotationDirection`、
  `DataCollectionDiameter` / `ReconstructionDiameter`、`DistanceSourceToDetector/Patient`、
  `ExposureTime` / `XRayTubeCurrent` / `Exposure` / `GeneratorPower` / `FocalSpots`
- **General Equipment**: `InstitutionName`、`StationName`、`DeviceSerialNumber`、`SoftwareVersions`

**合成データであることをヘッダで明示している**（実症例と取り違えられないため）:

- `ImageType` = `DERIVED\SECONDARY\AXIAL`（`ORIGINAL\PRIMARY` にはしない）
- `ImageComments` = "Synthetic digital phantom generated for benchmarking; not a real acquisition"
- `PatientIdentityRemoved` = `YES` / `DeidentificationMethod` = "Synthetic phantom; contains no real patient data"

撮影パラメータ（管電圧・管電流・曝射時間など）は**名目値であり実測ではない**。
計算で作った画像なので対応する曝射は存在しない。上記3つの属性でその旨が読み取れるようにしてある。

## GNBP-1A — 正確性

3D Shepp-Logan（10 楕円体）を CT として符号化したもの。

- **幾何パラメータの出典**: Kak AC, Slaney M, *Principles of Computerized Tomographic
  Imaging* (1988), Table 3.2 p.102（[errata](https://www.slaney.org/pct/pct-errata.html) 適用済み）。
  強度は Toft/Schabel 版。広く流通する `phantom3d.m` と `tsadakane/sl3d` の
  Toft-Schabel variant を突き合わせ、一致を確認したうえで転記した。
- **スケール**: 1 Shepp-Logan 単位 = 100 mm。外殻楕円体は 138×184×162 mm となり頭部大。
- **HU への写像**: `HU = 1200 × I − 200`。ファントム外は −1000 HU（空気）。
  この写像により 頭蓋 = 1000 HU、実質 = 40 HU、心室 = −200 HU、結節 = 160 HU。
  Shepp-Logan の強度は無次元なので、写像は恣意的だが**明示してあるので可逆**。
- **部分体積**: 1 ボクセルあたり 4³ = 64 点でスーパーサンプリングし、境界は
  物質と空気の体積比で混合する。これをしないと境界がエイリアスして「解析的真値」が
  境界で意味を失う。
- **空気と心室の区別**: 修正 Shepp-Logan では心室の正味強度が `1.0 − 0.8 − 0.2 = 0` で、
  背景と同値になる。そのため外殻楕円体の被覆率を別に保持して物質の有無を判定している。

### 検証できること

| 対象 | 真値 | 検証項目 |
| :- | :- | :- |
| 結節 A–E（直径 4.6〜10 mm） | 体積 `4/3·π·a·b·c`、主軸長 | 3D ROI 体積の誤差、距離計測の誤差、部分体積の扱い |
| 心室・上部腫瘤・外殻 | 同上 | 大きい ROI での体積精度 |
| HU ステップウェッジ 7 段 | −1000 / −500 / −100 / 0 / +100 / +400 / +1000 HU | **モダリティ LUT の正しさ**（校正値の二重適用を検出できる） |
| 各領域 | 頭蓋 1000 / 実質 40 / 心室 −200 / 結節 160 HU | HU 統計の正確性 |

ステップウェッジは |x| > 80 mm に置いてあり、外殻楕円体（x 半軸 69 mm）に決して
掛からないので Shepp-Logan の真値を乱さない。

### 生成器の自己検証

生成後、17 か所の均一領域を実際に測って解析値と比較する。全点で完全一致（SD 0.0）を確認済み。
※ これは**生成器が正しいことの確認**であって、ビューワの精度検証ではない。

## GNBP-1B — 性能

腹部様の断面にノイズと高コントラスト構造（椎体・肋骨弓・造影血管・3 病変）を載せたもの。
64 / 128 / 256 / 512 枚の4水準で生成し、**ボリュームサイズに対するスケーリング**を測る。

血管は螺旋で、中心線が閉形式で分かる:

```
x(z) = Rx · cos(2π z / L),   y(z) = Ry · sin(2π z / L)
```

ノイズがあっても中心線の真値は厳密なので、中心線抽出と CPR ストレート化の妥当性は
この系列でも確認できる。

## GNBP-2R — レジストレーション精度

GNBP-1A と同じ 3D Shepp-Logan を、**既知の変換で動かした** 5 系列。変換が閉形式で分かっているので、
TRE も変位場の誤差も厳密な真値を持つ。真値の正本は `phantom/GNBP-2R_ground_truth.json`。

| 系列 | 変換 | 検証できること |
| :- | :- | :- |
| `GNBP-2R-fixed` | 恒等（基準） | — |
| `GNBP-2R-rigid` | 並進 `[7.3, −4.1, 11.6]` mm ＋ 回転 `[3.2, −1.7, 5.5]`° | 剛体推定の残差 |
| `GNBP-2R-affine` | 剛体 ＋ 異方スケール ＋ せん断 | アフィン推定の残差 |
| `GNBP-2R-deform` | 剛体 ＋ 解析的変位場（最大 ~15 mm） | 変位場 RMSE、Jacobian 負値率 |
| `GNBP-2R-multimodal` | 剛体 ＋ **非単調な強度写像** ＋ PSF ＋ Poisson ノイズ、2 mm 格子 | マルチモーダル指標の妥当性 |

**moving は fixed を補間して作っていない。** 変換した座標で解析的に評価して生成している。
補間で作ると真値が「補間についての真値」になってしまい、測っているのが実装の誤差なのか
生成時の補間誤差なのか分からなくなる。

**向きの規約**（これを取り違えると、間違った答えに満点を与えるファントムになる）:

> `transform_fixed_to_moving` は **fixed の点 → 同じ解剖が写っている moving の点**（`q = T(p)`）。
> これがレジストレーションの推定対象であり、GRAPHY が `computeFusionSlice(fg, bg, xf)` に
> 渡す `xf` と同じ向き。生成時に使う逆写像は真値ではない。

オイラー角は `R = Rz·Ry·Rx`（度・患者 LPS・右手系・体積中心まわり）で、
`frontend/src/viewer/regTransform.ts` の `mat4FromEulerDeg` と同一。**この一致は保つこと** —
一致していないと、GRAPHY が報告する数値と公開した数値を比較できない。

### 非剛体を B-spline にしなかった理由

設計の初稿は B-spline 制御点だったが、**閉形式の正弦テンソル積**にした。
第三者が再現できることを優先したため: 3 行の式で任意の点を評価でき、
Jacobian が解析的に出る（＝「折り返しが無い」がサンプリングではなく証明になる）、
乱数シードも B-spline 評価器も要らない。R4 のエンジン側が B-spline/DVF を使うことは妨げない。

### 生成器の自己検証

生成後、**結節の中心が真値の示す moving 位置に本当にあるか**を測って HU で突き合わせる
（結節 160 HU / 周囲実質 40 HU）。向きを取り違えていればここで落ちる。
非剛体系列では併せて Jacobian 最小値（> 0）と逆写像の残差も真値 JSON に記録する。

### 採点

```bash
node score_registration.mjs --series rigid --estimate identity     # 未位置合わせのベースライン
node score_registration.mjs --series rigid --estimate est.json     # 推定を採点
node score_registration.mjs --series deform --estimate est.json --json
```

推定は `{"matrix_4x4_row_major": [...]}` または `{"translation_mm": [...], "euler_deg": [...]}`。
出力は landmark TRE・変位誤差（RMSE / p95 / max）と、真値が剛体のときは並進誤差・回転誤差。
合否は真値 JSON の `acceptance_targets` に対して判定し、終了コードに出す。

⚠️ **推定は線形（剛体・アフィン）のみ**。`deform` を線形推定で採点すると「剛体で取り除ける分の
上限」が測れるが、非剛体の目標値には届かない（それは欠陥ではない）。密な変位場の入力は、
それを出すエンジンができる R4 で追加する。

## GNBP-5N — 縦断 SPECT（内容が変わるレジストレーション）

GNBP-2R が測るのは「既知の変換を戻せるか」。こちらが測るのは GNBP-2R には聞けない問い —
**2 つのシリーズが同じものを写していないとき、何が起きるか**である。

治療後のフォローアップ SPECT がその状況にあたる。2 回のスキャンの間に腫瘍は出現し、大きさが
変わり、効いていれば消える。強度ベースの類似度は例外なく「2 つの画像の強度に何らかの対応が
ある」ことを前提にしており、**片方にだけ在る集積はその前提を局所的に破る**。失敗の仕方は
クラッシュではない。**消えた集積を埋めるように組織を引き寄せる、もっともらしい変形**であり、
本プロジェクトが最も嫌う「静かに間違う」形そのものである。

### 直交計画（内容 × 変換 × 背景 ＝ 18 系列）

| 因子 | 水準 | 中身 |
| :- | :- | :- |
| 内容 | `t20` | 腫瘍 20 個（ベースライン） |
| | `t25` | 25 個。**同じ 20 か所をサイズだけ変えて** ＋ 新規 5 個（増悪） |
| | `t00` | 同じ 25 か所が背景すれすれまで**退縮**（奏効） |
| 変換 | `id` | 恒等 — 真値は「動かさないこと」 |
| | `rigid` | 既知の剛体（受診間の体位差） |
| | `deform` | 既知の剛体 ＋ 解析的な変形 |
| 背景 | `tex` | 帯域制限した雲 ＋ 臓器集積（肝・腎・膀胱・脊椎） |
| | `smooth` | 同じ体から**構造を全部落とした**もの |

固定側は `GNBP-5N-t20-id-tex` / `GNBP-5N-t20-id-smooth`（背景の腕ごとに 1 つ）。

**なぜ「腫瘍だけ違う 3 つ」にしなかったか**: それでは既知の変換が無く、採点できない。
内容と変換を交差させると、**見た目がどれだけ変わったか**と**どれだけ動かす必要があったか**という
本来別の 2 つの効果を分離できる。恒等の列は埋め草ではない —
**「内容が変わったので、動かす必要が無いのに変位を作った」**は恒等の真値でしか捕まらない。

### ★ `smooth` の腕がある理由（`t00` の結果を判断する前に読む）

滑らかな背景の卵はほぼ回転体であり、**一様な領域の内部では変位が原理的に観測不能**である
（どれだけずらしても画像が同一）。GNBP-2R で既に実測した話で、あのファントムの変位場 RMSE が
設計目標に届かなかったのは**エンジンではなくファントムの性質**だった。腫瘍が唯一の構造なら、
`t00`（腫瘍が消える）は測れるものを最後の 1 つまで取り去ることになり、そこでの「失敗」は
エンジンについて何も語らない。

そこで背景を第 2 の因子として交差させてある。`tex` は腫瘍が消えても手がかりが残り、
`smooth` は**意図的に何も残さない**。2 つで答えを挟み込む — **`tex` はエンジンを測り、
`smooth` は床を測る**。どちらの腕かを言わずに `t00` の数値を報告しても意味が無い。

### ★ 強度の腕（9 系列・2026-08-21 追加）— カウントの意味が時点間で変わる

基本 18 系列は `COUNT_SCALE` / `STORE_SCALE` が全系列で同一で、背景も 3 つの内容水準で完全に
同じである。位置合わせにはそれで良いが（病変だけを動かして他を固定する）、
**強度正規化については何も言えない** — どんな推定器でも、**1.0 を返すだけの実装ですら満点**になる。
サブトラクションはこの段で成否が決まる（`fw/subtraction-design.md` §3）ので、専用の腕を足した。

**3 つの原因を別々にモデル化している**（同じ「ゲイン」に畳まない）:

| 腕 | 何を変えるか | 入る場所 | レベル | ノイズ CV |
| :- | :- | :- | :- | :- |
| `d080` | **投与量・収集時間** ×0.80 | Poisson の**前** | ×0.80 | **×1.118**（1/√0.8） |
| `s125` | **再構成の格納スケール** ×1.25 | 後段フィルタの**後** | ×1.25 | **不変** |
| `b010` | **一様な下駄**（散乱補正の残り）＋体部の 10% | 最後に加算 | +200（格納値） | — |

実測（`t20-id-tex` は 背景 10.8 カウント・ノイズ CV 11.5%・air 0.40）:

| 系列 | 背景カウント | ノイズ CV | air | 判定 |
| :- | :- | :- | :- | :- |
| `t20-id-tex-d080` | 8.7（= 10.8×0.8） | 12.8%（×1.11） | 0.32 | ✅ **レベルとノイズが両方動く** |
| `t20-id-tex-s125` | 13.6（= 10.8×1.25） | 11.5%（**不変**） | 0.50 | ✅ **レベルだけ動く** |
| `t20-id-tex-b010` | 11.8（= 10.8+1.0） | 10.6% | **1.40**（+1.00） | ✅ **下駄。構造 CV も 47%→43% に薄まる** |

🔴 **`b010` がこの腕の要**。**倍率ひとつでは下駄を消せない**ので、
**比だけの推定器（中央値比・全体平均）はここで必ず失敗し、アフィン推定器（ロバスト回帰）は通る。**
下駄のセルが無い正規化ファントムは、その 2 つを区別できない。

**交差させたのは内容だけ**（変換は `id`、背景は `tex` に固定）。
変換を混ぜると正規化の誤差か位置合わせの誤差か切り分けられない。`smooth` を作らないのは、
一様な組織は**中央値がきれいに出るぶん正規化にはむしろ易しい**腕だからで、
9 系列 28MB を足しても良い知らせしか出てこない（`smooth` が床を測るのは位置合わせの話）。

**真値**は各系列の `intensity` に入る。順方向（適用したもの）と、
**推定器が出すべき逆方向の係数**（`recover_scale` = 1/level、`recover_offset_stored` = −offset/level）の
両方を書いてあるので、採点側で反転しなくてよい。固定側は `fixed_reference`（＝`GNBP-5N-t20-id-tex`）。

```bash
python3 make_phantom_5n.py --out ./phantom --intensity d080 --intensity s125 --intensity b010
```

⚠️ **基本 18 系列のバイト列は変わっていない**（`t20-id-tex` の md5 は追加前後で
`a02f78ece2b4405fb2495b5d96d35f10` で一致）。強度の腕は `all_series()` の**末尾に追加**してあり、
`series_number` も UID も既存分は動かない。`PHANTOM_VERSION` も据え置き（上げると UID が変わる）。
順序を「論理的」に並べ替えると既存の md5 が全部無効になるので、**割り込ませないこと**。

### ★ ノイズのシードは系列ごとに変えてある

同じシードを使うと 2 つのシリーズの**ノイズが同一**になり、類似度指標 — とくに局所の
自己相似性から作る MIND-SSC — が**ノイズ模様に食いつく**。実データには存在しない手がかりで
解けてしまい、しかも極めて高精度に見える。

### ⚠️ 既知の単純化 — 背景は時点間で同一

`tex` の雲と臓器集積は**3 つの内容水準で完全に同じ**にしてある（同じ解剖なので）。時点間で
違うのは病変とノイズだけである。これは変数を病変だけに絞るための設計判断だが、
**実際のフォローアップでは背景の集積分布も変わる**（腎機能・膀胱の充満・投与からの経過時間）。

したがって `tex` の腕は**現実より手がかりが多い**。ここで良い成績が出ても
「背景が変わっても大丈夫」とは言えない。背景も変える第 3 の水準は、必要になったときに足す
（`CLOUD_SEED` を内容ごとに変えるだけで作れる）。

### SPECT らしさ（取得のシミュレーション）

```
解析的な集積（FINE 倍細かい格子） → 前段 PSF 8mm → 粗格子へ集約 → Poisson → 後段フィルタ 6mm
```

- **順序は物理の順序**で、入れ替えられない。集約後にぼかすと検出器応答が違う解像度に
  当たり、小さな病変がありえない集積を保ってしまう。ぼかす前に Poisson を引くと
  **ノイズが白色**になり、実際の再構成が持つ**相関したノイズ**より類似度指標にとって
  ずっと易しくなる。
- 実効分解能は √(8²+6²) ≒ **10mm FWHM**（177Lu SPECT の実勢）。
- **部分容積効果は「後から掛ける係数」ではなく、この順序から生じる**。実測の回収係数は
  40mm で 1.04、20mm で 0.89、11.6mm で 0.34、9.4mm で 0.22 と、教科書どおりの曲線を描く。
- 背景ノイズ CV は実測 **12〜13%**（`COUNT_SCALE` は活動量の計算ではなく、この**実測値**から
  決めた。最初の版は 6.7% で、どの実機よりも綺麗だった。**現実より静かに易しいファントム**は、
  そこで合格したエンジンが患者で落ちる種類の道具になる）。
- 値は**カウント × `STORE_SCALE`** で、rescale 対を書かない（NM の作法）。カウント換算の統計は
  真値 JSON の `background_statistics` / `air_statistics` に入っている。

### ★ 視野の中に「ちょうどゼロ」は無い

体の外には低くノイジーな床がある（体部背景の `AIR_FRACTION` ＝ 4%）。再構成 SPECT は患者の外が
真っ黒になることは無く、散乱・隔壁透過・再構成そのものがそこに床を作るからである。**外を
ゼロにすると、実機には存在しない「完全に鋭く・完全に無雑音な体の輪郭」を位置合わせに
渡すことになる**。それは単独で位置合わせを成立させてしまうほど強い手がかりである。
体に張り付くハローは前段 PSF から自然に出るので、この定数はその下に敷く遠方の床にあたる。

実測: air 0.40 カウント・ノイズ CV 61%（低計数なので相対ノイズが大きいのは物理的に正しい）。

### ★ 格納値は生のカウントではない（`STORE_SCALE`）

Poisson は現実的な計数レベル（体部で約 10 カウント）で引くが、**後段フィルタの出力は小数**で
あり、実際の再構成はそれを利用可能な範囲にスケールして格納する。カウントへ直接丸めていた
最初の版では、**体部が約 16 階調まで量子化**されていた（`t00-id-smooth` の一意な値は
ボリューム全体で 16 個）。これは見た目の問題ではない:

- **Mattes MI は強度をビンに落とす**（既定 48 ビン）。16 階調しか無い画像に対しては、
  解剖ではなく**丸めの副産物**を測ることになる。
- **MIND-SSC は小さな強度差から記述子を作る**。同じ理由で壊れる。
- 上で足した air の床も、そのままでは 0/1 のまばらな斑点に潰れていた。

`STORE_SCALE = 200` で、18 系列を通じた最大値（202 カウント）が約 39k に収まる。
16bit を超えたら writer が**落ちる**（黙って巻き上がらない）。
実測: 階調が 16 → 2,727（smooth）／ 139 → 7,846（tex）、ゼロの画素は 89.4% → 0.00%。

### DICOM の形 — NM 多フレーム

再構成 SPECT は**スライスごとのファイルではなく、多フレーム 1 ファイルの NM Image Storage**で
来る。GRAPHY はこれを `NmFrameExpander`（host API H28）で展開する。単フレーム連番で書くと
実データが通らない経路を検証することになり、**いちばん間違いやすい展開の部分が未検証のまま**に
なるので、実物の形で書いてある。

★ **NM はルートにも per-frame にも ImagePositionPatient を持たない。** 幾何は
`DetectorInformationSequence`（先頭スライスの位置と向き）＋ `SpacingBetweenSlices` にあり、
残りのフレームは読み手が法線方向に積む。書き出しているタグは `NmFrameExpander` が読むものと
厳密に同じ（`NumberOfSlices` / `SliceVector` / `ImageType` の `RECON TOMO` /
`DetectorInformationSequence` / `SpacingBetweenSlices`）。**別の合法な書き方で幾何を宣言すると
開けず、その失敗は検証対象の機能の不具合に見える。**

### 🔴 生成しただけでは**アプリに入らない** — C-STORE で投入する

生成器は DICOM ファイルを書き出すだけで、保管庫（H2 索引 ＋ FS）には入らない。
standalone の backend には**ファイルを受け取る HTTP の口が無く**
（`DicomStorageService.ingest()` を呼べるのは DIMSE の C-STORE SCP と Q/R の retrieve だけ）、
D&D 取り込みも未移植なので、**DIMSE で送るのが唯一の経路**である。

```bash
# アプリ（または backend）を起動しておく
bash bench/store-scu.sh phantom/GNBP-5N-t20-id-tex phantom/GNBP-5N-t25-id-tex
```

送り先の既定は `GRAPHYNEXT@127.0.0.1:11112`（`application.yml` の `local-ae-title` と
`application-standalone.yml` の SCP ポート）。`--host` / `--port` / `--called` で変えられる。

dcm4che の CLI を別途入れなくて済むよう、**backend が既に依存している dcm4che のクラスだけ**で
書いてある（`bench/StoreScu.java`。JDK 21 以降なら単一ファイルのまま実行できる）。
クラスパスは `~/.m2` から拾うので、1 度 `mvn compile` を通してあれば追加の準備は要らない。

⚠️ **Git Bash から実行するときはパス変換が要る**（`/c/Users/...` を Windows の java は
理解せず、区切り文字も `;`）。`store-scu.sh` が `cygpath` で吸収している。
自分で `java -cp` を書くときは忘れないこと——**jar は見つかっているのにクラスが無い**、
という分かりにくい失敗になる。

### 生成と検証

```bash
python3 make_phantom_5n.py --out ./phantom              # 18 系列・約 55MB・約 8 分
python3 make_phantom_5n.py --out ./phantom --texture tex --force   # 片腕だけ
python3 check_5n_nm.py --phantom ./phantom              # NM 幾何が真値と一致するか
```

`check_5n_nm.py` は **`NmFrameExpander` の Java 実装をそのまま写して**、(1) 展開の前提が
成立するか (2) **ヘッダから復元した幾何が公開した真値と一致するか** を見る。(2) が本体である:
生成器の自己検証は内部の格子で動くので、**書き出し側**の誤り（先頭スライス位置の off-by-one、
法線の符号、間隔を別のタグに書く）は素通りし、後になって「位置合わせの偏り」に見える定数
オフセットとして現れる。ここでは真値を JSON から、幾何をファイルから取るので、両者の間に
共有しているものはファントム自身しか無い。

実測（2026-08-20、18 系列）: 病変位置 120 点で一致、**体の重心は公開した変換の予測と平均
0.29mm・最悪 0.54mm**。

### 読み取り器は `nmVolume.mjs` に切り出してある

GNBP が書き出す DICOM を読む最小の読み取り器は、元は `run_rigid_registration.mjs` の中にあった。
GNBP-5N を使う採点が位置合わせ以外にも増えた（サブトラクションの強度正規化ほか）ため、
**同じ読み取り器を 2 つ書かないよう** `nmVolume.mjs` へ移してある（中身は動かしていない）。

⚠️ **汎用の DICOM パーサにはしないこと。** ここが一般化すると、アプリが持っている実装の 2 本目になり、
失敗したときに「エンジンが悪いのかベンチのパーサが悪いのか」が分からなくなる。

### 採点とエンジン実行

真値 JSON のキー構造と変形の閉形式を GNBP-2R に合わせてあるので、**`score_registration.mjs` を
そのまま使える**（新しい採点コードは要らない）。`run_rigid_registration.mjs` も
NM 多フレームを読めるようにしたので、同じハーネスでエンジンを走らせられる。
**固定側は 18 セルのうちの 1 つ**なので `--fixed` で指定する。

```bash
node score_registration.mjs --truth ./phantom/GNBP-5N_ground_truth.json \
     --series t25-rigid-tex --estimate identity

node run_rigid_registration.mjs --truth ./phantom/GNBP-5N_ground_truth.json \
     --fixed t20-id-tex --series t25-id-tex --metric nmi
```

#### 初回実測（2026-08-20・剛体・既定パラメータ）

| 系列 | TRE | 並進誤差 | 何が分かるか |
| :- | -: | -: | :- |
| `t20-rigid-tex`（対照） | 0.520 mm | 0.310 mm | 内容が同じなら 1/9 ボクセルで解ける |
| `t25-id-tex` | 2.471 mm | 1.356 mm | **恒等が真値なのに動く** |
| `t25-id-smooth` | 7.533 mm | 7.093 mm | 背景が無いと 3 倍悪化 |
| `t00-id-smooth` | 2.495 mm | 2.335 mm | 消失より**変化**の方が悪い |

**「腫瘍が変化する」方が「腫瘍が消える」より悪い**（smooth で 3 倍）。消えた集積は単に
寄与しなくなるだけだが、大きさの変わった集積と新しい集積は「両方の画像に在る明るい特徴」で、
指標がそれを積極的に合わせにいく。

**縦断では NMI を既定にすべき**という結論が出た。最悪セル `t25-id-smooth` を 5 シードで測ると
NCC 1.88〜7.09mm に対し **NMI 0.71〜1.69mm** で、**全シードで NMI が勝つ**。
LNCC は破綻する（8.6mm / 10.3°）。詳細は `fw/registration-design.md` §9.5。

### ⚠️ 観測可能性を先に見ること

`lesion_measurements[].cnr` は**書き出したボリュームで実測した値**である。CNR が概ね 3 を
下回る病変は 10mm の実効 PSF と計数統計の後では**検出できておらず**、そこでの大きな TRE は
エンジンの欠陥ではなく**データの性質**である。実測では `t20-id-tex` で 20 個中 18 個、
`t00` では 25 個中 **0 個**が CNR≥3（＝退縮が意図どおり効いている）。

**検出できる landmark で精度を判断し、残りは分けて報告すること。**

### ⚠️ 受け入れ目標は暫定

真値 JSON の `acceptance_targets` は `fw/registration-design.md` §9.1/§9.4 から引き写した
もので、**1mm の CT 様ファントム向けに決めた値**である。4.42mm の SPECT 格子にはほぼ確実に
スケールが合っていない。**意見ではなく測定で直すこと。**

## GNBP-4D — 劣化系列（属性欠落）

他のファントムは「答えが合っているか」を測る。こちらは別の問いに答える:
**データが機能を支えられないとき、アプリは間違った結果を出さずに「できない」と言うか。**

この経路は普通テストされない。実データで欠落したものを用意するのが面倒で、
持ち続けるのも面倒だからである。同時に、**失敗したときがいちばん悪い経路**でもある。
患者座標系を持たないシリーズを黙って位置合わせしたり、SUV に必要な属性を失った PET を
保存したりすると、**見た目は完了しているのに間違っている**結果ができる。

| 系列 | 中身 | 期待する挙動 |
| :- | :- | :- |
| `GNBP-4D-nonspatial` | DX 様 1 枚。**IOP/IPP/FrameOfReferenceUID なし** | 位置調整・自動位置合わせが**無効化され、理由が出る** |
| `GNBP-4D-pet-complete` | PET。SUV に必要な属性が揃っている | SUV が計算でき、派生シリーズも保存できる（**対照**） |
| `GNBP-4D-pet-incomplete` | PET。`Units` / `PatientWeight` / 放射性医薬品シーケンスを削除 | SUV が拒否され、**派生シリーズの保存も拒否される**（`fw/registration-design.md` §8.3） |

**対照（`pet-complete`）を必ず一緒に見ること。** 対照が無いと
「SUV が出なかった」が「拒否が効いた」のか「別の理由で出なかっただけ」なのか区別できない。

```bash
python3 make_phantom_4d.py --out ./phantom
```

実測（2026-08-09、実機）: `pet-complete` からの派生シリーズ保存は **HTTP 200**、
`pet-incomplete` は **HTTP 400** ＋ 欠けているタグ名を並べた理由。

## 使い方

```bash
python3 make_phantom_a.py --out ./phantom              # 正確性系列 + 真値 JSON
python3 make_phantom_b.py --out ./phantom              # 性能系列 64/128/256/512
python3 make_phantom_b.py --out ./phantom --slices 256 # 単一サイズ
python3 make_phantom_b.py --out ./phantom --compress j2k  # JPEG2000 版（デコード負荷比較用）
python3 make_phantom_2r.py --out ./phantom             # レジストレーション系列 5 本（約 5 分）
python3 make_phantom_4d.py --out ./phantom             # 劣化系列 3 本（属性欠落・数秒）
python3 make_phantom_2r.py --out ./phantom --series rigid --force  # 1 系列だけ作り直す
python3 preview.py phantom/GNBP-1A --out /tmp/a.png    # 目視確認
```

> 🚨 **生成器を直したら、真値 JSON / マニフェストも `--force` で作り直す。**
> 系列ディレクトリが残っていると生成そのものが `skip (exists)` になり、**マニフェストは
> 既存の値をそのまま引き継ぐ**ので、md5 が古いまま「一致しているように見える」。
> 2026-08-17 に実際に踏んだ: `GNBP-4D_manifest.json` は `46bff30` のまま残っていて、
> その後の `a58dae7`（PET の値が 1024 高かったのを直した）が反映されていなかった。
> `GNBP-2R_ground_truth.json` も同様に `evaluation_region` を欠いており、
> **`score_registration.mjs` は領域が無いと黙って全空間で採点する**（`inRegion` が常に true）ので、
> 設計ドキュメントの数値と食い違ってもエラーにならない。

出力:

- `phantom/GNBP-1A/` … DICOM 180 枚
- `phantom/GNBP-1A_ground_truth.json` … 楕円体パラメータ（mm）、解析体積、主軸長、
  期待 HU、ステップウェッジ、計測ターゲット、生成器の自己検証結果、系列の MD5
- `phantom/GNBP-1B_{64,128,256,512}/` … DICOM
- `phantom/GNBP-1B_manifest.json` … 各系列のサイズ・MD5・中心線パラメータ
- `phantom/GNBP-2R-{fixed,rigid,affine,deform,multimodal}/` … DICOM（1 スタディに 5 シリーズ）
- `phantom/GNBP-2R_ground_truth.json` … 各系列の 4×4 変換・並進/回転パラメータ・ランドマーク
  （fixed 空間と moving 空間の対応点）・変位統計・Jacobian・受け入れ基準・MD5

依存: `pydicom`, `numpy`（プレビューのみ `pillow`）。採点ハーネスは Node 標準のみ（依存なし）。

### Windows で生成する場合

生成物は**プラットフォームに依らず同じ**（2026-08-17 に Windows 11 / Python 3.11.7 /
pydicom 3.0.2 で確認。GNBP-XA・1A・2R とも記録済み MD5 と完全一致）。ただし 2 点だけ注意する。

- **Git Bash の `python` / `python3` は WindowsApps のスタブ**（実行すると何も起きず rc=49）。
  実体を直接叩く: `/c/Users/<user>/anaconda3/python.exe make_phantom_xa.py --out ./phantom`
- 🚨 **生成器のテキスト出力は必ず `encoding="utf-8"` で開く**。Windows の既定は cp932 なので、
  省略すると真値 JSON の書き出しが `UnicodeEncodeError` で落ちる（`make_phantom_a.py`）か、
  **cp932 で書けてしまい次回の読み込みが `UnicodeDecodeError` になる**（`make_phantom_4d.py`）。
  後者は**その場では成功したように見える**のが厄介。2026-08-17 に 4 本とも修正済み。
  なお**コンソール表示が文字化けするのは表示だけの問題**で、ファイルの中身は UTF-8。

**JS のハーネス（`run_rigid_registration.mjs`）も Windows で動くようにした**（2026-08-21）。
それまで 3 か所で落ちていた:

- `new URL("..", import.meta.url).pathname` を `resolve()` に渡すと `C:\C:\Users\...` になる
  （pathname が `/C:/Users/...` なので `resolve` がドライブを前置する）。`fileURLToPath` を通す
- `node_modules/.bin/esbuild` は Windows では拡張子なしのシェル用ラッパで、`execFileSync` からは
  起動できない。`.cmd` を選ぶ
- Windows の絶対パスはそのまま `import()` できない（`c:` がスキーム扱いになる）。`pathToFileURL` を通す

実行確認: `--fixed t20-id-tex --series t25-id-tex --metric nmi` で TRE 2.637mm
（下の「初回実測」の表と同水準）。

## ファイル

ファントム生成器（Python — `pydicom` / `numpy`、プレビューのみ `pillow`）:

| ファイル | 役割 |
| :- | :- |
| `dicom_io.py` | 決定的な DICOM 系列の書き出し（UID 導出・HU 符号化・NM 多フレーム断層） |
| `make_phantom_a.py` | GNBP-1A 生成＋真値 JSON＋自己検証 |
| `make_phantom_b.py` | GNBP-1B 生成＋マニフェスト |
| `make_phantom_2r.py` | GNBP-2R 生成＋真値 JSON＋自己検証（変換モデル・変位場もここ） |
| `make_phantom_5n.py` | GNBP-5N 生成＋真値 JSON＋自己検証（卵型・雲・病変・SPECT 物理） |
| `check_5n_nm.py` | GNBP-5N の NM 幾何が真値と一致するか（`NmFrameExpander` の写し） |
| `preview.py` | アキシャル/コロナル/サジタルの PNG プレビュー |
| `canvas_stats.py` | 描画キャンバスの画素統計（黒画面検出用） |

計測ハーネス（Node — Playwright。`npm install` で導入）:

| ファイル | 役割 |
| :- | :- |
| `run_all.sh` | ビルド同定 → 正確性・性能を一括実行し `results/` へ書き出す |
| `measure.mjs` | 2D 性能（初回描画・スクロール応答・JS ヒープ） |
| `measure_3d.mjs` | 3D 性能（初回ボリューム・回転 fps・プロセスメモリ） |
| `measure_accuracy.mjs` | GNBP-1A に対する HU 校正と座標変換の正確性 |
| `init_script.js` | ページ側の計測インストルメンテーション（アプリより先に注入） |
| `proc_rss.mjs` | ブラウザプロセス木の PSS 集計 |
| `probe_menus.mjs` / `probe_readout.mjs` | セレクタ・読み出し経路の事前調査 |
| `score_registration.mjs` | GNBP-2R の真値に対して推定変換を採点（アプリ非依存） |

同梱データ:

- `phantom/GNBP-1A_ground_truth.json` / `phantom/GNBP-1B_manifest.json` … 真値とマニフェスト
- `results/*.json` … 測定結果（環境・コミット・jar の MD5 を各ファイルに埋め込み済み）
- `shots/phantom/*.png` … ファントムのプレビュー

**DICOM 生成物（`phantom/GNBP-1A/`・`phantom/GNBP-1B_*/`、計約 575 MB）はリポジトリに含めない。**
バイト単位で決定的なので、上記の生成器を実行して再生成する。

## ライセンス

このディレクトリのコードは GRAPHY-Next 本体と同じ **GNU Affero General Public License v3.0
以降（AGPL-3.0-or-later）** で提供する。Copyright (C) 2026 Visionary Imaging Services, Inc.
全文はリポジトリルートの `LICENSE`、適用範囲の補足は `NOTICE` を参照。

- 生成される DICOM ファントムは本ディレクトリのコードの出力であり、**実患者データを一切含まない**
  合成データ。ヘッダにもその旨を明示している（`ImageType` = `DERIVED\SECONDARY`、
  `PatientIdentityRemoved` = `YES` ほか。「DICOM 属性」の節を参照）。
- GNBP-1A の楕円体パラメータは Kak AC, Slaney M, *Principles of Computerized Tomographic
  Imaging* (1988), Table 3.2 p.102（errata 適用済み）に基づく。出典として明記しており、
  同書の著作権は各権利者に帰属する。
- 計測ハーネスは Playwright（Apache-2.0）に依存する。`npm install` で取得され、
  このリポジトリには同梱していない。
