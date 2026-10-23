// `node --test`。設計: fw/ai-routing-design.md §7（合格条件）
//
// 🔑 **この機能の合格条件は「設定で提供元を切り替えると、プラグインを 1 行も直さずに
// そちらへ送られること」。** ここではネットワークへ出る前までを確かめる
// （実際の送信は鍵と課金が要るので実機で見る）。
//
// 🔴 electron を直接 import しない。secretStore が触るので、モジュールの読み込みを横取りする
//    （CI の Desktop ジョブは npm install しないため。2026-09-24 に同じことで CI を赤くした）。

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

// ── electron スタブ（safeStorage の往復だけ真似る） ─────────────────────────
let encryptionAvailable = true;
const electronStub = {
  safeStorage: {
    isEncryptionAvailable: () => encryptionAvailable,
    encryptString: (s) => Buffer.from(`ENC:${s}`, "utf8"),
    decryptString: (b) => {
      const s = b.toString("utf8");
      if (!s.startsWith("ENC:")) throw new Error("復号できない");
      return s.slice(4);
    },
  },
};
const originalLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === "electron") return electronStub;
  return originalLoad.call(this, request, ...rest);
};
test.after(() => {
  Module._load = originalLoad;
});

const GEMINI_A = {
  id: "prov-a", label: "提供元 A", kind: "gemini", endpoint: "https://a.example.test",
  models: { "image-to-image": "a-img", "image-to-text": "a-txt" },
};
const GEMINI_B = {
  id: "prov-b", label: "提供元 B", kind: "gemini", endpoint: "https://b.example.test",
  models: { "image-to-text": "b-txt" }, // 🔑 画像生成は扱えない
};

/** まっさらな構成で読み直す（＝アプリ再起動の代用）。 */
function freshGateway(dir, config) {
  if (config) fs.writeFileSync(path.join(dir, "ai-providers.json"), JSON.stringify(config));
  for (const m of ["./aiGateway", "./aiProviders", "./secretStore"]) {
    delete require.cache[require.resolve(m)];
  }
  const secretStore = require("./secretStore");
  const aiProviders = require("./aiProviders");
  const aiGateway = require("./aiGateway");
  secretStore.init(dir);
  aiProviders.init(dir);
  return { secretStore, aiProviders, aiGateway };
}

function freshDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "graphy-ai-gateway-"));
}

const REQ = { prompt: "指示", imageBase64: "aGVsbG8=", mimeType: "image/png" };

// ── 用途 → 宛先の解決 ─────────────────────────────────────────────────────

test("用途から宛先とモデルが引ける", () => {
  const dir = freshDir();
  const { aiGateway } = freshGateway(dir, { providers: [GEMINI_A] });
  const r = aiGateway.resolveCapability("image-to-image");
  assert.equal(r.ok, true);
  assert.equal(r.providerId, "prov-a");
  assert.equal(r.model, "a-img");
  assert.equal(r.endpointHost, "a.example.test");
  assert.equal(r.hasApiKey, false, "鍵を入れていないので false");
});

test("🔑 合格条件: 既定を切り替えると宛先が変わる", () => {
  const dir = freshDir();
  const { aiGateway, aiProviders } = freshGateway(dir, {
    providers: [GEMINI_A, GEMINI_B],
    defaults: { "image-to-text": "prov-a" },
  });
  assert.equal(aiGateway.resolveCapability("image-to-text").endpointHost, "a.example.test");

  // 設定画面がやることと同じ（既定だけ差し替えて保存）。
  const saved = aiProviders.save({ providers: [GEMINI_A, GEMINI_B], defaults: { "image-to-text": "prov-b" } });
  assert.equal(saved.ok, true);

  const after = aiGateway.resolveCapability("image-to-text");
  assert.equal(after.providerId, "prov-b");
  assert.equal(after.endpointHost, "b.example.test");
  assert.equal(after.model, "b-txt");
});

test("🔴 扱えない用途は、その提供元へ振らない", () => {
  const dir = freshDir();
  // 画像生成を扱えない提供元しか居ない。
  const { aiGateway } = freshGateway(dir, { providers: [GEMINI_B] });
  assert.equal(aiGateway.resolveCapability("image-to-image").error, "no-provider-for-capability");
  assert.equal(aiGateway.resolveCapability("image-to-text").ok, true);
});

test("知らない用途は unsupported-capability", () => {
  const dir = freshDir();
  const { aiGateway } = freshGateway(dir, { providers: [GEMINI_A] });
  assert.equal(aiGateway.resolveCapability("chat").error, "unsupported-capability");
});

// ── 送信前に落ちるべきもの（HTTP へ出ない） ────────────────────────────────

test("🔴 鍵が無ければ送らない", async () => {
  const dir = freshDir();
  const { aiGateway } = freshGateway(dir, { providers: [GEMINI_A] });
  const r = await aiGateway.generate({ ...REQ, capability: "image-to-image" });
  assert.equal(r.ok, false);
  assert.equal(r.error, "no-api-key");
});

test("🔴 扱えない用途は、鍵があっても送らない（課金を発生させない）", async () => {
  const dir = freshDir();
  const { aiGateway, secretStore } = freshGateway(dir, { providers: [GEMINI_B] });
  secretStore.setSecret("ai.provider.prov-b.apiKey", "KEY");
  const r = await aiGateway.generate({ ...REQ, capability: "image-to-image" });
  assert.equal(r.ok, false);
  assert.equal(r.error, "no-provider-for-capability");
  assert.equal(r.kind, "capability");
});

test("🔑 出荷時の Gemini は旧名の鍵でも通る（版を上げて鍵が消えたように見えない）", async () => {
  const dir = freshDir();
  // 構成ファイルを置かない＝出荷時の gemini-public。
  const { aiGateway, secretStore } = freshGateway(dir, null);
  assert.equal(aiGateway.resolveCapability("image-to-text").hasApiKey, false);

  secretStore.setSecret("ai.gemini.apiKey", "OLD-KEY");
  assert.equal(aiGateway.resolveCapability("image-to-text").hasApiKey, true, "旧名の鍵を見ること");
});

test("提供元ごとに鍵が分かれている（1 つの鍵を共用しない）", () => {
  const dir = freshDir();
  const { aiGateway, secretStore } = freshGateway(dir, {
    providers: [GEMINI_A, GEMINI_B],
    defaults: { "image-to-text": "prov-a" },
  });
  secretStore.setSecret("ai.provider.prov-a.apiKey", "KEY-A");
  assert.equal(aiGateway.resolveCapability("image-to-text").hasApiKey, true);

  aiGateway.resolveCapability("image-to-text"); // 解決を通す
  const { aiGateway: g2 } = freshGateway(dir, {
    providers: [GEMINI_A, GEMINI_B],
    defaults: { "image-to-text": "prov-b" },
  });
  // B には鍵を入れていないので false。A の鍵は使われない。
  assert.equal(g2.resolveCapability("image-to-text").hasApiKey, false);
});

test("指示や画像が空なら送らない", async () => {
  const dir = freshDir();
  const { aiGateway, secretStore } = freshGateway(dir, { providers: [GEMINI_A] });
  secretStore.setSecret("ai.provider.prov-a.apiKey", "KEY");
  assert.equal((await aiGateway.generate({ ...REQ, prompt: "", capability: "image-to-image" })).error, "empty-prompt");
  assert.equal((await aiGateway.generate({ ...REQ, imageBase64: "", capability: "image-to-image" })).error, "empty-image");
  assert.equal((await aiGateway.generate(null)).error, "empty-request");
});

test("🔴 モデル名の形を検査する（URL のパスに入るため）", async () => {
  const dir = freshDir();
  const { aiGateway, secretStore } = freshGateway(dir, {
    providers: [{ ...GEMINI_A, models: { "image-to-image": "a/../../evil" } }],
  });
  secretStore.setSecret("ai.provider.prov-a.apiKey", "KEY");
  const r = await aiGateway.generate({ ...REQ, capability: "image-to-image" });
  assert.equal(r.error, "invalid-model");
});

// ── 段 4: 提供元の種類をまたぐ ─────────────────────────────────────────────
//
// 🔑 **ここが「一社に縛られない」の実体。** 同じ用途を、別の会社の別の電文で送れること。
// 🚨 ただし**相手の API が受け付けるかは実機で確かめる**（fw/ai-routing-design.md §12）。

const OPENAI = {
  id: "oa", label: "OpenAI", kind: "openai", endpoint: "https://api.openai.test",
  models: { "image-to-image": "gpt-image-1", "image-to-text": "gpt-4o-mini" },
};
const AZURE = {
  id: "az", label: "院内 Azure", kind: "azure-openai", endpoint: "https://hosp.openai.azure.test",
  models: { "image-to-text": "my-deployment" },
};

