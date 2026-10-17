## multi_organ_segmentation（調査日 2026-10-18）

基底 URL（すべて curl で 200 確認済み）
- M = https://raw.githubusercontent.com/Project-MONAI/model-zoo/dev/models/multi_organ_segmentation/
- HF = https://huggingface.co/MONAI/multi_organ_segmentation ／ API https://huggingface.co/api/models/MONAI/multi_organ_segmentation
- 注意: `configs/train.json` `configs/inference.json` `docs/data_license.txt` は 404（この Bundle は YAML 構成。`train.yaml` `inference.yaml` `evaluate.yaml` `dataset_0.json` が実在）。

**最重要の結論（先に）**
1. ライセンスが「私的利用・非商用・再配布禁止・リバースエンジニアリング禁止」。「モデルを第三者に配布してはならない」「公衆網で共有・ネットでダウンロード可能にすることも不可」と明記。GRAPHY-Next への同梱・配布、商用提供、公開デモは不可と読める。**商用可否 = 不可**。
2. 学習データは非公開（愛知県がんセンター、420 例）。**独立に使える同一データは無い**。ただし分割（学習300/検証60/テスト60）の症例 ID は `dataset_0.json` で特定できるが、画像本体が無いので**再現検証は未達**。

### 欄ごとの表

| 欄 | 値 | 出典 |
|---|---|---|
| Bundle 版 | 0.0.7 | `M configs/metadata.json` `version` |
| MONAI 版 / PyTorch | monai_version 1.3.0 / pytorch_version 1.13.1（numpy 1.22.2。required: fire 0.5.0, nibabel 5.1.0, pytorch-ignite 0.4.11, pyyaml 6.0.2） | 同 `monai_version` `pytorch_version` `required_packages_version` |
| モデル | DiNTS（Neural Architecture Search）。アーキテクチャは MSD Pancreas で探索し、本データで再学習 | `docs/README.md`「Model Description」、metadata `description` |
| 入力 | CT 1ch、パッチ 96×96×96、float32、値域 [0,1]（HU を [-500,500] でクリップし [0,1] へ線形変換） | metadata `network_data_format.inputs.image`、`inference.yaml` `ScaleIntensityRanged a_min:-500 a_max:500 b_min:0 b_max:1 clip:true` |
| 出力 | 8ch（背景＋7 臓器）、パッチ 96³。推論の最終出力は argmax の 1ch ラベル画像 | metadata `network_data_format.outputs.pred.num_channels: 8`、`inference.yaml` `AsDiscreted argmax: true` |
| GPU 要件 | README に記載なし＝**不明**（推論の必要量は未記載）。学習は `train.yaml` で batch_size 2・96³・AMP・400 epoch、README の例は 8GPU（`--nproc_per_node=8`）。推論 `sw_batch_size: 4`, `overlap: 0.625`。実測は段 0c 想定 | `docs/README.md`、`train.yaml`、`inference.yaml` |
| 前処理（推論） | LoadImaged → EnsureChannelFirstd → **Orientationd RAS** → **Spacingd 1×1×1 mm（bilinear）** → ScaleIntensityRanged。後処理: softmax → Invertd（元空間へ戻す）→ argmax | `inference.yaml` `preprocessing` `postprocessing` |
| 重みファイル | `models/model.pt`（Content-Length 616,156,645 B ≒ 588 MiB）、`models/model.ts`、`models/search_code_18590.pt`（アーキ探索結果。推論に必須：`arch_ckpt_path`） | HF API `siblings`、`HEAD .../resolve/main/models/model.pt` |

### 1. ラベルの番号と名前（7 臓器＋背景）

| 番号 | 名前 | 出典 |
|---|---|---|
| 0 | background（everything else） | metadata `label_classes` / `pred_classes` / `channel_def` |
| 1 | artery（動脈） | 同 |
| 2 | portal vein（門脈） | 同 |
| 3 | liver（肝臓） | 同 |
| 4 | spleen（脾臓） | 同 |
| 5 | stomach（胃） | 同 |
| 6 | gallbladder（胆嚢） | 同 |
| 7 | pancreas（膵臓） | 同 |

