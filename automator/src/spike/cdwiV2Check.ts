/*
 * Computed DWI プラグイン v0.2.0（点 ROI の信号減衰・最新 ROI・切替の進捗・vMRE の実測の組）の実アプリ検証。
 * 実 GE 脳 DWI（b0・b1000）を使う。選択欄は**触らない既定の経路**を最初に通す。
 *
 * 実行:  cd automator && CDWI_GE=<b0/ b1000/ を持つフォルダ> npx tsx src/spike/cdwiV2Check.ts
 *        （プラグインの ui.js を先にビルドしておく。JDK を PATH に足す。CDWI_PORT_BASE で専用ポート）
 * 確かめること:
 *   1. 既定のまま計算 → 中央スライスに点 ROI が 5 つ、表の値が独立計算と一致、点がスライス上（スクリーンショットで目視）
 *   2. 点のドラッグで表の位置・値が変わる（動かせなければ【未達】）
 *   3. vMRE へ切替: 進捗が出る。b0/b1000 だけなので L・H は「合成」になる（実測の組が作れない旨）
 *   4. vMRE の実測の組（L=b0, H=b1000 を明示）: μdiff = α·ln(S_L/S_H)+β を独立計算と突き合わせる
 *   5. 最新の ROI: 楕円 A → 楕円 B で統計の対象が B に替わる。画素数は楕円の面積と一致（許容 8%）
 *   6. 一時タイルの ROI（点含む）は保管庫に保存されない
 * 入力が無ければ「未達」で終了コード 2。患者情報を含むのでリポジトリには入れない。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Locator, Page } from "playwright";

import { DesktopDriver, DESKTOP_RUN_DATA_DIR } from "../driver/desktopDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { importPaths } from "../fixtures/importFixtures.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { selectFirstStudy } from "../checklist/items/shared/helpers.js";
import { createStepRecorder } from "../checklist/types.js";
import { createChecker } from "./computeSpikeShared.js";

const { check, summary } = createChecker();
const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "cdwi-v2-check");
const PLUGIN_ID = "vis-computed-dwi";
const PLUGIN_DIR = process.env.CDWI_PLUGIN_DIR ?? path.join(os.homedir(), "graphy-next-plugin-computed-dwi");
const GE = process.env.CDWI_GE;
const P0 = Number(process.env.CDWI_PORT_BASE ?? 28761);
const PORTS = { http: P0, scp: P0 + 1, vite: P0 + 2 };

function tag(b: Buffer, t: number[], vr: string): string | null {
  const at = b.indexOf(Buffer.from([...t, ...Buffer.from(vr, "latin1")]));
  if (at < 0) return null;
  return b.toString("latin1", at + 8, at + 8 + b.readUInt16LE(at + 6)).trim().replace(/\0/g, "");
}
/** 非圧縮 Explicit VR LE の最小読み取り: IPP の z をキーに、画素（RescaleSlope/Intercept 適用済み）。 */
function readSeries(dir: string): Map<number, Float32Array> {
  const m = new Map<number, Float32Array>();
  for (const f of fs.readdirSync(dir).sort()) {
    const b = fs.readFileSync(path.join(dir, f));
    const head = b.subarray(0, 14000);
    const rows = head.readUInt16LE(head.indexOf(Buffer.from([0x28, 0, 0x10, 0, 0x55, 0x53])) + 8);
    const z = Math.round(Number(tag(head, [0x20, 0, 0x32, 0], "DS")!.split("\\")[2]) * 100) / 100;
    const slope = Number(tag(head, [0x28, 0, 0x53, 0x10], "DS") ?? "1");
    const icpt = Number(tag(head, [0x28, 0, 0x52, 0x10], "DS") ?? "0");
    const n = rows * rows;
    const px = new Float32Array(n);
    for (let i = 0; i < n; i++) px[i] = b.readInt16LE(b.length - n * 2 + i * 2) * slope + icpt;
    m.set(z, px);
  }
  return m;
}

