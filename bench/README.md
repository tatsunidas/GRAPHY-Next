# GNBP-1 — GRAPHY-Next Benchmark Phantom

GRAPHY-Next の性能・正確性を評価するためのデジタルファントムと、その生成器・計測ハーネス。

読み込み時間・フレームレート・メモリといった負荷の測定だけでなく、**解析的に真値が既知**の
データを使って計測そのものの正確性（HU 校正・座標変換・体積）も検証できるようにしてある。

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

## 再現性

生成物は**バイト単位で決定的**。UID は固定ルート＋パラメータの SHA-256 から導出し、
ノイズは固定シード、Implementation Class UID も固定してある（ここを `generate_uid()` に
すると毎回変わって再現性が壊れる。実際に一度踏んだ）。

検証済み: 同じコマンドで2回生成し、全ファイルの MD5 が一致することを確認。

```
GNBP-1A       180 files   90.2 MiB  md5 325737ca08213ffa5f9d024620f32d6a
GNBP-1B_64     64 files   32.1 MiB  md5 d2e21d18f4b984973e1cb6de2315869b
GNBP-1B_128   128 files   64.2 MiB  md5 3027c530c11791c79fb72cfee0a7e0c4
GNBP-1B_256   256 files  128.5 MiB  md5 5bbd10354392e8efa448dca9b7c8267d
GNBP-1B_512   512 files  257.0 MiB  md5 19814798810c9d42fe0fe703f78e565b
```

（MD5 は系列内の全ファイルをファイル名昇順に連結したものに対する値。
正典は `phantom/GNBP-1A_ground_truth.json` と `phantom/GNBP-1B_manifest.json`。）

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

## 使い方

```bash
python3 make_phantom_a.py --out ./phantom              # 正確性系列 + 真値 JSON
python3 make_phantom_b.py --out ./phantom              # 性能系列 64/128/256/512
python3 make_phantom_b.py --out ./phantom --slices 256 # 単一サイズ
python3 make_phantom_b.py --out ./phantom --compress j2k  # JPEG2000 版（デコード負荷比較用）
python3 preview.py phantom/GNBP-1A --out /tmp/a.png    # 目視確認
```

出力:

- `phantom/GNBP-1A/` … DICOM 180 枚
- `phantom/GNBP-1A_ground_truth.json` … 楕円体パラメータ（mm）、解析体積、主軸長、
  期待 HU、ステップウェッジ、計測ターゲット、生成器の自己検証結果、系列の MD5
- `phantom/GNBP-1B_{64,128,256,512}/` … DICOM
- `phantom/GNBP-1B_manifest.json` … 各系列のサイズ・MD5・中心線パラメータ

依存: `pydicom`, `numpy`（プレビューのみ `pillow`）

## ファイル

ファントム生成器（Python — `pydicom` / `numpy`、プレビューのみ `pillow`）:

| ファイル | 役割 |
| :- | :- |
| `dicom_io.py` | 決定的な CT DICOM 系列の書き出し（UID 導出・HU 符号化） |
| `make_phantom_a.py` | GNBP-1A 生成＋真値 JSON＋自己検証 |
| `make_phantom_b.py` | GNBP-1B 生成＋マニフェスト |
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
