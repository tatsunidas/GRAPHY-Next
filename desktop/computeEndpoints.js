// 外部の計算機（Jupyter Server）の接続先。設計: fw/remote-compute-design.md §4
//
// 置き場所は aiProviders と同じく Electron main（`<dataDir>/compute-endpoints.json`）。
// backend の設定（H2 の平文行・`GET /api/settings` が全件返す）には置かない。
// トークンはここに書かず secretStore（`compute.endpoint.<id>.token`）に預ける。
//
// 🔴 **検査規則はここに 1 つだけ。** 設定画面は validate() を IPC で叩く（レンダラに書き写さない）。
//    backend（JupyterEndpoint）も同じ規則で検査し直す——平文 http の判定は aiProviders.allowsPlainHttp を使う。

const fs = require("node:fs");
const path = require("node:path");
const { ID_RE, allowsPlainHttp } = require("./aiProviders");

const FILE_NAME = "compute-endpoints.json";
const SCHEMA_VERSION = 1;
const MAX_ENDPOINTS = 16;
const MAX_LABEL = 64;
const KINDS = new Set(["jupyter", "colab"]);
/** Colab の RuntimeSpec の値（VARIANT_GPU・T4・SHAPE_STANDARD など）。 */
const SPEC_VALUE_RE = /^[A-Z0-9_]{1,32}$/;

let filePath = null;
let config = null;

function init(dataDir) {
  filePath = path.join(dataDir, FILE_NAME);
  config = null;
}

/** その接続先のトークンを預けるキー名（secretStore の allowlist と同じ形）。 */
function secretKeyFor(id) {
  return `compute.endpoint.${id}.token`;
}

/**
 * URL を検査して正規形へ。
 *
 * <p>AI の提供元と違い**パスを許す**（JupyterHub は `/user/<name>/` の下に居る）。
 * クエリ・フラグメント・URL 内の認証情報は受け付けない（`?token=` を URL に書かせない。
 * トークンの置き場所が増えると、ログや画面に平文で出る経路が増える）。
 *
 * @returns {{ok:true, url:string, hostname:string, plaintext:boolean}|{ok:false, reason:string}}
 */
