// `node --test`。設計: roadmap AS-QA-001。要求の記録は本文を含まない。取れない値は null（0 で埋めない）。
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { buildRecord, createRequestLog } = require("./aiRequestLog");
const wire = require("./aiAdapters/wire");
const openai = require("./aiAdapters/openai");
const gemini = require("./aiAdapters/gemini");

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "graphy-reqlog-")), "ai-requests.jsonl");
const FULL = {
  sessionId: "s-1", provider: "cloud", kind: "openai", modelId: "m", modelVersion: "m-2026", destination: "external", fallbackFrom: "x",
  temperature: 0.5, usage: { in: 10, out: 2 }, latencyMs: 123.4, outcome: "ok", toolsOffered: 3, toolCalls: ["a", "b"], attachments: { images: { count: 2, bytes: 99 } },
};

test("buildRecord: 正例 — 項目が揃う", () => {
  const r = buildRecord(FULL);
  assert.deepEqual(r, {
    sessionId: "s-1", provider: "cloud", kind: "openai", modelId: "m", modelVersion: "m-2026", destination: "external", fallbackFrom: "x",
    params: { temperature: 0.5 }, usage: { in: 10, out: 2 }, latencyMs: 123, outcome: "ok", toolsOffered: 3, toolCalls: ["a", "b"], attachments: { images: { count: 2, bytes: 99 } },
  });
});

test("buildRecord: 負例 — 許可リスト以外（本文・引数・画像・鍵）は、キーが付いて来ても出力に現れない", () => {
  const dirty = { ...FULL, prompt: "山田太郎 MRN123", text: "返答本文", args: { a: "秘密" }, base64: "AAAA", apiKey: "sk-SECRET", messages: [{ text: "山田" }], error: "boom 山田太郎 sk-SECRET" };
  const s = JSON.stringify(buildRecord(dirty));
  for (const leak of ["山田", "MRN123", "返答本文", "秘密", "AAAA", "sk-SECRET", "boom"]) assert.equal(s.includes(leak), false, leak);
  assert.equal(buildRecord(dirty).outcome, "ok");
});

test("buildRecord: 自由文の outcome は other、不正なツール名は落ちる、usage 不明は null（0 でない）、不正値は捨てる", () => {
  assert.equal(buildRecord({ ...FULL, outcome: "接続できません: 山田" }).outcome, "other");
  assert.equal(buildRecord({ ...FULL, outcome: "rate-limited" }).outcome, "rate-limited");
  assert.deepEqual(buildRecord({ ...FULL, toolCalls: ["ok_1", "bad name", "山田", 5, null, "x".repeat(80)] }).toolCalls, ["ok_1"]);
  assert.equal(buildRecord({ ...FULL, usage: undefined }).usage, null);
  assert.equal(buildRecord({ ...FULL, usage: { in: null, out: null } }).usage, null);
  assert.deepEqual(buildRecord({ ...FULL, usage: { in: 5, out: -1 } }).usage, { in: 5, out: null });
  assert.deepEqual(buildRecord({ ...FULL, usage: { in: "5", out: 1.5 } }).usage, null);
  assert.equal(buildRecord(null).destination, "external");
  assert.equal(buildRecord({ ...FULL, temperature: NaN }).params.temperature, undefined);
  assert.equal(buildRecord({ ...FULL, modelVersion: "has space\n" }).modelVersion, undefined);
});

test("createRequestLog: 追記・summary・clear。壊れた行は飛ばす。書けない場所でも例外にならない", () => {
  const file = tmp();
  const log = createRequestLog({ file });
  assert.equal(log.summary().count, 0, "まだ無い");
  log.append(FULL);
  log.append({ ...FULL, usage: undefined, outcome: "timeout" });
  log.append({ ...FULL, modelVersion: "m-2026-11", usage: { in: 4, out: null } });
  fs.appendFileSync(file, "{壊れた\n");
  const s = log.summary();
  assert.equal(s.count, 3, "実在する 3 件（壊れた行は数えない）");
  const a = s.byModel.find((m) => m.model === "m-2026");
  assert.deepEqual({ requests: a.requests, tokensIn: a.tokensIn, tokensOut: a.tokensOut, unknownUsage: a.unknownUsage }, { requests: 2, tokensIn: 10, tokensOut: 2, unknownUsage: 1 });
  const b = s.byModel.find((m) => m.model === "m-2026-11");
  assert.deepEqual({ tokensIn: b.tokensIn, tokensOut: b.tokensOut, unknownUsage: b.unknownUsage }, { tokensIn: 4, tokensOut: 0, unknownUsage: 1 }, "片方不明は不明に数える");
  assert.equal(s.recent[0].modelVersion, "m-2026-11", "新しい順");
  assert.deepEqual(log.clear(), { ok: true });
  assert.equal(log.summary().count, 0);
  const bad = createRequestLog({ file: path.join(file, "nope", "x.jsonl") }); // ファイルの下にディレクトリは作れない
  assert.doesNotThrow(() => bad.append(FULL));
});

