/*
 * Computed DWI / vMRE プラグイン（graphy-next-plugin-computed-dwi）の実機検証スパイク。
 *
 * 実行:  cd backend && mvn -q -Dfrontend.skip=true -DskipTests package     （backend jar。必ず今の版を）
 *        cd <plugin> && npm run build                                      （ui.js）
 *        cd automator && CDWI_SAMPLE=<HASSAKU_DCM> CDWI_SYNTH=<合成 b0 のフォルダ> npx tsx src/spike/cdwiPluginCheck.ts
 *
 * 入力（患者情報を含むのでリポジトリに入れない）:
 *   CDWI_SAMPLE  HASSAKU_DCM.zip を展開したフォルダ（脳 DWI の b0・b900・装置 ADC）
 *   CDWI_SYNTH   実データの b900 と装置 ADC から合成した b0（S0 = S900·exp(900·ADC)。物理的に整合した正例）
 *   CDWI_PLUGIN_DIR  プラグインのリポジトリ（既定 ~/graphy-next-plugin-computed-dwi）
 * 入力が無ければ「未達」と書いて終了コード 2（合格にはしない）。
 *
 * 確かめること（本物の Electron ＋ backend ＋ プラグイン配信経路）:
 *   1. b 値が入れ子のタグ（MRDiffusionSequence 内）から読めて、入力欄に出る
 *   2. 実物の B0（系列ごとに別々に正規化されている）では強度スケールの警告が出る（負例）
 *   3. 合成 b0 + 実 b900 では警告が出ず、3 面の並列表示とカラースケール・単位が出る（スクリーンショットで判定）
 *   4. cDWI / ADC / sADC / μdiff が確認ダイアログを経て保存され、説明・b 値タグ・単位が正しい
 *   5. 保存した画素を読み戻し、独立に計算した期待値と数値で一致する
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
const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "cdwi-plugin-check");
const PLUGIN_ID = "vis-computed-dwi";
const PLUGIN_DIR = process.env.CDWI_PLUGIN_DIR ?? path.join(os.homedir(), "graphy-next-plugin-computed-dwi");
const SAMPLE = process.env.CDWI_SAMPLE;
const SYNTH = process.env.CDWI_SYNTH;
const N = 256 * 256;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- 期待値の独立計算用: 非圧縮 Explicit VR LE の最小読み取り（IPP の z と末尾の画素）
function readSlice(file: string): { z: number; px: Float32Array } {
  const b = fs.readFileSync(file);
  const at = b.indexOf(Buffer.from([0x20, 0x00, 0x32, 0x00, 0x44, 0x53]));
  const len = b.readUInt16LE(at + 6);
  const z = Number(b.toString("latin1", at + 8, at + 8 + len).trim().split("\\")[2]);
  const px = new Float32Array(N);
  for (let i = 0; i < N; i++) px[i] = b.readInt16LE(b.length - N * 2 + i * 2);
  return { z: Math.round(z * 100) / 100, px };
}
function readSeries(dir: string): Map<number, Float32Array> {
  const m = new Map<number, Float32Array>();
  for (const f of fs.readdirSync(dir).sort()) {
    const s = readSlice(path.join(dir, f));
    m.set(s.z, s.px);
  }
  return m;
}

async function seriesOf(base: string, studyUid: string) {
  return (await (await fetch(`${base}/api/studies/${studyUid}/series`)).json()) as {
    seriesInstanceUid: string; seriesDescription?: string; numberOfInstances?: number; modality?: string;
  }[];
}
async function tagsOf(base: string, studyUid: string, seriesUid: string, sop: string): Promise<{ tag: string; value: string; depth: number }[]> {
  return (await (await fetch(`${base}/api/studies/${studyUid}/series/${seriesUid}/instances/${sop}/tags`)).json()) as never;
}

async function main(): Promise<number> {
  if (!SAMPLE || !SYNTH || !fs.existsSync(SAMPLE) || !fs.existsSync(SYNTH) || !fs.existsSync(path.join(PLUGIN_DIR, "ui.js"))) {
    console.log("【未達】入力が足りません（CDWI_SAMPLE / CDWI_SYNTH / プラグインの ui.js）。合格ではありません。");
    return 2;
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const dst = path.join(DESKTOP_RUN_DATA_DIR, "plugins", PLUGIN_ID);
  fs.rmSync(dst, { recursive: true, force: true });
  fs.mkdirSync(dst, { recursive: true });
  for (const n of ["plugin.json", "ui.js"]) fs.copyFileSync(path.join(PLUGIN_DIR, n), path.join(dst, n));

  // 期待値の計算に、プラグインの純粋計算コアをそのまま使う（式の検証は vitest 側。ここは「配線」の検証）。
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const core = (await import(pathToFileURL(path.join(PLUGIN_DIR, "src", "core", "dwi.ts")).href)) as any;

  const dirB0 = path.join(SAMPLE, "DWI AX short-B0");
  const dirB9 = path.join(SAMPLE, "DWI AX short-DWI_b900");
  const driver = new DesktopDriver({ http: 18741, scp: 18742, vite: 18743 });
  let viewer: Page | null = null;
  try {
    await driver.start();
    await resetDb(driver.ports.http);
    const imp = await importPaths(driver.ports.http, [dirB0, SYNTH, dirB9]);
    console.log(`  import: ${JSON.stringify({ imported: imp.imported, skipped: imp.skipped, failed: imp.failed })}`);
    check(imp.failed === 0 && imp.imported === 48, "（前提）3 系列 48 枚を取り込めた", imp);

    const base = `http://localhost:${driver.ports.http}`;
    const studies = (await (await fetch(`${base}/api/studies`)).json()) as { studyInstanceUid: string }[];
    const studyUid = studies[0].studyInstanceUid;
    const ser = await seriesOf(base, studyUid);
    const uidOf = (pred: (d: string) => boolean) => ser.find((s) => pred(s.seriesDescription ?? ""))?.seriesInstanceUid;
    const uidSynth = uidOf((d) => d.includes("SYNTH"));
    const uidB9 = uidOf((d) => d.includes("b900"));
    const uidB0 = ser.find((s) => s.seriesInstanceUid !== uidSynth && s.seriesInstanceUid !== uidB9)?.seriesInstanceUid;
    check(!!uidSynth && !!uidB9 && !!uidB0 && studies.length === 1, "（前提）b0 / 合成 b0 / b900 が同じ検査に揃った", ser.map((s) => s.seriesDescription));

    const mainPage = driver.page;
    await mainPage.evaluate("localStorage.setItem('graphy.locale', 'ja')");
    await mainPage.reload({ waitUntil: "domcontentloaded" });
    await mainPage.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
    await selectFirstStudy(mainPage, createStepRecorder());
    await mainPage.locator(`[data-testid="series-row-${uidB9}"]`).click();
    await mainPage.getByTestId("series-viewer-root").waitFor({ state: "visible", timeout: 15_000 });
    await mainPage.waitForTimeout(1500);
    viewer = await driver.waitForNewPage(
      () => mainPage.getByTestId("viewer2d-toolbar-button").click(),
      (url) => url.includes("2dviewer"),
    );
    await viewer.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 30_000 });
    await viewer.waitForTimeout(2500);
    viewer.on("console", (m) => { if (m.type() === "error") console.log(`  [viewer error] ${m.text()}`); });

    // ---- プラグインを開く
    await viewer.getByTestId("viewer2d-menu-analysis").click();
    await viewer.getByTestId(`plugin-analysis-item-${PLUGIN_ID}`).click();
    await viewer.locator("#cdwi-run").waitFor({ state: "visible", timeout: 15_000 });
    // 表示中のシリーズ（b900）が自動で入る
    await viewer.locator('[data-testid="input-row"]').first().waitFor({ state: "visible", timeout: 20_000 });

    // ---- 入力: 保管庫から b0 と合成 b0 を足す
    await viewer.getByRole("button", { name: /保管庫から追加/ }).click();
    await viewer.getByTestId("pickseries-dialog").last().waitFor({ state: "visible", timeout: 20_000 });
    const top = (id: string) => viewer!.getByTestId(id).last();
    await top(`pickseries-study-${studyUid}`).waitFor({ state: "visible", timeout: 20_000 });
    for (const u of [uidB0!, uidSynth!]) {
      if ((await top(`pickseries-series-check-${u}`).count()) === 0) await top(`pickseries-expand-${studyUid}`).click();
      await top(`pickseries-series-check-${u}`).check();
    }
    await top("pickseries-ok").click();
    await viewer.waitForFunction(() => document.querySelectorAll('[data-testid="input-row"]').length >= 3, undefined, { timeout: 30_000 });

    console.log("\n[1] 入力と b 値");
    const bOf = async (uid: string) => viewer!.locator(`[data-testid="b-${uid}#0"]`).inputValue();
    const bs = { b0: await bOf(uidB0!), synth: await bOf(uidSynth!), b900: await bOf(uidB9!) };
    check(bs.b0 === "0" && bs.synth === "0" && bs.b900 === "900", "入れ子の (0018,9087) から b 値を読めた（0 / 0 / 900）", bs);
    const rowsText = await viewer.locator('[data-testid="input-row"]').allTextContents();
    check(rowsText.every((t) => t.includes("DICOM (0018,9087)")), "出所が表示される（DICOM (0018,9087)）", rowsText);
    check(rowsText.every((t) => t.includes("DERIVED")), "ImageType=DERIVED が表示される", rowsText);

    const run = async () => {
      await viewer!.getByTestId("run").click();
      await viewer!.waitForFunction(
        () => /計算しました|^[^計]/.test(document.querySelector('[data-testid="status"]')?.textContent ?? "") && !document.querySelector("#cdwi-run")?.hasAttribute("disabled"),
        undefined, { timeout: 120_000 },
      );
      await sleep(1500);
      return {
        status: (await viewer!.getByTestId("status").textContent()) ?? "",
        warnings: await viewer!.getByTestId("warning").allTextContents(),
      };
    };

    // ---- [2] 負例: 実物の B0（別々に正規化された系列）
    console.log("\n[2] 実物の B0 + b900（強度スケールが揃っていない）");
    await viewer.locator("#cdwi-base-low").selectOption(`${uidB0}#0`);
    await viewer.locator("#cdwi-base-high").selectOption(`${uidB9}#0`);
    const neg = await run();
    console.log(`  status: ${neg.status}`);
    check(neg.status.includes("計算しました"), "計算は完了する（警告つき）", neg.status);
    check(neg.warnings.some((w) => w.includes("強度スケール")), "🔴 強度スケール不一致の警告が出る", neg.warnings);
    await viewer.screenshot({ path: path.join(OUT_DIR, "1-real-b0-warning.png") });

    // ---- [3] 正例: 合成 b0 + 実 b900
    console.log("\n[3] 合成 b0 + 実 b900");
    await viewer.locator("#cdwi-base-low").selectOption(`${uidSynth}#0`);
    const pos = await run();
    console.log(`  status: ${pos.status}`);
    check(pos.status.includes("計算しました"), "計算が完了する", pos.status);
    check(!pos.warnings.some((w) => w.includes("強度スケール")), "🔴 強度スケールの警告は出ない", pos.warnings);
    check(pos.warnings.some((w) => w.includes("非ガウス")), "合成であることと非ガウス成分が戻らないことを注記する", pos.warnings);
    check(pos.status.includes("cDWI で合成"), "実測の b200/800 が無いので合成と表示する", pos.status);
    check((await viewer.getByTestId("colorbar-adc").count()) === 1, "ADC のカラースケールがある");
    check((await viewer.getByTestId("colorbar-mudiff").count()) === 1, "μdiff のカラースケールがある");
    check((await viewer.getByTestId("colorbar-unit-adc").textContent()) === "×10⁻³ mm²/s", "ADC の単位表示", await viewer.getByTestId("colorbar-unit-adc").textContent());
    check((await viewer.getByTestId("colorbar-unit-mudiff").textContent()) === "kPa", "μdiff の単位表示（kPa）");
    await viewer.screenshot({ path: path.join(OUT_DIR, "2-synth-three-views.png") });

    // ---- [4] 保存
    console.log("\n[4] 保存");
    const before = new Set((await seriesOf(base, studyUid)).map((s) => s.seriesInstanceUid));
    const saveOne = async (kind: string, expectedDesc: string) => {
      await viewer!.getByTestId(`save-${kind}`).click();
      await viewer!.getByTestId("plugin-save-confirm").waitFor({ state: "visible", timeout: 20_000 });
      const shown = ((await viewer!.getByTestId("plugin-save-description").textContent()) ?? "").trim();
      check(shown === `[Plugin] ${expectedDesc}`, `${kind}: 確認ダイアログの説明が「${expectedDesc}」`, shown);
      await viewer!.getByTestId("plugin-save-confirm-button").click();
      await viewer!.waitForFunction(() => /保存しました|保存できません/.test(document.querySelector('[data-testid="status"]')?.textContent ?? ""), undefined, { timeout: 120_000 });
      const st = (await viewer!.getByTestId("status").textContent()) ?? "";
      check(st.includes("保存しました（16 枚）"), `${kind}: 保存できた（16 枚）`, st);
    };
    await saveOne("cdwi", "Computed DWI b=400");
    await saveOne("adc", "ADC b0-900");
    await saveOne("sadc", "sADC b200-800");
    await saveOne("mudiff", "vMRE mu_diff b200-800");
    await viewer.screenshot({ path: path.join(OUT_DIR, "3-after-save.png") });

    const after = (await seriesOf(base, studyUid)).filter((s) => !before.has(s.seriesInstanceUid));
    const pick = (d: string) => after.find((s) => s.seriesDescription === `[Plugin] ${d}`);
    const saved = {
      cdwi: pick("Computed DWI b=400"), adc: pick("ADC b0-900"), sadc: pick("sADC b200-800"), mudiff: pick("vMRE mu_diff b200-800"),
    };
    check(Object.values(saved).every((s) => !!s && s.numberOfInstances === 16), "4 つの派生シリーズが保管庫に 16 枚ずつ現れる", after.map((s) => [s.seriesDescription, s.numberOfInstances]));

    // 先頭インスタンスのタグ
    const instances = async (uid: string) => (await (await fetch(`${base}/api/studies/${studyUid}/series/${uid}/instances`)).json()) as { sopInstanceUid: string }[];
    const tagMap = async (uid: string) => {
      const sops = await instances(uid);
      const rows = await tagsOf(base, studyUid, uid, sops[0].sopInstanceUid);
      const get = (tag: string) => rows.filter((r) => r.tag === tag).map((r) => r.value);
      return { rows, get, sops };
    };
    const tCdwi = await tagMap(saved.cdwi!.seriesInstanceUid);
    check(tCdwi.get("(0018,9087)").join() === "400", "🔴 cDWI の DiffusionBValue (0018,9087) = 400", tCdwi.get("(0018,9087)"));
    check(tCdwi.rows.some((r) => r.tag === "(0018,9087)" && r.vr === "FD"), "DiffusionBValue の VR は FD");
    const tAdc = await tagMap(saved.adc!.seriesInstanceUid);
    const tSadc = await tagMap(saved.sadc!.seriesInstanceUid);
    const tMu = await tagMap(saved.mudiff!.seriesInstanceUid);
    check(tAdc.get("(0018,9087)").length === 0 && tSadc.get("(0018,9087)").length === 0 && tMu.get("(0018,9087)").length === 0,
      "🔴 ADC・sADC・μdiff には b 値タグが無い（元の b900 を引き継がない）");
    check(tAdc.get("(0028,1054)").join() === "mm2/s" && tSadc.get("(0028,1054)").join() === "mm2/s" && tMu.get("(0028,1054)").join() === "kPa",
      "RescaleType: ADC・sADC は mm2/s、μdiff は kPa", [tAdc.get("(0028,1054)"), tSadc.get("(0028,1054)"), tMu.get("(0028,1054)")]);
    check(tCdwi.get("(0028,1054)").length === 0 || tCdwi.get("(0028,1054)").join() === "", "cDWI は単位なし", tCdwi.get("(0028,1054)"));
    const deriv = tMu.get("(0008,2111)").join();
    check(deriv.includes("alpha=4.91") && deriv.includes("umag034") && /plugin: vis-computed-dwi/.test(deriv), "μdiff の DerivationDescription に式・係数・論文・プラグイン id が残る", deriv.slice(0, 200));

    // ---- [5] 保存した画素 vs 独立に計算した期待値
    console.log("\n[5] 保存画素の数値照合");
    const s0 = readSeries(SYNTH), s9 = readSeries(dirB9), dev = readSeries(path.join(SAMPLE, "DWI AX short-ADC"));
    const readSaved = async (uid: string) => {
      const out = new Map<number, Float32Array>();
      for (const { sopInstanceUid } of await instances(uid)) {
        const rows = await tagsOf(base, studyUid, uid, sopInstanceUid);
        const val = (tag: string) => rows.find((r) => r.tag === tag && r.depth === 0)?.value ?? "";
        const z = Math.round(Number(val("(0020,0032)").split("\\")[2]) * 100) / 100;
        const slope = Number(val("(0028,1053)") || "1"), icpt = Number(val("(0028,1052)") || "0");
        const buf = Buffer.from(await (await fetch(`${base}/api/studies/${studyUid}/series/${uid}/instances/${sopInstanceUid}/file`)).arrayBuffer());
        const px = new Float32Array(N);
        for (let i = 0; i < N; i++) px[i] = buf.readInt16LE(buf.length - N * 2 + i * 2) * slope + icpt;
        out.set(z, px);
      }
      return out;
    };
    const rel = (got: number[], exp: number[], floor: number) => {
      const e = got.map((g, i) => Math.abs(g - exp[i]) / Math.max(Math.abs(exp[i]), floor)).sort((a, b) => a - b);
      return { median: e[e.length >> 1], p99: e[Math.floor(e.length * 0.99)], n: e.length };
    };
    const zs = [...s9.keys()].sort((a, b) => a - b);
    const expAdc: number[] = [], gotAdc: number[] = [], expC: number[] = [], gotC: number[] = [], expMu: number[] = [], gotMu: number[] = [];
    const sAdc = await readSaved(saved.adc!.seriesInstanceUid);
    const sC = await readSaved(saved.cdwi!.seriesInstanceUid);
    const sMu = await readSaved(saved.mudiff!.seriesInstanceUid);
    check(zs.every((z) => sAdc.has(z) && sC.has(z) && sMu.has(z)), "保存した全スライスの位置 (IPP z) が元と一致する");
    for (const z of zs) {
      const a = s0.get(z)!, b = s9.get(z)!, d = dev.get(z)!;
      const adc = core.adcVolume(a, b, 0, 900).data;
      const c400 = core.cdwiVolume(a, adc, 0, 900, 400, 1);
      const cl = core.cdwiVolume(a, adc, 0, 900, 200, 1), ch = core.cdwiVolume(a, adc, 0, 900, 800, 1);
      const mu = core.muDiffVolume(cl, ch, 4.91, 0.92).data;
      for (let i = 0; i < N; i++) {
        // 信号が十分高く、装置 ADC が正の脳実質の画素だけ比べる（低信号は整数丸めの影響が大きい）
        if (b[i] >= 100 && d[i] > 0 && Number.isFinite(mu[i])) {
          expAdc.push(adc[i]); gotAdc.push(sAdc.get(z)![i]);
          expC.push(c400[i]); gotC.push(sC.get(z)![i]);
          expMu.push(mu[i]); gotMu.push(sMu.get(z)![i]);
        }
      }
    }
    // 診断: 一致しなかった画素の正体（保存値が 0 か、どのスライスか、元の信号はいくつか）
    {
      const bad: { z: number; got: number; exp: number; a: number; b: number }[] = [];
      for (const z of zs) {
        const a0 = s0.get(z)!, b9v = s9.get(z)!, d = dev.get(z)!;
        const adc = core.adcVolume(a0, b9v, 0, 900).data;
        for (let i = 0; i < N; i++) {
          if (b9v[i] >= 100 && d[i] > 0) {
            const got = sAdc.get(z)![i];
            if (Math.abs(got - adc[i]) > 0.02 * Math.max(adc[i], 1e-4)) bad.push({ z, got, exp: adc[i], a: a0[i], b: b9v[i] });
          }
        }
      }
      const byZ = new Map<number, number>();
      for (const x of bad) byZ.set(x.z, (byZ.get(x.z) ?? 0) + 1);
      console.log(`  診断: 不一致 ${bad.length} 画素。保存値=0: ${bad.filter((x) => x.got === 0).length}。スライス別: ${JSON.stringify([...byZ])}`);
      console.log(`  診断: 例 ${JSON.stringify(bad.slice(0, 5))}  S0(b0) の範囲 ${Math.min(...bad.map((x) => x.a))}..${Math.max(...bad.map((x) => x.a))}`);
    }
    const rA = rel(gotAdc, expAdc, 1e-4), rC = rel(gotC, expC, 50), rM = rel(gotMu, expMu, 1);
    console.log(`  ADC: ${JSON.stringify(rA)}  cDWI: ${JSON.stringify(rC)}  μdiff: ${JSON.stringify(rM)}`);
    check(rA.n > 20000, "比べた画素が十分ある", rA.n);
    check(rA.median < 0.005 && rA.p99 < 0.03, "ADC: 保存値が期待値に一致（相対誤差 中央値 <0.5%、99 パーセンタイル <3%）", rA);
    check(rC.median < 0.005 && rC.p99 < 0.02, "cDWI(b=400): 保存値が期待値に一致", rC);
    check(rM.median < 0.005 && rM.p99 < 0.02, "μdiff: 保存値が期待値に一致", rM);
    const ratios = gotAdc.map((g, i) => g / expAdc[i]).filter(Number.isFinite).sort((a, b) => a - b);
    check(Math.abs(ratios[ratios.length >> 1] - 1) < 0.005, "保存 ADC と期待値の比の中央値 ≈ 1", ratios[ratios.length >> 1]);
  } finally {
    await driver.stop().catch(() => undefined);
  }
  return summary();
}

main().then((n) => process.exit(n)).catch((e) => { console.error(e); process.exit(1); });
