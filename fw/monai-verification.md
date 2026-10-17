# MONAI Bundle の 1 本ずつの検証（検証表の枠）

> **研究用です。診断に使えるという意味の「合格」ではありません。** 医療機器としての性能評価とも別物です。
> ここで確かめるのは「GRAPHY-Next の経路（取り込み → 外部の計算機 → SEG 保存）が、Bundle の報告した性能を損なっていないか」と
> 「結果が解剖・向き・ラベル名と合っているか」です。

状態: 採点スクリプトと、12 本の一次資料調査（2026-10-18）まで。実 Colab での実行・採点・画面撮影は未実施（§5 の各欄は「未実施」）。
関連: `fw/remote-compute-design.md` §16〜§18（Bundle を Colab で動かす経路。完走の確認はここ）、公式プラグイン `graphy-next-plugin-monai`。

## 1. 検証の 5 項目（Bundle ごと）

| # | 項目 | 方法 |
|---|---|---|
| a | 解剖が合う | **既報との突き合わせ（再現検証）**。Bundle の論文・README が報告した指標を、報告と同じ公開データ・同じ検証用の分割で、この経路を通して再現して比べる。目視（重ね表示）を併用 |
| b | ラベルの名前と番号が一致 | 結果の SEG のセグメント名と番号を、基準データのラベル表と突き合わせる（左右を含む） |
| c | 向き・位置が合う | 患者座標 LPS・mm で基準と重ねる。NIfTI を通らない **DICOM のシリーズ**で、左右・上下を解剖で確かめる（NIfTI 取り込みの向きの誤りは、画像と基準が同じ誤りになるので Dice に出ない） |
| d | 体積が妥当 | mL を算出し、文献の範囲と比べる。出典の無い範囲は置かない（「不明」） |
| e | 対象外の入力で止まる／警告 | 別モダリティ・別部位・チャネル数の違いを入れる。「止まるはずが走る」は失敗 |

### 画面キャプチャ（ユーザーマニュアル用）
- Bundle ごとに最低 3 枚: ①実行前（入力シリーズ・Bundle 選択・同意画面）②結果（ROI マネージャのラベル一覧と、重ね表示の断面）③SEG 保存後。負例（e）が止まる／警告する画面も 1 枚。
- Playwright の `screenshot`、Electron は `webContents.capturePage()` で撮る（OS のスクリーンショットは使わない）。出力先は `automator/.results/compute-monai-verify/<bundle>/`（git に入れない）。
- 写すのは公開データか本体の同梱サンプルだけ。患者データは写さない。CC-BY-SA などは、マニュアルに帰属表示（データ名・配布元・ライセンス）が要る。
- 撮影後に画像を開いて目視で確認（空画面・ウィンドウ外れ・個人情報の写り込み）。撮れていない・確認していないものは「未撮影」と書く。

## 2. 数え方
- **合格／失敗／未達（前提待ち）** の 3 つに分けて数える。未達を合格に書き換えない。
- 閾値が決められないものは **不明**（`verdict(value, lower=None)`）。最大化した値や仮置きの値を閾値にしない。閾値は、モデル作者の報告値と基準ラベルの観察者間ばらつきから導き、導出の根拠を表に書く。
- 取れなかった値は 0 で埋めず、空欄と理由を書く。

## 3. a の規則
1. 報告された指標（臓器ごとの Dice など）、算出に使ったデータと分割、出典（論文・README の該当箇所）を表に写す。読み取れない値は「不明」。
2. 報告が**学習に使っていない分割**で出したものなら、同じ症例を取得して採点し、報告の範囲に入るかを見る。
3. 検証用の症例を特定できない報告（交差検証など）は再現できない。a は「未達」＋参考値とする。
4. 学習データで出した Dice は必ず「独立性なし」と書き、合格に数えない。
- 報告値が高いこと自体を、臨床で使える根拠にしない。