- `metadata.json` の `label_classes`（"1 is artery, 2 is portal vein, 3 is liver, 4 is spleen, 5 is stomach, 6 is gallbladder, 7 is pancreas, 0 is everything else"）、`channel_def`、`docs/README.md`「Output」の 3 箇所が**一致**（取得済み実物で突き合わせ）。
- 注意: metadata の `description` は「eight abdominal organs and structures」と書くが、実体は背景＋7 構造（8 チャネル）。説明文の「eight」は 8 チャネルの意味で、臓器数ではない。「肝臓」「胃」等に加え動脈・門脈という**血管**が含まれる（臓器ではない）。
- 動脈・門脈の定義範囲（どこからどこまで）は資料に記載なし＝**不明**。
- 他 Bundle・他データセットとの番号の対応は未確認（記憶で補わない）。比較時は名前で対応づけ、各データの一次資料で番号を確かめること。

### 2. ライセンス

| 対象 | 値 | 出典 |
|---|---|---|
| Bundle の LICENSE（コード・重みを含むと読める） | "Private Use, Non-Commercial, Non-Reverse-Engineering License. The Licensee is not allowed to distribute or make the model to any third party, either for free or for a fee. Reverse engineering of the model is not allowed. This includes, but is not limited to, providing the model as part of a commercial offering, sharing the model on a public or private network, or making the model available for download on the Internet." | `M LICENSE`（423 B、全文）。README の「License」節も同文 |
| コード・重みの区別 | LICENSE はコードと重みを分けて書いていない。「the model」に対する条項。HF のモデルカード（README.md）はリポジトリ直下に存在せず、HF API の `siblings` に無い＝カード上のライセンス欄は**未確認（カード無し）** | HF API。`https://huggingface.co/MONAI/multi_organ_segmentation/raw/main/README.md` は "Entry not found" |
| 学習データ | 愛知県がんセンターの非公開データ。ライセンス・同意範囲の記載なし＝**不明**。`docs/data_license.txt` は存在しない（404） | README「This is a private dataset」 |
| 商用可否 | **不可**（LICENSE が非商用・第三者配布禁止・ネット公開禁止）。GRAPHY-Next への同梱・オンライン配布・商用提供は不可と読める。個人の私的な検証（ローカルでの実行）に限れば範囲内と読めるが、「私的利用」の範囲の解釈（法人内利用を含むか）は**法務判断が要る** | 上記 LICENSE |

### 3. 学習データ

| 欄 | 値 | 出典 |
|---|---|---|
| 名前 | 愛知県がんセンター（Aichi Cancer Center, Japan）の腹部 CT、門脈相 | README「Data」、metadata `data_source` |
| 件数 | 420 例 → 学習 300 / 検証 60 / テスト 60 | README「we split the 420 cases into training, validation and testing with 300, 60 and 60 cases」。`dataset_0.json` の実件数も training 300 / validation 60 / testing 60（取得して数えた。学習と検証の重複 0） |
| 配布元 | **非公開**。README は代替として BTCV（Synapse）での同様の学習を示すのみ | README |
| ラベルの作り方 | 不明（誰がどう付けたか記載なし）。参考文献 [2] Roth 2018（MICCAI）、[3] Shen 2022（SPIE）は未読＝未確認 | README「References」 |
| 造影相 | 門脈相（portal venous phase） | README「Data」 |
| 画像ファイル名の規則 | `<ID>/<ID>-data.nii.gz`、`<ID>/<ID>-label.nii.gz`（ID 例 `ACC_g559h`。大文字小文字が混在、例 `acc_g051h`、`acc_g029`） | `configs/dataset_0.json` |

### 4. 既報の指標と分割