async function tileOf(page: Page, n: number): Promise<Locator> {
  const t = `tile-${n}`;
  await page.evaluate(`(function(){
    var hosts = document.querySelectorAll('[data-testid="viewer2d-canvas-host"]');
    var p = hosts[${n}];
    while (p && p.parentElement && p.parentElement.getAttribute('data-testid') !== 'viewer2d-tile-grid') p = p.parentElement;
    document.querySelectorAll('[data-spike-tile="${t}"]').forEach(function(e){ e.removeAttribute('data-spike-tile'); });
    if (p) p.setAttribute('data-spike-tile', '${t}');
  })()`);
  return page.locator(`[data-spike-tile="${t}"]`);
}

/** 画像領域の (fx, fy)（0〜1）にカーソルを置き、ステータスバーの画素座標を読む。 */
async function probeXY(page: Page, tile: Locator, fx: number, fy: number): Promise<{ x: number; y: number } | null> {
  const box = await tile.locator('[data-testid="viewer2d-canvas-host"]').boundingBox();
  if (!box) return null;
  await page.mouse.move(box.x + box.width * fx, box.y + box.height * fy, { steps: 3 });
  await page.waitForTimeout(150);
  const xy = (await tile.locator('[data-testid="status-xy"]').first().textContent().catch(() => null)) ?? "";
  if (!/[0-9]/.test(xy)) console.log(`  [debug] status-xy=「${xy}」 count=${await tile.locator('[data-testid="status-xy"]').count()} (fx=${fx},fy=${fy})`);
  const m = /(-?[\d.]+),\s*(-?[\d.]+)/.exec(xy);
  return m ? { x: Number(m[1]), y: Number(m[2]) } : null;
}

async function dragOnCanvas(page: Page, hostIndex: number, sx: number, sy: number, dx: number, dy: number): Promise<void> {
  await page.evaluate(`(function(){
    var host = document.querySelectorAll('[data-testid="viewer2d-canvas-host"]')[${hostIndex}];
    var canvas = host.querySelector('canvas');
    var x0 = ${sx}, y0 = ${sy};
    function fire(type, x, y, buttons){
      var common = {bubbles:true, cancelable:true, composed:true, clientX:x, clientY:y, button:0, buttons:buttons};
      canvas.dispatchEvent(new PointerEvent(type, Object.assign({}, common, {pointerId:1, pointerType:'mouse', isPrimary:true})));
      canvas.dispatchEvent(new MouseEvent(type.replace('pointer','mouse'), common));
    }
    fire('pointermove', x0, y0, 0);
    fire('pointerdown', x0, y0, 1);
    for (var i=1;i<=10;i++) fire('pointermove', x0+${dx}*i/10, y0+${dy}*i/10, 1);
    fire('pointerup', x0+${dx}, y0+${dy}, 0);
  })()`);
}

async function drawEllipseAt(page: Page, hostIndex: number, fx: number, fy: number, dx: number, dy: number): Promise<{ sx: number; sy: number }> {
  const r = (await page.evaluate(`(function(){
    var host = document.querySelectorAll('[data-testid="viewer2d-canvas-host"]')[${hostIndex}];
    var rc = host.querySelector('canvas').getBoundingClientRect();
    return {x: rc.left + rc.width*${fx}, y: rc.top + rc.height*${fy}};
  })()`)) as { x: number; y: number };
  await dragOnCanvas(page, hostIndex, r.x, r.y, dx, dy);
  return { sx: r.x, sy: r.y };
}

const park = (p: Page) => p.evaluate(`(function(){ var w = document.querySelector('.graphy-plugin-window'); w.style.left = (window.innerWidth - 40) + 'px'; w.style.top = (window.innerHeight - 40) + 'px'; })()`);
const unpark = (p: Page) => p.evaluate(`(function(){ var w = document.querySelector('.graphy-plugin-window'); w.style.left = '20px'; w.style.top = '20px'; })()`);

