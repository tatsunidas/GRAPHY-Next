# MONAI Bundle の実機検証表（AV-MON-001）

更新: 2026-10-21。実機 = Google Colab の T4。結果は「合格／失敗／未達（前提待ち）／不明」で数える。
閾値が無いものの Dice は「不明」と書き、合格にしない。結果は研究用で、診断に使えるという意味の合格は出さない。

方法・ロードマップは `graphy-next-roadmap` の `research/monai-verification-2026-10-17.md`。
ハーネスは `automator/src/spike/computeMonaiVerify.ts`（採点は `automator/tools/monai_score.py`）。
データは git に入れず `~/monai-verify-data/` に置く。

## 1. 画面から渡す入力（段 1〜2）

| 入力 | Bundle | 実機の確認 | 状態 |
|---|---|---|---|
| 設定値 | wholeBody_ct_segmentation（highres） | `highres=false` で Bundle 側の `pixdim` が [3,3,3]、`modelname` が `model_lowres.pt` に解決された（153 秒、T4）。既定（true）は 141 秒で完走 | 動作は確認。結果の正しさは未評価 |
| 複数チャネル | brats_mri_segmentation（4 本） | 3 症例で完走（91〜127 秒）。下の 2 節 | 動作と Dice を確認 |
| 複数チャネル | renalStructures_CECT_segmentation（3 本） | 未実施 | **未達**（公開データは検証 9 例のみの見込み、配布は Yandex.Disk、非商用 CC BY-NC-SA 4.0、位置合わせ済みの切り出しが前提。完走確認は ct-basic ×3 の予定） |
| 点・ラベル指定 | vista3d / spleen_deepedit_annotation | 未実施 | **未達**（段 3 のスパイク待ち） |

wholeBody の出力格子は、`highres` の true／false どちらも入力の格子 [0.6445, 0.6445, 5] に戻る（Bundle が入力の格子へ戻すため）。効きは格子ではなく `pixdim`／`modelname` の解決結果で見る。
`highres=false` では前景ラベルが 66 から 2 に減った。手元の CT は 43 枚・5 mm 厚。理由は不明（確かめていない）。

## 2. brats_mri_segmentation（段 2）

- データ: MSD Task01_BrainTumour（`dataset.json` の licence は CC-BY-SA 4.0）。sha256 `d423911308d2ae5396d9c6bf4fad2b68cfde2dd09044269da9c0d639c22753c4`（7,608,266,240 B）。
- 並べ替え: MSD のチャネルは FLAIR, T1w, t1gd, T2w。Bundle（metadata の `channel_def`）は T1c, T1, T2, FLAIR。基準ラベルは MSD の 1=浮腫・2=非造影・3=造影を、Bundle の出力値 2・1・4 へ振り直す（`automator/tools/monai_brats_prep.py`）。
- 領域: WT = 1+2+4、TC = 1+4、ET = 4（Bundle の出力値）。

| 症例 | WT | TC | ET |
|---|---|---|---|
| BRATS_001 | 0.8897 | 0.9600 | 0.8837 |
| BRATS_002 | 0.9202 | 0.8497 | 0.8729 |
| BRATS_003 | 0.9154 | 0.9311 | 0.9219 |
| 平均（3 例） | 0.9084 | 0.9136 | 0.8928 |
| 報告値（Bundle の README、平均 0.8518） | 0.9026 | 0.8559 | 0.7905 |

- **独立ではない**: 報告値の学習データ（BraTS 2018）は MSD Task01 と重なる。a（解剖が合う）は「独立性なし」とし、合格に数えない。3 例では分布も言えない。
- **負例（順序の取り違え）**: チャネル 0 と 1（T1c と T1）を入れ替えると、BRATS_001 で ET 0.884→0.215、TC 0.960→0.830、WT 0.890→0.841。採点は順序の取り違えを ET・TC で見分けられる。**WT だけでは見分けにくい**。
- 判定: 完走・ラベル名と番号の対応（b）・SEG 保存は確認。a は独立性なし、c（向き）・d（体積）・e は未実施。

## 3. 見つけた不具合

| 不具合 | 原因 | 対処 |
|---|---|---|
| SEG 保存で日本語のセグメント名・Latin-1 参照元の患者名が `?` になる | `SegExportService` が `SpecificCharacterSet` を書かない | `ISO_IR 192` を書くよう修正（試験: 日本語ラベル、Latin-1 参照元の患者名。修正前は 2 件とも失敗を確認） |
| チャネルの自動選択で "T1" が "T1c" に当たる | 部分一致 | 語の境界で照合（プラグイン 0.3.0、負例つきの試験） |
| あとから足したタイルがプラグインから見えない | `makeViewerHost` が開いた時点の `actions` を持つ | 本体は未変更。プラグインの画面に「開く前にタイルを開く」と明記 |

## 4. 範囲外（記録のみ・実機は回さない）

検出（lung_nodule_ct_detection）、ランドマーク（valve_landmarks）、分類（breast_density_classification・endoscopic_inbody_classification）、RGB（endoscopic_tool_segmentation・vista2d）、病理 4 本、画像生成 7 本、位置合わせ（mednist_reg）、顕微鏡・眼科（retinalOCT_RPD_segmentation）、雛形 2 本。
理由: このプラグインは「ラベル画像を ROI にする」ため出力形式が合わない、または対象外のモダリティ・用途。詳細はロードマップ §3。個別に対応するかはユーザーが決める。
