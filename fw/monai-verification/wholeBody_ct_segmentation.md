# wholeBody_ct_segmentation（調査日 2026-10-18）

Bundle 取得元: https://raw.githubusercontent.com/Project-MONAI/model-zoo/dev/models/wholeBody_ct_segmentation/ （`configs/metadata.json` `configs/train.json` `configs/inference.json` `configs/evaluate.json` `docs/README.md` `docs/data_license.txt` `LICENSE` は curl で 200 を確認）。以下 M=metadata.json、T=train.json、R=docs/README.md。

## 1. 版・入出力・GPU

| 欄 | 値 | 出典 |
|---|---|---|
| Bundle 版 / MONAI 版 | 0.2.8 / 1.4.0（PyTorch 2.4.0、itk 5.4.0、nibabel 5.2.1、pytorch-ignite 0.4.11） | M `version` `monai_version` `pytorch_version` `required_packages_version`。changelog 0.2.8「add an optional ROCm inference config for AMD GPUs」 |
| ネットワーク | SegResNet（init_filters 32、blocks_down [1,2,2,4]、blocks_up [1,1,1]、dropout 0.2、in 1ch、out 105ch） | T `network_def`、R「trained using the SegResNet」 |
| 入力 | CT 1ch、パッチ 96x96x96、float32。M は value_range [0,1] と書くが、実際の前処理は ScaleIntensityd minv -1.0 maxv 1.0（M と食い違い。実処理は configs を採る） | M `network_data_format.inputs.image`、`configs/inference.json` `preprocessing` |
| 出力 | 105ch（0 背景 + 前景 104）、softmax→argmax で 0〜104 の単一ラベル画像 | M `outputs.pred.num_channels`=105、R「Output: 105 channels」、`inference.json` `postprocessing` |
| 解像度 | 既定 highres=1.5 mm 等方（`model.pt`）、低解像度 3.0 mm 等方（`model_lowres.pt`）。`displayable_configs#highres` で切替 | R「High-Resolution and Low-Resolution Models」、T/inference.json `pixdim` `modelname` |
| 推論の前処理 | LoadImaged → EnsureChannelFirstd → Orientationd RAS → Spacingd(1.5 mm, bilinear) → NormalizeIntensityd(nonzero=true) → ScaleIntensityd(-1,1)。HU のクリップ・窓は無い（z-score 後に min-max）。推論 SlidingWindow roi 96³、overlap 0.25、sw_batch_size 1、mode gaussian、padding replicate、amp true。Invertd で元空間に戻す | `configs/inference.json`（`preprocessing` `inferer` `postprocessing` `displayable_configs`） |
| GPU 要件 | 学習 48 GB（R）。評価（Dice 計算込み）は 48 GB 以上を推奨（R）。推論の実測: 512x512x397・1.5 mm で GPU 28.73 GB / CPU 26 GB（RAM）、3.0 mm で GPU 5.89 GB / CPU 2.3 GB。「300 スライスの CT でおよそ 27 GB」 | R「Training Configuration」「Evaluation Configuration」「Resource Requirements and Latency Benchmarks」 |
| 重みのサイズ | `models/model.pt` 75,225,922 B、`models/model_lowres.pt` 75,225,922 B（HF の x-linked-size。2 つが同一バイト数なのは構造が同じためと思われるが、中身が別物かは未確認） | HF `https://huggingface.co/MONAI/wholeBody_ct_segmentation/resolve/main/models/model.pt` HEAD（302→200、2026-10-18） |
| 重みの配布 | HF `MONAI/wholeBody_ct_segmentation`（最終更新 2025-06-30、sha 13f6d33a…）。README は Google Drive のリンクも載せる（Drive は curl で 401 のため未確認） | HF API `https://huggingface.co/api/models/MONAI/wholeBody_ct_segmentation`、R |

### ラベル番号と名前（M `network_data_format.outputs.pred.channel_def` を機械的に転記。105 項目）
注意: この番号は **TotalSegmentator 公式のクラス番号（v1・v2 とも）とは別**で、Bundle 独自の並び。左右は名前の接尾辞（`_left`=患者の左）で、M が示す名前をそのまま写した。左右の定義（患者の解剖学的左右か画像の左右か）を M は述べていない → 「不明」。ただし TotalSegmentator 原作は患者の解剖学的左右。肋骨・椎体・殿筋・腸腰筋・自家固有背筋などの左右ペアは 1 つの番号に 1 側ずつ。

