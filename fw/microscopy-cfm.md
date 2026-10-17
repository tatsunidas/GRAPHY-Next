# 顕微鏡画像を Confocal Microscopy Image（CFM）で持つ

> 起票: 2026-10-17 ／ ステータス: **書き出し（`POST /api/microscopy/import`）・2D 表示・H10・送信／書き出し前の確認は実装済み。MPR・3D は細かすぎるボクセルでは未対応（理由を表示）。host API H68（`host.microscopy.importVolume`、§5）も実装済み。LSM・PIC を読むプラグインは別リポジトリ**
> 関連: [`nifti-import.md`](nifti-import.md) §8（Raw の読み方 `RawSpec`）、[`dicom-data-layer.md`](dicom-data-layer.md)

## 0. 決めたこと（ユーザー決定 2026-10-17）
- 顕微鏡（共焦点の Z スタック）は **Confocal Microscopy Image Storage（1.2.840.10008.5.1.4.1.1.77.1.8、Modality=CFM）**で持つ。
- **値は 32 ビット浮動小数（Float Pixel Data）**。**規格外**である: PS3.3 C.8.12.1.1.2 は Bits Allocated・Bits Stored を 8、Pixel Representation を 0 に限る（Confocal Microscopy Image Module はこの決まりを参照する）。このことは画像の `ImageComments` に必ず書く（"Non-standard: 32-bit float …"）。
  - 調べて分かった補足: CFM を足した Supplement 226 は、皮膚の反射型共焦点顕微鏡（RCM）向けに作られている。
- 1 チャネル＝1 インスタンス（マルチフレーム、フレーム＝Z×T）＝1 シリーズ。チャネルごとに窓が違うため。同じ検査・Frame of Reference・Specimen UID をチャネル間で共有する。
- 装置（Enhanced General Equipment、Type 1）は**変換した本体**とする。
  - 製造者 "Visionary Imaging Services, Inc."、型式 "GRAPHY-Next"、版はアプリの版。
  - シリアル番号は、インストールごとに 1 度だけ作る UUID を共通の設定 `system.installationId` に保存して使う（`InstallationIdentity`）。
- 解剖部位（Frame Anatomy > Anatomic Region、Type 1）の既定は **SCT 91723000 "Anatomical Structure"**（PS3.16 2026c CID 9501 で確認）。取り込みの要求で変えられる。
- 照明（Optical Path）
  - 照明方式（Type 1）は PS3.16 CID 8123 から選ぶ。蛍光は **DCM 111743 "Epifluorescence illumination"**、反射は **DCM 111742 "Reflection illumination"**。
  - 波長が分かれば Illumination Wave Length を入れる。**分からなければ波長も色も入れない**。値を作らないためで、この点も規格外になる。そのことを `ImageComments` に書く（CID 8122 の色は 6 色だけで、「不明」のコードが無い）。
- 受信（SCP）の一覧に、CFM・VL Microscopic・VL Slide-Coordinates Microscopic を足した（WSM は前からある）。

## 1. 書き出し（`microscopy/ConfocalMicroscopyWriter`）
| 項目 | 値（出典） |
|---|---|
| Image Type・Frame Type | ORIGINAL\PRIMARY\VOLUME\NONE（C.8.35.1.1.1・C.8.35.4.1） |
| Confocal Mode・Tissue Location | FLUORESCENCE（既定）・EXVIVO（Type 1 の列挙値） |
| Plane Position (Slide)（フレームごと） | Column/Row Position in Total Image Pixel Matrix = 1、X・Y オフセット 0 mm、**Z オフセット = z × 間隔（µm）**（C.8.12.2。X・Y は mm、Z は µm） |
| Pixel Measures（共有） | PixelSpacing（mm）・SliceThickness・SpacingBetweenSlices |
| Multi-frame Dimension | Z（Z オフセット）・T（Temporal Position Index）、Dimension Organization Type = 3D |
| Specimen | Container・Specimen の識別子にファイル名、Specimen UID は生成。Issuer・準備手順は空（Type 2）。「変換器が作った」ことを `ImageComments` に書く |
| Acquisition Context | 空（Type 2） |
| Real World Value Mapping | 傾き 1・切片 0、単位なし（Parametric Map と同じ書き方） |

入口: `POST /api/microscopy/import`（standalone だけ。サーバー上のパスを受けるので web では出さない）。

## 2. 表示（2D・H10）
- **32 ビット浮動小数のマルチフレームの展開**（`ParametricMapFrameExpander`）を、Parametric Map と CFM の両方で使う（`handles()`）。振り分けの全経路（standalone・web・ボリュームの組み立て・匿名化など）が、そのまま CFM にも効く。
- **スライド座標を、表示用の仮の患者座標に写す**（`dicom/ConfocalGeometry`）。X・Y はそのまま mm、**Z は µm を 1/1000 して mm**にする。向きは `ImageOrientationSlide`、無ければ (1,0,0,0,1,0)。
  切り出したフレームの `ImageComments` に "Slide coordinates mapped to patient axes for display" を足す。保存されたファイルは変えない。
  - 今までの読み方（`SegFrameExpander.perFrameIpp`）は Plane Position (Patient) しか読まないので、CFM は 1 枚しか並ばなかった（テストの負例）。
