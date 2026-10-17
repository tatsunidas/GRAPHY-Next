## spleen_ct_segmentation（パイロット。調査日 2026-10-18）

| 欄 | 値 | 出典 |
|---|---|---|
| Bundle 版 / MONAI 版 | 0.6.1 / 1.4.0（PyTorch 2.4.0） | model-zoo dev `models/spleen_ct_segmentation/configs/metadata.json` |
| 入出力 | 入力 CT 1ch、出力 2ch（0 背景・1 脾臓）、パッチ 96³ | 同上 `network_data_format` |
| GPU | 学習 12 GB 以上（推論の必要量は README に記載なし＝不明。段 0c で Colab T4 で実測） | `docs/README.md` |
| ライセンス: Bundle のコード | Apache-2.0 | Bundle 同梱 `LICENSE`（全文取得、HF の同名リポジトリにも同じファイルあり） |
| ライセンス: 重み | 重み単独の記載なし（`models/model.pt` は HF `MONAI/spleen_ct_segmentation` で配布、カードのライセンス欄は空）。**不明** | HF API（2026-10-18） |
| ライセンス: 学習データ | CC-BY-SA 4.0（MSD） | `dataset.json` の `licence`、AWS Open Data 登録ページ。Bundle の `docs/data_license.txt` は MSD の URL のみ |
| 商用可否 | **不明**（コードは可。学習データが CC-BY-SA 4.0 で、重みへの波及の有無は法務判断が要る → モデルレジストリの法務確認 へ） | — |
| 学習データ | MSD Task09_Spleen（MSKCC）。ラベル付き 41 症例 + ラベルなし 20 症例。うち 32 例で学習、9 例で検証 | README「Data」「with 32 training images and 9 validation images」 |
| 既報の指標 | 平均 Dice 0.961（臓器 1 つ） | `metadata.json` `eval_metrics.mean_dice`、README「Performance」 |
| 既報の分割 | 検証 9 例 = `sorted(glob(imagesTr/*.nii.gz))` の**末尾 9 例**。辞書順なので `spleen_56, 59, 6, 60, 61, 62, 63, 8, 9`（実物の取得データで確認） | `configs/train.json`（`@images[-9:]`、`images` は `sorted(glob(...))`）、実物 |
| 独立性 | **限定的**。9 例は学習に使っていないが、学習中の検証（チェックポイント選択の指標）に使われた。テスト 20 例のラベルは非公開。 | `train.json` の validate 設定。選択基準の詳細は未確認 → 「不明」 |
| 再現の可否 | **可**（症例を特定できる）。a は「同じ 9 例を本経路で通して 0.961 と比べる」 |  |
| 観察者間ばらつき | 未取得（脾臓の文献値を探していない） | — |
| 閾値 | **不明**。既報の値 0.961 は検証 9 例の平均で、標準偏差・症例別の値は README に無い。 閾値の案は下記 | — |
| 公開データ | MSD Task09_Spleen、1,610,352,640 B、登録不要（AWS S3）、`~/monai-verify-data/msd/Task09_Spleen.tar`、sha256 `dfeba347…fa65e60`。展開後 41 画像・41 ラベル、ラベル値 {0,1}、向き RAS（末尾 9 例で確認） | 取得済み |

### 閾値の案（ユーザー確認用）
症例別の Dice の分布が既報に無いので、既報から直接は導けない。次のどれかを選ぶ:
1. **同じ 9 例の参照実行（MONAI 公式の手順、GRAPHY-Next を通さない）の症例別 Dice** から、下限 = 平均 − 2×標準偏差 を導く。「経路が性能を損なっていない」を直接見る検証に合う。要・Colab/GPU での参照実行（段 0c の前に 1 回）。
2. 既報 0.961 − 観察者間ばらつき（文献値）。文献値を探す作業が先。
3. 閾値を置かず「不明」のまま、値と目視だけ報告する。
推奨は 1。理由: 閾値が、モデル・データ・前処理を固定した「実測の揺れ」から出る（最大化ではなく、統計的意味から導く）。