test("🔑 gemini と openai を並べ、用途ごとに別の会社へ振れる", () => {
  const dir = freshDir();
  const { aiGateway } = freshGateway(dir, {
    providers: [GEMINI_A, OPENAI],
    defaults: { "image-to-image": "oa", "image-to-text": "prov-a" },
  });
  const i2i = aiGateway.resolveCapability("image-to-image");
  assert.equal(i2i.kind, "openai");
  assert.equal(i2i.endpointHost, "api.openai.test");
  assert.equal(i2i.model, "gpt-image-1");

  const i2t = aiGateway.resolveCapability("image-to-text");
  assert.equal(i2t.kind, "gemini");
  assert.equal(i2t.endpointHost, "a.example.test");
});

test("🔑 自院の Azure エンドポイントへ振れる（公開 API と同じ kind の実装で）", () => {
  const dir = freshDir();
  const { aiGateway } = freshGateway(dir, {
    providers: [AZURE],
    defaults: { "image-to-text": "az" },
  });
  const r = aiGateway.resolveCapability("image-to-text");
  assert.equal(r.ok, true);
  assert.equal(r.kind, "azure-openai");
  assert.equal(r.endpointHost, "hosp.openai.azure.test");
  // Azure は画像生成のデプロイを置いていない構成なので、そちらは振らない。
  assert.equal(aiGateway.resolveCapability("image-to-image").error, "no-provider-for-capability");
});

test("🔴 openai の提供元へ、用途無しの古い呼び出しは通さない", async () => {
  const dir = freshDir();
  const { aiGateway, secretStore } = freshGateway(dir, {
    providers: [OPENAI], defaults: { "image-to-image": "oa" },
  });
  secretStore.setSecret("ai.provider.oa.apiKey", "KEY");
  // capability 無し＝0.3.0 のプラグイン。Gemini の語彙を openai で解釈すると意味が合わない。
  const r = await aiGateway.generate({ ...REQ, model: "gpt-image-1" });
  assert.equal(r.ok, false);
  assert.equal(r.error, "unsupported-capability");
});

// ── 段 5b: 設定が電文と宛先に効く ──────────────────────────────────────────
//
// 🔑 **送出を差し替えて、実際に組まれた要求を見る。** ここまでの検査は「組み立て」を
// 単体で見ていたが、提供元の設定が**解決 → 組み立て → 送出**を通って効いているかは
// ここでしか確かめられない。🔴 ネットワークには 1 バイトも出さない。

/** 送出を横取りして、渡された引数を記録する。 */
function stubPost(dir, config, reply) {
  const g = freshGateway(dir, config);
  const aiHttp = require("./aiHttp");
  const calls = [];
  const original = aiHttp.post;
  aiHttp.post = async (target, path, headers, body) => {
    calls.push({ target, path, headers, body });
    return reply || { statusCode: 200, json: { candidates: [{ content: { parts: [{ text: "OK" }] } }] }, text: "" };
  };
  return { ...g, calls, restore: () => { aiHttp.post = original; } };
}

test("🔑 ポートが宛先に届く（以前は host にポート込みで渡していて名前解決で落ちていた）", async () => {
  const dir = freshDir();
  const s = stubPost(dir, {
    providers: [{ id: "h", kind: "gemini", endpoint: "https://ai.hosp.local:8443",
                  models: { "image-to-text": "m" } }],
  });
  try {
    s.secretStore.setSecret("ai.provider.h.apiKey", "KEY");
    const r = await s.aiGateway.generate({ ...REQ, capability: "image-to-text" });
    assert.equal(r.ok, true);
    assert.deepEqual(
      { hostname: s.calls[0].target.hostname, port: s.calls[0].target.port, plaintext: s.calls[0].target.plaintext },
      { hostname: "ai.hosp.local", port: 8443, plaintext: false },
    );
    assert.equal(r.provenance.endpointHost, "ai.hosp.local:8443", "由来にもポートを残す");
  } finally { s.restore(); }
});

test("🔑 院内の平文 http へ送れる（そして平文だと申告する）", async () => {
  const dir = freshDir();
  const s = stubPost(dir, {
    providers: [{ id: "ollama", kind: "openai", endpoint: "http://192.168.1.9:11434",
                  models: { "image-to-text": "llava" } }],
  }, { statusCode: 200, json: { choices: [{ message: { content: "OK" } }] }, text: "" });
  try {
    s.secretStore.setSecret("ai.provider.ollama.apiKey", "KEY");
    const r = await s.aiGateway.generate({ ...REQ, capability: "image-to-text" });
    assert.equal(r.ok, true);
    assert.equal(s.calls[0].target.plaintext, true);
    assert.equal(s.calls[0].target.port, 11434);
    assert.equal(r.provenance.plaintext, true, "🔴 平文で出したことを由来に残す");
    assert.equal(s.aiGateway.resolveCapability("image-to-text").plaintext, true, "画面が警告を出せる");
  } finally { s.restore(); }
});

test("🔑 認証ヘッダとパスの上書きが送出まで届く", async () => {
  const dir = freshDir();
  const s = stubPost(dir, {
    providers: [{ id: "r", kind: "openai", endpoint: "https://openrouter.test",
                  auth: { header: "x-api-key", prefix: "" },
                  paths: { "image-to-text": "/api/v1/chat/completions" },
                  models: { "image-to-text": "openai/gpt-4o" } }],
  }, { statusCode: 200, json: { choices: [{ message: { content: "OK" } }] }, text: "" });
  try {
    s.secretStore.setSecret("ai.provider.r.apiKey", "KEY");
    const r = await s.aiGateway.generate({ ...REQ, capability: "image-to-text" });
    assert.equal(r.ok, true, `実際: ${JSON.stringify(r)}`);
    assert.equal(s.calls[0].path, "/api/v1/chat/completions");
    assert.equal(s.calls[0].headers["x-api-key"], "KEY");
    assert.equal(s.calls[0].headers.Authorization, undefined);
  } finally { s.restore(); }
});

test("🔑 body に入るモデル名はスラッシュを許す（OpenRouter 形式が弾かれていた）", async () => {
  const dir = freshDir();
  const s = stubPost(dir, {
    providers: [{ id: "r", kind: "openai", endpoint: "https://openrouter.test",
                  models: { "image-to-text": "anthropic/claude-sonnet-4" } }],
  }, { statusCode: 200, json: { choices: [{ message: { content: "OK" } }] }, text: "" });
  try {
    s.secretStore.setSecret("ai.provider.r.apiKey", "KEY");
    const r = await s.aiGateway.generate({ ...REQ, capability: "image-to-text" });
    assert.equal(r.ok, true, "以前は invalid-model で送れなかった");
    assert.equal(JSON.parse(s.calls[0].body.toString("utf8")).model, "anthropic/claude-sonnet-4");
  } finally { s.restore(); }
});

test("🔴 パスに入るモデル名はスラッシュを許さない（パス・インジェクション）", async () => {
  const dir = freshDir();
  const s = stubPost(dir, {
    providers: [{ id: "az", kind: "azure-openai", endpoint: "https://h.test",
                  models: { "image-to-text": "a/../../evil" } }],
  });
  try {
    s.secretStore.setSecret("ai.provider.az.apiKey", "KEY");
    const r = await s.aiGateway.generate({ ...REQ, capability: "image-to-text" });
    assert.equal(r.error, "invalid-model");
    assert.equal(s.calls.length, 0, "送っていないこと");
  } finally { s.restore(); }
});

// ── apiVersion の優先順位 ─────────────────────────────────────────────────

test("🔑 提供元の apiVersion が、プラグインの指定より強い（宛先は本体が決める）", async () => {
  const dir = freshDir();
  const s = stubPost(dir, {
    providers: [{ id: "g", kind: "gemini", endpoint: "https://g.test", apiVersion: "v1",
                  models: { "image-to-text": "m" } }],
  });
  try {
    s.secretStore.setSecret("ai.provider.g.apiKey", "KEY");
    await s.aiGateway.generate({ ...REQ, capability: "image-to-text", apiVersion: "v1beta" });
    assert.match(s.calls[0].path, /^\/v1\/models\/m:generateContent$/);
  } finally { s.restore(); }
});

test("🔴 プラグインの apiVersion を Gemini 以外へ渡さない（Azure で 404 になる）", async () => {
  const dir = freshDir();
  const s = stubPost(dir, {
    providers: [{ id: "az", kind: "azure-openai", endpoint: "https://h.test",
                  models: { "image-to-text": "dep" } }],
  }, { statusCode: 200, json: { choices: [{ message: { content: "OK" } }] }, text: "" });
  try {
    s.secretStore.setSecret("ai.provider.az.apiKey", "KEY");
    // Gemini の語彙をそのまま渡してくるプラグイン。
    await s.aiGateway.generate({ ...REQ, capability: "image-to-text", apiVersion: "v1beta" });
    // 黙って無視し、Azure の既定へ落ちること（エラーにはしない＝0.3.0 のプラグインを止めない）。
    assert.match(s.calls[0].path, /\?api-version=2024-10-21$/);
  } finally { s.restore(); }
});