| 番号 | 名前 |
|---|---|
| 0 | background |
| 1 | spleen |
| 2 | kidney_right |
| 3 | kidney_left |
| 4 | gallbladder |
| 5 | liver |
| 6 | stomach |
| 7 | aorta |
| 8 | inferior_vena_cava |
| 9 | portal_vein_and_splenic_vein |
| 10 | pancreas |
| 11 | adrenal_gland_right |
| 12 | adrenal_gland_left |
| 13 | lung_upper_lobe_left |
| 14 | lung_lower_lobe_left |
| 15 | lung_upper_lobe_right |
| 16 | lung_middle_lobe_right |
| 17 | lung_lower_lobe_right |
| 18 | vertebrae_L5 |
| 19 | vertebrae_L4 |
| 20 | vertebrae_L3 |
| 21 | vertebrae_L2 |
| 22 | vertebrae_L1 |
| 23 | vertebrae_T12 |
| 24 | vertebrae_T11 |
| 25 | vertebrae_T10 |
| 26 | vertebrae_T9 |
| 27 | vertebrae_T8 |
| 28 | vertebrae_T7 |
| 29 | vertebrae_T6 |
| 30 | vertebrae_T5 |
| 31 | vertebrae_T4 |
| 32 | vertebrae_T3 |
| 33 | vertebrae_T2 |
| 34 | vertebrae_T1 |
| 35 | vertebrae_C7 |
| 36 | vertebrae_C6 |
| 37 | vertebrae_C5 |
| 38 | vertebrae_C4 |
| 39 | vertebrae_C3 |
| 40 | vertebrae_C2 |
| 41 | vertebrae_C1 |
| 42 | esophagus |
| 43 | trachea |
| 44 | heart_myocardium |
| 45 | heart_atrium_left |
| 46 | heart_ventricle_left |
| 47 | heart_atrium_right |
| 48 | heart_ventricle_right |
| 49 | pulmonary_artery |
| 50 | brain |
| 51 | iliac_artery_left |
| 52 | iliac_artery_right |
| 53 | iliac_vena_left |
| 54 | iliac_vena_right |
| 55 | small_bowel |
| 56 | duodenum |
| 57 | colon |
| 58 | rib_left_1 |
| 59 | rib_left_2 |
| 60 | rib_left_3 |
| 61 | rib_left_4 |
| 62 | rib_left_5 |
| 63 | rib_left_6 |
| 64 | rib_left_7 |
| 65 | rib_left_8 |
| 66 | rib_left_9 |
| 67 | rib_left_10 |
| 68 | rib_left_11 |
| 69 | rib_left_12 |
| 70 | rib_right_1 |
| 71 | rib_right_2 |
| 72 | rib_right_3 |
| 73 | rib_right_4 |
| 74 | rib_right_5 |
| 75 | rib_right_6 |
| 76 | rib_right_7 |
| 77 | rib_right_8 |
| 78 | rib_right_9 |
| 79 | rib_right_10 |
| 80 | rib_right_11 |
| 81 | rib_right_12 |
| 82 | humerus_left |
| 83 | humerus_right |
| 84 | scapula_left |
| 85 | scapula_right |
| 86 | clavicula_left |
| 87 | clavicula_right |
| 88 | femur_left |
| 89 | femur_right |
| 90 | hip_left |
| 91 | hip_right |
| 92 | sacrum |
| 93 | face |
| 94 | gluteus_maximus_left |
| 95 | gluteus_maximus_right |
| 96 | gluteus_medius_left |
| 97 | gluteus_medius_right |
| 98 | gluteus_minimus_left |
| 99 | gluteus_minimus_right |
| 100 | autochthon_left |
| 101 | autochthon_right |
| 102 | iliopsoas_left |
| 103 | iliopsoas_right |
| 104 | urinary_bladder |

