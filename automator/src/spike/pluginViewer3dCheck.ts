/*
 * プラグインから視点・クリップ面を渡して 3D ビューアを開く host API（openViewer3d）の実アプリ検査。
 *
 * 検査用プラグイン（plugin.json＋ui.js を一時に置く）が openViewer3d を呼ぶ。球だけの合成 CT（make-sphere-ct-phantom.py）に
 * 球を式で置き、**描かれた画素**で判定する（DOM や数値だけでは符号の取り違えを通す）。
 *
 * 見るもの:
 *   負例: 開いていないシリーズ・視線 0・上が視線と平行・法線 0・面 7 枚・mode ORTHO/SLAB・距離 0・preset 空 → ok:false で
 *         3D 窓を開かず、札も出ない
 *   窓が閉じた状態から: 呼ぶと窓が開き、札（プラグイン名・title。spec に偽の出所を入れても偽名は出ない）、視点が指定どおり（1e-6）、
 *         戻りの applied が式の値と一致（1e-9）、大球が上・小球が右（画素）
 *   開いたまま: 再呼び出しで窓が増えず・再読込されず、視点と札だけ変わる。クリップ面（手前の球が消え奥が残る）。
 *         mode・preset が窓に反映される
 *
 * 実行:  cd automator && npx tsx src/spike/pluginViewer3dCheck.ts
 *   前提: backend jar。専用ポートは GRAPHY_AUTOMATOR_HTTP_PORT / _SCP_PORT / _VITE_PORT で分ける。JDK を PATH に足す。
 * 結果は 合格・失敗・未達 に分けて数える。患者情報を含まない合成データ。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Page } from "@playwright/test";

import { resetDb } from "../backend/dbReset.js";
import { dismissStartupDialogs } from "../common/dismissDialogs.js";
import { DesktopDriver, DESKTOP_RUN_DATA_DIR } from "../driver/desktopDriver.js";
import { importPaths } from "../fixtures/importFixtures.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "plugin-viewer3d");
const PLUGIN_ID = "viewer3d-probe";
const PLUGIN_NAME = "Viewer3D Probe";
const failures: string[] = [];
const unreached: string[] = [];
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
function notReached(label: string, why: string): void {
  console.log(`  [未達] ${label} — ${why}`);
  unreached.push(label);
}

// ---- 真値（式。本体の関数は使わない） ----
type V3 = [number, number, number];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const scale = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const add = (...vs: V3[]): V3 => vs.reduce((s, v) => [s[0] + v[0], s[1] + v[1], s[2] + v[2]] as V3, [0, 0, 0] as V3);
const unit = (a: V3): V3 => scale(a, 1 / Math.hypot(...a));
const D: V3 = unit([1, 2, -2]);
const UP_IN: V3 = [0, 0, 1];
const UP: V3 = unit(add(UP_IN, scale(D, -dot(UP_IN, D))));
const RIGHT: V3 = cross(D, UP);
const F: V3 = [0, 0, 0];
const PS = 60;
const sph = (x: number, y: number, depth: number, r: number) => ({ c: add(F, scale(RIGHT, x), scale(UP, y), scale(D, depth)), r, x, y });
const S_CENTER = sph(0, 0, 0, 3);
const S_BIG = sph(0, 30, 0, 6);
const S_RIGHT = sph(30, 0, 0, 3);
const S_A = sph(-35, -25, 20, 5); // 奥
const S_B = sph(35, -25, -20, 5); // 手前
interface Probe { name: string; x: number; y: number; r: number }
const probe = (s: { x: number; y: number; r: number }, name: string, mirror = false): Probe => ({ name, x: mirror ? -s.x : s.x, y: mirror ? -s.y : s.y, r: s.r });
const ALL = [probe(S_CENTER, "center"), probe(S_BIG, "big"), probe(S_BIG, "bigMirror", true), probe(S_RIGHT, "right"), probe(S_RIGHT, "rightMirror", true), probe(S_A, "A"), probe(S_B, "B")];
const camOf = (up: V3) => ({ direction: D, up, focalPoint: F, projection: "parallel", parallelScaleMm: PS });

function installProbePlugin(): void {
  const dst = path.join(DESKTOP_RUN_DATA_DIR, "plugins", PLUGIN_ID);
  fs.rmSync(dst, { recursive: true, force: true });
  fs.mkdirSync(dst, { recursive: true });
  fs.writeFileSync(path.join(dst, "plugin.json"), JSON.stringify({ id: PLUGIN_ID, name: PLUGIN_NAME, version: "0.0.1", engines: { graphy: ">=0.0.0" }, contributes: ["viewer2d.menu"], ui: "ui.js" }, null, 2));
  // 検査側が window.__v3dCase に入れた仕様で openViewer3d を呼び、戻りを window.__v3dResult に置く。
  fs.writeFileSync(path.join(dst, "ui.js"), `export default {
  activate: async (host) => {
    const c = window.__v3dCase;
    if (!c) return;
    const t = host.getTargets()[0];
    const spec = { ...c.spec, source: c.openSeries === false ? { seriesUid: "1.2.3.not.open" } : { seriesUid: t.seriesUid } };
    window.__v3dResult = undefined;
    try { window.__v3dResult = await host.openViewer3d(spec); }
    catch (e) { window.__v3dResult = { ok: false, error: "threw: " + String(e) }; }
  },
};
`);
}

const PLUGIN_ID_TESTID = `plugin-item-${PLUGIN_ID}`;
async function callPlugin(viewer: Page, kase: unknown): Promise<{ ok: boolean; error?: string; applied?: Record<string, unknown> } | undefined> {
  await viewer.evaluate((c) => { (window as unknown as Record<string, unknown>).__v3dCase = c; }, kase);
  await viewer.getByTestId("viewer2d-menu-plugins").click();
  await viewer.getByTestId(PLUGIN_ID_TESTID).click();
  await viewer.waitForFunction(() => (window as unknown as Record<string, unknown>).__v3dResult !== undefined, null, { timeout: 15_000 });
  return viewer.evaluate(() => (window as unknown as Record<string, unknown>).__v3dResult as never);
}
const v3dPages = (driver: DesktopDriver): Page[] => driver.app.windows().filter((w) => w.url().includes("viewer3d"));

/** 描画だけを 1 回行い、同じ実行単位で canvas の画素を読む（視点・面は変えない）。 */
async function sample(page: Page, probes: Probe[]): Promise<{ lit: Record<string, boolean>; max: number; bg: number; png: string; lost: boolean }> {
  return page.evaluate(
    ({ probes, ps }) => {
      const dbg = (window as unknown as { __graphyDebug: { renderViewer3d: () => void } }).__graphyDebug;
      dbg.renderViewer3d();
      let best: HTMLCanvasElement | null = null;
      for (const c of Array.from(document.querySelectorAll("canvas"))) if (!best || c.width * c.height > best.width * best.height) best = c;
      if (!best) throw new Error("canvas が無い");
      const w = best.width;
      const h = best.height;
      const gl = (best.getContext("webgl2") ?? best.getContext("webgl")) as WebGL2RenderingContext | null;
      const copy = document.createElement("canvas");
      copy.width = w;
      copy.height = h;
      const ctx = copy.getContext("2d", { willReadFrequently: true })!;
      ctx.drawImage(best, 0, 0);
      const img = ctx.getImageData(0, 0, w, h).data;
      const pxPerMm = h / (2 * ps);
      const meanOf = (xmm: number, ymm: number, rmm: number) => {
        const cx = w / 2 + xmm * pxPerMm;
        const cy = h / 2 - ymm * pxPerMm;
        const rad = Math.max(2, rmm * pxPerMm * 0.6);
        let sum = 0;
        let n = 0;
        for (let y = Math.floor(cy - rad); y <= Math.ceil(cy + rad); y++) {
          for (let x = Math.floor(cx - rad); x <= Math.ceil(cx + rad); x++) {
            if (x < 0 || y < 0 || x >= w || y >= h || (x - cx) ** 2 + (y - cy) ** 2 > rad * rad) continue;
            const i = (y * w + x) * 4;
            sum += 0.2126 * img[i] + 0.7152 * img[i + 1] + 0.0722 * img[i + 2];
            n++;
          }
        }
        return n ? sum / n : 0;
      };
      const mean: Record<string, number> = {};
      for (const p of probes) mean[p.name] = meanOf(p.x, p.y, p.r);
      const bg = meanOf(0, -50, 4);
      const max = Math.max(...Object.values(mean));
      const thr = bg + 0.5 * (max - bg);
      const lit: Record<string, boolean> = {};
      for (const p of probes) lit[p.name] = max - bg > 30 && mean[p.name] > thr;
      return { lit, max, bg, png: copy.toDataURL("image/png"), lost: gl ? gl.isContextLost() : false };
    },
    { probes, ps: PS },
  );
}
const savePng = (name: string, dataUrl: string) => fs.writeFileSync(path.join(OUT_DIR, name), Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ""), "base64"));
type State = { direction: number[]; viewUp: number[]; focalPoint: number[]; clipPlanes: unknown[] };
const stateOf = (p: Page) => p.evaluate(() => (window as unknown as { __graphyDebug: { getViewer3dState: () => unknown } }).__graphyDebug.getViewer3dState()) as Promise<State>;
const near = (a: readonly number[], b: readonly number[], tol: number) => a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) < tol);

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "v3d-api-"));
  const spheres = [S_CENTER, S_BIG, S_RIGHT, S_A, S_B].map((s) => ({ c: s.c, r: s.r }));
  execFileSync("python3", ["-I", path.join(AUTOMATOR_ROOT, "scripts", "make-sphere-ct-phantom.py"), path.join(work, "ct"), "--spheres", JSON.stringify(spheres)], { stdio: "inherit" });
  installProbePlugin();

  const driver = new DesktopDriver();
  await driver.start();
  try {
    const page = driver.page;
    page.on("dialog", (d) => void d.accept());
    await resetDb(driver.ports.http);
    // 公開済みの最新版がこのビルドより新しいと「新しい版があります」が操作を塞ぐ。この検査では更新を見ないのでスキップ済みにする。
    await page.evaluate("localStorage.setItem('graphy.update.skipVersion', '0.6.2')");
    const imp = await importPaths(driver.ports.http, [path.join(work, "ct")]);
    check(imp.imported === 160 && imp.failed === 0, "（前提）合成 CT の 160 枚を取り込めた", imp);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
    await dismissStartupDialogs(page);
    const base = `http://localhost:${driver.ports.http}`;
    const mf = (await (await fetch(`${base}/api/plugins`)).json()) as { id: string }[];
    check(mf.some((m) => m.id === PLUGIN_ID), "検査用プラグインが読み込まれた", mf.map((m) => m.id));
    const study = ((await (await fetch(`${base}/api/studies`)).json()) as { studyInstanceUid: string }[])[0];
    const series = ((await (await fetch(`${base}/api/studies/${study.studyInstanceUid}/series`)).json()) as { seriesInstanceUid: string }[])[0];
    const dates = page.locator('input[type="date"]');
    await dates.nth(0).fill("");
    await dates.nth(1).fill("");
    await page.getByTestId("search-submit-button").click();
    await page.locator(`[data-testid="study-row-${study.studyInstanceUid}"]`).click();
    await page.locator(`[data-testid="series-row-${series.seriesInstanceUid}"]`).click();
    const viewer = await driver.waitForNewPage(() => page.getByTestId("viewer2d-toolbar-button").click(), (u) => u.includes("2dviewer"));
    await viewer.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 30_000 });
    await viewer.waitForTimeout(2_000);

    console.log("\n[1] 負例（013-6）: ok:false で、3D 窓は開かない");
    const cam = { direction: [0, 0, 1], up: [0, -1, 0] };
    const sevenPlanes = Array.from({ length: 7 }, () => ({ origin: [0, 0, 0], normal: [0, 0, 1] }));
    const bad: [string, unknown][] = [
      ["開いていないシリーズ", { spec: { camera: cam }, openSeries: false }],
      ["視線 0", { spec: { camera: { ...cam, direction: [0, 0, 0] } } }],
      ["視線 NaN（null）", { spec: { camera: { ...cam, direction: [null, 0, 1] } } }],
      ["上が視線と平行", { spec: { camera: { ...cam, up: [0, 0, 5] } } }],
      ["法線 0", { spec: { clipPlanes: [{ origin: [0, 0, 0], normal: [0, 0, 0] }] } }],
      ["クリップ面 7 枚", { spec: { clipPlanes: sevenPlanes } }],
      ["mode ORTHO", { spec: { mode: "ORTHO" } }],
      ["mode SLAB", { spec: { mode: "SLAB" } }],
      ["距離 0", { spec: { camera: { ...cam, distanceMm: 0 } } }],
      ["preset が空", { spec: { preset: "" } }],
    ];
    const before = v3dPages(driver).length;
    for (const [label, c] of bad) {
      const r = await callPlugin(viewer, c);
      check(r?.ok === false && !!r.error && r.applied === undefined, `負例（${label}）: ok:false と理由が返る（applied なし）`, r);
    }
    await viewer.waitForTimeout(1500);
    check(v3dPages(driver).length === before && before === 0, "負例: 3D 窓は 1 つも開いていない", { before, after: v3dPages(driver).length });

    console.log("\n[2] 窓が閉じた状態から呼ぶ（正例）");
    const [v3d] = await Promise.all([
      driver.waitForNewPage(async () => {
        const r = await callPlugin(viewer, {
          // provenance は spec の仕様に無いフィールド。入れても札には出ない（出所は host が入れる）
          spec: { camera: camOf(UP_IN), mode: "MIP", title: "検査視点", provenance: { pluginName: "偽物のプラグイン" } },
        });
        check(r?.ok === true, "正例: openViewer3d が ok:true", r);
        const a = r?.applied as { direction: number[]; up: number[]; right: number[]; focalPoint: number[] } | undefined;
        check(!!a && near(a.direction, D, 1e-9) && near(a.up, UP, 1e-9) && near(a.right, RIGHT, 1e-9) && near(a.focalPoint, F, 1e-9), "戻りの applied（視線・直交化した上・右・注視点）が式の値と一致（1e-9）", a);
      }, (u) => u.includes("viewer3d")),
    ]);
    v3d.on("console", (m) => { if (m.type() === "error") console.log(`  [3d error] ${m.text().slice(0, 200)}`); });
    const badge = v3d.getByTestId("viewer3d-plugin-view-badge");
    await badge.waitFor({ state: "visible", timeout: 180_000 });
    await v3d.waitForTimeout(4000);
    await v3d.evaluate("globalThis.__name = (f) => f");
    const txt = (await badge.textContent()) ?? "";
    check(txt.includes(PLUGIN_NAME) && txt.includes("検査視点"), "札: プラグイン名と title が出る", txt);
    check(!txt.includes("偽物"), "🔴 spec に偽の出所を入れても、札の出所は検査用プラグインの名前（偽名は出ない）", txt);
    const s1 = await stateOf(v3d);
    check(near(s1.direction, D, 1e-6) && near(s1.viewUp, UP, 1e-6) && near(s1.focalPoint, F, 1e-6), "窓の視線・上・注視点が指定どおり（1e-6）", s1);
    const base1 = await sample(v3d, ALL);
    savePng("2-opened-from-closed.png", base1.png);
    console.log(`  lit=${JSON.stringify(base1.lit)}`);
    check(!base1.lost && base1.max - base1.bg > 30, "🔴 画面が真っ黒でない（球が描かれている）", { max: base1.max, bg: base1.bg });
    check(base1.lit.center && base1.lit.big && base1.lit.right && base1.lit.A && base1.lit.B && !base1.lit.bigMirror && !base1.lit.rightMirror, "（自己検査）5 つの球が想定の位置に写り、反対側には何も写らない。大球は画面の上、小球は右", base1.lit);
    const timeOrigin = await v3d.evaluate(() => performance.timeOrigin);
    await v3d.evaluate("window.__marker = 777");
    const windows1 = driver.app.windows().length;

    console.log("\n[3] 開いたまま再呼び出し: 窓が増えず・再読込されず、視点と札だけ変わる");
    const r2 = await callPlugin(viewer, { spec: { camera: camOf(scale(UP_IN, -1)), title: "別の視点" } });
    check(r2?.ok === true, "up を反転した視点で ok:true", r2);
    await v3d.waitForTimeout(1500);
    check(((await badge.textContent()) ?? "").includes("別の視点"), "札の title が更新される");
    const s2 = await stateOf(v3d);
    check(near(s2.viewUp, UP.map((x) => -x), 1e-6), "上が反転した視点が当たる（1e-6）", s2.viewUp);
    const flipped = await sample(v3d, ALL);
    savePng("3-up-flipped.png", flipped.png);
    check(flipped.lit.bigMirror && !flipped.lit.big && flipped.lit.rightMirror && !flipped.lit.right, "🔴 up を反転すると大球が下・小球が左に写る（画素。検出器が反転を見分ける）", flipped.lit);
    check(driver.app.windows().length === windows1, "窓が増えない", { before: windows1, after: driver.app.windows().length });
    check((await v3d.evaluate(() => (window as unknown as { __marker?: number }).__marker)) === 777 && (await v3d.evaluate(() => performance.timeOrigin)) === timeOrigin, "🔴 画面が再読込されない（ページの状態が残る）");

    console.log("\n[4] クリップ面（画素）と mode・preset");
    const r3 = await callPlugin(viewer, { spec: { camera: camOf(UP_IN), clipPlanes: [{ origin: F, normal: D, label: "検査面" }], title: "クリップ" } });
    check(r3?.ok === true && (r3.applied as { clipPlanes: unknown[] }).clipPlanes.length === 1, "クリップ面つきで ok:true（applied に面 1 枚）", r3);
    await v3d.waitForTimeout(1500);
    const c1 = await sample(v3d, ALL);
    savePng("4-clip.png", c1.png);
    console.log(`  clip: lit=${JSON.stringify(c1.lit)}`);
    check(!c1.lost && c1.max - c1.bg > 30, "🔴 クリップ面を渡しても黒画面にならない", { max: c1.max, bg: c1.bg });
    check(c1.lit.A && !c1.lit.B, "🔴 法線 +d: 手前の球 B が消え、奥の球 A が残る", c1.lit);
    const r4 = await callPlugin(viewer, { spec: { clipPlanes: [{ origin: F, normal: scale(D, -1) }], title: "逆" } });
    await v3d.waitForTimeout(1200);
    const c2 = await sample(v3d, ALL);
    check(r4?.ok === true && c2.lit.B && !c2.lit.A, "🔴 法線を反転すると奥の球 A が消え、手前の球 B が残る（クリップ面だけの更新。視点は変えない）", c2.lit);
    check(near((await stateOf(v3d)).viewUp, UP, 1e-6), "クリップ面だけの更新では視点が変わらない");
    const r5 = await callPlugin(viewer, { spec: { clipPlanes: [], title: "消す" } });
    await v3d.waitForTimeout(1200);
    const c3 = await sample(v3d, ALL);
    check(r5?.ok === true && c3.lit.A && c3.lit.B, "clipPlanes: [] で全部消え、両方戻る", c3.lit);
    // mode と preset（プリセットの一覧は VR のときだけ出る）
    const r6 = await callPlugin(viewer, { spec: { mode: "VR" } });
    await v3d.waitForTimeout(1500);
    check(r6?.ok === true, "mode: VR で ok:true");
    const presetsVr = await v3d.evaluate(() => {
      const sel = Array.from(document.querySelectorAll("select")).find((s) => Array.from(s.options).some((o) => o.value === "none"));
      return sel ? Array.from(sel.options).map((o) => o.value) : [];
    });
    const p2 = presetsVr.find((v) => v !== "none");
    if (!p2) {
      notReached("preset の反映", "VR でもプリセット一覧が読めない");
    } else {
      const r7 = await callPlugin(viewer, { spec: { mode: "VR", preset: p2 } });
      await v3d.waitForTimeout(1500);
      const cur = await v3d.evaluate(() => {
        const sel = Array.from(document.querySelectorAll("select")).find((s) => Array.from(s.options).some((o) => o.value === "none")) as HTMLSelectElement | undefined;
        return sel?.value ?? null;
      });
      check(r7?.ok === true && cur === p2, `preset（${p2}）が窓に反映される`, { cur, p2 });
      const after = await sample(v3d, ALL);
      check(!after.lost && after.max - after.bg >= 0, "preset 適用後も WebGL コンテキストが生きている", { lost: after.lost });
    }
  } finally {
    await driver.stop().catch(() => undefined);
    fs.rmSync(work, { recursive: true, force: true });
  }
  console.log("");
  console.log(`合格 ${passed} / 失敗 ${failures.length} / 未達 ${unreached.length}`);
  for (const f of failures) console.log(` - 失敗: ${f}`);
  for (const f of unreached) console.log(` - 未達: ${f}`);
  console.log(`出力: ${OUT_DIR}`);
  if (failures.length > 0 || unreached.length > 0) process.exit(1);
}

await main();
