## prostate_mri_anatomy（調査日 2026-10-18。調査のみ、データは未ダウンロード）

略記: GH = https://raw.githubusercontent.com/Project-MONAI/model-zoo/dev/models/prostate_mri_anatomy/ （curl 200 確認済み: configs/metadata.json, docs/README.md, LICENSE, configs/train.json, configs/inference.json, scripts/center_crop.py）。`docs/data_license.txt` は **404（Bundle に存在しない）**、`configs/train.yaml` も 404（train.json がある）。

**最重要の食い違い**: 依頼文にあった MSD Task05_Prostate（TZ/PZ・T2+ADC の 2ch）との関係は**無い**。本 Bundle の学習データは Prostate158（Zenodo）で、入力は **T2 のみ 1ch**。MSD Task05 とは別物（ラベル定義・チャネル数が違う。MSD の名前は Bundle のどこにも出てこない）。

### 1. 版・入出力

| 欄 | 値 | 出典 |
|---|---|---|
| Bundle 版 / MONAI 版 | 0.3.7 / 1.4.0（PyTorch 2.4.0） | GH `configs/metadata.json` `version`, `monai_version`, `pytorch_version` |
| 入力 | **T2w 1ch**、MR、float32、値域 [0,1]、パッチ 96³ | 同 `network_data_format.inputs.image`（`num_channels: 1`）。README「Only T2w images were used for this task.」 |
| 出力 | 3ch（0 背景・1 central gland・2 peripheral zone）、96³ | 同 `network_data_format.outputs.pred.channel_def`、`pred_classes` |
| ラベル番号と名前 | **1 = central gland（中心域。metadata の呼称）= README/論文表では Transitional Zone (TZ)、2 = peripheral zone (PZ)、0 = その他** | GH `metadata.json` `label_classes`: "1 central gland, 2 periheral zone, 0 is everything else"。README「central gland (1), peripheral zone (2), or background (0)」。性能表の列名は "Transitional Zone"。CG と TZ が同一ラベルを指すかは、README の同一ラベル扱い（1）以上の定義（精管・前部線維筋性間質の扱い等）は**不明**（論文本文は ScienceDirect が 403 で未読） |
| ネットワーク | UNet 3D、channels [16,32,64,128,256,512]、strides [2]*5、num_res_units 4、norm batch、act prelu、dropout 0.15 | GH `configs/train.json` `network_def` |
| 前処理（推論） | LoadImage → EnsureChannelFirst → Orientation **RAS** → Spacing **0.5×0.5×0.5 mm**（bilinear）→ ScaleIntensity(0,1) → NormalizeIntensity → 96³ SlidingWindow（overlap 0.5）→ argmax → **KeepLargestConnectedComponent（ラベル 1,2）** → Invertd | GH `configs/inference.json` `preprocessing`, `inferer`, `postprocessing` |
| 事前の center crop | README は学習データが center crop 済み（各辺 20%、既定 margin 0.2）で、新データでも繰り返すよう指示。`scripts/center_crop.py` | README「Preprocessing」、GH `scripts/center_crop.py`（`--margin` 既定 0.2、「Crop margins applied to EACH side in the axial plane」）。**crop の有無で結果が変わるかは未測定＝不明** |
| GPU | 学習: RTX 3080 1 枚、100 epoch で約 8 時間。推論の必要量は記載なし＝**不明**（Colab T4 で実測） | README「System Configuration」 |
| 重み | `models/model.pt`（152,810,901 B）、`models/model.ts` | HF `https://huggingface.co/MONAI/prostate_mri_anatomy/resolve/main/models/model.pt` の Content-Length（HEAD、200） |

### 2. ライセンス

| 欄 | 値 | 出典 |
|---|---|---|
| Bundle のコード | Apache-2.0 | GH `LICENSE`（Apache 2.0 全文、11,357 B。"Copyright (c) MONAI Consortium"）。metadata `copyright` は "Copyright (c) Keno Bressem"（changelog 0.3.1「fix license Copyright error」）。両者の併記の意味は不明 |
| 重み | 単独の記載なし。HF API `https://huggingface.co/api/models/MONAI/prostate_mri_anatomy` に license タグ無し（`tags: ["region:us"]`）、HF の README.md は存在しない（`/raw/main/README.md` が "Entry not found"）。**不明** | HF API（2026-10-18）。ただし重みは Prostate158 の `anatomy.pt` と同系統とみられるが、Bundle 重みが同一ファイルかは未確認 |
| 学習データ | Prostate158 のライセンス: Zenodo 6481141 / 6592345 の API メタデータに `license`・`rights` が**無い**（`access_right: open` のみ）。GitHub kbressem/prostate158 のコードは MIT（GitHub API）。**データのライセンスは不明**（Zenodo ページ HTML からも CC 等の記載を検出できず）。論文は Elsevier 版で CC 表示は確認できず（Crossref は TDM ライセンスのみ、Europe PMC は OA=N） | `https://zenodo.org/api/records/6481141`, `/6592345`; `https://api.github.com/repos/kbressem/prostate158/license`; Crossref |
| 商用可否 | **不明**（コードは可。重みとデータの利用条件が明文化されていない。要・論文著者への確認か法務判断） | — |

