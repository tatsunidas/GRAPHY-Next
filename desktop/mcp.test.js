// `node --test`。設計: roadmap fw/mcp-server-design.md。MCP の設定・監査・射影・ツールの純ロジック。
// 検査は正例（通る）と負例（落ちる）の両方を持つ。患者情報の検査は、先に「オンでは出る」ことを確かめてから「オフでは出ない」を見る。
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createMcpPrefs, confirmationsFor } = require("./mcpPrefs");
const { buildRecord, createMcpAudit } = require("./mcpAudit");
const { createProjector } = require("./mcpProjection");
const T = require("./mcpTools");

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "graphy-mcp-"));

// ---- 設定 ----
test("prefs: 既定はすべてオフ。保存して読み戻せる", () => {
  const file = path.join(tmpDir(), "mcp.json");
  const p = createMcpPrefs({ file });
  assert.deepEqual(p.get(), { enabled: false, includePhi: false, allowAnalysis: false });
  p.set({ enabled: true });
  assert.deepEqual(createMcpPrefs({ file }).get(), { enabled: true, includePhi: false, allowAnalysis: false });
});

test("prefs: 負例 — 壊れた保存・未知のキー・真偽値以外は、既定に戻す／例外", () => {
  const file = path.join(tmpDir(), "mcp.json");
  fs.writeFileSync(file, "{not json");
  const p = createMcpPrefs({ file });
  assert.deepEqual(p.get(), { enabled: false, includePhi: false, allowAnalysis: false });
  assert.equal(p.readError(), "corrupt");
  fs.writeFileSync(file, JSON.stringify({ enabled: "yes" }));
  assert.equal(p.readError(), "corrupt");
  assert.equal(p.get().enabled, false);
  assert.throws(() => p.set({ nope: true }), /unknown key/);
  assert.throws(() => p.set({ enabled: 1 }), /boolean/);
});

test("prefs: confirmationsFor — オンにするキーだけを、確認の順に返す（オフにする・変わらない変更は確認しない）", () => {
  const off = { enabled: false, includePhi: false, allowAnalysis: false };
  assert.deepEqual(confirmationsFor(off, { enabled: true }), ["enabled"]);
  assert.deepEqual(confirmationsFor(off, { allowAnalysis: true, enabled: true, includePhi: true }), ["enabled", "includePhi", "allowAnalysis"]);
  assert.deepEqual(confirmationsFor({ ...off, enabled: true }, { enabled: true }), []); // すでにオン
  assert.deepEqual(confirmationsFor({ ...off, includePhi: true }, { includePhi: false }), []); // 安全側へ戻すだけ
  assert.deepEqual(confirmationsFor(off, { enabled: "true", unknown: true }), []); // 真偽値以外・未知のキーは対象外（set が例外にする）
  assert.deepEqual(confirmationsFor(off, null), []);
});

// ---- 監査 ----
test("audit: 負例 — 許可リスト以外（引数・結果・患者情報・トークン）は出力に現れない", () => {
  const dirty = { event: "call", tool: "search_studies", outcome: "ok", bytes: 120, includePhi: false, client: "claude-ai", args: { patientName: "山田太郎" }, result: "山田太郎 MRN123", token: "SECRET-TOKEN" };
  const s = JSON.stringify(buildRecord(dirty));
  for (const leak of ["山田", "MRN123", "SECRET-TOKEN"]) assert.equal(s.includes(leak), false, leak);
  assert.equal(buildRecord(dirty).tool, "search_studies");
});

test("audit: クライアント名は制御文字を除いて 64 文字に切る。ツール名の形が違えば捨てる", () => {
  const r = buildRecord({ tool: "a b;rm", outcome: "ok", client: `x\u0000\n${"y".repeat(100)}` });
  assert.equal(r.tool, undefined);
  assert.equal(r.client.length, 64);
  assert.equal(/[\u0000\n]/.test(r.client), false);
});

