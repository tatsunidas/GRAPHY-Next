# GNBP — GRAPHY-Next Benchmark Phantom

GRAPHY-Next の性能・正確性を評価するためのデジタルファントムと、その生成器・計測ハーネス。

読み込み時間・フレームレート・メモリといった負荷の測定だけでなく、**解析的に真値が既知**の
データを使って計測そのものの正確性（HU 校正・座標変換・体積・**レジストレーション**）も
検証できるようにしてある。

| 系列 | 目的 | 正本 |
| :- | :- | :- |
| **GNBP-1A / 1B** | 正確性（体積・距離・HU）／ 性能（負荷スケーリング） | この README |
| **GNBP-2R** | **レジストレーション精度**（剛体・アフィン・非剛体・マルチモーダル） | この README ＋ `fw/registration-design.md` §9.1 |
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
```

| 系列 | 中身 | 与える真値 |
| :- | :- | :- |
| **GNBP-XA-1** | 直管 3.0mm ＋ 既知 %DS（0/30/50/70/90）・既知長（5/10/20mm）・ぼけ 2 段・ノイズ 3 段の **11 フレーム** | MLD・RVD・%DS・病変長の解析解 |
| **GNBP-XA-2** | 背景（骨相当）＋マスク 5 ＋造影 20 フレーム、**既知の平行移動**を注入 | 注入したシフト量 |
| **GNBP-XA-3** | **1.1 回転する先細りの螺旋＋分岐**を既知の 4 方向で順投影（単一フレーム × 4 シリーズ）。同じ画像で**タグの角度にだけ既知誤差（±1〜3°）を混ぜた版**も作る | 3D 中心線（患者 LPS mm）・枝ごとの長さと径・注入した角度誤差 |
| **GNBP-XA-4** | 同一画像に**タグの書かれ方 5 変種**（FIDUCIAL / GEOMETRY / Imager と同値 / PixelSpacing 無し / 幾何タグも無し） | mm/px の真値と、`§7.2` が通るべき経路 |
| **GNBP-XA-6** | 既知の拡張（瘤）。紡錘状／嚢状／軽度／拡張無しの 6 フレーム（⚠ XA-5 は左室に予約済み） | 最大径・拡張比・瘤長・偏心度 |
| **GNBP-XA-7** | **断面の形だけを変えた 5 フレーム**（円／横長楕円／縦長楕円／三日月／D 型）。前 3 つは**断面積が厳密に同じでシルエットの幅だけ違う** | 断面積・**面積等価直径**・**シルエット幅**の両方（どちらを測る方式かで正解が変わるため） |

> **XA-7 は「エッジ検出と密度計測のどちらを採るか」を決めるための系列**（設計 §16.5）。
> 円柱では シルエット幅 ＝ 面積等価直径 になってしまい、**方式の違いが出ない**。
> 実験は `python experiment_qca_edge.py`。

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

## ファイル

ファントム生成器（Python — `pydicom` / `numpy`、プレビューのみ `pillow`）:

| ファイル | 役割 |
| :- | :- |
| `dicom_io.py` | 決定的な CT DICOM 系列の書き出し（UID 導出・HU 符号化） |
| `make_phantom_a.py` | GNBP-1A 生成＋真値 JSON＋自己検証 |
| `make_phantom_b.py` | GNBP-1B 生成＋マニフェスト |
| `make_phantom_2r.py` | GNBP-2R 生成＋真値 JSON＋自己検証（変換モデル・変位場もここ） |
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