| 欄 | 値 | 出典 |
|---|---|---|
| 平均 Dice | 0.88（metadata）／ 88.6%（README）。**2 つの値が微妙に違う**（0.88 は丸め値と読めるが断定せず、食い違いとして記録） | metadata `eval_metrics.mean_dice`、README「Scores」 |
| 算出データ | README: "validation data (our own split from the whole dataset)" ＝ 検証 60 例。テスト 60 例での値は**どこにも無い** | README「Scores」 |
| ラベルごとの Dice | **記載なし＝不明**（平均のみ。臓器別・症例別の値は資料に無い） | README、metadata |
| 検証の切り方 | 固定の datalist。`dataset_0.json` の `training`（300）/`validation`（60）/`testing`（60）。`train.yaml` は `data_list_key='training'` で学習、`'validation'` で検証、`inference.yaml` は `'testing'` を使用。乱数 seed での分割ではなく**ファイル記載の列挙**。`initialize` に `set_determinism(seed=123)`（学習の再現用で、分割とは無関係） | `train.yaml` `train_datalist` `val_datalist`、`inference.yaml` `datalist`、`dataset_0.json` |
| 検証 60 例の位置づけ | `ValidationHandler` ＋ `CheckpointSaver(save_key_metric: true, key_metric_filename: model.pt)` ＝ **検証 mean Dice 最良のチェックポイントが model.pt**。したがって 0.88 は検証 60 例で選んだ値で、**テスト 60 例は未使用の独立候補**（ただし README に「テストで評価していない」旨の明記は無い） | `train.yaml` `validate#handlers` |
| 独立性 | 検証 60 例の値 = チェックポイント選択に使ったため独立性なし。テスト 60 例のみ独立候補だが**画像が非公開で入手不可** | 同上 |

### 5. 独立に使える公開データ（基準ラベル付き）

**確定できたものなし。** 理由と候補:
- 学習・検証・テストのどれも非公開データ（愛知県がんセンター）。外部に出ていないので、公開データが学習に使われていないことの根拠は「README に学習データは private とある」点のみ（BTCV 等が学習に混入していないことを積極的に示す資料は無い＝「使われていない」を断言できず、「記載されていない」止まり）。
- 候補 BTCV（Synapse syn3193805、README が言及）: 30 例ラベル付き等の詳細は**一次資料未取得**（Synapse はログイン必須の可能性。ページ URL `https://www.synapse.org/` は 200 だが個別ページは未確認）。**動脈のラベルが BTCV にあるか、門脈の定義が同じか未確認**。ラベル体系がこの Bundle と一致しないため、比較できるのは共通する臓器（肝臓・脾臓・胃・胆嚢・膵臓 など）に限られる見込みだが、これは確認していない＝推測。サイズ・ライセンス・同意条件・取得方法は**不明（未調査）**。
- 候補 MSD Task07_Pancreas（アーキ探索に使用されたとされる）: 本 Bundle の学習データではなくアーキ探索データなので、独立性の判断は「再学習には愛知のデータ」と README にあることのみ。ラベルは膵臓＋腫瘍で本 Bundle と体系が違う。詳細は未調査。
- 追加調査が必要なら、BTCV・AMOS・TotalSegmentator 等のラベル体系・ライセンスを一次資料で確認する作業が別途要る。

### 6. 再現検証の可否

- **未達（参考値のみ）**。症例 ID（検証 60、テスト 60）は `dataset_0.json` で特定できるが、画像・ラベルが非公開のため同じ症例を通せない。
- 参考値: 検証 60 例 mean Dice 0.88（metadata）/ 88.6%（README）。ラベル別は不明。この値は独立性なし。
- 公開データ（BTCV など）での検証は「同一分布でない外部検証」になり、再現検証ではない。

### 7. 参照実行に必要なもの（閾値の数値は出さない）

