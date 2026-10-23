const test = require("node:test");
const assert = require("node:assert/strict");
const M = require("./mediaPermission");

const ASSISTANT = "file:///app/renderer/index.html#assistant";
const MAIN = "file:///app/renderer/index.html#/";

test("マイク(音声のみ)は、アシスタント窓のメインフレームだけに許す", () => {
  assert.equal(M.allowRequest({ permission: "media", mediaTypes: ["audio"], pageUrl: ASSISTANT, isMainFrame: true }), true);
  assert.equal(M.allowRequest({ permission: "media", mediaTypes: ["audio"], pageUrl: `${ASSISTANT}?x=1`, isMainFrame: true }), true);
});

test("🔴 負例: 他の窓・iframe・映像つき・種類不明は拒否", () => {
  for (const a of [
    { mediaTypes: ["audio"], pageUrl: MAIN, isMainFrame: true },
    { mediaTypes: ["audio"], pageUrl: "https://evil.example/#assistant-x", isMainFrame: true },
    { mediaTypes: ["audio"], pageUrl: ASSISTANT, isMainFrame: false },
    { mediaTypes: ["audio", "video"], pageUrl: ASSISTANT, isMainFrame: true },
    { mediaTypes: ["video"], pageUrl: ASSISTANT, isMainFrame: true },
    { mediaTypes: [], pageUrl: ASSISTANT, isMainFrame: true },
    { pageUrl: ASSISTANT, isMainFrame: true },
    { mediaTypes: ["audio"], pageUrl: "", isMainFrame: true },
  ]) assert.equal(M.allowRequest({ permission: "media", ...a }), false, JSON.stringify(a));
});

test("media 以外の権限は従来どおり許可（挙動を変えない）", () => {
  for (const permission of ["clipboard-read", "fullscreen", "notifications", "geolocation"]) {
    assert.equal(M.allowRequest({ permission, pageUrl: MAIN }), true, permission);
    assert.equal(M.allowCheck({ permission, pageUrl: MAIN }), true, permission);
  }
});

test("確認ハンドラ: 音声と enumerateDevices(unknown) はアシスタント窓だけ・映像は常に拒否", () => {
  assert.equal(M.allowCheck({ permission: "media", mediaType: "audio", pageUrl: ASSISTANT }), true);
  assert.equal(M.allowCheck({ permission: "media", mediaType: "unknown", pageUrl: ASSISTANT }), true);
  assert.equal(M.allowCheck({ permission: "media", mediaType: "video", pageUrl: ASSISTANT }), false);
  assert.equal(M.allowCheck({ permission: "media", mediaType: "audio", pageUrl: MAIN }), false);
  assert.equal(M.allowCheck({ permission: "media", mediaType: "audio", pageUrl: "" }), false);
});

test("install: webContents が null でも落ちず、media は拒否になる", () => {
  let req, chk;
  M.install({ setPermissionRequestHandler: (f) => { req = f; }, setPermissionCheckHandler: (f) => { chk = f; } });
  let got;
  req(null, "media", (v) => { got = v; }, { mediaTypes: ["audio"], isMainFrame: true });
  assert.equal(got, false);
  assert.equal(chk(null, "media", "x", { mediaType: "audio" }), false);
  req({ getURL: () => ASSISTANT }, "media", (v) => { got = v; }, { mediaTypes: ["audio"], isMainFrame: true });
  assert.equal(got, true);
});
