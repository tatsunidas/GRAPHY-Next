/*
 * 表示中のタイル画像の添付（captureView）の実機検証。
 *
 * 実行:  cd automator && npx tsx src/spike/assistantCaptureCheck.ts
 *
 * 本物の Electron ＋ backend ＋ fixture(ct-basic) の #2dviewer 窓。main の確認ダイアログ（dialog.showMessageBox）はスタブして
 * 回数・応答・icon の有無を見る。提供元は偽サーバー（ループバック）で、受け取った本文を記録する。確かめること:
 *   1. 前提: 楕円 ROI が実在する
 *   2. 🔴 ROI を含める／含めないで画素が**異なる**。長辺 ≤ 1024。PNG/JPEG として復号できる。ローカル宛ては確認なし
 *   3. 🔴 ボタンで添付欄にサムネイルが入り、焼き込み文字の注意が出る。送信すると偽サーバーが image-to-text のモデルで画像つきの本文を受ける
 *   4. 🔴 外部宛て(非ループバック): 画像ごとに確認が出て（icon つき）、取り消すと添付されない
 *   5. 🔴 image-to-text が無い提供元では image-model-not-set（黙って落とさない）
 *   6. 🔴 読み取りだけ（ROI の件数が変わらない）。メイン窓からの中継は forbidden
 *   7. 🔴 選択中の ROI の外接矩形で切り出し: 画像の大きさが ROI の画面上の寸法＋余白に一致し（期待値は ROI のハンドルから別に計算）、別の ROI でも追従。
 *      選択が無ければ no-selected-roi（添付されず確認も出ない）。切り出しは読み取りだけ（ROI の件数・選択が不変）。外部宛てでは切り出し後の画像に確認が出る
 * 未達として残すもの: 実 OS のネイティブ確認ダイアログの見た目／実クラウド提供元への実送信と応答品質。
 */
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import type { Page } from "playwright";

import { DesktopDriver } from "../driver/desktopDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { importFixtureCategory } from "../fixtures/importFixtures.js";
import { openFirstSeriesInViewer } from "../checklist/items/shared/helpers.js";
import { createStepRecorder } from "../checklist/types.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { createChecker } from "./computeSpikeShared.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "assistant-capture-check");
const PORTS = { http: 19390, scp: 19391, vite: 19393 };
const { check, summary } = createChecker();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function dismissUpdate(page: Page): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await page.evaluate(`(function(){ var b=[].slice.call(document.querySelectorAll("button")).find(function(x){return /^(後で|Later)$/.test((x.textContent||"").trim());}); if(b) b.click(); })()`).catch(() => undefined);
    await sleep(500);
  }
}

/** 偽の提供元（OpenAI 互換）。受けた本文を記録し、短い返答を SSE で返す。 */
function startFake(): Promise<{ port: number; bodies: string[]; close: () => void }> {
  const bodies: string[] = [];
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        bodies.push(Buffer.concat(chunks).toString("utf8"));
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "了解" }, finish_reason: "stop" }] })}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      });
    });
    server.listen(0, "127.0.0.1", () => resolve({ port: (server.address() as net.AddressInfo).port, bodies, close: () => server.close() }));
  });
}

