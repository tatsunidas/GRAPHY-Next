const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { viewerMenuTemplate } = require("./viewerMenu");

function roles(items, out = []) {
  for (const it of items || []) {
    if (it.role) out.push(it.role);
    if (Array.isArray(it.submenu)) roles(it.submenu, out);
  }
  return out;
}

for (const platform of ["linux", "win32"]) {
  test(`${platform}: 別窓のメニューに Quit が無く、File は「窓を閉じる」`, () => {
    const t = viewerMenuTemplate(platform);
    assert.ok(Array.isArray(t));
    assert.ok(!roles(t).map((r) => r.toLowerCase()).includes("quit"), "Quit は本体ごと終了するので別窓に置かない");
    const file = t.find((m) => m.label === "File");
    assert.deepEqual(file.submenu, [{ role: "close" }]);
  });

  test(`${platform}: 既定メニューにあった Edit・View・Window は残す`, () => {
    const top = viewerMenuTemplate(platform).map((m) => m.role).filter(Boolean);
    assert.deepEqual(top, ["editMenu", "viewMenu", "windowMenu"]);
  });
}

test("darwin: 窓ごとのメニューは付けない（アプリ共通のメニューのまま）", () => {
  assert.equal(viewerMenuTemplate("darwin"), null);
});

test("main.js の createViewerWindow がこのメニューを窓に付けている", () => {
  const src = fs.readFileSync(path.join(__dirname, "main.js"), "utf8");
  const start = src.indexOf("function createViewerWindow(");
  assert.ok(start >= 0);
  const body = src.slice(start, src.indexOf("\nfunction ", start + 1));
  assert.ok(body.includes("viewerMenuTemplate(process.platform)"), "createViewerWindow でテンプレートを作る");
  assert.ok(body.includes("win.setMenu(Menu.buildFromTemplate("), "作ったメニューを窓に付ける");
});
