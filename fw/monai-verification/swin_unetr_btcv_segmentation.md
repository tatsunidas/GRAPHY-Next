# swin_unetr_btcv_segmentation（調査日 2026-10-18、調査のみ・データ未ダウンロード）

略記: MZ = `https://raw.githubusercontent.com/Project-MONAI/model-zoo/dev/models/swin_unetr_btcv_segmentation/`（以下の MZ 配下 6 ファイルは curl で 200 確認済み）。
SYN = Synapse REST API `https://repo-prod.prod.sagebase.org/repo/v1`（匿名・200 確認済み。Synapse の Web ページは JS 描画で本文が読めないため、wiki の markdown を API で取得した）。
HF = `https://huggingface.co/api/models/MONAI/swin_unetr_btcv_segmentation`（200）。

## 1. Bundle 版 / MONAI 版 / 入出力 / GPU

| 欄 | 値 | 出典 |
|---|---|---|
| Bundle 版 | 0.5.9（changelog 最新「add an optional ROCm inference config for AMD GPUs」） | MZ`configs/metadata.json` `version` |
| MONAI 版 / PyTorch | 1.4.0 / 2.4.0（numpy 1.24.4、itk 5.4.0、nibabel 5.2.1、pytorch-ignite 0.4.11、einops 0.7.0） | 同 `monai_version` `pytorch_version` `required_packages_version` |
| ネットワーク | SwinUNETR（spatial_dims 3、img_size 96、in_channels 1、out_channels 14、feature_size 48） | MZ`configs/train.json` `network_def` |
| 入力 | CT 1ch、パッチ 96x96x96、float32、値域 [0,1]（HU -175〜250 を clip して 0〜1 に線形変換） | metadata `network_data_format.inputs`、train.json / inference.json の `ScaleIntensityRanged`（a_min -175, a_max 250, b_min 0, b_max 1, clip true） |
| 出力 | 14ch（softmax → argmax でラベル値 0〜13） | metadata `network_data_format.outputs`、`pred_classes` |
| 前処理の全部 | LoadImaged（ITKReader）→ EnsureChannelFirstd → Orientationd RAS → Spacingd pixdim [1.5, 1.5, 2.0]（画像 bilinear）→ ScaleIntensityRanged → EnsureTyped | MZ`configs/inference.json` `preprocessing` |
| 推論 | SlidingWindowInferer roi 96³、sw_batch_size 4、overlap 0.5（推論）。評価（validate）は sw_batch_size 2、overlap 0.25。後処理に `Invertd`（元の空間へ戻す）＋ argmax | inference.json `inferer`、train.json `validate#inferer` |
| 重み | `models/model.pt` 256,336,065 B（HF の HEAD `x-linked-size`） | HF `resolve/main/models/model.pt` の HEAD（302 → x-linked-size）。HF の siblings にも `models/model.pt` |
| GPU（学習） | 32 GB 以上 | MZ`docs/README.md`「GPU: At least 32GB of GPU memory」 |
| GPU（推論） | **不明**（README に推論のメモリ記載なし。A100 80G での時間のみ: model computation 123.64 ms(tf32)、end2end 5102 ms(tf32)）。実測は段 0c で | README「TensorRT speedup」 |
| システム RAM | 5.8 GB（CacheDataset、30 サンプル、学習時） | README「Memory Consumption」 |

### BTCV の 13 ラベル（番号と名前）

3 つの一次資料が一致した（番号 1〜13、0 は背景）。

| 値 | 名前 | Bundle の綴り（metadata `label_classes`） | Synapse の記載 |
|---|---|---|---|
| 0 | 背景 | background | （ラベル 0 は未記載。「labeled as their associate numbers listed above」） |
| 1 | 脾臓 | spleen | (1) spleen |
| 2 | 右腎 | Right Kidney | (2) right kidney |
| 3 | 左腎 | **Left Kideny**（綴り誤り。README / metadata とも） | (3) left kidney |
| 4 | 胆嚢 | Gallbladder | (4) gallbladder |
| 5 | 食道 | Esophagus | (5) esophagus |
| 6 | 肝臓 | Liver | (6) liver |
| 7 | 胃 | Stomach | (7) stomach |
| 8 | 大動脈 | Aorta | (8) aorta |
| 9 | 下大静脈 | IVC | (9) inferior vena cava |
| 10 | 門脈・脾静脈 | Portal and Splenic Veins | (10) portal vein and splenic vein |
| 11 | 膵臓 | Pancreas | (11) pancreas |
| 12 | 右副腎 | Right adrenal gland | (12) right adrenal gland |
| 13 | 左副腎 | Left adrenal gland | (13) left adrenal gland |

