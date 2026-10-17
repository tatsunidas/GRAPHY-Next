## wholeBrainSeg_Large_UNEST_segmentation（調査日 2026-10-18。調査のみ・データ未取得）

略称: B=https://raw.githubusercontent.com/Project-MONAI/model-zoo/dev/models/wholeBrainSeg_Large_UNEST_segmentation （以下の 5 ファイルは curl で 200 確認: configs/metadata.json, configs/train.json, configs/inference.json, docs/README.md, LICENSE）。`docs/data_license.txt` は **404（Bundle に無い）**。configs には他に `multi_gpu_train.json`, `logging.conf`（GitHub contents API で列挙）。HF: https://huggingface.co/MONAI/wholeBrainSeg_Large_UNEST_segmentation（API 200、重みは `models/model.pt`）。

### 1. 版・入出力・GPU
| 欄 | 値 | 出典 |
|---|---|---|
| Bundle 版 / MONAI 版 | 0.2.8 / MONAI 1.4.0、PyTorch 2.4.0、numpy 1.24.4、nibabel 5.2.1、einops 0.7.0、timm 0.6.7、pytorch-ignite 0.4.11、torchvision 0.19.0 | B/configs/metadata.json `version` `monai_version` `required_packages_version` |
| 入力 | T1w MRI 1ch、パッチ 96×96×96、float32、`image_classes`="single channel data, intensity scaled to [0, 1]"。ただし実際の前処理は下記 `NormalizeIntensityd`（nonzero、平均0・分散1）で、metadata の「[0,1]」とは**食い違う**（実処理を採る） | metadata.json `network_data_format.inputs`, `image_classes`; inference.json `preprocessing` |
| 出力 | 133ch（softmax→argmax で 0〜132 のラベル画像）。ネットワーク UNesT（patch_size 4, depths [2,2,8], embed_dim [128,256,512], heads [4,8,16]） | metadata.json `outputs.pred.num_channels`; inference.json `network_def` |
| 入力の前処理（推論） | `LoadImaged` → `EnsureChannelFirstd` → `NormalizeIntensityd(nonzero=True, channel_wise=True)` → `EnsureTyped`。**Orientation/Spacing/強度クリップなし**。リサンプリング・向き統一をしないので、入力が MNI305 空間（学習データと同じ格子）にある前提 | inference.json `preprocessing` |
| MNI 空間の前提 | **あり（必須）**。"The data should be in the MNI305 space before inference." 学習データは NiftyReg で MNI305 テンプレートへアフィン登録。登録済みなら不要。例として ANTsPy の Affine 登録コードを README が載せる（出力画像格子の仕様＝ボクセルサイズ・FOV は README に**記載なし＝不明**） | B/docs/README.md「Important」 |
| 推論の設定 | SlidingWindow roi 96³, sw_batch_size 4, overlap 0.7, `amp: false`（学習・検証は amp true, overlap 0.5） | inference.json `inferer` `evaluator`; train.json `validate#inferer` |
| GPU 要件 | **README の記載は「at least one 24GB-memory GPU」（学習・推論とも）**。聞いていた 11.5GB は Bundle 内（README/metadata/configs）に**見つからない**（"11.5" を grep 0 件）。推論の実測メモリは**不明（未計測）**。 | B/docs/README.md「Training configuration」 |
| 重みサイズ | model.pt 348,901,503 B（HTTP HEAD の x-linked-size / Content-Length） | `curl -I` https://huggingface.co/MONAI/wholeBrainSeg_Large_UNEST_segmentation/resolve/main/models/model.pt |

### 2. ラベル表（133 クラス、0〜132）
一次資料は metadata.json `network_data_format.outputs.pred.channel_def` と README「Complete ROI」（両者の内容は一致、番号・名前ともに写した）。名前は `側-略称-----正式名` の形式（ハイフン数は不揃い、番号 55 の名前の末尾に空白あり＝`'Right-FuG---fusiform-gyrus '`。名前での照合は strip が要る）。

