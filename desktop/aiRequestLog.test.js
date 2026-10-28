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

const { buildEvalRecord, createEvalStore } = require("./aiRequestLog");
const EVAL = { suiteVersion: 1, meta: { provider: "cloud", modelId: "m", modelVersion: "m-2026" }, cases: [{ id: "flip-h", pass: true }, { id: "slice-10th", pass: false }] };

test("buildEvalRecord: 正例 — 件数と一致数は main が数え直す（レンダラの申告を使わない）", () => {
  const r = buildEvalRecord({ ...EVAL, total: 99, passed: 99 });
  assert.deepEqual(r, { suite: "basic", suiteVersion: 1, provider: "cloud", modelId: "m", modelVersion: "m-2026", total: 2, passed: 1, totalLatencyMs: null, cases: [{ id: "flip-h", pass: true, passes: 1, n: 1 }, { id: "slice-10th", pass: false, passes: 0, n: 1 }] });
});

test("buildEvalRecord: 負例 — 不正な id・型・空・巨大・版なし・余計な項目（質問本文など）は保存しない／出さない", () => {
  for (const bad of [
    null, 5, {}, { ...EVAL, cases: [] }, { ...EVAL, cases: "x" }, { ...EVAL, suiteVersion: 0 }, { ...EVAL, suiteVersion: "1" },
    { ...EVAL, cases: [{ id: "BAD ID", pass: true }] }, { ...EVAL, cases: [{ id: "ok", pass: "yes" }] }, { ...EVAL, cases: [null] },
    { ...EVAL, cases: Array.from({ length: 201 }, (_, i) => ({ id: `c${i}`, pass: true })) },
  ]) assert.equal(buildEvalRecord(bad), null, JSON.stringify(bad).slice(0, 60));
  const dirty = buildEvalRecord({ ...EVAL, cases: [{ id: "a", pass: true, text: "山田太郎の質問", args: { x: 1 } }], text: "秘密", meta: { ...EVAL.meta, apiKey: "sk-X" } });
  assert.equal(JSON.stringify(dirty).includes("山田"), false);
  assert.equal(JSON.stringify(dirty).includes("sk-X"), false);
  assert.equal(JSON.stringify(dirty).includes("秘密"), false);
  assert.equal(buildEvalRecord({ ...EVAL, meta: { provider: "bad provider!", modelId: 5 } }).provider, null, "不正な由来は null（不明）");
});

test("createEvalStore: 追記・新しい順の一覧・clear。形の違う行は飛ばす。書けなくても例外にならない", () => {
  const file = tmp();
  const s = createEvalStore({ file });
  assert.deepEqual(s.list(), { ok: true, runs: [] });
  assert.deepEqual(s.append(EVAL), { ok: true });
  assert.deepEqual(s.append({ ...EVAL, meta: { ...EVAL.meta, modelVersion: "m-2026-11" } }), { ok: true });
  fs.appendFileSync(file, '{壊れた\n{"suiteVersion":1,"cases":[{"id":"BAD","pass":true}]}\n');
  const l = s.list();
  assert.equal(l.runs.length, 2, "実在する 2 件（壊れた行・形の違う行は数えない）");
  assert.equal(l.runs[0].modelVersion, "m-2026-11", "新しい順");
  assert.equal(s.append({ cases: [] }).error, "bad-eval");
  assert.equal(createEvalStore({ file: path.join(file, "no", "x.jsonl") }).append(EVAL).ok, false);
  s.clear();
  assert.equal(s.list().runs.length, 0);
});

test("createEvalStore: 上限で 1 世代ローテート", () => {
  const file = tmp();
  const s = createEvalStore({ file, maxBytes: 300 });
  for (let i = 0; i < 8; i++) s.append(EVAL);
  assert.ok(fs.existsSync(`${file}.1`));
  assert.ok(s.list(50).runs.length >= 2);
});

test("summary: モデル別の応答時間 — 手計算の分位数（最近順位法）。失敗行・不明は除く／0 件は null", () => {
  const file = tmp();
  const log = createRequestLog({ file });
  // 10 件: 100..1000 ms。p50 = ⌈5⌉ 番目 = 500、p95 = ⌈9.5⌉=10 番目 = 1000
  for (let i = 1; i <= 10; i++) log.append({ ...FULL, latencyMs: i * 100 });
  log.append({ ...FULL, latencyMs: 99999, outcome: "timeout" }); // 失敗は入らない
  log.append({ ...FULL, latencyMs: undefined }); // 不明は入らない
  // 別モデル: 奇数 3 件（p50 = ⌈1.5⌉=2 番目、p95 = ⌈2.85⌉=3 番目）と、成功 0 件のモデル
  for (const ms of [30, 10, 20]) log.append({ ...FULL, modelVersion: "odd", latencyMs: ms });
  log.append({ ...FULL, modelVersion: "none", outcome: "timeout", latencyMs: 5 });
  const by = (m) => log.summary().byModel.find((x) => x.model === m);
  assert.deepEqual(by("m-2026").latency, { n: 10, p50: 500, p95: 1000 });
  assert.deepEqual(by("odd").latency, { n: 3, p50: 20, p95: 30 });
  assert.equal(by("none").latency, null, "件数 0 は 0 でなく null");
  assert.equal("latencies" in by("odd"), false, "内部の配列は出さない");
});

