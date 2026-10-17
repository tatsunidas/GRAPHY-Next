## endoscopic_tool_segmentation（調査日 2026-10-18）

結論: **再現検証は「未達＋参考値」**。学習・検証データは Activ Surgical の非公開データで、症例を特定できない。報告指標は Dice でなく **IoU 0.86**（分割の説明なし）。独立に使える公開データ候補は EndoVis 2017（2 値の術具ラベルあり）だが、入手の可否・ライセンスは未確認。

略称: B=https://raw.githubusercontent.com/Project-MONAI/model-zoo/dev/models/endoscopic_tool_segmentation （以下の B/… はすべて curl で 200 を確認）

### 1. 版・入出力・GPU

| 欄 | 値 | 出典 |
|---|---|---|
| Bundle 版 / MONAI 版 | 0.6.2 / 1.4.0（PyTorch 2.4.0, numpy 1.24.4, nibabel 5.2.1, pillow 10.4.0） | B/configs/metadata.json `version`, `monai_version`, `pytorch_version`, `required_packages_version` |
| 設定ファイル | configs/train.json あり。ほか inference.json / evaluate.json / inference_trt.json / multi_gpu_*.json / logging.conf | GitHub contents API（configs/ 一覧） |
| タスク | 2 値セグメンテーション（術具 vs 背景）。**多クラス（器具種別・部位）ではない** | metadata.json `task`: "Binary Segmentation of Surgical Tools in Endoscopic Images" |
| ネットワーク | FlexibleUNet、backbone efficientnet-b2、2D、in 3 / out 2、dropout 0.6、is_pad false | train.json `network_def` |
| 入力（形式） | RGB 3ch、2D 画像（動画フレーム）。実装は JPEG 読み込み（`*.jpg`）。メタデータ上 dtype float32、値域 [0,1] | metadata.json `network_data_format.inputs.image`（format RGB, num_channels 3, value_range [0,1]）、`image_classes`: "three channel data, intensity [0-255]"、train.json `images` の glob |
| チャネル順 | 0=R, 1=G, 2=B | metadata.json `channel_def` |
| サイズ | 空間形状 [736, 480]（MONAI の Resized の spatial_size 順 = 画像の 1 軸目 736、2 軸目 480）。README は「736x480 pixel RGB」。任意サイズの入力は Resized(bilinear) で 736x480 にリサイズされ、推論後は Invertd で元サイズに戻す | metadata.json `spatial_shape`、train.json / inference.json `Resized`、inference.json `Invertd` |
| 前処理 | LoadImaged（image_only=false）→ EnsureChannelFirstd(channel_dim=-1) → Resized(736,480; bilinear) → ScaleIntensityd（既定 0–1 の min-max。**画像ごとの最小・最大で正規化**であり、固定の /255 ではない）。標準化・チャネル平均の減算は無し | inference.json `preprocessing`。ScaleIntensityd の既定動作は MONAI の実装知識であり、この調査では実物で未確認 |
| 出力 | 2ch（softmax 後に argmax → one-hot）。ch0=背景、ch1=術具 | metadata.json `pred_classes`、`outputs.pred.channel_def` {0: background, 1: tools} |
| ラベル | 0=背景、**1（または JPEG ラベルでは 255）=術具**。これ以外のラベル（器具種別・部位）は無い | metadata.json `label_classes`: "single channel data, 1/255 is tool, 0 is background" |
| 保存形式 | inference.json は `pred[1:]`（術具チャネルのみ）を ×255 の PNG（float32 指定）で保存 | inference.json `Lambdad`、`SaveImaged`（scale 255, output_ext .png） |
| GPU | 学習は 12 GB 以上。推論時の必要量は記載なし＝**不明**（A100 80G での速度表のみ。モデル計算 12.00 ms、end2end 170 ms） | docs/README.md「Training configuration」「TensorRT speedup」 |
| 配布 | 重み model.pt（46,290,573 B）。HF `MONAI/endoscopic_tool_segmentation` の `models/model.pt` で 200・同サイズ、NVIDIA の `large_files.yml` URL でも 200・同サイズ。md5 7ca94167f05ac9f62a16b1898155ff71（large_files.yml）。TorchScript の model.ts もあり。README が書く Google Drive 版は未確認 | B/large_files.yml、HF `resolve/main/models/model.pt`（HEAD で Content-Length 確認）、HF API siblings |

### 2. ライセンス

