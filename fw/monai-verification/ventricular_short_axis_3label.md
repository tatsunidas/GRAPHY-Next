## ventricular_short_axis_3label（調査日 2026-10-18）

略記: B = https://raw.githubusercontent.com/Project-MONAI/model-zoo/dev/models/ventricular_short_axis_3label ／ HF = https://huggingface.co/MONAI/ventricular_short_axis_3label（B の各ファイル・HF とも curl で 200 確認済み。`docs/data_license.txt` は 404 ＝ Bundle に存在しない）。
一次資料の控え: scratchpad の `research/vsa/`（metadata.json, train.json, inference.json, README.md, LICENSE, hf.json, vis.ipynb）。

### 1. 版・入出力・GPU
| 欄 | 値 | 出典 |
|---|---|---|
| Bundle 版 / MONAI 版 | 0.3.5 / monai_version 1.3.0（PyTorch 1.13.0, numpy 1.21.2, nibabel 3.2.1, pytorch-ignite 0.4.8） | B/configs/metadata.json `version`, `monai_version`, `pytorch_version`, `optional_packages_version` |
| 名称・用途 | "Ventricular Short Axis 3-Label Segmentation"。`intended_use`: "This is suitable for research purposes only" | 同 `name`, `intended_use` |
| 入力 | 画像 1ch、**2D**、空間形状 [256,256]、float32、modality MR、format "magnitude"、`is_patch_data`: false、`value_range`: []（空） | 同 `network_data_format.inputs.image` |
| 出力 | 4ch（softmax→argmax で 0〜3）、[256,256] | 同 `outputs.pred`（`num_channels`: 4, `value_range`: [0,3]） |
| ラベル番号と名前 | 0 background / 1 lv_pool（左室内腔）/ 2 myocardium（左室心筋）/ 3 rv_pool（右室内腔） | 同 `channel_def`。README「The left ventricular pool is class 1, left ventricular myocardium class 2, and right ventricular pool class 3」。両者一致 |
| ネットワーク | MONAI `UNet`、spatial_dims 2、in 1、out 4、channels [16,32,64,128,256]、strides [2,2,2,2]、num_res_units 2 | B/configs/train.json `network_def`（inference.json も同一） |
| 処理の単位 | **スライス（2D 1 枚）ごと**。README: "The input to the network is single 2D images thus segmenting whole time-dependent volumes consists of multiple inference operations." 推論 config は `SliceInferer`（`roi_size` [256,256]、`spatial_dim` 2）で 3D ボリュームを 2D スライスごとに処理。ただし README「Inference of 3D volumes only can be accomplished with the inference.json」＝公式の推論 config は 3D の NIfTI のみ想定。時間（シネ）次元の扱いは Bundle に無い（時相ごとに別ボリュームとして与える必要がある。推定ではなく README の記述から導いた解釈） | README「Data」「Inference」、inference.json `inferer` |
| 入力サイズの扱い | 256×256 固定。train.json は学習データを (9095,256,256) の npz とし、README は「他のサイズは (256,256) に crop か zero-pad」と指示。inference.json にはリサイズ・pad の変換が**無い**（`LoadImaged`→`EnsureChannelFirstd`→`ScaleIntensityd`→`EnsureTyped`）。256×256 以外の入力を `SliceInferer` に通すとどうなるか（ROI 256 のスライディング窓として扱われる可能性）は**未確認** | README「Data」、inference.json `preprocessing`、`inferer` |
| 強度の前処理 | `ScaleIntensityd`（既定 minv 0, maxv 1 ＝ 画像全体の min-max を [0,1]）。学習時は npz の 2D 1 枚ごとに適用。推論 config では**ボリューム全体**の min-max になり、学習時（スライス単位）と正規化単位がずれる点に注意。サンプルノートブックは `im / im.max()`（下限 0 前提） | train.json `train_transforms`/`eval_transforms`、inference.json `preprocessing`、HF/docs/visualise.ipynb |
| GPU 要件 | README に記載なし＝**不明**。モデルは小さい（model.pt 6,533,160 B、HF の HEAD で確認）。学習は `batch_size` 200、`num_iters` 400、`num_epochs` 50（必要メモリは不明）。CPU でも動く記述（`device` は cuda 無しなら cpu）。実測が必要 | train.json、HF resolve/main/models/model.pt の content-length |
| 配布ファイル | `models/model.pt`（6,533,160 B）、`models/model.ts`（6,631,889 B）、`docs/SC-N-2-3-0.npy`（524,416 B：Sunnybrook SC-N-2 の 1 枚）、`docs/visualise.ipynb`。HF に README.md（モデルカード）は無い（`resolve/main/README.md` が 404、API `cardData`: null） | HF API siblings、各 HEAD |

