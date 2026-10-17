## pancreas_ct_dints_segmentation（調査日 2026-10-18）

略記: GH = https://raw.githubusercontent.com/Project-MONAI/model-zoo/dev/models/pancreas_ct_dints_segmentation/ 、HFAPI = https://huggingface.co/api/models/MONAI/pancreas_ct_dints_segmentation 。いずれも curl で 200 を確認、全文取得。
注意: この Bundle の設定は `train.json` ではなく **YAML**（`configs/train.yaml` `evaluate.yaml` `inference.yaml` `multi_gpu_train.yaml` `search.yaml`）。`train.json` `inference.json` は 404。

### 1. 版・入出力・GPU
| 欄 | 値 | 出典 |
|---|---|---|
| Bundle 版 | 0.5.4（最新の changelog: 「ship search code ... loadable with torch.load(weights_only=True)」） | GH`configs/metadata.json` `version` |
| MONAI / PyTorch 版 | MONAI 1.4.0 / PyTorch 2.4.0（numpy 1.24.4、scikit-learn 1.5.1、nibabel 5.2.1、pytorch-ignite 0.4.11） | 同 `monai_version` `pytorch_version` `required_packages_version` |
| 入力 | CT 1ch、パッチ 96x96x96、float32、値域 [0,1]（HU を -87〜199 でクリップ→0〜1）、`format: hounsfield` | 同 `network_data_format.inputs`、`inference.yaml` の `ScaleIntensityRanged a_min -87 a_max 199 b_min 0 b_max 1 clip true` |
| 出力 | 3ch（one-hot）。channel_def: 0 background / 1 pancreas / 2 pancreatic tumor | 同 `network_data_format.outputs.pred.channel_def`、`label_classes`「1 is pancreas, 2 is pancreatic tumor, 0 is everything else」 |
| ラベル番号（推論保存時） | argmax 後の単一チャンネル値: **0 背景 / 1 膵臓 / 2 膵腫瘍**。MSD 側の名称は 2 = `cancer`（Bundle は「pancreatic tumor」と呼ぶ）。番号は両者で一致 | `inference.yaml`（`AsDiscreted argmax: true` → `SaveImaged`）、MSD `dataset.json` `labels` |
| 前処理（推論） | LoadImage → EnsureChannelFirst → Orientation **RAS** → Spacing **1x1x1 mm**（bilinear）→ ScaleIntensityRange（上記）。SlidingWindow roi 96³、overlap 0.625、sw_batch_size 4、AMP。後処理は softmax → Invertd（元空間へ戻す）→ argmax | GH`configs/inference.yaml` |
| GPU 要件 | 学習「at least 16GB-memory GPUs」。マルチ GPU（8GPU）学習時 System RAM 400G（Cache rate 1.0）。**推論の必要量は記載なし＝不明**（A100 80G での TensorRT 計測のみ。end2end 約 19 秒（AMP）〜55 秒（fp32）/症例 ※README 表は ms 単位） | GH`docs/README.md`「Training configuration」「Memory Consumption」「TensorRT speedup」 |
| 重みの置き場 | `models/model.pt`（HF）、`models/model.ts`、`models/search_code_18590.pt`（アーキテクチャ復元に必須。Bundle 0.5.4 で追加）。**GitHub の model-zoo には重みはなく HF から取得** | HFAPI `siblings`（sha 1b4b04a0…、lastModified 2025-06-30、usedStorage 1,107,873,843 B） |

