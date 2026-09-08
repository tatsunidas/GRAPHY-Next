/**
 * ui.js を 1 ファイルにバンドルする。
 *
 * GRAPHY-Next のプラグインは「plugin.json ＋ ui.js」をフォルダ直下に置く形で配信される
 * （backend の PluginController は `/{id}/ui.js` しか返さない）。**分割チャンク・追加アセットは
 * 配信されない**ので、必ず単一ファイル・外部依存なしにすること。
 *
 * 🔴 **生成した ui.js はコミットする。** 実機スパイクはこのフォルダを配布物と同じ形で
 *    コピーするだけでビルドしない——焼き直しを忘れると**古い ui.js で緑になる**。
 *    （スパイク側にも「src が ui.js より新しければ落とす」検査がある）
 */
import { build } from "esbuild";
import { readFileSync, writeFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("plugin.json", "utf8"));

const result = await build({
  entryPoints: ["src/ui/ui.ts"],
  bundle: true,
  format: "esm",
  target: "es2022",
  platform: "browser",
  splitting: false,
  // 版はビルド時に埋める（実行時に plugin.json を読む手段が無い）。
  // レポートに「どの版が計算したか」を残すために要る。
  define: { __PLUGIN_VERSION__: JSON.stringify(pkg.version) },
  minify: false, // 医療用途なので、配布物を読んで検証できる状態を保つ
  legalComments: "inline",
  banner: {
    js:
      `/* ${pkg.name} v${pkg.version} — 胎児心エコー動画の要約（UVS）\n` +
      ` * 研究・教育目的。診断機器ではありません。\n` +
      ` * このファイルは tools/build.mjs が src/ui/ から生成します。直接編集しないこと。\n */`,
  },
  write: false,
});

const out = result.outputFiles[0];
writeFileSync("ui.js", out.text);
console.log(`ui.js を生成しました (${(out.contents.byteLength / 1024).toFixed(1)} KB)`);
