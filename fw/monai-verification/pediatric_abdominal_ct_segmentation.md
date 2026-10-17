## pediatric_abdominal_ct_segmentation（調査日 2026-10-18）

略称: RAW = https://raw.githubusercontent.com/Project-MONAI/model-zoo/dev/models/pediatric_abdominal_ct_segmentation/ 、HF = https://huggingface.co/MONAI/pediatric_abdominal_ct_segmentation/resolve/main/ （いずれも curl 200 確認済み）。
注意: model-zoo の dev には `configs/train.json` が無い（404）。`configs/train.yaml`・`inference.yaml` が 200 で、`TS_test.json`・`evaluate*.yaml`・`scripts/`・`models/dynunet_FT.pt` は HF 側（HF API の siblings 一覧）にある。model-zoo の GitHub contents API では `LICENSE, configs, docs, large_files.yaml, scripts` を確認。

### 1. Bundle 版・入出力

| 欄 | 値 | 出典 |
|---|---|---|
| Bundle 版 / MONAI 版 | 0.4.7 / MONAI 1.3.0（PyTorch 2.1.0、numpy 1.22.2、nibabel 4.0.1、pytorch-ignite 0.4.11、fire 0.4.0） | RAW`configs/metadata.json` の `version`, `monai_version`, `pytorch_version`, `optional_packages_version` |
| ネットワーク | DynUNet（`monai.networks.nets.DynUNet`、res_block true、instance norm、deep_supervision false）。重みは `models/dynunet_FT.pt`（124,032,446 B） | RAW`configs/train.yaml` の `network_def`、HF `models/dynunet_FT.pt` の x-linked-size |
| 入力 | CT 1ch、HU を -250〜400 でクリップして 0〜1 に正規化、パッチ 96×96×96、float32 | `metadata.json` `network_data_format.inputs`、`inference.yaml` の `ScaleIntensityRanged`（a_min -250, a_max 400, b_min 0, b_max 1, clip true） |
| 前処理（推論） | LoadImaged（ITKReader）→ EnsureChannelFirstd → Orientationd RAS → Spacingd **1.5×1.5×3.0 mm**（bilinear）→ ScaleIntensityRanged → CropForegroundd（mode minimum）→ CastToTyped float32 | `inference.yaml` の `preprocessing` |
| 推論器 | SlidingWindowInferer roi 96³、sw_batch_size 4、overlap 0.75、amp true。後処理は softmax → Invertd → argmax → SaveImaged（int16） | `inference.yaml` の `inferer`, `postprocessing`, `evaluator` |
| 出力 | 4ch。**ラベル番号: 0 背景、1 肝臓（liver）、2 脾臓（spleen）、3 膵臓（pancreas）** | `metadata.json` `network_data_format.outputs.pred.label_def`、`label_classes`、`train.yaml` の `labels`、README「Output」 |
| GPU 要件 | **不明**。README・metadata に学習・推論の GPU メモリ記載なし（`docs/README.md` 全文を読んだ上で「無い」）。`inference.yaml` は `cuda:0` が無ければ CPU にフォールバックする記述のみ。実測は段 0c | RAW`docs/README.md`、`inference.yaml` の `device` |
| 目的・対象 | 「3D Segmentation of Liver, Spleen and Pancreas in Pediatric Abdominal CT」 | `metadata.json` `task` |
| 適用範囲の制限 | `intended_use`: 「Pediatric model - Validation on institutional data required before clinical use」。成人への使用を禁じる明文は**無い**（metadata・README を全読）。ただし小児モデルと位置づけられ、成人公開データでは論文上 TotalSegmentator より劣る（4 参照） | `metadata.json` `intended_use` |

### 2. ライセンス

| 欄 | 値 | 出典 |
|---|---|---|
| Bundle のコード | Apache-2.0 | RAW`LICENSE`（冒頭「Apache License Version 2.0, January 2004」）、README 末尾「Licensed under the Apache License, Version 2.0」 |
| 重み | **不明**。HF の API で `license: null`、`cardData: null`（モデルカード無し。`README.md` は HF で 404）。HF の `LICENSE` ファイルは存在（Apache-2.0 のコード側）が、重み単独の宣言は無い | HF API https://huggingface.co/api/models/MONAI/pediatric_abdominal_ct_segmentation |
| 学習データ | 事前学習に使用: TotalSegmentator v1（Zenodo 6802614、CC-BY-4.0）、TCIA Pediatric-CT-SEG（CC BY 4.0、v2）、BTCV（Synapse、「Data license may be requested」＝**ライセンスは申請制**）。微調整に使用: CCHMC 院内データ（**非公開**、ライセンス不明） | `docs/data_license.txt`、Zenodo API `metadata.license.id = cc-by-4.0`、TCIA ページの License 欄「CC BY 4.0」（Version 2）、README「Internal datasets currently not publicly available」 |
| 商用可否 | **不明**。コードは可（Apache-2.0）。重みは (a) 単独ライセンス記載なし、(b) BTCV が申請制で条件が Bundle から読めない、(c) 院内データの権利が不明。→ モデルレジストリの法務確認（法務）へ | 上記 |

