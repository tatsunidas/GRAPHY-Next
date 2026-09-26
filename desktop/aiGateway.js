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

const aiHttp = require("./aiHttp");
const secretStore = require("./secretStore");
const gemini = require("./aiAdapters/gemini");
const openai = require("./aiAdapters/openai");
const aiProviders = require("./aiProviders");

/** `kind` → アダプタ。提供元を足すときはここに 1 行足す（設計 §4.2）。 */
const ADAPTERS = {
  [gemini.KIND]: gemini,
  [openai.KIND]: openai,
  [openai.KIND_AZURE]: openai,
};

/** 旧名（`statusOf` の既存呼び出し互換のために公開したまま）。 */
const SECRET_KEY = aiProviders.LEGACY_SECRET_KEY;
/** 送信画像の上限。これを超えるものはプラグイン側の縮小漏れなので、ここで弾く。 */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/** 同時実行は 1 本に限る。誤操作や暴走ループで課金が積み上がるのを防ぐ。 */
let inFlight = false;

/**
 * モデル名の形。**入る場所で厳しさを変える。**
 *
 * <p>🔴 **URL のパスに入るときは厳格**（パス・インジェクション防止）。Gemini は常にパス、
 * Azure はデプロイ名をパスに入れる。
 * <p>🔑 **body に入るときはスラッシュを許す。** OpenRouter 系のモデル名は `openai/gpt-4o` の形で、
 * 厳格側だけで検査していると**足せるはずの提供元が登録できない**（一般化を妨げていた 1 つ）。
 * それでも制御文字・引用符・空白は許さない（JSON の中に入るため）。
 */
function validModel(model, inPath) {
  if (typeof model !== "string" || model.length === 0 || model.length > 120) return false;
  return inPath ? /^[A-Za-z0-9._-]+$/.test(model) : /^[A-Za-z0-9._\-\/:]+$/.test(model);
}

/**
 * API バージョンも URL パスに入るので同様に検査する。
 * 既定を v1beta にしてあるのは、新モデルの機能が先に載るのが常に v1beta 側だから。
 * 公式ドキュメントの例は v1 を使うので、必要なら設定から切り替えられるようにしてある。
 */
function validApiVersion(v) {
  // 🔑 使わない提供元もある（OpenAI の公開 API はパスに版を持たない）。未指定は許す。
  //    Azure の `2024-10-21` のような日付形も通す必要がある。
  if (v == null) return true;
  // 🔴 `..` はパス要素に入ると 1 つ上の階層を指す。`.` を許しているので明示的に弾く。
  if (typeof v !== "string" || v.includes("..")) return false;
  return /^[A-Za-z0-9][A-Za-z0-9.-]{0,31}$/.test(v);
}

/**
 * エラー文からキーを消す。Google のエラー本文がリクエストを反射することがあるため、
 * 例外メッセージをそのまま UI やログへ流すと鍵が漏れうる。
 */
function mask(text, key) {
  let s = String(text == null ? "" : text);
  // 🔴 **長さの下限を付けない。** 短い鍵（試験用の値や院内サーバの簡易鍵）が素通りする。
  if (key) s = s.split(key).join("***REDACTED***");
  s = scrubSecrets(s);
  return s.length > 2000 ? `${s.slice(0, 2000)}…` : s;
}

/**
 * 鍵らしい文字列を消す。
 *
 * <p>🔑 **鍵そのものと一致しなくても消す。** 提供元が鍵を一部だけ（`sk-abc…XYZ`）返すことがあり、
 * `auth.header` を設定で選べる以上、**相手が本文に反射する経路を全部は読めない**。
 * だから形で消す。
 */
function scrubSecrets(text) {
  return String(text)
    .replace(/\b(sk|xai|gsk|sk-ant|sk-proj)-[A-Za-z0-9_-]{6,}/g, "***REDACTED***")
    .replace(/\bAIza[0-9A-Za-z_-]{10,}/g, "***REDACTED***")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]{6,}=*/gi, "Bearer ***REDACTED***");
}

