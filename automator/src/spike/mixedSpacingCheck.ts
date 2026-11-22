/*
 * 一括抽出: 元画像の画素間隔（スライス厚）が組の間でそろっていないときの注意（warn / info）の実機検証スパイク。
 *
 * 実行:  cd automator && PYTHON=<pydicom のある python> GRAPHY_AUTOMATOR_HTTP_PORT=21090 GRAPHY_AUTOMATOR_SCP_PORT=21091 \
 *          GRAPHY_AUTOMATOR_VITE_PORT=21093 timeout 1500 npx tsx src/spike/mixedSpacingCheck.ts
 *
 *   合成 CT（スライス厚 1.0・3.0 mm）の 2 検査と、厚さのそろった 2 検査（2.0 mm）を別のアルバムに入れ、画面で計算する。
 *   - リサンプリングなし＋混在 → 警告（z の範囲が、DICOM のヘッダーから Python が求めた値と一致）。情報は出ない。
 *   - 既定の等方 1 mm＋混在 → 情報だけ（警告なし）。
 *   - 負例: そろったアルバムでは、どちらの注記も出ない。
 * 基準（スライス間隔）は spacingFromHeaders.py（ヘッダーの IPP から。本体の実装は使わない）。
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { DesktopDriver } from "../driver/desktopDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { importPaths } from "../fixtures/importFixtures.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { PY, PY_FLAGS } from "./pythonCmd.js";
import { clickDismissing, dismissUpdateDialog } from "./dismissUpdateDialog.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "mixed-spacing-check");
const failures: string[] = [];
let passed = 0;
function check(cond: boolean, label: string, detail?: unknown): void {
  if (cond) { passed++; console.log(`  [ok  ] ${label}`); } else { console.log(`  [FAIL] ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`); failures.push(label); }
}
async function post<T>(base: string, p: string, body: unknown): Promise<T> {
  const res = await fetch(`${base}${p}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`POST ${p} → HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as T;
}

interface Synth {
  studyInstanceUid: string; seriesInstanceUid: string; frameOfReferenceUID: string; rows: number; columns: number;
  pixelSpacing: number[]; sliceThickness: number; frames: { sopInstanceUid: string; imagePositionPatient: number[] }[];
  dir: string; header: number[];
}
function makeSynth(name: string, thick: number, seedOffset: number): Synth {
  const dir = path.join(OUT_DIR, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const seed = String((Date.now() + seedOffset * 7919) % 2_000_000_000);
  const r = spawnSync(PY, [...PY_FLAGS, path.join(import.meta.dirname, "roiFeatureSynth.py"), dir, seed, "-1000", `SYNTHSPACING-${name}`, String(thick)], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`合成データを作れません: ${r.stderr}`);
  const h = spawnSync(PY, [...PY_FLAGS, path.join(import.meta.dirname, "spacingFromHeaders.py"), dir], { encoding: "utf8" });
  if (h.status !== 0) throw new Error(`基準を作れません: ${h.stderr}`);
  return { ...(JSON.parse(r.stdout) as Omit<Synth, "dir" | "header">), dir, header: JSON.parse(h.stdout) as number[] };
}
/** 本体の表示（有効数字 4 桁、最小〜最大）と同じ書き方を、基準の値から独立に組み立てる。 */
const f4 = (n: number) => String(Number(n.toPrecision(4)));
const rangeText = (vals: number[]) => (Math.min(...vals) === Math.max(...vals) ? `${f4(vals[0])} mm` : `${f4(Math.min(...vals))}〜${f4(Math.max(...vals))} mm`);
const wantText = (ss: Synth[]) => ["x", "y", "z"].map((a, i) => `${a} ${rangeText(ss.map((s) => s.header[i]))}`).join("、");

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const mixed = [makeSynth("m1", 1.0, 1), makeSynth("m2", 3.0, 2)];
  const uniform = [makeSynth("u1", 2.0, 3), makeSynth("u2", 2.0, 4)];
  const all = [...mixed, ...uniform];
  console.log(`  基準（ヘッダーから）: 混在 ${JSON.stringify(mixed.map((s) => s.header))} / そろった ${JSON.stringify(uniform.map((s) => s.header))}`);
  check(mixed[0].header[2] === 1 && mixed[1].header[2] === 3 && uniform.every((s) => s.header[2] === 2), "基準: ヘッダーのスライス間隔が 1・3・2・2 mm", all.map((s) => s.header));

  const d = new DesktopDriver();
  await d.start();
  const base = `http://127.0.0.1:${d.ports.http}`;
  const albums: number[] = [];
  try {
    await resetDb(d.ports.http);
    for (const s of all) await importPaths(d.ports.http, [s.dir]);
    for (const s of all) {
      await post(base, "/api/dicom/seg", {
        studyInstanceUid: s.studyInstanceUid, seriesInstanceUid: s.seriesInstanceUid, rows: s.rows, columns: s.columns,
        imageOrientationPatient: [1, 0, 0, 0, 1, 0], pixelSpacing: s.pixelSpacing, sliceThickness: s.sliceThickness,
        frameOfReferenceUID: s.frameOfReferenceUID, seriesDescription: "synthetic box SEG",
        segments: [{ number: 1, label: "Box", color: [255, 0, 0], description: null, frames: s.frames.map((f, z) => {
          if (z < 3 || z >= 13) return { ...f, mask: "" };
          const m = Buffer.alloc(s.rows * s.columns);
          for (let r = 12; r < 36; r++) for (let c = 10; c < 34; c++) m[r * s.columns + c] = 1;
          return { ...f, mask: m.toString("base64") };
        }) }],
        producer: null,
      });
    }
    const mk = async (name: string, ss: Synth[]) => {
      const a = await post<{ id: number }>(base, "/api/albums", { name: `${name}-${Date.now()}` });
      albums.push(a.id);
      await post(base, `/api/albums/${a.id}/studies`, { studyUids: ss.map((s) => s.studyInstanceUid) });
      return a.id;
    };
    const mixedId = await mk("spacing-mixed", mixed);
    const uniformId = await mk("spacing-uniform", uniform);

    const page = d.page;
    await page.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
    await page.waitForTimeout(2000);
    await dismissUpdateDialog(page);
    await page.evaluate("localStorage.setItem('graphy.locale', 'ja')");
    await page.reload();
    await page.getByTestId("album-select").waitFor({ state: "visible", timeout: 60_000 });

    const openDialog = async (albumId: number) => {
      await page.getByTestId("album-select").selectOption(String(albumId));
      await page.waitForTimeout(800);
      await clickDismissing(page, page.getByTestId("album-batch-button"));
      await page.getByTestId("batch-dialog").waitFor({ state: "visible", timeout: 20_000 });
      await page.getByTestId("batch-row-1").waitFor({ state: "visible", timeout: 30_000 });
      await page.waitForTimeout(1500);
      await page.getByTestId("batch-preset").selectOption("six");
    };
    const run = async () => {
      await page.getByTestId("batch-run").click();
      await page.getByTestId("batch-progress").filter({ hasText: /完了 — 2\/2 完了/ }).waitFor({ state: "visible", timeout: 300_000 });
      await page.waitForTimeout(500);
    };
    const shown = async (id: string) => (await page.getByTestId(id).count()) > 0 && (await page.getByTestId(id).isVisible());
    const close = async () => { await page.getByTestId("batch-close").click(); await page.waitForTimeout(500); };

    console.log("\n[1] 混在（1.0 / 3.0 mm）・リサンプリングなし → 警告");
    await openDialog(mixedId);
    await page.getByTestId("batch-resampling").selectOption("none");
    await run();
    check(await shown("batch-spacing-warn") && !(await shown("batch-spacing-info")), "警告が出て、情報は出ない");
    const warn = (await page.getByTestId("batch-spacing-warn").innerText()).replace(/\s+/g, " ");
    check(warn.includes(wantText(mixed)), `警告の範囲がヘッダーの基準と一致（${wantText(mixed)}）`, warn);
    check(/2 組/.test(warn) && /リサンプリングなし/.test(warn), "警告に組の数とリサンプリングなしの理由が出る", warn);
    // 注記は進捗の下（ダイアログの下部）。見える位置まで動かして撮る
    await page.getByTestId("batch-spacing-warn").evaluate((e) => e.scrollIntoView({ block: "center" }));
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(OUT_DIR, "01-warn.png"), fullPage: false });

    console.log("\n[2] 混在・既定（等方 1 mm）→ 情報だけ");
    await close();
    await openDialog(mixedId);
    check((await page.getByTestId("batch-resampling").inputValue()) === "iso", "既定は等方リサンプリング");
    await run();
    check(await shown("batch-spacing-info") && !(await shown("batch-spacing-warn")), "情報だけが出る（警告なし）");
    const info = (await page.getByTestId("batch-spacing-info").innerText()).replace(/\s+/g, " ");
    check(info.includes("1 mm 等方") && info.includes(wantText(mixed)), "情報に取り直した値と範囲が出る", info);
    await page.getByTestId("batch-spacing-info").evaluate((e) => e.scrollIntoView({ block: "center" }));
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(OUT_DIR, "02-info.png"), fullPage: false });

    console.log("\n[3] 負例: そろったアルバム（2.0 / 2.0 mm）・リサンプリングなし → どちらも出ない");
    await close();
    await openDialog(uniformId);
    await page.getByTestId("batch-resampling").selectOption("none");
    await run();
    check(!(await shown("batch-spacing-warn")) && !(await shown("batch-spacing-info")), "そろっていれば、警告も情報も出ない");
    check((await page.getByTestId("batch-progress").innerText()).includes("完了 — 2/2 完了"), "計算は終わっている（出ないのは、実行前ではなく判定の結果）");
  } finally {
    for (const id of albums) await fetch(`${base}/api/albums/${id}`, { method: "DELETE" }).catch(() => {});
    await d.stop();
  }
  console.log(`\n合格 ${passed} / 失敗 ${failures.length}${failures.length ? `\n  失敗: ${failures.join(" / ")}` : ""}`);
  process.exitCode = failures.length ? 1 : 0;
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
