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
