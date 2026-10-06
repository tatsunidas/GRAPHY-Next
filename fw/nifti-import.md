# NIfTI インポート

> 起票: 2026-08-11 ／ ステータス: **実装済み（backend ＋ MainScreen の非 DICOM インポート導線）**
> 参考: Swing 版 GRAPHY の `com.vis.core.media.NIfTIToDicomConverter` / `ImportNIfTIPanel`
> 関連: [`nondicom-ffmpeg.md`](nondicom-ffmpeg.md)（同じダイアログの動画経路）／
> [`dicom-data-layer.md`](dicom-data-layer.md)（保管庫）

## 0. 何をするものか

`.nii` / `.nii.gz` を **DICOM へ変換して保管庫へ取り込む**。本体の中核は DICOM 前提
（ZCT レイアウト・ROI・計測・プラグイン host API がすべて DICOM の属性と UID に依存している）ため、
NIfTI を「別形式のまま」扱う道は取らない。Swing 版と同じ判断。

- **4D/5D は展開する**: Z=スライス / T=時相 / C=チャネル → 1 フレーム 1 インスタンス。
  時相は `TemporalPositionIndex` と `TriggerTime` に入れる
  （`SeriesLayoutBuilder` の T 判定が "Temporal" / "Trigger" / "Acq" を見るため。ここを外すと
  30 位相が Z 方向に並んでしまう）。
- **サイドカー JSON**（dcm2niix / BIDS の `*.json`）を一緒に取り込める。
- **standalone 前提**（ローカル FS のパス指定）。web モードでは使わない。

## 1. 入口

| API | 内容 |
|---|---|
| `POST /api/nifti/probe` `{path}` | ヘッダだけ読んで次元・画素間隔・幾何の出所を返す（取り込み前の確認用） |
| `POST /api/nifti/import` `{path, metadataPath?, modality?, patient…}` | 変換して保管庫へ取り込む |

**アップロードではなくパス指定**にしてある。4D は数百 MB になることがあり、multipart にすると
一時領域を二重に使うため（既存の非 DICOM インポートと同じ方針）。

UI は MainScreen の **非 DICOM インポート**ダイアログ。`.nii` / `.nii.gz` を選ぶと NIfTI 用の
セクション（モダリティ・サイドカー JSON・下読み結果）が出る。

## 2. 幾何（ここが一番間違えやすい）

```
sform_code > 0 → srow_x/y/z のアフィンをそのまま使う
qform_code > 0 → クォータニオン（method 2）から作る
どちらも 0    → pixdim から軸位断を仮定（synthesized = true）
```

- **NIfTI は RAS+、DICOM は LPS** なので、x 行と y 行の符号を反転する。
- 反転後に**行列式が負（左手系）なら列方向を反転**し、原点を (rows−1) 分ずらす。
  併せて**画素も上下反転**して整合させる（Swing 版と同じ矯正）。
- IOP = 行方向・列方向の単位ベクトル、IPP(k) = 原点 + k × スライス方向ベクトル。
- `xyzt_units` が m / μm のときは mm に直す。

⚠ **`qform_code = sform_code = 0` のファイルは患者座標を持たない**。この場合、
向きは**合成**であり元データの向きではない。取り込んだ画像には次を必ず残す:

- `ImageComments` に `Geometry synthesized: NIfTI had qform_code=sform_code=0 …`
- `DerivationDescription` に幾何の出所（`sform` / `qform` / `pixdim`）
- UI（インポートダイアログ）でも警告を出す

面内・スライス間隔は pixdim から取れるので**寸法は正しい**。狂うのは向きだけ、という線引き。

## 3. 画素

| NIfTI datatype | DICOM |
|---|---|
| uint8 / RGB24 | 8bit（RGB は SamplesPerPixel=3） |
| int8 / int16 / uint16 | 16bit |
| float32 / float64 / int32 / uint32 / int64 / uint64 | 取り込み前に全走査して決める（下の 1・2）。16bit ＋ Rescale Slope/Intercept |

