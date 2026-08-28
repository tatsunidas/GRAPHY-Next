// 起動スプラッシュ文言のテスト。
// 守りたいのは 3 点:
//   1. ja / en の両方に全コードがある（片方だけはレビュー差し戻し対象）
//   2. {port} 等のプレースホルダが必ず埋まる（"{seconds}" が画面に出るのは事故）
//   3. 未知のコードでも「何も出ない」にはならない
const test = require("node:test");
const assert = require("node:assert");
const messages = require("./startupMessages");

const CODES = [
  "jar-missing",
  "jar-broken",
  "java-missing",
  "java-too-old",
  "spawn-failed",
  "port-in-use",
  "db-locked",
  "backend-exited",
  "backend-timeout",
  "backend-stalled",
];

const PARAMS = { port: 8080, code: 1, seconds: 15, step: "database" };

test("全コードが ja / en の両方で非空の文になる", () => {
  for (const code of CODES) {
    for (const locale of ["ja", "en"]) {
      const text = messages.format(locale, code, PARAMS);
      assert.ok(text && text.length > 0, `${locale}/${code} が空`);
      assert.notStrictEqual(text, messages.format(locale, "unknown", {}), `${locale}/${code} が未定義`);
    }
  }
});

test("プレースホルダが残らない", () => {
  for (const code of CODES) {
    for (const locale of ["ja", "en"]) {
      const text = messages.format(locale, code, PARAMS);
      assert.ok(!/\{\w+\}/.test(text), `${locale}/${code}: 未置換のプレースホルダ → ${text}`);
    }
  }
});

test("値がそのまま文に入る", () => {
  assert.match(messages.format("ja", "port-in-use", { port: 18080 }), /18080/);
  assert.match(messages.format("en", "backend-exited", { code: 137 }), /137/);
  // {step} は識別子ではなく、その言語の呼び名に置き換わる
  assert.match(messages.format("ja", "backend-stalled", { seconds: 20, step: "database" }), /データベース/);
  assert.match(messages.format("en", "backend-stalled", { seconds: 20, step: "database" }), /database/);
});

test("未知のコード / 未知の言語でもフォールバックする", () => {
  assert.ok(messages.format("ja", "no-such-code", {}).length > 0);
  assert.strictEqual(messages.format("fr", "port-in-use", { port: 1 }), messages.format("ja", "port-in-use", { port: 1 }));
});

test("未知の step はそのまま返る（訳を持たない backend 側の新 step でも壊れない）", () => {
  assert.strictEqual(messages.stepLabel("ja", "brand-new-step"), null);
  assert.strictEqual(messages.stepNoun("en", "brand-new-step"), "brand-new-step");
});
