// 外部 AI の提供元レジストリ。設計: fw/ai-routing-design.md §4・§14
//
// 持っているのは「どこへ・どのモデルで・どんな電文の作法で送るか」だけ。
// **鍵は持たない**（secretStore が持つ）。
//
// 🔴 **backend の Settings に置かない。** `GET /api/settings` が平文で全件返すため、
//    レンダラ・プラグイン・DB バックアップ・ログの全経路から読める。AI は元から desktop 専用
//    （`host.ai` は web で desktop-only を返す）なので、設定も main に置く。
//
// 🔑 **ここが検査の正本。** 送信側（aiGateway・アダプタ）で検査を二重に持たないこと——
//    ずれたときに「保存はできるが送信だけ失敗する設定」が作れてしまう。
//
// 🔴 **`electron` を import しないこと。** desktop/ のテストは `node --test` で
//    **npm install 無し**に走る。electron に触るとファイルごと落ちる。

const fs = require("node:fs");
const path = require("node:path");

const FILE_NAME = "ai-providers.json";

/**
 * 設定ファイルの版。**形を変えたときに「読めない」と「古い」を区別するため**に持つ
 * （持っていないと、将来の版で読めなかったときに出荷時構成へ黙って戻るしかない）。
 */
const SCHEMA_VERSION = 1;

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

/**
 * 既知の電文の形。`kind` がアダプタ（電文の組み立てと応答の解釈）を決める。
 *
 * <p>`openai` と `azure-openai` は同じ実装だが、**パスと認証が別**なので kind を分けてある。
 * 🔑 **`azure-openai` を `pathStyle` に畳まない**（§14）——既存の設定ファイル・テスト・文書が
 * 一斉に変わるうえ、`save()` が正規化結果を書き戻すので**利用者のファイルが黙って新形式になり、
 * 版を戻せなくなる**。`pathStyle` は `kind:"openai"` の任意の上書きとしてだけ足す。
 */
const KINDS = new Set(["gemini", "openai", "azure-openai"]);

/** パスの組み方。`kind` の既定を上書きしたいときだけ書く。 */
const PATH_STYLES = new Set(["openai", "azure-deployment"]);

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

/** 提供元 1 件で認める項目。ここに無いものは「無視した」と problems に出す。 */
const KNOWN_PROVIDER_FIELDS = new Set([
  "id", "label", "kind", "endpoint", "auth", "models",
  "pathStyle", "apiVersion", "paths", "headers",
]);

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

// ── エンドポイント ────────────────────────────────────────────────────────

/**
 * 平文 http を許すホストか。
 *
 * <p>🔴 **利用者の判断（2026-09-27）で院内アドレスまで許す。** 目的は自分で立てた
 * Ollama / vLLM / LM Studio を登録できること。**院内 LAN を患者画素が平文で流れる**ことに
 * なるので、この提供元には画面と同意ダイアログに**平文の印**を出す（`plaintext: true`）。
 *
 * <p>許すのは「外へ出ない見込みのある宛先」だけ: ループバック・RFC1918・
 * 単一ラベル名（`aiserver` のような社内名）・`.local` / `.internal` / `.lan` / `.home.arpa`。
 * **それ以外の名前と公開 IP で http は許さない**（インターネットへ平文で出る）。
 */
function allowsPlainHttp(hostname) {
  const h = String(hostname || "").toLowerCase();
  if (!h) return false;
  if (h === "localhost" || h === "::1" || h === "127.0.0.1") return true;
  if (h.endsWith(".localhost")) return true;
  // IPv4 リテラル。127.0.0.0/8 と RFC1918 のみ。
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 127) return true;
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    return false; // 公開 IP へ平文では出さない
  }
  if (/^[0-9a-f:]+$/.test(h)) return false; // その他の IPv6 リテラルは許さない
  if (!h.includes(".")) return true; // 単一ラベル＝社内名
  return /\.(local|internal|lan|home\.arpa)$/.test(h);
}

/**
 * エンドポイントを解析して正規形へ。**scheme ＋ host ＋ port だけ**を持つ。
 *
 * <p>🔴 **パスを受け付けない。** 以前は `https://host/v1` が検査を通り、送出側は host しか
 * 使わないので **`/v1` が黙って捨てられていた**——「別の場所へ送る」形の失敗になる。
 * パスは `paths` で明示的に書く。
 *
 * @returns {{ok:true, endpoint:string, hostname:string, port:number, plaintext:boolean}
 *          |{ok:false, reason:string}}
 */