### 3. 学習データ

| 欄 | 値 | 出典 |
|---|---|---|
| 名前・配布元 | Prostate158（T2w + DWI + ADC の 3T bpMRI、Charité）。Zenodo DOI 10.5281/zenodo.6481141（train）、10.5281/zenodo.6592345（test） | GH `metadata.json` `data_source`、README「Data」。GitHub README kbressem/prostate158 |
| 件数 | 全体 139（train 配布）+ 19（test 配布）。train 配布内 train.csv = **119 行**、valid.csv = **20 行**（数えた） | train zip の `prostate158_train/train.csv`, `valid.csv`（HTTP Range でその 2 ファイルだけ取得）。139/19 は GitHub README「The training dataset (139 MRIs)」「19 additional MRIs」 |
| 使用 | 学習 = train.csv の `t2` と `t2_anatomy_reader1`（reader1 の解剖ラベル）。検証 = valid.csv | GH `train.json` `images`, `labels`, `val_images`, `val_labels` |
| 学習データのサイズ | train.zip 2,779,077,552 B（md5:a0d5361b7c4cbf3f17f7ccb9a2e1739c） | Zenodo API `files[0].size`, `checksum` |

### 4. 既報の指標と分割

| 欄 | 値 | 出典 |
|---|---|---|
| 既報 Dice（README） | **テストセット 19 例**で、Rater 1: TZ 0.877 / PZ 0.754、Rater 2: TZ 0.875 / PZ 0.730（HD 18.3/22.8, 17.5/33.2、Surface Distance 2.19/1.95, 2.59/1.88） | README「Performance」。GitHub kbressem/prostate158 README にも同じ表 |
| 既報 Dice（metadata） | central gland 0.88、peripheral zone 0.75 | `metadata.json` `eval_metrics.mean_dice`（README の Rater 1 値の丸めと一致） |
| 学習・検証・テストの分割 | 学習 = train.csv 119 例。検証 = valid.csv 20 例（ID 20,21,22,23,38,41,46,47,51,56,60,61,77,84,87,99,109,114,118,127）。**テスト = 別配布の 19 例（ID 1〜19）**。分割はファイルで固定（乱数分割ではない） | train zip の valid.csv、test zip の test.csv（ID 1〜19 を確認）。`train.json` は seed=321（`set_determinism`）だが分割には無関係 |
| 検証 20 例の独立性 | **独立性なし**。`CheckpointSaver`（`save_key_metric: true`, `val_mean_dice`）で valid の Dice が最良のチェックポイントを model.pt に保存している | `train.json` `validate#handlers`。提供された model.pt がこの手順で作られたかは未確認（metadata/README にその旨の明示なし）。選択の影響は小さい可能性があるが「独立性なし」と扱う |
| テスト 19 例の独立性 | 学習・検証リストに ID 1〜19 は無い（train は ID 24〜158、valid は 20〜127）。テストは README の指標の算出元。**ただし Bundle 重みがこのテストで選択・調整されていないことの直接の記述は無い**（論文は未読）→「学習に不使用」は ID の分離までを確認、それ以上は不明 | 上記 CSV。 |
| ラベル | テストは Reader 1 と Reader 2 の両方が解剖ラベルを持つ（`t2_anatomy_reader1`, `t2_anatomy_reader2`）。学習は reader1 のみ | test.csv 列。`interrater.csv` も同梱（中身は未取得）。評価に使うのは README 表と同じ reader 別 |

### 5. 独立に使える公開データ