内訳の確認: 椎骨 24（18〜41、L5→C1 の降順）、肋骨 24（58〜69 左 1〜12、70〜81 右 1〜12）、肺葉 5（13〜17）。番号は 0〜104 で欠番・重複なし（スクリプトで 105 件を確認）。
**辞書順の落とし穴**: 椎骨は 18=L5 … 41=C1 と尾側→頭側の降順。`rib_left_10` などは名前の辞書順と番号順が一致しない。名前でなく番号でマッピングすること。`iliac_vena_*` は一般名の "vein" でなく "vena"。`autochthon_*` は背筋、`clavicula_*` は鎖骨、`hip_*` は寛骨。

## 2. ライセンス

| 欄 | 値 | 出典 |
|---|---|---|
| Bundle のコード | Apache-2.0（Copyright MONAI Consortium） | Bundle 同梱 `LICENSE` 先頭「Licensed under the Apache License, Version 2.0」。HF にも同名 `LICENSE` あり |
| 重み | 重み単独のライセンス記載なし。HF API の `cardData` は null、`license` は null、モデルカード README は 404（HF のモデルカード本体なし）。**不明** | HF API 2026-10-18、`https://huggingface.co/MONAI/wholeBody_ct_segmentation/raw/main/README.md` が "Entry not found" |
| 学習データ | TotalSegmentator データセット: **CC-BY-4.0**（Zenodo のメタデータ）。ただし Bundle の `docs/data_license.txt` は「TotalSegmentator https://zenodo.org/record/6802614」とだけ書き、後ろに Apache License 2.0 の全文が付く（データに Apache-2.0 を当てているように読めるが、データの正は Zenodo の CC-BY-4.0）。R は「All rights and licenses are reserved to the original authors」 | Zenodo API `https://zenodo.org/api/records/6802614` `metadata.license.id`="cc-by-4.0"、`docs/data_license.txt`（本文は 236 B）、R「Data」 |
| 商用可否 | **不明（法務判断が要る）**。コードは可（Apache-2.0）。データは CC-BY-4.0 で商用利用自体は許容される（帰属表示が条件）。だが重みのライセンスが未記載で、MONAI 側の条項は読み取れていない。なお TotalSegmentator 本体の有償・非商用ライセンスは「別タスク」（README に「Available with a license」）の話で、`total`（117 クラス）は Apache-2.0。**この Bundle の重みは MONAI が再学習したもの**で、TotalSegmentator 本体の重みではない | 上記、TotalSegmentator README `https://raw.githubusercontent.com/wasserth/TotalSegmentator/master/README.md`「Openly available for any usage (Apache-2.0 license)」「Available with a license」 |

## 3. 学習データ

| 欄 | 値 | 出典 |
|---|---|---|
| 名前・配布元 | TotalSegmentator データセット。Zenodo 6802614（DOI 10.5281/zenodo.6802614、コンセプト DOI 10.5281/zenodo.6802613）。Bundle が参照するのは `zenodo.org/record/6802614`（v1.0）。作成: University Hospital Basel | `docs/data_license.txt`、Zenodo API |
| 件数 | v1.0（record 6802614）= **1204 CT**、104 構造（臓器 27・骨 59・筋 10・血管 8）、公開 2022-07-06、`Totalsegmentator_dataset.zip` 28,404,091,806 B、md5 f0fbb3f91d9d99f2169863545f577b30。後継 v2.0.1（record 10047292、2023-10-27）は 1228 CT・117 クラス、`Totalsegmentator_dataset_v201.zip` 23,581,218,285 B、CC-BY-4.0 | Zenodo API（両 record）。TotalSegmentator README が「1228 subjects」 |
| Bundle が実際にどれだけ・どの版で学習したか | **不明**。R は「The training set is the 104 whole-body structures from the TotalSegmentator released datasets」とだけ記し、症例数・版・分割を書かない。T の `dataset_dir` は `sampledata`（下記のサンプル 20 例）で、フルデータの datalist や分割ファイルは Bundle に無い。「Data Size: 1000 3D Volumes」はメモリ消費の記述で、学習件数と断定できない | R「Memory Consumption」、T |
| ラベル作成 | 104 個の二値マスクを 1 つの NIfTI（0〜104）に統合する手順を利用者に委ねている（順序は M の channel_def）。サンプル（20 学習/検証 + 5 テスト）の Google Drive: https://drive.google.com/file/d/1DtDmERVMjks1HooUhggOKAuDm0YIEunG/view（curl 401、未確認） | R「Preprocessing」 |