test("buildEvalRecord: 質問ごとの応答時間 — 許可リスト（負例は項目だけ捨てる）と合計", () => {
  const ok = buildEvalRecord({ ...EVAL, cases: [{ id: "a", pass: true, latencyMs: 1200 }, { id: "b", pass: false, latencyMs: 800 }] });
  assert.deepEqual(ok.cases, [{ id: "a", pass: true, passes: 1, n: 1, latencyMs: 1200 }, { id: "b", pass: false, passes: 0, n: 1, latencyMs: 800 }]);
  assert.equal(ok.totalLatencyMs, 2000);
  for (const bad of [-1, 1.5, "9", null, 60 * 60 * 1000 + 1, NaN]) {
    const r = buildEvalRecord({ ...EVAL, cases: [{ id: "a", pass: true, latencyMs: 100 }, { id: "b", pass: true, latencyMs: bad }] });
    assert.deepEqual(r.cases[1], { id: "b", pass: true, passes: 1, n: 1 }, `不正値 ${String(bad)} は項目だけ捨てる`);
    assert.equal(r.totalLatencyMs, null, "欠けがあれば合計は不明（欠けを 0 として足さない）");
  }
  const old = buildEvalRecord({ ...EVAL, cases: [{ id: "a", pass: true }] });
  assert.equal(old.totalLatencyMs, null, "古い行（項目なし）は読めて、合計は未取得");
});

test("buildEvalRecord: 組と反復の集計 — 許可リスト。pass と矛盾する・範囲外の passes/n・未知の組は保存しない", () => {
  const ok = buildEvalRecord({ ...EVAL, suite: "plugin-pos", cases: [{ id: "a", pass: true, passes: 5, n: 5 }, { id: "b", pass: false, passes: 3, n: 5 }] });
  assert.equal(ok.suite, "plugin-pos");
  assert.deepEqual(ok.cases.map((c) => [c.passes, c.n]), [[5, 5], [3, 5]]);
  assert.equal(ok.passed, 1, "一致数は『k 回すべて合格』の質問数");
  for (const bad of [
    { suite: "other" }, { suite: 1 },
    { cases: [{ id: "a", pass: true, passes: 4, n: 5 }] }, // 全回合格でないのに pass:true
    { cases: [{ id: "a", pass: false, passes: 5, n: 5 }] }, // 全回合格なのに pass:false
    { cases: [{ id: "a", pass: false, passes: 6, n: 5 }] },
    { cases: [{ id: "a", pass: true, passes: 21, n: 21 }] },
    { cases: [{ id: "a", pass: false, passes: 0, n: 0 }] },
    { cases: [{ id: "a", pass: false, passes: "1", n: 5 }] },
    { cases: [{ id: "a", pass: false, n: 5 }] },
  ]) assert.equal(buildEvalRecord({ ...EVAL, ...bad }), null, JSON.stringify(bad).slice(0, 70));
});

test("createEvalStore: 組と集計は書いて読み戻せる。古い行（suite なし）は basic・1 回として読める", () => {
  const file = tmp();
  const s = createEvalStore({ file });
  s.append({ ...EVAL, suite: "plugin-pos", cases: [{ id: "a", pass: false, passes: 3, n: 5 }] });
  fs.appendFileSync(file, JSON.stringify({ ts: "2026-10-01T00:00:00.000Z", suiteVersion: 1, provider: "cloud", modelId: "m", modelVersion: null, total: 1, passed: 1, totalLatencyMs: null, cases: [{ id: "a", pass: true }] }) + "\n");
  const [old, cur] = s.list().runs; // 新しい順（最後に足した古い形式の行が先頭）
  assert.equal(old.suite, "basic");
  assert.deepEqual(old.cases[0], { id: "a", pass: true, passes: 1, n: 1 });
  assert.equal(cur.suite, "plugin-pos");
  assert.deepEqual(cur.cases[0], { id: "a", pass: false, passes: 3, n: 5 });
});