出典:
- Bundle: MZ`configs/metadata.json` `label_classes` / `pred_classes` / `network_data_format.outputs.pred.channel_def`、MZ`docs/README.md`「Output」。
- 配布元: SYN`/entity/syn3193805/wiki2/217789/markdown`（Synapse wiki「Data Description > Abdomen」、gzip。「Thirteen abdominal organs … In the label images, these organs are labeled as their associate numbers listed above」）。
- 原コード側: `https://developer.download.nvidia.com/assets/Clara/monai/tutorials/swin_unetr_btcv_dataset_0.json`（200）の `labels` が 0 background、1 spleen、2 rkid、3 lkid、4 gall、5 eso、6 liver、7 sto、8 aorta、9 IVC、10 veins、11 pancreas、12 rad、13 lad。
- 注意: 「右腎・左腎」は患者の解剖学的な右・左（画像の右左ではない）かどうか、Synapse の記載は "right kidney" のみ。向きの規約は**不明**（確認するなら症例の画像で位置を見る）。

## 2. ライセンス

| 欄 | 値 | 出典 |
|---|---|---|
| Bundle のコード | Apache-2.0 | MZ`LICENSE`（Apache License 2.0 全文、"Copyright (c) MONAI Consortium"）。HF にも同名ファイルあり |
| 重み | **不明**。重み単独のライセンス記載なし。HF API は `cardData: null`、`license: null`、tags は `region:us` のみ。HF の LICENSE（Apache-2.0）はリポジトリ全体に付くが、学習データ由来の制約が重みに及ぶかは別問題 | HF API（2026-10-18） |
| 学習データ | **不明（BTCV に明示のライセンス表記を見つけられていない）**。Synapse wiki に license 表記なし。「The datasets will be freely available both during and after the challenge」「We will appreciate your quote of our website … if you use the dataset outside of this challenge」「Training data will be released … (with access under the conditions of the data sponsors)」の文言のみ。原コード側の dataset json は `"licence": "yt"`（意味不明の値）。IRB 承認は「We have already secured IRB approval, departmental approval, and medical center approval for this data release」 | SYN wiki 89480、217753。NVIDIA の dataset_0.json |
| Bundle の `docs/data_license.txt` | 中身は MSD（Medical Segmentation Decathlon）の URL のみ。**BTCV への言及なし**（コピー元の名残と思われるが理由は未確認 → 「不明」） | MZ`docs/data_license.txt`（6 行。"i. Medical Segmentation Decathlon http://medicaldecathlon.com/"） |
| 商用可否 | **不明**。コードは可（Apache-2.0）。データの条件が文書化されておらず、重みへの波及も確認できない。法務判断の対象 → モデルレジストリの法務確認 | 上記 |

## 3. 学習データ

| 欄 | 値 | 出典 |
|---|---|---|
| 名前 | BTCV（Beyond the Cranial Vault）Abdomen の `RawData.zip` | metadata `data_source`、README「Data」 |
| 件数（配布元） | 腹部 CT 50 例 = Training 30（ラベル付き）+ Testing 20（ラベル非公開、採点用） | SYN wiki 217789「Raw data are separated into 30 training and 20 testing subjects」「label files for the testing subjects are used for scoring … thus not provided」 |
| 件数（Bundle README） | 「30 3D volumes (24 Training + 6 Testing)」。**この記載は配布元の内訳（30 + 20）と合わない**。24+6 は Training 30 例の中の学習/検証分割を指すと推測されるが、README は説明していない（推測。確認不能） | README「Data」 |
| 件数（train.json） | Training 30 例のうち学習 21 例（`[:-9]`）+ 検証 9 例（`[-9:]`）。README の 24+6 とも**食い違う** | train.json `train#dataset`、`validate#dataset` |
| 撮影 | 門脈相の造影 CT。スライス数 85〜198、面内 0.54〜0.98 mm、スライス厚 2.5〜5.0 mm。大腸癌化学療法試験（進行中）と腹壁ヘルニア（後ろ向き）から無作為抽出 | SYN wiki 217789 |
| ラベル付け | 学部生 2 名が MIPAV で手作業、放射線科医が確認。**右腎・胆嚢が無い患者がある（その場合は未ラベル）** | SYN wiki 217789 |
| 配布元 | Synapse（Vanderbilt VUMC / MASI）`syn3193805`、Abdomen フォルダ `syn3376386`、`RawData.zip` = `syn3379050`（約 1.6 GB と wiki に記載。HEAD は認証が要り未取得） | SYN `/entity/syn3379050`、wiki 217789 |
| 自己教師あり事前学習 | Bundle の train.json は事前学習重みを読み込まない（「from scratch」の設定）。metadata は「utilizes self-supervised pre-training」と記載。model.pt が実際にどちらで作られたかは**不明**。なお原論文の事前学習データは LUNA16 / TCIA Covid19 / LIDC / HNSCC / TCIA Colon（計 5,050 例）で、BTCV・MSD は含まれない（論文の記載） | metadata `description`、train.json、arXiv 2111.14791「Pre-training Datasets」、付録 Table（200 確認済） |