test("提供元の apiVersion は保存時に形を検査済み（.. を通さない）", () => {
  const dir = freshDir();
  const { aiProviders } = freshGateway(dir, null);
  assert.equal(aiProviders.save({
    providers: [{ id: "g", kind: "gemini", endpoint: "https://g.test",
                  apiVersion: "v1../..", models: { "image-to-text": "m" } }],
  }).ok, false);
});

// ── 空の応答を成功にしない ────────────────────────────────────────────────

test("🔴 200 でも画像も文章も取れなければ失敗にする（設定の誤りが成功に見える経路）", async () => {
  const dir = freshDir();
  const s = stubPost(dir, { providers: [GEMINI_A] }, { statusCode: 200, json: { unexpected: true }, text: "" });
  try {
    s.secretStore.setSecret("ai.provider.prov-a.apiKey", "KEY");
    const r = await s.aiGateway.generate({ ...REQ, capability: "image-to-text" });
    assert.equal(r.ok, false);
    assert.equal(r.error, "empty-response");
    assert.deepEqual(r.data, { unexpected: true }, "生の応答は診断のために返す");
  } finally { s.restore(); }
});

test("拒否された理由が取れているなら成功として扱う（「返らなかった」とは違う）", async () => {
  const dir = freshDir();
  const s = stubPost(dir, { providers: [GEMINI_A] },
    { statusCode: 200, json: { promptFeedback: { blockReason: "SAFETY" } }, text: "" });
  try {
    s.secretStore.setSecret("ai.provider.prov-a.apiKey", "KEY");
    const r = await s.aiGateway.generate({ ...REQ, capability: "image-to-text" });
    assert.equal(r.ok, true);
    assert.equal(r.blockReason, "SAFETY");
  } finally { s.restore(); }
});

// ── 鍵の伏せ方 ────────────────────────────────────────────────────────────

test("🔴 エラー本文に鍵が混ざっても外へ出さない（短い鍵でも）", async () => {
  for (const key of ["sk-verylongkey1234567890", "ab"]) {
    const dir = freshDir();
    const s = stubPost(dir, { providers: [GEMINI_A] },
      { statusCode: 400, json: { error: { message: `bad request with key=${key} and sk-otherleak123456` } }, text: "" });
    try {
      s.secretStore.setSecret("ai.provider.prov-a.apiKey", key);
      const r = await s.aiGateway.generate({ ...REQ, capability: "image-to-text" });
      assert.equal(r.ok, false);
      assert.equal(JSON.stringify(r).includes(key), false, `鍵が出ている: ${key}`);
      assert.equal(JSON.stringify(r).includes("sk-otherleak"), false, "形だけで消せること");
    } finally { s.restore(); }
  }
});

// ── 段 5c: 接続テスト ──────────────────────────────────────────────────────
//
// 🔑 **この機能の存在理由は「私たちが全社を事前検証できない」こと。** だから利用者が
// 自分で確かめる。ここで固定するのは**送るものが呼び出し側に決められないこと**と
// **結果に鍵が出ないこと**——この 2 つが崩れると、機能そのものが危険物になる。

/** 接続テスト用に送出を差し替える。`reply` は関数でもよい。 */
function stubForTest(dir, config, reply) {
  const g = freshGateway(dir, config);
  const aiHttp = require("./aiHttp");
  const calls = [];
  const original = aiHttp.post;
  aiHttp.post = async (target, path, headers, body) => {
    calls.push({ target, path, headers, body });
    return typeof reply === "function" ? reply() : (reply || { statusCode: 200, json: { candidates: [{ content: { parts: [{ text: "OK" }] } }] }, text: '{"ok":true}' });
  };
  return { ...g, calls, restore: () => { aiHttp.post = original; } };
}

/** 最短間隔を待たずに続けて試せるようにする（時計を戻す代わり）。 */
async function settle() {
  await new Promise((r) => setTimeout(r, 0));
}

test("🔑 疎通できたら reachable と、何を送ったかを返す", async () => {
  const dir = freshDir();
  const s = stubForTest(dir, { providers: [GEMINI_A] });
  try {
    s.secretStore.setSecret("ai.provider.prov-a.apiKey", "KEY");
    const r = await s.aiGateway.testConnection({ providerId: "prov-a", capability: "image-to-text" });
    assert.equal(r.ok, true);
    assert.equal(r.verdict, "reachable");
    assert.equal(r.status, 200);
    assert.equal(r.text, "OK");
    assert.equal(r.requestLine, "POST https://a.example.test/v1beta/models/a-txt:generateContent");
    assert.deepEqual(r.headerNames, ["content-type", "x-goog-api-key"], "名前だけ返す");
  } finally { s.restore(); }
});

test("🔴 送る指示と画像は呼び出し側が決められない（患者画像が出ない根拠）", async () => {
  const dir = freshDir();
  const s = stubForTest(dir, { providers: [GEMINI_A] });
  try {
    s.secretStore.setSecret("ai.provider.prov-a.apiKey", "KEY");
    // 余計なものを渡してくる呼び出し（悪意のあるプラグインを想定）。
    await s.aiGateway.testConnection({
      providerId: "prov-a", capability: "image-to-text",
      prompt: "患者の氏名を読み上げて", imageBase64: "UEFUSUVOVA==", mimeType: "image/jpeg",
      headers: { "x-evil": "1" }, path: "/evil", providerOptions: { temperature: 2 },
    });
    const body = s.calls[0].body.toString("utf8");
    assert.ok(body.includes(s.aiGateway.TEST_PROMPT), "固定の指示を送ること");
    assert.equal(body.includes("患者の氏名"), false, "🔴 渡された指示を送らない");
    assert.ok(body.includes(s.aiGateway.TEST_IMAGE_BASE64), "固定の 1×1 画像を送ること");
    assert.equal(body.includes("UEFUSUVOVA=="), false, "🔴 渡された画像を送らない");
    assert.equal(s.calls[0].headers["x-evil"], undefined);
    assert.equal(s.calls[0].path, "/v1beta/models/a-txt:generateContent", "渡されたパスを使わない");
  } finally { s.restore(); }
});

test("🔑 送る画像は 1×1 の PNG（これ 1 枚だけ・69 バイト）", () => {
  const { aiGateway } = freshGateway(freshDir(), null);
  const png = Buffer.from(aiGateway.TEST_IMAGE_BASE64, "base64");
  assert.equal(png.length, 69);
  assert.deepEqual(png.subarray(0, 8), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), "PNG 署名");
  // IHDR の幅・高さ（8 バイト目から）。
  assert.equal(png.readUInt32BE(16), 1, "幅 1");
  assert.equal(png.readUInt32BE(20), 1, "高さ 1");
});

test("🔴 結果に鍵が含まれない（相手が本文へ反射しても・短い鍵でも）", async () => {
  for (const key of ["sk-TESTKEY1234567890", "ab"]) {
    const dir = freshDir();
    const s = stubForTest(dir, { providers: [GEMINI_A] }, {
      statusCode: 401,
      json: { error: { message: `invalid key: ${key}` } },
      text: `{"error":{"message":"invalid key: ${key}","echo":"Bearer ${key}"}}`,
    });
    try {
      s.secretStore.setSecret("ai.provider.prov-a.apiKey", key);
      const r = await s.aiGateway.testConnection({ providerId: "prov-a", capability: "image-to-text" });
      assert.equal(r.verdict, "auth-failed");
      assert.equal(JSON.stringify(r).includes(key), false, `鍵が出ている: ${key}`);
    } finally { s.restore(); }
    await settle();
  }
});

test("🔑 HTTP の状態を「何を直せばよいか」へ写す", async () => {
  const map = [[401, "auth-failed"], [403, "auth-failed"], [404, "not-found"], [400, "bad-request"],
               [429, "rate-limited"], [500, "server-error"], [418, "http-error"]];
  for (const [status, verdict] of map) {
    const dir = freshDir();
    const s = stubForTest(dir, { providers: [GEMINI_A] }, { statusCode: status, json: null, text: "boom" });
    try {
      s.secretStore.setSecret("ai.provider.prov-a.apiKey", "KEY");
      const r = await s.aiGateway.testConnection({ providerId: "prov-a", capability: "image-to-text" });
      assert.equal(r.verdict, verdict, `${status} → ${verdict} / 実際: ${r.verdict}`);
      assert.equal(r.ok, false);
    } finally { s.restore(); }
  }
});

