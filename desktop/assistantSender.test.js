// `node --test`。会話の口を呼べる窓の判定。
const test = require("node:test");
const assert = require("node:assert");
const { isAssistantUrl, isAssistantSender } = require("./assistantSender");

test("#assistant の窓だけが通る（正例）", () => {
  assert.equal(isAssistantUrl("http://localhost:5173/#assistant"), true);
  assert.equal(isAssistantUrl("file:///app/index.html#assistant"), true);
  assert.equal(isAssistantUrl("file:///app/index.html#assistant?x=1"), true);
});

test("他の窓・紛らわしい URL は通らない（負例）", () => {
  for (const u of [
    "http://localhost:5173/", "http://localhost:5173/#2dviewer", "http://localhost:5173/#mpr",
    "http://localhost:5173/#assistants", "http://localhost:5173/#assistant2", "http://localhost:5173/?x=#assistant-evil",
    "http://localhost:5173/#/assistant", "", "not a url", null, undefined,
  ]) {
    assert.equal(isAssistantUrl(u), false, String(u));
  }
});

test("iframe など、メインフレーム以外からの呼び出しは通さない", () => {
  const main = { url: "file:///app/index.html#assistant" };
  const sub = { url: "file:///app/index.html#assistant" };
  assert.equal(isAssistantSender({ sender: { mainFrame: main }, senderFrame: main }), true);
  assert.equal(isAssistantSender({ sender: { mainFrame: main }, senderFrame: sub }), false);
  assert.equal(isAssistantSender({ sender: { mainFrame: main }, senderFrame: null }), false);
  assert.equal(isAssistantSender(null), false);
  const viewer = { url: "file:///app/index.html#2dviewer" };
  assert.equal(isAssistantSender({ sender: { mainFrame: viewer }, senderFrame: viewer }), false);
});