32 bit 以上の型は、先にボリューム全体を 1 度走査し（有限値の最小・最大、すべて整数か、NaN・無限大の数）、次の順で決める（2026-10-06 改訂）。

1. **値がすべて整数で、範囲が 16 bit の符号の数（65536。NaN があれば 65535）に収まる → 可逆**。生の値をそのまま
   （int16 に収まれば int16、0〜65535 なら uint16、それ以外は一定のオフセットだけずらした int16）入れ、
   Rescale にオフセットと `scl_slope` / `scl_inter` を合成する。int32 の CT、HU を float で保存した CT はここに入る。
2. それ以外（整数でない浮動小数・範囲が 16 bit を超える整数）→ **16 bit の全域**へ量子化する。最大誤差（刻みの半分）を取り込み結果の
   `pixelConversion` に出す。
   - ⚠ 整数でない浮動小数は、ユーザ判断（2026-10-06）で **32 bit float（Parametric Map・Float Pixel Data）で格納する**ことに決めた。
     本体の読み込み・表示・解析・書き出しに広く手が要るので段 2 として別に進める（それまではこの量子化）。
- **NaN・無限大**は 16 bit で表せないので、使わない最小の符号（−32768）に置き、`PixelPaddingValue` にする。件数は `pixelConversion` に出す。
  以前は NaN が最小・最大に混ざって係数が壊れ、画像全体が潰れていた。
- 係数は**ボリューム全体で 1 つ**（フレームごとに決めると、スライスごとに Rescale が変わって同じ値が別の意味になる）。
- 発端: NLSTseg 100147（int32・−2048〜1508）が量子化されて最大 0.056 HU ずれた（`fw/lung-nodule-design.md` §9.2）。
  改訂後は保管された DICOM から戻した値が元の NIfTI と**全 3040 万ボクセルで差 0**（`automator/scripts/dicom-series-to-nifti.py` ＋ `compare-nifti.py`）。
  型ごとの往復は `NiftiPixelExactnessTest`（12 件。旧実装では 12 件とも落ちることを確認）。
- 以前は量子化を 32000 段階（16 bit の半分）で行っていたので、誤差が必要の 2 倍あった。
- 未対応の型（float128 等）は**理由を添えて失敗**する（黙って落とさない）。

## 3.1 段 2: 整数でない浮動小数を 32 bit float で格納する（設計・2026-10-06）

> ユーザの決定（2026-10-06）: 整数でない float（PET の SUV、MR の ADC・T1 マップなど）は 16 bit に量子化せず、**32 bit float のまま**入れる。
> この節は設計。**実装の前にユーザの確認を取る。**

### 対象

段 1（§3）の判定で「量子化」に落ちていたもののうち:

| 入力 | 段 2 での扱い | 誤差 |
|---|---|---|
| float32 で整数でない値を含む | float32 のまま | なし |
| float64 で整数でない値を含む | float32 に丸める（読み込み部品が 64 bit float を読めないため。§調査） | 相対 6×10⁻⁸ 程度。最大誤差を表示 |
| 整数だが範囲が 16 bit を超え、絶対値が 2²⁴ 以下 | float32（2²⁴ までの整数は float32 で正確） | なし |
| 整数で絶対値が 2²⁴ を超える | float32 に丸める | 最大誤差を表示 |

段 1 で可逆に入るもの（整数で 16 bit に収まるもの）は、今の通常の CT/MR 画像のまま（互換性が一番高い）。

### 保存形式

- **Parametric Map Storage（1.2.840.10008.5.1.4.1.1.30）、1 インスタンス 1 フレーム**（NumberOfFrames=1）。Float Pixel Data (7FE0,0008)、BitsAllocated 32、**PixelRepresentation は書かない**。
  - 1 ボリュームを 1 インスタンスにしない理由: 512×512×300 の float32 は約 300 MB になり、表示でフレームを 1 枚取り出すたびに大きいファイルを読む。Enhanced 系の IOD は 1 フレームを認めるので、今の NIfTI 取り込みと同じ「1 枚 1 インスタンス」を保てる。
