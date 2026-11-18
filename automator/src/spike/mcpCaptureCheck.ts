/*
 * MCP の画像（画素）の取得（capture_viewer_image。allowViewerCapture）の実機検証。実際の中継（desktop/mcpCli.js、stdio）から呼び、
 * 実際の 2D 窓の画像を取る。**実行のたびに利用者が確認する**ことと、画像が MCP の image content で全バイト届くことを確かめる。
 * 確認ダイアログは dialog.showMessageBox のスタブ（回数・文面・サムネイルの icon の有無を記録。応答を切り替え）。最後だけ本物のダイアログ。
 *
 * 実行:  cd automator && GRAPHY_AUTOMATOR_HTTP_PORT=19540 GRAPHY_AUTOMATOR_SCP_PORT=19541 GRAPHY_AUTOMATOR_VITE_PORT=19543 \
 *          npx tsx src/spike/mcpCaptureCheck.ts [検査のフォルダ（既定 ~/graphy-demo-samples/HASSAKU_DCM）]
 *
 *   1. 既定（allowViewerCapture オフ）: ツールが出ない／capture-disabled／確認も出ない。
 *   2. オン: 確認が 1 回（クライアント名・大きさ・焼き込み・責任・サムネイル）→ 承認で image content。PNG/JPEG として復号でき、大きさが確認の文面と一致し、空でない。
 *      2 回目も、もう一度確認が出る（毎回）。
 *   3. 拒否 → declined（画像は返らない）。答えない（本物のダイアログ）→ 120 秒で declined。
 *   4. withRoi: ROI があるとき、true と false で画素が違う。crop は ROI の選択が無ければ no-selected-roi。
 *   5. 監査ログ・journal・stderr に、画像のバイト列・患者の値が 0 件（監査は呼び出しとバイト数だけ）。
 *
 * 一時の userData（--user-data-dir）で起動する。前提: backend jar（今のビルド）・frontend の依存・desktop の electron・desktop/mcp/run.cjs。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { DesktopDriver } from "../driver/desktopDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { importPaths } from "../fixtures/importFixtures.js";
import { openFirstSeriesInViewer } from "../checklist/items/shared/helpers.js";
import { createStepRecorder } from "../checklist/types.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { McpStdio } from "./mcpStdioClient.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "mcp-capture");
const SAMPLE = process.argv[2] ?? path.join(os.homedir(), "graphy-demo-samples", "HASSAKU_DCM");
const CLIENT = "claude-capture-check";

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

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const userData = path.join(OUT_DIR, "userdata");
  fs.rmSync(userData, { recursive: true, force: true });
  fs.mkdirSync(userData, { recursive: true });
  const prefs = (capture: boolean) => fs.writeFileSync(path.join(userData, "mcp.json"), JSON.stringify({ enabled: true, includePhi: false, allowAnalysis: false, allowViewerControl: true, allowViewerEdit: true, allowViewerCapture: capture, pluginTools: [] }));
  prefs(false);

  const d = new DesktopDriver({}, { extraElectronArgs: [`--user-data-dir=${userData}`] });
  let mcp: McpStdio | null = null;
  try {
    await d.start();
    const base = `http://127.0.0.1:${d.ports.http}`;
    await resetDb(d.ports.http);
    await importPaths(d.ports.http, [SAMPLE]);
    const studies = (await (await fetch(`${base}/api/studies`)).json()) as { patientName?: string; patientId?: string; studyInstanceUid: string }[];
    const truth = [studies[0]?.patientName, studies[0]?.patientId, studies[0]?.studyInstanceUid].filter((v): v is string => typeof v === "string" && v.trim().length >= 3);

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
    await viewer.waitForTimeout(2500);

    const endpoint = path.join(userData, "mcp-endpoint.json");
    for (let i = 0; i < 50 && !fs.existsSync(endpoint); i++) await new Promise((r) => setTimeout(r, 200));
    check(fs.existsSync(endpoint), "受け口が待ち受けている");

    await d.app.evaluate(({ dialog }) => {
      const g = globalThis as unknown as { __dlg?: unknown; __orig?: unknown };
      g.__orig = dialog.showMessageBox;
      const st = { log: [] as { title: string; message: string; detail: string; hasIcon: boolean; iconW: number }[], mode: "accept" };
      g.__dlg = st;
      (dialog as unknown as { showMessageBox: unknown }).showMessageBox = async (...a: unknown[]) => {
        const o = (a.length > 1 ? a[1] : a[0]) as { title: string; message: string; detail: string; buttons: string[]; cancelId?: number; icon?: { getSize?: () => { width: number } } };
        st.log.push({ title: o.title, message: o.message, detail: o.detail, hasIcon: !!o.icon, iconW: o.icon?.getSize?.().width ?? 0 });
        return { response: st.mode === "accept" ? 0 : (o.cancelId ?? o.buttons.length - 1), checkboxChecked: false };
      };
    });
    type Dlg = { log: { title: string; message: string; detail: string; hasIcon: boolean; iconW: number }[]; mode: string };
    const dlg = (): Promise<Dlg> => d.app.evaluate(() => (globalThis as unknown as { __dlg: Dlg }).__dlg);
    const setMode = (mode: string) => d.app.evaluate((_a, m) => { (globalThis as unknown as { __dlg: Dlg }).__dlg.mode = m; }, mode);
    const captureAsks = async () => (await dlg()).log.filter((x) => /表示中の画像/.test(x.message));

    mcp = McpStdio.fromRepo(endpoint, CLIENT);
    await mcp.init();
    const names = async () => (((await mcp!.request("tools/list")).result as { tools: { name: string }[] }).tools ?? []).map((t) => t.name);

    console.log("\n[1] 既定（画像を返す許可がオフ）");
    check(!(await names()).includes("capture_viewer_image"), "capture_viewer_image が一覧に出ない（他の許可はオン）");
    const off = await mcp.call("capture_viewer_image", {});
    check(off.isError && /capture-disabled/.test(off.text), "オフで呼ぶと capture-disabled", off.text);
    check((await captureAsks()).length === 0, "オフでは画像の確認も出ない（画像を取りにもいかない）");

    console.log("\n[2] 許可をオン: 毎回確認して、image content で返る");
    prefs(true);
    check((await names()).includes("capture_viewer_image"), "オンで capture_viewer_image が出る");
    const noRoi = await mcp.call("capture_viewer_image", { crop: true });
    check(noRoi.isError && /no-selected-roi/.test(noRoi.text), "crop は ROI が選択されていなければ no-selected-roi（確認は出ない）", noRoi.text);
    check((await captureAsks()).length === 0, "取れなかったときは確認を出さない");
    const a0 = (await captureAsks()).length;
    const r1 = await mcp.callRaw("capture_viewer_image", {});
    check(!r1.isError && r1.content[0]?.type === "image" && r1.content[1]?.type === "text", "image content とテキスト（大きさ）が返る", r1.content.map((c) => c.type));
    const asks1 = (await captureAsks()).slice(a0);
    check(asks1.length === 1, "確認が 1 回出る", asks1.length);
    const ask = asks1[0];
    check(/claude-capture-check/.test(ask?.message ?? "") && /焼き込まれていないか/.test(ask?.detail ?? "") && /責任は、返すことを許可したあなたにあります/.test(ask?.detail ?? "") && /クラウドの AI へ送られる可能性/.test(ask?.detail ?? ""), "確認の文面にクライアント名・焼き込み・責任・クラウドへ送られ得ること", ask?.detail?.slice(0, 80));
    check(ask?.hasIcon === true && ask.iconW > 0, "確認にサムネイル（icon）がある", { hasIcon: ask?.hasIcon, iconW: ask?.iconW });
    const img = r1.content[0];
    const buf = Buffer.from(img.data ?? "", "base64");
    const isPng = img.mimeType === "image/png" && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const isJpeg = img.mimeType === "image/jpeg" && buf[0] === 0xff && buf[1] === 0xd8;
    check(isPng || isJpeg, "画像は PNG または JPEG として復号できる（マジック・mime が合う）", { mime: img.mimeType, head: buf.subarray(0, 4).toString("hex") });
    const dims = JSON.parse(r1.content[1].text ?? "{}") as { width: number; height: number };
    const pngDims = isPng ? { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) } : null;
    check(dims.width > 0 && dims.height > 0 && (!pngDims || (pngDims.width === dims.width && pngDims.height === dims.height)), "大きさ（テキスト）が画像の実際の大きさと一致する", { dims, pngDims });
    check(new RegExp(`${dims.width}×${dims.height}`).test(ask?.message ?? ""), "確認の文面の大きさが、返した画像の大きさと一致する", ask?.message);
    fs.writeFileSync(path.join(OUT_DIR, `capture-1.${isPng ? "png" : "jpg"}`), buf);
    // 空でない（画素の分散）: ブラウザで復号して輝度の標準偏差を見る
    const stats = await viewer.evaluate(async ([data, mime]) => {
      const im = new Image();
      await new Promise<void>((res, rej) => { im.onload = () => res(); im.onerror = () => rej(new Error("decode")); im.src = `data:${mime};base64,${data}`; });
      const c = document.createElement("canvas");
      c.width = im.width; c.height = im.height;
      const g = c.getContext("2d")!;
      g.drawImage(im, 0, 0);
      const px = g.getImageData(0, 0, c.width, c.height).data;
      let n = 0, s = 0, s2 = 0;
      for (let i = 0; i < px.length; i += 4) { const y = (px[i] + px[i + 1] + px[i + 2]) / 3; n++; s += y; s2 += y * y; }
      const mean = s / n;
      return { w: c.width, h: c.height, mean, std: Math.sqrt(Math.max(0, s2 / n - mean * mean)) };
    }, [img.data ?? "", img.mimeType ?? ""] as [string, string]);
    check(stats.w === dims.width && stats.h === dims.height && stats.std > 5, "ブラウザで復号でき、画素に変化がある（空・真っ黒ではない）", stats);

    const r2 = await mcp.callRaw("capture_viewer_image", {});
    check(!r2.isError && (await captureAsks()).length === a0 + 2, "2 回目も、もう一度確認が出る（毎回）", (await captureAsks()).length - a0);

    console.log("\n[3] 拒否・答えない");
    await setMode("decline");
    const dec = await mcp.callRaw("capture_viewer_image", {});
    check(dec.isError && !dec.content.some((c) => c.type === "image") && /declined/.test(dec.content[0]?.text ?? ""), "確認で［取り消す］→ declined（画像は返らない）", dec.content.map((c) => c.type));
    await setMode("accept");

    console.log("\n[4] withRoi");
    const roi = await mcp.call("create_roi", { shape: "ellipse", u: 0.5, v: 0.5, radiusXmm: 25, radiusYmm: 25 });
    check(!roi.isError, "（準備）create_roi で ROI を 1 つ作る", roi.text);
    await viewer.waitForTimeout(600);
    const withRoi = await mcp.callRaw("capture_viewer_image", { withRoi: true });
    const noRoiImg = await mcp.callRaw("capture_viewer_image", { withRoi: false });
    check(!withRoi.isError && !noRoiImg.isError, "withRoi の true・false どちらも通る", [withRoi.content[0]?.text, noRoiImg.content[0]?.text]);
    fs.writeFileSync(path.join(OUT_DIR, "capture-withroi.png"), Buffer.from(withRoi.content[0].data ?? "", "base64"));
    fs.writeFileSync(path.join(OUT_DIR, "capture-noroi.png"), Buffer.from(noRoiImg.content[0].data ?? "", "base64"));
    // tsx は名前つきの関数に __name を足し、ページの中では未定義になる。ページで動かす関数は文字列で渡す
    const diffFn = `(async function (a, b) {
      async function load(d) { var im = new Image(); await new Promise(function (res) { im.onload = function () { res(); }; im.src = "data:image/png;base64," + d; }); var c = document.createElement("canvas"); c.width = im.width; c.height = im.height; var g = c.getContext("2d"); g.drawImage(im, 0, 0); return g.getImageData(0, 0, c.width, c.height); }
      var x = await load(a), y = await load(b);
      if (x.width !== y.width || x.height !== y.height) return { sameSize: false, diff: -1 };
      var n = 0;
      for (var i = 0; i < x.data.length; i += 4) if (Math.abs(x.data[i] - y.data[i]) + Math.abs(x.data[i + 1] - y.data[i + 1]) + Math.abs(x.data[i + 2] - y.data[i + 2]) > 30) n++;
      return { sameSize: true, diff: n };
    })(${JSON.stringify(withRoi.content[0].data ?? "")}, ${JSON.stringify(noRoiImg.content[0].data ?? "")})`;
    const diff = (await viewer.evaluate(diffFn)) as { sameSize: boolean; diff: number };
    check(diff.sameSize && diff.diff > 100, "withRoi=true の画像は、false と画素が違う（ROI の注釈が重なっている）", diff);

    console.log("\n[5] 患者情報・画像のバイト列");
    const audit = fs.readFileSync(path.join(userData, "mcp-audit.jsonl"), "utf8");
    const journalFile = path.join(userData, "assistant-journal.jsonl");
    const journal = fs.existsSync(journalFile) ? fs.readFileSync(journalFile, "utf8") : "";
    const needle = (img.data ?? "").slice(40, 120);
    check(needle.length > 0 && !audit.includes(needle) && !journal.includes(needle) && !mcp!.stderr.includes(needle), "監査ログ・journal・stderr に画像のバイト列が残らない");
    check(truth.length > 0 && truth.every((v) => !audit.includes(v) && !journal.includes(v) && !mcp!.stderr.includes(v)), "監査ログ・journal・stderr に患者の値が 0 件", { truthKinds: truth.length });
    check(/"tool":"capture_viewer_image"/.test(audit) && /"bytes":\d{4,}/.test(audit), "監査ログに呼び出し（ツール名・バイト数）が残る");

    console.log("\n[6] 本物のダイアログに答えないまま 120 秒");
    await d.app.evaluate(({ dialog }) => {
      const g = globalThis as unknown as { __orig?: typeof dialog.showMessageBox };
      if (g.__orig) (dialog as unknown as { showMessageBox: unknown }).showMessageBox = g.__orig;
    });
    const t0 = Date.now();
    const slow = await mcp.callRaw("capture_viewer_image", {}, 240_000);
    const sec = (Date.now() - t0) / 1000;
    check(slow.isError && /declined/.test(slow.content[0]?.text ?? "") && !slow.content.some((c) => c.type === "image"), "答えないまま過ぎると declined（画像は返らない）", slow.content.map((c) => c.text));
    check(sec >= 110 && sec <= 200, `約 120 秒待ってから取り消された（${sec.toFixed(0)} 秒）`, sec);
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