## 4. 既報の指標と算出に使ったデータ

| 欄 | 値 | 出典 |
|---|---|---|
| 既報の値 | 平均 Dice **0.82**（ラベルごとの値は**どこにも無い**） | metadata `eval_metrics.mean_dice`、README「Performance」 |
| 何の上の値か | README は「Validation Dice」の図（5000 エポック）を載せるのみ。**学習データ上ではなく検証分割と読めるが、どの症例か README に明記なし**。train.json の検証は `validate#key_metric` = MeanDice（`include_background: false`）で、検証セットは `images[-9:]` | README「Validation Dice」、train.json |
| 検証の切り方 | `images = sorted(glob(dataset_dir + '/imagesTr/*.nii.gz'))`、`labels` も同様に別々に sorted。学習 `zip(images[:-9], labels[:-9])`、検証 `zip(images[-9:], labels[-9:])`。乱数 seed 123 は `set_determinism` のみで分割には無関係（分割は決定的で乱数なし） | train.json `images` `labels` `initialize` |
| 検証 9 例の特定 | Training の 30 例のファイル名は NVIDIA の json から `img0001〜img0010` と `img0021〜img0040`（学習 24 例 = 0001〜0010、0021〜0034、検証 6 例 = 0035〜0040）。辞書順の末尾 9 = **img0032, 0033, 0034, 0035, 0036, 0037, 0038, 0039, 0040**（ラベルは `label00NN.nii.gz`）。これはファイル名の一覧からの導出で、実物の Synapse データでは**未確認**（要ダウンロード後に `sorted(glob)` で確認） | NVIDIA json（`training` 24 + `validation` 6）、SYN wiki 217789（`img0001.nii.gz` の命名例）、train.json |
| 独立性 | **限定的／不明**。(a) Bundle の検証 9 例は train.json の学習 21 例に含まれないが、`CheckpointSaver(save_key_metric=true)` で**検証 Dice が最良のチェックポイントを model.pt として保存**するので、チェックポイント選択に使われている。(b) **model.pt を実際にどの分割で学習したかは文書化されていない**（README は 24+6、train.json は 21+9）。NVIDIA の分割だと 0032〜0034 は学習側に入る。0035〜0040 の 6 例は**どちらの分割でも検証側**。(c) テスト 20 例（img0061〜0080）のラベルは非公開。学習データ上の値は「独立性なし」 | train.json `validate#handlers.CheckpointSaver`、NVIDIA json、README |
| 参考: 原論文系の値 | Swin UNETR/Base の BTCV 検証 Dice 82.25（overlap 0.7）/ 81.86（0.5）。これは research-contributions の別モデルで、Bundle の model.pt と同一かは**不明** | `https://github.com/Project-MONAI/research-contributions/blob/main/SwinUNETR/BTCV/README.md`（200）表 |

## 5. 独立に使える公開データ（基準ラベル付き）

### 5.1 BTCV 自体（登録の要否）

