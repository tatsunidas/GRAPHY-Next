const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { endpointFile, userDataName, ENDPOINT_FILE } = require("./mcpCli");

test("発見用ファイルは appData/<Electron の userData 名>/mcp-endpoint.json（mcpBridge が userData に書く場所）", () => {
  const appDataBase = path.join("x", "appdata");
  assert.equal(endpointFile({ env: {}, appDataBase, name: "graphy-next-desktop" }), path.join(appDataBase, "graphy-next-desktop", "mcp-endpoint.json"));
  assert.equal(ENDPOINT_FILE, "mcp-endpoint.json");
});

test("userData の名前は package.json の productName、無ければ name（Electron の app.getName() と同じ規則）。データの GRAPHY-Next ではない", () => {
  // 実際の desktop/package.json: 今は name=graphy-next-desktop（productName は build の中だけ）。パッケージ版の userData はこの名前になる
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf8"));
  assert.equal(userDataName(), pkg.productName || pkg.name);
  assert.notEqual(userDataName(), "GRAPHY-Next");
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "mcpcli-"));
  fs.writeFileSync(path.join(d, "package.json"), JSON.stringify({ name: "n", productName: "P" }));
  assert.equal(userDataName(d), "P");
  fs.writeFileSync(path.join(d, "package.json"), JSON.stringify({ name: "n" }));
  assert.equal(userDataName(d), "n");
  fs.writeFileSync(path.join(d, "package.json"), "{bad");
  assert.equal(userDataName(d), "graphy-next-desktop"); // 読めなければ既定
});

test("GRAPHY_MCP_ENDPOINT があればそのパス（開発起動・検査用）", () => {
  assert.equal(endpointFile({ env: { GRAPHY_MCP_ENDPOINT: "rel/e.json" }, appDataBase: "ignored", name: "x" }), path.resolve("rel/e.json"));
});

test("mcpBridge の発見用ファイル名と一致している。main は userData に置く（片方だけ変えると中継が見つけられない）", () => {
  const src = fs.readFileSync(path.join(__dirname, "main.js"), "utf8");
  assert.ok(src.includes(`path.join(app.getPath("userData"), "${ENDPOINT_FILE}")`), "main.js の discoveryFile は userData 直下");
});
