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

function setup({ prefs = { enabled: true, includePhi: false, allowAnalysis: false }, confirm = async () => true, backendImpl, viewerImpl, pluginsImpl } = {}) {
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
    ...(viewerImpl ? { viewer: viewerImpl } : {}),
    ...(pluginsImpl ? { pluginTools: pluginsImpl } : {}),
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

test("bridge: ビューア系 — 2D 窓から読み、backend は呼ばない。includePhi・クライアント名が渡り、射影される", async () => {
  const seen = [];
  const viewerImpl = async (kind, ctx) => {
    seen.push({ kind, ...ctx });
    return kind === "getState"
      ? { ok: true, state: { tiles: [{ tile: "tile1", modality: "CT", sliceIndex: 3, sliceCount: 120, windowCenter: 40, windowWidth: 400, seriesLabel: "YAMADA head" }] } }
      : { ok: true, untrusted: true, measurements: { rois: [{ roi: "roi1", tile: "tile1", tool: "Length", lengthMm: 12.5, label: "YAMADA 腫瘤" }] } };
  };
  await withBridge({ viewerImpl }, async ({ port, token, calls, audits }) => {
    const names = (await request(port, { headers: auth(token) })).json.tools.map((t) => t.name);
    assert.ok(names.includes("get_viewer_state") && names.includes("get_measurements")); // 解析オフでも出る（読み取り）
    const s = await call(port, token, "get_viewer_state", {});
    assert.equal(s.json.ok, true);
    assert.equal(s.json.result.tiles[0].sliceCount, 120);
    assert.equal(s.text.includes("YAMADA"), false); // 伏せる設定: 想定外のラベルも落ちる
    const m = await call(port, token, "get_measurements", {});
    assert.equal(m.json.result.rois[0].lengthMm, 12.5);
    assert.equal(m.text.includes("YAMADA"), false);
    assert.deepEqual(seen, [{ kind: "getState", client: "claude-test", includePhi: false, allowViewerEdit: false }, { kind: "getMeasurements", client: "claude-test", includePhi: false, allowViewerEdit: false }]);
    assert.equal(calls.length, 0); // backend には一度も行かない
    assert.ok(audits.some((a) => a.tool === "get_viewer_state" && a.outcome === "ok"));
  });
  // 患者情報オンではラベルも残る（検査が空振りでない証拠）
  await withBridge({ viewerImpl, prefs: { enabled: true, includePhi: true, allowAnalysis: false } }, async ({ port, token }) => {
    assert.ok((await call(port, token, "get_viewer_state", {})).text.includes("YAMADA head"));
  });
});

test("bridge: ビューア系の失敗は固定の符号だけ（窓の本文・例外の文は返さない）。引数は受けない。依存が無ければ viewer-unavailable", async () => {
  const replies = [{ ok: false, error: "no-viewer" }, { ok: false, error: "timeout" }, { ok: false, error: "declined" }, { ok: false, error: "exec-failed:YAMADA^TARO" }, null];
  let i = 0;
  await withBridge({ viewerImpl: async () => replies[i++] }, async ({ port, token }) => {
    assert.deepEqual((await call(port, token, "get_viewer_state", {})).json, { ok: false, error: "no-viewer" });
    assert.deepEqual((await call(port, token, "get_viewer_state", {})).json, { ok: false, error: "timeout" });
    assert.deepEqual((await call(port, token, "get_measurements", {})).json, { ok: false, error: "declined" });
    const odd = await call(port, token, "get_viewer_state", {});
    assert.deepEqual(odd.json, { ok: false, error: "viewer-failed" }); // 許可リスト外の符号は丸める
    assert.equal(odd.text.includes("YAMADA"), false);
    assert.deepEqual((await call(port, token, "get_viewer_state", {})).json, { ok: false, error: "viewer-failed" });
    assert.equal((await call(port, token, "get_viewer_state", { tile: "tile1" })).json.error, "unknown-arg:tile");
  });
  await withBridge({ viewerImpl: async () => { throw new Error("boom YAMADA"); } }, async ({ port, token }) => {
    const r = await call(port, token, "get_viewer_state", {});
    assert.deepEqual(r.json, { ok: false, error: "viewer-failed" });
    assert.equal(r.text.includes("YAMADA"), false);
  });
  await withBridge({}, async ({ port, token }) => {
    assert.deepEqual((await call(port, token, "get_viewer_state", {})).json, { ok: false, error: "viewer-unavailable" });
  });
});

test("bridge: 表示操作 — allowViewerControl がオフなら一覧に出ず control-disabled、オンなら記述子が 2D 窓の依存へ渡り、結果は小さな control だけ", async () => {
  const seen = [];
  const viewerImpl = async (kind, ctx, desc) => {
    seen.push({ kind, client: ctx.client, desc, allowViewerEdit: ctx.allowViewerEdit });
    return { ok: true, control: { applied: desc.id ?? "undo", undoDepth: 1 }, state: "YAMADA^TARO" /* 想定外の余計な値は返らない */ };
  };
  await withBridge({ viewerImpl }, async ({ port, token, calls }) => {
    const names = (await request(port, { headers: auth(token) })).json.tools.map((t) => t.name);
    assert.equal(names.includes("set_window_level"), false);
    assert.deepEqual((await call(port, token, "set_window_level", { center: 40, width: 400 })).json, { ok: false, error: "control-disabled" });
    assert.equal(seen.length, 0); // オフでは窓へ届かない
    assert.equal(calls.length, 0);
  });
  await withBridge({ viewerImpl, prefs: { enabled: true, includePhi: false, allowAnalysis: false, allowViewerControl: true } }, async ({ port, token, calls }) => {
    const names = (await request(port, { headers: auth(token) })).json.tools.map((t) => t.name);
    assert.ok(names.includes("set_window_level") && names.includes("undo_viewer_action"));
    assert.equal(names.includes("radiomics_submit"), false); // 解析は別の設定
    const r = await call(port, token, "set_window_level", { center: 40, width: 400 });
    assert.deepEqual(r.json, { ok: true, result: { applied: "setWindowLevel", undoDepth: 1 } });
    assert.equal(r.text.includes("YAMADA"), false);
    assert.deepEqual(seen[0], { kind: "action", client: "claude-test", desc: { kind: "action", id: "setWindowLevel", params: { center: 40, width: 400 } }, allowViewerEdit: false });
    assert.deepEqual((await call(port, token, "undo_viewer_action", {})).json, { ok: true, result: { applied: "undo", undoDepth: 1 } });
    assert.deepEqual(seen[1].desc, { kind: "undo" });
    assert.equal((await call(port, token, "set_window_level", { center: 1e9, width: 400 })).json.error, "bad-arg:center"); // 範囲外は窓へ届かない
    assert.equal((await call(port, token, "create_roi", { shape: "ellipse", u: 0.5, v: 0.5, radiusXmm: 5, radiusYmm: 5 })).json.error, "edit-disabled"); // データを変える操作は別の許可
    assert.equal((await call(port, token, "createRoi", {})).json.error, "unknown-tool"); // 操作の id そのものはツールではない
    assert.equal(seen.length, 2);
    assert.equal(calls.length, 0); // backend には一度も行かない
  });
});

test("bridge: 表示操作の失敗は符号の許可リストだけ返す（rate-limited・nothing-to-undo・no-tile は返り、本文は返らない）", async () => {
  const replies = [{ ok: false, error: "rate-limited" }, { ok: false, error: "nothing-to-undo" }, { ok: false, error: "no-tile" }, { ok: false, error: "exec-failed:YAMADA^TARO" }];
  let i = 0;
  await withBridge({ viewerImpl: async () => replies[i++], prefs: { enabled: true, includePhi: false, allowAnalysis: false, allowViewerControl: true } }, async ({ port, token }) => {
    assert.equal((await call(port, token, "flip_horizontal", {})).json.error, "rate-limited");
    assert.equal((await call(port, token, "undo_viewer_action", {})).json.error, "nothing-to-undo");
    assert.equal((await call(port, token, "invert_colors", {})).json.error, "no-tile");
    const odd = await call(port, token, "go_to_slice", { index: 1 });
    assert.equal(odd.json.error, "viewer-failed");
    assert.equal(odd.text.includes("YAMADA"), false);
  });
});

test("bridge: ROI の作成・計測の全削除 — allowViewerEdit がオンのときだけ。記述子と allowViewerEdit が窓の依存へ渡り、roiUid などは返らない", async () => {
  const seen = [];
  const viewerImpl = async (kind, ctx, desc) => {
    seen.push({ kind, edit: ctx.allowViewerEdit, desc });
    return { ok: true, control: { applied: desc.id, undoDepth: 1 }, inverse: [{ id: "removeAssistantRoi", params: { roiUid: "SECRET-ROI-UID" } }] };
  };
  const roi = { shape: "rectangle", u: 0.5, v: 0.5, radiusXmm: 5, radiusYmm: 5 };
  await withBridge({ viewerImpl, prefs: { enabled: true, includePhi: false, allowAnalysis: false, allowViewerControl: true, allowViewerEdit: false } }, async ({ port, token }) => {
    const names = (await request(port, { headers: auth(token) })).json.tools.map((t) => t.name);
    assert.ok(names.includes("set_window_level"));
    assert.equal(["create_roi", "create_contour_roi", "clear_measurements"].some((n) => names.includes(n)), false); // 表示操作だけでは出ない
    assert.equal((await call(port, token, "clear_measurements", {})).json.error, "edit-disabled");
    assert.equal(seen.length, 0);
  });
  await withBridge({ viewerImpl, prefs: { enabled: true, includePhi: false, allowAnalysis: false, allowViewerControl: false, allowViewerEdit: true } }, async ({ port, token, calls }) => {
    const names = (await request(port, { headers: auth(token) })).json.tools.map((t) => t.name);
    assert.ok(["create_roi", "create_contour_roi", "clear_measurements", "undo_viewer_action"].every((n) => names.includes(n)));
    assert.equal(names.includes("set_window_level"), false); // データを変える許可は、表示操作の許可を含まない
    const r = await call(port, token, "create_roi", roi);
    assert.deepEqual(r.json, { ok: true, result: { applied: "createRoi", undoDepth: 1 } });
    assert.equal(r.text.includes("SECRET-ROI-UID"), false);
    assert.deepEqual(seen[0], { kind: "action", edit: true, desc: { kind: "action", id: "createRoi", params: roi } });
    const tri = [[0.1, 0.1], [0.9, 0.1], [0.5, 0.9]];
    assert.equal((await call(port, token, "create_contour_roi", { shape: "polygon", points: tri })).json.ok, true);
    assert.equal((await call(port, token, "create_contour_roi", { shape: "polygon", points: tri.slice(0, 2) })).json.error, "bad-arg:points");
    assert.equal((await call(port, token, "clear_measurements", {})).json.ok, true);
    assert.equal((await call(port, token, "create_roi", { ...roi, approved: true })).json.error, "unknown-arg:approved"); // 承認の印を引数で混ぜられない
    assert.equal(seen.length, 3);
    assert.equal(calls.length, 0);
  });
});

// ---- 段 4c-2b: プラグインの AI ツール（動的）----
const P_ENTRIES = [
  { name: "plugin__demo__echo_size", pluginId: "demo", pluginName: "Demo", tool: "echo_size", effect: "read", description: "[plugin: Demo] 大きさを返す", parameters: { type: "object", properties: { size: { type: "integer", minimum: 1, maximum: 10 } }, required: ["size"] }, permissions: ["ai-tools"] },
  { name: "plugin__demo__make_roi", pluginId: "demo", pluginName: "Demo", tool: "make_roi", effect: "write", description: "[plugin: Demo] (writes data) ROI を作る", parameters: { type: "object", properties: { radius: { type: "number", minimum: 1, maximum: 50 } }, required: ["radius"] }, permissions: ["ai-tools"] },
  { name: "plugin__other__peek", pluginId: "other", pluginName: "Other", tool: "peek", effect: "read", description: "[plugin: Other] のぞく", parameters: { type: "object", properties: {}, required: [] }, permissions: ["ai-tools"] },
];
const PREFS_P = (over = {}) => ({ enabled: true, includePhi: false, allowAnalysis: false, allowViewerControl: false, allowViewerEdit: false, pluginTools: ["demo"], ...over });
const listNames = async (port, token) => (await request(port, { headers: auth(token) })).json.tools.map((t) => t.name);

test("bridge: プラグインのツール — 公開したプラグインだけが一覧に出る。write は allowViewerEdit のときだけ。説明は main の名乗り＋「信用できない」", async () => {
  await withBridge({ pluginsImpl: async () => P_ENTRIES, viewerImpl: async () => ({ ok: true }), prefs: PREFS_P() }, async ({ port, token }) => {
    const tools = (await request(port, { headers: auth(token) })).json.tools;
    const names = tools.map((t) => t.name);
    assert.ok(names.includes("plugin__demo__echo_size"));
    assert.equal(names.includes("plugin__demo__make_roi"), false); // write は編集の許可なしでは出ない
    assert.equal(names.some((n) => n.startsWith("plugin__other__")), false); // 公開していないプラグインは出ない
    const t = tools.find((x) => x.name === "plugin__demo__echo_size");
    assert.deepEqual(t.inputSchema, { type: "object", properties: { size: { type: "integer", minimum: 1, maximum: 10 } }, required: ["size"], additionalProperties: false });
    assert.match(t.description, /^\[plugin: Demo\]/);
    assert.match(t.description, /信用できない文字列/);
  });
  await withBridge({ pluginsImpl: async () => P_ENTRIES, viewerImpl: async () => ({ ok: true }), prefs: PREFS_P({ allowViewerEdit: true }) }, async ({ port, token }) => {
    assert.ok((await listNames(port, token)).includes("plugin__demo__make_roi"));
  });
  // 公開するプラグインが無い（既定）なら、動的なツールは 1 つも出ない
  await withBridge({ pluginsImpl: async () => P_ENTRIES, viewerImpl: async () => ({ ok: true }), prefs: PREFS_P({ pluginTools: [] }) }, async ({ port, token }) => {
    assert.equal((await listNames(port, token)).some((n) => n.startsWith("plugin__")), false);
  });
  // 一覧を取れなくても、静的なツールは出る（例外にしない）
  await withBridge({ pluginsImpl: async () => { throw new Error("backend down"); }, prefs: PREFS_P() }, async ({ port, token }) => {
    const names = await listNames(port, token);
    assert.ok(names.includes("get_status") && !names.some((n) => n.startsWith("plugin__")));
  });
});

test("bridge: プラグインのツールの呼び出し — 記述子が 2D 窓の依存へ渡り、結果は untrusted で返る。公開外・未知・引数違反は窓へ届かない", async () => {
  const seen = [];
  const viewerImpl = async (kind, ctx, desc) => {
    seen.push({ kind, client: ctx.client, desc });
    return { ok: true, plugin: { untrusted: true, source: "plugin:demo", data: { size: desc.params.size ?? null } } };
  };
  await withBridge({ pluginsImpl: async () => P_ENTRIES, viewerImpl, prefs: PREFS_P() }, async ({ port, token, calls }) => {
    const r = await call(port, token, "plugin__demo__echo_size", { size: 4 });
    assert.deepEqual(r.json, { ok: true, result: { untrusted: true, source: "plugin:demo", data: { size: 4 } } });
    assert.deepEqual(seen[0], { kind: "pluginTool", client: "claude-test", desc: { kind: "pluginTool", name: "plugin__demo__echo_size", params: { size: 4 } } });
    // 負例
    assert.equal((await call(port, token, "plugin__other__peek", {})).json.error, "unknown-tool"); // 公開していない
    assert.equal((await call(port, token, "plugin__nobody__x", {})).json.error, "unknown-tool"); // 存在しない
    assert.equal((await call(port, token, "plugin__demo__make_roi", { radius: 5 })).json.error, "edit-disabled"); // write は別の許可
    assert.equal((await call(port, token, "plugin__demo__echo_size", { size: 99 })).json.error, "bad-arg:size");
    assert.equal((await call(port, token, "plugin__demo__echo_size", { size: "4" })).json.error, "bad-arg:size");
    assert.equal((await call(port, token, "plugin__demo__echo_size", {})).json.error, "missing-arg:size");
    assert.equal((await call(port, token, "plugin__demo__echo_size", { size: 4, approved: true })).json.error, "unknown-arg:approved"); // 承認の印を混ぜられない
    assert.equal(seen.length, 1);
    assert.equal(calls.length, 0);
  });
  await withBridge({ pluginsImpl: async () => P_ENTRIES, viewerImpl, prefs: PREFS_P({ allowViewerEdit: true }) }, async ({ port, token }) => {
    const r = await call(port, token, "plugin__demo__make_roi", { radius: 5 });
    assert.equal(r.json.ok, true);
    assert.equal(seen.at(-1).desc.name, "plugin__demo__make_roi");
    assert.equal((await call(port, token, "plugin__demo__make_roi", { radius: 500 })).json.error, "bad-arg:radius");
  });
});

test("bridge: プラグインのツールの失敗は符号だけ（effect-violation・plugin-error・declined・timeout は返り、本文・例外の文は返らない）", async () => {
  const replies = [{ ok: false, error: "effect-violation" }, { ok: false, error: "plugin-error" }, { ok: false, error: "declined" }, { ok: false, error: "timeout" }, { ok: false, error: "plugin says: YAMADA^TARO" }];
  let i = 0;
  await withBridge({ pluginsImpl: async () => P_ENTRIES, viewerImpl: async () => replies[i++], prefs: PREFS_P() }, async ({ port, token }) => {
    for (const want of ["effect-violation", "plugin-error", "declined", "timeout"]) assert.equal((await call(port, token, "plugin__demo__echo_size", { size: 1 })).json.error, want);
    const odd = await call(port, token, "plugin__demo__echo_size", { size: 1 });
    assert.equal(odd.json.error, "viewer-failed");
    assert.equal(odd.text.includes("YAMADA"), false);
  });
  await withBridge({ pluginsImpl: async () => P_ENTRIES, viewerImpl: async () => { throw new Error("boom YAMADA"); }, prefs: PREFS_P() }, async ({ port, token }) => {
    const r = await call(port, token, "plugin__demo__echo_size", { size: 1 });
    assert.deepEqual(r.json, { ok: false, error: "viewer-failed" });
    assert.equal(r.text.includes("YAMADA"), false);
  });
  await withBridge({ pluginsImpl: async () => P_ENTRIES, prefs: PREFS_P() }, async ({ port, token }) => {
    assert.equal((await call(port, token, "plugin__demo__echo_size", { size: 1 })).json.error, "viewer-unavailable"); // 窓の依存が無い
  });
});

test("bridge: プラグインの結果の患者情報 — 伏せる設定では、患者を示すキーを落とし、先に通した患者の値は guard が止める。オンでは残る", async () => {
  const viewerImpl = async () => ({ ok: true, plugin: { untrusted: true, source: "plugin:demo", data: { patientName: "YAMADA^TARO", name: "label-x", size: 7, note: "see MRN12345" } } });
  await withBridge({ pluginsImpl: async () => P_ENTRIES, viewerImpl, prefs: PREFS_P() }, async ({ port, token }) => {
    // 先に患者を通していない: 患者を示すキー（patientName・name）は落ちる。自由文の中の値は guard に分からない（限界。確認ダイアログと docs が補う）
    const r = await call(port, token, "plugin__demo__echo_size", { size: 7 });
    assert.deepEqual(r.json.result.data, { size: 7, note: "see MRN12345" });
    assert.equal(r.text.includes("YAMADA"), false);
    // 検索で患者を通したあとは、自由文の中の患者の値も止める
    await call(port, token, "search_studies", {});
    const g = await call(port, token, "plugin__demo__echo_size", { size: 7 });
    assert.deepEqual(g.json, { ok: false, error: "phi-leak" });
    assert.equal(g.text.includes("MRN12345"), false);
  });
  await withBridge({ pluginsImpl: async () => P_ENTRIES, viewerImpl, prefs: PREFS_P({ includePhi: true }) }, async ({ port, token }) => {
    const r = await call(port, token, "plugin__demo__echo_size", { size: 7 });
    assert.equal(r.json.result.data.patientName, "YAMADA^TARO"); // オンでは返る
  });
});

test("bridge: 監査ログの結果の符号は崩れない（大文字・: がそのまま。引数名は固定の語＋引数名だけで、患者情報は入らない）", async () => {
  await withBridge({}, async ({ port, token, audits }) => {
    await call(port, token, "search_studies", { patientName: "YAMADA^TARO" }); // 患者情報オフでは通らない
    await call(port, token, "list_series", { study: "1.2.840.113619.2.55.3.1" }); // 生の UID
    const outcomes = audits.filter((a) => a.event === "call").map((a) => a.outcome);
    assert.deepEqual(outcomes, ["phi-disabled:patientName", "unknown-handle:study"]);
    assert.equal(JSON.stringify(audits).includes("YAMADA"), false);
  });
});

// ---- 画像（画素）を返す（allowViewerCapture）----
const PNG_HEAD = "iVBORw0KGgo"; // PNG のマジックの base64
const fakeB64 = (n) => PNG_HEAD + "A".repeat(n - PNG_HEAD.length);
const PREFS_C = (over = {}) => ({ enabled: true, includePhi: false, allowAnalysis: false, allowViewerControl: false, allowViewerEdit: false, allowViewerCapture: true, pluginTools: [], ...over });

test("bridge: 画像 — allowViewerCapture がオフなら一覧に出ず capture-disabled。窓へ届かない", async () => {
  const seen = [];
  await withBridge({ viewerImpl: async (kind, ctx, desc) => { seen.push({ kind, desc }); return { ok: true, image: { base64: fakeB64(100), mimeType: "image/png", w: 4, h: 4 } }; }, prefs: PREFS_C({ allowViewerCapture: false, allowViewerControl: true, allowViewerEdit: true, allowAnalysis: true }) }, async ({ port, token }) => {
    assert.equal((await request(port, { headers: auth(token) })).json.tools.some((t) => t.name === "capture_viewer_image"), false);
    assert.deepEqual((await call(port, token, "capture_viewer_image", {})).json, { ok: false, error: "capture-disabled" });
    assert.equal(seen.length, 0);
  });
});

test("bridge: 画像は射影・512 KiB の上限を通らず、そのまま（全バイト）返る。記述子が窓の依存へ渡る", async () => {
  const seen = [];
  const big = fakeB64(7 * 1024 * 1024); // 512 KiB・射影の 512 字の上限を超える大きさ
  await withBridge({ viewerImpl: async (kind, ctx, desc) => { seen.push({ kind, desc }); return { ok: true, image: { base64: big, mimeType: "image/png", w: 2048, h: 1536 } }; }, prefs: PREFS_C() }, async ({ port, token, audits }) => {
    assert.ok((await request(port, { headers: auth(token) })).json.tools.some((t) => t.name === "capture_viewer_image"));
    const r = await call(port, token, "capture_viewer_image", { withRoi: true });
    assert.equal(r.json.ok, true);
    assert.deepEqual(Object.keys(r.json.result), ["image"]);
    assert.equal(r.json.result.image.data, big); // 切られても落とされてもいない
    assert.deepEqual([r.json.result.image.mimeType, r.json.result.image.width, r.json.result.image.height], ["image/png", 2048, 1536]);
    assert.deepEqual(seen[0], { kind: "captureView", desc: { kind: "captureView", withRoi: true, crop: false } });
    assert.ok(audits.some((a) => a.tool === "capture_viewer_image" && a.outcome === "ok" && a.bytes > 7 * 1024 * 1024)); // 監査は呼び出しとバイト数だけ
    assert.equal(JSON.stringify(audits).includes(PNG_HEAD), false); // 画像の中身は監査に入らない
  });
});

test("bridge: 画像の負例 — 上限（8 MiB）超は result-too-large、形が違う結果は viewer-failed、失敗の符号は許可リストだけ", async () => {
  const replies = [
    { ok: true, image: { base64: fakeB64(8 * 1024 * 1024 + 4), mimeType: "image/png", w: 1, h: 1 } },
    { ok: true, image: { base64: 123, mimeType: "image/png" } },
    { ok: true },
    { ok: false, error: "no-selected-roi" },
    { ok: false, error: "roi-not-visible" },
    { ok: false, error: "capture-failed" },
    { ok: false, error: "declined" },
    { ok: false, error: "image says YAMADA^TARO" },
  ];
  let i = 0;
  await withBridge({ viewerImpl: async () => replies[i++], prefs: PREFS_C() }, async ({ port, token }) => {
    const err = async () => (await call(port, token, "capture_viewer_image", {})).json.error;
    assert.equal(await err(), "result-too-large");
    assert.equal(await err(), "viewer-failed");
    assert.equal(await err(), "viewer-failed");
    for (const want of ["no-selected-roi", "roi-not-visible", "capture-failed", "declined"]) assert.equal(await err(), want);
    const odd = await call(port, token, "capture_viewer_image", {});
    assert.equal(odd.json.error, "viewer-failed");
    assert.equal(odd.text.includes("YAMADA"), false);
  });
});
