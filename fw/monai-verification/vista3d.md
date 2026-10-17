# vista3d（調査日 2026-10-18。全自動モード＝点プロンプトなしで使う範囲に限る）

略記:
- B = `https://raw.githubusercontent.com/Project-MONAI/model-zoo/dev/models/vista3d/`（全ファイル curl 200 確認）
- V = `https://raw.githubusercontent.com/Project-MONAI/VISTA/main/vista3d/`（curl 200 確認）
- 論文 = arXiv 2406.05285（https://arxiv.org/pdf/2406.05285 、curl 200、本文を pdftotext で読んだ）

## 最重要の所見（先に読む）
1. **この Bundle の `configs/train.json` は、元の VISTA3D の学習ではない**。MSD Task09 脾臓での**ファインチューニング用**（`README.md` 冒頭「To avoid confusion, we will only provide finetuning/continual learning APIs」）。したがって train.json の `fold: 0`・`datalist` は「公開重みの検証分割」ではない（脾臓 41 例を 5 分割し fold 0 の 9 例を検証に使う設定で、既定は `finetune: false`、`epochs: 5`）。
2. 既報の指標と検証分割の出典は **論文**と **VISTA リポジトリのデータリスト JSON**（乱数 seed 固定）。公開重みがその分割で学習されたことを示す一次資料は**読めていない**（下記 4・6）。
3. **重みのライセンスが二箇所で食い違う**。同じバイト列（LFS sha256 `c92bab26d00b4a5d89fa8a383900cdeb88302fd318e5e816df0bbec7106d9a1b`）が、MONAI/vista3d では **NVIDIA 非商用**、nvidia/NV-Segment-CT では **NVIDIA Open Model License（商用可）** と表示されている。商用可否は**不明**として法務確認へ（下記 2）。

## 1. 版・入出力・GPU

| 欄 | 値 | 出典 |
|---|---|---|
| Bundle 版 / MONAI 版 | 0.5.13 / monai_version 1.4.0、pytorch_version 2.4.0、numpy 1.24.4 | B`configs/metadata.json` の `version`, `monai_version`, `pytorch_version`, `numpy_version` |
| 必須パッケージ | matplotlib 3.9.1, einops 0.7.0, scikit-image 0.23.2, nibabel 5.2.1, pytorch-ignite 0.4.11, cucim-cu12 24.6.0, mlflow 2.17.2, tensorboard 2.17.0 | 同 `required_packages_version` |
| モダリティ | CT のみ（`modality: CT`）。`image_classes`: 1 channel | 同 `network_data_format.inputs.image` |
| 入力 | 1ch、パッチ 128×128×128、強度 [-963.8247715525971, 1053.678477684517] を [0,1] にクリップ＋スケール（HU を直接入力する前提）。再サンプリング 1.5 mm 等方（`Spacingd`, bilinear）、`CropForegroundd`（margin 10）、`Orientationd RAS` | B`configs/inference.json` の `preprocessing_transforms`, `resample_spacing`, `patch_size` |
| 出力 | ラベル番号は**全体共通のグローバル番号**（0〜132、連番ではない）。`SaveImaged` で float32 の .nii.gz。モデル外（ウィンドウ外）は NaN→255 に置換される設定あり（`Lambdad nan_to_num nan=255`） | 同 `postprocessing`、`inference.md`「All values outside of the window will set to be "NaN" ... (255 is used to represent NaN)」 |
| 全自動の指定方法 | 点も label_prompt も与えなければ `everything_labels` の **117 クラス**を出す。`python -m monai.bundle run --config_file configs/inference.json --input_dict "{'image':'xxx.nii.gz'}"`。複数ファイルは `inference.json` + `batch_inference.json`（`everything_labels` で全ファイル処理） | B`docs/README.md`「Single image inference to segment everything (automatic)」「Batch inference」、B`docs/inference.md`「If no prompt is provided, the model will use `everything_labels` to segment 117 classes」 |
| `everything_labels` の定義 | `list(set([i+1 for i in range(132)]) - set([2,16,18,20,21,23,24,25,26,27,128,129,130,131,132]))`。`len` = 117（実際に計算して確認） | B`configs/inference.json`、B`docs/inference.md` |
| GPU: 推論 | (a) 16 GB V100 でのベンチ: 体積 333×333×603 で 1m07s、512³ で 2m09s、512×512×768 で 3m25s、1024×1024×512 で 9m20s、1024×1024×768 は killed。 (b) 論文補足: 12 GB GPU＋CPU メモリ 32 GB の機で、典型 CT（MSD Task03、再サンプリング後 308×260×453）が 1m43s（TotalSegmentator は 2m41s）。(c) A100 80G の model computation 91.9 ms（amp）。**GPU メモリの最小値の明記は無い**。「12 GB で動いた」という記述が最低の実績。Colab T4（15 GB）での可否は**未測定＝不明**。CPU のみでの推論は `device` が cuda 無しなら CPU になる設定だが、速度・可否は**不明** | B`docs/inference.md`「Inference GPU benchmarks」「TensorRT speedup」、論文 補足「Inference Requirements」 |
| GPU: 学習 | 論文: 32 GB V100 ×64 枚、約 20,000 GPU 時間。16 GB 以下でも「プロンプト数を減らせば学習可」と書かれている。ファインチューニング（Bundle）の必要量は README に**数値の記載なし＝不明**（OOM 対策として `patch_size` を 96³ にする旨のみ） | 論文 補足「Training Requirements」、B`docs/README.md`「TroubleShoot for Out-of-Memory」 |
| 備考 | メタデータの `task` は "Multi-organ Segmentation in CT Scans with Zero-shot Learning"、`intended_use`: "This is an example, not to be used for diagnostic purposes"。`data_source` は "Task09_Spleen.tar"（Bundle 同梱の例の用途） | B`configs/metadata.json` |

