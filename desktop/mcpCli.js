// MCP の中継 graphy-mcp（stdio）。外部 AI クライアント（Claude Desktop など）が子プロセスとして起動し、標準入出力で MCP を話す。
// 実行の本体は frontend の `npm run build:mcp` が作る `mcp/run.cjs`。ここは発見用ファイルの場所を渡すだけ。
//
//   ELECTRON_RUN_AS_NODE=1 <electron> desktop/mcpCli.js        （インストール版は cli/graphy-mcp(.cmd) が起動する）
//
// 🔴 標準出力は MCP の通信そのもの。ここから何も書かない。標準エラー出力はクライアントのログに残るので、固定の文だけにする。
// 🔴 判断を持たない。受け口（main の mcpBridge）が開いている間だけ動き、閉じていれば呼び出しは「起動していない」旨を返す。
// electron を import しない（CI の Desktop ジョブは npm install しない）。SDK もここからは import しない（run.cjs に束ねてある）。
const fs = require("node:fs");
const path = require("node:path");
const { appDataDir } = require("./batchCli");

const EXIT_ERROR = 4;
const ENDPOINT_FILE = "mcp-endpoint.json";

/**
 * Electron の userData のフォルダ名（アプリ内の package.json の productName、無ければ name。electron の app.getName() と同じ規則）。
 * 🔴 パッケージ版の userData は `appData/graphy-next-desktop` で、データ（DB・設定）の `appData/GRAPHY-Next`（batchCli の appDataDir）とは別。
 *    main は mcp.json・mcp-endpoint.json・mcp-audit.jsonl を userData に置く。`GRAPHY-Next` を見ると、インストール版では見つけられない
 *    （2026-11-17 配布物の予行演習で判明。実機の v0.6.3 の deb で、userData が graphy-next-desktop、データが GRAPHY-Next に分かれることを確認）。
 */
function userDataName(dir = __dirname) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    if (typeof pkg.productName === "string" && pkg.productName) return pkg.productName;
    if (typeof pkg.name === "string" && pkg.name) return pkg.name;
  } catch {
    /* 読めなければ既定 */
  }
  return "graphy-next-desktop";
}

/** 発見用ファイル。既定はアプリの userData（上記）。開発起動では `GRAPHY_MCP_ENDPOINT`（パス）で指してもよい（検査用にも使う）。 */
function endpointFile({ env = process.env, appDataBase = path.dirname(appDataDir()), name = userDataName() } = {}) {
  return env.GRAPHY_MCP_ENDPOINT ? path.resolve(env.GRAPHY_MCP_ENDPOINT) : path.join(appDataBase, name, ENDPOINT_FILE);
}

async function main() {
  const runModule = path.join(__dirname, "mcp", "run.cjs");
  if (!fs.existsSync(runModule)) {
    console.error("実行部分（desktop/mcp/run.cjs）がありません。frontend で npm run build:mcp を実行してください");
    return EXIT_ERROR;
  }
  const { runMcp } = require(runModule);
  return runMcp(endpointFile());
}

module.exports = { endpointFile, userDataName, ENDPOINT_FILE, main };

if (require.main === module) {
  main().then((code) => process.exit(code), () => {
    console.error("graphy-mcp: 中継を続けられませんでした");
    process.exit(EXIT_ERROR);
  });
}