test("audit: 書けて、上限で 1 世代に回る。書き込み失敗は呼び出しへ影響しない", () => {
  const file = path.join(tmpDir(), "mcp-audit.jsonl");
  const a = createMcpAudit({ file, maxBytes: 200 });
  for (let i = 0; i < 10; i++) a.append({ tool: "get_status", outcome: "ok", bytes: i });
  assert.ok(fs.existsSync(`${file}.1`));
  assert.doesNotThrow(() => createMcpAudit({ file: path.join(file, "x", "y") }).append({ tool: "t" }));
});

// ---- 射影 ----
const STUDY = { studyInstanceUid: "1.2.840.113619.2.55.3.1", patientId: "MRN12345", patientName: "YAMADA^TARO", studyDate: "20260101", studyDescription: "Head CT YAMADA", modality: "CT", modalities: ["CT"], numberOfInstances: 120, numberOfFrames: 0, accessionNumber: "ACC9981" };
const PHI_VALUES = ["MRN12345", "YAMADA", "20260101", "ACC9981", "1.2.840.113619.2.55.3.1"];

test("projection: 正例（先に確認）— includePhi=true では患者情報が出る", () => {
  const P = createProjector({ includePhi: true });
  const s = JSON.stringify(P.study(STUDY));
  for (const v of ["MRN12345", "YAMADA^TARO", "20260101", "1.2.840.113619.2.55.3.1"]) assert.ok(s.includes(v), v);
});

test("projection: 負例 — includePhi=false では患者名・ID・日付・Accession・生 UID が出ない。札になり、解決できる", () => {
  const P = createProjector({ includePhi: false });
  const out = P.study(STUDY);
  const s = JSON.stringify(out);
  for (const v of PHI_VALUES) assert.equal(s.includes(v), false, v);
  assert.match(out.study, /^st_[0-9a-f]{16}$/);
  assert.equal(out.subject, "S001");
  assert.equal(P.resolve("study", out.study), STUDY.studyInstanceUid);
  assert.equal(P.study({ ...STUDY, studyInstanceUid: "1.2.3.4.5" }).subject, "S001"); // 同じ患者は同じ記号
  assert.equal(P.study({ ...STUDY, patientId: "OTHER-ID" }).subject, "S002");
});

test("projection: 負例 — 生の UID をクライアントが渡しても解決しない（札だけが通る）", () => {
  const P = createProjector({ includePhi: false });
  P.study(STUDY);
  assert.equal(P.resolve("study", STUDY.studyInstanceUid), null);
  assert.equal(P.resolve("study", "st_0000000000000000"), null);
  assert.equal(createProjector({ includePhi: true }).resolve("study", "../etc"), null);
});

test("projection: 札は別の接続（鍵）では解決しない", () => {
  const a = createProjector({ includePhi: false });
  const b = createProjector({ includePhi: false });
  const h = a.study(STUDY).study;
  assert.equal(b.resolve("study", h), null);
});

test("projection: タグは許可リストだけ。患者情報のタグ・シーケンスの中・画素は出ない", () => {
  const rows = [
    { depth: 0, tag: "(0010,0010)", name: "PatientName", vr: "PN", value: "YAMADA^TARO" },
    { depth: 0, tag: "(0028,0010)", name: "Rows", vr: "US", value: "512" },
    { depth: 1, tag: "(0028,0011)", name: "Columns", vr: "US", value: "512" },
    { depth: 0, tag: "(7FE0,0010)", name: "PixelData", vr: "OW", value: "..." },
    { depth: 0, tag: "(0008,0050)", name: "AccessionNumber", vr: "SH", value: "ACC9981" },
  ];
  const off = createProjector({ includePhi: false }).tags(rows);
  assert.deepEqual(off.map((r) => r.tag), ["00280010"]);
  const on = createProjector({ includePhi: true }).tags(rows).map((r) => r.tag);
  assert.ok(on.includes("00100010") && on.includes("00080050")); // オンでは患者情報のタグも出る（先に確認）
  assert.equal(on.includes("7FE00010"), false); // どちらでも画素は返さない
  assert.equal(on.includes("00280011"), false); // シーケンスの中は返さない
});

