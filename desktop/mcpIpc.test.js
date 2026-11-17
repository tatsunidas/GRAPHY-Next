// MCP の IPC 名が、preload の公開と main の handle で食い違っていないか（片方だけ変えると設定画面が黙って動かなくなる）。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const read = (f) => fs.readFileSync(path.join(__dirname, f), "utf8");
const names = (src, re) => new Set([...src.matchAll(re)].map((m) => m[1]));

test("preload が呼ぶ graphy:mcp-* と main が handle する graphy:mcp-* が一致する", () => {
  const invoked = names(read("preload.js"), /ipcRenderer\.invoke\("(graphy:mcp-[a-z-]+)"/g);
  const handled = names(read("main.js"), /ipcMain\.handle\("(graphy:mcp-[a-z-]+)"/g);
  assert.deepEqual([...invoked].sort(), ["graphy:mcp-get", "graphy:mcp-set"]);
  assert.deepEqual([...handled].sort(), [...invoked].sort());
});

test("mcp-get / mcp-set はメインの窓からだけ（isMainSender）", () => {
  const src = read("main.js");
  const get = src.slice(src.indexOf('ipcMain.handle("graphy:mcp-get"'));
  assert.match(get.slice(0, 200), /isMainSender\(e\)/);
  const set = src.slice(src.indexOf('ipcMain.handle("graphy:mcp-set"'));
  assert.match(set.slice(0, 300), /isMainSender\(e\)/);
});
