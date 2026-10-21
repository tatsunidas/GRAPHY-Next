# Remote compute demo（作者向けの最小の見本）

`host.compute.runJob`（H59）で、表示中のシリーズを外部の計算機（Google Colab の GPU・Jupyter Server）へ送って Python を実行し、
結果のマスクを `host.showLabelVolume`（H65）で ROI マネージャに出します。窓を閉じると、Colab のランタイムを解放するかを本体が聞きます（H61）。

- データは本体が匿名化して作ります（プラグインが渡すのはシリーズの参照だけ）。送るたびに本体の窓で、送り先・データ・コードの全文を見せて同意を取ります。
- 計算機の上では作業フォルダに `inputs/0.npz`（`volume` float32 `[z,y,x]`・`spacing`・`origin`・`direction`・`meta.json`）が置かれ、`outputs/` に書いたものが返ります。
- 計算機は環境設定 ＞ 外部の計算機 で登録します（Google にログイン済みなら、最初の実行で Colab の GPU T4 が自動で登録されます）。

## 複数のシリーズへ同じ処理をかける（一括）

`host.compute.runBatch` は、同じコードを入力の組ごとに走らせます。**同意は全組で 1 回**（本体の窓が全組の行と合計、コードの全文を見せます）。

```js
const out = await host.compute.runBatch(
  { script, items: studies.map((s, i) => ({ key: `case-${i + 1}`, inputs: [{ studyUid: s.studyUid, seriesUid: s.seriesUid }] })) },
  {
    onItem: async (item) => {           // 組が終わるたびに届く（runJob と同じ形に key が付く）
      if (item.ok && item.status === "ok") { const mask = await item.readFile("mask.npy"); /* … */ }
      await item.markCollected();       // 受け取り済み（計算ジョブの窓に出る）
    },
    onProgress: (fraction) => { /* 終わった組の割合 */ },
  },
);
// out.paused が true なら、計算機に届かなくなって一時停止中（残りは失敗にしていない）。利用者が計算ジョブの窓で［再開］を押す。
// out.refused は、送れずに外した組（焼き込み・格子など）と理由。
```

- 組の名前（`key`）は英数字と `. _ -` の 64 字まで。**患者名を入れないでください**（台帳・監査に残ります）。
- 1 組が落ちても残りは続きます。実行は本体の台帳が持つので、画面を閉じても計算は続き、開き直して `host.compute.attach(batchId, { onItem })` で受け取っていない結果を受け取れます。
- `host.compute.listJobs()` は自分のプラグインの行の一覧です。

実用のプラグイン（MONAI Bundle のモデルで臓器を分割し、SEG で保存する）は公式リポジトリ
[tatsunidas/graphy-next-plugin-monai](https://github.com/tatsunidas/graphy-next-plugin-monai) を見てください。設計: `fw/remote-compute-design.md`。
