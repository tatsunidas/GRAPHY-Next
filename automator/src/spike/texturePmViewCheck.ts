/*
 * テクスチャのマップ（Parametric Map・16 bit 整数＋RWVM）の実機検証スパイク（実データの PET と腫瘍の SEG）。
 *
 * 実行:  cd automator && PYTHON=<pydicom と numpy のある python> GRAPHY_AUTOMATOR_HTTP_PORT=21090 GRAPHY_AUTOMATOR_SCP_PORT=21091 \
 *          GRAPHY_AUTOMATOR_VITE_PORT=21093 AUTOMATOR_DATA_DIR=$PWD/.results/run-data/texture-pm-view timeout 1800 npx tsx src/spike/texturePmViewCheck.ts
 *   前提: backend jar を今のコードで作り直してある（mvn clean package）。
 *
 *   A. 2D ビューアの「テクスチャ…」ダイアログ（PET・SEG・First-order の Mean・カーネル 3・ストライド 4）でマップを作り、新しいタイルで開く。
 *      ROI が最も多いスライスへ移り、値の読み取り（マウス位置）が実値で、SUV の単位が付かないことをスクリーンショットと読み取りで確かめる。
 *   B. そのマップを pmConformanceCheck.py にかける。
 *   C. そのマップを ROI 特徴量（API）の入力にして、平均・最小・最大が pydicom（pixel_array＋RWVM）の ROI の実値の統計と一致し、
 *      校正が空（PET 由来でも SUV 校正が掛からない）であること。
 *   D. 旧形式を模したシリーズ（SC・TEXTURE・BitsStored=15）は ROI 特徴量の入力にすると理由つきで断られる。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { DesktopDriver } from "../driver/desktopDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { importPaths } from "../fixtures/importFixtures.js";
import { openFirstSeriesInViewer } from "../checklist/items/shared/helpers.js";
import { createStepRecorder } from "../checklist/types.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { PY, PY_FLAGS } from "./pythonCmd.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", `texture-pm-view-check${process.env.MAP_MODALITY ? "-" + process.env.MAP_MODALITY : ""}`);
// 既定は PSMA の PET。CT の症例（NSCLC など）で確かめるときは、MAP_ROOT（症例の親フォルダ。MAP_SRC_SUB・MAP_SEG_SUB の下に画像と SEG）と
// MAP_MODALITY=CT を渡す（textureMapSuvRef.py も同じ環境変数を読む）。
const PSMA = process.env.MAP_ROOT ?? path.join(os.homedir(), "graphy-demo-samples", "PSMA_0198cdca94fbb95f", "PET", "CT whole-body PSMA");
const MODALITY = process.env.MAP_MODALITY ?? "PT";
const REF = path.join(import.meta.dirname, "textureMapSuvRef.py");
const CONF = path.join(import.meta.dirname, "pmConformanceCheck.py");

const failures: string[] = [];
let passed = 0;
function check(cond: boolean, label: string, detail?: unknown): void {
  if (cond) { passed++; console.log(`  [ok  ] ${label}`); } else { console.log(`  [FAIL] ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`); failures.push(label); }
}
const py = (args: string[], script = REF): any => {
  const r = spawnSync(PY, [...PY_FLAGS, script, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0 && script === REF) throw new Error(`python ${args[0]}: ${r.stderr}`);
  return script === REF ? JSON.parse(r.stdout) : { status: r.status, out: r.stdout, err: r.stderr };
};
async function call<T>(base: string, p: string, method: string, body?: unknown): Promise<T> {
  const res = await fetch(`${base}${p}`, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!res.ok) throw new Error(`${method} ${p} → HTTP ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}
async function download(base: string, sops: string[], dir: string): Promise<void> {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const sop of sops) {
    const res = await fetch(`${base}/api/instances/${sop}/file`);
    if (!res.ok) throw new Error(`download ${sop}: HTTP ${res.status}`);
    fs.writeFileSync(path.join(dir, `${sop}.dcm`), Buffer.from(await res.arrayBuffer()));
  }
}
interface Series { seriesInstanceUid: string; modality: string | null; seriesDescription: string | null }
interface Inst { sopInstanceUid: string }
interface Row { column: string; value: number | null }
interface Feat { rows: Row[]; provenance: { calibration: string | null; valueUnit: string | null; uncalibratedPet: boolean } }
async function features(base: string, body: Record<string, unknown>): Promise<Feat> {
  const s = await call<{ jobId: string }>(base, "/api/radiomics/features/jobs", "POST", body);
  for (let i = 0; i < 900; i++) {
    const st = await call<{ state: string; result?: Feat; error?: string }>(base, `/api/radiomics/features/jobs/${s.jobId}`, "GET");
    if (st.state === "DONE" && st.result) return st.result;
    if (st.state === "FAILED" || st.state === "CANCELLED") throw new Error(`job ${st.state}: ${st.error}`);
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("job timeout");
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  if (!fs.existsSync(PSMA)) { console.log(`  [未達] 実データが無い: ${PSMA}`); process.exitCode = 2; return; }
  const d = new DesktopDriver();
  await d.start();
  const base = `http://127.0.0.1:${d.ports.http}`;
  try {
    await resetDb(d.ports.http);
    await importPaths(d.ports.http, [PSMA]);
    const studies = await call<{ studyInstanceUid: string }[]>(base, "/api/studies", "GET");
    const studyUid = studies[0].studyInstanceUid;
    const before = await call<Series[]>(base, `/api/studies/${studyUid}/series`, "GET");
    const pet = before.find((s) => s.modality === MODALITY)!;
    const seg = before.find((s) => s.modality === "SEG")!;
    check(!!pet && !!seg, "PET・SEG がある");

    console.log("\n[A] 画面: ダイアログからマップを作り、新しいタイルで開く");
    const mainPage = d.page;
    await mainPage.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
    await mainPage.waitForTimeout(2000);
    const later = mainPage.getByRole("button", { name: /^(後で|Later)$/ });
    if (await later.isVisible().catch(() => false)) await later.click();
    await mainPage.evaluate("localStorage.setItem('graphy.locale', 'ja')");
    await openFirstSeriesInViewer(mainPage, createStepRecorder());
    const viewer = await d.waitForNewPage(() => mainPage.getByTestId("viewer2d-toolbar-button").click(), (url) => url.includes("2dviewer"));
    await viewer.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 20_000 });
    await viewer.waitForTimeout(2000);
    // 実機でダイアログの既定（余白つき）のジョブは数分以上かかるので、マップは API（余白 0・カーネル 3・ROI 内）で作り、
    // ビューアには左の一覧の「＋」で開く（ダイアログの文言・欄の確認は textureMapSuvCheck が行う）
    const mapReq = { studyInstanceUid: studyUid, sourceSeriesUid: pet.seriesInstanceUid, maskSeriesUid: seg.seriesInstanceUid, maskChannel: 0,
      feature: "FIRSTORDER_Mean", filterSize: 3, stride: 1, force2D: false, channel: 0, timePoint: 0, settings: { MASK_LABEL_INT: "1" },
      margin: 0, seriesDescription: "PM view map", seriesNumber: null };
    const job = await call<{ jobId: string }>(base, "/api/series/texture/jobs", "POST", mapReq);
    for (let i = 0; i < 900; i++) {
      const st = await call<{ state: string; error?: string }>(base, `/api/series/texture/jobs/${job.jobId}`, "GET");
      if (st.state === "DONE") break;
      if (st.state === "FAILED" || st.state === "CANCELLED") throw new Error(`job ${st.state}: ${st.error}`);
      await new Promise((r) => setTimeout(r, 1000));
    }
    const tilesBefore = await viewer.getByTestId("series-viewer-root").count();
    await viewer.getByRole("button", { name: /^検索$/ }).click();
    await viewer.waitForTimeout(2500);
    const row = viewer.getByText(/PM view map/);
    await row.first().waitFor({ state: "visible", timeout: 20_000 });
    await viewer.screenshot({ path: path.join(OUT_DIR, "01-list.png") });
    await row.first().locator("xpath=following::button[1]").click();
    for (let i = 0; i < 60; i++) {
      if ((await viewer.getByTestId("series-viewer-root").count()) > tilesBefore) break;
      await viewer.waitForTimeout(1000);
    }
    check((await viewer.getByTestId("series-viewer-root").count()) === tilesBefore + 1, "マップが新しいタイルで開く", await viewer.getByTestId("series-viewer-root").count());
    await viewer.waitForTimeout(3000);
    const after = await call<Series[]>(base, `/api/studies/${studyUid}/series`, "GET");
    const made = after.filter((s) => !before.some((b) => b.seriesInstanceUid === s.seriesInstanceUid));
    check(made.length === 1, "派生シリーズが 1 本できる", made.map((m) => m.seriesDescription));
    const mp = made[0];
    const inst = await call<Inst[]>(base, `/api/studies/${studyUid}/series/${mp.seriesInstanceUid}/instances`, "GET");
    const mapDir = path.join(OUT_DIR, "map");
    await download(base, inst.map((i) => i.sopInstanceUid), mapDir);
    const stats = py(["roistats", PSMA, mapDir]);
    console.log(`  参照（pydicom の実値）: ${JSON.stringify({ ...stats, sliceDistinct: undefined })}`);
    check(stats.noValue === 0, "ROI の中に値なしは無い", stats.noValue);
    // ROI の外は値なし（画素 0）。実値 0.0 でない（旧版は外に 0.0 を書き、画素 1 以上の実値になっていた）。
    console.log(`  ROI の外: ${stats.outsideNoValue} / ${stats.outsideN} が値なし（ROI のあるスライスでは ${stats.outsideSliceNoValue} / ${stats.outsideSliceN}）`);
    check(stats.outsideN > 0 && stats.outsideNoValue === stats.outsideN, "ROI の外はすべて値なし（pydicom: 画素 0 → NaN）", { noValue: stats.outsideNoValue, n: stats.outsideN });

    // ROI が最も多いスライスへ（Z の入力欄）。新しいタイル＝最後
    const tile = viewer.getByTestId("series-viewer-root").last();
    const zInput = tile.locator('input[placeholder="#"]').first();
    await zInput.fill(String(stats.zBest + 1));
    await zInput.press("Enter");
    await viewer.waitForTimeout(2500);
    await viewer.screenshot({ path: path.join(OUT_DIR, "02-map-pet-slice.png") });
    const canvas = tile.locator("canvas").first();
    const box = (await canvas.boundingBox())!;
    // 画像は箱に収めて中央に出ると仮定して ROI 重心の位置を決め、周りも探る
    const sc = Math.min(box.width / stats.cols, box.height / stats.rows);
    const cx = box.x + box.width / 2 + (stats.roiCentroidRC[1] - stats.cols / 2) * sc;
    const cy = box.y + box.height / 2 + (stats.roiCentroidRC[0] - stats.rows / 2) * sc;
    const distinct: number[] = stats.sliceDistinct;
    let read: { v: number; unit: string; text: string } | null = null;
    for (const [dx, dy] of [[0, 0], [sc, 0], [-sc, 0], [0, sc], [0, -sc], [2 * sc, 0], [-2 * sc, 0]]) {
      await viewer.mouse.move(cx + dx, cy + dy);
      await viewer.waitForTimeout(400);
      const text = await tile.innerText();
      const m = /値\s*(-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)\s*([^\s\n]*)/.exec(text);
      if (m && Number(m[1]) !== 0) { read = { v: Number(m[1]), unit: m[2], text: m[0] }; break; }
    }
    await viewer.screenshot({ path: path.join(OUT_DIR, "03-map-pet-hover.png") });
    // 見せたい物が写っているか: ROI（値のある画素）が画面に見える。W/L が有限。ROI の無いスライス（全面 NaN）を先に出した後に
    // ROI のあるスライスへ移ると、値域の記憶が壊れて、値の読み取りは正しいのに画像全体が真っ黒になった（viewer/scalarRange.ts）。
    const canvasPng = path.join(OUT_DIR, "03a-canvas.png");
    await viewer.screenshot({ path: canvasPng, clip: { x: box.x, y: box.y, width: box.width, height: box.height } });
    const vis = py(["visible", canvasPng]);
    // 診断: cornerstone が持っている画像と、タイルごとの W/L（voiRange）。NaN の画素数も見る
    const csDiag = await viewer.evaluate(`(async () => {
      const u = performance.getEntriesByType('resource').map((e) => e.name).find((n) => /deps\\/@cornerstonejs_core\\.js/.test(n));
      if (!u) return [];
      const core = await import(u);
      return core.getRenderingEngines().flatMap((e) => e.getViewports()).map((vp) => {
        const id = vp.getCurrentImageId?.();
        const px = id ? core.cache.getImage(id)?.getPixelData?.() : null;
        let nan = 0; if (px) for (let i = 0; i < px.length; i++) if (Number.isNaN(px[i])) nan++;
        const sd = vp.getImageData?.()?.imageData?.getPointData?.()?.getScalars?.()?.getData?.(); let sNaN = -1; if (sd) { sNaN = 0; for (let i = 0; i < sd.length; i++) if (Number.isNaN(sd[i])) sNaN++; }
        return { vp: vp.id, nan, renderCopyNaN: sNaN, voi: vp.getProperties?.().voiRange ?? null };
      }); })()`) as { vp: string; nan: number; voi: { lower: number; upper: number } | null }[];
    const ranges = csDiag.map((d) => d.voi);
    console.log(`  タイルの画像: ${JSON.stringify(csDiag)}`);
    console.log(`  見える画素: ${JSON.stringify(vis)}`);
    check(csDiag.some((d) => d.nan > 0), "前提: マップのタイルの画像は値なし（NaN）を含む", csDiag);
    check(vis.visible >= 1000, "マップのタイルに ROI が見える（黒でない画素が千個以上。旧版は約 3000）", vis);
    check(ranges.length > 0 && ranges.every((r) => r !== null && Number.isFinite(r.lower) && Number.isFinite(r.upper)), "全タイルの W/L（voiRange）が有限", ranges);
    // ROI の外（スライスの上端の中央付近＝画像の外周側。ROI の画素から十分離れた所）へ移して、値の読み取りが数値でないことを確かめる
    const inRoiRead = await tile.getByTestId("status-value").first().innerText().catch(() => "");
    let outRead = "";
    for (const [fx, fy] of [[0.5, 0.06], [0.06, 0.5], [0.94, 0.5], [0.5, 0.94]]) {
      const px = box.x + box.width * fx, py2 = box.y + box.height * fy;
      await viewer.mouse.move(px, py2);
      await viewer.waitForTimeout(500);
      outRead = (await tile.getByTestId("status-value").first().innerText().catch(() => "")).trim();
      console.log(`  ROI の外 (${fx}, ${fy}) の読み取り: ${JSON.stringify(outRead)}`);
      await viewer.screenshot({ path: path.join(OUT_DIR, `03b-outside-${fx}-${fy}.png`) });
    }
    console.log(`  ROI の内の読み取り（status-value）: ${JSON.stringify(inRoiRead.trim())}`);
    check(outRead !== "" && !/^-?\d+(\.\d+)?(\s|$)/.test(outRead), "ROI の外の読み取りは数値でない（値なし）", outRead);
    console.log(`  値の読み取り: ${JSON.stringify(read)}`);
    check(!!read, "ROI の上で値の読み取りが出る");
    if (read) {
      const near = Math.min(...distinct.map((x) => Math.abs(x - read!.v)));
      check(near <= Math.max(stats.slope, 1e-4 * Math.abs(read.v)), "読み取りの値は、マップの実値（pydicom の pixel_array＋RWVM）のどれかと一致する", { read: read.v, near, slope: stats.slope });
      check(!/SUV/i.test(read.text + read.unit) && !/SUV/.test(await tile.innerText()), "SUV の表示が出ない（Modality=PT のままでも）");
    }

    console.log("\n[B] 適合検査（pydicom）");
    const files = fs.readdirSync(mapDir).map((f) => path.join(mapDir, f));
    const conf = py(files.slice(0, 40), CONF);
    check(conf.status === 0, "pmConformanceCheck: 先頭 40 枚が合格", conf.out.split("\n").filter((l: string) => l.includes("FAIL")).slice(0, 5));

    console.log("\n[C] マップを ROI 特徴量の入力にする（API）");
    const body = { studyInstanceUid: studyUid, sourceSeriesUid: mp.seriesInstanceUid, maskSeriesUid: seg.seriesInstanceUid, maskChannel: 0, channel: 0, timePoint: 0,
      settings: {}, recompute: true, roiModes: ["WHOLE_3D"] };
    // ROI の外が値なし（NaN）になったマップは、load の「NaN を含むシリーズは計算しない」で断られる（課題 30 で判明した下流の影響）。
    // 失敗として数え、[D] へ進む。
    let r: Feat | null = null;
    try { r = await features(base, body); } catch (e) { check(false, "[C] マップを ROI 特徴量の入力にできる", String((e as Error).message)); }
    if (r) {
    const col = (re: RegExp) => r.rows.filter((x) => re.test(x.column) && x.value !== null).map((x) => ({ c: x.column, v: x.value as number }));
    const mean = col(/IntensityBasedStatistical_Mean$/)[0];
    const mn = col(/IntensityBasedStatistical_Minimum$/)[0];
    const mx = col(/IntensityBasedStatistical_Maximum$/)[0];
    console.log(`  本体: mean=${mean?.v} min=${mn?.v} max=${mx?.v}、参照: mean=${stats.mean} min=${stats.min} max=${stats.max}、校正=${JSON.stringify(r.provenance)}`);
    const close = (a: number | undefined, b: number) => a !== undefined && Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(b));
    check(close(mean?.v, stats.mean) && close(mn?.v, stats.min) && close(mx?.v, stats.max), "平均・最小・最大が pydicom の ROI の実値の統計と一致（相対 1e-6）");
    check(!r.provenance.calibration && !r.provenance.uncalibratedPet, "PET 由来のマップでも校正が掛からない（Provenance の校正が空・未校正 PET の旗なし）", r.provenance);
    }

    console.log("\n[C2] マップのマップ（ROI の外が値なしのマップを、テクスチャの入力にする）は、理由つきで断られる");
    {
      const mm = { ...mapReq, sourceSeriesUid: mp.seriesInstanceUid, margin: 2, seriesDescription: "map of map" };
      const j = await call<{ jobId: string }>(base, "/api/series/texture/jobs", "POST", mm);
      let state = "", err = "";
      for (let i = 0; i < 300 && state !== "FAILED" && state !== "DONE" && state !== "CANCELLED"; i++) {
        const st = await call<{ state: string; error?: string }>(base, `/api/series/texture/jobs/${j.jobId}`, "GET");
        state = st.state; err = st.error ?? "";
        if (state !== "FAILED" && state !== "DONE" && state !== "CANCELLED") await new Promise((r) => setTimeout(r, 500));
      }
      console.log(`  断りの文面: ${err}`);
      check(state === "FAILED" && err.includes("窓が届く範囲") && err.includes("元の画像"), "マップのマップ（余白 2）は、窓が届く範囲の NaN を理由に断られ、元の画像を使う案内がある", { state, err });
    }

    console.log("\n[D] 旧形式を模したシリーズ（SC・TEXTURE・BitsStored=15）は断られる");
    const oldDir = path.join(OUT_DIR, "old-style");
    fs.rmSync(oldDir, { recursive: true, force: true });
    const old = py(["oldify", mapDir, oldDir]);
    await importPaths(d.ports.http, [oldDir]);
    const all = await call<Series[]>(base, `/api/studies/${studyUid}/series`, "GET");
    check(all.some((s) => s.seriesInstanceUid === old.seriesInstanceUid), "旧形式を模したシリーズを取り込めた");
    // 旧形式の PET 由来マップは Modality=PT のまま PET の属性が無い。誤宣言の判定は校正の解決より前なので、既定（auto）でも宣言の誤りで断られる
    let msgAuto = "";
    try { await features(base, { ...body, sourceSeriesUid: old.seriesInstanceUid }); } catch (e) { msgAuto = String((e as Error).message); }
    console.log(`  既定（auto）の断りの文面: ${msgAuto}`);
    check(msgAuto.includes("旧版で作られた") && !msgAuto.includes("校正できません"), "既定（auto）: 校正の理由でなく、画素の宣言の誤りで断られる", msgAuto);
    // 校正しない（none）を選ぶと、画素の宣言の誤りで断られる（今回の追加）
    let msg = "";
    try { await features(base, { ...body, sourceSeriesUid: old.seriesInstanceUid, calibration: "none" }); } catch (e) { msg = String((e as Error).message); }
    console.log(`  none の断りの文面: ${msg}`);
    check(msg.includes("旧版で作られた"), "ROI 特徴量（校正しない）: 画素の宣言の誤りを理由に断られる", msg);
    // 正例: 同じ画素で宣言だけ正しいもの（BitsStored=16・HighBit=15）は通る — 新形式のマップで [C] が通っていることが正例
  } finally {
    await d.stop();
  }
  console.log(`\n結果: 合格 ${passed} / 失敗 ${failures.length}`);
  if (failures.length) { console.log(failures.map((x) => `  - ${x}`).join("\n")); process.exitCode = 1; }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
