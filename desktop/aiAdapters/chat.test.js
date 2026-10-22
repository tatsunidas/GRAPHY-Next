// `node --test`。会話（text-to-text・ツール・ストリーミング）の電文。設計: fw/ai-routing-design.md §15
//
// 🚨 ここが固定するのは「組み立てと解釈が意図どおりか」だけ。各社の実 API が受け付けるかは
//    実機で確かめる（接続テスト）。electron を import しない。

const test = require("node:test");
const assert = require("node:assert");
const openai = require("./openai");
const gemini = require("./gemini");

const PUBLIC = { id: "o", kind: "openai", endpoint: "https://api.example.test", models: { "text-to-text": "gpt-x" } };
const AZURE = { id: "az", kind: "azure-openai", endpoint: "https://x.openai.azure.com", models: { "text-to-text": "dep" } };
const GEM = { id: "g", kind: "gemini", endpoint: "https://generativelanguage.googleapis.com", models: { "text-to-text": "gem-x" } };
const LOCAL = { id: "l", kind: "openai", endpoint: "http://127.0.0.1:8080", auth: "none", models: { "text-to-text": "tiny" } };

const TOOLS = [{
  name: "set_window_level", description: "W/L を変える",
  parameters: { $schema: "x", type: "object", additionalProperties: false, properties: { center: { type: "number" }, width: { type: ["number", "null"] } }, required: ["center"] },
}];
const MESSAGES = [
  { role: "system", text: "あなたはアシスタント" },
  { role: "user", text: "W/L を 40/400 に" },
  { role: "assistant", text: "", toolCalls: [{ id: "c1", name: "set_window_level", args: { center: 40, width: 400 }, providerState: { thoughtSignature: "SIG" } }] },
  { role: "tool", toolCallId: "c1", toolName: "set_window_level", text: "ok" },
  { role: "tool", toolCallId: "c2", toolName: "other", text: "ok2" },
];
const body = (b) => JSON.parse(b.body.toString("utf8"));

// ── OpenAI 互換 ───────────────────────────────────────────────────────────

test("openai: text-to-text を扱える", () => {
  assert.equal(openai.supports("text-to-text"), true);
  assert.equal(gemini.supports("text-to-text"), true);
});

test("openai: 履歴・ツール・ツール結果を組む", () => {
  const r = openai.buildChatRequest({ provider: PUBLIC, model: "gpt-x", apiKey: "K", messages: MESSAGES, tools: TOOLS });
  const b = body(r);
  assert.equal(r.path, "/v1/chat/completions");
  assert.equal(b.model, "gpt-x");
  assert.equal(r.headers.Authorization, "Bearer K");
  assert.deepEqual(b.messages.map((m) => m.role), ["system", "user", "assistant", "tool", "tool"]);
  assert.equal(b.messages[2].tool_calls[0].function.arguments, JSON.stringify({ center: 40, width: 400 }));
  assert.equal(b.messages[3].tool_call_id, "c1");
  assert.equal(b.tools[0].function.name, "set_window_level");
  assert.equal("stream" in b, false);
});

test("openai: 画像は data URL で載る／stream は Accept と stream:true", () => {
  const r = openai.buildChatRequest({
    provider: PUBLIC, model: "m", apiKey: "K", stream: true,
    messages: [{ role: "user", text: "これ何", images: [{ base64: "QUJD", mimeType: "image/jpeg" }] }],
  });
  assert.equal(body(r).stream, true);
  assert.equal(r.headers.Accept, "text/event-stream");
  assert.equal(r.streaming, true);
  assert.equal(body(r).messages[0].content[1].image_url.url, "data:image/jpeg;base64,QUJD");
});

test("openai: 🔴 providerOptions で messages / tools / model / stream を上書きできない", () => {
  const r = openai.buildChatRequest({
    provider: PUBLIC, model: "m", apiKey: "K", messages: [{ role: "user", text: "hi" }], tools: TOOLS,
    providerOptions: { messages: [], tools: [], model: "evil", stream: true, top_p: 0.5 },
  });
  const b = body(r);
  assert.equal(b.model, "m");
  assert.equal(b.messages.length, 1);
  assert.equal(b.tools.length, 1);
  assert.equal("stream" in b, false);
  assert.equal(b.top_p, 0.5);
});