| 欄 | 値 | 出典 |
|---|---|---|
| 登録・同意の要否 | **要（Synapse アカウント + チャレンジのチーム参加）**。Abdomen フォルダ `syn3376386` の ACL は特定ユーザーとチーム「Segmentation Outside the Cranial Vault 2015 Participants」（id 3324903）にだけ READ/DOWNLOAD を許可（匿名・AUTHENTICATED_USERS は無し）。このチームは `canPublicJoin: true`、`canRequestMembership: false` ＝**誰でも承認なしで参加できる**。アクセス要件（accessRequirement、利用条件の署名）は API で 0 件 | SYN `/entity/syn3376386/acl`、`/team/3324903`、`/entity/syn3376386/accessRequirement`（`totalNumberOfResults: 0`）、`/entity/syn3379050/accessRequirement`（0 件） |
| 手順 | wiki「Step 1」: Synapse アカウントを作って Join を押す。さらに「please send an email to masicranialvault@gmail.com using the email that you would like to get your results from … include your synapse username」（これは**結果提出用**の案内。ダウンロードに必須かは**不明**） | SYN wiki 217754、217753（"You need to **join** the challenge for the data access"） |
| 未確認の点 | 実際のダウンロードを試していない（匿名では不可）。参加時に Synapse 全体の利用規約の同意画面が出る可能性があるが、**確認できていない（不明）**。「Certified User」が要るのは結果の提出（submission）の場合のみと wiki にある | SYN wiki 217754「Certified Users」 |
| 結論 | 「登録不要」ではない。ただし承認待ちは無く、アカウント作成＋ワンクリック参加で取得できる（取得は人手。パスワード等はこちらで扱わない） | 上記 |
| 件数・サイズ | Training 30（ラベル付き）、`RawData.zip` 約 1.6 GB（wiki 記載）。`Abdomen.zip` 全部は 39 GB（不要） | SYN wiki 217789 |

### 5.2 登録不要の代替（BTCV 以外）

| データ | 件数 | サイズ（実測 HEAD / API） | ライセンス | 登録 | ラベルの関係 | 出典 |
|---|---|---|---|---|---|---|
| AMOS22 | CT 500 + MRI 100（論文） | `amos22.zip` 24,234,336,519 B（md5 67717b2a…89aef7、Zenodo） | CC BY 4.0 | 不要（Zenodo access_right: open） | 15 臓器: spleen, right kidney, left kidney, gallbladder, esophagus, liver, stomach, aorta, IVC, pancreas, right adrenal, left adrenal, duodenum, bladder, prostate/uterus。BTCV の 13 のうち **12 が共通。門脈・脾静脈（10）は無い**。**番号は BTCV と異なる可能性が高いが、AMOS 側の数値対応表は一次資料で未確認 → 不明**（論文の列挙順は膵臓が副腎の前で、BTCV の 11 とは順が違う） | `https://zenodo.org/api/records/7155725`（200）、arXiv 2206.08023（200）。Zenodo の説明に「500 CT and 100 MRI」 |
| TotalSegmentator v2.0.1 | CT 1,228 | `Totalsegmentator_dataset_v201.zip` 23,581,218,285 B | CC BY 4.0 | 不要（open） | 117 構造。**portal_vein_and_splenic_vein を含む**ので BTCV の 13 すべてに対応する構造が（名前の上では）ある。ただし 1 構造 1 ファイル形式で、結合してラベル番号を BTCV に合わせる作業が要る。副腎等の名前: adrenal_gland_right/left（README の表） | `https://zenodo.org/api/records/10047292`（200）、`https://raw.githubusercontent.com/wasserth/TotalSegmentator/master/README.md`（200） |
| MSD Task09_Spleen | 41 ラベル付き | 1,610,352,640 B（spleen パイロット行） | CC-BY-SA 4.0 | 不要（AWS S3） | 脾臓のみ（BTCV ラベル 1 に対応） | spleen_pilot_row.md |
| MSD Task07_Pancreas | （件数は未取得） | 12,289,971,712 B（HEAD、200） | CC-BY-SA 4.0（spleen 行の MSD 記載。Task07 個別は未確認） | 不要 | 膵臓 + 腫瘍（ラベル 2 つ）。BTCV の 11 に対応 | `https://msd-for-monai.s3-us-west-2.amazonaws.com/Task07_Pancreas.tar` HEAD 200 |
| MSD Task03_Liver | （件数は未取得） | 28,925,891,584 B（HEAD、200） | 同上 | 不要 | 肝臓 + 腫瘍。BTCV の 6 に対応 | 同 Task03_Liver.tar HEAD 200 |