- 整数の CFM（規格どおりの 8 ビット。16 ビットも）も同じ経路で読む。
- 画面: 情報欄に「スライド座標（患者座標ではない）・規格外の 32 ビット」の注記。送信と書き出しの前に、CFM を含むと規格外の確認を出す（`mainscreen/cfmNotice.ts`）。

## 3. MPR・3D（細かすぎるボクセルは未対応）
- **MPR の並びの判定（`viewer/sliceGeometry.ts`）の許容幅を直した**（2026-10-18 ユーザー決定）。
  - 旧: 「同じ位置」の許容が 0.01 mm 固定。Z 2 µm の顕微鏡では、全部が「同じ位置」になっていた。
  - 新: 丸めの許容 r = min(0.01 mm, max(q, 間隔の 1%))。q は IPP が実際に書かれている桁の刻み。
  - 旧と新を合成データ 12,240 例（間隔 0.002〜5 mm × 丸め 4 種 × 6 パターン）で比べた。**判定が変わるのは間隔 0.05 mm 以下だけ**で、CT・MR の範囲では変わらない。
  - 最初の案（r = min(0.01, 間隔の 1%)）では、小数 2 桁で書かれた 0.3〜0.9 mm の CT が「欠けあり」に変わったので、やめた。
- それでも描けない。**描画ライブラリ Cornerstone3D が断面の厚みの最小値を mm で持つ**ため（既定 `MINIMUM_SLAB_THICKNESS` = 0.05 mm、`setSlabThickness` は 0.1 mm 未満を切り上げ）。
  厚み 0.04 mm の Z スタックは、1 枚のつもりの断面がボリューム全体を含み、MPR も 3D も黒くなる（スクリーンショットで確認）。
- そこで、**ボクセルの一番細かい寸法が最小の厚み（0.05 mm）より細かければ、MPR・3D は理由を出して止める**（`viewer/volumeScale.ts`。しきい値はライブラリの定数から読む）。2D と H10 は使える。
- MPR・3D の対応（描画だけ座標を拡大する、ライブラリを直す、など）は別項目で方式を比べる（2026-10-18 ユーザー決定）。

## 5. プラグインから取り込む（H68・2026-10-18）
- `host.microscopy.importVolume(req)`（`frontend/src/plugins/pluginMicroscopyApi.ts`）→ `POST /api/plugins/{id}/microscopy/import`（`PluginMicroscopyController`、standalone のみ）。
- **毎回、本体が確認画面を出す**（プラグイン名・元のファイル・患者・チャネル・合計のフレーム数・「32 ビットで規格外」の注記）。プラグインからは消せない。
- **パスの制限**: そのプラグインのジョブが書いた `<java.io.tmpdir>/graphy-plugin-microscopy/<プラグイン ID>/` の下の、実在する通常のファイルだけ。
  ファイルそのものがリンクなら断る。途中のフォルダのリンクはたどって実際の場所で比べる（macOS の一時フォルダ `/var/folders` は `/private/var/folders` へのリンクで、たどらないと正しいファイルまで断っていた。macOS の CI で発覚）。`..`・ほかのプラグインのフォルダ・その外・中に置いた外向きのリンクは断る。どこのファイルでも受ける `/api/microscopy/import` は、プラグインには使わせない。
- 取り込みは本体のジョブ（`PluginJobService.submitTask`）で走り、進み具合はフレーム単位。取り込んだら、その一時ファイルを本体が消す。
- チャネルを順に取り込み、2 本目からは 1 本目の検査・Frame of Reference・検体の UID を渡す。途中で失敗したら残りを止め、取り込めた分を返す。最後に DB の変更を知らせる。
- 検証
  - `PluginMicroscopyControllerTest`（4 件。一時フォルダが別名のリンクの場合を含む）: 取り込んで一時ファイルが消えること。外・ほかのプラグイン・リンク・`..` を断ること（フォルダの確かめを外すと落ちることを確認）。404・501。
  - `pluginMicroscopyApi.test.ts`（4 件）: 取り消すと何も送らないこと、UID の受け渡し、途中の失敗で止まること、入力の誤り。
  - `StandaloneOnlyEndpointsTest` に、2 つのコントローラを足した。

## 4. 検証（2026-10-17〜18）
- JUnit `ConfocalMicroscopyTest`（7 件）
  - 必須の骨組み・規格外の注記・Z が µm。波長が無いときの扱い。
  - 表示用の展開で Z が mm になり、値の差が 0。web の経路でも同じ。
  - 負例: 患者座標の読み方では位置が取れない、Z を µm のまま使うと間隔が 1000 倍。
  - 整数の CFM、フレーム数の誤り、SCP の一覧。
- 実データ: Zenodo 16916709（CC BY 4.0、3 チャネル × 20 Z、512×512、8 bit、0.332 µm・2 µm）。リポジトリには入れない。
  - 3 チャネルを取り込み、pydicom で読み直すと値の差は 0。
  - layout は 20 枚・間隔 0.002 mm。切り出したフレームの値の差も 0。
- 自動スパイク `automator/src/spike/microscopyCfmCheck.ts`（実アプリ 16 件）
  - 取り込みと layout、書き出しの前の規格外の確認、情報欄の注記。
  - H10 の値が LSM と一致（0 でない値を含む 6 点）。
  - MPR・3D は理由を出す。
- 退行の確認: 1 mm の実データ（Zenodo 4938032 の FA マップ）で、MPR と 3D が描けることをスクリーンショットで確かめた。`sliceGeometry` のテストに境界の 3 件を足した。