test("openai: Azure はモデルを body に入れずパスへ、toolMode:none ならツールを送らない", () => {
  const r = openai.buildChatRequest({ provider: AZURE, model: "dep", apiKey: "K", messages: [{ role: "user", text: "x" }] });
  assert.match(r.path, /^\/openai\/deployments\/dep\/chat\/completions\?api-version=/);
  assert.equal("model" in body(r), false);
  const n = openai.buildChatRequest({ provider: { ...PUBLIC, toolMode: "none" }, model: "m", apiKey: "K", messages: [{ role: "user", text: "x" }], tools: TOOLS });
  assert.equal("tools" in body(n), false);
});

test("openai: 鍵なし(auth:none)は認証ヘッダを付けない（正例）／鍵ありは付く（負例）", () => {
  const none = openai.buildChatRequest({ provider: LOCAL, model: "tiny", messages: [{ role: "user", text: "x" }] });
  assert.deepEqual(Object.keys(none.headers).map((k) => k.toLowerCase()).sort(), ["content-type"]);
  const keyed = openai.buildChatRequest({ provider: PUBLIC, model: "m", apiKey: "K", messages: [{ role: "user", text: "x" }] });
  assert.ok("Authorization" in keyed.headers);
});

test("openai: paths の上書きが text-to-text に効く", () => {
  const r = openai.buildChatRequest({ provider: { ...PUBLIC, paths: { "text-to-text": "/api/v1/chat/completions" } }, model: "m", apiKey: "K", messages: [{ role: "user", text: "x" }] });
  assert.equal(r.path, "/api/v1/chat/completions");
});

test("openai: 接続テスト用の buildRequest(text-to-text) は画像を持たない", () => {
  const r = openai.buildRequest({ capability: "text-to-text", provider: PUBLIC, model: "m", apiKey: "K", prompt: "Reply with OK." });
  assert.equal(body(r).messages[0].content, "Reply with OK.");
});

test("openai: 応答の文章とツール呼び出し。引数が壊れていれば argsError（実行させない目印）", () => {
  const n = openai.normalizeChat({
    choices: [{ finish_reason: "tool_calls", message: { content: null, tool_calls: [
      { id: "a", type: "function", function: { name: "f", arguments: '{"x":1}' } },
      { id: "b", type: "function", function: { name: "g", arguments: "{not json" } },
      { id: "c", type: "function", function: { name: "h", arguments: "[1]" } },
    ] } }],
  });
  assert.equal(n.text, undefined);
  assert.deepEqual(n.toolCalls[0], { id: "a", name: "f", args: { x: 1 } });
  assert.equal(n.toolCalls[1].argsError, "arguments-not-json");
  assert.deepEqual(n.toolCalls[1].args, {});
  assert.equal(n.toolCalls[2].argsError, "arguments-not-an-object");
  assert.equal(n.finishReason, "tool_calls");
});

test("openai: 壊れた応答で例外を投げない／content_filter は blockReason", () => {
  for (const bad of [null, undefined, 1, "x", {}, { choices: [] }, { choices: [null] }, { choices: [{ message: 5 }] }]) {
    assert.doesNotThrow(() => openai.normalizeChat(bad));
  }
  const n = openai.normalizeChat({ choices: [{ finish_reason: "content_filter", message: { content: "" } }] });
  assert.equal(n.blockReason, "content_filter");
});

test("openai: ストリームの断片を連結した結果が、非ストリームの正規化と一致する", () => {
  const chunks = [
    { choices: [{ delta: { content: "こん" } }] },
    { choices: [{ delta: { content: "にちは" } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "a", function: { name: "set_", arguments: '{"cen' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "window_level", arguments: 'ter":40}' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 1, id: "b", function: { name: "g", arguments: "{}" } }] } }] },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
  ];
  const p = openai.createStreamParser();
  const deltas = [];
  for (const c of chunks) deltas.push(...p.push(JSON.stringify(c)));
  p.push("[DONE]");
  assert.deepEqual(deltas.map((d) => d.text), ["こん", "にちは"]);
  const whole = openai.normalizeChat({ choices: [{ finish_reason: "tool_calls", message: { content: "こんにちは", tool_calls: [
    { id: "a", function: { name: "set_window_level", arguments: '{"center":40}' } },
    { id: "b", function: { name: "g", arguments: "{}" } },
  ] } }] });
  assert.deepEqual(p.result(), whole);
});

test("openai: ストリームに壊れたイベントが混ざっても落ちない", () => {
  const p = openai.createStreamParser();
  assert.deepEqual(p.push("{broken"), []);
  assert.deepEqual(p.push(JSON.stringify({ choices: [{ delta: { content: "a" } }] })), [{ type: "delta", text: "a" }]);
});