// 送出は aiHttp.js（テストで差し替えられるようにモジュール越しに呼ぶ）。
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
  if (!validModel(model, adapter.modelInPath(provider))) return { ok: false, error: "invalid-model" };
  const apiVersion = resolveApiVersion(provider, adapter, req);
  if (!validApiVersion(apiVersion)) return { ok: false, error: "invalid-api-version" };
  if (typeof req.prompt !== "string" || req.prompt.length === 0) return { ok: false, error: "empty-prompt" };
  if (typeof req.imageBase64 !== "string" || req.imageBase64.length === 0) return { ok: false, error: "empty-image" };
  if (req.imageBase64.length > MAX_IMAGE_BYTES) return { ok: false, error: "image-too-large" };
  if (inFlight) return { ok: false, error: "busy" };

  const target = targetOf(provider);
  const built = adapter.buildRequest({ ...req, model, apiVersion, apiKey, provider });
  if (built.error) return { ok: false, error: built.error, kind: "capability" };
  const provenance = {
    providerId: provider.id,
    kind: provider.kind,
    model,
    endpointHost: target.display,
    // 🔑 平文で送ったことは作品の由来として残す（院内ホストだけ起こりうる）。
    ...(target.plaintext ? { plaintext: true } : {}),
  };

  inFlight = true;
  try {
    const res = await aiHttp.post(target, built.path, built.headers, built.body);
    if (res.statusCode !== 200) {
      const msg = (res.json && res.json.error && res.json.error.message) || res.text || `HTTP ${res.statusCode}`;
      // 認証失敗だけは呼び出し側で「鍵を入れ直して」と案内したいので区別する。
      const kind = res.statusCode === 400 || res.statusCode === 401 || res.statusCode === 403 ? "auth-or-request" : "http";
      console.error(`[ai] ${provider.id} エラー ${res.statusCode}:`, mask(msg, apiKey));
      return { ok: false, error: mask(msg, apiKey), status: res.statusCode, kind };
    }
    if (!res.json) return { ok: false, error: "invalid-json", status: 200 };

    const norm = adapter.normalize(res.json);
    // 🔴 **何も取れていないのに成功を返さない。** 200 が返っても中身が読めないことがある
    //    （`paths` が別の API を指している等）。成功として返すと、プラグインは
    //    「成功したが何も無い」を受け取り、**設定の誤りが成功として報告される**。
    if (!norm.image && !norm.text && !norm.blockReason) {
      console.error(`[ai] ${provider.id}: 応答から画像も文章も取れませんでした`);
      return { ok: false, error: "empty-response", status: 200, data: res.json };
    }
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
  // 旧来の呼び出し（0.3.0 のプラグイン）。モデルは呼び出し側の指定を使うが、
  // **宛先は既定の提供元**。
  const fallback = aiProviders.resolve("image-to-image");
  if (!fallback.ok) return { ok: false, error: fallback.error, kind: "capability" };
  const adapter = ADAPTERS[fallback.provider.kind];
  if (!adapter) return { ok: false, error: "unknown-provider-kind", kind: "capability" };
  // 🔴 **用途が無い呼び出しを、Gemini 以外へ流さない。** あの形は
  //    `responseModalities` で「何を返してほしいか」を言う Gemini の語彙で、
  //    他社の電文には対応する概念が無い。**勝手に画像生成へ読み替えると、
  //    文章が欲しかった呼び出しで画像を作って課金する。**
  if (!adapter.acceptsLegacyRequest) {
    return { ok: false, error: "unsupported-capability", kind: "capability" };
  }
  return { ok: true, provider: fallback.provider, adapter, model: req.model };
}

/**
 * 使う API バージョンを決める。
 *
 * <p>🔴 **提供元の設定がいちばん強い。** これは宛先（URL）に入る値であり、
 * 「宛先は本体が決める」（§3.1）の一部だから——呼び出し側に決めさせない。
 * <p>🔴 **プラグインの指定は Gemini のときだけ見る。** `apiVersion` は Gemini の語彙で入った
 * 項目なので、そのまま Azure へ渡すと `?api-version=v1beta` で 404 になる。
 * 用途なし呼び出しを Gemini 以外へ流さないのと同じ理由（黙って無視し、エラーにはしない
 * ——0.3.0 のプラグインを止めないため）。
 */
