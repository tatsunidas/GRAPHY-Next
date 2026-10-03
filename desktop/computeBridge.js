// Electron main → backend の内部経路（/api/internal/compute/**）。設計: fw/remote-compute-design.md §4.1
//
// main は backend を起動するときに起動ごとの乱数（GRAPHY_MAIN_SECRET）を環境変数で渡し、
// 内部経路はそれを Bearer で示した要求だけを通す（backend の MainChannelFilter）。
// **レンダラはこの値を知らない**——preload にも IPC にも出さない。
//
// トークンの平文が main の外へ出る経路はここだけで、行き先は自分の backend（loopback）に限る。
// backend はメモリにだけ持つ。

const crypto = require("node:crypto");

let secret = null;
let apiBase = null;

/** 起動ごとの乱数を作る（外から渡されていればそれを使う＝backend を別に起動する開発用）。 */
function createSecret(fromEnv) {
  if (typeof fromEnv === "string" && fromEnv.length >= 32) return fromEnv;
  return crypto.randomBytes(32).toString("hex");
}

function init({ secret: s, apiBase: base }) {
  secret = s || null;
  // 🔴 自分の backend にだけ送る（apiBase は main 自身が組み立てた localhost の URL）
  const u = new URL(base);
  if (u.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)) {
    throw new Error(`computeBridge: not a loopback backend: ${base}`);
  }
  apiBase = `${u.protocol}//${u.host}`;
}

function enabled() {
  return !!(secret && apiBase);
}

async function call(method, pathname, body, timeoutMs = 15000) {
  if (!enabled()) return { ok: false, status: 0, error: "main-channel-disabled" };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`${apiBase}${pathname}`, {
      method,
      headers: { Authorization: `Bearer ${secret}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctl.signal,
    });
    let json = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    return { ok: res.ok, status: res.status, body: json };
  } catch (e) {
    return { ok: false, status: 0, error: e && e.name === "AbortError" ? "timeout" : String(e && e.message) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 接続先をトークン込みで backend へ丸ごと入れる。
 * @param list [{ id, label, url, token, kind }]（jupyter はトークンを secretStore から、colab は確保したランタイムから）
 */
async function pushEndpoints(list) {
  const r = await call("PUT", "/api/internal/compute/endpoints", { endpoints: list });
  if (!r.ok) {
    // トークンは出さない（id だけ）
    console.error(`[compute] backend への接続先の登録に失敗 (status=${r.status} ${r.error || ""}):`,
      r.body && r.body.problems ? r.body.problems : "");
  }
  return r;
}

/** 接続テスト（backend が固定のコードだけを実行する）。 */
async function testEndpoint(id) {
  const r = await call("POST", `/api/internal/compute/endpoints/${encodeURIComponent(id)}/test`, null, 120000);
  if (r.ok && r.body) return r.body;
  return {
    ok: false,
    stage: "bridge",
    error: r.error || `backend-${r.status}`,
    httpStatus: 0,
    kernels: [],
    probe: null,
    elapsedMs: 0,
  };
}

/** 同意画面に出す内容（backend が確定したもの）を取り直す。レンダラが渡した内容は使わない。 */
async function getEgress(id) {
  return call("GET", `/api/internal/compute/egress/${encodeURIComponent(id)}`);
}

/** 同意画面の結果を返す。承認は見せた内容のハッシュを添える（backend が今の内容と突き合わせる）。 */
async function decideEgress(id, approve, contentHash) {
  return call("POST", `/api/internal/compute/egress/${encodeURIComponent(id)}/decision`, {
    approve: approve === true,
    contentHash: approve ? contentHash : null,
  });
}

module.exports = { createSecret, init, enabled, pushEndpoints, testEndpoint, getEgress, decideEgress };