### 3. 学習データ

| 欄 | 値 | 出典 |
|---|---|---|
| 事前学習 | TotalSegmentator **815**、BTCV **30**、TCIA Pediatric **282** | README「Pre-training data」 |
| 微調整 | CCHMC Liver-Spleen CT **275**、CCHMC Pancreas CT **146**（院内・非公開） | README「Fine-tuning data」 |
| 試験データ（学習に使わない側） | CCHMC Liver-Spleen **57**、CCHMC Pancreas **35**、TCIA-Pediatric **74**、TotalSegmentator **50** | README「Testing data」 |
| 年齢範囲 | 院内データ・論文は「pediatric (age ≤ 18 years)」。TCIA Pediatric-CT-SEG は「5 days to 16 years、mean 7」（359 例、非がん、2 mm 再構成が多い）。TotalSegmentator と BTCV は成人主体（論文要旨「primarily adult」） | 論文要旨（Europe PMC PMID 38691411）、TCIA https://www.cancerimagingarchive.net/collection/pediatric-ct-seg/ の Summary |
| 論文の総数 | 1731 CT（学習 1504、試験 221）、院内小児 3 データセット n=483、公開 3 データセット n=1248 | 論文要旨（同上）。README の試験合計 57+35+74+50=216 は論文の 221 と**一致しない**（理由は不明、原文の本文を未取得） |

### 4. 既報の指標と分割

| 欄 | 値 | 出典 |
|---|---|---|
| Bundle 記載の値 | `TS_mean_dice` 0.9、`TCIA_mean_dice` 0.87、`CCHMC_mean_dice` 0.89。**ラベルごとの値は Bundle 内に無い**（README「Performance」は「MedArxiv to be linked」のみ）。何の平均か（3 臓器の平均か等）は記載無し → 不明 | `metadata.json` `eval_metrics`、README「Performance」 |
| 論文の値（DynUNet を含む 3 構造の TL モデル範囲） | 院内小児: 肝 0.965-0.966、脾 0.937-0.945、膵（正常）0.775-0.786。公開小児（TCIA）: 肝 0.941-0.946、脾 0.897-0.926、膵 0.693-0.736。公開主に成人（TS）: 肝 0.926-0.952、脾 0.923-0.947、膵 0.699-0.775。**範囲は 3 アーキテクチャ（SegResNet/DynUNet/SwinUNETR）の TL モデルの幅で、DynUNet 単独の値は要旨に無い**。本文・表は未取得（doi.org は 403、PMC 無し） | Europe PMC 要旨 |
| 参考: TotalSegmentator（論文比較用） | 公開成人 TS 試験で肝 0.991、脾 0.983、膵 0.909（本 Bundle より高い） | 同上 |
| 算出に使ったデータ | README の試験データ 4 種（CCHMC 2、TCIA-Pediatric 74、TS 50）。metadata の 3 キーは TS・TCIA・CCHMC | README「Testing data」、`metadata.json` |
| 分割の特定 | **TS 試験 50 例のみ特定可能**: `configs/TS_test.json`（HF）の `validation` に 50 例 `s0013, s0029, s0038, s0040, s0119, s0230, s0235, s0236, s0244, s0291, s0308, s0311, s0423, s0440, s0441, s0450, s0459, s0468, s0470, s0482, s0499, s0505, s0543, s0561, s0667, s0687, s0735, s0753, s0802, s0829, s0923, s0933, s0994, s1094, s1096, s1119, s1121, s1152, s1174, s1176, s1212, s1240, s1248, s1249, s1276, s1322, s1323, s1347, s1377, s1386`。パスは `/processed/Public/CT_TotalSegmentator/TS_split/test/`（作者環境の絶対パス）。**TCIA-Pediatric 74 例の症例 ID は Bundle に無い → 特定不可**（Pediatric-CT-SEG 359 例中のどれかは不明）。CCHMC は非公開 | HF `configs/TS_test.json`（`validation` 50 例） |
| 独立性 | TS 50 例: README が「Testing data」としてパス名も `TS_split/test` だが、**事前学習 815 例と重ならないことを裏付ける資料は未確認**（TotalSegmentator 公式の train/val/test 分割 meta.csv は 28.4 GB の zip の中で、未取得）。したがって「学習に使っていない」は**作者の記述を信じる限り**。TCIA 74 例は同様に作者記述のみ。train.yaml は検証にも `TS_test.json` を使う設定で、既定のまま学習すると**試験用 50 例で学習する**（`training` と `validation` が同一内容: スクリプトで `d['training']==d['validation']` が True を確認）。この設定は配布時のダミーで、実際の学習分割は Bundle に無い | README「Testing data」、`TS_test.json`、`train.yaml` の `data_list_file_path`, `train_datalist`, `val_datalist` |
| 検証の切り方（train.yaml） | `[-9:]` 等の末尾スライスや seed による分割は**無い**。分割は datalist JSON に外出し。`set_determinism(seed=123)` はあるが分割用ではない。学習は max_epochs 15、val_interval 2、`CheckpointSaver` で val_dice 最良を保存、ロスは DiceCELoss | `train.yaml`（`initialize`, `max_epochs`, `val_interval`, `validate#handlers`） |