## 4. 採点スクリプト `automator/tools/monai_score.py`
本体が書く DICOM SEG（BINARY）を読み、NIfTI の基準ラベルと LPS・mm で突き合わせる（最近傍）。Dice・体積・ラベル名↔番号の対応を出す。

    ~/monai-verify-data/.venv/bin/python -I automator/tools/monai_score.py \
      --seg result.dcm --reference ref.nii.gz --label-map map.json --out score.json

- 環境: `automator/tools/requirements.txt`（リポジトリの外の専用 venv）。検証用のデータの置き場は `~/monai-verify-data/`（git に入れない）。
- 自己検査: `~/monai-verify-data/.venv/bin/python -I automator/tools/test_monai_score.py`。
  - 正例: 本体の実際の SEG 書き出しで作った固定データ（`automator/tools/testdata/`）が、独立に計算した正解の座標・体積と一致する。軸の順と向きの違う基準でも満点。
  - 負例: 20 mm のずれ（x・y・z）、LPS 各軸の反転、ラベル名の入れ替え、スライス欠け、基準の向きの誤り宣言で必ず落ちる。負例は、改変が実際に効いていることを先に確かめてから見る。
  - 採点器をわざと壊した 7 通り（IOP を無視、RAS↔LPS の取り違え、ビット順、行の反転、Dice の式、最近傍の丸め、判定）で、テストが落ちることを 2026-10-18 に確かめた。
- 既存の CI は automator の Python テストを走らせない。CI が緑でもこの自己検査は走っていないので、手で実行する。

## 5. 検証表（Bundle ごとの行）
調査日 2026-10-18。各 Bundle の詳細（値・出典・不明の一覧）は `fw/monai-verification/<bundle>.md`。
要点（版・報告値・検証の切り方・ラベル表・ライセンスの主な点）は、Bundle の `metadata.json`・README・学習設定と照合した。それ以外の値は各ファイルの出典欄に拠る。出典が取れなかった値は「不明」。

**閾値**: 同じ検証症例を MONAI 公式の手順（GRAPHY-Next を通さない）で 1 回参照実行し、症例別 Dice の「平均 − 2×標準偏差」を下限にする。検証症例を特定できない Bundle は、この手順が成立しない（下限は「不明」のまま。a は「未達＋参考値」）。参照実行は未実施。

