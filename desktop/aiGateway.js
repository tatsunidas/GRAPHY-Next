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

/**
 * 提供元。**段 3 で `ai-providers.json` から読む**ようになる（設計 §4）。
 * いまは 1 つだけを定数で持つ——提供元が 1 つのうちに契約を提供元非依存へ変えるのが段 2 の目的で、
 * 「契約の変更」と「提供元の増加」を同時にやらないため。
 */
const PROVIDER = { id: "gemini-public", kind: gemini.KIND, adapter: gemini };
const HOST = "generativelanguage.googleapis.com";
const SECRET_KEY = "ai.gemini.apiKey";
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

function postJson(pathname, apiKey, bodyObj) {
  const body = Buffer.from(JSON.stringify(bodyObj), "utf8");
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: HOST,
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
  const apiKey = secretStore.getSecret(SECRET_KEY);
  if (!apiKey) return { ok: false, error: "no-api-key" };
  if (!req || !validModel(req.model)) return { ok: false, error: "invalid-model" };
  const apiVersion = req.apiVersion == null ? PROVIDER.adapter.DEFAULT_API_VERSION : req.apiVersion;
  if (!validApiVersion(apiVersion)) return { ok: false, error: "invalid-api-version" };
  if (typeof req.prompt !== "string" || req.prompt.length === 0) return { ok: false, error: "empty-prompt" };
  if (typeof req.imageBase64 !== "string" || req.imageBase64.length === 0) return { ok: false, error: "empty-image" };
  if (req.imageBase64.length > MAX_IMAGE_BYTES) return { ok: false, error: "image-too-large" };
  // 🔴 扱えない用途は**送る前に**断る。送ってから「できません」と返るのでは課金が発生する。
  if (req.capability && !PROVIDER.adapter.supports(req.capability)) {
    return { ok: false, error: "unsupported-capability", kind: "capability" };
  }
  if (inFlight) return { ok: false, error: "busy" };

  const { path, body } = PROVIDER.adapter.buildRequest({ ...req, apiVersion });
  const provenance = {
    providerId: PROVIDER.id,
    kind: PROVIDER.kind,
    model: req.model,
    endpointHost: HOST,
  };

  inFlight = true;
  try {
    const res = await postJson(path, apiKey, body);
    if (res.statusCode !== 200) {
      const msg = (res.json && res.json.error && res.json.error.message) || res.text || `HTTP ${res.statusCode}`;
      // 認証失敗だけは呼び出し側で「鍵を入れ直して」と案内したいので区別する。
      const kind = res.statusCode === 400 || res.statusCode === 401 || res.statusCode === 403 ? "auth-or-request" : "http";
      console.error(`[ai] ${PROVIDER.id} エラー ${res.statusCode}:`, mask(msg, apiKey));
      return { ok: false, error: mask(msg, apiKey), status: res.statusCode, kind };
    }
    if (!res.json) return { ok: false, error: "invalid-json", status: 200 };

    const norm = PROVIDER.adapter.normalize(res.json);
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

module.exports = { generate, SECRET_KEY, MAX_IMAGE_BYTES };
