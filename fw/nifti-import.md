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
| float32 / float64 / int32 / uint32 | **16bit へ量子化**し、Rescale Slope/Intercept で元の値へ戻せるようにする |

- 量子化係数は**ボリューム全体で 1 つ**（先に 1 度全走査して min/max を取る）。
  フレームごとに決めると、スライスごとに Rescale が変わって同じ値が別の意味になる。
- NIfTI の `scl_slope` / `scl_inter` は量子化前に適用し、最終的な Rescale に合成する。
- 未対応の型（float128 等）は**理由を添えて失敗**する（黙って落とさない）。

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