function resolveApiVersion(provider, adapter, req) {
  if (provider.apiVersion != null) return provider.apiVersion;
  if (req.apiVersion != null && adapter.acceptsLegacyRequest) return req.apiVersion;
  return adapter.DEFAULT_API_VERSION;
}

/** その提供元の鍵。出荷時の Gemini は旧名も見る（版を上げて鍵が消えたように見えるのを防ぐ）。 */
function secretForProvider(providerId) {
  for (const key of aiProviders.secretKeyCandidates(providerId)) {
    const v = secretStore.getSecret(key);
    if (v) return v;
  }
  return null;
}

/**
 * 提供元の宛先。**ホスト名・ポート・平文かどうかを分けて持つ。**
 *
 * <p>🔑 `display` は画面（同意ダイアログ）とログに出す表記。**ポートを含める**——
 * 同じホストの別ポートに別のモデルが立っていることがあり、宛先が同じに見えてはいけない。
 */
function targetOf(provider) {
  const endpoint = provider.endpoint;
  try {
    const u = new URL(endpoint);
    const plaintext = u.protocol === "http:";
    return {
      hostname: u.hostname,
      port: u.port ? Number(u.port) : plaintext ? 80 : 443,
      plaintext,
      display: u.host,
    };
  } catch {
    const host = String(endpoint).replace(/^https?:\/\//, "");
    return { hostname: host, port: 443, plaintext: false, display: host };
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
    endpointHost: targetOf(r.provider).display,
    // 🔑 画面（同意ダイアログ）が「平文で出ます」と言えるようにする。
    ...(r.provider.plaintext ? { plaintext: true } : {}),
    hasApiKey: !!secretForProvider(r.provider.id),
  };
}

// ── 接続テスト（疎通確認） ─────────────────────────────────────────────────
//
// 🔑 **なぜ要るのか。** 利用者が自分で提供元を足せる形にした以上、**私たちが全社を事前に
// 検証することはできない**（各社の API は版が変わる）。だから「登録したら押して確かめる」
// 手段を本体が持つ。これが無いと、最初の 1 回が必ず患者画像での試行になり、
// 失敗しても原因（鍵・パス・応答の形）が切り分けられない。
//
// 🔴 **呼び出し側は「どの提供元の・どの用途か」しか決められない。** 送る指示と画像は
//    ここにある定数。プラグインも同じレンダラに居るのでこの口を呼べてしまうが、
//    **内容を決められないので患者画像は絶対に出ない**——これが安全性の根拠。

/** 送る画像。**1×1 の白 1 枚**（69 バイト）。患者画像は使わない。 */
const TEST_IMAGE_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC";
const TEST_IMAGE_MIME = "image/png";
/** 送る指示。**短く・当たり障りがなく・返答の形が読みやすいもの。** */
const TEST_PROMPT = "Reply with OK.";
/** 連続で押されたときの最短間隔。課金と相手への負荷を抑える。 */
const TEST_MIN_INTERVAL_MS = 3000;
let lastTestAt = 0;

/** HTTP の結果を「何を直せばよいか」へ写す。 */
function verdictForStatus(status) {
  if (status === 401 || status === 403) return "auth-failed";
  if (status === 404) return "not-found";
  if (status === 400 || status === 422) return "bad-request";
  if (status === 429) return "rate-limited";
  if (status >= 500) return "server-error";
  return "http-error";
}

/** 例外を「何を直せばよいか」へ写す。 */
function verdictForError(message) {
  const m = String(message || "");
  if (/タイムアウト|ETIMEDOUT|ESOCKETTIMEDOUT/i.test(m)) return "timeout";
  if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|DEPTH_ZERO/i.test(m)) return "tls";
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH/i.test(m)) return "network";
  return "network";
}

/**
 * 1 度だけ実物の API へ送って、電文が通るかを確かめる。
 *
 * <p>返すのは**診断に必要な最小限**。🔴 **ヘッダは名前だけ**（値は絶対に返さない——
 * 認証ヘッダ名を設定で選べる以上、どのヘッダに鍵が載るか固定できない）。
 *
 * @param {{providerId: string, capability: string}} args
 */