## 4. 既報の指標

| 欄 | 値 | 出典 |
|---|---|---|
| Bundle の mean Dice | `eval_metrics.mean_dice` = 0.8。**根拠データ・分割・算出方法の記載なし**（R の Performance は図 2 枚へのリンクのみ、数値表なし。画像 URL は developer.download.nvidia.com で本調査では取得・判読していない） → 値の出所は「不明」 | M `eval_metrics`、R「Performance」 |
| ラベルごとの Dice | Bundle には無い。**未取得** | R |
| 原論文（参考、独立性は別物） | TotalSegmentator の nnU-Net（**この Bundle の SegResNet ではない**）のテスト 65 例: 1.5 mm Dice 0.943（95% CI 0.938–0.947）、NSD 0.966；3 mm Dice 0.840。この値はこの Bundle の性能の根拠にならない | arXiv 2208.05868 §3.4、https://arxiv.org/abs/2208.05868 |
| 検証の切り方（Bundle 内） | T の学習は `@images[:-10]`、検証は `@images[-10:]`（`images` = `sorted(glob(dataset_dir + '/imagesTr/*.nii.gz'))`）、`set_determinism(seed=123)`、`val_interval` 20 エポック、検証の主指標 `MeanDice(include_background=false)`、`CheckpointSaver(save_key_metric=true)` → **検証 10 例の Dice でチェックポイントを選ぶ**。検証は中心 160³ に CenterSpatialCropd するため全身の Dice ではない。ただしこの datalist は利用者が与えるフォルダ（サンプルなら 20 例の末尾 10 例）で、**配布重みの学習時にどの 10 例だったかは不明** | `configs/train.json` `train#dataset` `validate#dataset` `validate#preprocessing` `validate#key_metric` `validate#handlers` `initialize` |
| 独立性 | 配布重みが TotalSegmentator のどの症例で学習・検証されたか Bundle から特定不能 → 同データセットのどの症例も「学習に使われていない」と言えない。既報 0.8 は独立性なし/不明 | 上記 |

## 5. 独立に使える公開データ（基準ラベル付き）
| 欄 | 値 | 出典 |
|---|---|---|
| TotalSegmentator データセットの分割（原論文） | 1204 例を学習 1082（90%）/ 検証 57（5%）/ テスト 65（5%）。分割は dataset 内の `meta.csv` に記載（README: "The exact split of the dataset can be found in the file `meta.csv` inside of the dataset"）。**`meta.csv` の中身は未取得**（ZIP 28.4 GB が必要でダウンロードしない方針。ZIP 内の個別ファイル取得の可否は未確認） | arXiv 2208.05868 §2、TotalSegmentator README「The exact split…」、`resources/train_nnunet.md` |
| 利用 | データセット自体は open（access_right=open）、CC-BY-4.0、登録不要の直接ダウンロード（Zenodo）。サイズ 28,404,091,806 B（v1）または 23,581,218,285 B（v2.0.1） | Zenodo API |
| モデルが学習に使っていない根拠 | **無い**。上の通り Bundle の学習症例は不明で、原論文のテスト 65 例（`meta.csv` で特定）でも、MONAI の再学習がテスト例を学習に使っていないことは Bundle のどこにも書かれていない → 「独立」とは断定できない（未確認） | R、T |
| 他のデータ | BTCV 等の別データは本調査で未調査（104 ラベルと対応づけも要る） → 未調査 | — |

## 6. 再現検証の可否
**未達（参考値のみ）**。理由: (1) Bundle は検証症例を「利用者が与えるフォルダの末尾 10 例」と定義するだけで、配布重みの学習時の症例を特定できない。(2) 既報 0.8 は出所不明。(3) 参考値として使えるのは原論文の値だが、別モデル（nnU-Net）。
代案（ユーザー判断）: TotalSegmentator の `meta.csv` のテスト 65 例のうち少数を使う参照実行は可能だが、MONAI の学習にテスト例が含まれていないかは未確認のため「独立」と書けない。

