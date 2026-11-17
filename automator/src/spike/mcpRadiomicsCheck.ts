/*
 * MCP の radiomics_submit／radiomics_status が返す値と、本体の画面（2D Viewer > 解析 > Radiomics 特徴量（ROI）…）の結果が一致するかの実機検証
 * （roadmap fw/mcp-server-design.md §9 の合格条件）。
 *
 * 実行:  cd automator && GRAPHY_AUTOMATOR_HTTP_PORT=19540 GRAPHY_AUTOMATOR_SCP_PORT=19541 GRAPHY_AUTOMATOR_VITE_PORT=19543 \
 *          npx tsx src/spike/mcpRadiomicsCheck.ts
 *
 *   1. 合成 CT を取り込み、アプリの SEG 書き出し API で 2 セグメントの SEG を作る（roiFeatureCheck.ts と同じ）。
 *   2. 画面を**既定のまま**開き、「計算」→「CSV に書き出す」で値を取る（画面が送った要求の本文も記録）。
 *   3. 同じ検査・シリーズ・マスクを、実際の中継（desktop/mcpCli.js、stdio）から MCP の radiomics_submit で計算する。
 *   4. 設定の SHA-256 → 全列の値を、特徴量の列名で突き合わせる。
 *
 * ⚠ MCP の radiomics_submit は { study, sourceSeries, maskSeries, recompute } だけを送る（設定・マスクのセグメントは省略）。
 *   画面は既定のフォーム設定（固定ビン数 32 など）とセグメントを送る。同じ値になるかは**測って確かめる**（食い違いは FAIL ではなく記録する）。
 *
 * 一時の userData（--user-data-dir）に mcp.json を置いて起動する（開発者の ~/.config を使わない）。同意ダイアログは dialog のスタブで許可する。
 * 前提: backend jar（今のビルド）・python3 と pydicom・frontend の依存。
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { DesktopDriver } from "../driver/desktopDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { importPaths } from "../fixtures/importFixtures.js";
import { openFirstSeriesInViewer } from "../checklist/items/shared/helpers.js";
import { createStepRecorder } from "../checklist/types.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { McpStdio } from "./mcpStdioClient.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "mcp-radiomics-check");

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

interface Synth {
  studyInstanceUid: string;
  seriesInstanceUid: string;
  frameOfReferenceUID: string;
  rows: number;
  columns: number;
  pixelSpacing: number[];
  sliceThickness: number;
  frames: { sopInstanceUid: string; imagePositionPatient: number[] }[];
}
interface Box { r0: number; r1: number; c0: number; c1: number; z0: number; z1: number }
const SEG1: Box = { r0: 12, r1: 36, c0: 10, c1: 34, z0: 3, z1: 13 };
const SEG2: Box = { r0: 30, r1: 40, c0: 36, c1: 46, z0: 5, z1: 9 };

function makeSynth(): Synth & { dir: string } {
  const dir = path.join(OUT_DIR, "synth");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const seed = String(Date.now() % 2_000_000_000);
  const r = spawnSync("python3", ["-I", path.join(import.meta.dirname, "roiFeatureSynth.py"), dir, seed], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`合成データを作れません: ${r.stderr}`);
  return { ...(JSON.parse(r.stdout) as Synth), dir };
}

function boxFrames(s: Synth, b: Box) {
  return s.frames.map((f, z) => {
    if (z < b.z0 || z >= b.z1) return { ...f, mask: "" };
    const m = Buffer.alloc(s.rows * s.columns);
    for (let r = b.r0; r < b.r1; r++) for (let c = b.c0; c < b.c1; c++) m[r * s.columns + c] = 1;
    return { ...f, mask: m.toString("base64") };
  });
}

async function api<T>(base: string, p: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${base}${p}`, init);
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${p} → HTTP ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

/** RFC 4180 の 1 行。 */
function splitRow(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") { out.push(cur); cur = ""; } else cur += c;
  }
  out.push(cur);
  return out;
}
const NREC = 11; // 先頭の記録の列（roiFeatureCheck.ts と同じ）