### 2. ライセンス
| 欄 | 値 | 出典 |
|---|---|---|
| Bundle のコード | Apache-2.0（Copyright (c) MONAI Consortium） | GH`LICENSE` 先頭「Apache License Version 2.0」、`docs/README.md`「# License」。`metadata.json` `copyright` |
| 重み | 重み単独のライセンス記載なし。HF API は `cardData: null`、`license` 欄なし。HF に README.md は存在しない（`/raw/main/README.md` は "Entry not found"、ページは `LICENSE` と `docs/README.md` を表示）。→ **不明**（Bundle 全体の Apache-2.0 が及ぶと読むのが自然だが、記載としては未確認） | HFAPI、`siblings` に `LICENSE` あり |
| 学習データ | CC-BY-SA 4.0（MSD）。※ AWS 登録ページ内のリンク先は `creativecommons.org/licenses/by/4.0/`（BY の URL）だが、表示文言は「CC-BY-SA 4.0 International」で食い違う。`dataset.json` は `"licence": "CC-BY-SA 4.0"` | 実物 `Task07_Pancreas/dataset.json` `licence`、https://registry.opendata.aws/msd/（200）。`docs/data_license.txt` は「Medical Segmentation Decathlon / http://medicaldecathlon.com/」の URL のみでライセンス名なし |
| 商用可否 | **不明**。コードは可。学習データが CC-BY-SA 4.0（ShareAlike）で、学習済み重みへの波及の有無は法務判断（モデルレジストリの法務確認 へ）。`metadata.json` `intended_use`: 「This is an example, not to be used for diagnostic purposes」＝**診断用途に使わない旨の明記あり** | 上記 |

### 3. 学習データ
| 欄 | 値 | 出典 |
|---|---|---|
| 名前 / 配布元 | MSD Task07_Pancreas（Memorial Sloan Kettering Cancer Center）。造影（門脈相）CT。`data_source`: "Task07_Pancreas.tar from http://medicaldecathlon.com/" | `metadata.json` `data_source`、README「Data」（Modality: Portal venous phase CT, Source: MSKCC） |
| 件数（MSD 実物） | **ラベル付き学習 281 例 + テスト（ラベル非公開）139 例 = 420**。README の「282 Training +139 Testing」は実物（`numTraining: 281`、`training` 配列 281 件）と**1 例ずれる**。README の方が誤り（実物を優先） | 実物 `dataset.json` `numTraining` `numTest`、README「Size: 420 3D volumes (282 Training +139 Testing)」 |
| Bundle の分割 | `scripts/prepare_datalist.py` の既定: **training 196 / validation 56 / testing 29**（`train_size=196`、残り 85 を `train_test_split(train_size=0.66)` で 56/29）。MSD 本来のテスト 139 例は使わない（ラベルなし） | GH`scripts/prepare_datalist.py`（私の再計算で 196/85/56/29 を確認） |
| サイズ | tar 12,289,971,712 B（約 12.3 GB）、Last-Modified 2020-08-14、登録不要 | HTTP HEAD（下記 URL） |

### 4. 既報の指標
| 欄 | 値 | 出典 |
|---|---|---|
| 既報の値 | **mean Dice 0.62**（膵臓と腫瘍の 2 ラベルの平均、背景除外 `include_background: false`）。**ラベル別の値は記載なし＝不明** | `metadata.json` `eval_metrics.mean_dice`、README「Performance」 |
| 算出データ | **記載なし＝不明**。README は検証 Dice の学習曲線（3200 epochs の図）のみで、「test」か「validation」か明言なし。`train.yaml` の `validate` は検証 56 例で `MeanDice` を `val_mean_dice` として計算し、`CheckpointSaver(save_key_metric: true)` で最良の `model.pt` を保存するので、**0.62 は検証 fold の値（かつチェックポイント選択に使った値）である可能性が高いが、断定の根拠は無い**。テスト 29 例の値は報告なし | `train.yaml`（`validate#key_metric`、`CheckpointSaver`）、README |
| 独立性 | **限定的**。検証 56 例は勾配学習には使わないが、最良エポックの選択に使われた。学習 196 例での値は「独立性なし」 | `train.yaml` |
| 不一致 | `train.yaml` は `max_epochs: 400`、`val_interval: 10`。README の曲線は「3200 epochs」。`search.yaml` は `num_epochs_per_validation: 100`。公開重みがどの設定で得られたかは**不明**（changelog 0.3.7「re-train model with updated dints implementation」あり） | `train.yaml`、README、`search.yaml`、`metadata.json` changelog |
| 検証時の計算空間 | `train.yaml` の検証は **Invertd なし**＝1 mm RAS にリサンプリングした空間で Dice。`evaluate.yaml` は **Invertd あり**＝元空間で Dice。両者の Dice は一致しない | `train.yaml` `validate.postprocessing`、`evaluate.yaml` |

