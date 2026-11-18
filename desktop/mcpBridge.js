// MCP の受け口（main が持つ）。設計: roadmap fw/mcp-server-design.md §4。electron に依存しない（`node --test` で走る）。
// 中継 `graphy-mcp`（stdio）はここへ HTTP で転送するだけ。射影・同意・監査・引数の検査・拒否リストはすべてここと mcpTools / mcpProjection にある。
//
//   GET  /v1/tools                   → { tools: [...] }              （現在の設定で見せるツール）
//   POST /v1/call  { tool, args }    → { ok: true, result } | { ok: false, error }
//   ヘッダ: Authorization: Bearer <トークン> / X-Graphy-Mcp-Client: <クライアントの自称名>
//
// 🔴 `enabled` の間だけ 127.0.0.1 の乱数ポートで待ち受ける。受ける条件: Bearer（定数時間の比較）・Host が localhost・`Origin` 無し・送信元が loopback。
//    どれかが外れたら 404（存在を明かさない。MainChannelFilter と同じ）。
// 🔴 トークンは起動ごとに作る。発見用ファイルは有効な間だけ置き、止めるとき・終了時に消す。
// 🔴 最初の接続（クライアント名ごと・起動ごと）に利用者の同意を取る。拒否したら、その起動中は受けない。
// 🔴 backend の本文（エラー含む）は返さない（患者情報が入り得る）。返すのは射影済みの結果か、固定の符号だけ。
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const T = require("./mcpTools");
const { createProjector } = require("./mcpProjection");
const { oneLine } = require("./mcpAudit");