### ラベル番号表（全自動で出る 117 クラス。名前は metadata.json `channel_def` と一字一句一致）
`docs/labels.json`（HF `MONAI/vista3d` の同名ファイル、124 エントリ）と `channel_def` を突き合わせ済み。名前→番号の食い違いは 0 件。labels.json に無いのは 0, 2, 16, 18, 20, 21, 129, 130, 131（＝背景と、複合クラス・未対応クラス）。**GitHub の model-zoo dev には `docs/labels.json` は無い（404）。HF にはある**。

| 番号 | 名前 | 番号 | 名前 | 番号 | 名前 |
|---|---|---|---|---|---|
| 1 | liver | 40 | vertebrae T10 | 87 | left humerus |
| 3 | spleen | 41 | vertebrae T9 | 88 | right humerus |
| 4 | pancreas | 42 | vertebrae T8 | 89 | left scapula |
| 5 | right kidney | 43 | vertebrae T7 | 90 | right scapula |
| 6 | aorta | 44 | vertebrae T6 | 91 | left clavicula |
| 7 | inferior vena cava | 45 | vertebrae T5 | 92 | right clavicula |
| 8 | right adrenal gland | 46 | vertebrae T4 | 93 | left femur |
| 9 | left adrenal gland | 47 | vertebrae T3 | 94 | right femur |
| 10 | gallbladder | 48 | vertebrae T2 | 95 | left hip |
| 11 | esophagus | 49 | vertebrae T1 | 96 | right hip |
| 12 | stomach | 50 | vertebrae C7 | 97 | sacrum |
| 13 | duodenum | 51 | vertebrae C6 | 98 | left gluteus maximus |
| 14 | left kidney | 52 | vertebrae C5 | 99 | right gluteus maximus |
| 15 | bladder | 53 | vertebrae C4 | 100 | left gluteus medius |
| 17 | portal vein and splenic vein | 54 | vertebrae C3 | 101 | right gluteus medius |
| 19 | small bowel | 55 | vertebrae C2 | 102 | left gluteus minimus |
| 22 | brain | 56 | vertebrae C1 | 103 | right gluteus minimus |
| 28 | left lung upper lobe | 57 | trachea | 104 | left autochthon |
| 29 | left lung lower lobe | 58 | left iliac artery | 105 | right autochthon |
| 30 | right lung upper lobe | 59 | right iliac artery | 106 | left iliopsoas |
| 31 | right lung middle lobe | 60 | left iliac vena | 107 | right iliopsoas |
| 32 | right lung lower lobe | 61 | right iliac vena | 108 | left atrial appendage |
| 33 | vertebrae L5 | 62 | colon | 109 | brachiocephalic trunk |
| 34 | vertebrae L4 | 63–74 | left rib 1〜12（63=rib1 … 74=rib12） | 110 | left brachiocephalic vein |
| 35 | vertebrae L3 | 75–86 | right rib 1〜12（75=rib1 … 86=rib12） | 111 | right brachiocephalic vein |
| 36 | vertebrae L2 | 112 | left common carotid artery | 113 | right common carotid artery |
| 37 | vertebrae L1 | 114 | costal cartilages | 115 | heart |
| 38 | vertebrae T12 | 116 | left kidney cyst | 117 | right kidney cyst |
| 39 | vertebrae T11 | 118 | prostate | 119 | pulmonary vein |
| 120 | skull | 121 | spinal cord | 122 | sternum |
| 123 | left subclavian artery | 124 | right subclavian artery | 125 | superior vena cava |
| 126 | thyroid gland | 127 | vertebrae S1 | | |

