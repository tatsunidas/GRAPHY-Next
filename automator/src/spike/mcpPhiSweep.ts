/*
 * MCP の患者情報の扱いを、実データ（実名入りの検査）で全ツールについて確かめる実機検証（roadmap fw/mcp-server-design.md §9 の合格条件）。
 *
 * 実行:  cd automator && GRAPHY_AUTOMATOR_HTTP_PORT=19540 GRAPHY_AUTOMATOR_SCP_PORT=19541 GRAPHY_AUTOMATOR_VITE_PORT=19543 \
 *          npx tsx src/spike/mcpPhiSweep.ts [検査のフォルダ（既定 ~/graphy-demo-samples/HCC_001。CT と SEG を含むこと）]
 *
 *   1. 検査を取り込み、アルバムを作る。**患者の値の一覧（真値）は MCP を通さず、backend の応答から作る**
 *      （患者名・ID・生年月日・受付番号・各種の説明・Study/Series/SOP/FrameOfReference の UID・アルバム名）。
 *   2. includePhi=true で全ツールを呼び、真値が**出る**ことを確かめる（検査が空振りでない証拠）。
 *   3. includePhi=false で全ツールを呼び、出力・監査ログ・中継の stderr に真値が 0 件。数値・状態は残る。
 *   4. 実 Electron に対し、不正なトークン・Origin 付き・Host 違い・無効時が 404、未知のツール・生の UID・拒否リストの経路が通らない。
 *
 * 🔴 患者の値はログに出さない（種類の名前と、出た／出ないだけを報告する）。
 * 前提: backend jar（今のビルド）・frontend の依存・desktop の electron。一時の userData（--user-data-dir）で起動する。
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { DesktopDriver } from "../driver/desktopDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { importPaths } from "../fixtures/importFixtures.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { McpStdio } from "./mcpStdioClient.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "mcp-phi-sweep");
const SAMPLE = process.argv[2] ?? path.join(os.homedir(), "graphy-demo-samples", "HCC_001");

const failures: string[] = [];
let passed = 0;
function check(cond: boolean, label: string, detail?: unknown): void {
  if (cond) {
    passed++;
    console.log(`  [ok  ] ${label}`);
  } else {
    console.log(`  [FAIL] ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
    failures.push(label);
  }
}

async function api<T>(base: string, p: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${base}${p}`, init);
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${p} → HTTP ${res.status}`);
  return (await res.json()) as T;
}

/** 患者の値（種類 → 値）。値はログに出さない。3 文字未満は、数値などと偶然一致するので真値に入れない。 */
type Truth = Map<string, string>;
function addTruth(t: Truth, kind: string, v: unknown): void {
  if (typeof v === "string" && v.trim().length >= 3) t.set(kind, v.trim());
}

interface Study { studyInstanceUid: string; patientId?: string; patientName?: string; studyDate?: string; studyDescription?: string; accessionNumber?: string }
interface Series { seriesInstanceUid: string; modality: string; seriesDescription?: string }

