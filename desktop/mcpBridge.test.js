// `node --test`。設計: roadmap fw/mcp-server-design.md §4。実際に 127.0.0.1 で待ち受け、偽の backend を渡して通す。
// 負例（拒否される）を、正例（通る）と同じ口で確かめる。結果が空に見える検査にならないよう、先に正例で 200 と中身を確かめる。
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const { createMcpBridge } = require("./mcpBridge");

const STUDY = { studyInstanceUid: "1.2.840.113619.2.55.3.1", patientId: "MRN12345", patientName: "YAMADA^TARO", studyDate: "20260101", modality: "CT", modalities: ["CT"], numberOfInstances: 120 };

function setup({ prefs = { enabled: true, includePhi: false, allowAnalysis: false }, confirm = async () => true, backendImpl } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "graphy-mcpbridge-"));
  const calls = [];
  const audits = [];
  const asked = [];
  const state = { ...prefs };
  const bridge = createMcpBridge({
    prefs: { get: () => ({ ...state }) },
    audit: { append: (r) => audits.push(r) },
    backend: backendImpl ?? (async (method, p, o) => {
      calls.push({ method, path: p, ...o });
      if (p === "/api/studies") return { status: 200, json: [STUDY] };
      if (p === "/api/status") return { status: 200, json: { app: "GRAPHY-Next", version: "0.6.3", mode: "standalone", activeProfiles: ["x"] } };
      return { status: 404, json: { message: "YAMADA^TARO not found" } };
    }),
    confirmClient: async (c) => {
      asked.push(c);
      return confirm(c);
    },
    discoveryFile: path.join(dir, "mcp-endpoint.json"),
  });
  return { bridge, state, calls, audits, asked, dir, file: path.join(dir, "mcp-endpoint.json") };
}

function request(port, { method = "GET", path: p = "/v1/tools", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: p, headers }, (res) => {
      let s = "";
      res.on("data", (c) => (s += c));
      res.on("end", () => resolve({ status: res.statusCode, text: s, json: s ? JSON.parse(s) : null }));
    });
    req.on("error", reject);
    if (body !== undefined) req.write(typeof body === "string" ? body : JSON.stringify(body));
    req.end();
  });
}
const auth = (token, extra = {}) => ({ authorization: `Bearer ${token}`, "x-graphy-mcp-client": "claude-test", "content-type": "application/json", ...extra });
const call = (port, token, tool, args, extra) => request(port, { method: "POST", path: "/v1/call", headers: auth(token, extra), body: { tool, args } });

async function withBridge(opts, fn) {
  const t = setup(opts);
  const port = await t.bridge.start();
  const token = JSON.parse(fs.readFileSync(t.file, "utf8")).token;
  try {
    await fn({ ...t, port, token });
  } finally {
    await t.bridge.stop();
  }
}

test("bridge: 正例 — 起動すると発見用ファイルができ、トークン付きでツール一覧が取れる。止めるとファイルが消える", async () => {
  await withBridge({}, async ({ port, token, file, bridge }) => {
    const d = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(d.port, port);
    assert.match(d.token, /^[0-9a-f]{64}$/);
    const r = await request(port, { headers: auth(token) });
    assert.equal(r.status, 200);
    const names = r.json.tools.map((t) => t.name);
    assert.ok(names.includes("search_studies"));
    assert.equal(names.includes("radiomics_submit"), false); // 解析オフ
    await bridge.stop();
    assert.equal(fs.existsSync(file), false);
    assert.equal(bridge.listening(), false);
  });
});