- 幾何・時相・チャネルは Functional Groups に入れる（Shared: PlaneOrientation・PixelMeasures、PerFrame: PlanePosition・FrameContent の DimensionIndex＝z/t/c）。
- **値は float のまま実際の量**。RealWorldValueMapping は傾き 1・切片 0、単位は NIfTI に無いので「単位なし」。→ フロントは RWVM を読まなくても値が正しい（今の校正処理は Rescale が無ければ傾き 1・切片 0 として扱う）。
- NaN・無限大: **要決定**（下の「決めてほしいこと」）。

### 読み込み部品で確かめたこと（2026-10-06）

`@cornerstonejs/dicom-image-loader` 3.33.5 の `shared/decoders/decodeLittleEndian.js`: BitsAllocated 32 で **PixelRepresentation が無ければ Float32Array**、0 なら Uint32、1 なら Int32 として読む。Float Pixel Data (x7fe00008) は `wadouri/getPixelData.js`・`getUncompressedImageFrame.js` が拾う。**64 bit の Double Float Pixel Data (7FE0,0009) には対応していない**。RWVM・Parametric Map の SOP はどこにも出てこない。

### 本体で要る変更（調査: Explore 2 本・2026-10-06。要の主張はコードで確かめた）

**backend**
1. `NiftiToDicom`: 段 2 の対象を Parametric Map として書く（Functional Groups・Float Pixel Data・RWVM）。
2. 新しい展開器 `ParametricMapFrameExpander`（`NmFrameExpander` と同じ形）: `layout()` で Functional Groups から z/t/c・IOP・z の並び（zSpatial）・PixelFormat（32 bit・float）を返し、`extractFrame()` で 1 フレームを**トップレベルに幾何を持つ単一フレーム**（Float Pixel Data・PixelRepresentation なし）にして返す。
   - 🚨 展開器は standalone（`DicomStorageService` の `…LayoutIfApplicable`）と web（`SeriesLayoutAssembler.fromAttributes`）の**両方**に繋ぐ（片方だけだと実機で 1 枚しか出ない・2026-09-03 に踏んだ）。
   - 今のフレーム切り出し（`SegFrameExpander.extractFrame`）は PixelData しか読まず PixelRepresentation=0 を書くので、float には使えない。
3. C-STORE の受信 SOP の一覧（`storage-sop-classes.properties`）に ParametricMapStorage を足す（今は無い＝C-STORE・自局宛ての C-MOVE で拒否される）。
4. フレームの振り分け: `DicomStorageService.frameDicom`・`StudyController.extractWebFrame` で NM より前に PM を振り分ける。
5. 空白画像（`DicomStorageService.blankDicom`・`WebDicomDataService.blankDicom`）: 先頭のヘッダを複製して 16 bit で書くので、PM 用の分岐（float の単一フレーム）。
6. 外部の計算機へ送る npz（`compute/VolumeAssembler.java`）: PixelData しか読まない（PM は `npz-pixels-unreadable`）・32 bit を整数として書く・幾何をトップレベルから取る → Float Pixel Data を読み、Functional Groups から幾何を取る。
7. 派生シリーズ（`DerivedSeriesService.buildInstance`）: 元の SOP Class を写すので、元が PM だと「PM なのに 16 bit・FG なし」の不正なインスタンスができる → PM を元にするときは画像の SOP（`sopClassOf`）にする。
8. `NiftiMetadataMapper.PROTECTED_TAGS` に Float Pixel Data・NumberOfFrames・Functional Groups・DimensionIndex などを足す（サイドカー JSON で上書きされないように）。
9. テクスチャ（`RadiomicsMapEngine.processorFrom`）・ImageJ 連携（`ImageJBridgeService.loadProcessor`）: 8/16 bit しか読まない → float のフレームは FloatProcessor を直接組む。
10. 匿名化の焼き込みの事前検査（`AnonymizeService.geometryOf`）: float を「塗れる」と判定しているので外す（焼き込み本体は PixelData しか読まないので塗らない＝安全側）。
- 変更不要と確かめたもの: ZIP 書き出し（バイト列のままコピー・DICOMDIR は PM 対応済み）、匿名化（UID は Functional Groups の中も置き換わる）、DB のスキーマ、SEG・RTDOSE・RTSTRUCT の書き出し、圧縮形式の変換（float は圧縮できない規定）。
- 流用できるもの: SEG の書き出し（`SegExportService.export`・`perFrameItem`・`dimIndexItem`）の Functional Groups の組み方。dcm4che 5.34.3 は `UID.ParametricMapStorage`・`Tag.FloatPixelData`・`VR.OF` を持ち、ヘッダだけを読む箇所（`IncludeBulkData.NO`）は Float Pixel Data を読み飛ばす。