- 同じ検証症例の参照実行は**不可**（データ非公開）。したがって「平均−2×標準偏差」の下限は、この Bundle では**この調査の範囲では決められない**。
- 参照実行の手順だけ記録（公開データで外部検証する場合に使える）:
  - コマンド: `python -m monai.bundle run --config_file configs/inference.yaml`（README）。指標つきの評価は `python -m monai.bundle run --config_file "['configs/train.yaml','configs/evaluate.yaml']"`（README）。`--dataset_dir` で上書き。
  - 前処理: 上記（RAS、1 mm 等方、[-500,500] → [0,1]）。SlidingWindow 96³、overlap 0.625。
  - 必要ファイル: `models/model.pt`（HF から取得、588 MiB）＋ `models/search_code_18590.pt`（必須）。
  - GPU メモリ: 未記載＝不明（実測が要る）。
  - 実行環境の注意: `inference.yaml` は `imports` に `glob` `os` のみ。`dataset_dir` の既定は "/data/"。`datalist` は `testing` キーを `dataset_0.json` から読む（Bundle の `testing` は愛知の症例なので、公開データで試すには datalist を差し替える必要）。
  - モデル重みの取得そのものはライセンス上「自分だけの私的利用」の範囲に限られる。

### 8. 注意点・つまずきそうな所

- **ライセンス**: 上記のとおり配布・公開・商用が不可。GRAPHY-Next にこの Bundle を載せる、プラグインで配布する、デモに使う、のいずれも要法務確認（現状は不可と読める）。HF 上で公開されている点と LICENSE の矛盾は未解決（HF は誰でもダウンロード可＝gated:false）。
- **ラベル体系**: 7 構造のうち動脈・門脈は血管で臓器ではない。説明文の「eight」は 8 ch の意味。
- **数値の食い違い**: Dice 0.88 と 88.6%。
- **ファイルの食い違い**: 指示にあった `configs/train.json` は無く `train.yaml`。HF 側 `README.md` カードが無い。
- **向きと間隔**: Orientationd RAS、1 mm 等方に再サンプリング。出力は Invertd で元空間に戻す。GRAPHY-Next 側で同じ前処理を再現しないと、Dice が下がる。
- **造影相**: 学習は門脈相のみ。動脈相・単純 CT・他相では精度が落ちる見込みだが、これは資料にない推測であり未検証。
- **意図された用途**: "This is an example, not to be used for diagnostic purposes"（metadata `intended_use`）。
- **アーキ探索ファイル**: `search_code_18590.pt` が無いと network が組めない（`arch_ckpt` が必須）。v0.0.7 の変更履歴は `torch.load(weights_only=True)` で読める tensor 形式にしたもの（metadata `changelog` 0.0.7）。
- **学習時の `RandZoomd`** の `align_corners` に空要素がある（`train.yaml`）。推論には無関係だが、学習の再現時に要注意（確認のみ。動作は未検証）。
- **model.ts** は HF に存在（TorchScript）。変換の README 手順あり。内容は未確認。

### 不明・未確認の一覧と理由

| 項目 | 理由 |
|---|---|
| 推論の GPU メモリ必要量 | README・metadata に記載なし。実測が要る |
| ラベル別・症例別の Dice | 平均値のみ公開。資料に無い |
| テスト 60 例での性能 | 記載なし |
| 0.88 と 88.6% の食い違いの理由 | 資料に説明なし（後付けしない） |
| 重みのライセンスを分けた記載 | LICENSE は「model」一括。HF にモデルカード無し |
| 学習データの権利・同意範囲 | 非公開データで記載なし |
| 動脈・門脈の範囲の定義、ラベル付けの方法 | 記載なし。参考文献 [2][3] は未読 |
| BTCV 等の公開データのサイズ・ライセンス・取得方法・ラベル体系との対応 | 未調査（Synapse は個別ページ未確認） |
| 公開データが学習に混入していないことの積極的根拠 | 資料に無い。「private」の記載のみ |
| model.ts の中身、HF とライセンスの矛盾の扱い | 未確認／法務判断 |
| 造影相以外での精度 | 検証していない |