function parseEndpoint(raw) {
  if (typeof raw !== "string" || !raw.trim()) return { ok: false, reason: "endpoint-missing" };
  let u;
  try {
    u = new URL(raw.trim());
  } catch {
    return { ok: false, reason: "endpoint-unparsable" };
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return { ok: false, reason: "endpoint-scheme" };
  if (!u.hostname) return { ok: false, reason: "endpoint-no-host" };
  // 🔴 認証情報つき URL は鍵の置き場所を増やすだけなので受け付けない（黙って捨てるのも駄目）。
  if (u.username || u.password) return { ok: false, reason: "endpoint-has-credentials" };
  if (u.search) return { ok: false, reason: "endpoint-has-query" };
  if (u.hash) return { ok: false, reason: "endpoint-has-fragment" };
  if (u.pathname.replace(/\/+$/, "") !== "") return { ok: false, reason: "endpoint-has-path" };
  const plaintext = u.protocol === "http:";
  if (plaintext && !allowsPlainHttp(u.hostname)) return { ok: false, reason: "endpoint-plain-http" };
  const port = u.port ? Number(u.port) : plaintext ? 80 : 443;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, reason: "endpoint-bad-port" };
  return { ok: true, endpoint: `${u.protocol}//${u.host}`, hostname: u.hostname, port, plaintext };
}

// ── 認証・ヘッダ・パス ────────────────────────────────────────────────────

/** ヘッダ名の形（RFC の token より狭く取る。小文字で保存する）。 */
const HEADER_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** ヘッダ値は印字可能 ASCII のみ（CR/LF/TAB/非 ASCII を入れない）。 */
const HEADER_VALUE_RE = /^[\x20-\x7E]{0,1024}$/;

/**
 * 設定で書かせないヘッダ。
 *
 * <p>🔴 **`host` がいちばん危険**——差し替えると、同意ダイアログが出す送信先
 * （解決後の `endpoint`）と**実際に届く先が乖離する**。§5 の「同意に宛先を含める」が設定で壊れる。
 * <p>🔴 **認証ヘッダも書かせない**。鍵は `auth.header` ＋ キーチェーンで扱う。ここに書けると
 * **鍵が `ai-providers.json` に平文で入り、`ai-providers-get` でレンダラ（＝プラグイン）へ返る**。
 */
const HOP_BY_HOP_HEADERS = new Set([
  "host", "content-length", "content-type", "transfer-encoding", "connection",
  "expect", "upgrade", "te", "trailer", "keep-alive",
]);
const FORBIDDEN_HEADERS = new Set([
  ...HOP_BY_HOP_HEADERS,
  "authorization", "proxy-authorization", "api-key", "x-api-key",
  "x-goog-api-key", "x-goog-user-project",
]);

/** 値が鍵に見えるか。**設定ファイルへ鍵を書かせない**ための門。 */
function looksLikeSecret(value) {
  const v = String(value || "");
  if (/^(sk|xai|gsk|sk-ant|sk-proj)-[A-Za-z0-9_-]{8,}/.test(v)) return true;
  if (/^AIza[0-9A-Za-z_-]{10,}/.test(v)) return true;
  if (/^Bearer\s+\S+/i.test(v)) return true;
  if (v.length > 32 && /^[A-Za-z0-9_-]+$/.test(v)) return true;
  return false;
}

/**
 * 認証の載せ方。**未指定ならアダプタの既定**（`gemini` は `x-goog-api-key`、
 * `openai` は `Authorization: Bearer `）。
 *
 * <p>旧い形（`"auth": "api-key"` という文字列）も受け付ける——既存のファイルを壊さないため。
 *
 * @returns {{ok:true, auth: object|string|undefined} | {ok:false, reason:string}}
 */