| 欄 | 値 | 出典 |
|---|---|---|
| Bundle のコード | Apache-2.0 | B/LICENSE（全文取得、冒頭 "Apache License Version 2.0"）。README 末尾にも "Licensed under the Apache License, Version 2.0" |
| 重み | 重み単独のライセンス記載なし。HF モデルカードは README.md が "Entry not found"（カード本文・ライセンス欄なし）。**不明** | HF `raw/main/README.md`、HF API（tags に license なし） |
| 学習データ | Activ Surgical 提供の非公開データ。`docs/data_license.txt` は "Datasets used in this work were provided by Activ Surgical." の 1 行のみで、利用条件の記載なし。**不明** | B/docs/data_license.txt |
| 事前学習 | 既定は `use_imagenet_pretrain: false`。true にすると EfficientNet-PyTorch の ImageNet 重みを読み込み、README は「these weights are for non-commercial use」と明記。公開の重み model.pt がどの事前学習を経たかは、README に「encoder is trained with pre-trained weights from some internal data」とあるのみで詳細は**不明** | train.json `use_imagenet_pretrain`、README「Pre-trained weights」 |
| 商用可否 | **不明**。コードは可。重みのライセンスと学習データの利用条件が未記載。事前学習に ImageNet 由来が混ざったかも不明。ImageNet 重みを使う構成は非商用 | 上記 |

### 3. 学習データ

| 欄 | 値 | 出典 |
|---|---|---|
| 名前・配布元 | Activ Surgical の非公開サンプル（metadata.json `data_source`: "private dataset"）。**公開されていない** | metadata.json、README「Data」 |
| 件数 | **不明**（README・metadata に件数なし） | README 全文 |
| 形式 | train / val / test 各フォルダ配下の `<症例>/<名前>.jpg` と `<名前>_seg.jpg`（ラベル）。JPEG のラベルは 0/255 → ScaleIntensityd で 0/1 | train.json `images`, `labels`, `val_images`, `val_labels` |
| 公開の代替 | README は「EndoVis 2017 などの公開データで同様のモデルを学習できる」と記載（Bundle 付属のデータではない） | README「Data」 |

### 4. 既報の指標と分割

| 欄 | 値 | 出典 |
|---|---|---|
| 指標 | **mean IoU 0.86**（術具 1 クラス、背景除外）。**Dice の既報値は無い**（学習・検証時に `val_mean_dice` を追加指標として計算する設定はあるが、値は書かれていない） | metadata.json `eval_metrics.mean_iou`、README「Performance」、train.json `validate#additional_metrics.val_mean_dice` |
| 算出データ | 検証データ（`val` フォルダ）の mean IoU とみなされるが、README にはどの分割の値か**明記がない**。図（Validation IoU 100 epoch）の最終値か最大値かも不明 | README「Performance」。図は取得していない |
| 分割 | `val_images` = `dataset_dir/val/*/*[!seg].jpg` の sorted。**非公開データのためどの症例が val かを外部から特定できない** | train.json |
| 独立性 | **独立性なし**（検証データでチェックポイントを選択している: `CheckpointSaver` `save_key_metric: true` で `val_iou` が最良の時点を model.pt に保存）。test フォルダの結果は報告されていない | train.json `validate#handlers`, `validate#key_metric` |
| 乱数 | `set_determinism(seed=123)`。ただしデータが非公開なので再現に使えない | train.json `initialize` |
| 学習設定 | 100 epoch、Adam lr 1e-4、CosineAnnealingWarmRestarts(T_0=100)、DiceFocalLoss(jaccard, include_background false)、batch 8、RandRotated(±π, p 0.8)、RandZoomd(0.8–1.2, p 0.2) | train.json |

### 5. 独立に使える公開データ