### 2. ライセンス
| 欄 | 値 | 出典 |
|---|---|---|
| Bundle のコード | MIT（Copyright (c) 2022 Eric Kerfoot）。README「This model is released under the MIT License. The license file is included with the model.」 | B/LICENSE（全文取得）、README 末尾 |
| 重み | **MIT と README は書く（"This model is released under the MIT License"）が、metadata.json の `license` は "See license.txt" で、`license.txt` という名のファイルは Bundle に無い（LICENSE のみ）。HF API の `license` は None、カード無し**。重みを MIT とする記述は README の 1 文のみ → 重みの扱いは「README 上は MIT」まで。学習データの権利（下記）への配慮の有無は不明 | README、metadata.json `license`、HF API |
| 学習データ | **非公開（King's College London の未公開画像）**。ライセンス・同意範囲は**不明**（資料に記述なし） | README「Data」: "cannot be made public as it contains unreleased image data from King's College London" |
| 商用可否 | **不明**。コード・README の重み表記は MIT で形式上は可だが、(a) metadata が "research purposes only"（`intended_use`）と述べる、(b) 非公開学習データの権利・同意範囲が資料から確認できない、(c) `license` 欄が存在しないファイルを指す。→ 法務判断（法務確認）が要る | 上記 |

### 3. 学習データ
| 欄 | 値 | 出典 |
|---|---|---|
| 名前・配布元 | KCL（King's College London）の非公開データ。コホート・撮像シーケンス・施設数・患者数は**不明**（資料に無い） | README「Data」 |
| 件数 | 保存ボリューム形状 `(9095, 256, 256)` ＝ **2D 画像 9,095 枚**（患者数・時相数は不明）。上記は npz 全体で、学習／検証に分割して使う | README「Data」、train.json `partitions` |
| 時相 | "much of the training data is composed of segmented end-diastole images"（多くが拡張末期）。ただし全時相も許容（"Full cycle segmentation with this network is possible"）。割合は**不明** | README 冒頭 |
| MR シーケンス前提 | **明記なし**。metadata は "MR"・"magnitude" のみ。シネ bSSFP と書かれていない（SSFP/bSSFP とは断定できない＝**不明**）。短軸断面（2D short axis）は README に明記。ベンダー差を意識した強度オーグメンテーション（"difference between scanner vendors"）の記述あり ＝ 複数ベンダーのデータを含むと読めるが件数は不明 | README「Training」、metadata.json |
| 参考（公開データ、学習に使用ではない） | README は「Sunnybrook と ACDC は類似のネットワークの学習に使える」と述べる（このモデルの学習に使ったとは書いていない）。docs のサンプル画像は Sunnybrook SC-N-2 | README「Data」、visualise.ipynb |
| 手法の原典 | Kerfoot E. et al. (2019) "Left-Ventricle Quantification Using Residual U-Net", STACOM 2018, LNCS 11395, doi 10.1007/978-3-030-12029-0_40（doi は 200 で解決。本文は Springer のため未取得）。README は「ネットワークと学習方式は essentially identical」。ただし**原論文は LV 計量（STACOM 2018 のチャレンジ）が対象で、本 Bundle の 3 ラベル Dice の報告元ではない**ことは README の記述からの推測。論文本文は読んでいない → 不明 | README |

### 4. 既報の指標
| 欄 | 値 | 出典 |
|---|---|---|
| 既報の Dice | **無い**。metadata.json に `eval_metrics` が無い。README に Performance 節が無い。HF にカードが無い。ラベルごとの Dice・平均 Dice とも**未報告**（「読めていない」ではなく、Bundle 内の 4 資料を全文確認して記載が無いことを確認） | metadata.json 全文、README 全文、HF API |
| 検証の切り方 | train.json: `partitions = monai.data.partition_dataset(np.arange(len(@npz)),(8,2), shuffle=True)`、学習 8：検証 2（80/20）。**`seed` 引数なし**、他に乱数固定の記述なし → 配布済み重みで使われた検証画像は**特定できない**。かつ分割単位は 2D 画像（患者単位でない。同一患者のスライス・時相が学習と検証に分かれる＝リークの可能性が高い。画像と患者の対応表は非公開データのため不明） | train.json `partitions`, `train_sub`, `eval_sub` |
| 独立性 | 学習データの値は「独立性なし」。そもそも値が無い。検証指標 `val_mean_dice`（`MeanDice`、`include_background`: false）は train.json に定義があるだけで、結果は記載なし | train.json `evaluator.key_val_metric` |
| 損失・最適化 | DiceLoss（background 除外、softmax）、Adam lr 1e-3、50 epoch、サンプラは重み一様の復元抽出 | train.json `lossfn`, `optimizer` |