| 範囲 | 内容（番号: 名前） |
|---|---|
| 0 | background |
| 1–2 | 1 3rd-Ventricle, 2 4th-Ventricle（左右なし） |
| 3–29 | 右→左の順の対: 3/4 Accumbens-Area, 5/6 Amygdala, 7 Brain-Stem（単独）, 8/9 Caudate, 10/11 Cerebellum-Exterior, 12/13 Cerebellum-White-Matter, 14/15 Cerebral-White-Matter, 16/17 Hippocampus, 18/19 Inf-Lat-Vent, 20/21 Lateral-Ventricle, 22/23 Pallidum, 24/25 Putamen, 26/27 Thalamus-Proper, 28/29 Ventral-DC（奇数=Right、偶数=Left） |
| 30–32 | 30 Cerebellar-Vermal-Lobules-I-V, 31 …VI-VII, 32 …VIII-X（左右なし） |
| 33–34 | **33 Left-Basal-Forebrain, 34 Right-Basal-Forebrain（ここだけ Left が先＝並びが逆）** |
| 35–132 | 皮質（右が奇数・左が偶数の対）: 35/36 ACgG, 37/38 AIns, 39/40 AOrG, 41/42 AnG, 43/44 Calc, 45/46 CO, 47/48 Cun, 49/50 Ent, 51/52 FO, 53/54 FRP, 55/56 FuG, 57/58 GRe, 59/60 IOG, 61/62 ITG, 63/64 LiG, 65/66 LOrG, 67/68 MCgG, 69/70 MFC, 71/72 MFG, 73/74 MOG, 75/76 MOrG, 77/78 MPoG, 79/80 MPrG, 81/82 MSFG, 83/84 MTG, 85/86 OCP, 87/88 OFuG, 89/90 OpIFG, 91/92 OrIFG, 93/94 PCgG, 95/96 PCu, 97/98 PHG, 99/100 PIns, 101/102 PO, 103/104 PoG, 105/106 POrG, 107/108 PP, 109/110 PrG, 111/112 PT, 113/114 SCA, 115/116 SFG, 117/118 SMC, 119/120 SMG, 121/122 SOG, 123/124 SPL, 125/126 STG, 127/128 TMP, 129/130 TrIFG, 131/132 TTG |

全 133 行の完全な番号＝名前の写しは metadata.json の `channel_def`（機械可読）を正とする。各行の完全名（例 35 Right-ACgG--anterior-cingulate-gyrus）は README の表にある。向きの定義（Right/Left が患者の右か画像の右か）は README に**記載なし＝不明**。名前に重複気味の組がある（77/78 MPoG postcentral-gyrus と 103/104 PoG postcentral-gyrus、79/80 MPrG precentral-gyrus と 109/110 PrG precentral-gyrus）— 原因は README に説明なし。
ラベル体系の由来: README は Huo et al. 2019（SLANT）を参照。133 の名称は Neuromorphometrics/BrainCOLOR 系に見えるが、**Bundle にその旨の明記なし＝不明**。

### 3. ライセンス
| 欄 | 値 | 出典 |
|---|---|---|
| Bundle のコード | Apache-2.0（"Copyright (c) MONAI Consortium"） | B/LICENSE（Apache 2.0 全文）、README 末尾 |
| 重み | 重み単独の記載なし。HF API の `license` は null、tags は `region:us` のみ。**不明** | https://huggingface.co/api/models/MONAI/wholeBrainSeg_Large_UNEST_segmentation |
| 学習データのライセンス | Bundle に記載なし（`data_license.txt` 無し、metadata `data_source` は空文字）。個別は下の表。OASIS は非商用・学術研究のみの DUA | metadata.json `data_source`; 下記 |
| 商用可否 | **不明（実質は不可寄りの懸念）**。コードは可。学習データの OASIS が「非商用・学術研究のみ」(DUA)で、重みへの波及は法務判断が要る。他の学習データ（Vanderbilt 内部）の条件は不明 | OASIS アクセスページ |