function parseUrl(raw) {
  if (typeof raw !== "string" || !raw.trim()) return { ok: false, reason: "url-missing" };
  let u;
  try {
    u = new URL(raw.trim());
  } catch {
    return { ok: false, reason: "url-unparsable" };
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return { ok: false, reason: "url-scheme" };
  if (!u.hostname) return { ok: false, reason: "url-no-host" };
  if (u.username || u.password) return { ok: false, reason: "url-has-credentials" };
  if (u.search) return { ok: false, reason: "url-has-query" };
  if (u.hash) return { ok: false, reason: "url-has-fragment" };
  const plaintext = u.protocol === "http:";
  if (plaintext && !allowsPlainHttp(u.hostname)) return { ok: false, reason: "url-plain-http" };
  let p = u.pathname || "/";
  if (!p.endsWith("/")) p += "/";
  if (p.split("/").some((s) => s === ".." || s === ".")) return { ok: false, reason: "url-bad-path" };
  return { ok: true, url: `${u.protocol}//${u.host}${p}`, hostname: u.hostname, plaintext };
}

function validateEndpoint(e) {
  if (!e || typeof e !== "object" || Array.isArray(e)) return { ok: false, reason: "not-an-object" };
  if (typeof e.id !== "string" || !ID_RE.test(e.id)) return { ok: false, reason: "bad-id" };
  const kind = e.kind === undefined ? "jupyter" : e.kind;
  if (!KINDS.has(kind)) return { ok: false, reason: "bad-kind" };
  const label = typeof e.label === "string" && e.label.trim() ? e.label.trim().slice(0, MAX_LABEL) : e.id;
  if (kind === "colab") {
    // Colab は URL を持たない（ランタイムを確保するたびに Colab が決める）。持つのはランタイムの種類だけ
    const s = e.spec || {};
    if (![s.variant, s.accelerator, s.shape].every((v) => typeof v === "string" && SPEC_VALUE_RE.test(v))) {
      return { ok: false, reason: "bad-colab-spec" };
    }
    return {
      ok: true,
      endpoint: { id: e.id, label, kind, spec: { variant: s.variant, accelerator: s.accelerator, shape: s.shape } },
    };
  }
  const u = parseUrl(e.url);
  if (!u.ok) return { ok: false, reason: u.reason };
  return { ok: true, endpoint: { id: e.id, label, kind, url: u.url, ...(u.plaintext ? { plaintext: true } : {}) } };
}

/** 検査して正規形へ。悪いものは落として理由を problems に積む。 */
function normalize(raw) {
  const list = raw && Array.isArray(raw.endpoints) ? raw.endpoints : [];
  const endpoints = [];
  const problems = [];
  const seen = new Set();
  for (const e of list) {
    const r = validateEndpoint(e);
    const id = e && typeof e.id === "string" ? e.id : "?";
    if (!r.ok) {
      problems.push(`${id}:${r.reason}`);
      continue;
    }
    if (seen.has(r.endpoint.id)) {
      problems.push(`${id}:duplicate-id`);
      continue;
    }
    if (endpoints.length >= MAX_ENDPOINTS) {
      problems.push(`${id}:too-many`);
      continue;
    }
    seen.add(r.endpoint.id);
    endpoints.push(r.endpoint);
  }
  return { endpoints, problems };
}

/** 現在の構成。ファイルが無ければ空（出荷時の接続先は持たない）。 */
function get() {
  if (config) return config;
  let raw = { endpoints: [] };
  let loadError = null;
  if (filePath && fs.existsSync(filePath)) {
    try {
      raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (e) {
      // 黙って空に戻さない（「登録したのに消えた、理由は不明」にしない）
      loadError = `config:parse-error:${e.message}`;
      console.error(`[compute] ${FILE_NAME} を読めません:`, e.message);
    }
  }
  config = normalize(raw);
  if (loadError) config = { ...config, problems: [loadError, ...config.problems] };
  return config;
}

/**
 * 保存する。**1 件でも不正なら書かない**（落として保存すると、利用者の書いた接続先が黙って消える）。
 * @returns {{ok:boolean, problems:string[]}}
 */
function save(raw) {
  const next = normalize(raw);
  if (next.problems.length > 0) return { ok: false, problems: next.problems };
  if (!filePath) return { ok: false, problems: ["config:no-destination"] };
  try {
    fs.writeFileSync(
      filePath,
      JSON.stringify({ schemaVersion: SCHEMA_VERSION, endpoints: next.endpoints.map(toStored) }, null, 2),
      { encoding: "utf8", mode: 0o600 },
    );
  } catch (e) {
    return { ok: false, problems: [`config:write-failed:${e.message}`] };
  }
  config = next;
  return { ok: true, problems: [] };
}

function toStored(e) {
  return e.kind === "colab"
    ? { id: e.id, label: e.label, kind: e.kind, spec: e.spec }
    : { id: e.id, label: e.label, kind: e.kind, url: e.url };
}

/** 検査だけ（書かない）。設定画面が入力中に叩く。 */
function validate(raw) {
  const next = normalize(raw);
  return { ok: next.problems.length === 0, endpoints: next.endpoints, problems: next.problems };
}

function byId(id) {
  if (typeof id !== "string" || !ID_RE.test(id)) return null;
  return get().endpoints.find((e) => e.id === id) || null;
}

/** 「送信先としての同一性」。ここが変わる保存は main が利用者に聞く。 */
function destinationOf(e) {
  // Colab の宛先は Google の Colab（*.prod.colab.dev）で、ランタイムの種類が変わっても送り先は同じ
  if (e.kind === "colab") return JSON.stringify({ kind: "colab" });
  return JSON.stringify({ kind: e.kind || "jupyter", url: e.url });
}

module.exports = {
  FILE_NAME,
  MAX_ENDPOINTS,
  init,
  get,
  save,
  validate,
  byId,
  normalize,
  parseUrl,
  secretKeyFor,
  destinationOf,
};