### 5. 独立に使える公開データ（基準ラベル付き）
重みの学習データが非公開で、画像単位の分割が不明のため、「モデルの学習に使われていない」ことを**保証できる公開データは無い**（ACDC/Sunnybrook/M&Ms のどれも、学習に使われていないという記述が Bundle に無い。README は「類似の学習に使える」と書くのみ）。下は候補の事実（利用には「学習に未使用」の保証が無いことを併記）。

| データ | 件数・内容 | 配布元・ライセンス・取得 | 出典 |
|---|---|---|---|
| ACDC（MICCAI 2017） | 150 例（学習 100＋テスト 50、各 5 群×30＝学習 20/群＋テスト 10/群）、ディジョン大学病院、1.5 T / 3.0 T の Siemens、**シネ SSFP の短軸**、厚さ 5 mm（8 mm もあり）、拡張末期・収縮末期の専門医 1 名の手動基準あり。サイズ（バイト数）・ライセンス条項・登録／同意の要否・ラベル番号は**未取得**（データ配布先は SPA 風のページで、本文を読めていない）。引用必須（Bernard et al., IEEE TMI 2018, doi 10.1109/TMI.2018.2837502） | 配布: https://humanheart-project.creatis.insa-lyon.fr/database/#collection/637218c173e9f0047faa00fb（リンクを databases.html から取得。このページは JS 描画のため 200 確認のみ未実施）。説明: https://www.creatis.insa-lyon.fr/Challenge/acdc/databases.html、…/databasesTraining.html、…/databasesTesting.html（いずれも 200） | 各ページ本文 |
| Sunnybrook Cardiac Data（SCD, 2009 LV segmentation challenge） | 45 例の cine-MRI（健常・肥大・梗塞を伴う／伴わない心不全）。**CC0 1.0（パブリックドメイン）**、"free to use for any usage"。引用: Radau P. et al., MIDAS Journal (hdl 10380/3070)。基準は**左室（内膜・外膜の輪郭）が中心で、右室内腔のラベルは含まれるか不明**（ページ本文で未確認）。サイズ・取得方法（Cardiac Atlas Project 経由）の詳細は未取得。サンプルの `SC-N-2-3-0.npy` は Bundle 付属のデモ画像 | https://www.cardiacatlas.org/sunnybrook-cardiac-data/（200、"Terms of usage" 節） | 同ページ |
| M&Ms | URL https://www.ub.edu/mnms/ は 200 だが、内容は JS で別ファイルを `load()` する構造で、データ件数・ライセンスを**取得できなかった**（`/mnms/data.html` 等は 404）。→ **不明** | — | — |

### 6. 再現検証の可否
**未達（分割を特定できない）＋参考値なし**。理由: (a) 既報の Dice がそもそも無い、(b) 検証分割は seed 無しの乱数で、元データも非公開、(c) 公開データに「学習に未使用」の保証が無い。つまり「同じ症例で既報値を再現する」検証は成立しない。可能なのは、公開データ（Sunnybrook CC0 など）での独立評価だが、基準値との比較であり、再現ではない。

### 7. 閾値（数値は出さない）— 参照実行に必要なもの
- 前提: 「同じ検証症例を MONAI 公式の手順で 1 回参照実行→症例別 Dice の平均−2×SD」は、**検証症例を特定できないため現状成立しない**。代案をユーザーに確認する必要がある（例: 公開データ（Sunnybrook を第一候補、CC0）の症例を選び、MONAI 公式手順で参照実行して同じ式で導く。ただしその場合、学習に使われていないことの保証は無く「独立性なし／不明」と明記する）。
- 公式手順: `python -m monai.bundle run evaluating --meta_file configs/metadata.json --config_file configs/inference.json --logging_file configs/logging.conf --dataset_dir dataset --output_dir ./output/ --bundle_root .`（README）。入力は `dataset_dir/*.nii*` の 3D NIfTI のみ。出力は argmax したラベル NIfTI。
- 前処理: `LoadImaged`→`EnsureChannelFirstd`→`ScaleIntensityd`（ボリューム全体の min-max）。**リサイズ・向き統一・256 への pad は無い**。
- 注意: 症例別 Dice を計算する側（基準ラベルとの比較）は Bundle に無い。基準ラベルのラベル番号を本モデルの 1=LV pool, 2=myocardium, 3=RV pool に写像する作業が要る（ACDC の番号は未確認＝写像は確認後）。
- GPU メモリ: 不明（上の 1 節）。モデルが小さいので CPU で実測可能と思われるが、実測前は断定しない。