### 5. 独立に使える公開データ

| 名前 | 件数・サイズ | 配布元・ライセンス・同意 | 学習に使われていない根拠 |
|---|---|---|---|
| TotalSegmentator v1 の試験 50 例（上記 ID） | 全体は zip 1 本 28,404,091,806 B（1204 例）。**50 例だけの取得は不可**（単一 zip）。肝・脾・膵の個別ラベルは持つが、Bundle の 1/2/3 統合ラベルは作者環境 `/processed/...` にあり**非公開**。自分で肝・脾・膵の 3 ラベルを 1/2/3 に統合する必要がある（統合の細部が作者と同じか不明） | Zenodo https://zenodo.org/records/6802614 、CC-BY-4.0、登録不要（access_right open）。HEAD は Zenodo API の `files[].size` で確認 | README の記述のみ（上記「独立性」）。裏付けは公式 meta.csv の split 列で行える（未実施） |
| TCIA Pediatric-CT-SEG | 359 例、65.69 GB（DICOM+RTSTRUCT）。うち 74 例が試験だが ID は不明 → **全 359 例のうち 282 例が事前学習に使われている**（README）ため、**試験の 74 例を特定できない限り独立データとして使えない** | TCIA、CC BY 4.0、取得は TCIA Data Retriever（登録は未確認） | 特定不可 |
| BTCV | 30 例が事前学習に使用 | Synapse、利用は申請制 | 学習に使用済み → 独立性なし |
| MSD（Task03 Liver, Task07 Pancreas, Task09 Spleen）等 | 本 Bundle の README・metadata の学習データ一覧に**含まれない** | MSD は CC-BY-SA 4.0（spleen パイロットの記録） | 学習に使われていないとは言えるが（一覧に無い）、「一覧に無い」＝「不使用」の確証は TotalSegmentator と BTCV の元データの重複（MSD 由来症例が TS に含まれる等）で崩れうる。TS 論文の元データ構成は未確認 → 不明 |

成人公開データでの検証の可否: Bundle 側に成人禁止の条項は無い。ただし (1) `intended_use` が小児モデル、(2) 論文で成人（TS）は TotalSegmentator に劣る（膵 0.699-0.775）、(3) 事前学習に TS・BTCV（成人）が入っているので、成人データでの値は「成人での外部検証」ではなく「事前学習分布内」の可能性がある。**経路検証（GRAPHY-Next が性能を損なわないか）が目的なら TS 試験 50 例で可能**。モデルの小児適用の妥当性は検証できない。

### 6. 再現検証の可否

| 欄 | 判定 | 根拠 |
|---|---|---|
| TS 試験 50 例 | **条件付き可**。症例は特定できる。ただし (a) 参照ラベルを自分で 1/2/3 に統合する必要がある、(b) 取得に 28.4 GB の zip が要る、(c) 学習と重ならない裏付けが未確認 | 上記 |
| TCIA 74 例・CCHMC | **未達**（症例が特定できない／非公開）。参考値のみ: 論文の TCIA 範囲（肝 0.941-0.946、脾 0.897-0.926、膵 0.693-0.736。DynUNet 単独値ではない） | 上記 |

### 7. 閾値（数値は出さない）— 参照実行に必要なもの