function validateAuth(raw) {
  if (raw == null) return { ok: true, auth: undefined };
  if (typeof raw === "string") {
    // 旧形式。意味は持たない（認証はアダプタの既定）ので、そのまま保持して先へ通す。
    return raw === "api-key" ? { ok: true, auth: "api-key" } : { ok: false, reason: "auth-unknown" };
  }
  if (!isPlainObject(raw)) return { ok: false, reason: "auth-not-an-object" };
  const out = {};
  if (raw.header != null) {
    const name = String(raw.header).trim().toLowerCase();
    if (!HEADER_NAME_RE.test(name)) return { ok: false, reason: "auth-header-name" };
    // 🔑 `authorization` / `api-key` 系は**認証ヘッダとしてなら当然許す**（FORBIDDEN_HEADERS は
    //    追加ヘッダ用の表なので、ここでは使わない）。禁止するのは電文の骨格を壊すものだけ。
    if (HOP_BY_HOP_HEADERS.has(name)) return { ok: false, reason: `auth-header-not-allowed:${name}` };
    out.header = name;
  }
  if (raw.prefix != null) {
    const prefix = String(raw.prefix);
    if (!/^[\x20-\x7E]{0,16}$/.test(prefix)) return { ok: false, reason: "auth-prefix" };
    out.prefix = prefix;
  }
  return { ok: true, auth: Object.keys(out).length ? out : undefined };
}

/**
 * 追加ヘッダ。**UI には出さない**（§14）——自由記入欄を出すと利用者は必ず鍵を貼るため。
 * JSON を手で書く人のためだけに受理する。
 *
 * @returns {{headers: object|undefined, problems: string[]}}
 */
function validateHeaders(raw) {
  const problems = [];
  if (raw == null) return { headers: undefined, problems };
  if (!isPlainObject(raw)) return { headers: undefined, problems: ["headers-not-an-object"] };
  const out = {};
  let count = 0;
  for (const [k, v] of Object.entries(raw)) {
    const name = String(k).trim().toLowerCase();
    if (!HEADER_NAME_RE.test(name)) { problems.push(`header-name:${String(k).slice(0, 32)}`); continue; }
    if (FORBIDDEN_HEADERS.has(name) || name.startsWith("proxy-") || name.startsWith(":")) {
      problems.push(`header-not-allowed:${name}`); continue;
    }
    // 🔴 大小違いの重複（`X-Foo` と `x-foo`）は送出時に後勝ちになるので、ここで弾く。
    if (Object.prototype.hasOwnProperty.call(out, name)) { problems.push(`header-duplicate:${name}`); continue; }
    const value = typeof v === "string" ? v : String(v);
    if (!HEADER_VALUE_RE.test(value)) { problems.push(`header-value:${name}`); continue; }
    if (looksLikeSecret(value)) { problems.push(`header-looks-like-secret:${name}`); continue; }
    if (++count > 8) { problems.push("header-too-many"); break; }
    out[name] = value;
  }
  return { headers: Object.keys(out).length ? out : undefined, problems };
}

/**
 * パスの上書き。**固定文字列の完全置換のみ。**
 *
 * <p>🔴 **`{model}` のような差し込みを入れない。** 入れた瞬間に「電文を記述する小さな言語」が
 * 始まり、エンコードの問題が戻ってくる（利用者と「作らない」と決めた境界線・§14）。
 * <p>🔴 **クエリを許さない。** アダプタが `apiVersion` から作る `?api-version=` と合成すると
 * `?a=b?api-version=` という壊れた URL になり、原因が設定かアダプタか分からない失敗になる。
 *
 * @returns {{paths: object|undefined, problems: string[]}}
 */
function validatePaths(raw, models) {
  const problems = [];
  if (raw == null) return { paths: undefined, problems };
  if (!isPlainObject(raw)) return { paths: undefined, problems: ["paths-not-an-object"] };
  const out = {};
  for (const cap of CAPABILITIES) {
    const p = raw[cap];
    if (p == null || p === "") continue;
    const s = String(p);
    if (!s.startsWith("/")) { problems.push(`path-not-absolute:${cap}`); continue; }
    if (s.startsWith("//")) { problems.push(`path-protocol-relative:${cap}`); continue; }
    if (s.includes("..")) { problems.push(`path-dotdot:${cap}`); continue; }
    if (s.includes("?") || s.includes("#")) { problems.push(`path-has-query:${cap}`); continue; }
    if (s.includes("%")) { problems.push(`path-has-escape:${cap}`); continue; }
    if (!/^\/[A-Za-z0-9._~\-/]{0,255}$/.test(s)) { problems.push(`path-chars:${cap}`); continue; }
    // 🔑 その用途のモデルが無いのにパスだけ在るのは矛盾（送る先はあるが送るものが無い）。
    if (!models[cap]) { problems.push(`path-without-model:${cap}`); continue; }
    out[cap] = s;
  }
  return { paths: Object.keys(out).length ? out : undefined, problems };
}

