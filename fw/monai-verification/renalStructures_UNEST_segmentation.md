## renalStructures_UNEST_segmentation（調査日 2026-10-18）

基底 URL: B = https://raw.githubusercontent.com/Project-MONAI/model-zoo/dev/models/renalStructures_UNEST_segmentation/ （configs/metadata.json, configs/train.json, configs/inference.json, docs/README.md, LICENSE は curl で 200 を確認。configs/train.yaml と docs/data_license.txt は 404＝Bundle に存在しない）。
HF: https://huggingface.co/api/models/MONAI/renalStructures_UNEST_segmentation（200、sha f15df38d…、lastModified 2025-06-30、gated=false）。

### 1. 版・入出力・GPU

| 欄 | 値 | 出典 |
|---|---|---|
| Bundle 版 / MONAI 版 | 0.2.8 / MONAI 1.4.0、PyTorch 2.4.0、optional: einops 0.7.0, timm 0.6.7, nibabel 5.2.1 | B`configs/metadata.json` `version`, `monai_version`, `pytorch_version`, `optional_packages_version` |
| 入力 | CT 1ch、パッチ 96³、float32。前処理は RAS 向き → 1.0 mm 等方 → HU [-175, 250] を [0,1] にクリップ | metadata `network_data_format.inputs`、`train.json`/`inference.json` の `Orientationd(RAS)`, `Spacingd(pixdim 1,1,1)`, `ScaleIntensityRanged(a_min -175, a_max 250, b 0..1, clip)` |
| 出力 | 4ch。論文は HU [-175, 275] と記載（Bundle は 250）→ 食い違い（注意点参照） | metadata `outputs.pred.num_channels: 4`、論文 4.2 節 |
| ラベル番号と名前 | 0 background / 1 kidney cortex（metadata は "Kideny Cortex" と綴り誤り、README は Renal Cortex）/ 2 medulla / 3 pelvicalyceal system（README は Pelvicalyceal System、論文は pelvicalyceal system＝腎杯・腎盂）。「集合系」= 3 | metadata `channel_def` と `label_classes`、README「Output: 4: 0:Background, 1:Renal Cortex, 2:Medulla, 3:Pelvicalyceal System」 |
| 左右の区別 | **なし**（左右腎とも同じ 1/2/3）。論文: 左右の腎構造を手動で輪郭 | 上記ラベル表、論文 4.1 節「The left and right renal structures are outlined manually」 |
| ネットワーク | `scripts.networks.unest.UNesT`（in 1, out 4）。Bundle の scripts/ が必要（PYTHONPATH に追加） | `train.json` `network_def`、README「Add scripts component」 |
| GPU | 学習「at least one 16GB-memory GPU」。推論の必要量は記載なし＝**不明**（Colab T4 で実測要）。論文は RTX 2080 11GB で学習（batch 1） | README「Training configuration」、論文 4.2 節 |
| 重み | `models/model.pt` 348,887,167 B（HF `x-linked-size`） | HF resolve ヘッダ（HEAD） |
| 造影相の前提 | **造影 CT の動脈相または静脈相（門脈相）**。非造影・排泄相は対象外と読める（排泄相が対象外とは書かれていない＝未確認） | README 冒頭「contrast-enhanced CT images (Arterial/Portal Venous Phase)」、「Modality: CT (Artrial \| Venous phase)」 |

### 2. ライセンス

| 欄 | 値 | 出典 |
|---|---|---|
| Bundle のコード | Apache-2.0 | B`LICENSE`（全文取得、冒頭 "Apache License Version 2.0"）、README「License」 |
| 重み | 単独の記載なし。**不明**（HF の cardData は None、HF に README.md は無く raw/main/README.md が 404。`docs/data_license.txt` も無い） | HF API、curl 404 |
| 学習データ | **非公開**（ImageVU RenalSeg、Vanderbilt）。ライセンス不明。論文は IRB 下の臨床データ | README「The training data is not public available yet」 |
| 商用可否 | **不明**（コードは可。重みの条件と、学習データの利用条件が未開示）。法務判断へ | — |

### 3. 学習データ