- コマンド（MONAI 公式）: 推論 `python -m monai.bundle run --config_file configs/inference.yaml`、評価 `python -m monai.bundle run --config_file configs/evaluate-standalone.yaml`。重み `models/dynunet_FT.pt` を `bundle_root/models/` に置く（`inference.yaml` の `CheckpointLoader`）。（README「MONAI Bundle Commands」。README の `models/dynunet_FT.pt` 参照と一致）
- 入力の前処理: 6 欄「前処理（推論）」のとおり（RAS、1.5×1.5×3.0 mm、-250〜400 → 0〜1、CropForeground）。`dataset_dir`・`data_list_file_path` を自分のデータに書き換える（README「To load data」）。ラベルは `labels/final/` 配下の README のフォルダ構成。
- 評価の中身: `scripts/compute_metric.py` は 4 クラスに one-hot 化して `DiceMetric(include_background=False, reduction="mean")` を症例ごとに計算し `mean_dice` を出す。**症例別・臓器別の値**は `metric_details` が出る（csv は MetricsSaver）。臓器別 Dice が欲しいなら `reduction` を変えるか metric_details の列を使う。
- 必要 GPU メモリ: 不明（上記）。
- 必要データ: TS 試験 50 例の画像と、肝・脾・膵を 1/2/3 に統合したラベル。症例は特定可（上記）。
- 閾値の方法（ブリーフどおり）: 同じ症例を MONAI 公式手順で 1 回参照実行し、症例別 Dice の平均 − 2×標準偏差。その値は未取得。

### 8. 注意点

- **Bundle に `train.json` が無い**（yaml のみ）。`configs/TS_test.json` は model-zoo ではなく HF 側にあり、model-zoo だけ見ると欠落して見える。
- `train.yaml` の既定は `training` と `validation` が同一の TS 試験 50 例。そのまま学習すると試験データで学習する。`dataset_dir` も作者環境の絶対パス。
- ラベル番号は 1 肝・2 脾・3 膵。TotalSegmentator の 104 クラスのラベル番号とも、MSD（Spleen は 1 のみ、Liver は 1 肝/2 腫瘍、Pancreas は 1 膵/2 腫瘍）とも違う。参照側の統合を間違えると Dice がずれる。TS 側は臓器ごとに別ファイル（`liver.nii.gz` 等）なので、統合順と重なり処理が作者と一致しているか不明。
- 向き: 前処理で RAS に揃える。出力の逆変換は `Invertd`（`inference.yaml`）。`evaluate.yaml` は `resample: false`、`squeeze_end_dims: true` で保存。
- 辞書順の落とし穴は、この Bundle の分割には出ない（datalist JSON に明示）。ただし画像と JSON の ID 対応（`sNNNN`）を保つこと。
- 入力は軸位 CT で、造影相の前提は記載無し（不明）。TCIA は 2 mm 再構成が多く、Bundle の z 間隔 3 mm へリサンプルされる。
- 論文の `README`「Performance」は MedArxiv 未リンク、`metadata.json` の `references` は「url to be updated」。数値の一次資料は論文（AJR 2024、doi:10.2214/AJR.24.30931）。DOI は 403、Europe PMC の要旨のみ取得。
- GitHub: https://github.com/cchmc-dll/pediatric_abdominal_segmentation_bundle （200）。README は「More details about model training and validation will be added shortly」のみ。
- 臨床利用は施設データでの検証が必須と `intended_use` にある。

### 不明・未確認の一覧と理由

| 項目 | 理由 |
|---|---|
| 重みのライセンス・商用可否 | HF API の license が null、カード無し、Bundle に重み単独の宣言無し。BTCV の条件と院内データの権利も読めない |
| GPU 要件（学習・推論） | README・metadata に記載無し。実測が要る |
| DynUNet 単独の臓器別 Dice（論文） | 取得できたのは要旨のみ（本文・表は doi.org が 403、PMC 無し）。要旨の値は 3 アーキテクチャの範囲 |
| metadata の `TS_mean_dice` 等が何の平均か | 記載無し。論文本文未取得 |
| README の試験 216 例と論文の 221 例の差 | 理由は資料に無い |
| TS 試験 50 例と事前学習 815 例の非重複 | 公式 meta.csv（28.4 GB zip 内）を未取得。README の記述のみ |
| TCIA 試験 74 例の症例 ID | Bundle に無い |
| TCIA 取得の登録要否 | TCIA ページで Data Retriever の要求のみ確認。アカウント要否は未確認 |
| TS 試験ラベルを 1/2/3 に統合した作者の手順 | `/processed/...` は非公開。統合のコードは Bundle に無い |
| MSD が元から学習に入っていないことの確証 | TS・BTCV の元データ構成との重複を未確認 |
| 造影相の前提 | Bundle に記載無し |
| 取得データの実物検証（ID と向き） | ブリーフにより取得していない |