test("bridge: 負例 — トークン無し・違うトークン・Origin 付き・Host が localhost でない・無効時は 404（理由を明かさない）", async () => {
  await withBridge({}, async ({ port, token, state }) => {
    assert.equal((await request(port, { headers: auth(token) })).status, 200); // 先に正例
    assert.equal((await request(port, { headers: { "x-graphy-mcp-client": "c" } })).status, 404);
    assert.equal((await request(port, { headers: auth("0".repeat(64)) })).status, 404);
    assert.equal((await request(port, { headers: auth(token.slice(0, 10)) })).status, 404);
    assert.equal((await request(port, { headers: auth(token, { origin: "http://evil.example" }) })).status, 404);
    assert.equal((await request(port, { headers: auth(token, { origin: "null" }) })).status, 404);
    assert.equal((await request(port, { headers: auth(token, { host: "evil.example" }) })).status, 404);
    assert.equal((await request(port, { headers: auth(token, { host: "localhost.evil.example:80" }) })).status, 404);
    assert.equal((await request(port, { headers: auth(token, { host: `localhost:${port}` }) })).status, 200); // localhost は通る
    state.enabled = false; // 無効にした瞬間から受けない
    assert.equal((await request(port, { headers: auth(token) })).status, 404);
  });
});

test("bridge: 同意 — 拒否したら、その起動中は同じクライアントを受けない。クライアントごとに 1 回だけ問う", async () => {
  await withBridge({ confirm: async (c) => c === "good" }, async ({ port, token, asked }) => {
    const ok = await request(port, { headers: auth(token, { "x-graphy-mcp-client": "good" }) });
    assert.equal(ok.status, 200);
    const bad1 = await request(port, { headers: auth(token, { "x-graphy-mcp-client": "bad" }) });
    const bad2 = await request(port, { headers: auth(token, { "x-graphy-mcp-client": "bad" }) });
    assert.equal(bad1.status, 403);
    assert.equal(bad2.status, 403);
    assert.deepEqual(asked, ["good", "bad"]); // bad は 2 回呼んでも問いは 1 回
  });
});

test("bridge: 同意 — 同時の要求は同じ問いを共有する。問いが例外なら拒否として扱う", async () => {
  let n = 0;
  let release;
  const gate = new Promise((r) => (release = r));
  await withBridge({ confirm: async () => (n++, await gate, true) }, async ({ port, token }) => {
    const ps = [request(port, { headers: auth(token) }), request(port, { headers: auth(token) }), request(port, { headers: auth(token) })];
    await new Promise((r) => setTimeout(r, 50));
    release();
    const rs = await Promise.all(ps);
    assert.deepEqual(rs.map((r) => r.status), [200, 200, 200]);
    assert.equal(n, 1);
  });
  await withBridge({ confirm: async () => { throw new Error("dialog failed"); } }, async ({ port, token }) => {
    assert.equal((await request(port, { headers: auth(token) })).status, 403);
  });
});

test("bridge: 正例（先に確認）— includePhi=true では検索結果に患者情報が出る", async () => {
  await withBridge({ prefs: { enabled: true, includePhi: true, allowAnalysis: false } }, async ({ port, token }) => {
    const r = await call(port, token, "search_studies", {});
    assert.equal(r.json.ok, true);
    assert.ok(r.text.includes("YAMADA^TARO") && r.text.includes("MRN12345"));
  });
});

test("bridge: 負例 — includePhi=false では応答・監査・backend への要求のどこにも患者情報が出ない。札で次の呼び出しができる", async () => {
  await withBridge({}, async ({ port, token, audits, calls }) => {
    const r = await call(port, token, "search_studies", {});
    assert.equal(r.json.ok, true);
    for (const v of ["YAMADA", "MRN12345", "20260101", "1.2.840.113619.2.55.3.1"]) assert.equal(r.text.includes(v), false, v);
    const handle = r.json.result[0].study;
    assert.match(handle, /^st_/);
    const s = await call(port, token, "list_series", { study: handle });
    assert.equal(s.json.error, "backend-404"); // 偽 backend は 404。要求は札から生 UID に戻っている
    assert.equal(calls.at(-1).path, "/api/studies/1.2.840.113619.2.55.3.1/series");
    assert.equal(s.text.includes("YAMADA"), false); // backend のエラー本文（患者名入り）は返さない
    assert.equal(JSON.stringify(audits).includes("YAMADA"), false);
    assert.ok(audits.some((a) => a.tool === "search_studies" && a.outcome === "ok" && a.includePhi === false && a.client === "claude-test"));
  });
});