| 欄 | 値 | 出典 |
|---|---|---|
| 名前・配布元 | ImageVU RenalSeg dataset（Vanderbilt University / VUMC）。非公開 | README「Data」 |
| 件数 | README: 96 volumes。論文: 116 例（うち 96 例を 5-fold CV、20 例をホールドアウトテスト）。**README の 96 は論文の 116 のうち 96 例（テスト 20 を除く）に相当すると読めるが、Bundle 側にその説明は無い（推測）** | README「Size: 96 3D volumes」、論文 4.1・4.2 節 |
| 造影相 | 動脈相／静脈相（README）。論文の本文では相の内訳は未確認 | README |

### 4. 既報の指標

| 欄 | 値 | 出典 |
|---|---|---|
| Bundle の平均 Dice | 0.8523（README、"validation data (our own split from the training dataset)"、元の spacing で計算）／ metadata は 0.85 | README「Performance」、metadata `eval_metrics.mean_dice` |
| 上記の算出データ | 学習データ内の検証 9 例。**独立性なし**（検証 Dice 最大のチェックポイントを保存＝選択に使用）。ラベル別の Dice は Bundle に無い（key_metric は include_background=false の平均のみ） | `train.json` `validate.key_metric.val_mean_dice`、`CheckpointSaver save_key_metric: true` |
| 論文のラベル別 Dice（テスト 20 例、5-fold アンサンブル） | Cortex 0.9201 / Medulla 0.8356 / Pelvicalyceal 0.7843 / 平均 0.8467。HD は 14.54 / 13.59 / 24.54 | 論文 Table 1（UNesT 行） |
| 論文の値と Bundle の関係 | Bundle の重みが論文の 5-fold アンサンブルと同一かは**不明**（1 個の model.pt、検証 9 例分割＝論文の 5-fold とは別の手順）。論文の値を Bundle の再現目標にしない | train.json の分割、論文 4.2 節 |
| 観察者間ばらつき | 論文: テスト 20 例は interpreter 2 が再度手動セグメンテーション（intra-rater）。数値は未取得（Fig./補足の読み取りが未了） | 論文 4.1 節 |

### 5. 検証の切り方（train.json）

- `images`/`labels` = `sorted(glob(dataset_dir + '/imagesTr/*.nii.gz'))` と `labelsTr`。
- 学習 = `@images[:-9]`、検証 = `@images[-9:]`（辞書順の末尾 9 例）。乱数での分割ではない。`set_determinism(seed=123)` は学習の再現用。
- 検証の推論: SlidingWindowInferer roi 96³、sw_batch_size 4、overlap 0.5。指標 MeanDice(include_background=false)、post は softmax→argmax→one-hot 4。
- 学習: 1000 epoch（train.json）、val_interval 5。**README の図は 5000 epoch と書く → 食い違い**。AdamW でなく Adam lr 2e-4、DiceCELoss。
- 出典: B`configs/train.json`（`train.dataset.data`、`validate.dataset.data`、`training`）。

### 6. 独立に使える公開データ

| 欄 | 値 | 出典 |
|---|---|---|
| 皮質・髄質・集合系のラベルを持つ公開データ | **見つからず＝不明**。WebSearch 1 回のみで網羅探索ではない（「無い」と断定しない）。KiTS19 は公開だが腎全体＋腫瘍のみで 3 ラベルは無い（部分的な代用にもならない：皮質と髄質を分けられない） | WebSearch（2026-10-18）、論文 4.1 節 |
| 参考の手がかり（未確認） | arXiv 2305.13616（部分腎摘術向けの腎解剖抽出。データ公開は未確認）。URL は検索結果のみで、curl での 200 確認と中身の読み取りは未実施 | WebSearch 結果 |
| 学習に使われていない根拠 | 該当データが未特定のため記述できない | — |

### 7. 再現検証の可否

- **未達（前提待ち）＋参考値**。検証 9 例は `sorted(imagesTr)[-9:]` で規則上は特定できるが、データ（ImageVU RenalSeg）が非公開で、症例名・ファイル名も Bundle に無い → 症例を挙げられず、手元で再現できない。
- 参考値: Bundle 0.8523（学習データ内・独立性なし）、論文 0.8467（別手順・テスト 20 例）。
- 代替案: 造影相（動脈／門脈）の公開 CT でラベルなしの実行は可能（出力の目視とラベル 1/2/3 の体積の妥当性のみ）。皮質＋髄質＋集合系の結合を腎全体とみなして KiTS19 等の腎ラベルと比べる案は、全体の形の確認にとどまる（皮質／髄質／集合系の Dice は測れない）。採るか要判断。

