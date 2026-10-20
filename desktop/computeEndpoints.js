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
const SCHEMA_VERSION = 2;
const MAX_ENDPOINTS = 16;
const MAX_LABEL = 64;
const KINDS = new Set(["jupyter", "colab"]);
/** Colab の RuntimeSpec の値（VARIANT_GPU・T4・SHAPE_STANDARD など）。 */
const SPEC_VALUE_RE = /^[A-Z0-9_]{1,32}$/;

/** 「この PC」の Python の設定。接続先の配列ではなく最上位の `local` に置く（接続先の選び方・backend への送り先に乗せない）。 */
const AUTO_LOCAL = Object.freeze({ python: Object.freeze({ mode: "auto" }) });

/** 既定の計算機に「この PC」を選ぶときの id（接続先の一覧には載らない。起動ごとに URL とトークンが変わる）。 */
const LOCAL_ID = "local";

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

/**
 * `local` を検査して正規形へ。不正なら auto として扱い、理由を problems に積む（黙って消さない）。
 * Python のパスは絶対パス・NUL なしだけ。通常ファイルかどうかは選んだ時点で main が確かめる。
 */
function normalizeLocal(raw) {
  if (raw === undefined || raw === null) return { local: { python: { mode: "auto" } }, problems: [] };
  const py = raw && typeof raw === "object" && !Array.isArray(raw) ? raw.python : undefined;
  if (py === undefined) return { local: { python: { mode: "auto" } }, problems: [] };
  if (!py || typeof py !== "object" || Array.isArray(py)) return { local: { python: { mode: "auto" } }, problems: ["local:bad-python"] };
  if (py.mode === "auto") return { local: { python: { mode: "auto" } }, problems: [] };
  if (py.mode === "path") {
    const p = py.path;
    const ok = typeof p === "string" && p.length > 0 && p.length <= 1024 && !p.includes("\0") && (path.isAbsolute(p) || path.win32.isAbsolute(p));
    if (!ok) return { local: { python: { mode: "auto" } }, problems: ["local:bad-python-path"] };
    return { local: { python: { mode: "path", path: p } }, problems: [] };
  }
  return { local: { python: { mode: "auto" } }, problems: ["local:bad-python-mode"] };
}

/**
 * `defaultId`（利用者が「既定にする」で選んだ計算機）を検査する。
 * undefined＝キーが無い（未移行。移行の判定は computeDefault 側が旧規則で行う）／null＝自動／文字列＝その id。
 * 形が不正なら自動として扱い、理由を problems に積む（黙って消さない）。
 */
function normalizeDefaultId(raw) {
  if (raw === undefined) return { defaultId: undefined, problems: [] };
  if (raw === null) return { defaultId: null, problems: [] };
  if (typeof raw === "string" && (raw === LOCAL_ID || ID_RE.test(raw))) return { defaultId: raw, problems: [] };
  return { defaultId: null, problems: ["default:bad-id"] };
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
  // v1（schemaVersion 無し）の `local` は無いので auto。読むだけでは書き換えない
  const v = raw && typeof raw === "object" ? raw.schemaVersion : undefined;
  const tooNew = typeof v === "number" && v > SCHEMA_VERSION;
  const loc = v === undefined || v === 1 ? { local: AUTO_LOCAL, problems: [] } : normalizeLocal(raw.local);
  const def = normalizeDefaultId(raw && typeof raw === "object" ? raw.defaultId : undefined);
  config = { ...config, local: loc.local, defaultId: def.defaultId, problems: [...(loadError ? [loadError] : []), ...(tooNew ? [`config:schema-too-new:${v}`] : []), ...config.problems, ...loc.problems, ...def.problems] };
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
  // 新しい版のファイルを古い形で上書きしない
  const cur = get();
  const tooNew = cur.problems.find((p) => p.startsWith("config:schema-too-new"));
  if (tooNew) return { ok: false, problems: [tooNew] };
  // 🔴 渡されなかった `local` は今の値を引き継ぐ（接続先を編集しただけで Python の設定が消えない）
  let local = cur.local;
  if (raw && raw.local !== undefined) {
    const l = normalizeLocal(raw.local);
    if (l.problems.length > 0) return { ok: false, problems: l.problems };
    local = l.local;
  }
  // 🔴 同じく、渡されなかった `defaultId` は今の値を引き継ぐ（未移行＝undefined のままなら書かない）
  let defaultId = cur.defaultId;
  if (raw && raw.defaultId !== undefined) {
    const d = normalizeDefaultId(raw.defaultId);
    if (d.problems.length > 0) return { ok: false, problems: d.problems };
    defaultId = d.defaultId;
  }
  // 消した接続先を指したままにしない（宙に浮いた id は自動として扱うが、ファイルにも残さない）
  if (typeof defaultId === "string" && defaultId !== LOCAL_ID && !next.endpoints.some((e) => e.id === defaultId)) defaultId = null;
  return write(next, local, defaultId);
}

function write(next, local, defaultId) {
  try {
    fs.writeFileSync(
      filePath,
      JSON.stringify(
        { schemaVersion: SCHEMA_VERSION, endpoints: next.endpoints.map(toStored), local, ...(defaultId === undefined ? {} : { defaultId }) },
        null,
        2,
      ),
      { encoding: "utf8", mode: 0o600 },
    );
  } catch (e) {
    return { ok: false, problems: [`config:write-failed:${e.message}`] };
  }
  config = { ...next, local, defaultId };
  return { ok: true, problems: [] };
}

/**
 * Python の設定だけを書く（接続先は今の値を引き継ぐ）。ファイルが読めない・新しい版のときは書かない。
 * 🔴 送り先の確認は呼び出し側（main）が済ませてから呼ぶ。
 */
function setLocalPython(py) {
  if (!filePath) return { ok: false, problems: ["config:no-destination"] };
  const cur = get();
  const blocked = cur.problems.find((p) => p.startsWith("config:"));
  if (blocked) return { ok: false, problems: [blocked] };
  const l = normalizeLocal({ python: py });
  if (l.problems.length > 0) return { ok: false, problems: l.problems };
  return write({ endpoints: cur.endpoints, problems: cur.problems }, l.local, cur.defaultId);
}

/**
 * 既定の計算機だけを書く（null＝自動）。接続先・Python の設定は今の値を引き継ぐ。ファイルが読めない・新しい版のときは書かない。
 * 新しい送り先は増えないので確認は要らないが、登録簿に在る id か "local" だけ受ける。
 */
function setDefaultId(id) {
  if (!filePath) return { ok: false, problems: ["config:no-destination"] };
  const cur = get();
  const blocked = cur.problems.find((p) => p.startsWith("config:"));
  if (blocked) return { ok: false, problems: [blocked] };
  const d = normalizeDefaultId(id === undefined ? null : id);
  if (d.problems.length > 0) return { ok: false, problems: d.problems };
  if (typeof d.defaultId === "string" && d.defaultId !== LOCAL_ID && !cur.endpoints.some((e) => e.id === d.defaultId)) {
    return { ok: false, problems: ["default:unknown-endpoint"] };
  }
  return write({ endpoints: cur.endpoints, problems: cur.problems }, cur.local, d.defaultId);
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
  LOCAL_ID,
  MAX_ENDPOINTS,
  init,
  get,
  save,
  setLocalPython,
  setDefaultId,
  validate,
  byId,
  normalize,
  parseUrl,
  secretKeyFor,
  destinationOf,
};
