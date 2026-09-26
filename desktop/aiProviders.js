// 外部 AI の提供元レジストリ。設計: fw/ai-routing-design.md §4
//
// 持っているのは「どこへ・どのモデルで送るか」だけ。**鍵は持たない**（secretStore が持つ）。
//
// 🔴 **backend の Settings に置かない。** `GET /api/settings` が平文で全件返すため、
//    レンダラ・プラグイン・DB バックアップ・ログの全経路から読める。AI は元から desktop 専用
//    （`host.ai` は web で desktop-only を返す）なので、設定も main に置く。
//
// 🔴 **`electron` を import しないこと。** desktop/ のテストは `node --test` で
//    **npm install 無し**に走る。electron に触るとファイルごと落ちる。

const fs = require("node:fs");
const path = require("node:path");

const FILE_NAME = "ai-providers.json";

/** 扱える用途。増やすときはアダプタ側の対応と対で足す。 */
const CAPABILITIES = ["image-to-image", "image-to-text"];

/**
 * 提供元 id の形。
 *
 * 🔴 **緩めないこと。** id は秘密情報のキー名（`ai.provider.<id>.apiKey`）に入る。
 * secretStore の allowlist は「レンダラから任意の名前で書ける素朴な平文 KVS にしない」ために
 * 在るので、`../` や長大な名前が通るとその目的が消える。
 */
const ID_RE = /^[a-z0-9-]{1,32}$/;

/** 既知の電文の形。`kind` ごとに desktop/aiAdapters/<kind>.js が対応する。 */
const KINDS = new Set(["gemini"]);

/**
 * 出荷時の構成。**ファイルが無いときはこれで動く。**
 *
 * <p>🔑 0.3.x から上げた利用者が**鍵を入れ直さずに済む**ようにしてある（§secretKeyFor）。
 */
const BUILT_IN = {
  providers: [
    {
      id: "gemini-public",
      label: "Google Gemini",
      kind: "gemini",
      endpoint: "https://generativelanguage.googleapis.com",
      auth: "api-key",
      models: {
        "image-to-image": "gemini-3.1-flash-image",
        "image-to-text": "gemini-2.5-flash",
      },
    },
  ],
  defaults: { "image-to-image": "gemini-public", "image-to-text": "gemini-public" },
};

/** 旧版（0.3.0 まで）が使っていた鍵の名前。 */
const LEGACY_SECRET_KEY = "ai.gemini.apiKey";
/** 旧版の鍵を引き継ぐ提供元（出荷時の Gemini だけ）。 */
const LEGACY_PROVIDER_ID = "gemini-public";

let filePath = null;
/** 読み込み済みの構成（未読なら null）。 */
let config = null;

function init(dataDir) {
  filePath = path.join(dataDir, FILE_NAME);
  config = null;
}

/**
 * その提供元の鍵の名前。
 *
 * <p>🔑 出荷時の Gemini だけは**旧名も見る**。0.3.0 で鍵を入れた利用者が、
 * 版を上げた途端に「鍵が未設定」に戻るのを避けるため。
 * 新しい名前に値があればそちらを優先する。
 */
function secretKeyFor(providerId) {
  return `ai.provider.${providerId}.apiKey`;
}