### 4. 学習データ・既報指標・分割
| 欄 | 値 | 出典 |
|---|---|---|
| 学習・検証データ | Vanderbilt 大学／VUMC のデータ＋公開の OASIS と CANDI。T1w 3 サイト。OASIS 50 例（45 学習・5 検証）。テスト = Colin27 1 例＋CANDI 13 例。全て MNI305 へ登録、前処理は Huo 2019 に従う。Vanderbilt 内部データの件数・公開可否は**不明**（記載なし）。ラベルの作り方（教師の出所）も README に**記載なし＝不明** | README「Data」 |
| 既報の指標 | `eval_metrics.mean_dice` = **0.71** の 1 値のみ。ラベル別 Dice なし。算出データ・分割の記載なし（README「Training/Validation Benchmarking」はグラフ画像 training.png のみで、"fine-tuning 600 epochs / 10 fine-tuned labels" とあり、0.71 がどの条件の値かは**不明**） | metadata.json `eval_metrics`; README |
| 検証の切り方（train.json） | `images`/`labels` = `sorted(glob(dataset/brain/{images,labels}/*.nii.gz))`、学習 `[:-2]`、検証 `[-2:]`（**末尾 2 例**）。seed 123（`set_determinism`）、val_interval 5、max_epochs 2000、lr 1e-4、DiceCELoss、バッチ 1、RandSpatialCrop 96³。ただしこれは**利用者が自分のデータでファインチューン／学習するための汎用の設定**で、データ（`dataset/brain`）は Bundle に同梱されていない。配布済み重みの作成時の分割とは**同一とは確認できない** | train.json `images` `train#dataset` `validate#dataset` |
| 独立性 | 0.71 は学習データの検証か、テスト（Colin27+CANDI13）かが特定できない → **「独立性なし／不明」扱い**。症例の特定もできない | 上記 |

### 5. 独立に使える公開データ（基準ラベル付き）
重要な前提: 重みは OASIS（50 例）と CANDI を**既に使っている**。したがって OASIS 由来・CANDI 由来の基準ラベル付きデータは独立でない可能性が高い。学習に使われていない症例の具体的な根拠は Bundle から得られない（Vanderbilt 内部の件数も不明）。

| データ | 件数 | 配布元・取得 | ライセンス・同意 | 学習との独立性 |
|---|---|---|---|---|
| OASIS-1 | 学習に 50 例使用（上記） | https://sites.wustl.edu/oasisbrains/home/access でフォーム申請（機関メールのみ、詳細な研究目的、DUA 同意） | 非商用・学術のみ。特定ライセンス名なし。国制限なし(OASIS-1) | **非独立**（学習に使用）。使うなら 50 例以外の症例だが、50 例の ID は README に無く特定不能 |
| CANDI Share（NITRC） | ページに件数なし。テストに 13 例使用 | https://www.nitrc.org/projects/candi_share/ （200） | ページ上は「Attribution (Creative Commons)」。登録要否はページから不明 | **非独立（テストに使用）**。ページに「under review for potential modification」の注記あり |
| Mindboggle-101 | 101 例（論文題名から。ページに件数なし） | https://mindboggle.info/data.html → OSF https://osf.io/nhtur/ / Harvard Dataverse / Synapse（要ログイン）。OSF ページは JS 描画でサイズ未取得 | **記述が食い違う**: mindboggle.info は「Except where noted … Creative Commons」(リンクは CC BY 4.0)、NITRC は CC BY-NC-SA 3.0。→ 保守的に NC-SA とみなす。登録: Synapse 経路のみログイン | 学習に使われた根拠は無いが、**使われていないことの根拠も無い**（一部が OASIS 由来の画像を含む可能性は未確認）。ラベル体系は DKT 系の皮質ラベルで、133 クラスと一対一ではない可能性が高い（名称対応表は未作成＝**未確認**） |
| MICCAI 2012 Multi-Atlas Challenge（Synapse syn3193805, 200） | 未確認 | https://www.synapse.org/Synapse:syn3193805 | 未確認 | OASIS 由来の可能性、未確認 |
サイズ・sha256: いずれも**未取得**（データ未ダウンロードの指示。OSF/Synapse は HEAD で取れず）。

