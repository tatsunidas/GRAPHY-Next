# MONAI Bundle（外部の計算機）— サンプルプラグイン

GRAPHY-Next の 2D ビューアから、[MONAI Bundle](https://docs.monai.io/en/stable/bundle_intro.html) のセグメンテーション
モデルを **外部の計算機（Google Colab の GPU、または自分で立てた Jupyter Server）** で動かし、結果を **DICOM SEG** として保存します。
`host.compute.runJob`（H59）の使い方の手本です。設計: `fw/remote-compute-design.md` §16。

## 使い方

1. 環境設定 ＞ 外部の計算機 で、Colab（例: GPU T4）か Jupyter Server を登録しておく。
2. 2D ビューアで CT などのシリーズを開き、「解析」メニュー ＞ **MONAI Bundle (remote GPU)**。
3. 一覧から Bundle を選んで「実行」。表示中のシリーズのモダリティに合わないものは選べない。一覧に無いものは「その他」で名前を入れる
   （Model Zoo の名前、または Hugging Face の `組織/名前`）。
4. 送る前に本体の窓で **送り先・送るデータ・実行するコードの全文** の確認がある（1 回）。
5. 計算機の上で Bundle の `configs/metadata.json` を読み、使えるか（モダリティ・チャネル数・出力がセグメンテーションか）を判定する。
   合わなければ推論せずに止まり、理由とモデルの説明が出る。使えれば推論する。
6. 下見の画像を確かめ、保存するラベルを選んで「SEG で保存」。保存した SEG は ROI マネージャの SEG 読み込みで表示できる。
7. 窓を閉じると、Colab のランタイムを確保したままなら、本体が「解放しますか」を聞く。

## 入出力の決め方（自動でわかること）

MONAI Bundle は `configs/metadata.json` の `network_data_format` に入出力を書く決まりがあります。

```json
"inputs":  {"image": {"modality": "CT", "format": "hounsfield", "num_channels": 1, "spatial_shape": [96,96,96]}},
"outputs": {"pred":  {"format": "segmentation", "channel_def": {"0": "background", "1": "spleen"}}}
```

このプラグインは、ここから「使えるか」と「ラベル名」を決めます。前処理（リサンプリング・向き・窓）は Bundle の
`inference.json` のとおりに `monai.bundle.run` が行うので、プラグインでは書き直しません。

⚠ メタデータは作者の自己申告です。止めるのは明らかに合わないときだけなので、結果は必ず目で確かめてから保存してください。
⚠ Bundle ごとにライセンスが違います（学習データの条件で非商用のものもあります）。下見に出るライセンスを確認してください。

## 計算機の上でしていること

- `inputs/0.npz`（float32 `[z, y, x]`・HU・`spacing`/`origin`/`direction` は LPS）→ NIfTI（RAS の affine）
- `monai.bundle.run(config_file=inference.json, datalist=[画像], output_dir=…)` で推論
- 出力の NIfTI を affine で入力の格子に戻し、`outputs/labels.npy`（uint8/uint16 `[z, y, x]`）と `outputs/labels.json` を返す
- Bundle は `/content/graphy-cache/bundles`（Colab）に置くので、同じランタイムでの 2 回目はダウンロードしない
- **パッケージ（monai・nibabel・Bundle が求めるもの）を自分で入れるのは Colab のときだけ**。自分で立てた Jupyter では
  環境を書き換えず、足りないパッケージ名を示して止まる

## 制限

- 入力が 1 シリーズ・1 チャネルのモデルだけ（BraTS のように複数の MR 系列を重ねるものは「使えない」と出る）
- 出力がセグメンテーションのモデルだけ
- SEG はセグメントごとに volume と同じ大きさのマスクを渡すので、ラベルが多いときは選んで保存する（合計 1.5 GB まで）
- `datalist` / `output_dir` を上書きできない形の `inference.json` を持つ Bundle は失敗する（エラーで止まる）

## テスト

```bash
node --test examples/remote-compute-monai
# 計算機の上のコードも（偽の MONAI で npz→NIfTI→npz の往復）:
GRAPHY_TEST_PYTHON=/path/to/python [GRAPHY_TEST_PYTHONPATH=<nibabel の場所>] node --test examples/remote-compute-monai
```
