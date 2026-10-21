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
| ラベル番号・点 | vista3d / spleen_deepedit_annotation | 3 節 | 動作は確認。点 ROI の読み込みは未確認 |

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

## 3. ラベル番号・点（段 3、スパイク）

データ: MSD Task09 の脾臓 1 例（spleen_56）。点は基準ラベルから選んだ（`automator/tools/monai_point_pick.py`: 陽性 = 脾臓の重心に最も近い脾臓内、陰性 = 脾臓から 40 mm 以上離れた体内）。**MSD は vista3d・DeepEdit の学習データに含まれるので独立ではない**。1 例なので分布は言えない。Dice は「不明」（閾値なし、動作確認が目的）。

| モデル | 入力 | 結果（T4） |
|---|---|---|
| vista3d | ラベル 3（脾臓）のみ | 完走 129 秒、前景 1、脾臓 Dice 0.9406 |
| vista3d | ラベル 3 + 陽性 1・陰性 1 | 完走 223 秒、前景 2（255 = 点の窓の外）、脾臓 Dice 0.9373 |
| vista3d | ラベルも点も無し（全自動 117 クラス） | 完走 147 秒、前景 66、脾臓 Dice 0.9406（ラベルのみと同じ） |
| DeepEdit | 点なし | 完走 172〜177 秒、Dice 0.8843（2 回とも同じ値＝決定的） |
| DeepEdit | 陽性 1・陰性 1 | 完走 177 秒、Dice 0.8801 |
| DeepEdit | 陽性と陰性を入れ替え（対照） | 完走 228 秒、Dice 0.8810 |

- DeepEdit の点は結果をわずかに変える（点なしの再実行が同値なので、差は点によるもの）が、この 1 例では**改善は見えない**（点なし 0.8843 が最大）。クリックで改善するか、は未確認。
- vista3d の点: Bundle のコードの 1 行（`scripts/evaluator.py` の `torch.from_numpy(points)`）が、Colab の MONAI で `TypeError: expected np.ndarray (got Tensor)` になる。型だけを揃える手当て（`torch.as_tensor(np.asarray(points))`）を計算機の上で当てた。当てた箇所は結果の `bundleCodePatched` に残る。
- vista3d は点を使うと、点の窓の外を 255 で返す（Bundle の仕様）。プラグインは 255 を背景にし、その数を画面に出す（255 を臓器として SEG に保存しないため）。
- ラベル指定・点を渡すには、Bundle の `scripts/` を import できるようにする必要があった（実行前に `sys.path` へ Bundle の置き場を足す）。
- 「点 ROI から読み込む」ボタン（ROI の画素座標 → 患者座標）は、下の 3.1 で実機確認した。

### 3.1 点 ROI の読み込み（Colab 不使用）

`automator/src/spike/computeMonaiRoiButton.ts`。MSD 脾臓 spleen_56 を取り込み、点 ROI を 3 スライス × 4 点置いてボタンを押し、出た座標の位置の画素値を NIfTI から独立に読んで（`automator/tools/monai_roi_probe.py`）、ビューアが同じ点で示す値と突き合わせる。

| 版 | 画面の値と一致 | 負例: z 反転 | 負例: x と y の入れ替え |
|---|---|---|---|
| 0.4.0（修正前） | 3/12 | 1/12 | 0/12 |
| 0.4.1（修正後） | 12/12 | 4/12 | 0/12 |

- 原因: `getRois` の画素座標は「画素の左上隅が 0」（`roiRead.ts`）。`indexToWorld` は画素中心が整数なので、0.5 を引いていなかった。面内で最大 0.5 画素（この画像で約 0.35 mm）ずれ、最近傍の画素が 1 つ隣になった。スライス方向は修正前から正しい。
- 点は 1 つの画像・1 つのシリーズでの確認。陽性・陰性の割り当て（ROI のラベル）は未確認。

## 4. 見つけた不具合

| 不具合 | 原因 | 対処 |
|---|---|---|
| SEG 保存で日本語のセグメント名・Latin-1 参照元の患者名が `?` になる | `SegExportService` が `SpecificCharacterSet` を書かない | `ISO_IR 192` を書くよう修正（試験: 日本語ラベル、Latin-1 参照元の患者名。修正前は 2 件とも失敗を確認） |
| チャネルの自動選択で "T1" が "T1c" に当たる | 部分一致 | 語の境界で照合（プラグイン 0.3.0、負例つきの試験） |
| あとから足したタイルがプラグインから見えない | `makeViewerHost` が開いた時点の `actions` を持つ | 本体は未変更。プラグインの画面に「開く前にタイルを開く」と明記 |

## 5. 範囲外（記録のみ・実機は回さない）

検出（lung_nodule_ct_detection）、ランドマーク（valve_landmarks）、分類（breast_density_classification・endoscopic_inbody_classification）、RGB（endoscopic_tool_segmentation・vista2d）、病理 4 本、画像生成 7 本、位置合わせ（mednist_reg）、顕微鏡・眼科（retinalOCT_RPD_segmentation）、雛形 2 本。
理由: このプラグインは「ラベル画像を ROI にする」ため出力形式が合わない、または対象外のモダリティ・用途。詳細はロードマップ §3。個別に対応するかはユーザーが決める。
