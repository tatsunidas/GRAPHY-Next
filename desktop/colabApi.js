// Colab API v1beta（公式・allowlist 制）。設計: fw/remote-compute-design.md §15
//
// 使うのは公開されている v1beta だけ。非公開の /tun/m や colab.pa.googleapis.com は使わない（ToS）。
// 形は実測（2026-10-03）と、Colab の VS Code 拡張（colab-api.json）に合わせた:
//   GET  /v1beta/subscription           → { tier }
//   GET  /v1beta/runtimespecs           → { runtimeSpecs: [{ key: {variant, accelerator, shape}, eligible }] }
//   GET  /v1beta/runtimes               → { runtimes: [Runtime] }
//   POST /v1beta/runtimes?requestId=…   → Operation（GET /v1/operations/{id}:wait で待つ）
//   GET  /v1beta/runtimes/{id}          → Runtime（connectionInfo: url / token / expireTime）
//   DELETE /v1beta/runtimes/{id}        → {}
// エラーは Operation の error（ErrorInfo の reason）に入る。

const crypto = require("node:crypto");

const API = "https://colaboratory.googleapis.com";
const AGENT = { "X-Colab-Client-Agent": "graphy-next" };
const CREATE_DEADLINE_MS = 4 * 60 * 1000;

class ColabError extends Error {
  /** @param code 画面で訳す理由（gpu-unavailable / too-many-runtimes / quota-exceeded / denylisted / http-401 …） */
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.code = code;
  }
}

/** @param accessToken () => Promise<string|null> */
function createColabApi(accessToken, doFetch = fetch) {
  async function call(method, path, body) {
    const token = await accessToken();
    if (!token) throw new ColabError("not-signed-in");
    const r = await doFetch(API + path, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...AGENT, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    let json = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = {};
    }
    if (!r.ok) {
      const msg = json && json.error && json.error.message;
      throw new ColabError(r.status === 401 ? "http-401" : r.status === 404 ? "not-found" : `http-${r.status}`, msg);
    }
    return json;
  }

  /** Operation の error を理由のコードにする（VS Code 拡張の throwIfOperationError と同じ読み方）。 */
  function operationError(err, spec) {
    const reasons = (err.details || []).map((d) => d && d.reason).filter(Boolean);
    if (reasons.includes("TOO_MANY_ACTIVE_RUNTIMES")) return new ColabError("too-many-runtimes", err.message);
    if (reasons.includes("QUOTA_EXCEEDED_USAGE_TIME")) return new ColabError("quota-exceeded", err.message);
    if (reasons.includes("DENYLISTED")) return new ColabError("denylisted", err.message);
    // GPU の在庫切れには専用の reason が無い。FAILED_PRECONDITION（9）× アクセラレータ指定で判断する
    if (err.code === 9 && spec && spec.accelerator && spec.accelerator !== "NONE") {
      return new ColabError("gpu-unavailable", err.message);
    }
    return new ColabError(`operation-${err.code}`, err.message);
  }

  return {
    subscription: () => call("GET", "/v1beta/subscription"),
    async runtimeSpecs() {
      const j = await call("GET", "/v1beta/runtimespecs");
      return (j.runtimeSpecs || []).map((s) => ({ ...s.key, eligible: s.eligible === true }));
    },
    async listRuntimes() {
      return (await call("GET", "/v1beta/runtimes")).runtimes || [];
    },
    /** ランタイムを確保する（LRO を待つ）。@returns Runtime */
    async createRuntime(spec) {
      let op = await call("POST", `/v1beta/runtimes?requestId=${crypto.randomUUID()}`, {
        runtimeSpec: { variant: spec.variant, accelerator: spec.accelerator, shape: spec.shape },
      });
      const t0 = Date.now();
      while (!op.done) {
        if (Date.now() - t0 > CREATE_DEADLINE_MS) throw new ColabError("create-timeout");
        const id = String(op.name || "").replace(/^operations\//, "");
        if (!/^[A-Za-z0-9-]+$/.test(id)) throw new ColabError("bad-operation", op.name);
        op = await call("GET", `/v1/operations/${id}:wait?timeout=60s`);
      }
      if (op.error) throw operationError(op.error, spec);
      if (!op.response || !op.response.name) throw new ColabError("no-runtime-in-response");
      return op.response;
    },
    /** 接続トークンの取り直しもこれ（専用の口は無い）。 */
    getRuntime: (name) => call("GET", `/v1beta/${runtimePath(name)}`),
    deleteRuntime: (name) => call("DELETE", `/v1beta/${runtimePath(name)}?allowMissing=true`),
  };
}

/** `runtimes/<id>` の形だけ通す（パスに余計なものを混ぜない）。 */
function runtimePath(name) {
  if (typeof name !== "string" || !/^runtimes\/[A-Za-z0-9-]{1,128}$/.test(name)) {
    throw new ColabError("bad-runtime-name", String(name));
  }
  return name;
}

module.exports = { createColabApi, ColabError };
