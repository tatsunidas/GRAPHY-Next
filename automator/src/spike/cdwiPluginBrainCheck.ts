/*
 * Computed DWI / vMRE プラグインの実機検証（GE 製の脳 DWI。b0・b1000 は ORIGINAL＝同じスケール、装置 ADC つき）。
 * cdwiPluginCheck.ts（果物のファントム＋合成 b0）の補完: **本物の脳**で、b 値を GE の私的タグから読めること、
 * 強度スケールの警告が出ないこと、保存した ADC が**装置の ADC と絶対値で一致**することを確かめる。
 *
 * 実行:  cd automator && CDWI_GE=<b0/ b1000/ adc/ を持つフォルダ> npx tsx src/spike/cdwiPluginBrainCheck.ts
 *        （backend jar と、プラグインの ui.js を先にビルドしておく。cdwiPluginCheck.ts と同じ）
 * 入力が無ければ「未達」と書いて終了コード 2（合格にはしない）。患者情報を含むのでリポジトリには入れない。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Page } from "playwright";

import { DesktopDriver, DESKTOP_RUN_DATA_DIR } from "../driver/desktopDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { importPaths } from "../fixtures/importFixtures.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { selectFirstStudy } from "../checklist/items/shared/helpers.js";
import { createStepRecorder } from "../checklist/types.js";
import { createChecker } from "./computeSpikeShared.js";

const { check, summary } = createChecker();
const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "cdwi-brain-check");
const PLUGIN_ID = "vis-computed-dwi";
const PLUGIN_DIR = process.env.CDWI_PLUGIN_DIR ?? path.join(os.homedir(), "graphy-next-plugin-computed-dwi");
const GE = process.env.CDWI_GE;

function tag(b: Buffer, t: number[], vr: string): string | null {
  const at = b.indexOf(Buffer.from([...t, ...Buffer.from(vr, "latin1")]));
  if (at < 0) return null;
  return b.toString("latin1", at + 8, at + 8 + b.readUInt16LE(at + 6)).trim().replace(/\0/g, "");
}
/** 非圧縮 Explicit VR LE の最小読み取り: IPP の z と、画素（RescaleSlope/Intercept 適用済み）。 */
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
const median = (v: number[]) => [...v].sort((a, b) => a - b)[v.length >> 1];
function corr(a: number[], b: number[]): number {
  const n = a.length;
  const ma = a.reduce((s, v) => s + v, 0) / n, mb = b.reduce((s, v) => s + v, 0) / n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) { sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2; }
  return sab / Math.sqrt(saa * sbb);
}

