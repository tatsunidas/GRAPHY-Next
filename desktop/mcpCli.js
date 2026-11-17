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
 * 発見用ファイル。既定はインストール版の userData（appData/GRAPHY-Next）。開発起動の userData は `graphy-next-desktop`（electron の app 名）なので、
 * 開発では `GRAPHY_MCP_ENDPOINT`（パス）で指す（検査用にも使う）。
 */
function endpointFile({ env = process.env, appData = appDataDir() } = {}) {
  return env.GRAPHY_MCP_ENDPOINT ? path.resolve(env.GRAPHY_MCP_ENDPOINT) : path.join(appData, ENDPOINT_FILE);
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

module.exports = { endpointFile, ENDPOINT_FILE, main };

if (require.main === module) {
  main().then((code) => process.exit(code), () => {
    console.error("graphy-mcp: 中継を続けられませんでした");
    process.exit(EXIT_ERROR);
  });
}