test("🔑 つながらない理由も分ける（宛先か・証明書か・遅いか）", async () => {
  const map = [["getaddrinfo ENOTFOUND x.test", "network"], ["connect ECONNREFUSED 1.2.3.4:443", "network"],
               ["タイムアウト(120000 ms)", "timeout"], ["SELF_SIGNED_CERT_IN_CHAIN", "tls"]];
  for (const [message, verdict] of map) {
    const dir = freshDir();
    const s = stubForTest(dir, { providers: [GEMINI_A] }, () => { throw new Error(message); });
    try {
      s.secretStore.setSecret("ai.provider.prov-a.apiKey", "KEY");
      const r = await s.aiGateway.testConnection({ providerId: "prov-a", capability: "image-to-text" });
      assert.equal(r.verdict, verdict, `${message} → ${verdict} / 実際: ${r.verdict}`);
      assert.ok(r.requestLine, "どこへ送ろうとしたかは返す");
    } finally { s.restore(); }
  }
});

test("🔴 200 だが読めない＝別の API を指している（paths の設定間違い）", async () => {
  const dir = freshDir();
  const s = stubForTest(dir, { providers: [GEMINI_A] }, { statusCode: 200, json: { hello: "world" }, text: '{"hello":"world"}' });
  try {
    s.secretStore.setSecret("ai.provider.prov-a.apiKey", "KEY");
    const r = await s.aiGateway.testConnection({ providerId: "prov-a", capability: "image-to-text" });
    assert.equal(r.ok, false);
    assert.equal(r.verdict, "unreadable-response");
    assert.ok(r.bodyPreview.includes("hello"), "何が返ったかを見せる（診断に要る）");
  } finally { s.restore(); }
});

test("🔴 鍵が無ければ送らない／扱えない用途なら送らない", async () => {
  const dir = freshDir();
  const s = stubForTest(dir, { providers: [GEMINI_A, GEMINI_B] });
  try {
    assert.equal((await s.aiGateway.testConnection({ providerId: "prov-a", capability: "image-to-text" })).verdict, "no-api-key");
    s.secretStore.setSecret("ai.provider.prov-b.apiKey", "KEY");
    const r = await s.aiGateway.testConnection({ providerId: "prov-b", capability: "image-to-image" });
    assert.equal(r.verdict, "config");
    assert.equal(r.error, "no-provider-for-capability");
    assert.equal(s.calls.length, 0, "1 度も送っていないこと");
  } finally { s.restore(); }
});

test("🔴 知らない提供元・形の悪い id は断る", async () => {
  const dir = freshDir();
  const s = stubForTest(dir, { providers: [GEMINI_A] });
  try {
    for (const id of ["nope", "../etc", "", null]) {
      const r = await s.aiGateway.testConnection({ providerId: id, capability: "image-to-text" });
      assert.equal(r.error, "unknown-provider", String(id));
    }
    assert.equal(s.calls.length, 0);
  } finally { s.restore(); }
});

test("🔴 連打を抑える（課金と相手への負荷）", async () => {
  const dir = freshDir();
  const s = stubForTest(dir, { providers: [GEMINI_A] });
  try {
    s.secretStore.setSecret("ai.provider.prov-a.apiKey", "KEY");
    assert.equal((await s.aiGateway.testConnection({ providerId: "prov-a", capability: "image-to-text" })).ok, true);
    const second = await s.aiGateway.testConnection({ providerId: "prov-a", capability: "image-to-text" });
    assert.equal(second.verdict, "too-soon");
    assert.ok(second.retryAfterMs > 0, "あと何 ms 待てばよいかを返す");
    assert.equal(s.calls.length, 1, "2 度目は送っていない");
  } finally { s.restore(); }
});

test("🔑 設定の効き方を試験できる（接続テストは generate と同じ組み立てを通る）", async () => {
  const dir = freshDir();
  const s = stubForTest(dir, {
    providers: [{ id: "az", kind: "openai", endpoint: "https://hosp.test", pathStyle: "azure-deployment",
                  apiVersion: "2025-01-01", auth: { header: "api-key", prefix: "" },
                  models: { "image-to-text": "my-deployment" } }],
  }, { statusCode: 200, json: { choices: [{ message: { content: "OK" } }] }, text: "{}" });
  try {
    s.secretStore.setSecret("ai.provider.az.apiKey", "KEY");
    const r = await s.aiGateway.testConnection({ providerId: "az", capability: "image-to-text" });
    assert.equal(r.ok, true);
    assert.equal(r.requestLine,
      "POST https://hosp.test/openai/deployments/my-deployment/chat/completions?api-version=2025-01-01");
    assert.deepEqual(r.headerNames, ["api-key", "content-type"]);
  } finally { s.restore(); }
});