test("projection: guard — 通った患者の値が出力に残っていたら例外（射影の書き漏れの備え）", () => {
  const P = createProjector({ includePhi: false });
  P.study(STUDY);
  assert.throws(() => P.guard({ note: "see YAMADA^TARO" }), /phi-leak/);
  assert.doesNotThrow(() => P.guard({ modality: "CT" }));
  assert.doesNotThrow(() => createProjector({ includePhi: true }).guard({ note: "anything" }));
});

test("projection: deep — 患者キーを落とし、UID を札にする（形が一定でない応答）", () => {
  const P = createProjector({ includePhi: false });
  const out = P.deep({ jobId: "j1", state: "done", patientName: "YAMADA^TARO", result: { studyInstanceUid: "1.2.840.113619.2.55.3.9", features: { mean: 1.5 }, label: "YAMADA" }, version: "0.6.3" });
  const s = JSON.stringify(out);
  assert.equal(s.includes("YAMADA"), false);
  assert.equal(s.includes("1.2.840.113619.2.55.3.9"), false);
  assert.equal(out.version, "0.6.3"); // 版の文字列は UID と取り違えない
  assert.equal(out.result.features.mean, 1.5);
});

// ---- ツール ----
const OFF = { includePhi: false, allowAnalysis: false };
const ON = { includePhi: true, allowAnalysis: true };

test("tools: listTools — 解析がオフなら analysis は出ない。患者情報がオフなら患者名の引数も出ない", () => {
  const names = (prefs) => T.listTools(prefs).map((t) => t.name);
  assert.equal(names(OFF).includes("radiomics_submit"), false);
  assert.ok(names(ON).includes("radiomics_submit"));
  const search = (prefs) => T.listTools(prefs).find((t) => t.name === "search_studies").inputSchema.properties;
  assert.equal("patientName" in search(OFF), false);
  assert.ok("patientName" in search(ON));
});

test("tools: 負例 — 解析オフで analysis を呼ぶと要求を作らない。患者名の引数も落とす", () => {
  const P = createProjector({ includePhi: false });
  assert.deepEqual(T.buildRequest("radiomics_status", { jobId: "j1" }, { projector: P, prefs: OFF }), { error: "analysis-disabled" });
  assert.deepEqual(T.buildRequest("search_studies", { patientName: "x" }, { projector: P, prefs: OFF }), { error: "phi-disabled:patientName" });
  assert.deepEqual(T.buildRequest("radiomics_status", { jobId: "j1" }, { projector: P, prefs: ON }).path, "/api/radiomics/features/jobs/j1");
});

test("tools: 負例 — 未知のツール・未知の引数・必須の欠け・型違い・札でない値は要求を作らない", () => {
  const P = createProjector({ includePhi: false });
  const ctx = { projector: P, prefs: OFF };
  assert.equal(T.buildRequest("delete_study", {}, ctx).error, "unknown-tool");
  assert.equal(T.buildRequest("list_albums", { x: 1 }, ctx).error, "unknown-arg:x");
  assert.equal(T.buildRequest("list_series", {}, ctx).error, "missing-arg:study");
  assert.equal(T.buildRequest("list_album_studies", { albumId: "1" }, ctx).error, "bad-arg:albumId");
  assert.equal(T.buildRequest("list_album_studies", { albumId: -1 }, ctx).error, "bad-arg:albumId");
  assert.equal(T.buildRequest("list_series", { study: "1.2.840.113619.2.55.3.1" }, ctx).error, "unknown-handle:study");
  assert.equal(T.buildRequest("list_series", { study: "../../api/dbadmin" }, ctx).error, "unknown-handle:study");
});