**frontend**
11. MPR の入口（`mpr/MprScreen.tsx:191`）をレイアウトのセルから imageId を作る形にする（3D・Slicer はすでにセル優先）。
12. H10 の単位（`plugins/pluginVolumeApi.ts:79`）をフレーム付きの imageId から取る。**F2 で済み**（`loadRegVolume` が実際に読んだ先頭の imageId を返す）。
13. NaN を含む画像: `viewer/histogram.ts`（NaN を除く）、W/L 調整（`viewer2d/WwWlAdjustDialog.tsx`: NaN を除いた最小・最大、0.1 刻みの丸めをやめて値域に合わせた刻みにする＝ADC のような小さい値が扱えない）。
14. `viewer/seriesRenderable.ts` で Parametric Map を開ける種類として明示する。

### 決めたこと（2026-10-06・ユーザ）

- **NaN・無限大は NaN のまま入れ、表示・統計で除く**（float は NaN を表せる。無限大も NaN にする。件数は取り込み結果に出す）。
  ROI 統計（`summarizeValues`）・H66 はすでに非有限値を除く。ヒストグラムと W/L 調整（13）は直す。
- **単位は取り込みの画面で選べるようにする**。非 DICOM 取り込みの NIfTI の節に「値の単位」を足す（候補: 単位なし・SUV（g/ml）・Bq/ml・mm²/s・ms・HU・その他（UCUM を入力））。
  - 保存: RWVM の MeasurementUnitsCodeSequence（UCUM）に入れる。
  - 表示: フレームを切り出すとき、単位を RescaleType にも写す（傾き 1・切片 0）。今のフロントの単位の判定（`pixelCalibration.ts` の `resolveValueUnit` は RescaleType を見る）がそのまま使える。
  - 段 1 の 16 bit の画像（整数）にも同じ単位を付ける（RescaleType）。

### 段

| 段 | 内容 |
|---|---|
| F1 | backend の土台: PM の書き出し（NiftiToDicom・PROTECTED_TAGS）、展開器（layout・extractFrame）を standalone・web の両方に配線、フレームの振り分け、空白画像、受信 SOP。単体テスト（往復で値が一致・NaN が残る）。**✅ 2026-10-06**（下の「F1 の結果」） |
| F2 | 単位の選択（取り込みの画面・RWVM・RescaleType）。段 1 の整数の画像にも。**✅ 2026-10-06**（下の「F2 の結果」） |
| F3 | frontend: MPR の入口、H10 の単位、ヒストグラム・W/L の NaN と小さい値域、seriesRenderable。実機（2D・MPR・3D・ROI・H10）でスクリーンショット |
| F4 | npz（VolumeAssembler）・派生シリーズ・テクスチャ・ImageJ・焼き込みの事前検査 |
| F5 | 書き出し → 取り込み直しの往復、設計書の状態を更新 |

### F1 の結果（2026-10-06）