### 5. 独立に使える公開データ
| 欄 | 値 | 出典 |
|---|---|---|
| 候補 A（同じ MSD、未使用 fold） | 学習に使っていない MSD 症例は、検証 56 例（選択に使用）とテスト 29 例（学習にも選択にも未使用）。**テスト 29 例が最も独立に近い**が、同一施設・同一データセットで分布は同じ。独立データとして扱うなら「同分布の内部テスト」と明記 | `prepare_datalist.py` |
| 候補 B（別施設の公開データ） | **未調査**（この調査では探していない）。TCIA Pancreas-CT（NIH、82 例、膵臓のみ・腫瘍ラベルなし）等が一般に知られるが、件数・ライセンス・同意要否・MSD との重複有無を一次資料で確認していないため**不明**。腫瘍ラベルの検証には使えないと思われるが未確認 | — |
| 配布（MSD） | `https://msd-for-monai.s3-us-west-2.amazonaws.com/Task07_Pancreas.tar` 12,289,971,712 B、登録不要（AWS Open Data）。CC-BY-SA 4.0。AWS 登録ページには tar.gz 版も記載あり（サイズ未確認） | HTTP HEAD 200、https://registry.opendata.aws/msd/ |

### 6. 再現検証の可否
**条件付きで可（症例は計算で特定できるが、公開重みがその分割で学習された証拠は無い）。**
- 分割は `prepare_datalist.py` が `monai.utils.set_determinism(seed=123)`（numpy のグローバル乱数を seed）後、`random_state` 無指定の `sklearn.train_test_split` を 2 回呼ぶ。入力は `sorted(glob(labelsTr/*))` の 281 例。`dataset_0.json` 自体は Bundle に同梱されていない（HFAPI `siblings` に無い）。
- 私の再計算（numpy `np.random.seed(123)` → 同関数。MONAI は未インストールなので `set_determinism` そのものは未実行、scikit-learn 1.9.0 / numpy 2.4.4 で実行。順序入れ替えは `permutation` 依存で版差は小さいはずだが**公式の版（sklearn 1.5.1）では未確認**）:
  - 検証 56 例: pancreas_010, 016, 041, 042, 043, 048, 056, 058, 064, 070, 092, 102, 107, 117, 127, 138, 148, 160, 191, 204, 210, 213, 215, 218, 226, 246, 247, 255, 265, 266, 267, 268, 274, 279, 280, 295, 301, 311, 327, 333, 334, 336, 342, 347, 348, 357, 362, 366, 375, 378, 391, 398, 399, 406, 409, 416
  - テスト 29 例: pancreas_012, 052, 055, 069, 078, 093, 095, 114, 129, 131, 149, 170, 194, 212, 231, 262, 269, 286, 289, 303, 305, 312, 323, 331, 350, 351, 369, 400, 402
- 「DiNTS の交差検証の fold」: この Bundle は **fold を持たない**（固定 1 回のランダム分割。`dataset_0.json` の名前は fold 0 の慣習に似るが fold の仕組みは無い）。原論文（He et al. CVPR 2021）の fold 設定は一次資料を読んでいないので**不明**。
- 上記は「`prepare_datalist.py` を MONAI 公式 seed で実行すれば得られる分割」であり、公開重みの学習時に同一の分割が使われたことは、Bundle 内の記載（README は「The data list/split can be created with the script」）以上には確認できない。→ 判定は「可（ただし分割一致は未検証）」。MONAI 1.4.0 + sklearn 1.5.1 の環境で `prepare_datalist.py` を実機実行し、上の一覧と一致するかを段 0c で確かめるのが前提。