| 欄 | 値 | 出典 |
|---|---|---|
| 候補 | **EndoVis 2017 Robotic Instrument Segmentation**（Grand Challenge）。da Vinci Xi の豚の手術動画、学習 8 本 × 225 フレーム（2 Hz）、テスト 8 本 × 75 フレーム + 300 フレーム 2 本。元画像は 1280x1024（動画フレームから (320, 28) で切り出す）。**2 値（術具=255、背景=0）のラベル課題**があり、本 Bundle の出力に対応づけられる。部位・種別のラベルは別課題（今回は不要） | https://endovissub2017-roboticinstrumentsegmentation.grand-challenge.org/Data/ （200、2026-10-18）、…/Home/（200） |
| モデルの学習に使われていない根拠 | Bundle の学習データは Activ Surgical の非公開サンプルで、README は EndoVis を「別途使えるデータ」として挙げるのみ。EndoVis が学習に含まれていない、とは README から**断定できない**（「含まれない」と書いた記述はなく、非公開データの中身が不明）。ただし Activ Surgical は別組織・別装置（Intuitive の da Vinci ではない）であり、EndoVis そのものが含まれた形跡は README / metadata に無い。→ 「含まれていない根拠は弱い（状況証拠のみ）」 | README「Data」、metadata.json `data_source` |
| 件数・サイズ | 公式: 学習 1,800 フレーム（8×225）、テスト 600 フレーム（8×75 + 2×300）。ファイルサイズは**未取得**（Downloads ページが本文を返さなかったため） | Data ページ。Downloads ページ（…/Downloads/）は本文が取れず（サインイン前提と思われるが未確認） |
| 登録・同意 | **未確認**。Home ページに「Join」ボタンあり（challenge への参加登録）。Home は「challenge is now over … To use the data in your publications, please cite this work」と記載。データ利用規約・ライセンスは取得できた範囲に記載なし → **不明** | …/Home/ |
| 第三者の複製 | Zenodo 10.5281/zenodo.10527017「Endovis2017 & Endovis2018 Datasets preprocessed for Contrastive Segmentation…」、CC-BY-4.0、access_right open、endovis2017.zip 1,515,311,398 B。**前処理済みの派生物**（ラベル形式・サイズ・フレーム選択が公式と異なる可能性があり、中身は未確認）。元データの権利との関係も未確認のため、検証用の基準データとしては使う前に中身確認が要る | Zenodo API `records/10527017`（metadata.license, files） |
| 論文 | Allan et al., "2017 Robotic Instrument Segmentation Challenge", arXiv 1902.06426（検索結果より。本文は未読） | WebSearch（arxiv.org/abs/1902.06426 は curl 未確認） |

### 6. 再現検証の可否

| 欄 | 値 |
|---|---|
| 判定 | **未達＋参考値**。既報の 0.86 は非公開の検証データの IoU で、症例を特定できない。 |
| 参考値の使い方 | 0.86（IoU）は「別の公開データ（EndoVis 2017 など）での IoU が桁違いに低くないか」の目安に留める。ドメインが異なる（装置・光学・組織・器具）ため、0.86 を合否の基準にしない。 |

### 7. 参照実行に必要なもの（閾値の数値は出さない）

- 症例を特定できるか: Bundle 付属の検証症例は**特定不可**。公開データ（EndoVis 2017）で参照実行する場合は、その中の症例を自分で選ぶことになり、既報の分割とは無関係。
- コマンド（MONAI 公式）: 推論 `python -m monai.bundle run --config_file configs/inference.json`（`dataset_dir` を上書き、`dataset_dir/test/*/*[!seg].jpg` を読む）。IoU/Dice の算出は `python -m monai.bundle run --config_file "['configs/train.json','configs/evaluate.json']"`（val フォルダ、MetricsSaver が `val_iou` と `val_mean_dice` の症例別値を出力）。
- 入力の前処理: 上記 1。データを `train/ val/ test/` の下に置き、各症例フォルダに `x.jpg` と `x_seg.jpg` の組。ラベルは 0/255 の JPEG が前提（README は画像とラベルの形式を揃える必要を警告。形式が違うと転置してラベルが不一致になる）。EndoVis の PNG ラベルは JPEG へ変換するか、`images`/`labels` の設定を直す必要がある。
- GPU: 学習は 12 GB 以上（README）。推論の必要量は**不明**（段 0c で実測）。
- 必要データ: EndoVis 2017 の画像とラベル（入手は 5 を参照、未確認）。
- 注意: Bundle の `labels` 生成は `x.replace('.jpg','_seg.jpg')` で、glob は `*[!seg].jpg`（文字クラス。「末尾の 1 文字が s/e/g 以外」を意味し、"seg" という接尾辞の除外ではない。名前が s・e・g で終わる画像が落ちる）。→ 8 を参照。

### 8. 注意点・つまずきそうな所

