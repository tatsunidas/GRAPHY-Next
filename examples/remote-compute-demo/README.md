# Remote compute demo（作者向けの最小の見本）

`host.compute.runJob`（H59）で、表示中のシリーズを外部の計算機（Google Colab の GPU・Jupyter Server）へ送って Python を実行し、
結果のマスクを `host.showLabelVolume`（H65）で ROI マネージャに出します。窓を閉じると、Colab のランタイムを解放するかを本体が聞きます（H61）。

- データは本体が匿名化して作ります（プラグインが渡すのはシリーズの参照だけ）。送るたびに本体の窓で、送り先・データ・コードの全文を見せて同意を取ります。
- 計算機の上では作業フォルダに `inputs/0.npz`（`volume` float32 `[z,y,x]`・`spacing`・`origin`・`direction`・`meta.json`）が置かれ、`outputs/` に書いたものが返ります。
- 計算機は環境設定 ＞ 外部の計算機 で登録します（Google にログイン済みなら、最初の実行で Colab の GPU T4 が自動で登録されます）。

実用のプラグイン（MONAI Bundle のモデルで臓器を分割し、SEG で保存する）は公式リポジトリ
[tatsunidas/graphy-next-plugin-monai](https://github.com/tatsunidas/graphy-next-plugin-monai) を見てください。設計: `fw/remote-compute-design.md`。