## 7. 参照実行に必要なもの（閾値の数値はここでは出さない）
| 欄 | 値 |
|---|---|
| コマンド | `python -m monai.bundle run --config_file configs/inference.json --datalist "['<path>.nii.gz']"`（R「Execute inference with Data Samples」）。評価は `--config_file "['configs/train.json','configs/evaluate.json']"`（`configs/evaluate.json` は 200 を確認、中身は未読） |
| 前処理 | 上の「推論の前処理」。**学習時の前処理は推論と違う**: T は CropForegroundd(margin 10, k_divisible 96) と GaussianSmoothd(sigma 0.4) があり、`inference.json` には無い。Dice を測る評価（T の validate）は GaussianSmoothd と中心 160³ クロップを含む |
| GPU メモリ | 1.5 mm: 約 29〜48 GB（推論 28.73 GB、評価 48 GB 以上推奨）。3.0 mm: 推論 5.89 GB。Colab T4（16 GB）では 1.5 mm は大きな CT で OOM の恐れ（実測は未実施）。CPU 推論は 1.5 mm で 26 GB RAM |
| 必要データ | 検証症例を特定できない（上述）。TotalSegmentator ZIP（28.4 GB）か、サンプル 25 例（Drive、未確認） |
| 症例の特定 | **不可** |

## 8. 注意点
- 番号は Bundle 独自で、TotalSegmentator 公式のクラス ID と違う。データを自作統合する場合も M の順序に従う必要がある（R）。
- 出力は 105ch だが保存されるのは argmax の 0〜104 の単一ラベル。主要臓器の重なりは無い（クラス排他）。
- 椎体・肋骨の番号は逆順/連番で辞書順と合わない（上記）。
- 向きは前処理で RAS に再配置、出力は Invertd で元の向きに戻す。左右の定義は M に明記なし。
- 入力を [-1,1] に正規化するため、窓・クリップが無い。造影相の前提は Bundle に記載なし（TotalSegmentator データは「scanner・pathology 様々」の臨床 CT で、相は混在 — Zenodo 説明）。
- M の `intended_use`: "This is an example, not to be used for diagnostic purposes"（診断用途不可）。
- 非決定的: R「this bundle is non-deterministic because of the trilinear interpolation」→ 再実行で Dice が少し揺れる。
- 学習時と推論時の前処理の差（GaussianSmoothd、CropForeground）は性能に影響しうるが、影響の大きさは未測定。
- R は「The model predicts 105 channels」「Label 0: Background … label 1-105」と書く箇所があるが、M は 0〜104 で、実際は 0〜104（R の 1-105 は誤記と思われる。断定は M の channel_def による）。
- 低解像度は `highres=false` で `model_lowres.pt` を読む。

## 不明・未確認の一覧
| 項目 | 理由 |
|---|---|
| 重みのライセンス | HF の cardData/license が null、モデルカード 404、Bundle の LICENSE はコード用 |
| 商用可否の最終結論 | 上記＋MONAI の条項が読み取れていない。法務判断（法務確認）へ |
| 学習に使った症例数・データ版・分割 | R/T に記載なし（T は利用者提供の `sampledata`） |
| mean_dice 0.8 の根拠 | M にデータ・分割の記載なし |
| ラベル別 Dice | Bundle に数値表なし。R の図は未取得・未判読 |
| `meta.csv` の中身（65 テスト例の ID） | ZIP 28.4 GB 未ダウンロード（方針） |
| 配布重みが TotalSegmentator のテスト例を学習していないこと | 記載なし |
| Google Drive のサンプル（20+5 例）・チェックポイント | curl 401 のため存在・サイズ未確認 |
| `configs/evaluate.json` の詳細 | 200 のみ確認、中身は未読 |
| 左右の定義（患者の解剖学的左右か） | M に明記なし |
| 1.5mm と 3.0mm の重みが別物か（同サイズ 75,225,922 B） | ハッシュ未確認 |
| Colab T4 での 1.5 mm 推論可否 | 未実測 |
| BTCV 等、ほかの独立データ | 未調査 |