### 8. 閾値（この調査では数値を出さない）

参照実行に必要なもの:
- コマンド: `python -m monai.bundle run evaluating --meta_file configs/metadata.json --config_file configs/inference.json --logging_file configs/logging.conf`（README）。PYTHONPATH に `<bundle>/scripts` を追加。重みを `models/model.pt` に置く。
- 入力の前処理: RAS → 1 mm 等方 → HU [-175, 250] クリップ → [0,1]。`Invertd` で元の空間に戻して `SaveImaged`。
- 必要 GPU メモリ: 推論は**不明**（要実測）。CPU 実行は可能な書きぶり（`cuda` が無ければ cpu）だが速度は未確認。
- 必要データ: 検証 9 例の画像とラベル。**非公開で入手不可** → 閾値の方法（同じ検証症例の参照実行）は適用できない。症例を特定できない。
- 閾値の数値は出さない。方法が成立しないため「未達」。

### 9. 注意点

1. `inference.json` の `dataset_dir` が `./dataset/spleen`（spleen Bundle からのコピーの名残）で、`datalist` は `glob(dataset_dir/*.nii.gz)`。そのまま実行すると意図しないパスを見る。上書きが要る。さらに `dataset_dir` は `@bundle_root + './dataset'`（train.json も同様）で、`/models/.../` + `./dataset` のように `/` 抜けで連結される書き方。実行前にパスを確かめる。
2. `inference.json` の `bundle_root` は `/models/renalStructures_UNEST_segmentation` 固定。上書きが要る。
3. ラベル番号は 1=皮質、2=髄質、3=腎杯・腎盂（集合系）。metadata の綴りは "Kideny"。表示名をそのまま使うと誤綴りが出る。左右の区別は無い。
4. 皮質ラベルは腎柱（renal columns）を含む。髄質は皮質に囲まれる。集合系は腎杯と腎盂（尿管へ続く部分）（論文 4.1 節）。
5. 造影相の前提（動脈相／門脈相）。非造影 CT や排泄相では性能は保証されない（未検証）。
6. 前処理の HU 窓: Bundle は [-175, 250]、論文は [-175, 275]。重みの学習時の設定は Bundle の train.json に従う（重みと Bundle の対応は未確認）。
7. 学習 epoch: train.json 1000、README の図は 5000 epoch と記載。どちらが重みに対応するか不明。
8. README の免責: "not to be used for diagnostic purposes"。
9. 推論は `Invertd` を使うので元の空間（向き・spacing）に戻る。GRAPHY-Next 側の向き（LPS）との変換を、RAS の前提と合わせて確認する。
10. Dice は元の spacing で計算（README）。1 mm 等方で計算すると値が変わりうる。
11. 重みのファイルは 348.9 MB（HF は Xet 経由の 302 リダイレクト）。

### 不明・未確認の一覧と理由

| 項目 | 状態 | 理由 |
|---|---|---|
| 重みのライセンス | 不明 | HF カード（cardData None）、Bundle に記載なし。data_license.txt も無い |
| 学習データのライセンス・入手 | 不明・非公開 | README「not public available yet」 |
| 商用可否 | 不明 | 上記 2 点 |
| 推論時の GPU メモリ | 不明 | README は学習 16 GB のみ記載。実測が要る |
| ラベル別の Bundle 内 Dice | 不明 | Bundle は平均のみ（0.8523） |
| 検証 9 例の症例名 | 不明 | データ非公開、datalist も Bundle に無い |
| 重みと論文の 5-fold アンサンブルの関係 | 不明 | Bundle に説明なし |
| README の 96 と論文の 116 の関係 | 推測のみ（上記）| Bundle に説明なし |
| 1000 epoch と 5000 epoch のどちらか | 不明 | train.json と README の食い違い |
| HU 窓 250 と 275 | 不明 | train.json と論文の食い違い |
| 皮質・髄質・集合系ラベルを持つ公開データ | 見つからず（網羅探索ではない） | WebSearch 1 回のみ |
| arXiv 2305.13616 の中身 | 未確認 | 検索結果で見ただけ。読んでいない |
| 観察者間ばらつきの数値 | 未取得 | 論文の該当箇所を読んでいない |
| 排泄相・非造影での挙動 | 未検証 | 記載なし |