type TagRow = { tag: string; value: string; depth: number; vr?: string };
async function tagsOf(base: string, st: string, se: string, sop: string): Promise<TagRow[]> {
  return (await (await fetch(`${base}/api/studies/${st}/series/${se}/instances/${sop}/tags`)).json()) as TagRow[];
}

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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const core = (await import(pathToFileURL(path.join(PLUGIN_DIR, "src", "core", "dwi.ts")).href)) as any;

  const driver = new DesktopDriver({ http: 18741, scp: 18742, vite: 18743 });
  try {
    await driver.start();
    await resetDb(driver.ports.http);
    const imp = await importPaths(driver.ports.http, [path.join(GE, "b0"), path.join(GE, "b1000")]);
    check(imp.failed === 0 && imp.imported === 64, "（前提）b0・b1000 の 64 枚を取り込めた", imp);

    const base = `http://localhost:${driver.ports.http}`;
    const studies = (await (await fetch(`${base}/api/studies`)).json()) as { studyInstanceUid: string }[];
    const studyUid = studies[0].studyInstanceUid;
    const series = (await (await fetch(`${base}/api/studies/${studyUid}/series`)).json()) as { seriesInstanceUid: string }[];
    // 2 系列とも説明が同じ（Diffusion_b1000）なので、標準の b 値タグがある方を b1000、無い方を b0 とみなす（GE の実データの形）
    const withStd: string[] = [], withoutStd: string[] = [];
    for (const s of series) {
      const sops = (await (await fetch(`${base}/api/studies/${studyUid}/series/${s.seriesInstanceUid}/instances`)).json()) as { sopInstanceUid: string }[];
      const rows = await tagsOf(base, studyUid, s.seriesInstanceUid, sops[0].sopInstanceUid);
      (rows.some((r) => r.tag === "(0018,9087)") ? withStd : withoutStd).push(s.seriesInstanceUid);
    }
    check(series.length === 2 && withStd.length === 1 && withoutStd.length === 1, "（前提）2 系列: 標準の b 値タグがある系列（b1000）と無い系列（b0）", { withStd: withStd.length, withoutStd: withoutStd.length });
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
    viewer.on("console", (m) => { if (m.type() === "error") console.log(`  [viewer error] ${m.text()}`); });

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

    console.log("\n[1] b 値の読み取り（GE）");
    const bOf = (u: string) => viewer.locator(`[data-testid="b-${u}#0"]`).inputValue();
    check((await bOf(uidB0)) === "0" && (await bOf(uidB1)) === "1000", "b0 は GE 私的タグから 0、b1000 は標準タグから 1000", { b0: await bOf(uidB0), b1: await bOf(uidB1) });
    const rowsText = (await viewer.locator('[data-testid="input-row"]').allTextContents()).join(" | ");
    check(rowsText.includes("GE (0043,1039)") && rowsText.includes("DICOM (0018,9087)"), "出所が表示される（GE (0043,1039) と DICOM (0018,9087)）", rowsText);
    check(!rowsText.includes("DERIVED"), "ImageType は ORIGINAL（DERIVED の表示が無い）");

    console.log("\n[2] 計算");
    await viewer.getByTestId("run").click();
    await viewer.waitForFunction(() => /計算しました|範囲|必要|読み込め|ありません/.test(document.querySelector('[data-testid="status"]')?.textContent ?? "") && !document.querySelector("#cdwi-run")?.hasAttribute("disabled"), undefined, { timeout: 180_000 });
    await viewer.waitForTimeout(1500);
    const status = (await viewer.getByTestId("status").textContent()) ?? "";
    const warnings = await viewer.getByTestId("warning").allTextContents();
    console.log(`  status: ${status}`);
    check(status.includes("計算しました"), "計算が完了する", status);
    check(!warnings.some((w) => w.includes("強度スケール")), "🔴 同じスケールの ORIGINAL 系列なので強度スケールの警告は出ない", warnings);
    check(!warnings.some((w) => w.includes("DERIVED")), "DERIVED の警告も出ない", warnings);
    check(warnings.some((w) => w.includes("非ガウス")), "b200/800 が実測に無いので合成の注記が出る", warnings);
    await viewer.screenshot({ path: path.join(OUT_DIR, "1-brain-three-views.png") });

    console.log("\n[3] 保存と、装置 ADC との絶対値照合");
    const before = new Set((await (await fetch(`${base}/api/studies/${studyUid}/series`)).json() as { seriesInstanceUid: string }[]).map((s) => s.seriesInstanceUid));
    for (const [kind, desc] of [["adc", "ADC b0-1000"], ["cdwi", "Computed DWI b=400"]] as const) {
      await viewer.getByTestId(`save-${kind}`).click();
      await viewer.getByTestId("plugin-save-confirm").waitFor({ state: "visible", timeout: 20_000 });
      check(((await viewer.getByTestId("plugin-save-description").textContent()) ?? "").trim() === `[Plugin] ${desc}`, `${kind}: 確認ダイアログの説明が「${desc}」`);
      await viewer.getByTestId("plugin-save-confirm-button").click();
      await viewer.waitForFunction(() => /保存しました|保存できません/.test(document.querySelector('[data-testid="status"]')?.textContent ?? ""), undefined, { timeout: 120_000 });
      check(((await viewer.getByTestId("status").textContent()) ?? "").includes("保存しました（32 枚）"), `${kind}: 保存できた（32 枚）`);
    }
    const after = ((await (await fetch(`${base}/api/studies/${studyUid}/series`)).json()) as { seriesInstanceUid: string; seriesDescription?: string; numberOfInstances?: number }[]).filter((s) => !before.has(s.seriesInstanceUid));
    const savedAdc = after.find((s) => s.seriesDescription === "[Plugin] ADC b0-1000");
    const savedC = after.find((s) => s.seriesDescription === "[Plugin] Computed DWI b=400");
    check(!!savedAdc && !!savedC && savedAdc.numberOfInstances === 32 && savedC.numberOfInstances === 32, "ADC と cDWI が 32 枚ずつ保管庫に現れる", after.map((s) => [s.seriesDescription, s.numberOfInstances]));
    const inst = async (u: string) => (await (await fetch(`${base}/api/studies/${studyUid}/series/${u}/instances`)).json()) as { sopInstanceUid: string }[];
    const cTags = await tagsOf(base, studyUid, savedC!.seriesInstanceUid, (await inst(savedC!.seriesInstanceUid))[0].sopInstanceUid);
    check(cTags.filter((r) => r.tag === "(0018,9087)").map((r) => r.value).join() === "400", "🔴 cDWI の DiffusionBValue = 400", cTags.filter((r) => r.tag === "(0018,9087)"));

    const readSaved = async (u: string) => {
      const out = new Map<number, Float32Array>();
      for (const { sopInstanceUid } of await inst(u)) {
        const rows = await tagsOf(base, studyUid, u, sopInstanceUid);
        const val = (t: string) => rows.find((r) => r.tag === t && r.depth === 0)?.value ?? "";
        const z = Math.round(Number(val("(0020,0032)").split("\\")[2]) * 100) / 100;
        const slope = Number(val("(0028,1053)") || "1"), icpt = Number(val("(0028,1052)") || "0");
        const buf = Buffer.from(await (await fetch(`${base}/api/studies/${studyUid}/series/${u}/instances/${sopInstanceUid}/file`)).arrayBuffer());
        const n = 256 * 256, px = new Float32Array(n);
        for (let i = 0; i < n; i++) px[i] = buf.readInt16LE(buf.length - n * 2 + i * 2) * slope + icpt;
        out.set(z, px);
      }
      return out;
    };
    const sAdc = await readSaved(savedAdc!.seriesInstanceUid);
    const s0 = readSeries(path.join(GE, "b0")), s1 = readSeries(path.join(GE, "b1000")), dev = readSeries(path.join(GE, "adc"));
    const zs = [...s0.keys()].sort((a, b) => a - b);
    check(zs.every((z) => sAdc.has(z)), "保存した全スライスの位置 (IPP z) が元と一致する");
    const got: number[] = [], exp: number[] = [], scanner: number[] = [];
    for (const z of zs) {
      const a = s0.get(z)!, b = s1.get(z)!, d = dev.get(z)!;
      const adc = core.adcVolume(a, b, 0, 1000).data as Float32Array;
      const max = Math.max(...a);
      for (let i = 0; i < a.length; i++) {
        if (a[i] > 0.15 * max && b[i] > 0 && d[i] > 0) { got.push(sAdc.get(z)![i] * 1e6); exp.push(adc[i] * 1e6); scanner.push(d[i]); }
      }
    }
    const relErr = got.map((g, i) => Math.abs(g - exp[i]) / Math.max(exp[i], 50)).sort((a, b) => a - b);
    console.log(`  比べた画素 ${got.length}。保存 ADC vs 独立計算: 中央値 ${relErr[relErr.length >> 1].toExponential(2)}, p99 ${relErr[Math.floor(relErr.length * 0.99)].toExponential(2)}`);
    check(got.length > 100000, "比べた画素が十分ある", got.length);
    check(relErr[relErr.length >> 1] < 0.005 && relErr[Math.floor(relErr.length * 0.99)] < 0.03, "保存した ADC が独立に計算した期待値と一致する");
    const ratio = median(got.map((g, i) => g / scanner[i]));
    const r = corr(got, scanner);
    console.log(`  保存 ADC（×10⁻⁶ mm²/s） / 装置 ADC: 中央値の比 ${ratio.toFixed(4)}、相関 ${r.toFixed(4)}`);
    check(Math.abs(ratio - 1) < 0.01, "🔴 保存した ADC の絶対値が装置の ADC と一致する（中央値の比 1±1%）", ratio);
    check(r > 0.99, "画素ごとの相関 > 0.99", r);
  } finally {
    await driver.stop().catch(() => undefined);
  }
  return summary();
}

main().then((n) => process.exit(n)).catch((e) => { console.error(e); process.exit(1); });