### 6. 再現検証の可否
**未達（参考値のみ）**。理由: (a) 既報は mean_dice 0.71 の 1 値のみ、症例別・ラベル別なし、(b) 算出データ・分割を特定できない（train.json は利用者データ用の汎用設定）、(c) 学習データの主要部分（Vanderbilt 内部）は非公開と思われるが記載なし、(d) OASIS/CANDI は学習・テストに使用済みで独立でない。参考値: 0.71（独立性なし）。

### 7. 閾値（数値は出さない）— 参照実行に必要なもの
- 検証症例: **特定できない**。参照実行をするなら、独立性を保証できる別の基準ラベル付きデータが要る（5 の通り候補は未確定）。
- コマンド（MONAI 公式）: `python -m monai.bundle run evaluating --meta_file configs/metadata.json --config_file configs/inference.json --logging_file configs/logging.conf`（PYTHONPATH に Bundle ルート。`models/model.pt` を置く、入力は `dataset/images/*.nii.gz`）
- 入力: MNI305 空間の T1w（ANTs 等で Affine 登録）。強度は NormalizeIntensityd(nonzero) のみ
- 必要 GPU: README は 24 GB 以上。実測は未
- 出力はラベル画像（0〜132）で、Invertd により入力画像の空間に戻る（登録後の空間で出る）。比較は基準ラベルも同じ MNI305 空間にある必要がある
- 症例別 Dice は 133 ラベル別になる。平均−2SD の取り方（ラベル別か症例平均か）はユーザー確認が要る。

### 8. 注意点
1. **MNI305 登録が前提**。元画像をそのまま入れると破綻（向き・間隔・Orientation の補正が Bundle 側に無い）。GRAPHY-Next が登録を担う場合、登録の方法・格子が精度を左右する。登録後の画像格子の仕様が README に無い。
2. **ラベルの左右**: 33/34 だけ Left→Right の順（他は Right→Left）。偶奇での左右判定は 33/34 で外れる。Right/Left の向きの定義は不明（解剖学的に確認する検査が要る）。
3. 名前の末尾空白（55）、紛らわしい重複名（MPoG/PoG、MPrG/PrG）。
4. metadata の「intensity scaled to [0,1]」「format: hounsfield」は実処理と合わない（実処理は平均0分散1）。
5. GPU 24GB（聞いていた 11.5GB は出典なし）。重み 349 MB。
6. 非商用条項: OASIS の DUA が非商用・学術のみ。重みへの影響は法務判断。Mindboggle は NC-SA の記載あり。
7. "This is an example, not to be used for diagnostic purposes."（intended_use、README Disclaimer）。
8. 参照論文 arXiv:2203.02430 は腎臓（造影 CT）の論文で、脳の結果は含まない（abstract で確認）。脳の性能の一次資料は Bundle 内に 0.71 のみ。SLANT 論文（Huo 2019）は本文未確認。

### 不明・未確認の一覧と理由
- 重み単独のライセンス: HF の license 欄が null、記載なし。
- 学習データ Vanderbilt 内部の件数・公開可否・教師ラベルの作り方: README に記載なし。
- 0.71 の算出データ・分割・ラベル別値: 記載なし。
- 配布重みの学習時の分割: train.json はデータ非同梱の汎用設定。
- 11.5GB の根拠: Bundle 内で見つからず。推論の実測メモリ: 未計測。
- 登録後の画像格子（ボクセル、FOV）: README に記載なし。
- Right/Left の向きの定義、ラベル体系の由来（BrainCOLOR か）: 記載なし／未確認。
- CANDI の件数・登録要否、Mindboggle の正確な件数・サイズ・ライセンス（CC BY 4.0 と NC-SA の食い違い）、OSF の中身: ページが JS 描画／記載なしで未取得。
- Mindboggle ラベルと 133 クラスの対応: 未作成。
- 独立性の根拠（学習に使われていない症例）: 得られず。
- SLANT 論文（PubMed 30910724）の内容: cookie 同意ページで本文を読めず。