test("tools: 正例 — 札から backend の要求が組める（UID に戻る）", () => {
  const P = createProjector({ includePhi: false });
  const st = P.study(STUDY).study;
  const se = P.series({ seriesInstanceUid: "1.2.840.113619.2.55.3.1.7" }).series;
  const r = T.buildRequest("get_series_layout", { study: st, series: se }, { projector: P, prefs: OFF });
  assert.equal(r.path, "/api/studies/1.2.840.113619.2.55.3.1/series/1.2.840.113619.2.55.3.1.7/layout");
  const sub = T.buildRequest("radiomics_submit", { study: st, sourceSeries: se, maskSeries: se, recompute: true }, { projector: P, prefs: ON });
  assert.equal(sub.method, "POST");
  assert.equal(sub.body.recompute, true);
});

test("tools: checkBackendCall — 許可リストの外・拒否リスト・経路の細工は通さない", () => {
  const ok = (m, p) => T.checkBackendCall(m, p).ok;
  assert.equal(ok("GET", "/api/albums"), true);
  assert.equal(ok("POST", "/api/radiomics/features/jobs"), true);
  for (const [m, p] of [
    ["DELETE", "/api/studies/1.2.3.4"],
    ["GET", "/api/internal/compute/egress/x/decision"],
    ["POST", "/api/dbadmin/tags/apply"],
    ["GET", "/api/instances/1.2.3.4/file"],
    ["POST", "/api/dicom/send"],
    ["GET", "/api/patients"],
    ["GET", "/api/albums/../internal/x"],
    ["GET", "/api/albums?x=1"],
    ["GET", "/api/settings"],
    ["DELETE", "/api/radiomics/features/jobs/j1"],
    ["POST", "/api/compute/jobs/j1/cancel"],
  ]) assert.equal(ok(m, p), false, `${m} ${p}`);
  // 拒否リストは許可リストより優先（許可リストに誤って足しても通さない）
  T.ALLOWED.push(["GET", /^\/api\/settings$/]);
  try {
    assert.equal(ok("GET", "/api/settings"), false);
  } finally {
    T.ALLOWED.pop();
  }
});

test("tools: すべてのツールが、組み立てた要求を checkBackendCall に通す（登録表と許可リストの食い違いを検出）", () => {
  const P = createProjector({ includePhi: true });
  const U = "1.2.840.1.2.3.4";
  const args = { study: U, series: U, instance: U, sourceSeries: U, maskSeries: U, albumId: 1, jobId: "j1" };
  for (const t of T.TOOLS) {
    const a = {};
    for (const k of t.inputSchema.required) a[k] = args[k];
    const r = T.buildRequest(t.name, a, { projector: P, prefs: ON });
    assert.equal(r.error, undefined, `${t.name}: ${r.error}`);
    // 2D ビューア窓から読むツールは backend の要求でなく、固定の kind だけを返す（それ以外の kind は作れない）
    if (t.via === "viewer") {
      assert.deepEqual(Object.keys(r), ["viewer"], t.name);
      assert.ok(T.VIEWER_KINDS.includes(r.viewer.kind), `${t.name}: ${r.viewer.kind}`);
    } else {
      assert.ok(r.method && r.path, t.name);
    }
  }
});

test("tools: ビューア系は 2 つだけ・読み取り・引数なし。画素（captureView）と操作（action・pluginTool）の kind は固定リストに無い", () => {
  assert.deepEqual([...T.VIEWER_KINDS].sort(), ["getMeasurements", "getState"]);
  const viewer = T.TOOLS.filter((t) => t.via === "viewer");
  assert.deepEqual(viewer.map((t) => t.name).sort(), ["get_measurements", "get_viewer_state"]);
  for (const t of viewer) {
    assert.equal(t.effect, "read", t.name);
    assert.deepEqual(t.inputSchema.properties, {}, t.name);
    assert.ok(T.VIEWER_KINDS.includes(t.viewerKind), t.name);
  }
  // 解析オフでも読み取りなので一覧に出る
  const names = T.listTools({ allowAnalysis: false, includePhi: false }).map((t) => t.name);
  assert.ok(names.includes("get_viewer_state") && names.includes("get_measurements"));
  // 引数は受けない
  const P = createProjector({ includePhi: false });
  assert.equal(T.buildRequest("get_viewer_state", { tile: "tile1" }, { projector: P, prefs: { includePhi: false, allowAnalysis: false } }).error, "unknown-arg:tile");
});