- **指標の名前**: 既報は IoU。Dice と取り違えない（同じ予測でも Dice ≧ IoU）。比較は同じ指標で行う。
- **ラベルは 2 値のみ**: EndoVis の部位・種別ラベルを使うと意味が合わない。2 値（術具の全部位の和集合）に直す必要がある。EndoVis の「その他の器具」（腹腔鏡器具・超音波プローブ）を術具に含めるか背景にするかで IoU が変わる。本 Bundle の学習データ側の扱いは**不明**。
- **ラベル値**: 学習 JPEG ラベルは 0/255（ScaleIntensityd で 0/1）。0/1 の PNG を ScaleIntensityd に通すと、ラベルが全て 0 または全て 1 の画像で正規化が崩れる（画像ごとの min-max のため）。ラベルが全て背景のフレームでは 0/0 → 0 だが、術具だけの画像では 1 が 1 のまま。要・実物で確認。
- **JPEG の圧縮**: ラベルが JPEG のため、境界に 0/255 以外の値が混じる（nearest でリサイズしても元が劣化している）。参照実行と GRAPHY-Next 経路で同じ入力を使うこと。
- **入力正規化**: ScaleIntensityd は画像ごとの min-max。GRAPHY-Next 側で固定値 /255 にすると、暗いフレームなどで入力が変わる。
- **サイズ・向き（軸順）**: spatial_shape [736, 480] は MONAI の読み込み後の軸順（PIL 経由で (幅, 高さ) の転置された配列になる、という README の警告あり）。つまり MONAI の ImageReader（PIL）は画像を [W, H] の配列として扱い、Resized で [736, 480] にする。GRAPHY-Next が [H, W] で渡すと転置になり、結果が崩れる。要・実物（本調査では未検証）。
- **ImageNet 重み**: `use_imagenet_pretrain: true` は非商用。公開 model.pt の推論には不要。
- **ライセンス**: 重みと学習データの条項が不明。商用判断は保留（法務）。EndoVis は利用規約の確認が先。
- **dropout 0.6**: 学習時のみ。推論は eval モード。

### 向きの検証（c）に使える性質

- **DICOM 患者座標が無い**: 向きは画像の行・列（上下・左右）だけで、LPS の向きは定義されない。
- **使える性質（主張の根拠は下の「確かめた/未確認」を参照）**:
  1. 術具は通常、画像の**外周（下端・左右端）から入って中央へ伸びる**。トロッカー（体表の挿入点）は視野外にあるため、術具の連結成分は画像の外周に接するはずで、上下・左右の反転、転置で外周との接し方が変わる。
  2. 上下反転・左右反転・90° 回転・転置の 4〜8 通りに対して**同じ画像を入れて Dice/IoU を比べる**。正しい向きで最大になり、他の向きで落ちる（モデルは回転・拡大の拡張で学習しているが、RandRotated は ±π なので回転にはある程度頑健＝**回転不変性のため、向きの検出力は弱いかもしれない**。要・実測）。
  3. 転置（軸順の取り違え）は、RandRotated で 90° 回転が学習に含まれても、画像の縦横比 736:480 の学習からずれるので影響が出る可能性。要・実測。
- **確かめた/未確認**: 上は一般的な性質と README / 設定からの推論であり、Bundle の出典に直接の記載はない。「正例で通り負例で落ちる」ことは**未確認**（正例=正しい向きの EndoVis フレーム、負例=反転・転置したフレームで IoU が下がるかを実データで示してから、検査器として使う）。回転で学習している点が、検出力を下げる側の懸念。
- 注意: 学習拡張に ±π 回転があるため、回転で IoU がほとんど落ちない可能性がある。その場合、このモデルは向きの検査器には向かない（試す前に「使えない」と決めない。実測で判定する）。

### 不明・未確認の一覧と理由

| 項目 | 理由 |
|---|---|
| 学習・検証データの件数、症例 | 非公開（Activ Surgical）。README・metadata に記載なし |
| 0.86 がどの分割の値か、最終値か最大値か | README に明記なし。図（NVIDIA 配布の PNG）は取得していない |
| 重みのライセンス、学習データの利用条件、商用可否 | HF カード本文なし（README.md が "Entry not found"）、data_license.txt は提供元の表記のみ |
| 公開の model.pt がどの事前学習を経たか | README は "some internal data" とのみ |
| 推論に必要な GPU メモリ | README に記載なし |
| EndoVis 2017 の入手方法（登録・同意）、利用規約、ファイルサイズ | Downloads ページが本文を返さず、Data/Home ページに規約の記載なし。Join ボタンは参加登録 |
| EndoVis が Bundle の学習に含まれていないことの確証 | データ非公開のため断定できない（状況証拠のみ） |
| Zenodo 版 EndoVis の中身（ラベル形式、フレーム数、公式との一致） | 取得していない（約 1.5 GB のためダウンロード禁止） |
| ScaleIntensityd の既定動作、PIL 経由の軸順（[W,H]）の実挙動 | MONAI の実装知識に基づく。実物で未確認 |
| 向きの検証としての有効性（回転拡張の影響） | 実データで未測定 |
| 器具の定義（EndoVis の「その他の器具」を含めるか） | Bundle 側の扱いが不明 |
| arXiv 1902.06426 の本文、HF 以外の Google Drive 配布の生死 | 未取得・未確認 |