async function buildTruth(base: string, albumName: string): Promise<{ truth: Truth; study: Study; ct: Series; seg: Series }> {
  const studies = await api<Study[]>(base, "/api/studies");
  if (studies.length !== 1) throw new Error(`検査が 1 件でない: ${studies.length}`);
  const st = studies[0];
  const truth: Truth = new Map();
  addTruth(truth, "patientName", st.patientName);
  addTruth(truth, "patientId", st.patientId);
  addTruth(truth, "studyDate", st.studyDate);
  addTruth(truth, "studyDescription", st.studyDescription);
  addTruth(truth, "accessionNumber", st.accessionNumber);
  addTruth(truth, "studyUid", st.studyInstanceUid);
  addTruth(truth, "albumName", albumName);
  const series = await api<Series[]>(base, `/api/studies/${st.studyInstanceUid}/series`);
  series.forEach((s, i) => {
    addTruth(truth, `seriesUid#${i}`, s.seriesInstanceUid);
    addTruth(truth, `seriesDescription#${i}`, s.seriesDescription);
  });
  const ct = series.find((s) => s.modality === "CT");
  const seg = series.find((s) => s.modality === "SEG");
  if (!ct || !seg) throw new Error("CT と SEG のシリーズが要ります");
  const inst = await api<{ sopInstanceUid: string }[]>(base, `/api/studies/${st.studyInstanceUid}/series/${ct.seriesInstanceUid}/instances`);
  addTruth(truth, "sopUid", inst[0]?.sopInstanceUid);
  const layout = await api<{ frameOfReferenceUID?: string }>(base, `/api/studies/${st.studyInstanceUid}/series/${ct.seriesInstanceUid}/layout`);
  addTruth(truth, "frameOfReferenceUid", layout.frameOfReferenceUID);
  // タグの実値（患者情報のタグ。値だけ真値にする）
  const tags = await api<{ tag: string; name: string; value: string }[]>(base, `/api/instances/${inst[0].sopInstanceUid}/tags`);
  for (const r of tags) {
    if (/^\(0010,00(10|20|30|32|40)\)$|^\(0008,00(50|80|90)\)$|^\(0020,0010\)$/.test(r.tag)) addTruth(truth, `tag${r.tag}`, r.value);
  }
  return { truth, study: st, ct, seg };
}

interface Call { tool: string; text: string; isError: boolean }