出典: B`configs/metadata.json` `network_data_format.outputs.pred.channel_def`（0 は background）。上の表で番号が書いてある行は 1〜127 のうち everything に含まれる 117 個すべて（2, 16, 18, 20, 21, 23〜27 は含まない）。

**everything から外れる番号（明示プロンプトなら出せるが、全自動の既定出力には含まれない）**: 2 kidney（→14 left kidney + 5 right kidney に分解）、20 lung（→28〜32）、21 bone（→33〜56, 63〜97, 114, 120, 122）、16 prostate or uterus、18 rectum、23 lung tumor、24 pancreatic tumor、25 hepatic vessel、26 hepatic tumor、27 colon cancer primaries、128 bone lesion、129 kidney mass、130 liver tumor、131 vertebrae L6、132 airway。
- 出典: B`configs/inference.json` の `subclass`, `everything_labels`、B`docs/inference.md`。
- 「対応外（legacy で番号だけ残る）5 件」は 16, 18, 129, 130, 131（`inference.md`「there are 5 we do not support」）。したがって対応は 127 クラス。腫瘍・血管 7 件（23〜27, 128 など。`inference.md` は「7 tumor and vessel classes」とだけ書き番号は列挙していない）と複合 3 件（2, 20, 21）は everything から外してある。

## 2. ライセンス（コード／重み／学習データを別々に）

