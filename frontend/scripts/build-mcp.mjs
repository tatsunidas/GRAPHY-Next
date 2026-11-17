// 外部 AI クライアント向けの中継 graphy-mcp（stdio）を 1 ファイルに束ねる。
//   node scripts/build-mcp.mjs   →  ../desktop/mcp/run.cjs
// SDK は stdio の部分だけを使う。HTTP のトランスポート（express・hono・cors）や OAuth（jose）が束に入ったら落とす
// （入ると配布物が大きくなり、HTTP 側の既知の脆弱性の対象にもなる）。
import path from "node:path";
import { build } from "esbuild";

const root = path.resolve(import.meta.dirname, "..");

const result = await build({
  entryPoints: [path.join(root, "src", "mcp", "server.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  outfile: path.resolve(root, "..", "desktop", "mcp", "run.cjs"),
  logLevel: "warning",
  metafile: true,
});

const inputs = Object.keys(result.metafile.inputs).map((p) => p.replaceAll("\\", "/"));
const banned = inputs.filter(
  (p) => /src\/(http|log)\.ts$/.test(p) || /node_modules\/(express|hono|@hono|cors|jose|express-rate-limit|eventsource|cross-spawn)\//.test(p) || /sdk\/dist\/(esm|cjs)\/(server\/(sse|streamableHttp|auth|middleware)|client\/)/.test(p),
);
if (banned.length) {
  console.error(`束に入ってはいけないものが入っています:\n  ${banned.slice(0, 10).join("\n  ")}`);
  process.exit(1);
}
console.log(`built desktop/mcp/run.cjs (${inputs.length} inputs)`);