/** 全ツールを、その設定で見える札・UID を使って呼ぶ。radiomics は完了まで待つ。 */
async function sweep(mcp: McpStdio, albumId: number, includePhi: boolean): Promise<Call[]> {
  const out: Call[] = [];
  const call = async (tool: string, args: Record<string, unknown> = {}) => {
    const r = await mcp.call(tool, args);
    out.push({ tool, text: r.text, isError: r.isError });
    return r;
  };
  await call("get_status");
  await call("list_albums");
  await call("list_album_studies", { albumId });
  const studies = (await call("search_studies", { limit: 5 })).json as { study: string }[];
  const study = studies[0].study;
  const series = (await call("list_series", { study })).json as { series: string; modality: string }[];
  const cts = series.filter((s) => s.modality === "CT");
  const ct = cts[0];
  const seg = series.find((s) => s.modality === "SEG")!;
  await call("get_series_layout", { study, series: ct.series });
  const inst = (await call("list_instances", { study, series: ct.series })).json as { instance: string }[];
  await call("get_tags", { instance: inst[0].instance });
  await call("list_compute_jobs");
  await call("get_viewer_state");
  await call("get_measurements");
  // SEG が参照する元シリーズが分からない（オフでは説明が見えない）ので、通るまで CT を順に試す
  let jobId: string | undefined;
  for (const c of cts) {
    const sub = await call("radiomics_submit", { study, sourceSeries: c.series, maskSeries: seg.series, recompute: false });
    jobId = (sub.json as { jobId?: string } | null)?.jobId;
    if (jobId) break;
  }
  if (jobId) {
    for (let i = 0; i < 1200; i++) {
      const st = await mcp.call("radiomics_status", { jobId });
      const j = st.json as { state?: string } | null;
      if (j?.state === "DONE" || j?.state === "FAILED" || st.isError) {
        out.push({ tool: "radiomics_status", text: st.text, isError: st.isError });
        break;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  console.log(`  (${includePhi ? "オン" : "オフ"}) 呼んだツール: ${[...new Set(out.map((c) => c.tool))].join(", ")}`);
  return out;
}

function rawRequest(port: number, opts: { method?: string; path?: string; headers?: Record<string, string>; body?: string }): Promise<number> {
  return new Promise((resolve) => {
    const req = http.request({ host: "127.0.0.1", port, method: opts.method ?? "GET", path: opts.path ?? "/v1/tools", headers: opts.headers }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 0));
    });
    req.on("error", () => resolve(0));
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const userData = path.join(OUT_DIR, "userdata");
  fs.rmSync(userData, { recursive: true, force: true });
  fs.mkdirSync(userData, { recursive: true });
  const prefs = (includePhi: boolean, enabled = true) => fs.writeFileSync(path.join(userData, "mcp.json"), JSON.stringify({ enabled, includePhi, allowAnalysis: true }));
  prefs(true);

  const d = new DesktopDriver({}, { extraElectronArgs: [`--user-data-dir=${userData}`] });
  await d.start();
  const base = `http://127.0.0.1:${d.ports.http}`;
  let mcp: McpStdio | null = null;
  let albumId: number | null = null;
  try {
    await resetDb(d.ports.http);
    const imp = await importPaths(d.ports.http, [SAMPLE]);
    console.log(`  import: imported=${(imp as { imported?: number }).imported}`);
    const albumName = `SweepAlbum${Date.now() % 1_000_000}`; // 前回の実行のアルバムが残っていても 409 にならない
    const album = await api<{ id: number }>(base, "/api/albums", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: albumName }) });
    albumId = album.id;
    const { truth, study } = await buildTruth(base, albumName);
    await api(base, `/api/albums/${album.id}/studies`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ studyUids: [study.studyInstanceUid] }) });
    console.log(`  真値の種類: ${[...truth.keys()].join(", ")}（${truth.size} 件。値は表示しない）`);

    const endpoint = path.join(userData, "mcp-endpoint.json");
    for (let i = 0; i < 50 && !fs.existsSync(endpoint); i++) await new Promise((r) => setTimeout(r, 200));
    check(fs.existsSync(endpoint), "受け口が待ち受けている");
    await d.app.evaluate(({ dialog }) => {
      (dialog as unknown as { showMessageBox: unknown }).showMessageBox = async () => ({ response: 0, checkboxChecked: false });
    });
    mcp = McpStdio.fromRepo(endpoint, "claude-phi-sweep");
    await mcp.init();

    console.log("\n[2] 患者情報オン: 真値が出る（検査が空振りでないことの確認）");
    const on = await sweep(mcp, album.id, true);
    const onText = on.map((c) => c.text).join("\n");
    const shownOn = [...truth.entries()].filter(([, v]) => onText.includes(v)).map(([k]) => k);
    console.log(`  オンで出た真値: ${shownOn.join(", ")}`);
    for (const k of ["patientName", "patientId", "studyUid", "albumName"]) check(truth.has(k) ? shownOn.includes(k) : true, `オンで ${k} が出る`);
    check(shownOn.some((k) => k.startsWith("seriesUid")) && shownOn.includes("sopUid"), "オンで Series・SOP の UID が出る");
    check(on.filter((c) => c.isError && c.tool !== "radiomics_submit").every((c) => c.tool === "get_viewer_state" || c.tool === "get_measurements"), "オンで（2D 窓の無いビューア系と、元シリーズの試行を除き）全ツールが成功する", on.filter((c) => c.isError).map((c) => `${c.tool}:${c.text.slice(0, 60)}`));

    console.log("\n[3] 患者情報オフ: 全ツールの出力・監査ログ・stderr に真値が 0 件");
    prefs(false);
    const off = await sweep(mcp, album.id, false);
    const leaks: string[] = [];
    for (const c of off) for (const [k, v] of truth) if (c.text.includes(v)) leaks.push(`${c.tool}: ${k}`);
    check(leaks.length === 0, "オフで全ツールの出力に真値が 0 件", leaks);
    check(off.filter((c) => c.isError && c.tool !== "radiomics_submit").every((c) => c.tool === "get_viewer_state" || c.tool === "get_measurements"), "オフで（2D 窓の無いビューア系と、元シリーズの試行を除き）全ツールが成功する", off.filter((c) => c.isError).map((c) => `${c.tool}:${c.text.slice(0, 80)}`));
    const audit = fs.readFileSync(path.join(userData, "mcp-audit.jsonl"), "utf8");
    const auditLeaks = [...truth.entries()].filter(([, v]) => audit.includes(v)).map(([k]) => k);
    check(auditLeaks.length === 0, "監査ログに真値が 0 件", auditLeaks);
    check(![...truth.values()].some((v) => mcp!.stderr.includes(v)), "中継の stderr に真値が 0 件");
    const offText = off.map((c) => c.text).join("\n");
    fs.writeFileSync(path.join(OUT_DIR, "off-output.json"), JSON.stringify(off, null, 1)); // 真値が 0 件と確かめた後の出力（患者情報なし）
    const kept = { modality: /"modality":"CT"/.test(offText), numberOfInstances: /"numberOfInstances"/.test(offText), layoutCells: /"cells"/.test(offText), version: /"version"/.test(offText) };
    check(Object.values(kept).every(Boolean), "数値・状態は残る（全部落として 0 件にしただけではない）", kept);
    const resultOff = off.find((c) => c.tool === "radiomics_status");
    check(!!resultOff && /"feature":"/.test(resultOff.text) && /"value":/.test(resultOff.text), "Radiomics の特徴量名と値が残る");
    const tagsOff = off.find((c) => c.tool === "get_tags");
    check(!!tagsOff && !/\\"?(0010|00100010)/.test(tagsOff.text) && !/PatientName/i.test(tagsOff.text), "オフのタグに患者情報のタグが無い");

    console.log("\n[4] 受け口と中継の拒否（実 Electron）");
    const tok = (JSON.parse(fs.readFileSync(endpoint, "utf8")) as { port: number; token: string });
    const H = (extra: Record<string, string> = {}) => ({ authorization: `Bearer ${tok.token}`, "x-graphy-mcp-client": "claude-phi-sweep", ...extra });
    check((await rawRequest(tok.port, { headers: H() })) === 200, "正例: 正しいトークンは 200");
    check((await rawRequest(tok.port, { headers: {} })) === 404, "トークン無しは 404");
    check((await rawRequest(tok.port, { headers: H({ authorization: `Bearer ${tok.token.slice(0, -1)}0` }) })) === 404, "トークン 1 字違いは 404");
    check((await rawRequest(tok.port, { headers: H({ origin: "http://evil.example" }) })) === 404, "Origin 付きは 404");
    check((await rawRequest(tok.port, { headers: H({ host: "evil.example" }) })) === 404, "Host 違いは 404");
    for (const tool of ["delete_study", "send_to_pacs", "export_study", "get_settings"]) {
      const r = await mcp.call(tool, {});
      check(r.isError && /unknown-tool/.test(r.text), `拒否リスト: ${tool} は unknown-tool`, r.text);
    }
    const raw = await mcp.call("list_series", { study: study.studyInstanceUid });
    check(raw.isError && /unknown-handle/.test(raw.text), "生の UID を渡しても通らない（札だけ）", raw.text);
    const phiArg = await mcp.call("search_studies", { patientName: "x" });
    check(phiArg.isError && /phi-disabled/.test(phiArg.text), "オフで患者名の絞り込みは通らない", phiArg.text);
    prefs(false, false);
    const disabled = await rawRequest(tok.port, { headers: H() });
    check(disabled === 404, "無効にすると 404", disabled);
    const afterOff = await mcp.call("get_status");
    check(afterOff.isError && /起動していない/.test(afterOff.text), "無効のとき中継は「起動していないか MCP がオフ」と返す", afterOff.text);
  } finally {
    mcp?.close();
    if (albumId !== null) await fetch(`${base}/api/albums/${albumId}`, { method: "DELETE" }).catch(() => {});
    await d.stop();
  }
  console.log(`\n=== ${passed} 件合格 / ${failures.length} 件失敗 ===`);
  if (failures.length) {
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
