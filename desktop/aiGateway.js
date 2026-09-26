// 外部 AI へのリクエストを中継する層。電文の組み立てと応答の正規化は
// aiAdapters/<kind>.js が持つ（設計: fw/ai-routing-design.md）。
//
// なぜ main プロセスに置くのか:
//   製品ビルドの CSP（frontend/vite.config.ts の cspPlugin）が
//   `connect-src 'self' http://localhost:* http://127.0.0.1:*` を注入するため、
//   レンダラから generativelanguage.googleapis.com へは到達できない。
//   しかも **dev では CSP を注入しない**ので、レンダラ直叩きは「開発では動くが
//   配布ビルドだけ壊れる」という最悪の壊れ方をする（v0.2.1〜v0.2.3 の実例）。
//   既存の graphy:check-update（api.github.com）が同じ理由で main に居る。
//
// ここでやらないこと（意図的に）:
//   レスポンスの解釈・画像デコード・プロンプト組み立ては一切しない。
//   それらは全部プラグイン側の TypeScript に置いて vitest で試験する。
//   main.js には単体テストの仕組みが無いため、テストできない層を厚くしない。

const https = require("node:https");
const secretStore = require("./secretStore");
const gemini = require("./aiAdapters/gemini");
const aiProviders = require("./aiProviders");

/** `kind` → アダプタ。提供元を足すときはここに 1 行足す（設計 §4.2）。 */
const ADAPTERS = { [gemini.KIND]: gemini };

/** 旧名（`statusOf` の既存呼び出し互換のために公開したまま）。 */
const SECRET_KEY = aiProviders.LEGACY_SECRET_KEY;
const TIMEOUT_MS = 120000;
/** 画像生成のレスポンスは base64 で数 MB になる。青天井にはしない。 */
const MAX_RESPONSE_BYTES = 20 * 1024 * 1024;
/** 送信画像の上限。これを超えるものはプラグイン側の縮小漏れなので、ここで弾く。 */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/** 同時実行は 1 本に限る。誤操作や暴走ループで課金が積み上がるのを防ぐ。 */
let inFlight = false;

/** URL パスに入る値なので、モデル名は形を検査する（パス・インジェクション防止）。 */
function validModel(model) {
  return typeof model === "string" && model.length > 0 && model.length <= 120 && /^[A-Za-z0-9._-]+$/.test(model);
}

/**
 * API バージョンも URL パスに入るので同様に検査する。
 * 既定を v1beta にしてあるのは、新モデルの機能が先に載るのが常に v1beta 側だから。
 * 公式ドキュメントの例は v1 を使うので、必要なら設定から切り替えられるようにしてある。
 */
function validApiVersion(v) {
  return typeof v === "string" && /^v[0-9]+[A-Za-z0-9]*$/.test(v);
}

/**
 * エラー文からキーを消す。Google のエラー本文がリクエストを反射することがあるため、
 * 例外メッセージをそのまま UI やログへ流すと鍵が漏れうる。
 */
function mask(text, key) {
  let s = String(text == null ? "" : text);
  if (key && key.length >= 8) s = s.split(key).join("***REDACTED***");
  return s.length > 2000 ? `${s.slice(0, 2000)}…` : s;
}

function postJson(host, pathname, apiKey, bodyObj) {
  const body = Buffer.from(JSON.stringify(bodyObj), "utf8");
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host,
        path: pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": body.length,
          "User-Agent": "GRAPHY-Next",
          "x-goog-api-key": apiKey,
        },
        timeout: TIMEOUT_MS,
      },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on("data", (c) => {
          size += c.length;
          if (size > MAX_RESPONSE_BYTES) {
            res.destroy();
            reject(new Error(`レスポンスが上限(${MAX_RESPONSE_BYTES} バイト)を超えました`));
            return;
          }
          chunks.push(c);
        });
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            /* 下で statusCode とともに扱う */
          }
          resolve({ statusCode: res.statusCode, json, text });
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error(`タイムアウト(${TIMEOUT_MS} ms)`)));
    req.end(body);
  });
}

/**
 * 画像 1 枚 ＋ 指示を送り、**提供元非依存の形**で返す。
 *
 * <p>🔑 応答の解釈はアダプタが行う。以前は生 JSON をそのまま返し、プラグインが
 * `candidates[].content.parts[]` を読んでいた——提供元が増えるとプラグインごとに
 * 解釈が生えるので、ここへ寄せた（設計 §3.2）。
 *
 * @param {{capability?: string, model: string, apiVersion?: string, prompt: string,
 *          imageBase64: string, mimeType: string, responseModalities?: string[],
 *          temperature?: number, providerOptions?: object}} req
 * @returns {Promise<object>} **例外を投げずに結果で返す。**
 *   鍵入りのスタックトレースが IPC 境界を越えるのを避けるため。
 */