type Img = { base64: string; mimeType: string; w: number; h: number };
type Res = { ok: boolean; error?: string; image?: Img };

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const driver = new DesktopDriver(PORTS);
  const fake = await startFake();
  let dataDir = "";
  const clean = () => {
    for (const f of ["ai-providers.json", "secrets.enc.json"]) {
      if (dataDir && fs.existsSync(path.join(dataDir, f))) fs.rmSync(path.join(dataDir, f));
    }
  };
  try {
    await driver.start();
    const info = await driver.app.evaluate(({ dialog }) => {
      dialog.showMessageBoxSync = (() => 0) as typeof dialog.showMessageBoxSync;
      return { cwd: process.cwd() };
    });
    dataDir = info.cwd;
    clean();
    const main: Page = driver.page;
    await resetDb(driver.ports.http);
    await importFixtureCategory(driver.ports.http, "ct-basic");
    await main.reload({ waitUntil: "domcontentloaded" });
    await main.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 30_000 });
    await dismissUpdate(main);
    await openFirstSeriesInViewer(main, createStepRecorder());
    await dismissUpdate(main);
    const viewer = await driver.waitForNewPage(() => main.getByTestId("viewer2d-toolbar-button").click(), (u) => u.includes("2dviewer"));
    await viewer.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 20_000 });
    await viewer.waitForTimeout(2500);

    // 起動処理のあとでスタブする（確認 0=添付 / 1=取り消し）
    await driver.app.evaluate(({ dialog }) => {
      const g = globalThis as unknown as { __dlg: { n: number; response: number; last: unknown; icon: boolean } };
      g.__dlg = { n: 0, response: 0, last: null, icon: false };
      (dialog as unknown as { showMessageBox: unknown }).showMessageBox = async (_w: unknown, o: { icon?: { isEmpty?: () => boolean } }) => {
        g.__dlg.n++;
        g.__dlg.last = o;
        g.__dlg.icon = !!o.icon && o.icon.isEmpty?.() === false;
        return { response: g.__dlg.response, checkboxChecked: false };
      };
    });
    type Dlg = { n: number; icon: boolean; last: { message?: string; detail?: string } | null };
    const dlg = () => driver.app.evaluate(() => (globalThis as unknown as { __dlg: Dlg }).__dlg);
    const setResponse = (r: number) => driver.app.evaluate((_a, v) => { (globalThis as unknown as { __dlg: { response: number } }).__dlg.response = v; }, r);
    const setProvider = async (endpoint: string, label: string, auth: "none" | "api-key", withImage: boolean) => {
      const models: Record<string, string> = { "text-to-text": "tiny" };
      if (withImage) models["image-to-text"] = "vlm";
      const p = { id: "p1", label, kind: "openai", endpoint, auth, models };
      return main.evaluate(
        (cfg) => (window as unknown as { graphyDesktop: { aiProvidersSet: (c: unknown) => Promise<{ ok: boolean; problems?: string[] }> } }).graphyDesktop.aiProvidersSet(cfg),
        { providers: [p], defaults: { "text-to-text": "p1", "image-to-text": withImage ? "p1" : undefined } },
      );
    };

    const win = await driver.waitForNewPage(async () => {
      await main.getByTestId("mainscreen-menu-system").click();
      await main.getByTestId("menu-item-assistant").click();
    }, (u) => u.includes("#assistant"));
    await win.getByTestId("assistant-root").waitFor({ state: "visible", timeout: 20_000 });
    await win.setViewportSize({ width: 560, height: 820 });
    await sleep(600);
    const cmd = (withRoi: boolean, crop = false) =>
      win.evaluate(([w, c]) => (window as unknown as { graphyDesktop: { assistantViewerCmd: (s: string, c: unknown) => Promise<Res> } }).graphyDesktop.assistantViewerCmd("cap", { kind: "captureView", withRoi: w, ...(c ? { crop: true } : {}) }), [withRoi, crop] as [boolean, boolean]);
    const selectedUids = () => viewer.evaluate(`(function(){ return window.__graphyDebug.getSelectedAnnotations(); })()`) as Promise<string[]>;
    const roiPoints = () => viewer.evaluate(`(function(){ return window.__graphyDebug.getAnnotationCanvasPoints(); })()`) as Promise<{ uid: string; tool: string; points: number[][] }[]>;
    const canvasInfo = () => viewer.evaluate(`(function(){ var c=document.querySelector('[data-testid="series-viewer-root"] canvas'); return { cw: c.clientWidth, ch: c.clientHeight, scale: c.width / c.clientWidth }; })()`) as Promise<{ cw: number; ch: number; scale: number }>;
    const pickEllipse = async () => {
      const btn = viewer.getByRole("button", { name: /(楕円 ROI|Ellipse ROI)$/ }).first(); // 選択済みだと先頭に「✓ 」が付く
      if (!(await btn.isVisible().catch(() => false))) await viewer.getByTestId("viewer2d-menu-roi").click();
      await btn.waitFor({ state: "visible", timeout: 5000 }).catch(async () => {
        await viewer.screenshot({ path: path.join(OUT_DIR, "debug-menu.png") });
        throw new Error("楕円 ROI のボタンが見えない（debug-menu.png）");
      });
      await btn.click();
    };
    const drawEllipse = async (fx0: number, fy0: number, fx1: number, fy1: number) => {
      await pickEllipse();
      await viewer.waitForTimeout(250);
      const b = await viewer.getByTestId("series-viewer-root").first().boundingBox();
      if (!b) throw new Error("viewer box");
      await viewer.mouse.move(b.x + b.width * fx0, b.y + b.height * fy0);
      await viewer.mouse.down();
      await viewer.mouse.move(b.x + b.width * fx1, b.y + b.height * fy1, { steps: 10 });
      await viewer.mouse.up();
      await viewer.waitForTimeout(1500);
    };
    /** ROI のハンドル（CSS px）から期待する切り出しの画素寸法（余白 10%・最小 8 px・最小辺 64 px・画像内に収める → 長辺 1024 に縮小）。 */
    const expectedCrop = (pts: number[][], ci: { cw: number; ch: number; scale: number }) => {
      const xs = pts.map((p) => p[0]);
      const ys = pts.map((p) => p[1]);
      const edge = (lo: number, hi: number, max: number) => {
        const m = Math.max(8, (hi - lo) * 0.1);
        let l = lo - m;
        let r = hi + m;
        if (r - l < 64) { const g = 64 - (r - l); l -= g / 2; r += g / 2; }
        return Math.min(max, r) - Math.max(0, l);
      };
      const w = edge(Math.min(...xs), Math.max(...xs), ci.cw) * ci.scale;
      const h = edge(Math.min(...ys), Math.max(...ys), ci.ch) * ci.scale;
      const k = Math.min(1, 1024 / Math.max(w, h));
      return { w: w * k, h: h * k };
    };
    const annCount = () => viewer.evaluate(`(function(){ return window.__graphyDebug.getAnnotationCanvasPoints().length; })()`) as Promise<number>;
    /** 2 枚の画像の画素の違い（異なる画素の数）と大きさ。アシスタント窓で復号する。 */
    const diff = (a: Img, b: Img) =>
      win.evaluate(`(async function () {
        var load = async function (i) {
          var img = new Image();
          img.src = "data:" + i.mimeType + ";base64," + i.base64;
          await img.decode();
          var c = document.createElement("canvas");
          c.width = img.naturalWidth; c.height = img.naturalHeight;
          var ctx = c.getContext("2d");
          ctx.drawImage(img, 0, 0);
          return ctx.getImageData(0, 0, c.width, c.height);
        };
        var p = await load(${JSON.stringify(a)});
        var q = await load(${JSON.stringify(b)});
        if (p.width !== q.width || p.height !== q.height) return { sameSize: false, diff: -1, w: p.width, h: p.height };
        var d = 0;
        for (var i = 0; i < p.data.length; i += 4) if (p.data[i] !== q.data[i] || p.data[i + 1] !== q.data[i + 1] || p.data[i + 2] !== q.data[i + 2]) d++;
        return { sameSize: true, diff: d, w: p.width, h: p.height };
      })()`) as Promise<{ sameSize: boolean; diff: number; w: number; h: number }>;

    /** 提供元を変えたあと、アシスタント窓は読み込み直す（宛先の解決は起動時に行う）。 */
    const reopen = async () => {
      await win.reload({ waitUntil: "domcontentloaded" });
      await win.getByTestId("assistant-root").waitFor({ state: "visible", timeout: 20_000 });
      await win.setViewportSize({ width: 560, height: 820 });
      await sleep(800);
    };

    // --- 1. ROI を描く ---
    console.log("\n[1] 楕円 ROI を描く");
    const s1 = await setProvider(`http://127.0.0.1:${fake.port}`, "ローカル", "none", true);
    check(s1.ok === true, "ローカル提供元(image-to-text つき)を保存できる", s1);
    check((await annCount()) === 0, "前提: ROI が 0 件から始まる");
    await viewer.getByTestId("viewer2d-menu-roi").click();
    await viewer.getByRole("button", { name: /^(楕円 ROI|Ellipse ROI)$/ }).first().click();
    await viewer.waitForTimeout(250);
    const box = await viewer.getByTestId("series-viewer-root").first().boundingBox();
    if (!box) throw new Error("viewer box");
    await viewer.mouse.move(box.x + box.width * 0.35, box.y + box.height * 0.35);
    await viewer.mouse.down();
    await viewer.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.5, { steps: 10 });
    await viewer.mouse.up();
    await viewer.waitForTimeout(1500);
    const n1 = await annCount();
    check(n1 === 1, "前提: 楕円 ROI が 1 件描けた", n1);
    await viewer.screenshot({ path: path.join(OUT_DIR, "1-roi.png") });

    // --- 2. ローカル宛て: ROI 有り/無し ---
    console.log("\n[2] ROI 有り/無し（ローカル宛て）");
    const d0 = (await dlg()).n;
    const withRoi = await cmd(true);
    const noRoi = await cmd(false);
    check(withRoi.ok === true && !!withRoi.image?.base64 && noRoi.ok === true && !!noRoi.image?.base64, "どちらも画像が返る", { a: withRoi.error, b: noRoi.error });
    check((await dlg()).n === d0, "🔴 ローカル宛てでは確認が出ない");
    if (withRoi.image && noRoi.image) {
      check(withRoi.image.mimeType === "image/png" && noRoi.image.mimeType === "image/png", "PNG として返る", [withRoi.image.mimeType, noRoi.image.mimeType]);
      check(Math.max(withRoi.image.w, withRoi.image.h) <= 1024 && Math.max(noRoi.image.w, noRoi.image.h) <= 1024, "🔴 長辺 ≤ 1024", [withRoi.image.w, withRoi.image.h]);
      const df = await diff(withRoi.image, noRoi.image);
      console.log(`  画素の差: ${JSON.stringify(df)}`);
      check(df.sameSize && df.diff > 20, "🔴 ROI 有り／無しで画素が異なる（ROI の線の分）", df);
      const same = await diff(noRoi.image, (await cmd(false)).image!);
      check(same.sameSize && same.diff === 0, "対照: ROI 無し同士は同じ画素（差が ROI によることの確認）", same);
      fs.writeFileSync(path.join(OUT_DIR, "2-with-roi.png"), Buffer.from(withRoi.image.base64, "base64"));
      fs.writeFileSync(path.join(OUT_DIR, "2-no-roi.png"), Buffer.from(noRoi.image.base64, "base64"));
    }

    // --- 7（先に実施）. 選択中の ROI で切り出す ---
    console.log("\n[2b] 選択中の ROI の外接矩形で切り出す");
    const sel1 = await selectedUids();
    const rois1 = await roiPoints();
    check(sel1.length === 1 && rois1.length === 1 && sel1[0] === rois1[0].uid, "前提: 描いた ROI が選択されている", { sel1, n: rois1.length });
    const ci = await canvasInfo();
    const full = await cmd(false);
    const crop1 = await cmd(false, true);
    const exp1 = expectedCrop(rois1[0].points, ci);
    console.log(`  期待 ${exp1.w.toFixed(1)}×${exp1.h.toFixed(1)}  実際 ${crop1.image?.w}×${crop1.image?.h}（全体 ${full.image?.w}×${full.image?.h}）`);
    check(crop1.ok === true && !!crop1.image, "切り出しの画像が返る", crop1);
    check(!!crop1.image && Math.abs(crop1.image.w - exp1.w) <= 2 && Math.abs(crop1.image.h - exp1.h) <= 2, "🔴 画像の大きさが ROI の画面上の寸法＋余白に一致（期待値は ROI のハンドルから別に計算）", { exp1, got: [crop1.image?.w, crop1.image?.h] });
    check(!!crop1.image && !!full.image && crop1.image.w * crop1.image.h < full.image.w * full.image.h, "全体より小さい（対照: 切り出さなければ全体の大きさ）", [crop1.image?.w, full.image?.w]);
    const cropRoi = await cmd(true, true);
    if (crop1.image && cropRoi.image) {
      const df = await diff(crop1.image, cropRoi.image);
      check(df.sameSize && df.diff > 20, "🔴 切り出しでも ROI を含める／含めないで画素が異なる（ROI の線が切り出しに写っている）", df);
      fs.writeFileSync(path.join(OUT_DIR, "2b-crop-roi.png"), Buffer.from(cropRoi.image.base64, "base64"));
    }
    // 別の位置・別の大きさの ROI（描くと選択が移る）
    await drawEllipse(0.6, 0.55, 0.85, 0.85);
    const sel2 = await selectedUids();
    const rois2 = await roiPoints();
    const second = rois2.find((r) => r.uid !== rois1[0].uid);
    check(rois2.length === 2 && !!second && sel2.length === 1 && sel2[0] === second.uid, "前提: 2 つ目の ROI が選択に移った", { sel2, n: rois2.length });
    const crop2 = await cmd(false, true);
    const exp2 = second ? expectedCrop(second.points, ci) : { w: NaN, h: NaN };
    console.log(`  2 つ目: 期待 ${exp2.w.toFixed(1)}×${exp2.h.toFixed(1)}  実際 ${crop2.image?.w}×${crop2.image?.h}`);
    check(!!crop2.image && Math.abs(crop2.image.w - exp2.w) <= 2 && Math.abs(crop2.image.h - exp2.h) <= 2, "🔴 別の ROI でも寸法が追従する（定数でない）", { exp2, got: [crop2.image?.w, crop2.image?.h] });
    check(!!crop1.image && !!crop2.image && (crop1.image.w !== crop2.image.w || crop1.image.h !== crop2.image.h), "2 つの切り出しは大きさが異なる", [crop1.image?.w, crop2.image?.w]);
    await viewer.screenshot({ path: path.join(OUT_DIR, "2b-two-rois.png") });
    // 読み取りだけ: ROI の件数・選択が不変
    check((await roiPoints()).length === 2 && JSON.stringify(await selectedUids()) === JSON.stringify(sel2), "🔴 切り出しの前後で ROI の件数・選択が変わらない（対象は実在する）");
    // 選択なし: 空きの場所をクリックして選択を外す
    const dlgBefore = (await dlg()).n;
    await viewer.keyboard.press("Escape");
    await pickEllipse();
    const bx = await viewer.getByTestId("series-viewer-root").first().boundingBox();
    if (bx) {
      await viewer.mouse.click(bx.x + bx.width * 0.05, bx.y + bx.height * 0.95);
      await viewer.waitForTimeout(500);
    }
    const sel3 = await selectedUids();
    const noSel = await cmd(false, true);
    console.log(`  選択なし: selected=${JSON.stringify(sel3)} → ${JSON.stringify({ ok: noSel.ok, error: noSel.error })}`);
    check(sel3.length === 0, "前提: 選択が外れた", sel3);
    check(noSel.ok === false && noSel.error === "no-selected-roi" && !noSel.image, "🔴 選択が無ければ no-selected-roi（全体画像にフォールバックしない）", noSel);
    check((await dlg()).n === dlgBefore, "確認ダイアログも出ない", (await dlg()).n - dlgBefore);
    check(!!(await cmd(false)).image, "対照: 切り出さなければ同じ状態でも画像は取れる");
    // 画面: チェックを入れて押す → サムネイル、選択なしなら注意文
    await reopen();
    await win.getByTestId("assistant-attach-view-crop").check();
    await win.getByTestId("assistant-attach-view").click();
    await sleep(900);
    check(/選択されていません|No ROI is selected/.test((await win.locator("body").innerText())), "画面に「ROI が選択されていません」の注意が出る");
    await win.screenshot({ path: path.join(OUT_DIR, "2b-no-selection.png") });
    // 取り消しの対照: 以降のセクションは ROI 1 件前提なので 2 つ目を消す
    // （ROI を消す操作は 2D 窓のメニュー／キーに依存するため、件数 n1 は 2 つ目を含めて更新する）

    // --- 3. 画面: ボタン→サムネイル→送信で画像が届く ---
    console.log("\n[3] 画面から添付して送る");
    await reopen();
    await win.getByTestId("assistant-attach-view").click();
    await win.locator('img[src^="data:image/png"]').first().waitFor({ state: "visible", timeout: 15_000 });
    check(await win.getByTestId("assistant-viewimage-warn").isVisible(), "🔴 焼き込み文字の注意が出る");
    await win.getByTestId("assistant-input").fill("この画像で見える範囲を一言で");
    await win.getByTestId("assistant-send").click();
    await win.getByTestId("assistant-msg-bot").first().waitFor({ state: "visible", timeout: 30_000 });
    await win.screenshot({ path: path.join(OUT_DIR, "3-attached.png") });
    const body = fake.bodies.find((b) => b.includes("image_url")) ?? "";
    check(body.length > 0, "🔴 偽サーバーが画像つきの本文を受けた", fake.bodies.length);
    check(body.includes('"model":"vlm"'), "🔴 画像のときは image-to-text のモデルで送られる", body.slice(0, 120));
    check(/data:image\/png;base64,iVBORw0KGgo/.test(body), "本文に PNG の dataURL が載っている");

    // --- 4. 外部宛て ---
    console.log("\n[4] 外部宛て（非ループバック）");
    const s4 = await setProvider("https://ai.example.invalid", "外部AI", "api-key", true);
    check(s4.ok === true, "外部提供元を保存できる", s4);
    await setResponse(1);
    const d1 = (await dlg()).n;
    const refused = await cmd(false);
    check((await dlg()).n === d1 + 1, "🔴 外部宛てでは確認が 1 回出る", await dlg());
    check((await dlg()).icon === true, "🔴 確認にサムネイル(icon)が付く");
    check(refused.ok === false && refused.error === "declined" && !refused.image, "🔴 取り消すと declined で画像が返らない", refused);
    await setResponse(0);
    const ok1 = await cmd(false);
    check(ok1.ok === true && !!ok1.image?.base64, "承認すると画像が返る", ok1.error);
    check(/外部の AI/.test((await dlg()).last?.message ?? "") && /外部AI|ai\.example\.invalid/.test((await dlg()).last?.detail ?? ""), "文面は main が持つもの(外部の AI・宛先ホスト)", (await dlg()).last);
    const d2 = (await dlg()).n;
    await cmd(false);
    check((await dlg()).n === d2 + 1, "🔴 画像ごとに毎回確認する(セッション1回にしない)");
    await setResponse(1);
    const declinedAgain = await cmd(false);
    check(declinedAgain.ok === false && !declinedAgain.image, "🔴 取り消した画像は返らない(添付欄に入らない)", declinedAgain);

    // --- 5. 画像モデルが無い ---
    console.log("\n[5] image-to-text が無い提供元");
    const s5 = await setProvider(`http://127.0.0.1:${fake.port}`, "ローカル", "none", false);
    check(s5.ok === true, "image-to-text の無い提供元を保存できる", s5);
    const d3 = (await dlg()).n;
    const noModel = await cmd(false);
    await reopen();
    check(noModel.ok === false && noModel.error === "image-model-not-set", "🔴 image-model-not-set を返す(黙って落とさない)", noModel);
    check((await dlg()).n === d3, "確認の前に返る");
    await win.getByTestId("assistant-attach-view").click();
    await sleep(800);
    await win.screenshot({ path: path.join(OUT_DIR, "5-no-model.png") });

    // --- 6. 読み取りだけ・他の窓 ---
    console.log("\n[6] 読み取りだけ／他の窓");
    check((await annCount()) === n1 + 1, "🔴 ROI の件数が変わらない(対象は実在する。[2b] で描いた 1 件を足した数)", { before: n1 + 1, after: await annCount() });
    const r6 = await main.evaluate(() => (window as unknown as { graphyDesktop: { assistantViewerCmd: (s: string, c: unknown) => Promise<Res> } }).graphyDesktop.assistantViewerCmd("x", { kind: "captureView", withRoi: false }));
    check(r6.ok === false && r6.error === "forbidden", "🔴 メイン窓からの中継は forbidden", r6);
  } finally {
    fake.close();
    await driver.stop();
    clean();
  }
  const failed = summary();
  fs.writeFileSync(path.join(OUT_DIR, "result.json"), JSON.stringify({ failed }, null, 2));
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((e) => { console.error(e); process.exit(1); });