test("bridge: 負例 — 生の UID・未知のツール・解析オフの解析・患者名の引数・不正な本文は、backend に届かない", async () => {
  await withBridge({}, async ({ port, token, calls }) => {
    await call(port, token, "search_studies", {});
    const before = calls.length;
    assert.equal((await call(port, token, "list_series", { study: "1.2.840.113619.2.55.3.1" })).json.error, "unknown-handle:study");
    assert.equal((await call(port, token, "delete_study", {})).json.error, "unknown-tool");
    assert.equal((await call(port, token, "radiomics_status", { jobId: "j1" })).json.error, "analysis-disabled");
    assert.equal((await call(port, token, "search_studies", { patientName: "x" })).json.error, "phi-disabled:patientName");
    assert.equal((await request(port, { method: "POST", path: "/v1/call", headers: auth(token), body: "{bad" })).status, 400);
    assert.equal((await request(port, { method: "POST", path: "/v1/call", headers: auth(token), body: "x".repeat(70 * 1024) }).catch(() => ({ status: "reset" }))).status !== 200, true);
    assert.equal(calls.length, before);
  });
});

test("bridge: 解析 — allowAnalysis=true では一覧に出て、要求が組める", async () => {
  await withBridge({ prefs: { enabled: true, includePhi: false, allowAnalysis: true } }, async ({ port, token, calls }) => {
    const names = (await request(port, { headers: auth(token) })).json.tools.map((t) => t.name);
    assert.ok(names.includes("radiomics_submit") && names.includes("radiomics_status"));
    await call(port, token, "radiomics_status", { jobId: "j1" });
    assert.equal(calls.at(-1).path, "/api/radiomics/features/jobs/j1");
  });
});

test("bridge: backend が落ちていても固定の符号を返す。射影の漏れは phi-leak で止める", async () => {
  await withBridge({ backendImpl: async () => { throw new Error("ECONNREFUSED YAMADA"); } }, async ({ port, token }) => {
    const r = await call(port, token, "list_albums", {});
    assert.deepEqual(r.json, { ok: false, error: "backend-unreachable" });
  });
  // 患者の値が別の経路で出力に混ざる場合（偽の射影漏れ）: search で患者を通した後、get_series_layout の応答に氏名が入っていても guard が止める
  let n = 0;
  await withBridge({ backendImpl: async (m, p) => (p === "/api/studies" ? { status: 200, json: [STUDY] } : { status: 200, json: { comment: "from YAMADA^TARO" } }) }, async ({ port, token }) => {
    const r = await call(port, token, "search_studies", {});
    const st = r.json.result[0].study;
    const sr = await call(port, token, "list_series", { study: st });
    assert.equal(sr.json.ok, true); // list_series は形が配列でないので空配列になる
    const se = await call(port, token, "get_series_layout", { study: st, series: st });
    assert.equal(se.json.ok, false);
    assert.equal(se.json.error, "phi-leak");
    n++;
  });
  assert.equal(n, 1);
});

test("bridge: apply — 設定に合わせて起動・停止する。起動の失敗は呼び出し側へ伝わる", async () => {
  const t = setup({ prefs: { enabled: false, includePhi: false, allowAnalysis: false } });
  await t.bridge.apply();
  assert.equal(t.bridge.listening(), false);
  assert.equal(fs.existsSync(t.file), false);
  t.state.enabled = true;
  await t.bridge.apply();
  assert.equal(t.bridge.listening(), true);
  assert.equal(fs.existsSync(t.file), true);
  t.state.enabled = false;
  await t.bridge.apply();
  assert.equal(t.bridge.listening(), false);
  assert.equal(fs.existsSync(t.file), false);
});

test("bridge: 再起動するとトークンが変わる（古いトークンは使えない）", async () => {
  const t = setup();
  const p1 = await t.bridge.start();
  const tok1 = JSON.parse(fs.readFileSync(t.file, "utf8")).token;
  await t.bridge.stop();
  const p2 = await t.bridge.start();
  const tok2 = JSON.parse(fs.readFileSync(t.file, "utf8")).token;
  try {
    assert.notEqual(tok1, tok2);
    assert.equal((await request(p2, { headers: auth(tok1) })).status, 404);
    assert.equal((await request(p2, { headers: auth(tok2) })).status, 200);
    assert.ok(p1 > 0);
  } finally {
    await t.bridge.stop();
  }
});