### 7. 閾値（数値は出さない）：参照実行に必要なもの
- コマンド（公式）: `python scripts/prepare_datalist.py --path <Task07_Pancreas> --output configs/dataset_0.json` → `python -m monai.bundle run --config_file "['configs/train.yaml','configs/evaluate.yaml']" --dataset_dir <Task07_Pancreas>`。これは `val_datalist`（validation キー、56 例）に対して `CheckpointLoader` で `models/model.pt` を読み、`MetricsSaver` で `val_mean_dice` を `metric_details` として**症例別に保存**する（`evaluate.yaml`）。ただし `evaluate.yaml` の保存は `val_mean_dice` が 2 クラス分（背景除外）の**症例別値**で、ラベル別は metric_details の列として得られる見込み（実行して確認すること）。
- 前処理: RAS、1mm 等方、HU -87〜199 クリップ→[0,1]（上記）。
- 必要 GPU: 学習は 16 GB 以上。推論の必要量は不明（sw_batch_size 4〜6、96³ パッチなので小さいと見込むが**実測が要る**）。
- 必要データ: Task07_Pancreas.tar（12.3 GB）。
- 症例の特定: 上記 56 例（検証）または 29 例（テスト）。分割一致が前提。
- 注: `evaluate.yaml` は `Invertd` を使うため、Dice は元空間。GRAPHY-Next 側も元空間で比べる。

### 8. 注意点
- **YAML**: 設定は `.yaml`（`train.yaml` 等）。spleen と同じ `train.json` の前提でスクリプトを書くと 404。
- **ラベル名**: MSD は 2 = `cancer`、Bundle は 2 = `pancreatic tumor`。番号は同じ。
- **ラベル 0/1/2 は排他**。腫瘍は膵臓の内部または周囲にあるが、番号上は 2 が 1 を上書き（膵臓全体の体積を見るなら 1 と 2 の和）。
- **評価指標**: 平均 Dice 0.62 は背景除外の 2 ラベル平均。腫瘍ラベルが無い症例では Dice の扱い（NaN か 0 か）に注意（MSD の training 281 例は全例に腫瘍ありとは限らない。**未確認**）。
- **アーキテクチャ復元**: `search_code_18590.pt` が無いと `DiNTS` を組めない。`torch.load(weights_only=True)` 対応の 0.5.4 の形式。旧版の重みと取り違えない。
- **TorchScript**: `models/model.ts` あり（HF）。`ckpt_export` 手順は README。
- **非決定的**: README「this bundle is non-deterministic because of the trilinear interpolation」。参照実行の値は実行ごとに僅かに揺れる。閾値の標準偏差にその揺れを含める。
- **造影相**: 門脈相（portal venous）CT が前提。非造影・動脈相は分布外。
- **向き**: 推論は RAS に再配置し元に戻す。GRAPHY-Next 側で LPS ↔ RAS の符号を取り違えると左右が反転する（負例で確認する）。
- **診断不可**: `intended_use`「not to be used for diagnostic purposes」。
- **README の誤り候補**: 「282 Training」は実物 281。

### 不明・未確認の一覧と理由
| 項目 | 理由 |
|---|---|
| 重みの単独ライセンス | HF API の `cardData`/`license` が空、HF に README.md なし |
| 商用可否 | 学習データ CC-BY-SA 4.0 の波及は法務判断 |
| 0.62 の算出データ（検証かテストか） | README・metadata に記載なし。設定上は検証 56 例の可能性が高いが断定不可 |
| ラベル別 Dice（膵臓・腫瘍） | 記載なし |
| 公開重みが上の分割で学習されたか | `dataset_0.json` 未同梱。再計算は numpy 2.4.4 / sklearn 1.9.0 で、MONAI の `set_determinism` を実行していない |
| 公開重みの学習設定（400 epochs か 3200 か） | README の図は 3200、`train.yaml` は 400 |
| 推論の GPU 必要メモリ | README に学習の 16 GB のみ |
| 原論文の fold 設定 | 論文本文を読んでいない |
| 独立した外部データ（TCIA 等）の件数・ライセンス・同意要否・重複 | 一次資料を未確認 |
| 腫瘍なし症例の有無と Dice の扱い | 全ラベルを集計していない（データ未ダウンロード） |
| MSD tar.gz 版のサイズ | 未取得 |
| 観察者間ばらつき | 文献値を探していない |
