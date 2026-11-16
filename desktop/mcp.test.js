// `node --test`。設計: roadmap fw/mcp-server-design.md。MCP の設定・監査・射影・ツールの純ロジック。
// 検査は正例（通る）と負例（落ちる）の両方を持つ。患者情報の検査は、先に「オンでは出る」ことを確かめてから「オフでは出ない」を見る。
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createMcpPrefs } = require("./mcpPrefs");
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
  }
});

test("tools: projectResult — 患者情報オフで、全ツールの出力に患者の値が 0 件（オンでは出る）", () => {
  const SERIES = { seriesInstanceUid: "1.2.840.113619.2.55.3.1.7", modality: "CT", seriesNumber: 2, seriesDescription: "YAMADA head", numberOfInstances: 120, sopClassUid: "1.2.840.10008.5.1.4.1.1.2" };
  const data = { search_studies: [STUDY], list_series: [SERIES], list_albums: [{ id: 3, name: "YAMADA 経過", createdAt: "2026-01-01", count: 4 }], list_instances: [{ sopInstanceUid: "1.2.840.113619.2.55.3.1.7.1", instanceNumber: 1 }] };
  const off = createProjector({ includePhi: false });
  const on = createProjector({ includePhi: true });
  const onAll = JSON.stringify(Object.entries(data).map(([n, d]) => T.projectResult(n, d, on)));
  assert.ok(onAll.includes("YAMADA") && onAll.includes("MRN12345")); // オンでは出る（検査が空振りでない証拠）
  for (const [n, d] of Object.entries(data)) {
    const s = JSON.stringify(T.projectResult(n, d, off));
    for (const v of [...PHI_VALUES, "1.2.840.113619.2.55.3.1.7", "経過"]) assert.equal(s.includes(v), false, `${n}: ${v}`);
  }
});