「モデルの学習に使われていないことの根拠」:
- この Bundle の学習データは BTCV のみ（README「The training data is from the BTCV dataset」）。AMOS・TotalSegmentator・MSD は train.json に出てこない。
- 事前学習（原論文）に使われたのは LUNA16 / TCIA Covid19 / LIDC / HNSCC / TCIA Colon で、AMOS・TotalSegmentator・MSD・BTCV は含まれない（論文の記載）。ただし model.pt が事前学習重みを使ったかは不明（上記）。
- AMOS は中国の 2 施設のデータ（AMOS 論文「generated by two institutes from 2018 to 2021」）。BTCV（米国 VUMC）とは別施設だが、**症例の重複が無いことの明示の記載は見つけていない**（施設が違うことからの推論）。
- TotalSegmentator と BTCV の症例重複の有無は**未確認（不明）**。
- 参考: AMOS 論文は BTCV で学習した UNet を MSD 各課題に当てた値を載せるが、これは別モデルで Bundle の値の代わりにならない。

## 6. 再現検証の可否

| 欄 | 値 | 根拠 |
|---|---|---|
| 判定 | **条件付きで可**。同じ症例（img0032〜0040）は特定できる。ただし (1) BTCV の取得は Synapse 登録＋参加（人手）が要る、(2) model.pt が img0032〜0034 を学習に使った可能性があり（README の 24+6 分割なら学習側）、**9 例のうち独立と言えるのは img0035〜0040 の 6 例のみ**、(3) 既報 0.82 の算出症例が不明。よって「既報 0.82 との一致」を厳密な再現とは言えず、「参照実行との一致」を検証の基準にする | 第 4 節 |
| 段 0c への影響 | BTCV が取れるまでの間は、登録不要の AMOS（12 臓器が共通）で「独立データ」の検証ができる。ただしラベル番号の対応表の作成が要る | 第 5 節 |

## 7. 閾値（この調査では数値を出さない）

方法: 同じ検証症例を MONAI 公式の手順（GRAPHY-Next を通さない）で 1 回参照実行し、症例別 Dice の「平均 − 2×標準偏差」を下限にする。

参照実行に必要なもの:
| 欄 | 内容 | 出典 |
|---|---|---|
| コマンド | `python -m monai.bundle run --config_file "['configs/train.json','configs/evaluate.json']"`（`--dataset_dir <RawData のパス>` で上書き可）。evaluate.json は `CheckpointLoader` で `models/model.pt` を読み、`MetricsSaver` が `val_mean_dice`（`metric_details` = 症例別・ラベル別）を `eval/` に保存。検証セットは train.json の `images[-9:]` | README「Execute training … evaluation」、MZ`configs/evaluate.json` |
| 入力の前処理 | RAS、1.5×1.5×2.0 mm、HU -175〜250 を 0〜1 に clip。評価時は `Invertd` でラベルと同じ空間に戻して比較（evaluate.json）。**評価の overlap は 0.25（validate）**で、推論 inference.json の 0.5 とは違う | train.json、evaluate.json、inference.json |
| データの並べ替え | `RawData.zip` を展開し `Training/img` → `imagesTr`、`Training/label` → `labelsTr` に改名する（README の mv コマンド）。`dataset_dir` の既定は `/workspace/data/RawData/` | README「Preprocessing」、train.json |
| 必要な GPU メモリ | 学習は 32 GB 以上。**評価（推論）の必要量は不明**。`use_checkpoint: true` は train.json の設定。実測は段 0c で | README |
| 必要データ | `RawData.zip`（約 1.6 GB）。model.pt は 256,336,065 B | 第 3、1 節 |
| 症例の特定 | img0032〜0040（9 例）。独立性が高いのは img0035〜0040（6 例）。症例数が少ないので「平均 − 2×標準偏差」の標準偏差は粗い（9 例）。**ラベルごとの標準偏差は 1 つのラベルが 9 例中で欠ける場合がある（右腎・胆嚢が無い患者）ことに注意** | 第 4 節、SYN wiki 217789 |
| 指標の定義 | MeanDice は `include_background: false`、`one-hot 14ch`。**ラベルが GT に無い症例の扱い（NaN か 0 か）は MONAI の既定に依存し、Bundle は指定していない → 参照実行で NaN 数を確認** | train.json `validate#key_metric`。MONAI の既定は本調査では未確認 |