async function testConnection(args) {
  const providerId = args && args.providerId;
  const capability = args && args.capability;
  const provider = aiProviders.byId(providerId);
  if (!provider) return { ok: false, verdict: "config", error: "unknown-provider" };
  if (!aiProviders.CAPABILITIES.includes(capability)) {
    return { ok: false, verdict: "config", error: "unsupported-capability" };
  }
  const model = provider.models[capability];
  if (!model) return { ok: false, verdict: "config", error: "no-provider-for-capability" };
  const adapter = ADAPTERS[provider.kind];
  if (!adapter || !adapter.supports(capability)) {
    return { ok: false, verdict: "config", error: "unsupported-capability" };
  }
  const apiKey = secretForProvider(provider.id);
  if (!apiKey) return { ok: false, verdict: "no-api-key", error: "no-api-key" };
  if (!validModel(model, adapter.modelInPath(provider))) {
    return { ok: false, verdict: "config", error: "invalid-model" };
  }
  // 🔴 本番の送信と同じ 1 本の錠を使う（試験連打で生成が止まる／その逆を防ぐ）。
  if (inFlight) return { ok: false, verdict: "busy", error: "busy" };
  const since = Date.now() - lastTestAt;
  if (since < TEST_MIN_INTERVAL_MS) {
    return { ok: false, verdict: "too-soon", error: "too-soon", retryAfterMs: TEST_MIN_INTERVAL_MS - since };
  }

  const apiVersion = resolveApiVersion(provider, adapter, {});
  const target = targetOf(provider);
  // 🔑 **`generate()` と同じ組み立てを通す。** 別経路で組むと、設定の効き方を確かめられない。
  const built = adapter.buildRequest({
    capability,
    model,
    apiVersion,
    apiKey,
    prompt: TEST_PROMPT,
    imageBase64: TEST_IMAGE_BASE64,
    mimeType: TEST_IMAGE_MIME,
    provider,
  });
  if (built.error) return { ok: false, verdict: "config", error: built.error };

  const requestLine = `POST ${target.plaintext ? "http" : "https"}://${target.display}${built.path}`;
  const headerNames = Object.keys(built.headers).map((k) => k.toLowerCase()).sort();
  console.log(`[ai] connection-test provider=${provider.id} host=${target.display} capability=${capability}`);

  inFlight = true;
  lastTestAt = Date.now();
  const startedAt = Date.now();
  try {
    const res = await aiHttp.post(target, built.path, built.headers, built.body);
    const elapsedMs = Date.now() - startedAt;
    const bodyPreview = mask(res.text, apiKey).replace(/[\u0000-\u001f]+/g, " ").slice(0, 1000);
    if (res.statusCode !== 200) {
      const msg = (res.json && res.json.error && res.json.error.message) || res.text || `HTTP ${res.statusCode}`;
      return {
        ok: false, verdict: verdictForStatus(res.statusCode), status: res.statusCode, elapsedMs,
        requestLine, headerNames, bodyPreview, plaintext: target.plaintext || undefined,
        error: mask(msg, apiKey),
      };
    }
    const norm = res.json ? adapter.normalize(res.json) : {};
    const base = {
      status: 200, elapsedMs, requestLine, headerNames, bodyPreview,
      plaintext: target.plaintext || undefined,
    };
    if (norm.image) return { ok: true, verdict: "reachable", imageBytes: norm.image.base64.length, ...base };
    if (norm.text) return { ok: true, verdict: "reachable", text: mask(norm.text, apiKey).slice(0, 200), ...base };
    if (norm.blockReason) return { ok: true, verdict: "blocked", blockReason: norm.blockReason, ...base };
    // 200 なのに読めない＝**別の API を指している**ことが多い（`paths` の設定間違い）。
    return { ok: false, verdict: "unreadable-response", error: "empty-response", ...base };
  } catch (e) {
    const message = mask(e && e.message, apiKey);
    return {
      ok: false, verdict: verdictForError(message), error: message,
      elapsedMs: Date.now() - startedAt, requestLine, headerNames,
      plaintext: target.plaintext || undefined,
    };
  } finally {
    inFlight = false;
  }
}

module.exports = {
  generate,
  resolveCapability,
  testConnection,
  SECRET_KEY,
  MAX_IMAGE_BYTES,
  TEST_PROMPT,
  TEST_IMAGE_BASE64,
  TEST_MIN_INTERVAL_MS,
};