| Bundle（版） | 報告値（出典・独立性） | 検証症例の特定 | a の見込み | 独立データ（取得状況） | 商用可否 |
|---|---|---|---|---|---|
| spleen_ct_segmentation (0.6.1) | 平均 Dice 0.961（検証 9 例。独立性は限定的: 学習中の検証に使用） | 可: `sorted(imagesTr)[-9:]` = spleen_56, 59, 6, 60, 61, 62, 63, 8, 9 | 再現検証できる | MSD Task09（CC-BY-SA 4.0、1.6 GB、登録不要）**取得済** | 不明（重みのライセンス記載なし） |
| wholeBody_ct_segmentation (0.2.8) | mean_dice 0.8 のみ（算出データ・分割の記載なし） | 不可（配布重みの学習・検証症例の記載なし） | 未達＋参考値 | TotalSegmentator v1（Zenodo、CC-BY-4.0、28.4 GB、登録不要）未取得。学習データと同じ可能性があり独立と言えない | 不明 |
| swin_unetr_btcv_segmentation (0.5.9) | 平均 Dice 0.82（ラベル別なし。症例は不明） | 条件付き: 検証 `[-9:]`。README（24+6）と設定（21+9）が食い違い、確実に独立と言えるのは 6 例 | 条件付きで再現検証 | BTCV（Synapse のアカウントとチーム参加が要る）未取得。代替の AMOS22 は門脈・脾静脈なし | 不明 |
| multi_organ_segmentation | 検証 60 例の平均 Dice 0.88（README は 88.6%）。独立性なし | 症例 ID は特定できるが画像は非公開 | 未達＋参考値 | 該当なし（公開データなし） | **不可と読める**（私的利用・非商用・再配布禁止。同梱・配布不可） |
| pancreas_ct_dints_segmentation (0.5.4) | 平均 Dice 0.62（データ・分割の記載なし） | 条件付き: seed 固定でない `train_test_split` の 2 段。MONAI 1.4.0・sklearn 1.5.1 で分割が一致するか実機確認が要る | 条件付き（分割の一致確認が前提） | MSD Task07（CC-BY-SA 4.0、12.3 GB、登録不要）未取得 | 不明 |
| renalStructures_UNEST_segmentation (0.2.8) | 検証 9 例の平均 Dice 0.85。独立性なし | 不可（学習データが非公開） | 未達＋参考値 | 皮質・髄質・集合系のラベルを持つ公開データは未確認（網羅探索ではない） | 不明 |
| prostate_mri_anatomy | テスト 19 例: TZ 0.877 / PZ 0.754（Rater1）、TZ 0.875 / PZ 0.730（Rater2） | 可: Prostate158 のテスト 19 例（学習・検証と重ならない） | 再現検証できる | Prostate158 テスト（Zenodo、約 203 MB、登録不要）未取得。データのライセンスは不明。README が中心切り出しの前処理を要求 | 不明 |
| wholeBrainSeg_Large_UNEST_segmentation (0.2.8) | mean_dice 0.71（算出データ・分割の記載なし） | 不可（OASIS・CANDI は学習・テストに使用済み） | 未達＋参考値 | Mindboggle-101 は候補だがライセンス表記が食い違う（CC BY 4.0 と CC BY-NC-SA 3.0）。MNI305 への登録が必須 | 不明（OASIS の DUA は非商用・学術のみ） |
| pediatric_abdominal_ct_segmentation (0.4.7) | TS 0.9 / TCIA 小児 0.87 / 院内 0.89（臓器別なし） | 一部: TotalSegmentator の試験 50 例は ID を特定できる。他は不明・非公開 | 条件付き（成人データでの経路検証。小児の性能は言えない） | TotalSegmentator（28.4 GB の zip 全体。事前学習 815 例との非重複の裏付けは未取得） | 不明 |
| vista3d (0.5.13) | 論文のテスト分割（各データの 20%）: MSD 脾臓 0.952、14 データセット平均 0.711。公開重みと同一かは不明 | 可（リポジトリの fold 定義）: MSD 脾臓のテストは spleen_44, 21, 61, 29, 38, 46, 53, 33 | 条件付き | MSD などは学習に使われた可能性が高く独立の裏付けが弱い | 不明（同一重みに「非商用」と「Open Model License」の食い違う 2 表示。安全側は非商用扱い） |
| ventricular_short_axis_3label (0.3.5) | Dice の記載なし | 不可（seed なしのランダム分割） | 未達（参考値もなし） | ACDC・Sunnybrook・M&Ms は候補だが学習に未使用の保証なし | 不明（README は MIT だが metadata は研究用のみ） |
| endoscopic_tool_segmentation (0.6.2) | mean IoU 0.86（Dice ではない）。独立性なし | 不可（非公開データ） | 未達＋参考値 | EndoVis 2017 は候補（登録・規約は未確認） | 不明（ImageNet 事前学習重みを使う構成は非商用） |

### 共通の注意（調査で見つかった落とし穴）
- 学習設定の `[-N:]` は `sorted(glob(...))` の辞書順。数値順ではない（例: spleen_6 は spleen_60 の前）。
- ラベル名の綴り誤り（"Left Kideny"）、metadata の `value_range` や `channel_def` が実処理と食い違う Bundle がある。b の検査はラベル表を一次資料と突き合わせる。
- pediatric_abdominal_ct は `channel_def` が空。ラベル名は README 側の根拠による。
- renalStructures_UNEST の `inference.json` は `dataset_dir` が別 Bundle の名残、`bundle_root` が固定値。実行時に上書きが要る。
- wholeBodyの GPU は推論で約 29 GB（1.5 mm）。Colab T4 では足りない恐れがあるが実測していない。

### 実施状況（すべて未実施）
a〜e の合否、参照実行、画面キャプチャは、実 Colab での実行を伴うため未実施。合格とは書かない。
