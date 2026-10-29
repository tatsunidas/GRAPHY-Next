/*
 * 実症例の指定フレームを、座標の格子つきで画像に書き出す（点の選定のために人が目で見る用）。
 *
 * 実行（専用ポート・前景）:
 *   FFR_CASE=1|2 FFR_CASES_DIR=<FFR フォルダ> GRAPHY_AUTOMATOR_HTTP_PORT=18390 \
 *     GRAPHY_AUTOMATOR_SCP_PORT=18391 GRAPHY_AUTOMATOR_VITE_PORT=18393 npx tsx src/spike/ffrCasesViewDump.ts
 *
 * 実症例のシネは JPEG ロスレスで、ここでは復号器を書かない。2 方向窓に読み込ませ、窓のキャンバスを拡大して取り出す
 * （窓が見せている画素そのもの）。格子は画像 px（0〜511）で、拡大しても座標が読める。
 *
 * 🚨 出力 `.results/ffr-view/` は実症例の画像を含む。コミットしない・再配布しない。患者識別子は書き出さない。
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { Page } from "@playwright/test";

import { DesktopDriver, DESKTOP_RUN_DATA_DIR } from "../driver/desktopDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { importPaths } from "../fixtures/importFixtures.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { waitForMainScreenReady } from "../checklist/items/shared/helpers.js";
import { dismissStartupDialogs } from "../common/dismissDialogs.js";

const QUANT_REPO = path.resolve(AUTOMATOR_ROOT, "..", "..", "graphy-next-plugin-angio-quant");
const CASES_DIR = process.env.FFR_CASES_DIR ?? path.join(os.homedir(), "graphy_sample_images", "ffr-cases", "FFR");
const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "ffr-view");
const CASE = process.env.FFR_CASE ?? "1";
/** 0 始まり。試行 A・B と同じ規則（静止画との相関が最大のフレーム）。 */
const FRAMES: Record<string, { A: number; B: number }> = { "1": { A: 38, B: 37 }, "2": { A: 39, B: 39 } };
const FRAME_OVERRIDE = process.env.FFR_FRAMES; // 例 "40,37"（選び直し用。使ったら記録する）
const log = (...a: unknown[]) => console.log(...a);

function caseDir(): string {
  const d = fs.readdirSync(CASES_DIR).find((n) => n.startsWith(`Case${CASE}`));
  if (!d) throw new Error(`Case${CASE} が ${CASES_DIR} に無い`);
  return path.join(CASES_DIR, d, "DICOM");
}

async function listSeries(base: string): Promise<{ study: string; series: string; modality: string }[]> {
  const out: { study: string; series: string; modality: string }[] = [];
  for (const st of (await (await fetch(`${base}/studies`)).json()) as { studyInstanceUid: string }[]) {
    for (const se of (await (await fetch(`${base}/studies/${st.studyInstanceUid}/series`)).json()) as { seriesInstanceUid: string; modality: string }[]) {
      out.push({ study: st.studyInstanceUid, series: se.seriesInstanceUid, modality: se.modality });
    }
  }
  return out;
}

/** 窓のキャンバスを格子つきで PNG にする。拡大率 2（880 px）。 */
type Line = { p: [number, number]; d: [number, number]; label?: string };
/** 重ね描きする直線（画像 px）。FFR_OVERLAY_FILE が指す JSON: { "A": [...], "B": [...] }。 */
const OVERLAY: Record<string, Line[]> = process.env.FFR_OVERLAY_FILE ? JSON.parse(fs.readFileSync(process.env.FFR_OVERLAY_FILE, "utf8")) : {};
const ONLY_FULL = process.env.FFR_ONLY_FULL === "1";
const TAG = process.env.FFR_TAG ?? "";