| 欄 | 値 | 出典 |
|---|---|---|
| 名前 | Prostate158 test data（19 例、T2w/ADC/DWI、解剖 reader1+reader2、腫瘍） | Zenodo 6592345 |
| サイズ | prostate158_test.zip = 202,851,041 B（md5:403b3736cb12013ed7585e07cbda6978）。HEAD 200 | Zenodo API、`curl -I https://zenodo.org/records/6592345/files/prostate158_test.zip` |
| 取得 | 登録不要（`access_right: open`）。Zenodo から直接 | 同上 |
| ライセンス・同意 | メタデータに記載なし＝**不明**（上記 2 と同じ）。個別の利用同意の要否も不明 | — |
| 独立性の根拠 | ID が学習・検証と重ならない（上記 4）。公開日 2022-05-30 は train 配布（2022-04-24）より後で、README の既報値の算出元そのもの | Zenodo `publication_date` |
| 他の候補 | MSD Task05_Prostate は**本モデルの学習に使われていない**ことを Bundle 資料から確認はできないが、ラベル定義が違う（MSD は 1=PZ, 2=TZ の 2 クラス・T2+ADC。記憶に基づく記述のため要確認＝本調査では MSD の一次資料を未取得） | — |

### 6. 再現検証の可否
**可**。テスト 19 例（ID 1〜19）または valid 20 例を特定できる。既報値と同じ土俵（独立）で見るのはテスト 19 例（reader1 基準で README 表と比較）。valid 20 例は「独立性なし」の参考値。

### 7. 閾値のための参照実行に必要なもの（閾値の数値は出さない）
- コマンド（MONAI 公式手順）: `python -m monai.bundle run --config_file configs/inference.json --bundle_root <dir> --dataset_dir <prostate158_test>/ `。`datalist` は `test.csv` の `t2` 列、出力は `eval/`。**inference.json は Dice を計算しない**（metric 無し）ため、予測を保存してから `t2_anatomy_reader1`/`reader2` と症例別 Dice を別途計算する必要がある。
- 入力前処理: Orientation RAS、0.5 mm 等方、[0,1] スケール後に正規化、README は center crop の再現を指示（テストデータが crop 済みか未確認）。
- 必要データ: prostate158_test.zip（約 203 MB）。必要 GPU メモリ: 不明（sw_batch_size 4、96³、UNet 約 6 段）。
- 症例特定: 可（ID 1〜19）。reader が 2 人いるので、どちらを基準にするかを先に決める（README の既報は両方）。
- 前提: `train.json` の `dataset_dir` 既定は `/workspace/data/prostate158/prostate158_train/`、`inference.json` は `.../prostate158_test/`。

### 8. 注意点
- **MSD Task05 ではない**。ラベルの番号の取り違えに注意: 本 Bundle は 1=TZ(CG)、2=PZ。MSD は記憶では 1=PZ・2=TZ とされ逆順の恐れがある（未確認）。同じ「前立腺ゾーン」でも MSD の ADC 併用モデルと入力が違う。
- 名前のずれ: metadata は "central gland"、README は "Transitional Zone"。GRAPHY-Next の表示名は両方を併記するか、README の表と対応づける。
- PZ の Dice は 0.73〜0.75 と TZ（0.88）より低い。PZ に厳しい閾値を置くと誤って落ちる。
- 後処理に KeepLargestConnectedComponent（1,2）がある。GRAPHY-Next 側で同じ後処理が無いと Dice が変わりうる。
- 向き RAS・0.5 mm 等方への再サンプリングが必須。元画像は 0.47×0.47×3 mm の厚いスライス（README）。補間の影響を受ける。
- T2 専用。ADC/DWI を入れてはいけない（1ch）。
- 「This is an example, not to be used for diagnostic purposes」「research use only」（`metadata.json` `intended_use`、README「Limitations」）。
- metadata の `label_classes` 等に誤字（singe, periheral）。
- HF に README（モデルカード）が無い。ライセンスの確認先が GitHub の LICENSE と論文しかない。

### 不明・未確認の一覧と理由
1. 重みのライセンス: HF にタグ・カードが無い。
2. Prostate158 データのライセンス・利用同意: Zenodo メタデータに記載なし。論文本文は ScienceDirect が 403 で未読。
3. 商用可否: 上記 1・2 による。
4. CG と TZ が同一の解剖定義か: 論文未読。
5. 提供 model.pt が valid ベストの選択後か／テストで調整されていないか: 記載なし、論文未読。
6. 推論の必要 GPU メモリ: 記載なし。
7. center crop の有無の影響、テストデータが crop 済みか: 未測定・未取得（zip の中身のうちヘッダ・CSV のみ取得）。
8. MSD Task05 の仕様（ラベル順など）: 本調査の対象外で一次資料を未取得。
9. `interrater.csv` の中身（観察者間の Dice の可能性）: 未取得。
10. 観察者間ばらつきの文献値: 未探索。
