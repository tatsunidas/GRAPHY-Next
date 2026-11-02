// 一括抽出の無人実行（desktop/batchCli.js が呼ぶ）の実行部分を 1 ファイルに束ねる。
//   node scripts/build-batch-cli.mjs   →  ../desktop/batch-cli/run.cjs
// `src/http.ts`（window・log・DOMException に依存する）だけを、Node 用の代役 `src/radiomics/cli/httpNode.ts` に差し替える。
import path from "node:path";
import { build } from "esbuild";

const root = path.resolve(import.meta.dirname, "..");
const httpTs = path.join(root, "src", "http");
const shim = path.join(root, "src", "radiomics", "cli", "httpNode.ts");

const result = await build({
  entryPoints: [path.join(root, "src", "radiomics", "cli", "batchCliMain.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  outfile: path.resolve(root, "..", "desktop", "batch-cli", "run.cjs"),
  logLevel: "warning",
  metafile: true,
  plugins: [{
    name: "http-node",
    setup(b) {
      b.onResolve({ filter: /(^|\/)http$/ }, (a) => (path.resolve(a.resolveDir, a.path) === httpTs ? { path: shim } : undefined));
    },
  }],
});

const inputs = Object.keys(result.metafile.inputs).map((p) => p.replaceAll("\\", "/"));
if (inputs.some((p) => /src\/(http|log)\.ts$/.test(p))) {
  console.error("window 依存の http.ts / log.ts が束に入っています");
  process.exit(1);
}
console.log(`built desktop/batch-cli/run.cjs (${inputs.length} inputs)`);