test("平文の宛先はそう申告する（画面が警告を出せる）", async () => {
  const dir = freshDir();
  const s = stubForTest(dir, {
    providers: [{ id: "ollama", kind: "openai", endpoint: "http://localhost:11434",
                  models: { "image-to-text": "llava" } }],
  }, { statusCode: 200, json: { choices: [{ message: { content: "OK" } }] }, text: "{}" });
  try {
    s.secretStore.setSecret("ai.provider.ollama.apiKey", "KEY");
    const r = await s.aiGateway.testConnection({ providerId: "ollama", capability: "image-to-text" });
    assert.equal(r.plaintext, true);
    assert.match(r.requestLine, /^POST http:\/\/localhost:11434\//);
  } finally { s.restore(); }
});

// ── モデル一覧の取得（設定画面の選択肢） ─────────────────────────────────────
//
// 🔴 この機能の危険は「鍵を、任意の宛先へ送れる口になること」。ここで固定するのは
//   宛先が絞られていること・鍵が結果に出ないこと・読めない応答を成功にしないこと。

/** GET を横取りして記録する。`reply` は関数でもよい（ページ送りの検査用）。 */
function stubGet(dir, config, reply) {
  const g = freshGateway(dir, config);
  const aiHttp = require("./aiHttp");
  const calls = [];
  const original = aiHttp.get;
  aiHttp.get = async (target, path, headers) => {
    calls.push({ target, path, headers });
    return typeof reply === "function" ? reply(calls.length) : reply;
  };
  return { ...g, calls, restore: () => { aiHttp.get = original; } };
}

const OPENAI_LIST = { statusCode: 200, text: "", json: { data: [{ id: "model-b" }, { id: "model-a" }, { id: "model-a" }, { id: "bad name" }] } };

test("🔑 OpenAI 系: 保存済みの鍵で /v1/models を GET し、名前を重複なく並べる（不正な名前は出さない）", async () => {
  const dir = freshDir();
  const s = stubGet(dir, { providers: [OPENAI] }, OPENAI_LIST);
  try {
    s.secretStore.setSecret("ai.provider.oa.apiKey", "KEY");
    const r = await s.aiGateway.listModels({ providerId: "oa" });
    assert.equal(r.ok, true);
    assert.deepEqual(r.models, ["model-a", "model-b"]);
    assert.equal(s.calls.length, 1);
    assert.equal(s.calls[0].path, "/v1/models");
    assert.equal(s.calls[0].headers.Authorization, "Bearer KEY");
    assert.equal(JSON.stringify(r).includes("KEY"), false, "🔴 戻りに鍵が出ない");
  } finally { s.restore(); }
});

test("Gemini: generateContent を扱えるものだけ、models/ を外して、ページ送りを追う", async () => {
  const dir = freshDir();
  const pages = [
    { statusCode: 200, text: "", json: { models: [
      { name: "models/gem-1", supportedGenerationMethods: ["generateContent"] },
      { name: "models/embed-1", supportedGenerationMethods: ["embedContent"] },
    ], nextPageToken: "T2" } },
    { statusCode: 200, text: "", json: { models: [{ name: "models/gem-2", supportedGenerationMethods: ["generateContent", "countTokens"] }] } },
  ];
  const s = stubGet(dir, { providers: [GEMINI_A] }, (n) => pages[n - 1]);
  try {
    s.secretStore.setSecret("ai.provider.prov-a.apiKey", "KEY");
    const r = await s.aiGateway.listModels({ providerId: "prov-a" });
    assert.deepEqual(r.models, ["gem-1", "gem-2"], "🔴 埋め込み専用は出さない");
    assert.equal(s.calls.length, 2);
    assert.equal(s.calls[0].path, "/v1beta/models?pageSize=1000");
    assert.equal(s.calls[1].path, "/v1beta/models?pageSize=1000&pageToken=T2");
    assert.equal(s.calls[0].headers["x-goog-api-key"], "KEY");
  } finally { s.restore(); }
});

test("🔴 未保存の候補は公式ホストだけ。任意の宛先へは鍵を送らない（負例）", async () => {
  const dir = freshDir();
  const s = stubGet(dir, { providers: [OPENAI] }, OPENAI_LIST);
  try {
    for (const endpoint of ["https://evil.example.test", "http://api.openai.com", "https://api.openai.com:8443", "https://api.openai.com.evil.test", "not a url"]) {
      const r = await s.aiGateway.listModels({ kind: "openai", endpoint, apiKey: "KEY" });
      assert.equal(r.ok, false, endpoint);
      assert.equal(r.error, "unsupported-endpoint", endpoint);
    }
    // 種別と宛先の食い違い（Gemini の鍵を OpenAI のホストへ）も通さない。
    assert.equal((await s.aiGateway.listModels({ kind: "gemini", endpoint: "https://api.openai.com", apiKey: "KEY" })).error, "unsupported-endpoint");
    assert.equal(s.calls.length, 0, "🔴 1 度も送出していない");
  } finally { s.restore(); }
});

test("未保存の候補: 公式ホストなら入力中の鍵で取れる（正例。上の負例の対照）", async () => {
  const dir = freshDir();
  const s = stubGet(dir, { providers: [OPENAI] }, OPENAI_LIST);
  try {
    const r = await s.aiGateway.listModels({ kind: "openai", endpoint: "https://api.openai.com", apiKey: " KEY " });
    assert.equal(r.ok, true);
    assert.equal(s.calls[0].target.hostname, "api.openai.com");
    assert.equal(s.calls[0].headers.Authorization, "Bearer KEY");
    assert.equal((await s.aiGateway.listModels({ kind: "openai", endpoint: "https://api.openai.com", apiKey: "KEY" })).error, "too-soon", "（連打の抑止が効く）");
    assert.equal((await s.aiGateway.listModels({ kind: "openai", endpoint: "https://api.openai.com", apiKey: "" })).error, "no-api-key", "鍵が空なら送らない");
  } finally { s.restore(); }
});

test("鍵が無ければ no-api-key、Azure は手入力（送出しない）", async () => {
  const dir = freshDir();
  const AZURE = { id: "az", label: "Azure", kind: "azure-openai", endpoint: "https://r.openai.azure.com", models: { "image-to-text": "dep1" } };
  const s = stubGet(dir, { providers: [OPENAI, AZURE] }, OPENAI_LIST);
  try {
    assert.equal((await s.aiGateway.listModels({ providerId: "oa" })).verdict, "no-api-key");
    s.secretStore.setSecret("ai.provider.az.apiKey", "KEY");
    const r = await s.aiGateway.listModels({ providerId: "az" });
    assert.equal(r.verdict, "manual");
    assert.equal(s.calls.length, 0);
  } finally { s.restore(); }
});

test("🔴 401 を成功にしない。エラー文に鍵を出さない。読めない応答は成功にしない", async () => {
  const dir = freshDir();
  const s = stubGet(dir, { providers: [OPENAI] }, { statusCode: 401, text: "", json: { error: { message: "bad key KEY here" } } });
  try {
    s.secretStore.setSecret("ai.provider.oa.apiKey", "KEY");
    const r = await s.aiGateway.listModels({ providerId: "oa" });
    assert.equal(r.ok, false);
    assert.equal(r.verdict, "auth-failed");
    assert.equal(JSON.stringify(r).includes("KEY"), false);
  } finally { s.restore(); }
  const s2 = stubGet(freshDir(), { providers: [OPENAI] }, { statusCode: 200, text: "<html>", json: null });
  try {
    s2.secretStore.setSecret("ai.provider.oa.apiKey", "KEY");
    assert.equal((await s2.aiGateway.listModels({ providerId: "oa" })).verdict, "unreadable-response");
  } finally { s2.restore(); }
});

test("知らない提供元 id は unknown-provider", async () => {
  const s = stubGet(freshDir(), { providers: [OPENAI] }, OPENAI_LIST);
  try {
    assert.equal((await s.aiGateway.listModels({ providerId: "nope" })).error, "unknown-provider");
  } finally { s.restore(); }
});

// ── 会話（text-to-text・ツール・ストリーミング・フォールバック） ───────────

const CHAT_CLOUD = {
  id: "cloud", label: "クラウド", kind: "openai", endpoint: "https://api.example.test",
  models: { "text-to-text": "cloud-m", "image-to-text": "cloud-vl" },
};
const CHAT_CLOUD2 = {
  id: "cloud2", label: "別のクラウド", kind: "openai", endpoint: "https://api2.example.test",
  models: { "text-to-text": "cloud2-m" },
};
const CHAT_LOCAL = {
  id: "local", label: "ローカル", kind: "openai", endpoint: "http://127.0.0.1:8080", auth: "none",
  models: { "text-to-text": "tiny" },
};
const CHAT_LOCAL_VL = { ...CHAT_LOCAL, models: { "text-to-text": "tiny", "image-to-text": "tiny-vl" } };

const OK_JSON = (text, extra) => ({
  statusCode: 200, text: "",
  json: { choices: [{ finish_reason: "stop", message: { content: text, ...(extra || {}) } }] },
});
const MSGS = [{ role: "user", text: "こんにちは" }];

/** aiHttp.post / postStream を差し替える。`handlers.post(target, path, headers, body, calls)` が応答を決める。 */
function chatGateway(config, handlers, keys) {
  const dir = freshDir();
  const g = freshGateway(dir, config);
  for (const [id, key] of Object.entries(keys || {})) g.secretStore.setSecret(`ai.provider.${id}.apiKey`, key);
  const aiHttp = require("./aiHttp");
  const orig = { post: aiHttp.post, postStream: aiHttp.postStream };
  const calls = [];
  aiHttp.post = async (target, p, headers, body) => {
    calls.push({ host: target.display, path: p, headers, body: JSON.parse(body.toString("utf8")) });
    return handlers.post(target, p, headers, calls[calls.length - 1], calls);
  };
  aiHttp.postStream = async (target, p, headers, body, opts) => {
    calls.push({ host: target.display, path: p, headers, body: JSON.parse(body.toString("utf8")), stream: true });
    return handlers.stream(target, p, headers, calls[calls.length - 1], opts, calls);
  };
  return { ...g, calls, restore: () => { aiHttp.post = orig.post; aiHttp.postStream = orig.postStream; } };
}

test("chat: 文章とツール呼び出しが提供元非依存の形で返り、由来が付く", async () => {
  const g = chatGateway(
    { providers: [CHAT_CLOUD], defaults: { "text-to-text": "cloud" } },
    { post: () => OK_JSON("", { tool_calls: [{ id: "t1", function: { name: "f", arguments: '{"a":1}' } }] }) },
    { cloud: "SECRET-KEY-1" },
  );
  try {
    const r = await g.aiGateway.chat({ sessionId: "s1", messages: MSGS, tools: [{ name: "f", parameters: { type: "object" } }] });
    assert.equal(r.ok, true);
    assert.deepEqual(r.toolCalls, [{ id: "t1", name: "f", args: { a: 1 } }]);
    assert.equal(r.provenance.providerId, "cloud");
    assert.equal(r.provenance.model, "cloud-m");
    assert.equal(r.degraded, undefined);
    assert.equal(g.calls[0].headers.Authorization, "Bearer SECRET-KEY-1");
    assert.equal(g.calls[0].body.tools[0].function.name, "f");
  } finally { g.restore(); }
});

test("chat: 鍵が無ければ送らない（負例）／鍵なし(auth:none)のローカルは鍵無しで送れる（正例）", async () => {
  const g = chatGateway({ providers: [CHAT_CLOUD], defaults: { "text-to-text": "cloud" } }, { post: () => OK_JSON("x") });
  try {
    assert.equal((await g.aiGateway.chat({ sessionId: "s", messages: MSGS })).error, "no-api-key");
    assert.equal(g.calls.length, 0, "鍵が無いなら 1 バイトも送らない");
  } finally { g.restore(); }
  const l = chatGateway({ providers: [CHAT_LOCAL], defaults: { "text-to-text": "local" } }, { post: () => OK_JSON("hi") });
  try {
    const r = await l.aiGateway.chat({ sessionId: "s", messages: MSGS });
    assert.equal(r.ok, true);
    assert.equal(r.text, "hi");
    assert.equal(Object.keys(l.calls[0].headers).some((k) => /authorization|api-key/i.test(k)), false);
    assert.equal(r.provenance.plaintext, true);
  } finally { l.restore(); }
});

const FALLBACK_CONFIG = {
  providers: [CHAT_CLOUD, CHAT_CLOUD2, CHAT_LOCAL],
  defaults: { "text-to-text": "cloud" },
  fallbacks: { "text-to-text": ["cloud2", "local"] }, // cloud2 は検査で落ちる
};

test("🔴 フォールバック: ネットワーク断・タイムアウト・5xx でローカルへ落ち、縮退と由来が付く", async () => {
  for (const failure of [
    () => { throw new Error("connect ECONNREFUSED 1.2.3.4:443"); },
    () => { throw new Error("タイムアウト(120000 ms)"); },
    () => ({ statusCode: 503, json: null, text: "unavailable" }),
  ]) {
    const g = chatGateway(FALLBACK_CONFIG, {
      post: (t) => (t.hostname === "127.0.0.1" ? OK_JSON("ローカルの返答") : failure()),
    }, { cloud: "K" });
    try {
      const r = await g.aiGateway.chat({ sessionId: "s", messages: MSGS });
      assert.equal(r.ok, true);
      assert.equal(r.text, "ローカルの返答");
      assert.equal(r.degraded, true);
      assert.equal(r.provenance.providerId, "local");
      assert.equal(r.provenance.fallbackFrom, "cloud");
      assert.deepEqual(g.calls.map((c) => c.host), ["api.example.test", "127.0.0.1:8080"], "別のクラウド(cloud2)へは送らない");
    } finally { g.restore(); }
  }
});

test("🔴 フォールバックしない失敗: 401 / 400 / 429 は次へ回さない（負例）", async () => {
  for (const status of [401, 403, 400, 429]) {
    const g = chatGateway(FALLBACK_CONFIG, { post: () => ({ statusCode: status, json: null, text: "no" }) }, { cloud: "K" });
    try {
      const r = await g.aiGateway.chat({ sessionId: "s", messages: MSGS });
      assert.equal(r.ok, false);
      assert.equal(r.status, status);
      assert.equal(g.calls.length, 1, `HTTP ${status} でローカルへ回してはいけない`);
    } finally { g.restore(); }
  }
});

test("🔴 ローカルが既定なら、落ちてもクラウドへは出ない（負例）", async () => {
  const g = chatGateway(
    { providers: [CHAT_CLOUD, CHAT_LOCAL], defaults: { "text-to-text": "local" }, fallbacks: { "text-to-text": ["cloud"] } },
    { post: () => { throw new Error("connect ECONNREFUSED 127.0.0.1:8080"); } },
    { cloud: "K" },
  );
  try {
    const r = await g.aiGateway.chat({ sessionId: "s", messages: MSGS });
    assert.equal(r.ok, false);
    assert.deepEqual(g.calls.map((c) => c.host), ["127.0.0.1:8080"]);
  } finally { g.restore(); }
});

test("画像: 画像対応の宣言(image-to-text)があればそのモデルで送る／無ければ落として数える", async () => {
  const withVl = chatGateway({ providers: [CHAT_LOCAL_VL], defaults: { "text-to-text": "local" } }, { post: () => OK_JSON("見えた") });
  try {
    const m = [{ role: "user", text: "これは", images: [{ base64: "QUJD", mimeType: "image/png" }] }];
    const r = await withVl.aiGateway.chat({ sessionId: "s", messages: m });
    assert.equal(withVl.calls[0].body.model, "tiny-vl");
    assert.equal(r.droppedImages, undefined);
    assert.equal(r.provenance.model, "tiny-vl");
  } finally { withVl.restore(); }
  const without = chatGateway({ providers: [CHAT_LOCAL], defaults: { "text-to-text": "local" } }, { post: () => OK_JSON("見えない") });
  try {
    const m = [{ role: "user", text: "これは", images: [{ base64: "QUJD" }, { base64: "REVG" }] }];
    const r = await without.aiGateway.chat({ sessionId: "s", messages: m });
    assert.equal(r.ok, true);
    assert.equal(r.droppedImages, 2, "黙って欠損させない");
    assert.equal(without.calls[0].body.model, "tiny");
    assert.equal(JSON.stringify(without.calls[0].body).includes("QUJD"), false, "画像は送らない");
  } finally { without.restore(); }
});

test("ストリーミング: 差分が順に届き、結果は非ストリームと同じ形", async () => {
  const g = chatGateway({ providers: [CHAT_LOCAL], defaults: { "text-to-text": "local" } }, {
    stream: (t, p, h, call, opts) => {
      opts.onData(JSON.stringify({ choices: [{ delta: { content: "あ" } }] }));
      opts.onData(JSON.stringify({ choices: [{ delta: { content: "い" }, finish_reason: "stop" }] }));
      opts.onData("[DONE]");
      return { statusCode: 200, json: null, text: "" };
    },
  });
  try {
    const events = [];
    const r = await g.aiGateway.chat({ sessionId: "s", messages: MSGS, stream: true }, { onEvent: (e) => events.push(e.text) });
    assert.deepEqual(events, ["あ", "い"]);
    assert.equal(r.text, "あい");
    assert.equal(g.calls[0].body.stream, true);
  } finally { g.restore(); }
});

test("🔴 差分を流したあとの失敗は、別の宛先へ回さない（同じ文が二重に出る）", async () => {
  const g = chatGateway(FALLBACK_CONFIG, {
    post: () => OK_JSON("ローカル"),
    stream: (t, p, h, call, opts) => {
      opts.onData(JSON.stringify({ choices: [{ delta: { content: "途中" } }] }));
      throw new Error("read ECONNRESET");
    },
  }, { cloud: "K" });
  try {
    const r = await g.aiGateway.chat({ sessionId: "s", messages: MSGS, stream: true }, { onEvent: () => {} });
    assert.equal(r.ok, false);
    assert.equal(g.calls.length, 1);
  } finally { g.restore(); }
});

test("錠: 同一セッションの二重送信は busy、別セッションは通る、終われば解放される", async () => {
  let release;
  const gate = new Promise((res) => { release = res; });
  const g = chatGateway({ providers: [CHAT_LOCAL], defaults: { "text-to-text": "local" } }, { post: async () => { await gate; return OK_JSON("x"); } });
  try {
    const first = g.aiGateway.chat({ sessionId: "A", messages: MSGS });
    assert.equal((await g.aiGateway.chat({ sessionId: "A", messages: MSGS })).error, "busy");
    const other = g.aiGateway.chat({ sessionId: "B", messages: MSGS });
    release();
    assert.equal((await first).ok, true);
    assert.equal((await other).ok, true);
    assert.equal((await g.aiGateway.chat({ sessionId: "A", messages: MSGS })).ok, true, "終われば同じセッションで再び送れる");
  } finally { g.restore(); }
});

test("会話の錠は画像生成の錠と独立（会話中でも接続テストが busy にならない）", async () => {
  let release;
  const gate = new Promise((res) => { release = res; });
  const g = chatGateway({ providers: [CHAT_LOCAL_VL], defaults: { "text-to-text": "local", "image-to-text": "local" } }, {
    post: async (t, p, h, call) => { if (call.body.messages && call.body.messages[0].content === "hold") await gate; return OK_JSON("OK"); },
  });
  try {
    const running = g.aiGateway.chat({ sessionId: "A", messages: [{ role: "user", text: "hold" }] });
    const t = await g.aiGateway.testConnection({ providerId: "local", capability: "image-to-text" });
    assert.notEqual(t.verdict, "busy");
    release();
    await running;
  } finally { g.restore(); }
});

test("中断: cancelChat で進行中のストリームが止まり、錠が解放される", async () => {
  const g = chatGateway({ providers: [CHAT_LOCAL], defaults: { "text-to-text": "local" } }, {
    stream: (t, p, h, call, opts) => new Promise((_, reject) => {
      opts.signal.addEventListener("abort", () => reject(new Error("canceled")));
    }),
  });
  try {
    const running = g.aiGateway.chat({ sessionId: "A", messages: MSGS, stream: true }, { onEvent: () => {} });
    await new Promise((r) => setImmediate(r));
    assert.equal(g.aiGateway.cancelChat("A").ok, true);
    const r = await running;
    assert.equal(r.error, "canceled");
    assert.equal(g.aiGateway.cancelChat("A").ok, false, "もう走っていない");
    assert.equal(g.calls.length, 1, "中断を失敗として別の宛先へ回さない");
  } finally { g.restore(); }
});

test("入力の検査: 不正な sessionId・空の会話・不正なツール名・画像の上限（負例）", async () => {
  const g = chatGateway({ providers: [CHAT_LOCAL], defaults: { "text-to-text": "local" } }, { post: () => OK_JSON("x") });
  try {
    const chat = (r) => g.aiGateway.chat(r);
    assert.equal((await chat({ sessionId: "../x", messages: MSGS })).error, "invalid-session");
    assert.equal((await chat({ sessionId: "s", messages: [] })).error, "empty-messages");
    assert.equal((await chat({ sessionId: "s", messages: [{ role: "root", text: "x" }] })).error, "invalid-message");
    assert.equal((await chat({ sessionId: "s", messages: [{ role: "assistant", images: [{ base64: "QQ==" }] }] })).error, "invalid-message");
    assert.equal((await chat({ sessionId: "s", messages: MSGS, tools: [{ name: "bad name" }] })).error, "invalid-tools");
    assert.equal((await chat({ sessionId: "s", messages: MSGS, tools: [{ name: "a" }, { name: "a" }] })).error, "invalid-tools");
    const big = "A".repeat(g.aiGateway.MAX_IMAGE_BYTES + 1);
    assert.equal((await chat({ sessionId: "s", messages: [{ role: "user", images: [{ base64: big }] }] })).error, "image-too-large");
    assert.equal(g.calls.length, 0, "検査で落ちたものは送らない");
  } finally { g.restore(); }
});

test("🔴 鍵はエラー文に出ない", async () => {
  const g = chatGateway({ providers: [CHAT_CLOUD], defaults: { "text-to-text": "cloud" } }, {
    post: () => ({ statusCode: 400, json: { error: { message: "bad key SECRET-KEY-9 sk-abcdef123456" } }, text: "" }),
  }, { cloud: "SECRET-KEY-9" });
  try {
    const r = await g.aiGateway.chat({ sessionId: "s", messages: MSGS });
    assert.equal(r.ok, false);
    assert.equal(JSON.stringify(r).includes("SECRET-KEY-9"), false);
    assert.equal(JSON.stringify(r).includes("sk-abcdef123456"), false);
  } finally { g.restore(); }
});

test("200 なのに中身が読めないときは成功を返さない", async () => {
  const g = chatGateway({ providers: [CHAT_LOCAL], defaults: { "text-to-text": "local" } }, { post: () => ({ statusCode: 200, json: { object: "other" }, text: "" }) });
  try {
    assert.equal((await g.aiGateway.chat({ sessionId: "s", messages: MSGS })).error, "empty-response");
  } finally { g.restore(); }
});

test("generate は text-to-text を受けない（会話は chat の仕事）／接続テストは画像なしで通る", async () => {
  const g = chatGateway({ providers: [CHAT_LOCAL], defaults: { "text-to-text": "local" } }, { post: () => OK_JSON("OK") });
  try {
    const r = await g.aiGateway.generate({ capability: "text-to-text", prompt: "x", imageBase64: "QQ==" });
    assert.equal(r.error, "unsupported-capability");
    const t = await g.aiGateway.testConnection({ providerId: "local", capability: "text-to-text" });
    assert.equal(t.ok, true);
    assert.equal(t.verdict, "reachable");
    assert.equal(JSON.stringify(g.calls[0].body).includes("image_url"), false, "接続テストに画像は付けない");
  } finally { g.restore(); }
});

test("resolveCapability は toolMode と local を返す（会話の呼び出し側が使う）", () => {
  const dir = freshDir();
  const { aiGateway } = freshGateway(dir, { providers: [{ ...CHAT_LOCAL, toolMode: "none" }], defaults: { "text-to-text": "local" } });
  const r = aiGateway.resolveCapability("text-to-text");
  assert.equal(r.ok, true);
  assert.equal(r.toolMode, "none");
  assert.equal(r.local, true);
  assert.equal(r.hasApiKey, true, "鍵なしの提供元は鍵が要らない");
});

test("🔑 prepare フック: 送る直前に呼ばれ、保存し直した endpoint(ポート)へ送る／local 以外には影響しない", async () => {
  const g = chatGateway({ providers: [CHAT_LOCAL], defaults: { "text-to-text": "local" } }, { post: () => OK_JSON("hi") });
  try {
    const seen = [];
    g.aiGateway.setPrepareHook(async (provider) => {
      seen.push(provider.id);
      // 起動のたびにポートが変わる想定: 保存し直す
      const cfg = g.aiProviders.get();
      g.aiProviders.save({
        providers: cfg.providers.map(({ plaintext, ...p }) => (p.id === "local" ? { ...p, endpoint: "http://127.0.0.1:9191" } : p)),
        defaults: cfg.defaults,
      });
      return { ok: true };
    });
    const r = await g.aiGateway.chat({ sessionId: "s", messages: MSGS });
    assert.equal(r.ok, true);
    assert.deepEqual(seen, ["local"]);
    assert.equal(g.calls[0].host, "127.0.0.1:9191", "準備のあとの endpoint へ送る");
  } finally { g.aiGateway.setPrepareHook(null); g.restore(); }
});

test("🔴 prepare フックが失敗したら送らない（負例）／クラウド→ローカルの縮退で、ローカルの準備失敗は握りつぶさない", async () => {
  const g = chatGateway(FALLBACK_CONFIG, {
    post: (t) => (t.hostname === "127.0.0.1" ? OK_JSON("届いてはいけない") : (() => { throw new Error("connect ECONNREFUSED"); })()),
  }, { cloud: "K" });
  try {
    g.aiGateway.setPrepareHook(async (p) => (p.id === "local" ? { ok: false, error: "local-llm:not-installed" } : { ok: true }));
    const r = await g.aiGateway.chat({ sessionId: "s", messages: MSGS });
    assert.equal(r.ok, false);
    assert.equal(r.error, "local-llm:not-installed");
    assert.deepEqual(g.calls.map((c) => c.host), ["api.example.test"], "準備に失敗したローカルへは送っていない");
  } finally { g.aiGateway.setPrepareHook(null); g.restore(); }
});

// ── 音声の文字起こし（speech-to-text） ─────────────────────────────────────

const WAV = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVEfmt "), Buffer.from("PCMDATA-MARKER")]);
const AUDIO = { base64: WAV.toString("base64"), mimeType: "audio/wav" };
const STT_LOCAL = {
  id: "local-stt", label: "ローカル音声", kind: "openai", endpoint: "http://127.0.0.1:8099", auth: "none",
  models: { "speech-to-text": "qwen3-asr" }, paths: { "speech-to-text": "/v1/chat/completions" },
};
const STT_CLOUD_OPENAI = {
  id: "oa", label: "OpenAI 互換", kind: "openai", endpoint: "https://api.example.test",
  models: { "text-to-text": "m", "speech-to-text": "whisper-1" },
};
const STT_CLOUD_GEMINI = {
  id: "gm", label: "Gemini", kind: "gemini", endpoint: "https://g.example.test",
  models: { "speech-to-text": "gemini-2.5-flash" },
};

/** 生の本文（multipart でも読める）を記録する差し替え。`reply(target, path, call)` が応答。 */
function sttGateway(config, reply, keys) {
  const g = freshGateway(freshDir(), config);
  for (const [id, key] of Object.entries(keys || {})) g.secretStore.setSecret(`ai.provider.${id}.apiKey`, key);
  const aiHttp = require("./aiHttp");
  const original = aiHttp.post;
  const calls = [];
  aiHttp.post = async (target, p, headers, body) => {
    calls.push({ host: target.display, path: p, headers, raw: body });
    return reply(target, p, calls[calls.length - 1]);
  };
  return { ...g, calls, restore: () => { aiHttp.post = original; g.aiGateway.setPrepareHook(null); } };
}
const STT_OK = (text) => ({ statusCode: 200, text: "", json: { choices: [{ message: { content: text } }] } });

test("文字起こし: ローカル(chat 形式)は input_audio で送り、先頭の language 表記を取り除く", async () => {
  const g = sttGateway({ providers: [STT_LOCAL], defaults: { "speech-to-text": "local-stt" } }, () => STT_OK("language Japanese<asr_text>肺結節の大きさを測定してください。"));
  try {
    const r = await g.aiGateway.transcribe({ audio: AUDIO, language: "ja" });
    assert.equal(r.ok, true);
    assert.equal(r.text, "肺結節の大きさを測定してください。");
    assert.equal(r.provenance.local, true);
    assert.equal(g.calls[0].path, "/v1/chat/completions");
    const body = JSON.parse(g.calls[0].raw.toString("utf8"));
    assert.equal(body.messages[0].content[0].type, "input_audio");
    assert.equal(body.messages[0].content[0].input_audio.data, AUDIO.base64);
    assert.equal(body.messages[0].content[0].input_audio.format, "wav");
    assert.equal(Object.keys(g.calls[0].headers).some((k) => /authorization|api-key/i.test(k)), false);
  } finally { g.restore(); }
});

test("文字起こし: OpenAI 互換は multipart の /v1/audio/transcriptions（鍵を付け、音声はバイト列で入る）", async () => {
  const g = sttGateway({ providers: [STT_CLOUD_OPENAI], defaults: { "speech-to-text": "oa" } }, () => ({ statusCode: 200, text: "", json: { text: "hello" } }), { oa: "KEY-1" });
  try {
    const r = await g.aiGateway.transcribe({ audio: { ...AUDIO, mimeType: "audio/wav;codecs=1" }, language: "en" });
    assert.equal(r.ok, true);
    assert.equal(r.text, "hello");
    assert.equal(r.provenance.local, false);
    assert.equal(g.calls[0].path, "/v1/audio/transcriptions");
    assert.match(g.calls[0].headers["Content-Type"], /^multipart\/form-data; boundary=/);
    assert.equal(g.calls[0].headers.Authorization, "Bearer KEY-1");
    const raw = g.calls[0].raw;
    assert.ok(raw.includes(WAV), "音声が生のバイト列で入る");
    const text = raw.toString("latin1");
    assert.match(text, /name="model"\r\n\r\nwhisper-1/);
    assert.match(text, /name="language"\r\n\r\nen/);
    assert.match(text, /name="file"; filename="audio\.wav"/);
  } finally { g.restore(); }
});

test("文字起こし: Gemini は音声を inline_data で送り、書き起こしだけを頼む", async () => {
  const g = sttGateway({ providers: [STT_CLOUD_GEMINI], defaults: { "speech-to-text": "gm" } },
    () => ({ statusCode: 200, text: "", json: { candidates: [{ content: { parts: [{ text: "こんにちは" }] } }] } }), { gm: "GK" });
  try {
    const r = await g.aiGateway.transcribe({ audio: AUDIO });
    assert.equal(r.ok, true);
    assert.equal(r.text, "こんにちは");
    const body = JSON.parse(g.calls[0].raw.toString("utf8"));
    assert.equal(body.contents[0].parts[1].inline_data.mime_type, "audio/wav");
    assert.equal(body.contents[0].parts[1].inline_data.data, AUDIO.base64);
    assert.match(body.contents[0].parts[0].text, /verbatim/);
    assert.equal(body.generationConfig.temperature, 0);
    assert.match(g.calls[0].path, /models\/gemini-2\.5-flash:generateContent$/);
  } finally { g.restore(); }
});

test("🔴 文字起こしの入力検査（負例）: 空・過大・音声以外の MIME・不正な言語は送らない", async () => {
  const g = sttGateway({ providers: [STT_LOCAL], defaults: { "speech-to-text": "local-stt" } }, () => STT_OK("届いてはいけない"));
  try {
    const cases = [
      [{}, "empty-audio"],
      [{ audio: { base64: "", mimeType: "audio/wav" } }, "empty-audio"],
      [{ audio: { base64: "A".repeat(g.aiGateway.MAX_AUDIO_BYTES + 1), mimeType: "audio/wav" } }, "audio-too-large"],
      [{ audio: { base64: "QQ==", mimeType: "text/html" } }, "unsupported-audio-type"],
      [{ audio: { base64: "QQ==", mimeType: "image/png" } }, "unsupported-audio-type"],
      [{ audio: AUDIO, language: "ja; rm -rf" }, "invalid-language"],
    ];
    for (const [req, err] of cases) assert.equal((await g.aiGateway.transcribe(req)).error, err, err);
    assert.equal(g.calls.length, 0, "検査で落ちたものは 1 件も送っていない");
  } finally { g.restore(); }
});

test("🔴 文字起こし: 提供元が無い／鍵が無い／Azure／generate 経由は送らない", async () => {
  const none = sttGateway({ providers: [CHAT_CLOUD] }, () => STT_OK("x"));
  try {
    assert.equal((await none.aiGateway.transcribe({ audio: AUDIO })).error, "no-provider-for-capability", "既定でクラウドへ音声を出さない");
    assert.equal(none.aiGateway.resolveCapability("speech-to-text").ok, false);
    assert.equal((await none.aiGateway.generate({ capability: "speech-to-text", prompt: "x", imageBase64: "QQ==" })).error, "unsupported-capability");
    assert.equal(none.calls.length, 0);
  } finally { none.restore(); }

  const nokey = sttGateway({ providers: [STT_CLOUD_OPENAI], defaults: { "speech-to-text": "oa" } }, () => STT_OK("x"));
  try {
    assert.equal((await nokey.aiGateway.transcribe({ audio: AUDIO })).error, "no-api-key");
    assert.equal(nokey.calls.length, 0);
  } finally { nokey.restore(); }

  const azure = sttGateway({ providers: [{ ...STT_CLOUD_OPENAI, id: "az", kind: "azure-openai" }], defaults: { "speech-to-text": "az" } }, () => STT_OK("x"), { az: "K" });
  try {
    assert.equal((await azure.aiGateway.transcribe({ audio: AUDIO })).error, "unsupported-capability");
    assert.equal(azure.calls.length, 0);
  } finally { azure.restore(); }
});

test("🔴 文字起こし: 空の認識結果・読めない応答は成功にしない／エラー文に鍵が出ない", async () => {
  const g = sttGateway({ providers: [STT_LOCAL], defaults: { "speech-to-text": "local-stt" } }, () => STT_OK("language Japanese<asr_text>"));
  try {
    const r = await g.aiGateway.transcribe({ audio: AUDIO });
    assert.equal(r.ok, false);
    assert.equal(r.error, "empty-transcript");
  } finally { g.restore(); }
  const key = "sk-secretkey1234567890";
  const e = sttGateway({ providers: [STT_CLOUD_OPENAI], defaults: { "speech-to-text": "oa" } },
    () => ({ statusCode: 401, json: { error: { message: `bad key ${key}` } }, text: "" }), { oa: key });
  try {
    const r = await e.aiGateway.transcribe({ audio: AUDIO });
    assert.equal(r.ok, false);
    assert.equal(JSON.stringify(r).includes(key), false);
  } finally { e.restore(); }
});

test("文字起こし: 既定がクラウドで落ちたときだけ、ローカル判定の宛先へ縮退する／ローカル既定からクラウドへは出ない", async () => {
  const cfg = {
    providers: [STT_CLOUD_OPENAI, STT_CLOUD_GEMINI, STT_LOCAL],
    defaults: { "speech-to-text": "oa" },
    fallbacks: { "speech-to-text": ["gm", "local-stt"] }, // gm は検査で落ちる
  };
  const g = sttGateway(cfg, (t) => (t.hostname === "127.0.0.1" ? STT_OK("language English<asr_text>local") : { statusCode: 503, json: null, text: "down" }), { oa: "K", gm: "G" });
  try {
    const r = await g.aiGateway.transcribe({ audio: AUDIO });
    assert.equal(r.ok, true);
    assert.equal(r.text, "local");
    assert.equal(r.degraded, true);
    assert.equal(r.provenance.fallbackFrom, "oa");
    assert.deepEqual(g.calls.map((c) => c.host), ["api.example.test", "127.0.0.1:8099"]);
  } finally { g.restore(); }

  const l = sttGateway({ providers: [STT_LOCAL, STT_CLOUD_OPENAI], defaults: { "speech-to-text": "local-stt" }, fallbacks: { "speech-to-text": ["oa"] } },
    () => { throw new Error("connect ECONNREFUSED"); }, { oa: "K" });
  try {
    const r = await l.aiGateway.transcribe({ audio: AUDIO });
    assert.equal(r.ok, false);
    assert.deepEqual(l.calls.map((c) => c.host), ["127.0.0.1:8099"], "ローカルが落ちてもクラウドへは出ない");
  } finally { l.restore(); }
});

test("🔴 文字起こし: prepare フックが失敗したら送らない", async () => {
  const g = sttGateway({ providers: [STT_LOCAL], defaults: { "speech-to-text": "local-stt" } }, () => STT_OK("届いてはいけない"));
  try {
    g.aiGateway.setPrepareHook(async () => ({ ok: false, error: "local-llm:not-installed" }));
    const r = await g.aiGateway.transcribe({ audio: AUDIO });
    assert.equal(r.ok, false);
    assert.equal(r.error, "local-llm:not-installed");
    assert.equal(g.calls.length, 0);
  } finally { g.restore(); }
});

test("文字起こしの接続テスト: 送るのは無音の WAV だけ（利用者の音声は使えない）", async () => {
  const g = sttGateway({ providers: [STT_LOCAL], defaults: { "speech-to-text": "local-stt" } }, () => STT_OK("language English<asr_text>"));
  try {
    const t = await g.aiGateway.testConnection({ providerId: "local-stt", capability: "speech-to-text" });
    assert.equal(t.ok, true);
    assert.equal(t.verdict, "reachable");
    const body = JSON.parse(g.calls[0].raw.toString("utf8"));
    const wav = Buffer.from(body.messages[0].content[0].input_audio.data, "base64");
    assert.equal(wav.subarray(0, 4).toString(), "RIFF");
    assert.equal(wav.length, 44 + 9600);
    assert.ok(wav.subarray(44).every((b) => b === 0), "無音");
  } finally { g.restore(); }
});