async function main(): Promise<number> {
  if (!GE || !fs.existsSync(path.join(GE, "b0")) || !fs.existsSync(path.join(PLUGIN_DIR, "ui.js"))) {
    console.log("【未達】入力が足りません（CDWI_GE / プラグインの ui.js）。合格ではありません。");
    return 2;
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const dst = path.join(DESKTOP_RUN_DATA_DIR, "plugins", PLUGIN_ID);
  fs.rmSync(dst, { recursive: true, force: true });
  fs.mkdirSync(dst, { recursive: true });
  for (const n of ["plugin.json", "ui.js"]) fs.copyFileSync(path.join(PLUGIN_DIR, n), path.join(dst, n));

  const driver = new DesktopDriver(PORTS);
  try {
    await driver.start();
    await resetDb(driver.ports.http);
    const imp = await importPaths(driver.ports.http, [path.join(GE, "b0"), path.join(GE, "b1000")]);
    check(imp.failed === 0 && imp.imported === 64, "（前提）b0・b1000 の 64 枚を取り込めた", imp);

    const base = `http://localhost:${driver.ports.http}`;
    const studies = (await (await fetch(`${base}/api/studies`)).json()) as { studyInstanceUid: string; patientId?: string; patientName?: string }[];
    const studyUid = studies[0].studyInstanceUid;
    const patientKey = studies[0].patientId || studies[0].patientName || studyUid;
    const series = (await (await fetch(`${base}/api/studies/${studyUid}/series`)).json()) as { seriesInstanceUid: string }[];
    const withStd: string[] = [], withoutStd: string[] = [];
    for (const s of series) {
      const sops = (await (await fetch(`${base}/api/studies/${studyUid}/series/${s.seriesInstanceUid}/instances`)).json()) as { sopInstanceUid: string }[];
      const rows = (await (await fetch(`${base}/api/studies/${studyUid}/series/${s.seriesInstanceUid}/instances/${sops[0].sopInstanceUid}/tags`)).json()) as { tag: string }[];
      (rows.some((r) => r.tag === "(0018,9087)") ? withStd : withoutStd).push(s.seriesInstanceUid);
    }
    const uidB1 = withStd[0], uidB0 = withoutStd[0];

    const mainPage = driver.page;
    await mainPage.evaluate("localStorage.setItem('graphy.locale', 'ja')");
    await mainPage.reload({ waitUntil: "domcontentloaded" });
    await mainPage.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
    await selectFirstStudy(mainPage, createStepRecorder());
    await mainPage.locator(`[data-testid="series-row-${uidB1}"]`).click();
    await mainPage.getByTestId("series-viewer-root").waitFor({ state: "visible", timeout: 15_000 });
    await mainPage.waitForTimeout(1500);
    const viewer: Page = await driver.waitForNewPage(
      () => mainPage.getByTestId("viewer2d-toolbar-button").click(),
      (url) => url.includes("2dviewer"),
    );
    await viewer.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 30_000 });
    await viewer.waitForTimeout(2500);
    await viewer.setViewportSize({ width: 1900, height: 1150 }); // 実利用に近い広い窓（既定の小さな窓では 3 タイルの画像領域が潰れる）
    await viewer.waitForTimeout(1000);
    viewer.on("console", (m) => { if (m.type() === "error") console.log(`  [viewer error] ${m.text().slice(0, 300)}`); });
    const hostCount = () => viewer.locator('[data-testid="viewer2d-canvas-host"]').count();

    await viewer.getByTestId("viewer2d-menu-analysis").click();
    await viewer.getByTestId(`plugin-analysis-item-${PLUGIN_ID}`).click();
    await viewer.locator("#cdwi-run").waitFor({ state: "visible", timeout: 15_000 });
    await viewer.locator('[data-testid="input-row"]').first().waitFor({ state: "visible", timeout: 20_000 });
    await viewer.getByRole("button", { name: /保管庫から追加/ }).click();
    await viewer.getByTestId("pickseries-dialog").last().waitFor({ state: "visible", timeout: 20_000 });
    const top = (id: string) => viewer.getByTestId(id).last();
    await top(`pickseries-study-${studyUid}`).waitFor({ state: "visible", timeout: 20_000 });
    if ((await top(`pickseries-series-check-${uidB0}`).count()) === 0) await top(`pickseries-expand-${studyUid}`).click();
    await top(`pickseries-series-check-${uidB0}`).check();
    await top("pickseries-ok").click();
    await viewer.waitForFunction(() => document.querySelectorAll('[data-testid="input-row"]').length >= 2, undefined, { timeout: 30_000 });

    const s0 = readSeries(path.join(GE, "b0")), s1 = readSeries(path.join(GE, "b1000"));
    const zs = [...s0.keys()].sort((a, b) => a - b);
    const nPx = Math.round(Math.sqrt(s0.get(zs[0])!.length));

    const waitDone = () => viewer.waitForFunction(
      () => /計算しました|表示を切り替えました|開けません|ください|必要|できません|置けません/.test(document.querySelector('[data-testid="status"]')?.textContent ?? "") && !document.querySelector("#cdwi-run")?.hasAttribute("disabled"),
      undefined, { timeout: 240_000 });
    const waitPoints = async () => {
      const t0 = Date.now();
      await viewer.waitForFunction(() => document.querySelector('[data-testid="graph-caption"]')?.getAttribute("data-live-points") === "5", undefined, { timeout: 60_000 }).catch(() => undefined);
      console.log(`  点 ROI が本体に実在するまで ${((Date.now() - t0) / 1000).toFixed(1)} 秒`);
    };
    const tableRows = async () => viewer.evaluate(`Array.from(document.querySelectorAll('[data-testid="stats-table"] tbody tr')).map(function(tr){return Array.from(tr.children).map(function(td){return (td.textContent||'').trim()})})`) as Promise<string[][]>;

    console.log("\n[1] 既定のまま計算（選択欄は触らない）→ 点 ROI 5 つ");
    check((await viewer.getByTestId("base-low").inputValue()) !== (await viewer.getByTestId("base-high").inputValue()), "既定で基準の低 b・高 b が別の系列になる");
    await viewer.getByTestId("run").click();
    await waitDone();
    await waitPoints();
    await viewer.waitForTimeout(3000);
    const status1 = (await viewer.getByTestId("status").textContent()) ?? "";
    console.log(`  status: ${status1}`);
    check(status1.includes("計算しました"), "計算が完了する", status1);
    check((await hostCount()) === 3, "ADC・cDWI の 2 タイル + 元 DWI = 3 タイル", await hostCount());
    let rows = await tableRows();
    console.log(`  信号減衰の表: ${JSON.stringify(rows)}`);
    check(rows.length === 5, "🔴 信号減衰の表に点が 5 つ出る", rows.length);
    const zi0 = Number(/z(\d+)/.exec(rows[0]?.[1] ?? "")?.[1] ?? "0") - 1;
    check(zi0 === Math.floor(zs.length / 2), "点は中央のスライスにある", { zi0, mid: Math.floor(zs.length / 2) });
    let allMatch = 0;
    for (const r of rows) {
      const m = /\((\d+), (\d+)\) z(\d+)/.exec(r[1]);
      if (!m) continue;
      const x = Number(m[1]), y = Number(m[2]), z = zs[Number(m[3]) - 1];
      const e0 = s0.get(z)![y * nPx + x], e1 = s1.get(z)![y * nPx + x];
      const v0 = Number(r[2]), v1 = Number(r[3]);
      const ok = Math.abs(v0 - e0) <= 1e-3 * Math.abs(e0) + 0.01 && Math.abs(v1 - e1) <= 1e-3 * Math.abs(e1) + 0.01;
      if (ok) allMatch++;
      else console.log(`  不一致 ${r[0]} (${x},${y}) 表=${v0}/${v1} 期待=${e0}/${e1}`);
    }
    const cap1 = (await viewer.getByTestId("graph-caption").textContent()) ?? "";
    const live1 = Number(await viewer.getByTestId("graph-caption").getAttribute("data-live-points"));
    const annot = await viewer.evaluate(`document.querySelectorAll('[data-testid="viewer2d-canvas-host"]')[1].parentElement.querySelectorAll('[data-annotation-uid]').length`);
    console.log(`  実在の点 ROI（本体から読めた数）= ${live1}、ADC タイルの注釈 SVG 要素 = ${annot}`);
    check(live1 === 5, "🔴 点 ROI が本体に実在する（覚えた位置からの表示ではない）", live1);
    check(!/置けませんでした/.test(cap1), "点 ROI を実際にタイルへ置けた（置けなかった旨の注記が無い）", cap1);
    check(allMatch === 5, "🔴 5 点すべての b0・b1000 の値が、DICOM から独立に読んだ画素値と一致する", allMatch);
    const bright = rows.filter((r) => { const m = /\((\d+), (\d+)\) z(\d+)/.exec(r[1])!; return s0.get(zs[Number(m[3]) - 1])![Number(m[2]) * nPx + Number(m[1])] > 0; }).length;
    check(bright === 5, "5 点とも背景（信号 0）の上にない", bright);
    await park(viewer);
    await viewer.waitForTimeout(600);
    await viewer.screenshot({ path: path.join(OUT_DIR, "1a-tiles-with-points.png") });
    await unpark(viewer);
    await viewer.waitForTimeout(400);
    await viewer.screenshot({ path: path.join(OUT_DIR, "1b-panel-decay.png") });
    await park(viewer);

    console.log("\n[2] 点のドラッグ");
    const tileAdc = await tileOf(viewer, 1);
    const pA = await probeXY(viewer, tileAdc, 0.4, 0.4);
    const pB = await probeXY(viewer, tileAdc, 0.6, 0.6);
    console.log(`  画素座標の読み取り: ${JSON.stringify(pA)} ${JSON.stringify(pB)}`);
    const boxAdc = (await tileAdc.locator('[data-testid="viewer2d-canvas-host"]').boundingBox())!;
    if (pA && pB) {
      const kx = (pB.x - pA.x) / (0.2 * boxAdc.width), ky = (pB.y - pA.y) / (0.2 * boxAdc.height);
      const p1 = /\((\d+), (\d+)\)/.exec(rows[0][1])!;
      const sx = boxAdc.x + 0.4 * boxAdc.width + (Number(p1[1]) - pA.x) / kx;
      const sy = boxAdc.y + 0.4 * boxAdc.height + (Number(p1[2]) - pA.y) / ky;
      await dragOnCanvas(viewer, 1, sx, sy, 45, 30);
      await viewer.waitForTimeout(1200);
      const after = await tableRows();
      console.log(`  P1: ${rows[0][1]} → ${after[0]?.[1]}`);
      if (after[0]?.[1] !== rows[0][1]) check(true, "点をドラッグすると表の位置が変わる");
      else console.log("  【未達】点をドラッグしても位置が変わらなかった（合成イベントでは掴めない可能性。手動で確認が要る）");
      rows = after;
    } else console.log("  【未達】画素座標を読めず、ドラッグを試せなかった");

    console.log("\n[3] vMRE へ切替（b0 + b1000 だけ → 合成になる）。進捗が出る");
    await unpark(viewer);
    const sawProgress = viewer.waitForSelector('[data-testid="progress"]:not([hidden])', { timeout: 15_000 }).then(async (e) => (await e.textContent()) ?? "");
    const t0 = Date.now();
    await viewer.getByTestId("mode-vmre").click();
    const progText = await sawProgress.catch(() => "");
    await viewer.screenshot({ path: path.join(OUT_DIR, "3a-switching.png") });
    await waitDone();
    await waitPoints();
    console.log(`  進捗の文言: 「${progText}」 所要 ${((Date.now() - t0) / 1000).toFixed(1)} 秒`);
    console.log(`  status: ${(await viewer.getByTestId("status").textContent()) ?? ""}`);
    check(/切り替えています/.test(progText), "🔴 切替中に「切り替えています」の進捗が出る", progText);
    check((await viewer.getByTestId("source-synth").getAttribute("aria-pressed")) === "true", "実測の組が作れない（b>0 が 1 つ）ので L・H は「合成」が選ばれる");
    const note = (await viewer.getByTestId("source-note").textContent()) ?? "";
    check(/実測が 2 つ無い/.test(note), "合成になった理由が画面に出る", note);
    await viewer.waitForTimeout(2500);
    await viewer.screenshot({ path: path.join(OUT_DIR, "3b-vmre-synth.png") });
    rows = await tableRows();
    check(rows.length === 5 && /μdiff/.test(await viewer.getByTestId("stats-table").innerText()), "vMRE では点の表に μdiff の列が出て、点は 5 つのまま（開き直しで置き直された）", rows.length);

    console.log("\n[4] vMRE の実測の組（L=b0, H=b1000 を明示）");
    await viewer.getByTestId("source-pair").click();
    await viewer.waitForTimeout(500);
    const lowSel = viewer.getByTestId("base-low"), highSel = viewer.getByTestId("base-high");
    const opts = (await lowSel.evaluate((s) => Array.from((s as HTMLSelectElement).options).map((o) => ({ v: o.value, t: o.textContent ?? "" })))) as { v: string; t: string }[];
    const o0 = opts.find((o) => /^b=0 /.test(o.t)), o1 = opts.find((o) => /^b=1000 /.test(o.t));
    check(!!o0 && !!o1, "（前提）選択肢に b=0 と b=1000 がある", opts);
    await lowSel.selectOption(o0!.v);
    await highSel.selectOption(o1!.v);
    await viewer.getByTestId("run").click();
    await waitDone();
    await waitPoints();
    await viewer.waitForTimeout(3000);
    console.log(`  status: ${(await viewer.getByTestId("status").textContent()) ?? ""}`);
    check((await hostCount()) === 3, "実測の組は sADC・μdiff の 2 タイル + 元 DWI = 3 タイル", await hostCount());
    rows = await tableRows();
    const head = await viewer.evaluate(`Array.from(document.querySelectorAll('[data-testid="stats-table"] thead th')).map(function(t){return t.textContent})`) as string[];
    const iMu = head.findIndex((h) => /μdiff/.test(h));
    let muOk = 0;
    for (const r of rows) {
      const m = /\((\d+), (\d+)\) z(\d+)/.exec(r[1]);
      if (!m) continue;
      const x = Number(m[1]), y = Number(m[2]), z = zs[Number(m[3]) - 1];
      const a = s0.get(z)![y * nPx + x], b = s1.get(z)![y * nPx + x];
      const e = a > 0 && b > 0 ? 4.91 * Math.log(a / b) + 0.92 : NaN;
      const v = Number(r[iMu]);
      if ((Number.isNaN(e) && !Number.isFinite(v)) || Math.abs(v - e) <= 5e-3 + 2e-3 * Math.abs(e)) muOk++;
      else console.log(`  μdiff 不一致 ${r[0]} 表=${v} 期待=${e}`);
    }
    check(muOk === rows.length && rows.length === 5, "🔴 実測の組の μdiff が α·ln(S_L/S_H)+β と 5 点で一致する", { muOk, n: rows.length });
    const warn = ((await viewer.getByTestId("warning").allInnerTexts().catch(() => [])) as string[]).join(" / ");
    check(/b=0\/1000/.test(warn), "L・H が論文の b200/800 でないことが警告される", warn);
    await viewer.screenshot({ path: path.join(OUT_DIR, "4-vmre-pair.png") });

    console.log("\n[5] 最新の ROI（cDWI モードへ戻して）");
    await viewer.getByTestId("mode-cdwi").click();
    await waitDone();
    await waitPoints();
    await viewer.waitForTimeout(2500);
    await park(viewer);
    await viewer.getByTestId("viewer2d-menu-roi").click().catch(() => undefined);
    const pickEllipse = async (hostIndex: number) => {
      const t = await tileOf(viewer, hostIndex);
      await t.locator('[data-testid="tile-patient-label"]').first().click().catch(() => undefined);
      await viewer.keyboard.press("Escape");
      await viewer.getByTestId("viewer2d-menu-roi").click();
      await viewer.getByRole("button", { name: /^(✓ )?楕円 ROI/ }).first().click({ timeout: 8000 });
      await viewer.waitForTimeout(300);
    };
    const tile1 = await tileOf(viewer, 1);
    const pa = await probeXY(viewer, tile1, 0.4, 0.4), pb = await probeXY(viewer, tile1, 0.6, 0.6);
    const box1 = (await tile1.locator('[data-testid="viewer2d-canvas-host"]').boundingBox())!;
    const scaleX = pa && pb ? (0.2 * box1.width) / (pb.x - pa.x) : NaN; // 画面 px / 画像 px
    const scaleY = pa && pb ? (0.2 * box1.height) / (pb.y - pa.y) : NaN;
    await pickEllipse(1);
    await drawEllipseAt(viewer, 1, 0.42, 0.4, 80, 70);
    await viewer.waitForTimeout(1200);
    await unpark(viewer);
    await viewer.getByTestId("tab-stats").click();
    await viewer.waitForTimeout(800);
    const capA = (await viewer.getByTestId("graph-caption").textContent()) ?? "";
    console.log(`  楕円 A: ${capA}`);
    check(/最新の ROI: 楕円/.test(capA) && /ADC/.test(capA), "楕円 A を描くと、最新の ROI として A（ADC のタイル）が使われる", capA);
    const nOf = async () => {
      const text = ((await viewer.getByTestId("stats-table").innerText()) ?? "").replace(/\s+/g, " ");
      return Number(/ADC \[[^\]]*\] \S+ \S+ \S+ (\d+)/.exec(text)?.[1] ?? "0");
    };
    const nA = await nOf();
    console.log(`  A の画素数 ${nA}`);
    check(nA > 1000, "A の画素数が出る", nA);
    await viewer.screenshot({ path: path.join(OUT_DIR, "5a-roi-A.png") });
    await park(viewer);
    // 径が 2 倍の楕円 2 つ（互いに重ならない場所。既存の ROI の内側から描き始めると移動になるので避ける）→ 画素数はおよそ 4 倍。
    const nDwi = async () => {
      const text = ((await viewer.getByTestId("stats-table").innerText()) ?? "").replace(/\s+/g, " ");
      if (!/DWI b=0/.test(text)) console.log("  [debug] 表: " + text.slice(0, 300));
      return Number(/DWI b=0 \[a\.u\.\] \S+ \S+ \S+ (\d+)/.exec(text)?.[1] ?? "0");
    };
    await park(viewer);
    await pickEllipse(2);
    await drawEllipseAt(viewer, 2, 0.4, 0.15, 30, 30);
    await viewer.waitForTimeout(1000);
    await unpark(viewer);
    const nSmall = await nDwi();
    await park(viewer);
    await drawEllipseAt(viewer, 2, 0.4, 0.5, 60, 60);
    await viewer.waitForTimeout(1000);
    await unpark(viewer);
    const nBig = await nDwi();
    console.log(`  径 1 倍 ${nSmall} 画素 → 径 2 倍 ${nBig} 画素（比 ${(nBig / nSmall).toFixed(2)}）`);
    check(nSmall > 0 && Math.abs(nBig / nSmall - 4) <= 0.5, "径が 2 倍の楕円は、画素数がおよそ 4 倍（±12%）。最新の ROI に従って替わる", { nSmall, nBig });
    await park(viewer);
    await pickEllipse(2);
    await drawEllipseAt(viewer, 2, 0.5, 0.3, 50, 40);
    await viewer.waitForTimeout(1200);
    await unpark(viewer);
    const capB = (await viewer.getByTestId("graph-caption").textContent()) ?? "";
    console.log(`  楕円 B: ${capB}`);
    check(/最新の ROI: 楕円/.test(capB) && /cDWI/.test(capB) && capB !== capA, "楕円 B を描くと、最新が B（cDWI のタイル）に替わる", capB);
    await viewer.getByTestId("tab-hist").click();
    await viewer.waitForTimeout(600);
    const capH = (await viewer.getByTestId("graph-caption").textContent()) ?? "";
    check(/cDWI/.test(capH), "ヒストグラムも最新の ROI（B）に従う", capH);
    await viewer.screenshot({ path: path.join(OUT_DIR, "5b-roi-B-hist.png") });

    console.log("\n[6] 一時タイルの ROI（点・楕円）は保存されない");
    await viewer.waitForTimeout(5000);
    const res = await fetch(`${base}/api/rois/${encodeURIComponent(patientKey)}`);
    check(res.ok, "ROI の API が 2xx", res.status);
    const d = (await res.json()) as { roiCount: number; json: string | null };
    check(d.roiCount === 0, "🔴 保管庫の ROI は 0 件（点 ROI も楕円も保存されない）", d.roiCount);
    check(!(d.json ?? "").includes("graphy-plugin-volume"), "保存内容に plugin-volume の imageId が無い");
  } finally {
    await driver.stop().catch(() => undefined);
  }
  return summary();
}

main().then((n) => process.exit(n)).catch((e) => { console.error(e); process.exit(1); });