const MAX_BODY = 64 * 1024;
const MAX_RESULT = 512 * 1024;
const MAX_CONCURRENT = 4;
const { safeError: viewerError } = require("./mcpViewerControl");
const LOCAL_HOST_RE = /^(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/i;

function tokenEquals(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/**
 * @param {object} o
 * @param {{get(): {enabled:boolean,includePhi:boolean,allowAnalysis:boolean}}} o.prefs
 * @param {{append(r: object): void}} o.audit
 * @param {(method: string, path: string, opts: {query?: object, body?: object}) => Promise<{status:number, json:any}>} o.backend
 * @param {(clientName: string) => Promise<boolean>} o.confirmClient  最初の接続の同意（main が描く）
 * @param {string} o.discoveryFile  userData/mcp-endpoint.json
 * @param {(kind: string, ctx: {client: string, includePhi: boolean, allowViewerEdit: boolean}, desc: {kind: string, id?: string, params?: object}) => Promise<{ok: boolean, state?: any, measurements?: any, control?: any, error?: string}>} [o.viewer]  2D ビューア窓から読む・操作する（main が viewerRelay で中継。kind は mcpTools.VIEWER_KINDS の固定リストだけ。action の id は VIEWER_ACTIONS だけ）
 */
function createMcpBridge({ prefs, audit, backend, confirmClient, discoveryFile, viewer, newToken = () => crypto.randomBytes(32).toString("hex") }) {
  let server = null;
  let token = null;
  let projector = null;
  let projectorPhi = null;
  let active = 0;
  const decisions = new Map(); // クライアント名 → Promise<boolean>（起動ごと。同時の要求は同じ問いを共有する）

  function projectorFor(includePhi) {
    if (!projector || projectorPhi !== includePhi) {
      projector = createProjector({ includePhi });
      projectorPhi = includePhi;
    }
    return projector;
  }

  function consent(client) {
    if (!decisions.has(client)) {
      decisions.set(
        client,
        Promise.resolve()
          .then(() => confirmClient(client))
          .then((v) => v === true)
          .catch(() => false),
      );
    }
    return decisions.get(client);
  }

  function send(res, status, body) {
    const s = body === undefined ? "" : JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
    res.end(s);
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let n = 0;
      const chunks = [];
      req.on("data", (c) => {
        n += c.length;
        if (n > MAX_BODY) {
          reject(new Error("too-large"));
          req.destroy();
        } else chunks.push(c);
      });
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      req.on("error", reject);
    });
  }

  async function runTool(name, args, p, client) {
    const projectorNow = projectorFor(p.includePhi);
    const req = T.buildRequest(name, args, { projector: projectorNow, prefs: p });
    if (req.error) return { ok: false, error: req.error };
    let data;
    if (req.viewer) {
      // 2D ビューア窓から読む（backend は呼ばない）。失敗は固定の符号だけ返す（窓の本文は返さない）。
      if (typeof viewer !== "function") return { ok: false, error: "viewer-unavailable" };
      let v;
      try {
        v = await viewer(req.viewer.kind, { client, includePhi: p.includePhi, allowViewerEdit: p.allowViewerEdit === true }, req.viewer);
      } catch {
        return { ok: false, error: "viewer-failed" };
      }
      if (!v || v.ok !== true) return { ok: false, error: viewerError(v && v.error) };
      data = req.viewer.kind === "getState" ? v.state : req.viewer.kind === "getMeasurements" ? v.measurements : v.control; // action・undo は main が作った小さな結果
    } else {
      let r;
      try {
        r = await backend(req.method, req.path, { query: req.query, body: req.body });
      } catch {
        return { ok: false, error: "backend-unreachable" };
      }
      if (!r || r.status < 200 || r.status >= 300) return { ok: false, error: `backend-${Number(r && r.status) || 0}` };
      data = r.json;
      if (name === "search_studies" && Array.isArray(data)) data = data.slice(0, req.limit ?? 50);
    }
    let result;
    try {
      result = T.projectResult(name, data, projectorNow);
    } catch (e) {
      return { ok: false, error: e && e.message === "phi-leak" ? "phi-leak" : "projection-failed" };
    }
    if (JSON.stringify(result).length > MAX_RESULT) return { ok: false, error: "result-too-large" };
    return { ok: true, result };
  }

  async function handle(req, res) {
    const p = prefs.get();
    // 受け口の条件。外れたら 404（理由を明かさない）。
    if (!p.enabled || !token) return send(res, 404);
    const remote = req.socket.remoteAddress || "";
    const loopback = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
    const auth = String(req.headers.authorization || "");
    if (!loopback || req.headers.origin !== undefined || !LOCAL_HOST_RE.test(String(req.headers.host || "")) || !auth.startsWith("Bearer ") || !tokenEquals(auth.slice(7), token)) {
      return send(res, 404);
    }
    const client = oneLine(req.headers["x-graphy-mcp-client"], 64) || "unknown";
    const log = (o) => audit.append({ client, includePhi: p.includePhi, ...o });

    if (!(await consent(client))) {
      log({ event: "denied", outcome: "client-denied" });
      return send(res, 403, { ok: false, error: "client-denied" });
    }
    const url = new URL(req.url, "http://localhost");
    if (req.method === "GET" && url.pathname === "/v1/tools") {
      const tools = T.listTools(p);
      log({ event: "list", outcome: "ok", bytes: JSON.stringify(tools).length });
      return send(res, 200, { tools });
    }
    if (req.method === "POST" && url.pathname === "/v1/call") {
      if (active >= MAX_CONCURRENT) return send(res, 429, { ok: false, error: "busy" });
      active++;
      try {
        let body;
        try {
          body = JSON.parse(await readBody(req));
        } catch {
          log({ event: "call", outcome: "bad-request" });
          return send(res, 400, { ok: false, error: "bad-request" });
        }
        const name = body && typeof body.tool === "string" ? body.tool : "";
        const out = await runTool(name, body && body.args, p, client);
        const bytes = out.ok ? JSON.stringify(out.result).length : 0;
        log({ event: "call", tool: /^[A-Za-z0-9_-]{1,64}$/.test(name) ? name : undefined, outcome: out.ok ? "ok" : String(out.error).replace(/[^a-z0-9-]/g, "-").slice(0, 40), bytes });
        return send(res, 200, out);
      } finally {
        active--;
      }
    }
    return send(res, 404);
  }

  function writeDiscovery(port) {
    fs.mkdirSync(path.dirname(discoveryFile), { recursive: true });
    const tmp = `${discoveryFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ port, token }), { mode: 0o600 });
    fs.renameSync(tmp, discoveryFile);
  }

  function removeDiscovery() {
    try {
      fs.rmSync(discoveryFile, { force: true });
    } catch {
      /* 無い */
    }
  }

  function start() {
    if (server) return Promise.resolve(server.address().port);
    token = newToken();
    return new Promise((resolve, reject) => {
      const s = http.createServer((req, res) => {
        handle(req, res).catch(() => {
          try {
            send(res, 500, { ok: false, error: "internal" });
          } catch {
            /* 応答済み */
          }
        });
      });
      s.on("error", (e) => {
        if (server === s) server = null;
        token = null;
        reject(e);
      });
      s.listen(0, "127.0.0.1", () => {
        server = s;
        try {
          writeDiscovery(s.address().port);
        } catch (e) {
          server = null;
          token = null;
          s.close();
          return reject(e);
        }
        resolve(s.address().port);
      });
    });
  }

  function stop() {
    removeDiscovery();
    token = null;
    projector = null;
    projectorPhi = null;
    decisions.clear();
    const s = server;
    server = null;
    if (!s) return Promise.resolve();
    return new Promise((resolve) => {
      s.close(() => resolve());
      s.closeAllConnections?.();
    });
  }

  /** 設定に合わせて起動・停止する。 */
  async function apply() {
    if (prefs.get().enabled) await start();
    else await stop();
  }

  return { start, stop, apply, listening: () => server !== null };
}

module.exports = { createMcpBridge, MAX_BODY, MAX_RESULT };