| 欄 | 値 | 出典 |
|---|---|---|
| Bundle のコード | **Apache-2.0**。商用可 | B`LICENSE`（15,651 B）の前半は Apache License 2.0 全文。B`docs/README.md`「Code License ... Apache License 2.0」 |
| 重み（MONAI/vista3d `models/model.pt`、871,970,895 B） | **NVIDIA 非商用ライセンス（"NVIDIA License"）**。`docs/README.md` は「The model weights ... are licensed under the NCLS v1 License」と書き、`LICENSE` の後半「Model Weights License ... NVIDIA License」の全文が付く。要点: §3.3 Use Limitation「The Work and any derivative works thereof only may be used or intended for use non-commercially. Notwithstanding the foregoing, NVIDIA Corporation and its affiliates may use the Work and any derivative works commercially. As used herein, 'non-commercially' means for research or evaluation purposes only.」§3.1 再配布は同ライセンス＋全文同梱、§3.2 派生物にも非商用制限を課す必要あり、§3.6 違反で権利消滅。HF の `LICENSE` は GitHub と同内容（HF 側ファイルを取得して差分なし）。HF API の `cardData` は空で、カード上のライセンス欄は無い | B`LICENSE`「Model Weights License」「3.3 Use Limitation」、B`docs/README.md`「License」、`https://huggingface.co/MONAI/vista3d/raw/main/LICENSE`（200）、HF API `https://huggingface.co/api/models/MONAI/vista3d` |
| 重み（同一バイトの別配布: nvidia/NV-Segment-CT） | **NVIDIA Open Model License**（"commercial friendly" と VISTA 側 README が明記）。HF カード `license_name: nvidia-open-model-license-agreement`、本文「Model Weights License: NVIDIA Open Model License Agreement」。NVIDIA の契約ページ本文には「Models are commercially usable.」「You are free to create and distribute Derivative Models.」「NVIDIA claims no ownership rights in outputs.」とある（WebFetch の要約。原文の全条項は未精読）。ただし同カードに「This model is for research purposes and not for clinical usage.」とある | `https://huggingface.co/nvidia/NV-Segment-CT`（API・README とも 200）、V`README.md`「License: Commercial Friendly」「The model weight is released under commercial friendly NVIDIA open models license」、`https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-open-model-license/` |
| 同一バイトの根拠 | HF API の LFS oid が `MONAI/vista3d: models/model.pt` と `nvidia/NV-Segment-CT: vista3d_pretrained_model/model.pt` で**一致**（sha256 `c92bab26d00b4a5d89fa8a383900cdeb88302fd318e5e816df0bbec7106d9a1b`、サイズ 871,970,895） | `https://huggingface.co/api/models/MONAI/vista3d/tree/main/models`、`https://huggingface.co/api/models/nvidia/NV-Segment-CT/tree/main/vista3d_pretrained_model` |
| 姉妹モデル | NV-Segment-CTMR は **非商用**（NVIDIA OneWay Noncommercial License）。これは今回の対象外 | V`README.md` 表「License」、NV-Segment-CT カード「Sister Model ... Non-commercial」 |
| 学習データ | 混成。MSD は CC-BY-SA 4.0（脾臓パイロット行の調査と同じ。Bundle の `data_license.txt` は「Third Party Licenses ... Medical Segmentation Decathlon http://medicaldecathlon.com/」のみで条項なし）。TotalSegmentator v2 データセットは CC-BY-4.0（Zenodo 10047292）、AMOS22 は CC-BY-4.0（Zenodo 7262581）。**他の約 12 データセットのライセンスは未調査（不明）**。論文補足は「We included as much dataset with a commercial license as possible」とだけ書き、全件の商用可否は述べていない | B`docs/data_license.txt`、Zenodo API（取得日 2026-10-18）、論文 補足 1 |
| 商用可否 | **不明（法務確認が要る）**。理由: (1) コードは可。(2) 同一バイトの重みに、MONAI 側は「非商用（研究・評価のみ）」、NVIDIA 側は「商用可（Open Model License）」と**食い違う二つの表示**がある。どちらが有効か、MONAI 経由の取得に NVIDIA 側の条項が及ぶかは、一次資料からは決められない。(3) 学習データに CC-BY-SA の MSD などが混ざり、重みへの波及の有無は法務判断。**当面の安全側: MONAI/vista3d 経由で入れた重みは非商用（研究・評価のみ）扱い**。GRAPHY-Next への同梱・再配布は §3.1/§3.2 の条件（同ライセンス＋全文同梱＋派生物へ非商用制限）が付くので、モデルレジストリの法務確認 に回す | 上記 |

## 3. 学習データ

| 欄 | 値 | 出典 |
|---|---|---|
| 総数 | 「11454 CT volumetric images」。うち 5 データセットはラベル無し。データソースごとに 64% train / 16% val / 20% test にランダム分割。TotalSegmentator（v1 の 117 クラス）の疑似ラベルを全スキャンに作り、信頼できないものは後処理で除く。さらに SAM 特徴由来の 3D スーパーボクセルも学習に使う | 論文 §3.3 Data |
| 内訳（補足 Table 1 の「# cases used」） | TCIA Pancreas-CT 80／AbdomenCT-1K 1,050／AMOS22 300／MSD Task 3,6,7,8,9,10 計 945／CT-ORG 136／TotalSegmentator 1,228／CRLM-CT 197／VerSe 374／AeroPath 27／骨病変（院内・私的）296／LIDC-IDRI 470（ラベル無し）／COVID-19 524（ラベル無し）／TCIA Colonography 1,440（ラベル無し）／StonyBrook COVID19 CT 1,274（ラベル無し）／NLST 3,113（ラベル無し）。（BTCV-Abdomen, BTCV-Cervix, FLARE22 などの JSON も VISTA リポジトリにあり、表との対応は**未確認**） | 論文 補足 1「Table 1. Summary of datasets used for model training」、V`data/jsons/` の一覧 |
| 配布元 | 各データセットの配布元に依存（Zenodo, TCIA, Synapse, MSD など）。一覧と URL は論文の参考文献 [3,4,12,16,20,23,25,31,32,46-50,52,53,56] | 論文 §3.3 |
| 公開重みと論文の重みが同一か | **不明**。V`README_research.md` は「The configurations represents the training procedure but may not fully reproduce the weights of VISTA3D since each stage has multiple rounds with slightly varying configuration changes.」。公開チェックポイントが論文の分割でそのまま学習されたことを示す文言は見つからなかった（「見つからなかった」であり「無い」とは断定しない） | V`README_research.md` |

