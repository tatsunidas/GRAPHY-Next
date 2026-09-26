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