/** 旧名も含めた候補（先に見つかったものを使う）。 */
function secretKeyCandidates(providerId) {
  const keys = [secretKeyFor(providerId)];
  if (providerId === LEGACY_PROVIDER_ID) keys.push(LEGACY_SECRET_KEY);
  return keys;
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * 1 件の提供元を検査する。**壊れた 1 件で全体を捨てない**（他の提供元は使えるべき）。
 *
 * @returns {{ok: true, provider: object} | {ok: false, reason: string}}
 */
function validateProvider(p) {
  if (!isPlainObject(p)) return { ok: false, reason: "not-an-object" };
  if (typeof p.id !== "string" || !ID_RE.test(p.id)) return { ok: false, reason: "invalid-id" };
  if (!KINDS.has(p.kind)) return { ok: false, reason: `unknown-kind:${p.kind}` };
  // 🔴 https のみ。平文 http で患者画素を出させない。
  if (typeof p.endpoint !== "string" || !/^https:\/\/[^\s/]+/.test(p.endpoint)) {
    return { ok: false, reason: "invalid-endpoint" };
  }
  if (!isPlainObject(p.models)) return { ok: false, reason: "no-models" };
  const models = {};
  for (const cap of CAPABILITIES) {
    const m = p.models[cap];
    // 空文字は「その用途は使えない」と同じ扱い。**推測で埋めない。**
    if (typeof m === "string" && m.trim()) models[cap] = m.trim();
  }
  if (Object.keys(models).length === 0) return { ok: false, reason: "no-usable-capability" };
  return {
    ok: true,
    provider: {
      id: p.id,
      label: typeof p.label === "string" && p.label.trim() ? p.label.trim() : p.id,
      kind: p.kind,
      endpoint: p.endpoint.replace(/\/+$/, ""),
      auth: p.auth === "api-key" ? "api-key" : "api-key",
      models,
    },
  };
}

/**
 * 構成を検査して整える。**読めない部分は捨てて、残りで動かす。**
 *
 * <p>⚠ 「設定が壊れていたので何もしない」は、利用者から見ると原因不明の沈黙になる。
 * 捨てたものは `problems` で返して呼び出し元が見せられるようにする。
 */
function normalize(raw) {
  const problems = [];
  const providers = [];
  const seen = new Set();
  const list = isPlainObject(raw) && Array.isArray(raw.providers) ? raw.providers : [];
  for (const p of list) {
    const r = validateProvider(p);
    if (!r.ok) {
      problems.push(`provider ${isPlainObject(p) ? String(p.id) : "?"}: ${r.reason}`);
      continue;
    }
    if (seen.has(r.provider.id)) {
      problems.push(`provider ${r.provider.id}: duplicate-id`);
      continue;
    }
    seen.add(r.provider.id);
    providers.push(r.provider);
  }

  const defaults = {};
  const rawDefaults = isPlainObject(raw) && isPlainObject(raw.defaults) ? raw.defaults : {};
  for (const cap of CAPABILITIES) {
    const want = rawDefaults[cap];
    const hit = providers.find((p) => p.id === want && p.models[cap]);
    if (want && !hit) problems.push(`default ${cap}: ${want} はこの用途を扱えません`);
    // 🔑 既定が無い／使えないなら、**その用途を扱える最初の提供元**へ落とす。
    //    「既定が壊れていたので送れない」より「使えるものを使う」ほうが利用者の意図に近い。
    const fallback = providers.find((p) => p.models[cap]);
    const chosen = hit || fallback;
    if (chosen) defaults[cap] = chosen.id;
  }
  return { providers, defaults, problems };
}

/** 現在の構成（未読なら読む）。ファイルが無ければ出荷時の構成。 */
function get() {
  if (config) return config;
  let raw = BUILT_IN;
  if (filePath && fs.existsSync(filePath)) {
    try {
      raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (e) {
      console.error(`[ai] ${FILE_NAME} を読めません。出荷時の構成で続けます:`, e.message);
      raw = BUILT_IN;
    }
  }
  config = normalize(raw);
  if (config.providers.length === 0) {
    console.error(`[ai] 使える提供元がありません。出荷時の構成へ戻します: ${config.problems.join(" / ")}`);
    config = normalize(BUILT_IN);
  }
  return config;
}

/**
 * 構成を保存する。**検査を通したものだけを書く。**
 *
 * @returns {{ok: boolean, problems: string[]}}
 */
function save(raw) {
  const next = normalize(raw);
  if (next.providers.length === 0) {
    return { ok: false, problems: next.problems.length ? next.problems : ["使える提供元がありません"] };
  }
  if (!filePath) return { ok: false, problems: ["保存先が未設定です"] };
  try {
    fs.writeFileSync(
      filePath,
      JSON.stringify({ providers: next.providers, defaults: next.defaults }, null, 2),
      { encoding: "utf8", mode: 0o600 },
    );
  } catch (e) {
    return { ok: false, problems: [`書き込めません: ${e.message}`] };
  }
  config = next;
  return { ok: true, problems: next.problems };
}

/**
 * 用途 → どこへ何で送るか。
 *
 * @returns {{ok: true, provider: object, model: string} | {ok: false, error: string}}
 */
function resolve(capability) {
  if (!CAPABILITIES.includes(capability)) return { ok: false, error: "unsupported-capability" };
  const c = get();
  const id = c.defaults[capability];
  const provider = c.providers.find((p) => p.id === id);
  // 🔴 「この用途を扱える提供元が無い」と「用途そのものが無い」は案内が違う。
  if (!provider) return { ok: false, error: "no-provider-for-capability" };
  return { ok: true, provider, model: provider.models[capability] };
}

module.exports = {
  CAPABILITIES,
  ID_RE,
  KINDS,
  BUILT_IN,
  LEGACY_SECRET_KEY,
  FILE_NAME,
  init,
  get,
  save,
  resolve,
  normalize,
  secretKeyFor,
  secretKeyCandidates,
};