## 4. 既報の指標と、それが算出されたデータ・分割

**全て「論文のテスト分割（各データソースの 20%）」での Dice**（Bundle の `metadata.json` には指標の数値が無い。changelog 0.4.6「remove the metric part」）。以下は全自動（auto、点なし）列のみ。論文 Table 1・補足 Table 3 から転記。

| 項目 | 既報 Dice（VISTA3D auto） | データ・分割 |
|---|---|---|
| 論文 Table 1 平均（14 データセット） | 0.711 | 各テスト分割。ただし TotalSegV2 は「ground truth が TotalSegmentator 由来で、学習データがテスト分割を含む可能性がある」と論文自身が注記 |
| MSD09 spleen | 0.952（Table 1 と Table 3 一致） | MSD Task09 のテスト 8 例（下記）。参考: Table 1 の TotalSegmentator 列は 0.966、Table 3 では 0.935 と**論文内で食い違い**（原因は不明） |
| MSD03 liver / hepatic tumor | 0.959 / 0.588 | MSD Task03 テスト分割 |
| MSD07 pancreas / pancreatic tumor | 0.819 / 0.324 | 同 |
| MSD06 lung tumor / MSD10 colon cancer | 0.614 / 0.439 | 同 |
| BTCV-Abdomen（13 臓器） | spleen 0.944, right kidney 0.943, left kidney 0.942, gallbladder 0.794, esophagus 0.779, liver 0.967, stomach 0.944, aorta 0.931, IVC 0.842, portal/splenic vein 0.775, pancreas 0.841, right adrenal 0.692, left adrenal 0.646 | BTCV テスト分割 6 例（V`data/jsons/BTCV-Abdomen_5_folds.json`：training 24／testing 6） |
| AMOS22（15 臓器） | spleen 0.934, R kidney 0.945, L kidney 0.931, gallbladder 0.847, esophagus 0.776, liver 0.959, stomach 0.876, aorta 0.917, IVC 0.855, pancreas 0.797, R adrenal 0.700, L adrenal 0.704, duodenum 0.704, bladder 0.826, prostate or uterus 0.788 | AMOS22 テスト分割 60 例（training 240／testing 60） |
| AbdomenCT-1K | liver 0.974, spleen 0.966, pancreas 0.865 | AbdomenCT-1K テスト分割 |
| VerSe（C1〜L5） | 0.707〜0.881（例 C2 0.881, L3 0.752, L4 0.707） | VerSe テスト分割 |
| TotalSegmentatorV2（全 117 に近い数） | spleen 0.967, R kidney 0.934, L kidney 0.920, gallbladder 0.827, liver 0.968, stomach 0.931, aorta 0.959, IVC 0.883, portal vein 0.801, pancreas 0.860, R adrenal 0.863, L adrenal 0.873, 肺葉 0.878〜0.953, 椎体 0.752〜0.936（L5 0.916 …）, 肋骨 0.866〜0.932, heart 0.919, trachea 0.941, brain 0.894 など（全 117 クラスは補足 Table 3） | TotalSegmentator v2 のテスト 248 例（training 980／testing 248、合計 1,228 と一致） |

出典: 論文 Table 1（本文 §4）、補足 §4.2「Table 3. Dice score of all the classes on the test datasets」（`pdftotext -layout` で読み、Table 1 と Table 3 の整合は MSD09 で確認）。分割の件数は V`data/jsons/*_5_folds.json` の `training`/`testing` の長さを実際に数えた。