### 8. 注意点
- **ラベル番号の写像**: 本モデルは 1=LV 内腔・2=心筋・3=RV 内腔。他のデータセットのラベル番号が同じ保証は無い（ACDC の番号は未確認だが、データごとに順序が違いうる）。比較前に必ず表で写像を確認する。
- **LV 内腔と RV 内腔の取り違え／向き**: 学習データの短軸画像の向き規約（左右反転・回転）は資料に無い。学習は `RandAxisFlipd`・`RandRotate90d`（各確率 0.5）で向きに頑健なはずだが、RV/LV の識別は形態に依存。NIfTI のスライス軸・向き（`SliceInferer` が `spatial_dim` 2 で処理する軸＝最後の空間軸であることは README/inference.json から推測）→ 向きは実データで目視確認が要る。
- **スライス軸**: `SliceInferer(spatial_dim=2)` は 3 軸目（Z）を走査する。短軸の積層が NIfTI の 3 軸目でない場合は軸を入れ替える必要がある（未検証）。
- **強度正規化の単位**: 学習＝2D 1 枚ごとの min-max、推論 config＝ボリューム全体の min-max。実運用でスライス間の輝度差があると挙動が学習時とずれる。
- **サイズ**: 256×256 以外の取り扱いは未検証（上記）。多くの臨床短軸は 192×256 等で、zero-pad/crop は呼び出し側の責任。README は学習時の pad を明示。
- **時相**: シネは時相ごとに別ボリュームとして与える。拡張末期が学習の中心で、収縮末期の精度は保証されない（README が "generally acceptable" と述べる程度で、数値なし）。
- **用途制限**: `intended_use` "research purposes only"。GRAPHY-Next に組み込み・配布する場合は、この文言と上記ライセンスの不一致を要確認。
- **向き・造影相・MR 前提**: 造影の有無・撮像シーケンス（bSSFP か否か）・磁場強度は資料に無い。「シネ bSSFP の拡張末期」を前提と書いた資料は無い（短軸 MR ということのみ明記）。
- **config 名**: configs/train.json は存在する（本 Bundle は問題なし）。他に `logging.conf`（README が参照。HF の siblings に存在。内容未確認）。

### 不明・未確認の一覧と理由
1. 既報 Dice（ラベル別・平均）: Bundle・README・HF のいずれにも記載なし（`eval_metrics` 無し、Performance 節無し、モデルカード無し）。
2. 検証画像の特定: seed 無しの `partition_dataset(shuffle=True)`、データ非公開。患者との対応も不明。
3. 学習データの件数（患者数）・コホート・MR シーケンス（bSSFP か）・磁場強度・ベンダー・拡張末期の割合・同意範囲・ライセンス: 非公開で資料に記述なし。
4. 重みの商用可否: README は MIT と述べる一方、`license` 欄が存在しないファイルを指し、`intended_use` は research only、学習データの権利は不明。
5. GPU 要件（推論・学習とも）: 記載なし。未実測。
6. 256×256 以外の画像を `SliceInferer` に通した挙動、スライス軸の取り方、時間次元の扱い: 実装未確認（コードを実行していない）。
7. ACDC: バイト数、ライセンス条項、登録・同意の要否、ラベル番号。配布先（humanheart-project）の本文を読めていない。
8. Sunnybrook: 右室ラベルの有無、ファイルサイズ、取得手順の詳細。
9. M&Ms: 件数・ライセンス・入手方法（ページ構造により本文を取得できず）。
10. 原論文（Kerfoot 2019）の本文: Springer のため未取得。学習データ・Dice の記載の有無は不明。
11. `logging.conf` の中身: 未取得（実行に影響しない可能性が高いが未確認）。
