/*
 * 3D 窓が「プラグインが指定した視点・クリップ面」を受けて表示する部分の実アプリ検査。
 *
 * 起動コンテキストの `pluginView` を書き込んで窓へ知らせる（dev の口 `__graphyDebug.setViewer3dPluginView`）。
 * host API（段 3）が同じコンテキストを書くので、窓の受け取り側は実際の経路で通る。
 * 球だけの合成 CT（`make-sphere-ct-phantom.py`）に球を式で置き、**描かれた画素**で判定する。
 *
 * 見るもの: 札（出所・title・離れた印・拒否理由）、視点の一致（1e-6）、［指定に戻す］、開いたままの更新（窓が増えず・
 * 再読込されず）、同じ seq の無視、クリップ面（画素）とパネルの ON/OFF、拒否（何も変えない）、別シリーズなら従来どおり読み直す。
 *
 * 実行:  cd automator && npx tsx src/spike/viewer3dPluginViewCheck.ts
 *   前提: backend jar。専用ポートは GRAPHY_AUTOMATOR_HTTP_PORT / _SCP_PORT / _VITE_PORT で分ける。JDK を PATH に足す。
 * 結果は 合格・失敗・未達 に分けて数える。患者情報を含まない合成データ。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Page } from "@playwright/test";

import { DesktopDriver } from "../driver/desktopDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { importPaths } from "../fixtures/importFixtures.js";
import { openFirstSeriesInViewer } from "../checklist/items/shared/helpers.js";
import { createStepRecorder } from "../checklist/types.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "viewer3d-plugin-view");
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
const orth = (up: V3, d: V3): V3 => unit(add(up, scale(d, -dot(up, d))));

const D: V3 = unit([1, 2, -2]);
const UP_IN: V3 = [0, 0, 1];
const UP: V3 = orth(UP_IN, D);
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

const PROV = { pluginId: "viewer3d-probe", pluginName: "Probe Plugin", pluginVersion: "0.0.1" };
const camOf = (up: V3) => ({ direction: D, up, focalPoint: F, projection: "parallel" as const, parallelScaleMm: PS });

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

function savePng(name: string, dataUrl: string): void {
  fs.writeFileSync(path.join(OUT_DIR, name), Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ""), "base64"));
}

type State = { direction: number[]; viewUp: number[]; focalPoint: number[]; clipPlanes: unknown[] };
const stateOf = (p: Page) => p.evaluate(() => (window as unknown as { __graphyDebug: { getViewer3dState: () => unknown } }).__graphyDebug.getViewer3dState()) as Promise<State>;
const near = (a: number[], b: number[], tol: number) => a.every((x, i) => Math.abs(x - b[i]) < tol);

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "v3d-pv-"));
  const spheres = [S_CENTER, S_BIG, S_RIGHT, S_A, S_B].map((s) => ({ c: s.c, r: s.r }));
  execFileSync("python3", ["-I", path.join(AUTOMATOR_ROOT, "scripts", "make-sphere-ct-phantom.py"), path.join(work, "ct"), "--spheres", JSON.stringify(spheres)], { stdio: "inherit" });

  const driver = new DesktopDriver();
  await driver.start();
  try {
    const page = driver.page;
    await resetDb(driver.ports.http);
    // 公開済みの最新版がこのビルドより新しいと「新しい版があります」が操作を塞ぐ。この検査では更新を見ないのでスキップ済みにする。
    await page.evaluate("localStorage.setItem('graphy.update.skipVersion', '0.6.2')");
    await page.reload({ waitUntil: "domcontentloaded" });
    const imp = await importPaths(driver.ports.http, [path.join(work, "ct")]);
    check(imp.imported === 160 && imp.failed === 0, "（前提）合成 CT の 160 枚を取り込めた", imp);
    await page.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
    await openFirstSeriesInViewer(page, createStepRecorder());
    const v3d = await driver.waitForNewPage(() => page.locator('button[title="3D Viewer"]').click(), (url) => url.includes("viewer3d"));
    v3d.on("console", (m) => { if (m.type() === "error") console.log(`  [3d error] ${m.text().slice(0, 200)}`); });
    await v3d.locator('[data-testid="viewer3d-mode-mip"]').waitFor({ timeout: 120_000 });
    await v3d.locator('[data-testid="viewer3d-mode-mip"]').click();
    await v3d.waitForTimeout(4000);
    await v3d.evaluate("globalThis.__name = (f) => f");
    const ready = await v3d.evaluate(() => { try { return !!(window as unknown as { __graphyDebug: { getViewer3dState: () => unknown } }).__graphyDebug.getViewer3dState(); } catch { return false; } });
    if (!ready) {
      notReached("3D が開き dev の口が使える", "getViewer3dState が null／例外。以降は行わない");
      return;
    }
    check(true, "3D が開き、dev の口が使える（MIP）");
    const windowsBefore = driver.app.windows().length;
    const timeOrigin = await v3d.evaluate(() => performance.timeOrigin);
    await v3d.evaluate("window.__marker = 12345");
    const write = (view: object, patch?: object) =>
      v3d.evaluate(([v, p]) => (window as unknown as { __graphyDebug: { setViewer3dPluginView: (v: object, p?: object) => boolean } }).__graphyDebug.setViewer3dPluginView(v, p ?? undefined), [view, patch ?? null] as [object, object | null]);
    const badge = v3d.getByTestId("viewer3d-plugin-view-badge");

    console.log("\n[0] 指定なしの状態（札が無い）");
    check((await badge.count()) === 0, "プラグインの指定が無いうちは札が出ない");

    console.log("\n[1] 開いた窓へ視点を書き込む（013-3 相当）");
    check(await write({ seq: 1, camera: camOf(UP_IN), provenance: { ...PROV, title: "検査視点" } }), "コンテキストを書き込めた");
    await badge.waitFor({ state: "visible", timeout: 10_000 });
    await v3d.waitForTimeout(800);
    const txt = (await badge.textContent()) ?? "";
    check(/Probe Plugin/.test(txt) && /検査視点/.test(txt), "札に出所（プラグイン名）と title が出る", txt);
    const s1 = await stateOf(v3d);
    check(near(s1.direction, D, 1e-6) && near(s1.viewUp, UP, 1e-6) && near(s1.focalPoint, F, 1e-6), "視線・上（直交化）・注視点が指定どおり（1e-6）", s1);
    check((await badge.getAttribute("data-away")) === "0", "適用直後は「離れた」印が無い");
    // 検出器の自己検査（先に）: クリップ面なしで球が全部写る／反対側には写らない
    const base = await sample(v3d, ALL);
    savePng("1-applied.png", base.png);
    console.log(`  lit=${JSON.stringify(base.lit)} max=${base.max.toFixed(0)} bg=${base.bg.toFixed(0)}`);
    check(!base.lost && base.max - base.bg > 30, "🔴 画面が真っ黒でない（球が描かれている）", { max: base.max, bg: base.bg });
    check(base.lit.center && base.lit.big && base.lit.right && base.lit.A && base.lit.B && !base.lit.bigMirror && !base.lit.rightMirror, "（自己検査）5 つの球が想定の位置に写り、反対側には何も写らない", base.lit);

    console.log("\n[2] 視点が離れた印と［指定に戻す］");
    const canvasBox = await v3d.evaluate(() => {
      let best: HTMLCanvasElement | null = null;
      for (const c of Array.from(document.querySelectorAll("canvas"))) if (!best || c.width * c.height > best.width * best.height) best = c;
      const r = best!.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    });
    await v3d.mouse.move(canvasBox.x + canvasBox.w / 2, canvasBox.y + canvasBox.h / 2);
    await v3d.mouse.down();
    await v3d.mouse.move(canvasBox.x + canvasBox.w / 2 + 120, canvasBox.y + canvasBox.h / 2 + 60, { steps: 8 });
    await v3d.mouse.up();
    await v3d.waitForTimeout(600);
    const s2 = await stateOf(v3d);
    check(!near(s2.viewUp, UP, 1e-3) || !near(s2.direction, D, 1e-3), "（前提）ドラッグで視点が実際に動いた", s2);
    check((await badge.getAttribute("data-away")) === "1", "視点を動かすと札に「離れた」印が付く");
    await v3d.getByTestId("viewer3d-plugin-view-restore").click();
    await v3d.waitForTimeout(800);
    const s3 = await stateOf(v3d);
    check(near(s3.direction, D, 1e-6) && near(s3.viewUp, UP, 1e-6) && near(s3.focalPoint, F, 1e-6), "🔴 ［指定に戻す］で指定の視点に戻る（1e-6）", s3);
    check((await badge.getAttribute("data-away")) === "0", "戻すと「離れた」印が消える");

    console.log("\n[3] 開いたままの更新（013-7 相当）: 窓が増えず・再読込されず・視点と札だけ変わる");
    check(await write({ seq: 2, camera: camOf(scale(UP_IN, -1)), provenance: { ...PROV, title: "別の視点" } }), "別の視点（up 反転）を書き込めた");
    await v3d.waitForTimeout(1000);
    const t2 = (await badge.textContent()) ?? "";
    check(/別の視点/.test(t2), "札の title が更新される", t2);
    const s4 = await stateOf(v3d);
    check(near(s4.viewUp, UP.map((x) => -x), 1e-6), "視点が更新される（上が反転）", s4.viewUp);
    const flipped = await sample(v3d, ALL);
    savePng("3-updated-up-flipped.png", flipped.png);
    check(flipped.lit.bigMirror && !flipped.lit.big && flipped.lit.rightMirror && !flipped.lit.right, "🔴 up を反転した視点で、大球が下・小球が左に写る（画素）", flipped.lit);
    check(driver.app.windows().length === windowsBefore, "窓が増えない", { before: windowsBefore, after: driver.app.windows().length });
    check((await v3d.evaluate(() => (window as unknown as { __marker?: number }).__marker)) === 12345 && (await v3d.evaluate(() => performance.timeOrigin)) === timeOrigin, "🔴 画面が再読込されない（ページの状態が残る）");
    // 同じ seq の再送は無視される
    await write({ seq: 2, camera: camOf(UP_IN), provenance: { ...PROV, title: "無視されるはず" } });
    await v3d.waitForTimeout(800);
    const s5 = await stateOf(v3d);
    check(near(s5.viewUp, UP.map((x) => -x), 1e-6) && !/無視されるはず/.test((await badge.textContent()) ?? ""), "同じ seq の再送は無視される（視点も札も変わらない）");
    await write({ seq: 1, camera: camOf(UP_IN), provenance: { ...PROV, title: "古い" } });
    await v3d.waitForTimeout(500);
    check(near((await stateOf(v3d)).viewUp, UP.map((x) => -x), 1e-6), "古い seq は無視される");

    console.log("\n[4] クリップ面（画素）とパネルの ON/OFF");
    check(await write({ seq: 3, camera: camOf(UP_IN), clipPlanes: [{ origin: F, normal: D, label: "検査面" }], provenance: { ...PROV, title: "クリップ" } }), "クリップ面つきの指定を書き込めた");
    await v3d.waitForTimeout(1200);
    const c1 = await sample(v3d, ALL);
    savePng("4-clip.png", c1.png);
    console.log(`  clip: lit=${JSON.stringify(c1.lit)}`);
    check(!c1.lost && c1.max - c1.bg > 30, "🔴 クリップ面を指定しても黒画面・コンテキスト喪失にならない", { max: c1.max, bg: c1.bg, lost: c1.lost });
    check(c1.lit.A && !c1.lit.B, "🔴 法線 +d（奥を向く）: 手前の球 B が消え、奥の球 A が残る", c1.lit);
    const row = v3d.getByTestId("viewer3d-plugin-clip-row-0");
    check((await row.count()) === 1 && /検査面/.test((await row.textContent()) ?? ""), "右パネルにクリップ面の行（ラベル）が出る");
    await v3d.getByTestId("viewer3d-plugin-clip-toggle").first().click();
    await v3d.waitForTimeout(600);
    const c2 = await sample(v3d, ALL);
    check(c2.lit.A && c2.lit.B, "パネルで面を OFF にすると球 A・B の両方が戻る", c2.lit);
    await v3d.getByTestId("viewer3d-plugin-clip-toggle").first().click();
    await v3d.waitForTimeout(600);
    const c3 = await sample(v3d, ALL);
    check(c3.lit.A && !c3.lit.B, "ON に戻すと再び B が消える", c3.lit);
    // 既存のクリップ箱を ON にしても、プラグインの面は効いたまま
    const boxBtn = v3d.getByRole("button", { name: /クリップ箱|clip box/i });
    if ((await boxBtn.count()) > 0) {
      await boxBtn.first().click();
      await v3d.waitForTimeout(800);
      const c4 = await sample(v3d, ALL);
      check(c4.lit.A && !c4.lit.B, "既存のクリップ箱を ON にしても、プラグインの面は効いたまま", c4.lit);
      await boxBtn.first().click();
      await v3d.waitForTimeout(500);
    } else notReached("既存のクリップ箱との併用", "クリップ箱のボタンが見つからない");
    // クリップ面を省略した更新は「変えない」
    await write({ seq: 4, camera: camOf(UP_IN), provenance: { ...PROV, title: "面は据え置き" } });
    await v3d.waitForTimeout(1000);
    const c5 = await sample(v3d, ALL);
    check(c5.lit.A && !c5.lit.B && (await stateOf(v3d)).clipPlanes.length === 1, "クリップ面を省略した更新は、面を変えない", c5.lit);
    // [] で全部消える
    await write({ seq: 5, clipPlanes: [], provenance: { ...PROV, title: "面を消す" } });
    await v3d.waitForTimeout(1000);
    const c6 = await sample(v3d, ALL);
    check(c6.lit.A && c6.lit.B && (await stateOf(v3d)).clipPlanes.length === 0, "clipPlanes: [] で全部消え、両方戻る", c6.lit);
    // 面を戻して［×］
    await write({ seq: 6, clipPlanes: [{ origin: F, normal: D }], provenance: { ...PROV, title: "もう一度" } });
    await v3d.waitForTimeout(1000);
    await v3d.getByTestId("viewer3d-plugin-view-clear").click();
    await v3d.waitForTimeout(800);
    const c7 = await sample(v3d, ALL);
    check((await badge.count()) === 0 && c7.lit.A && c7.lit.B, "［×］で札とクリップ面が消える（視点は今のまま）", c7.lit);

    console.log("\n[5] 拒否（何も変えない）");
    await write({ seq: 7, camera: camOf(UP_IN), clipPlanes: [{ origin: F, normal: D }], provenance: { ...PROV, title: "正常" } });
    await v3d.waitForTimeout(1000);
    const before = await stateOf(v3d);
    await write({ seq: 8, camera: { ...camOf(UP_IN), direction: [0, 0, 0] as V3 }, provenance: { ...PROV, title: "視線 0" } });
    await v3d.waitForTimeout(800);
    check((await badge.getAttribute("data-error")) === "1", "視線 0 は拒否され、札に理由が出る");
    const after = await stateOf(v3d);
    check(near(after.direction, before.direction, 1e-9) && near(after.viewUp, before.viewUp, 1e-9) && after.clipPlanes.length === 1, "拒否しても視点・クリップ面は変わらない", { before, after });
    const seven = Array.from({ length: 7 }, () => ({ origin: F, normal: D }));
    await write({ seq: 9, clipPlanes: seven, provenance: { ...PROV, title: "7 枚" } });
    await v3d.waitForTimeout(800);
    check((await badge.getAttribute("data-error")) === "1" && (await stateOf(v3d)).clipPlanes.length === 1, "クリップ面 7 枚は拒否され、面は 1 枚のまま");

    console.log("\n[6] 別のシリーズのコンテキストなら従来どおり読み直す（既存の挙動の維持）");
    // 別窓（2D 側）からの書き込みを再現する。storage イベントは書いた窓には届かないので、主画面から書く。
    await page.evaluate(() => {
      const raw = localStorage.getItem("graphy-viewer3d-ctx");
      if (!raw) return;
      const ctx = JSON.parse(raw);
      localStorage.setItem("graphy-viewer3d-ctx", JSON.stringify({ ...ctx, series: { seriesInstanceUid: "1.2.3.4.5.999" }, ts: Date.now() }));
    });
    await v3d.waitForTimeout(6000);
    const reloaded = await v3d.evaluate(() => (window as unknown as { __marker?: number }).__marker === undefined).catch(() => true);
    check(reloaded, "別シリーズでは画面が読み直される（ページの状態が消える）");
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