/** API バージョン。URL のパスかクエリに入るので形を見る。 */
function validApiVersionValue(v) {
  if (v == null) return true;
  if (typeof v !== "string" || v.includes("..")) return false;
  return /^[A-Za-z0-9][A-Za-z0-9.-]{0,31}$/.test(v);
}

// ── 提供元 1 件 ───────────────────────────────────────────────────────────

/**
 * 1 件の提供元を検査する。**壊れた 1 件で全体を捨てない**（他の提供元は使えるべき）。
 *
 * @returns {{ok: true, provider: object, problems: string[]} | {ok: false, reason: string}}
 */
function validateProvider(p) {
  if (!isPlainObject(p)) return { ok: false, reason: "not-an-object" };
  if (typeof p.id !== "string" || !ID_RE.test(p.id)) return { ok: false, reason: "invalid-id" };
  if (!KINDS.has(p.kind)) return { ok: false, reason: `unknown-kind:${p.kind}` };

  const ep = parseEndpoint(p.endpoint);
  if (!ep.ok) return { ok: false, reason: ep.reason };

  if (!isPlainObject(p.models)) return { ok: false, reason: "no-models" };
  const models = {};
  for (const cap of CAPABILITIES) {
    const m = p.models[cap];
    // 空文字は「その用途は使えない」と同じ扱い。**推測で埋めない。**
    if (typeof m === "string" && m.trim()) models[cap] = m.trim();
  }
  if (Object.keys(models).length === 0) return { ok: false, reason: "no-usable-capability" };

  const auth = validateAuth(p.auth);
  if (!auth.ok) return { ok: false, reason: auth.reason };

  if (p.pathStyle != null && !PATH_STYLES.has(p.pathStyle)) {
    return { ok: false, reason: `unknown-path-style:${p.pathStyle}` };
  }
  if (!validApiVersionValue(p.apiVersion)) return { ok: false, reason: "invalid-api-version" };

  const problems = [];
  const h = validateHeaders(p.headers);
  problems.push(...h.problems);
  const pa = validatePaths(p.paths, models);
  problems.push(...pa.problems);

  // 🔑 知らない項目は**黙って消さない**。save() は正規化結果を書き戻すので、
  //    手で書いた項目が消えたことを利用者が知る必要がある。
  for (const key of Object.keys(p)) {
    if (!KNOWN_PROVIDER_FIELDS.has(key)) problems.push(`ignored-field:${key}`);
  }

  const provider = {
    id: p.id,
    label: typeof p.label === "string" && p.label.trim() ? p.label.trim() : p.id,
    kind: p.kind,
    endpoint: ep.endpoint,
    models,
  };
  if (auth.auth !== undefined) provider.auth = auth.auth;
  if (p.pathStyle != null) provider.pathStyle = p.pathStyle;
  if (p.apiVersion != null) provider.apiVersion = p.apiVersion;
  if (pa.paths) provider.paths = pa.paths;
  if (h.headers) provider.headers = h.headers;
  // 送出側と画面が使う。**保存はしない**（endpoint から毎回決まるので二重に持たない）。
  if (ep.plaintext) provider.plaintext = true;
  return { ok: true, provider, problems };
}

/** 保存するときの形（実行時にだけ意味がある項目を落とす）。 */
function toStored(provider) {
  const { plaintext, ...rest } = provider;
  return rest;
}

/**
 * 構成を検査して整える。**読めない部分は捨てて、残りで動かす。**
 *
 * <p>⚠ 「設定が壊れていたので何もしない」は、利用者から見ると原因不明の沈黙になる。
 * 捨てたものは `problems` で返して呼び出し元が見せられるようにする。
 *
 * <p>🔑 `problems` の各要素は**機械可読なコード**（`provider:<id>:<code>`）。
 * 画面側が i18n で文にする——ここに日本語を書くと en に切り替えても日本語が出る。
 */