// ── Gemini ────────────────────────────────────────────────────────────────

test("gemini: JSON Schema を Gemini の Schema に直す（受けないキーを落とし、null 許容を nullable に）", () => {
  const s = gemini.toGeminiSchema(TOOLS[0].parameters);
  assert.equal("$schema" in s, false);
  assert.equal("additionalProperties" in s, false);
  assert.equal(s.properties.width.type, "number");
  assert.equal(s.properties.width.nullable, true);
  assert.deepEqual(s.required, ["center"]);
  assert.deepEqual(gemini.toGeminiSchema(undefined), { type: "object", properties: {} });
});

test("gemini: 履歴・systemInstruction・関数宣言を組み、思考署名を返し、連続する tool 結果を 1 つにまとめる", () => {
  const r = gemini.buildChatRequest({ provider: GEM, model: "gem-x", apiKey: "K", messages: MESSAGES, tools: TOOLS });
  const b = body(r);
  assert.equal(r.path, "/v1beta/models/gem-x:generateContent");
  assert.equal(r.headers["x-goog-api-key"], "K");
  assert.equal(b.systemInstruction.parts[0].text, "あなたはアシスタント");
  assert.deepEqual(b.contents.map((c) => c.role), ["user", "model", "user"]);
  assert.equal(b.contents[1].parts[0].thoughtSignature, "SIG");
  assert.equal(b.contents[2].parts.length, 2, "tool 結果 2 件は 1 つの user にまとまる");
  assert.equal(b.contents[2].parts[0].functionResponse.name, "set_window_level");
  assert.equal(b.tools[0].functionDeclarations[0].name, "set_window_level");
});

test("gemini: stream は :streamGenerateContent?alt=sse。paths を上書きしていれば非ストリーム", () => {
  const s = gemini.buildChatRequest({ provider: GEM, model: "m", apiKey: "K", stream: true, messages: [{ role: "user", text: "x" }] });
  assert.equal(s.path, "/v1beta/models/m:streamGenerateContent?alt=sse");
  assert.equal(s.streaming, true);
  const o = gemini.buildChatRequest({ provider: { ...GEM, paths: { "text-to-text": "/v1beta/openai/chat/completions" } }, model: "m", apiKey: "K", stream: true, messages: [{ role: "user", text: "x" }] });
  assert.equal(o.path, "/v1beta/openai/chat/completions");
  assert.equal(o.streaming, false);
});

test("gemini: 応答の文章・関数呼び出し(ID を採番・署名を保持)。壊れた応答で落ちない", () => {
  let n = 0;
  const r = gemini.normalizeChat({
    candidates: [{ finishReason: "STOP", content: { parts: [
      { text: "了解" },
      { functionCall: { name: "f", args: { a: 1 } }, thoughtSignature: "S" },
      { text: "思考", thought: true },
    ] } }],
  }, { makeId: () => `id${++n}` });
  assert.equal(r.text, "了解");
  assert.deepEqual(r.toolCalls, [{ id: "id1", name: "f", args: { a: 1 }, providerState: { thoughtSignature: "S" } }]);
  for (const bad of [null, 3, {}, { candidates: [] }, { candidates: [{ content: 4 }] }]) {
    assert.doesNotThrow(() => gemini.normalizeChat(bad));
  }
  assert.equal(gemini.normalizeChat({ promptFeedback: { blockReason: "SAFETY" } }).blockReason, "SAFETY");
});

test("gemini: ストリームのチャンクを連結した結果が、非ストリームの正規化と一致する", () => {
  const mk = () => { let n = 0; return () => `id${++n}`; };
  const parts1 = [{ text: "こん" }];
  const parts2 = [{ text: "にちは" }, { functionCall: { name: "f", args: { a: 1 } } }];
  const p = gemini.createStreamParser({ makeId: mk() });
  const d = [
    ...p.push(JSON.stringify({ candidates: [{ content: { parts: parts1 } }] })),
    ...p.push(JSON.stringify({ candidates: [{ finishReason: "STOP", content: { parts: parts2 } }] })),
  ];
  assert.deepEqual(d.map((x) => x.text), ["こん", "にちは"]);
  const whole = gemini.normalizeChat({ candidates: [{ finishReason: "STOP", content: { parts: [...parts1, ...parts2] } }] }, { makeId: mk() });
  assert.deepEqual(p.result(), whole);
});