## 8. 注意点・つまずきそうな所

1. **README と train.json の分割が食い違う**: README「24 Training + 6 Testing」、配布元は 30 + 20、train.json は 21 + 9。model.pt の実際の学習分割は不明。検証 9 例のうち 0032〜0034 は「学習に入っていた可能性」を排除できない。
2. **ラベル番号と名前のずれ**: 10 は「門脈・脾静脈」。AMOS（10 番が膵臓の可能性）や TotalSegmentator（名前ベース）と**番号が違う**ので、対応表を作ってから比較する。metadata の綴り誤り「Left Kideny」は表示名に写さない（GRAPHY-Next 側は Left Kidney にする等、写し方を決める）。
3. **辞書順の落とし穴**: 検証 9 例は `sorted(glob)` の末尾。ファイル名が `img0001…img0010, img0021…img0040` と欠番があり、`images` と `labels` を別々に sorted している。ファイル名が揃っていないとペアがずれる（BTCV は対応する番号で揃う）。
4. **向き**: 前処理は RAS に再配向する。右腎／左腎の取り違えは再配向や向きの扱いを間違えると起きる。患者の右が画像のどちら側か、実データで要確認（未確認）。
5. **造影相の前提**: 学習データは門脈相の造影 CT のみ（SYN wiki 217789）。単純 CT・動脈相・非造影では性能が下がる可能性（本調査では未検証）。
6. **一部の患者はラベルが欠ける**: 右腎・胆嚢が無い患者は未ラベル。Dice の NaN 扱いに注意。
7. **ライセンス**: BTCV の利用条件が文書化されておらず、`data_license.txt` は MSD の記載のまま（BTCV 非言及）。商用可否は不明のままで、法務へ。Bundle 同梱の説明は「intended_use: This is an example, not to be used for diagnostic purposes」。
8. **取得の手間**: BTCV は Synapse アカウント＋参加が要る（承認待ち無し）。取得はユーザーの手で。AMOS と TotalSegmentator は約 24 GB で重い（全部落とさず、展開後の一部だけ使えるかは未確認）。
9. **エポック数の食い違い**: train.json は `max_epochs: 500`、README の Validation Dice の図は「5000 epochs」。どちらで model.pt を作ったかは不明。
10. 検証は MONAI の `MeanDice` で、`include_background: false`。GRAPHY-Next 側で背景を含めた平均を出すと値が合わない。

## 不明・未確認の一覧と理由

| 項目 | 理由 |
|---|---|
| 推論の GPU 必要メモリ | README に記載なし。未実測 |
| 重みのライセンス | HF カードのライセンス欄が空（cardData null）、重み単独の記載なし |
| BTCV のデータライセンス・利用条件 | Synapse wiki にライセンス表記が無い。accessRequirement も 0 件。`data_license.txt` は MSD の記載のみ |
| 商用可否 | 上記 2 つが不明 |
| model.pt の実際の学習分割・事前学習の有無 | README（24+6）と train.json（21+9）が食い違い、学習ログが公開されていない |
| 既報 0.82 の算出症例・ラベルごとの値・標準偏差 | metadata と README に平均値のみ |
| 検証 9 例のファイル名（img0032〜0040） | NVIDIA の json と命名例からの導出。Synapse の実物は未ダウンロード（`sorted(glob)` で要確認） |
| BTCV 参加時の追加の同意画面・メール送付の要否 | 匿名ではダウンロード不可で、参加操作を行っていない |
| 左右（右腎・左腎）の向きの規約 | Synapse に定義の記載なし。実データで確認が要る |
| AMOS のラベル番号の対応表 | 論文本文は臓器の列挙のみ。Zenodo の説明にも番号なし |
| AMOS / TotalSegmentator と BTCV の症例重複 | 重複が無いとの明示記載を見つけていない（AMOS は別施設という記載のみ） |
| AMOS のラベル付き症例数（公開分） | 論文は 500 CT + 100 MRI と記すが、ラベルが全件公開かは未確認 |
| MSD Task07 / Task03 の件数・個別ライセンス | HEAD でサイズのみ取得。dataset.json は未取得 |
| MONAI の MeanDice が GT に無いラベルをどう扱うか | MONAI のソースを本調査では読んでいない |
| `RawData.zip` の正確なバイト数 | HEAD は認証が必要（wiki の「1.6GB」のみ） |