function normalize(raw) {
  const problems = [];
  const providers = [];
  const seen = new Set();
  if (isPlainObject(raw) && raw.schemaVersion != null && Number(raw.schemaVersion) > SCHEMA_VERSION) {
    problems.push(`config:schema-too-new:${raw.schemaVersion}`);
  }
  const list = isPlainObject(raw) && Array.isArray(raw.providers) ? raw.providers : [];
  for (const p of list) {
    const id = isPlainObject(p) && typeof p.id === "string" ? p.id : "?";
    const r = validateProvider(p);
    if (!r.ok) {
      problems.push(`provider:${id}:${r.reason}`);
      continue;
    }
    if (seen.has(r.provider.id)) {
      problems.push(`provider:${r.provider.id}:duplicate-id`);
      continue;
    }
    for (const code of r.problems) problems.push(`provider:${r.provider.id}:${code}`);
    seen.add(r.provider.id);
    providers.push(r.provider);
  }

  const defaults = {};
  const rawDefaults = isPlainObject(raw) && isPlainObject(raw.defaults) ? raw.defaults : {};
  for (const cap of CAPABILITIES) {
    const want = rawDefaults[cap];
    const hit = providers.find((p) => p.id === want && p.models[cap]);
    if (want && !hit) problems.push(`default:${cap}:capability-not-supported:${want}`);
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
  let loadError = null;
  if (filePath && fs.existsSync(filePath)) {
    try {
      raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (e) {
      // 🔴 **黙って出荷時構成へ戻さない。** 戻すだけだと利用者には
      //    「Grok を書いたのに Gemini に送られる、理由は不明」に見える。
      //    ⚠ JSON にコメント（`//`）は書けない。いちばん多い壊れ方がこれ。
      loadError = `config:parse-error:${e.message}`;
      console.error(`[ai] ${FILE_NAME} を読めません。出荷時の構成で続けます:`, e.message);
      raw = BUILT_IN;
    }
  }
  config = normalize(raw);
  if (config.providers.length === 0) {
    console.error(`[ai] 使える提供元がありません。出荷時の構成へ戻します: ${config.problems.join(" / ")}`);
    const fallback = normalize(BUILT_IN);
    config = { ...fallback, problems: [...config.problems, "config:fell-back-to-built-in"] };
  }
  if (loadError) config = { ...config, problems: [loadError, ...config.problems] };
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
    return { ok: false, problems: next.problems.length ? next.problems : ["config:no-usable-provider"] };
  }
  if (!filePath) return { ok: false, problems: ["config:no-destination"] };
  try {
    fs.writeFileSync(
      filePath,
      JSON.stringify(
        { schemaVersion: SCHEMA_VERSION, providers: next.providers.map(toStored), defaults: next.defaults },
        null,
        2,
      ),
      { encoding: "utf8", mode: 0o600 },
    );
  } catch (e) {
    return { ok: false, problems: [`config:write-failed:${e.message}`] };
  }
  config = next;
  return { ok: true, problems: next.problems };
}

/**
 * 検査だけ行う（**書かない**）。設定画面が入力中に叩く。
 *
 * <p>🔴 **検査規則をレンダラ側に書き写さないため。** 二重に持つと必ずずれ、
 * 「画面では通るのに保存で消える」が起きる。
 */
function validate(raw) {
  const next = normalize(raw);
  return {
    ok: next.providers.length > 0,
    providers: next.providers,
    defaults: next.defaults,
    problems: next.problems,
  };
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

/**
 * id で 1 件引く。**接続テストに必要**（既定でない提供元も試せないと意味がない）。
 */
function byId(id) {
  if (typeof id !== "string" || !ID_RE.test(id)) return null;
  return get().providers.find((p) => p.id === id) || null;
}

module.exports = {
  CAPABILITIES,
  ID_RE,
  KINDS,
  PATH_STYLES,
  BUILT_IN,
  LEGACY_SECRET_KEY,
  SCHEMA_VERSION,
  FILE_NAME,
  init,
  get,
  save,
  validate,
  resolve,
  byId,
  normalize,
  secretKeyFor,
  secretKeyCandidates,
  allowsPlainHttp,
  parseEndpoint,
};