- 規則を 1 つに絞った: **整数で 16 bit に収まり NaN が無いもの → 通常の画像（可逆）、それ以外 → すべて Parametric Map**。NaN を含む float もこちら（NaN を保つため）。段 1 で入れた「NaN をパディング値に置く」経路と 16 bit への量子化は使わなくなったので外した。
- `ParametricMapFrameExpander`（layout・extractFrame・blankFrame）を standalone（`DicomStorageService` の layout・frameDicom・blankDicom）と web（`SeriesLayoutAssembler`・`StudyController.extractWebFrame`・`WebDicomDataService.blankDicom`）の両方に繋いだ。受信 SOP に ParametricMapStorage。
- float32 への丸め誤差は、整数型は**元の 64 bit 整数と**比べる（double に直してから比べると 2^53 を超える整数は double の段階で丸まっていて誤差が 0 に見えた——int64 の両端のテストで発覚）。
- サイドカー JSON の保護に ImageType を足して、通常の画像で JSON の ImageType が入らなくなる退行を出した（既存テストで発覚・外した。PM の ImageType は JSON を当てた後で上書きしている）。
- テスト: `ParametricMapRoundTripTest` 5/0（4D・NaN・layout・切り出した単一フレームが表示側の読める形〔Float Pixel Data・PixelRepresentation なし・トップレベルに幾何〕・空白は NaN・web の組み立ても同じ）、`NiftiPixelExactnessTest` 12/0、`NiftiToDicomTest` 11/0、backend 全体 762/0。
- 実機 `automator/src/spike/niftiFloatCheck.ts` **14/0**: ADC のような float32（0.0007〜0.0018・NaN 32 ボクセル）を取り込み、レイアウト（48×40×12・IOP・z の位置・32 bit）、**H10 の値が元の float32 とビット単位で一致**（患者座標で突き合わせ・`scripts/make-float-nifti.py` がアフィンから独立に出した答え）、NaN は 32 ボクセルのまま、2D 表示はスクリーンショットで確認。
- F3 で直すことを実機で確認: 上の帯の「W/L 0/0」（0.1 刻みに丸めるので小さい値が 0 に潰れる。画像は DICOM の窓で正しく描かれている）。

### F2 の結果（2026-10-06）

- 取り込みの要求に `valueUnit`（UCUM のコード）。画面は NIfTI の節の「値の単位」（単位なし・SUV・Bq/ml・mm²/s・ms・HU・その他（UCUM・16 文字以内））。候補と検査は `frontend/src/mainscreen/niftiUnits.ts`。
- 保存: Parametric Map は RWVM の MeasurementUnitsCodeSequence（UCUM・CodeMeaning は表示名）、通常の画像は RescaleType に表示名（`[hnsf'U]`→HU、`{SUVbw}g/ml`→SUVbw、ほかはコードのまま）。切り出したフレームは RWVM の表示名を RescaleType に写す。
- 実機で見つけて直した: **H10 の unit が "raw" になっていた**（単位をインスタンスの imageId から取っていて、Parametric Map では Rescale の無い生のファイルを指していた）。`loadRegVolume` が実際に読んだ先頭の imageId（`firstImageId`）を返し、そこから取る（frontend 12）。H3 は初めから正しかった。
- テスト: `ParametricMapRoundTripTest` 8/0（RWVM の UCUM・切り出しの RescaleType・単位なしは「1」で表示は空・既知のコードの表示名・17 文字は不可）、`NiftiPixelExactnessTest` 13/0（通常の画像の RescaleType）、`niftiUnits.test.ts` 3/0、backend 766/0、frontend 1944/0。
- 実機 `niftiFloatCheck` **16/0**: mm2/s を付けて取り込み、H10・H3 の unit が mm2/s。取り込みの画面に候補 7 つ・「その他」で入力欄（スクリーンショット）。
- 見つけたが触っていない: 非 DICOM 取り込みのファイル一覧で `.nii.gz` の印が「?」になる（今回より前からの見た目の問題）。

### 検証（実装後）

- 整数でない float32（と NaN）の合成 NIfTI を取り込み、H3・H10・ROI 統計の値が元の float32 と**完全一致**、MPR・3D が開く、NaN の扱いが決めたとおり。表示はスクリーンショットで判定。
- 保存した DICOM を pydicom で読み、Float Pixel Data の値が元と一致（`automator/scripts/dicom-series-to-nifti.py` を Float Pixel Data に対応させる）。
- 書き出し（ZIP）→ 別の保管庫へ取り込み直して値が一致。外部の計算機へ送る npz の値が一致。

## 4. サイドカー JSON（メタデータ）

Swing 版と同じく、**JSON のキーを DICOM キーワードとして解釈**する
（完全一致 → 編集距離 1 まで許容。`ManufacturersModelName` のような 1 文字違いを拾うため）。