test("tools: projectResult — 患者情報オフで、全ツールの出力に患者の値が 0 件（オンでは出る）", () => {
  const SERIES = { seriesInstanceUid: "1.2.840.113619.2.55.3.1.7", modality: "CT", seriesNumber: 2, seriesDescription: "YAMADA head", numberOfInstances: 120, sopClassUid: "1.2.840.10008.5.1.4.1.1.2" };
  const STATE = { tiles: [{ tile: "tile1", modality: "CT", sliceIndex: 3, sliceCount: 120, windowCenter: 40, windowWidth: 400, seriesLabel: "YAMADA head 1.2.840.113619.2.55.3.1.7" }], activeTool: "WindowLevel", layoutCols: 1 };
  const ROIS = { rois: [{ roi: "roi1", tile: "tile1", tool: "Length", sliceIndex: 3, lengthMm: 12.5, label: "YAMADA 腫瘤" }], truncated: false };
  const data = { get_viewer_state: STATE, get_measurements: ROIS, search_studies: [STUDY], list_series: [SERIES], list_albums: [{ id: 3, name: "YAMADA 経過", createdAt: "2026-01-01", count: 4 }], list_instances: [{ sopInstanceUid: "1.2.840.113619.2.55.3.1.7.1", instanceNumber: 1 }] };
  const off = createProjector({ includePhi: false });
  const on = createProjector({ includePhi: true });
  const onAll = JSON.stringify(Object.entries(data).map(([n, d]) => T.projectResult(n, d, on)));
  assert.ok(onAll.includes("YAMADA") && onAll.includes("MRN12345")); // オンでは出る（検査が空振りでない証拠）
  assert.ok(JSON.stringify(T.projectResult("get_viewer_state", STATE, on)).includes("seriesLabel") && JSON.stringify(T.projectResult("get_measurements", ROIS, on)).includes("腫瘤")); // ビューア系も、オンでは残る
  // 伏せる側では、レンダラが落とし損ねた（想定外の）ラベルも main の射影が落とす。数値は残る
  const offState = JSON.stringify(T.projectResult("get_viewer_state", STATE, off));
  assert.ok(offState.includes('"sliceCount":120') && offState.includes('"windowWidth":400'));
  assert.ok(JSON.stringify(T.projectResult("get_measurements", ROIS, off)).includes('"lengthMm":12.5'));
  for (const [n, d] of Object.entries(data)) {
    const s = JSON.stringify(T.projectResult(n, d, off));
    for (const v of [...PHI_VALUES, "1.2.840.113619.2.55.3.1.7", "経過"]) assert.equal(s.includes(v), false, `${n}: ${v}`);
  }
});