**分割の特定（再現に直結）**
- 分割は V`data/make_datalists.py` が作る。`test_ratio = 0.2`、`n_folds = 5`、`seed = 20230808`、`monai.data.utils.partition_dataset(..., shuffle=True, seed=seed)`。結果が V`data/jsons/<dataset>_5_folds.json` の `testing` に固定されている（再生成せずその JSON を使えば症例を特定できる）。
- **MSD Task09 のテスト 8 例**（`vj` の `testing`）: `spleen_44, spleen_21, spleen_61, spleen_29, spleen_38, spleen_46, spleen_53, spleen_33`（残り 33 例が training、fold 0〜4）。41 = 33 + 8 で、MSD の有ラベル 41 例と一致。
- TotalSegmentator v2 のテスト 248 例は ID リスト（`s0002, s0003, s0019, s0025, s0030, …`）を V`data/jsons/TotalSegmentatorV2_5_folds.json` の `testing` から取れる。training と重複 0（確認済み）。AMOS22 のテスト 60 例は `amos_0015, amos_0103, amos_0288, amos_0371, amos_0049, …`（V`data/jsons/AMOS22_5_folds.json`）。
- **Bundle の train.json／`configs/msd_task09_spleen_folds.json` の fold 0（9 例）は別物**: `spleen_19, 31, 52, 40, 3, 17, 21, 33, 49`。このうち `spleen_21`・`spleen_33` は VISTA の「テスト」分割（上記 8 例）と重なるが、他の 7 例（19, 31, 52, 40, 3, 17, 49）は VISTA 側では**学習／検証に入っている**（`Task09_5_folds.json` の training 33 例）。よって **Bundle の fold 0 の Dice は独立性なし**（脾臓パイロット行と同じ扱いにしてはいけない）。
- 独立性の判定: 論文のテスト分割は学習・検証に使っていないと論文は述べるが、(a) 公開重みが論文と同一かは不明（3 参照）、(b) TotalSegmentator 疑似ラベルは「全スキャン」に作られる（疑似ラベルが学習時にテスト分割へ及んだかは論文から読めない）、(c) 論文自身が TotalSegV2 の偏りを注記。**学習データでの値は「独立性なし」**。論文のテスト分割の値は、公開重みについて「独立性: 論文の主張どおりなら有り、一次資料での裏付けは弱い」。

## 5. 独立に使える公開データ（基準ラベル付き）

「モデルの学習に使われていないことの根拠」が強いものは**ほぼ無い**（VISTA は 20 超のデータセットを使い、主要な腹部 CT 公開データはほぼ入っている）。次の二系統。

| 候補 | 名前・件数・サイズ | 配布元・ライセンス・同意 | 学習に使われていないことの根拠 |
|---|---|---|---|
| A. 論文のテスト分割（推奨） | MSD Task09 脾臓 8 例（41 例の tar は 1,610,352,640 B。HEAD 200、Content-Length 確認）。TotalSegmentator v2 の 248 例（全体 zip 23,581,218,285 B）。AMOS22 の 60 例（全体 amos22.zip 24,234,336,519 B） | MSD: AWS S3 `msd-for-monai`、登録不要、CC-BY-SA 4.0（脾臓パイロット行の調査）。TotalSegmentator v2: Zenodo 10047292、CC-BY-4.0、アクセス open。AMOS22: Zenodo 7262581、CC-BY-4.0、open（Zenodo API で確認）。いずれも利用同意フォームの要否は API 上は不要（open）。AMOS は元サイトに登録がある場合があるが**未確認** | 論文が「64/16/20」でテスト分割を学習から外したと述べ、分割は seed 固定の JSON で再現できる。**ただし**: 公開重みが同分割で学習された裏付けは弱い（3・4 参照）。TotalSegmentator v2 は GT 自体が疑似的で、論文もバイアスを注記 |
| B. 論文が「学習に使っていない」と書いたデータ | WORD（腹部 16 臓器 CT、論文のファインチューニング実験用。**件数・サイズは未取得**） | HiLab-git/WORD。GPL-3.0、ただし README に「not for clinical, commercial, second-development, or other use」とあり**商用・二次開発は不可**。配布は Google Drive／BaiduPan（以前は申請制、現在は許可申請なしでパスワード付き zip と README 記載） | 論文（Table 3 付近の本文）が WORD を事前学習ではなくファインチューニング実験のデータとして挙げている（補足 Table 1 の学習データ表に無い）。一次資料で直接読んだのは README のライセンス記述まで。件数・ラベル仕様は**未確認** |

## 6. 再現検証の可否