test("createRequestLog: 上限で 1 世代ローテート。clear は両方消す", () => {
  const file = tmp();
  const log = createRequestLog({ file, maxBytes: 600 });
  for (let i = 0; i < 12; i++) log.append({ ...FULL, sessionId: `s-${i}` });
  assert.ok(fs.existsSync(`${file}.1`), "ローテートした");
  assert.ok(log.summary().count >= 2 && log.summary().count <= 12);
  log.clear();
  assert.equal(fs.existsSync(file) || fs.existsSync(`${file}.1`), false);
});

test("wire.usageOf / modelVersionOf: 数えられた整数だけ。無い・文字列・負・小数・非有限は不明", () => {
  assert.deepEqual(wire.usageOf(3, 4), { in: 3, out: 4 });
  assert.deepEqual(wire.usageOf(0, 0), { in: 0, out: 0 }, "実際の 0 は 0");
  assert.deepEqual(wire.usageOf(3, undefined), { in: 3, out: null });
  for (const bad of [undefined, null, "3", -1, 1.5, NaN, Infinity]) assert.equal(wire.usageOf(bad, bad), undefined, String(bad));
  assert.equal(wire.modelVersionOf("gpt-x-2026"), "gpt-x-2026");
  for (const bad of [undefined, 5, "", "a b", "x".repeat(121)]) assert.equal(wire.modelVersionOf(bad), undefined);
});

test("openai: usage とモデル版を取る（非ストリーム）。無い・壊れた値は付かない・例外なし", () => {
  const ok = openai.normalizeChat({ model: "gpt-x", choices: [{ message: { content: "hi" }, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 3 } });
  assert.deepEqual([ok.usage, ok.modelVersion, ok.text], [{ in: 12, out: 3 }, "gpt-x", "hi"]);
  const none = openai.normalizeChat({ choices: [{ message: { content: "hi" } }] });
  assert.equal("usage" in none, false);
  assert.equal("usage" in openai.normalizeChat({ choices: [{ message: { content: "hi" } }], usage: { prompt_tokens: "12", completion_tokens: -1 } }), false);
  assert.doesNotThrow(() => openai.normalizeChat({ choices: [{ message: { content: "hi" } }], usage: 5, model: {} }));
});

test("openai ストリーム: choices が空の最終チャンクの usage を拾う。届かなければ不明", () => {
  const p = openai.createStreamParser();
  p.push(JSON.stringify({ model: "gpt-x", choices: [{ delta: { content: "he" } }] }));
  p.push(JSON.stringify({ choices: [{ delta: { content: "llo" }, finish_reason: "stop" }] }));
  p.push(JSON.stringify({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 2 } }));
  p.push("[DONE]");
  const r = p.result();
  assert.deepEqual([r.text, r.usage, r.modelVersion], ["hello", { in: 7, out: 2 }, "gpt-x"]);
  const q = openai.createStreamParser();
  q.push(JSON.stringify({ choices: [{ delta: { content: "x" }, finish_reason: "stop" }] }));
  assert.equal("usage" in q.result(), false, "include_usage を要求していないので届かない提供元は不明");
});

test("gemini: usageMetadata と modelVersion を取る（非ストリーム・ストリームは最後の値）", () => {
  const body = (t, u) => ({ modelVersion: "gemini-2.5-flash-002", candidates: [{ content: { parts: [{ text: t }] }, finishReason: "STOP" }], ...(u ? { usageMetadata: u } : {}) });
  const ok = gemini.normalizeChat(body("hi", { promptTokenCount: 7, candidatesTokenCount: 2 }));
  assert.deepEqual([ok.usage, ok.modelVersion], [{ in: 7, out: 2 }, "gemini-2.5-flash-002"]);
  assert.equal("usage" in gemini.normalizeChat(body("hi")), false);
  const p = gemini.createStreamParser();
  p.push(JSON.stringify(body("a", { promptTokenCount: 7, candidatesTokenCount: 1 })));
  p.push(JSON.stringify(body("b", { promptTokenCount: 7, candidatesTokenCount: 5 })));
  const r = p.result();
  assert.deepEqual([r.text, r.usage], ["ab", { in: 7, out: 5 }]);
});
