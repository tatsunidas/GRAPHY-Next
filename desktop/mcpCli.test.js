const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { endpointFile, ENDPOINT_FILE } = require("./mcpCli");

test("発見用ファイルは appData/GRAPHY-Next 直下の mcp-endpoint.json（mcpBridge が書く場所）", () => {
  const appData = path.join("x", "GRAPHY-Next");
  assert.equal(endpointFile({ env: {}, appData }), path.join(appData, "mcp-endpoint.json"));
  assert.equal(ENDPOINT_FILE, "mcp-endpoint.json");
});

test("GRAPHY_MCP_ENDPOINT があればそのパス（開発起動・検査用）", () => {
  assert.equal(endpointFile({ env: { GRAPHY_MCP_ENDPOINT: "rel/e.json" }, appData: "ignored" }), path.resolve("rel/e.json"));
});

test("mcpBridge の発見用ファイル名と一致している（片方だけ変えると中継が見つけられない）", () => {
  const src = require("node:fs").readFileSync(path.join(__dirname, "main.js"), "utf8");
  assert.ok(src.includes(`"${ENDPOINT_FILE}"`), "main.js の discoveryFile");
});