async function generate(req) {
  if (!req) return { ok: false, error: "empty-request" };

  // 🔴 **宛先とモデルは本体が決める。** プラグインが名指ししてきても、用途が来ていれば
  //    レジストリの解決を優先する——宛先を呼び出し側に決めさせない（設計 §3.1）。
  const plan = resolvePlan(req);
  if (!plan.ok) return plan;
  const { provider, adapter, model } = plan;

  const apiKey = secretForProvider(provider.id);
  if (!apiKey) return { ok: false, error: "no-api-key" };
  if (!validModel(model)) return { ok: false, error: "invalid-model" };
  const apiVersion = req.apiVersion == null ? adapter.DEFAULT_API_VERSION : req.apiVersion;
  if (!validApiVersion(apiVersion)) return { ok: false, error: "invalid-api-version" };
  if (typeof req.prompt !== "string" || req.prompt.length === 0) return { ok: false, error: "empty-prompt" };
  if (typeof req.imageBase64 !== "string" || req.imageBase64.length === 0) return { ok: false, error: "empty-image" };
  if (req.imageBase64.length > MAX_IMAGE_BYTES) return { ok: false, error: "image-too-large" };
  if (inFlight) return { ok: false, error: "busy" };

  const host = hostOf(provider.endpoint);
  const { path, body } = adapter.buildRequest({ ...req, model, apiVersion });
  const provenance = { providerId: provider.id, kind: provider.kind, model, endpointHost: host };

  inFlight = true;
  try {
    const res = await postJson(host, path, apiKey, body);
    if (res.statusCode !== 200) {
      const msg = (res.json && res.json.error && res.json.error.message) || res.text || `HTTP ${res.statusCode}`;
      // 認証失敗だけは呼び出し側で「鍵を入れ直して」と案内したいので区別する。
      const kind = res.statusCode === 400 || res.statusCode === 401 || res.statusCode === 403 ? "auth-or-request" : "http";
      console.error(`[ai] ${provider.id} エラー ${res.statusCode}:`, mask(msg, apiKey));
      return { ok: false, error: mask(msg, apiKey), status: res.statusCode, kind };
    }
    if (!res.json) return { ok: false, error: "invalid-json", status: 200 };

    const norm = adapter.normalize(res.json);
    return {
      ok: true,
      image: norm.image,
      text: norm.text,
      blockReason: norm.blockReason,
      provenance,
      // @deprecated 移行期間だけ残す。0.3.0 で配ったプラグインが自分で解釈するため。
      data: res.json,
    };
  } catch (e) {
    console.error("[ai] 送信に失敗:", mask(e && e.message, apiKey));
    return { ok: false, error: mask(e && e.message, apiKey) };
  } finally {
    inFlight = false;
  }
}

/**
 * 用途 → 提供元・アダプタ・モデル。
 *
 * <p>用途が来ていなければ**旧来の呼び出し**（プラグインがモデルを名指し）として扱い、
 * 既定の提供元へ送る——0.3.0 で配ったプラグインを動かし続けるため。
 */
function resolvePlan(req) {
  const capability = req.capability;
  if (capability) {
    const r = aiProviders.resolve(capability);
    // 🔴 扱えない用途は**送る前に**断る。送ってから「できません」と返るのでは課金が発生する。
    if (!r.ok) return { ok: false, error: r.error, kind: "capability" };
    const adapter = ADAPTERS[r.provider.kind];
    if (!adapter) return { ok: false, error: "unknown-provider-kind", kind: "capability" };
    if (!adapter.supports(capability)) return { ok: false, error: "unsupported-capability", kind: "capability" };
    return { ok: true, provider: r.provider, adapter, model: r.model };
  }
  // 旧来の呼び出し。モデルは呼び出し側の指定を使うが、**宛先は既定の提供元**。
  const fallback = aiProviders.resolve("image-to-image");
  if (!fallback.ok) return { ok: false, error: fallback.error, kind: "capability" };
  const adapter = ADAPTERS[fallback.provider.kind];
  if (!adapter) return { ok: false, error: "unknown-provider-kind", kind: "capability" };
  return { ok: true, provider: fallback.provider, adapter, model: req.model };
}

/** その提供元の鍵。出荷時の Gemini は旧名も見る（版を上げて鍵が消えたように見えるのを防ぐ）。 */
function secretForProvider(providerId) {
  for (const key of aiProviders.secretKeyCandidates(providerId)) {
    const v = secretStore.getSecret(key);
    if (v) return v;
  }
  return null;
}

/** `https://host` からホスト名だけを取る。検査済みなので失敗しない前提。 */
function hostOf(endpoint) {
  try {
    return new URL(endpoint).host;
  } catch {
    return endpoint.replace(/^https:\/\//, "");
  }
}

/**
 * レンダラが同意ダイアログを出す前に「どこへ何で送るか」を知るための問い合わせ。
 *
 * <p>🔑 **解決の権限は main に 1 つ。** レンダラ側で同じ計算を持つと、
 * 同意画面に出す宛先と実際の宛先がずれる余地ができる。
 *
 * @returns {{ok: true, providerId: string, kind: string, model: string, endpointHost: string,
 *            hasApiKey: boolean} | {ok: false, error: string}}
 */
function resolveCapability(capability) {
  const r = aiProviders.resolve(capability);
  if (!r.ok) return { ok: false, error: r.error };
  return {
    ok: true,
    providerId: r.provider.id,
    label: r.provider.label,
    kind: r.provider.kind,
    model: r.model,
    endpointHost: hostOf(r.provider.endpoint),
    hasApiKey: !!secretForProvider(r.provider.id),
  };
}

module.exports = { generate, resolveCapability, SECRET_KEY, MAX_IMAGE_BYTES };