- **可（条件付き）**: 論文のテスト分割（MSD09 の 8 例、AMOS22 の 60 例、TotalSegV2 の 248 例、BTCV の 6 例ほか）は JSON で症例を特定できるので、「同じ症例を本経路と MONAI 公式で通して、既報（例 spleen 0.952）と比べる」ことはできる。
- **未達＋参考値になる部分**: 公開重み＝論文の重みかが不明なため、既報の値は「参考値」。比較の基準は既報ではなく、**MONAI 公式手順で同じ症例を 1 回走らせた実測**にする（BRIEF の方針どおり）。Bundle 付属の fold 0（9 例）は独立性が無いので使わない。
- 参照実行の候補: MSD Task09 の 8 例（脾臓 label 3。Task09 の GT は脾臓のみ、ローカル 1 → グローバル 3 の対応は V`data/jsons/Task09_5_folds.json` の `label_dict`/`original_label_dict` = `{'1': 'spleen'}`）。複数臓器の確認には AMOS22 の 60 例（15 臓器）が向く。

## 7. 閾値に向けた参照実行の材料（閾値の数値は出さない）

| 項目 | 内容 | 出典 |
|---|---|---|
| コマンド（全自動・バッチ） | `python -m monai.bundle download "vista3d" --bundle_dir "bundles/"` の後、`python -m monai.bundle run --config_file="['configs/inference.json', 'configs/batch_inference.json']" --input_dir="/data/Task09_Spleen/imagesTr" --output_dir="./eval_task09"`（`input_list` で対象症例を絞る） | B`docs/README.md`「Installation Guide」「Batch inference for segmenting everything」、B`configs/batch_inference.json` |
| Dice の算出 | 評価用の設定は `configs/evaluate.json`（`train.json`＋`train_continual.json`＋`evaluate.json` を重ねる）。「dice score is calculated on the original image spacing using `invertd`」。ただし「Evaluation does not support point evaluation」で `val_head` は常に `auto`。`label_mappings` は `[[1, 3]]`（MSD の 1 → グローバル 3）。比較側（GRAPHY-Next）は同じ GT 領域で Dice を別途計算する | B`docs/README.md`「Evaluation」「Other explanatory items」、B`configs/train_continual.json`（`label_mappings`）、B`configs/evaluate.json` |
| 入力の前処理 | 上記 1 の通り（RAS・1.5 mm・HU クリップ −963.8〜1053.7 → [0,1]）。Invertd で元の空間へ戻す | B`configs/inference.json` |
| 必要 GPU メモリ | 実績は 12 GB（1m43s/例）。最小値は**不明**（1 参照） | 論文 補足 |
| 必要データ | 症例の画像（上記 ID）と GT。MSD Task09 は 1.61 GB、AMOS22 は 24.2 GB、TotalSegV2 は 23.6 GB の一括 zip（一部症例だけ取る方法は**未確認**） | 5 |
| 症例の特定 | **できる**（4・6 参照）。ただし Bundle の train.json の fold 0 ではなく VISTA の `testing` | 4 |
| 乱数・決定性 | 推論は `monai.utils.set_determinism(seed=123)`、`overlap: 0.3`、AMP 有効（`amp: true`）。AMP により GPU 種別で数値がわずかにずれる可能性あり（影響の大きさは**未測定**） | B`configs/inference.json` |

## 8. 注意点・つまずきそうな所

