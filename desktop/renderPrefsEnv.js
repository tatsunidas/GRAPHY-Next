// 開発起動（scripts/dev-desktop.sh）が Electron を起動する前に評価する: 保存した「描画に使う GPU」の選択に応じた
// 環境変数の export 行を出す。Linux の PRIME オフロードは Electron が起動した後では効かない（main.js の
// applyRenderPrefsAtStartup のコメント）。値は renderPrefs.js の固定の定数だけ。何があっても何も出さず正常終了する。
try {
  const rp = require("./renderPrefs");
  const { resolveDevDataDir } = require("./devDataDir");
  const plan = rp.applyPlan(rp.load(resolveDevDataDir(process.env, false, process.cwd())), {
    platform: process.platform,
    nvidiaPresent: rp.nvidiaGpuCount() > 0,
  });
  for (const [k, v] of Object.entries(plan.env)) console.log(`export ${k}=${v}`);
} catch {
  /* 何も出さない（OS の既定で起動する） */
}