async function dumpCanvas(page: Page, key: string, file: string, gridStep: number): Promise<{ zoom: number; ox: number; oy: number }> {
  const lines = JSON.stringify(OVERLAY[key] ?? []);
  const r = (await page.evaluate(
    `(() => {
      const c = document.querySelector('[data-testid="dual-canvas-${key}"]');
      const zoom = Number(c.dataset.zoom); const [ox, oy] = c.dataset.view.split(",").map(Number);
      const S = 2, W = c.width * S;
      const o = document.createElement("canvas"); o.width = W; o.height = W;
      const g = o.getContext("2d"); g.imageSmoothingEnabled = true; g.drawImage(c, 0, 0, W, W);
      const step = ${gridStep};
      g.font = "16px sans-serif"; g.lineWidth = 1;
      const s2 = (t, off) => (t - off) * zoom * c.width / 512 * S;
      for (let t = Math.ceil(ox / step) * step; s2(t, ox) < W; t += step) {
        const x = s2(t, ox); g.strokeStyle = "rgba(0,255,255,0.35)"; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, W); g.stroke();
        g.fillStyle = "#0ff"; g.fillText(String(t), x + 2, 14);
      }
      for (let t = Math.ceil(oy / step) * step; s2(t, oy) < W; t += step) {
        const y = s2(t, oy); g.strokeStyle = "rgba(255,255,0,0.35)"; g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke();
        g.fillStyle = "#ff0"; g.fillText(String(t), 2, y - 2);
      }
      const L = ${lines};
      const col = ["#ff4d4d", "#4dff4d", "#ff4dff", "#ffa94d", "#4da6ff", "#ffff4d", "#fff", "#f0f"];
      L.forEach((ln, i) => {
        g.strokeStyle = col[i % col.length]; g.fillStyle = col[i % col.length]; g.lineWidth = 1.5;
        const big = 2000;
        const x0 = s2(ln.p[0] - ln.d[0] * big, ox), y0 = s2(ln.p[1] - ln.d[1] * big, oy);
        const x1 = s2(ln.p[0] + ln.d[0] * big, ox), y1 = s2(ln.p[1] + ln.d[1] * big, oy);
        g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke();
        // ラベルは線が画面に入る点（左端・上端・右端・下端のどれか）の近くへ
        const cands = [];
        const mx = (v) => v;
        const tx = (X) => { const t = (X - ln.p[0]) / ln.d[0]; return ln.p[1] + t * ln.d[1]; };
        const ty = (Y) => { const t = (Y - ln.p[1]) / ln.d[1]; return ln.p[0] + t * ln.d[0]; };
        const xl = ox + 8 / (zoom * c.width / 512), xr = ox + 512 / zoom - 40 / (zoom * c.width / 512 * S) ;
        const yy = tx(xl);
        if (yy >= oy && yy <= oy + 512 / zoom) { g.font = "bold 18px sans-serif"; g.fillText(ln.label ?? String(i), 6, s2(yy, oy) - 4); }
        else { const xx = ty(oy + 24 / (zoom * c.width / 512 * S)); if (xx >= ox && xx <= ox + 512 / zoom) { g.font = "bold 18px sans-serif"; g.fillText(ln.label ?? String(i), s2(xx, ox) + 4, 36); } }
      });
      return JSON.stringify({ url: o.toDataURL("image/png"), zoom, ox, oy });
    })()`,
  )) as string;
  const j = JSON.parse(r) as { url: string; zoom: number; ox: number; oy: number };
  fs.writeFileSync(file, Buffer.from(j.url.replace(/^data:image\/png;base64,/, ""), "base64"));
  return { zoom: j.zoom, ox: j.ox, oy: j.oy };
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const dst = path.join(DESKTOP_RUN_DATA_DIR, "plugins", "angio-quant");
  fs.mkdirSync(dst, { recursive: true });
  for (const n of ["plugin.json", "ui.js"]) fs.copyFileSync(path.join(QUANT_REPO, n), path.join(dst, n));
  const frames = FRAME_OVERRIDE ? { A: Number(FRAME_OVERRIDE.split(",")[0]), B: Number(FRAME_OVERRIDE.split(",")[1]) } : FRAMES[CASE];
  log(`Case${CASE} フレーム(0 始まり) A=${frames.A} B=${frames.B}${FRAME_OVERRIDE ? "（選び直し: 上書き）" : "（規則どおり）"}`);

  const driver = new DesktopDriver();
  await driver.start();
  try {
    const page = driver.page;
    page.on("dialog", (d) => void d.accept().catch(() => {}));
    const base = `http://127.0.0.1:${driver.ports.http}/api`;
    await resetDb(driver.ports.http);
    const imp: Record<"A" | "B", { study: string; series: string }> = {} as never;
    for (const [k, f] of [["A", "00000003"], ["B", "00000004"]] as const) {
      const before = new Set((await listSeries(base)).map((s) => s.series));
      await importPaths(driver.ports.http, [path.join(caseDir(), f)]);
      const added = (await listSeries(base)).filter((s) => !before.has(s.series) && s.modality === "XA");
      if (added.length !== 1) throw new Error(`方向 ${k} の取り込みで XA が ${added.length} 本`);
      imp[k] = added[0];
    }
    await waitForMainScreenReady(page, 60_000);
    await dismissStartupDialogs(page);
    await page.getByRole("button", { name: /^(All|全期間)$/ }).click();
    await page.getByTestId("search-submit-button").click();
    await page.locator(`[data-testid="study-row-${imp.A.study}"]`).click();
    const row = page.locator(`[data-testid="series-row-${imp.A.series}"]`);
    await row.waitFor({ state: "visible", timeout: 20_000 });
    await row.click();
    await page.waitForTimeout(500);
    const viewer: Page = await driver.waitForNewPage(() => page.getByTestId("viewer2d-toolbar-button").click(), (u) => u.includes("2dviewer"));
    await viewer.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 30_000 });
    await viewer.waitForTimeout(3_000);
    await viewer.getByTestId("viewer2d-menu-plugins").click();
    await viewer.waitForTimeout(300);
    await viewer.getByTestId("plugin-item-angio-quant").click();
    await viewer.waitForTimeout(1_500);
    await viewer.getByTestId("angio-quant-dual").click();
    await viewer.getByTestId("dual-panel").waitFor({ state: "visible", timeout: 10_000 });
    await viewer.getByTestId("dual-pick").click();
    await viewer.getByTestId("pickseries-dialog").waitFor({ state: "visible", timeout: 10_000 });
    await viewer.waitForTimeout(1_000);
    for (const st of new Set([imp.A.study, imp.B.study])) {
      const exp = viewer.getByTestId(`pickseries-expand-${st}`);
      if ((await exp.count()) && (await exp.getAttribute("aria-expanded")) !== "true") await exp.click();
    }
    await viewer.waitForTimeout(800);
    await viewer.getByTestId(`pickseries-series-check-${imp.A.series}`).check();
    await viewer.getByTestId(`pickseries-series-check-${imp.B.series}`).check();
    await viewer.getByTestId("pickseries-ok").click();
    await viewer.waitForTimeout(4_000);

    for (const k of ["A", "B"] as const) {
      await viewer.evaluate(
        `(() => { const el = document.querySelector('[data-testid="dual-frame-${k}"]'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(el, '${frames[k]}'); el.dispatchEvent(new Event('input', { bubbles: true })); })()`,
      );
      await viewer.waitForTimeout(1_500);
    }
    const meta: Record<string, unknown> = { case: CASE, frames, views: {} as Record<string, unknown> };
    for (const k of ["A", "B"] as const) {
      const full = await dumpCanvas(viewer, k, path.join(OUT_DIR, `case${CASE}${TAG}-${k}-f${frames[k]}-full.png`), 64);
      (meta.views as Record<string, unknown>)[k] = { full };
      if (ONLY_FULL) continue;
      // 拡大（約 2 倍。カーソルの下の点は動かさない）を 4 隅と中央付近で。
      const box = (await viewer.getByTestId(`dual-canvas-${k}`).boundingBox())!;
      const spots: [string, number, number][] = [["tl", 0.25, 0.25], ["tr", 0.75, 0.25], ["bl", 0.25, 0.75], ["br", 0.75, 0.75], ["c", 0.5, 0.5]];
      for (const [name, fx, fy] of spots) {
        await viewer.getByTestId("dual-zoom-reset").click();
        await viewer.mouse.move(box.x + box.width * (fx === 0.5 ? 0.5 : fx < 0.5 ? 0.003 : 0.997), box.y + box.height * (fy === 0.5 ? 0.5 : fy < 0.5 ? 0.003 : 0.997));
        await viewer.keyboard.down("Control");
        for (let n = 0; n < 3; n++) { await viewer.mouse.wheel(0, -100); await viewer.waitForTimeout(150); }
        await viewer.keyboard.up("Control");
        await viewer.waitForTimeout(300);
        const z = await dumpCanvas(viewer, k, path.join(OUT_DIR, `case${CASE}${TAG}-${k}-f${frames[k]}-${name}.png`), 32);
        (meta.views as Record<string, unknown>)[`${k}-${name}`] = z;
      }
      await viewer.getByTestId("dual-zoom-reset").click();
    }
    fs.writeFileSync(path.join(OUT_DIR, `case${CASE}${TAG}-meta.json`), JSON.stringify(meta, null, 1));
    log("書き出し:", OUT_DIR);
  } finally {
    await driver.stop();
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