// ---- 段 5: 実際の応答の形（backend の controller の戻り型）で、残りのツールも患者情報 0 件を確かめる ----
const SU = "1.2.840.113619.2.55.3.1"; // STUDY の Study UID
const SE = "1.2.840.113619.2.55.3.1.7";
const SOP = "1.2.840.113619.2.55.3.1.7.1";
const FOR = "1.2.840.113619.2.55.3.1.99";
const REAL = {
  get_status: { activeProfiles: ["standalone"], javaVersion: "21", demo: false, app: "GRAPHY-Next", version: "0.6.3", mode: "standalone" },
  list_album_studies: [SU], // AlbumController: List<String>
  get_series_layout: { nZ: 1, nC: 1, nT: 1, cells: [{ c: 0, z: 0, t: 0, sopInstanceUid: SOP, frame: 0 }], imageOrientationPatient: [1, 0, 0, 0, 1, 0], pixelSpacing: [0.5, 0.5], frameOfReferenceUID: FOR, pixelFormat: "int16", axes: ["Z"] },
  get_tags: [{ depth: 0, tag: "(0010,0010)", name: "PatientName", vr: "PN", value: "YAMADA^TARO" }, { depth: 0, tag: "(0028,0010)", name: "Rows", vr: "US", value: "512" }],
  // ComputeJobLedger.view(): message・errorValue・env はプラグイン由来の自由文・任意 JSON
  list_compute_jobs: [{ id: "j1", batchId: "b1", state: "failed", phase: "run", progress: 0.4, message: "failed for YAMADA^TARO (MRN12345)", reason: "plugin-error", errorName: "ValueError", errorValue: "bad value for ACC9981", attempt: 1, itemKey: "k1", inputs: [{ studyUid: SU, seriesUid: SE, format: "dicom", deleted: false }], requestId: "r1", pluginJobId: "pj1", env: { note: "run by YAMADA^TARO", python: "3.11" }, queuedAt: "2026-01-01T00:00:00Z", pluginId: "p1", pluginName: "demo" }],
  radiomics_submit: { jobId: "r-1", state: "RUNNING", elapsedMs: 5, result: null, error: null },
  // RoiFeatureResult（frontend/src/api.ts）: rows は { family, feature, ibsi, value, notes }、settingsProperties は RadiomicsJ の .properties（文字列）
  radiomics_status: { jobId: "r-1", state: "DONE", error: "failed reading /data/YAMADA^TARO/a.dcm", result: { label: 1, rows: [{ family: "firstorder", feature: "Mean", ibsi: "Q4LE", value: 1.5, notes: [] }], provenance: { settingsSha256: "ab" }, settingsProperties: "INT_binCount=32\n" } },
};

test("tools: 残りのツール（実データの形）— 患者情報オンでは出て、オフでは 0 件。先に患者を観測していなくても漏れない", () => {
  const VALUES = [...PHI_VALUES, SU, SE, SOP, FOR, "YAMADA"];
  const run = (includePhi, observe) => {
    const P = createProjector({ includePhi });
    if (observe) P.study(STUDY);
    // guard が止めた（phi-leak）ものは返らない＝漏れない。その印を文字列にして、他の検査と同じ形で扱う
    return Object.fromEntries(Object.entries(REAL).map(([n, d]) => [n, (() => { try { return JSON.stringify(T.projectResult(n, d, P)); } catch (e) { return e.message === "phi-leak" ? "BLOCKED" : (() => { throw e; })(); } })()]));
  };
  const on = run(true, true);
  // 先にオンで出ることを確かめる（検査が空振りでない証拠）
  assert.ok(on.list_album_studies.includes(SU) && on.get_series_layout.includes(SOP) && on.list_compute_jobs.includes("YAMADA") && on.get_tags.includes("YAMADA"));
  for (const observe of [true, false]) {
    for (const [n, s] of Object.entries(run(false, observe))) {
      for (const v of VALUES) assert.equal(s.includes(v), false, `${n} (観測${observe ? "あり" : "なし"}): ${v}`);
    }
  }
  // 数値・状態は残る（全部落として 0 件にしただけの射影を許さない）
  const off = run(false, false);
  assert.ok(off.get_series_layout.includes('"pixelSpacing":[0.5,0.5]') && off.list_compute_jobs.includes('"state":"failed"') && off.list_compute_jobs.includes('"progress":0.4'));
  assert.ok(off.radiomics_status.includes('"feature":"Mean"') && off.radiomics_status.includes('"value":1.5') && off.radiomics_status.includes("INT_binCount=32"));
  assert.ok(off.get_status.includes("0.6.3"));
});

test("tools: guard の誤検出 — 3 文字以上の患者の値が数値と偶然一致したら止まる（安全側に倒れる。仕様として固定）", () => {
  const P = createProjector({ includePhi: false });
  P.study({ ...STUDY, patientId: "1234", accessionNumber: "" });
  assert.throws(() => T.projectResult("list_compute_jobs", [{ id: "j1", state: "done", progress: 1, outputsBytes: 1234 }], P), /phi-leak/);
});