- **時間系（RepetitionTime / EchoTime / InversionTime）は秒 → ミリ秒**に直す（BIDS は秒）。
- **変換側が決めるタグ（幾何・画素・UID・患者・InstanceNumber 等）は上書きさせない**。
- 数値 VR に非数値が来たら入れない。壊れた JSON でも取り込み自体は続ける（属性が付かないだけ）。

## 5. 実装

| 場所 | 役割 |
|---|---|
| `backend/.../nifti/NiftiHeader.java` | NIfTI-1 / NIfTI-2 のヘッダ解析（バイト順自動判定・gzip 対応は下記） |
| `backend/.../nifti/NiftiGeometry.java` | sform / qform / pixdim → IOP・IPP（RAS→LPS・左手系矯正） |
| `backend/.../nifti/NiftiToDicom.java` | 変換本体（フレーム展開・画素変換・属性組み立て） |
| `backend/.../nifti/NiftiMetadataMapper.java` | サイドカー JSON → 属性 |
| `backend/.../nifti/NiftiImportService.java` | 1 フレームずつ書いて取り込む（一時ファイルを溜めない） |
| `backend/.../nifti/NiftiImportController.java` | `/api/nifti/probe` `/api/nifti/import` |
| `frontend/src/mainscreen/NonDicomImportDialog.tsx` | 導線（下読み表示・モダリティ・JSON 選択） |
| `frontend/src/api.ts` | `probeNifti` / `importNifti` |

gzip かどうかは**マジックバイト**で判定する（拡張子に頼らない）。

## 6. 検証

- backend: `NiftiToDicomTest`（9 件）/ `NiftiMetadataMapperTest`（8 件）。
  合成した NIfTI で **IOP/IPP の値・時相タグ・量子化の復元・左手系の反転・gzip・未対応型の拒否**を数値で確認。
- 実データ: ACDC の cine（216×256×10 slices × 30 phases・`qform=sform=0`）で
  取り込み → 2D Viewer に **Z 10 / T 30** で載ることを確認（2026-08-11）。

## 7. やらないこと

- **NIfTI のまま表示する**（本体は DICOM 前提。変換で一本化する）
- **向きの推測**。`qform=sform=0` のときに「たぶん短軸」等と当てにいかない。合成した事実を残すだけ
- **Analyze 7.5（.hdr/.img ペア）**。必要になったら別途


## 実データで見つかった欠陥: アフィンが向きだけでスケールを持たない（2026-08-12）

EMIDEC（LGE の公開データ・NIfTI）を取り込んだところ、**スライス間隔が 1 mm** になった。
ヘッダを見ると `sform_code=2` だが `srow` は

```
srow_x = [-1, 0, 0, 0]   srow_y = [0, -1, 0, 0]   srow_z = [0, 0, 1, 0]
pixdim = (1.5625, 1.5625, 10.0)
```

で、**アフィンは向き（RAS の符号）だけを表し、実寸は pixdim 側**にあった。
NIfTI 仕様の優先順位（sform > qform > pixdim）に素直に従うとスライス間隔 1 mm になり、
**容積が 10 倍狂う**（面内は PixelSpacing を pixdim から出していたので気づきにくい）。

### 決めたこと

- 方向ベクトルはアフィンを信じる。**長さ（スケール）だけ**、pixdim と 1% を超えて食い違うときに
  pixdim へ合わせる（`NiftiGeometry.spacingFromPixdim`）。
- 黙って直さない。`Result.spacingNote` に「どの軸が sform=? → pixdim=? だったか」を入れ、
  取込ダイアログが警告として出す（`nifti.warn.spacing`）。
- アフィンが正しくスケールを持つ通常のファイルは**素通し**（回帰テストあり）。

実データでの確認（Case_108）: PixelSpacing 1.5625 / SliceThickness 10 / IPP z = 0,10,…,60 mm、
画素は float64 → int16 + Rescale で 7/7 スライスとも誤差 0.064（量子化幅 0.128 の半分）で一致。