1. **ラベル番号はグローバル番号で連番ではない**。出力 NIfTI の値は 3=spleen, 1=liver, 5=right kidney, 14=left kidney など。MSD の GT（脾臓=1）と比べるときは 1↔3 の写像が要る（`label_mappings`）。ラベル名は metadata.json の `channel_def` が正。
2. **右腎 5 / 左腎 14 の番号が離れている**。名前は「left/right」だが、番号は 5=right kidney, 14=left kidney, 8=right adrenal, 9=left adrenal。患者の左右と画像の向きを混同しないこと（番号表と向きは別問題）。
3. **everything に含まれないクラスがある**（2, 20, 21 の複合、16, 18, 23〜27, 128〜132）。全自動でこれらが出ない・出せないのは仕様。label_prompt に 2/20/21 を入れると `subclass` で細分化される。ファインチューニングで 2/20/21 に写像した場合は `inference.json` の `subclass` を消す（README の注記）。
4. **出力に 255（NaN 代用）が出る**ことがある。`Lambdad nan_to_num nan=255` と `use_point_window`（点プロンプト時のみ有効）の組み合わせ。全自動ではウィンドウ処理は使われないはずだが、**出力に 255 が無いことは未確認**。集計の前に値の分布（unique）を確認する。
5. **入力は HU 前提**。強度 −963.8〜1053.7 をクリップ。造影相の指定は無く、論文は単相を要件にしていない（造影相の依存性は一次資料から**不明**）。MR や PET は対象外（CT 専用。姉妹の CTMR が別にある）。
6. **向き・間隔**: 内部で RAS と 1.5 mm に変換し Invertd で戻す。Spacing はサブ 1.5 mm の高解像度では劣化する可能性（サル CT では [1,1,1] の方が良かったと README）。ヒト CT での最適値は**未検証**。
7. **ライセンス**（2 参照）: MONAI/vista3d の重みは非商用（研究・評価のみ）。NVIDIA 側は商用可と表示されるが、同一バイトに二つの表示があり未解決。再配布時は全文同梱と派生物への非商用制限（§3.1/§3.2）。NVIDIA 側カードも「research purposes and not for clinical usage」。
8. **`train.json` を見て「VISTA3D の学習分割」と誤読しない**（冒頭の所見 1）。
9. **論文の数値の内部不整合**: MSD09 の TotalSegmentator 列が Table 1 で 0.966、Table 3 で 0.935。VISTA3D 自身の値（0.952）は両表で一致。
10. **辞書順の罠**: `batch_inference.json` の既定は `sorted(glob(...))`（辞書順）。MSD の `spleen_6` と `spleen_59` の並びが数値順にならない。症例は ID で明示して選ぶ。
11. **マルチ GPU 非対応**: 推論はシングル GPU のみ（README「The bundle only provides single-gpu inference」）。TensorRT 設定は `head_trt_enabled` 既定 false、`max_prompt_size` 4 で 16 GB。全自動は 117 プロンプトなので、TRT の class_head を有効にすると上限超えで PyTorch に戻る。
12. 重みの取得: Bundle の README は HF 経由（0.5.8「update to huggingface hosting」）。`models/model.pt` は HF `MONAI/vista3d` から。

## 不明・未確認の一覧と理由
| 項目 | 状態 | 理由 |
|---|---|---|
| 重みの商用可否 | 不明 | MONAI/vista3d は非商用、nvidia/NV-Segment-CT は Open Model License（商用可と表示）で、同一バイトに二つの表示。NVIDIA Open Model License の全条項は精読していない（WebFetch の要約のみ） |
| 公開重みが論文の重み・分割で学習されたか | 不明 | 一次資料に明言なし。README_research は「may not fully reproduce the weights」 |
| 学習データ約 12 件のライセンス | 未調査 | 時間配分上 MSD・TotalSegmentator・AMOS のみ確認 |
| BTCV・FLARE22 等の学習への使用 | 未確認 | 補足 Table 1 に BTCV の行は無いが、VISTA の JSON と論文の評価表には BTCV がある |
| GPU メモリの最小値、T4 での可否 | 不明 | 12 GB で動いた実績のみ。最小値の記載なし。Colab T4 は未測定 |
| ファインチューニングの GPU メモリ | 不明 | README に数値なし |
| 造影相・撮影条件への依存 | 不明 | 一次資料に記載なし |
| 出力に 255 が混じるか | 未確認 | 実行していない（調査のみの指示） |
| TotalSeg 疑似ラベルのテスト分割への波及 | 不明 | 論文から読めない |
| 論文 Table 1/3 の MSD09 TotalSegmentator 値の不一致 | 原因不明 | 論文に説明なし |
| AMOS22 の登録の要否、TotalSegV2 から一部症例だけ取る方法 | 未確認 | Zenodo は一括 zip のみ確認 |
| WORD の件数・サイズ・ラベル | 未取得 | README のライセンス記述までしか読んでいない |
| 閾値（平均−2×SD） | 出さない | BRIEF の指示。参照実行の材料は 7 に記載 |
| `docs/labels.json` が GitHub dev に無い理由 | 不明 | 404。HF にはあり（200）。metadata.json の `channel_def` と食い違いなしを確認済み |