interface Row { column?: string; family: string; feature: string; value: number | null }
interface Result {
  fromCache: boolean;
  rows: Row[];
  provenance: { settingsSha256: string; radiomicsjVersion: string };
  settingsProperties: string;
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const synth = makeSynth();
  const userData = path.join(OUT_DIR, "userdata");
  fs.rmSync(userData, { recursive: true, force: true });
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(userData, "mcp.json"), JSON.stringify({ enabled: true, includePhi: false, allowAnalysis: true }));

  const d = new DesktopDriver({}, { extraElectronArgs: [`--user-data-dir=${userData}`] });
  await d.start();
  const base = `http://127.0.0.1:${d.ports.http}`;
  let mcp: McpStdio | null = null;
  try {
    console.log(`  reset: ${JSON.stringify(await resetDb(d.ports.http))}`);
    console.log(`  import: ${JSON.stringify(await importPaths(d.ports.http, [synth.dir]))}`);

    console.log("\n[1] SEG をアプリの書き出し API で作る");
    const seg = await api<{ seriesInstanceUid: string }>(base, "/api/dicom/seg", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        studyInstanceUid: synth.studyInstanceUid,
        seriesInstanceUid: synth.seriesInstanceUid,
        rows: synth.rows,
        columns: synth.columns,
        imageOrientationPatient: [1, 0, 0, 0, 1, 0],
        pixelSpacing: synth.pixelSpacing,
        sliceThickness: synth.sliceThickness,
        frameOfReferenceUID: synth.frameOfReferenceUID,
        seriesDescription: "synthetic two-box SEG",
        segments: [
          { number: 1, label: "BigBox", color: [255, 0, 0], description: null, frames: boxFrames(synth, SEG1) },
          { number: 2, label: "SmallBox", color: [0, 255, 0], description: null, frames: boxFrames(synth, SEG2) },
        ],
        producer: null,
      }),
    });
    check(!!seg.seriesInstanceUid, "SEG ができる");

    console.log("\n[2] 画面を既定のまま開いて計算し、CSV と要求の本文を取る");
    const mainPage = d.page;
    await mainPage.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
    await mainPage.waitForTimeout(2000);
    const later = mainPage.getByRole("button", { name: /^(後で|Later)$/ });
    if (await later.isVisible().catch(() => false)) {
      await later.click();
      await mainPage.waitForTimeout(500);
    }
    await mainPage.evaluate("localStorage.setItem('graphy.locale', 'ja')");
    await openFirstSeriesInViewer(mainPage, createStepRecorder());
    const viewer = await d.waitForNewPage(
      () => mainPage.getByTestId("viewer2d-toolbar-button").click(),
      (url) => url.includes("2dviewer"),
    );
    await viewer.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 20_000 });
    await viewer.waitForTimeout(2000);
    await viewer.getByTestId("viewer2d-menu-analysis").click();
    const page = await d.waitForNewPage(
      () => viewer.getByTestId("menu-roi-features").click(),
      (url) => url.includes("#radiomics-features"),
    );
    const posted: Record<string, unknown>[] = [];
    page.on("request", (req) => {
      if (req.method() === "POST" && req.url().includes("/api/radiomics/features/jobs")) posted.push(JSON.parse(req.postData() ?? "{}") as Record<string, unknown>);
    });
    await page.evaluate(`
      (function () {
        window.__roiDownloads = [];
        var orig = HTMLAnchorElement.prototype.click;
        HTMLAnchorElement.prototype.click = function () {
          var a = this;
          if (a.download && a.href.indexOf("blob:") === 0) {
            var name = a.download;
            fetch(a.href).then(function (r) { return r.text(); }).then(function (t) { window.__roiDownloads.push({ name: name, text: t }); });
            return;
          }
          return orig.call(this);
        };
      })()
    `);
    await page.getByTestId("roifeat-mask").waitFor({ state: "visible", timeout: 20_000 });
    await page.waitForTimeout(1500);
    await page.getByTestId("roifeat-mask").selectOption(seg.seriesInstanceUid);
    await page.waitForTimeout(1500);
    await page.getByTestId("roifeat-run").click();
    await page.getByTestId("roifeat-summary").waitFor({ state: "visible", timeout: 300_000 });
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(OUT_DIR, "01-screen-result.png"), fullPage: true });
    await page.getByTestId("roifeat-csv").click();
    for (let i = 0; i < 50 && ((await page.evaluate("window.__roiDownloads.length")) as number) < 2; i++) await page.waitForTimeout(200);
    const dls = (await page.evaluate("window.__roiDownloads.splice(0)")) as { name: string; text: string }[];
    const data = dls.find((f) => !f.name.endsWith("_definitions.csv"));
    check(!!data && posted.length > 0, "画面の CSV と要求の本文が取れた", { downloads: dls.map((f) => f.name), posts: posted.length });
    if (!data) throw new Error("CSV が取れない");
    fs.writeFileSync(path.join(OUT_DIR, "screen.csv"), data.text);
    fs.writeFileSync(path.join(OUT_DIR, "screen-request.json"), JSON.stringify(posted[0], null, 2));
    const [h, v] = data.text.split("\r\n").map(splitRow);
    const screenRec = Object.fromEntries(h.slice(0, NREC).map((n, i) => [n, v[i]]));
    const screenVals = new Map<string, number>(h.slice(NREC).map((n, i) => [n, Number(v[NREC + i])]));
    console.log(`  画面の要求のキー: ${Object.keys(posted[0]).sort().join(", ")}`);
    console.log(`  画面の記録: ${JSON.stringify(screenRec)}`);

    console.log("\n[3] 中継（実際の graphy-mcp、stdio）から radiomics_submit");
    const endpoint = path.join(userData, "mcp-endpoint.json");
    for (let i = 0; i < 50 && !fs.existsSync(endpoint); i++) await new Promise((r) => setTimeout(r, 200));
    check(fs.existsSync(endpoint), "受け口が待ち受けている（起動時に mcp.json の enabled が効いた）");
    // 最初の接続の同意ダイアログは、実際の dialog.showMessageBox を許可に差し替える（アプリは変えない）
    await d.app.evaluate(({ dialog }) => {
      const g = globalThis as unknown as { __orig?: unknown };
      g.__orig = dialog.showMessageBox;
      (dialog as unknown as { showMessageBox: unknown }).showMessageBox = async () => ({ response: 0, checkboxChecked: false });
    });
    mcp = McpStdio.fromRepo(endpoint, "claude-radiomics-check");
    await mcp.init();
    const tools = ((await mcp.request("tools/list")).result as { tools: { name: string }[] }).tools.map((t) => t.name);
    check(tools.includes("radiomics_submit") && tools.includes("radiomics_status"), "解析ツールが一覧に出る（allowAnalysis=true）", tools);
    const studies = (await mcp.call("search_studies", {})).json as { study: string }[];
    check(Array.isArray(studies) && studies.length === 1, "検査が 1 件", studies);
    const series = (await mcp.call("list_series", { study: studies[0].study })).json as { series: string; modality: string }[];
    console.log(`  list_series: ${JSON.stringify(series)}`);
    const src = series.find((s) => s.modality === "CT");
    const mask = series.find((s) => s.modality === "SEG");
    check(!!src && !!mask, "元シリーズ（CT）とマスク（SEG）が札で見つかる", series);
    if (!src || !mask) throw new Error("シリーズが見つからない");
    const sub = await mcp.call("radiomics_submit", { study: studies[0].study, sourceSeries: src.series, maskSeries: mask.series, recompute: false });
    check(!sub.isError, "radiomics_submit が通る", sub.text);
    const jobId = (sub.json as { jobId?: string })?.jobId ?? "";
    let result: Result | null = null;
    for (let i = 0; i < 600 && !result; i++) {
      const st = await mcp.call("radiomics_status", { jobId });
      const j = st.json as { state?: string; result?: Result; error?: string } | null;
      if (j?.state === "DONE" && j.result) result = j.result;
      else if (j?.state === "FAILED" || st.isError) throw new Error(`radiomics_status: ${st.text}`);
      else await new Promise((r) => setTimeout(r, 500));
    }
    if (!result) throw new Error("radiomics_status が完了しない");
    fs.writeFileSync(path.join(OUT_DIR, "mcp-result.json"), JSON.stringify(result, null, 2));

    console.log("\n[4] 画面と MCP の突き合わせ");
    const screenSha = screenRec.Provenance_SettingsSha256 ?? "";
    console.log(`  設定の SHA-256: 画面=${screenSha.slice(0, 16)}… MCP=${result.provenance.settingsSha256.slice(0, 16)}…  MCP の fromCache=${result.fromCache}`);
    const sameSha = screenSha === result.provenance.settingsSha256;
    check(sameSha, "設定の SHA-256（計算に効いた設定）が画面と MCP で同じ", { screen: screenSha, mcp: result.provenance.settingsSha256 });
    const diffs: string[] = [];
    let compared = 0;
    for (const r of result.rows) {
      const col = r.column ?? `${r.family}_${r.feature}`;
      if (!screenVals.has(col)) {
        diffs.push(`${col}: 画面に列が無い`);
        continue;
      }
      compared++;
      if (!Object.is(screenVals.get(col), r.value ?? NaN)) diffs.push(`${col}: 画面=${screenVals.get(col)} MCP=${r.value}`);
    }
    check(result.rows.length > 100 && compared === result.rows.length, "MCP の全特徴量が画面の列に対応する", { mcpRows: result.rows.length, compared, screenCols: screenVals.size });
    check(diffs.length === 0, "全列で値の差 0", { nDiff: diffs.length, first: diffs.slice(0, 8) });
    fs.writeFileSync(path.join(OUT_DIR, "diffs.txt"), diffs.join("\n"));
    console.log(`  差のある列: ${diffs.length} / 比較した列: ${compared}`);
    if (!sameSha) {
      console.log("  --- 設定の差（画面の要求 vs MCP が送る要求）---");
      console.log(`  画面: ${JSON.stringify(posted[0])}`);
      console.log(`  MCP : { studyInstanceUid, sourceSeriesUid, maskSeriesUid, recompute }（settings・maskChannel は省略）`);
      console.log(`  MCP の settingsProperties: ${JSON.stringify(result.settingsProperties).slice(0, 300)}`);
    }
    check(!mcp.stderr.includes(synth.studyInstanceUid), "中継の stderr に UID が出ていない", mcp.stderr.slice(0, 200));
  } finally {
    mcp?.close();
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
