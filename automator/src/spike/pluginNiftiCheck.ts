/*
 * H78・H79（仮）（host.nifti.exportSeries / release / importVolume）を実アプリ（Electron＋実 backend）で確かめる（fw/nifti-import.md §11）。
 *
 * 実行:  cd automator && NIFTI_PY=<nibabel・pydicom・numpy の入った python> GRAPHY_AUTOMATOR_HTTP_PORT=18700 GRAPHY_AUTOMATOR_SCP_PORT=18701 \
 *          GRAPHY_AUTOMATOR_VITE_PORT=18703 timeout 900 npx tsx src/spike/pluginNiftiCheck.ts   （先に backend の jar を作り直す）
 *
 * 1. 合成シリーズ（`check-nifti-markers.py make`）を取り込み、プラグインが exportSeries → **返ったパスのファイルを nibabel で読む**
 *    （矢状・斜位・4D。形・向き・印の RAS・画素のビット一致）。プラグインの JAR も同じファイルを自分のコードで読む。
 *    断る形（チルト・位置ごとの枚数が揃わない 4D・モザイク）は理由コードつきの ok:false でファイルを渡さない。
 * 2. JAR がそのファイルを自分の一時フォルダへ書き戻す（形式変換の代わり）→ importVolume → **本体の確認画面**（目視）→ 取り込む
 *    → 新しいシリーズ。**もう一度書き出して、最初のファイルと形・affine・画素が一致**。取り込んだ一時ファイルは本体が消す。
 * 3. 確認で「やめる」と取り込まない（先に 1 件取り込めることを確かめてから、検査の数が変わらないことを見る）。
 * 4. 負例: 一時フォルダの外・ほかのプラグインのフォルダのパスは断られ、ファイルは消えない。向きの無い NIfTI は確認画面に「向きを合成」の警告。
 * 5. release は自分のフォルダのファイルだけ消す。
 * 結果は 合格・失敗・未達 に分けて数える。患者情報を含まない合成データ。
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Page } from "@playwright/test";

import { resetDb } from "../backend/dbReset.js";
import { dismissStartupDialogs } from "../common/dismissDialogs.js";
import { DesktopDriver, DESKTOP_RUN_DATA_DIR } from "../driver/desktopDriver.js";
import { importPaths } from "../fixtures/importFixtures.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { createChecker } from "./computeSpikeShared.js";

const PLUGIN_ID = "nifti-bridge-check";
const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "plugin-nifti");
const SRC_DIR = path.join(AUTOMATOR_ROOT, "plugins", PLUGIN_ID);
const SPI_JAR = path.join(AUTOMATOR_ROOT, "..", "backend", "target", "graphy-next-backend-plugin-api.jar");
const PY = process.env.NIFTI_PY ?? "python3";
const TOOL = path.join(AUTOMATOR_ROOT, "scripts", "check-nifti-markers.py");
const { check, summary } = createChecker();

function py(args: string[]): { status: number; out: string } {
  const r = spawnSync(PY, ["-I", ...args], { encoding: "utf8" });
  return { status: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function installPlugin(): void {
  const dst = path.join(DESKTOP_RUN_DATA_DIR, "plugins", PLUGIN_ID);
  fs.rmSync(dst, { recursive: true, force: true });
  fs.mkdirSync(dst, { recursive: true });
  for (const name of ["plugin.json", "ui.js"]) fs.copyFileSync(path.join(SRC_DIR, name), path.join(dst, name));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "niftiprobe-"));
  execFileSync("javac", ["--release", "17", "-cp", SPI_JAR, "-d", work, path.join(SRC_DIR, "java", "NiftiBridgeProbe.java")]);
  execFileSync("jar", ["--create", "--file", path.join(dst, "nifti-probe.jar"), "-C", work, "."]);
  fs.rmSync(work, { recursive: true, force: true });
}

type ExportOut = { ok: true; path: string; bytes: number; slices: number; frames: number; timeStepSec: number | null } | { ok: false; error: string };
type ImportOut = { ok: boolean; cancelled?: boolean; error?: string; studyInstanceUid?: string; seriesInstanceUid?: string; geometrySynthesized?: boolean };

async function main(): Promise<number> {
  const probe = py(["-c", "import nibabel, pydicom, numpy"]);
  if (probe.status !== 0) {
    console.log(`【未達】nibabel / pydicom / numpy が使えません（NIFTI_PY=${PY}）。独立照合ができないので合格にしません。\n${probe.out}`);
    return 2;
  }
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "nifti-host-api-"));
  const ph = path.join(work, "ph");
  const made = py([TOOL, "make", ph]);
  if (made.status !== 0) throw new Error(`合成シリーズを作れませんでした: ${made.out}`);
  const truth = JSON.parse(fs.readFileSync(path.join(ph, "truth.json"), "utf8")) as Record<string, { study: string; series: string }>;
  installPlugin();

  const driver = new DesktopDriver();
  try {
    await driver.start();
    const page = driver.page;
    await resetDb(driver.ports.http);
    const base = `http://localhost:${driver.ports.http}`;
    const imp = await importPaths(driver.ports.http, Object.keys(truth).map((n) => path.join(ph, n)));
    const made2 = Object.keys(truth).reduce((n, name) => n + fs.readdirSync(path.join(ph, name)).length, 0);
    check(imp.failed === 0 && imp.imported === made2, `（前提）合成シリーズ（${made2} 枚）を取り込めた`, imp);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
    await dismissStartupDialogs(page);
    await page.getByTestId("mainscreen-menu-plugins").click();
    await page.getByTestId(`plugin-item-${PLUGIN_ID}`).click();
    await page.waitForFunction(() => !!(window as unknown as { __mainHost?: unknown }).__mainHost, null, { timeout: 20_000 });

    const exportOf = (name: string): Promise<ExportOut> =>
      page.evaluate(`window.__mainHost.nifti.exportSeries(${JSON.stringify({ studyUid: truth[name].study, seriesUid: truth[name].series })})`) as Promise<ExportOut>;
    const job = (payload: object) => page.evaluate(`window.__mainHost.runBackendJob(${JSON.stringify(payload)})`) as Promise<{ ok: boolean; error?: string; result: Record<string, unknown> }>;
    const countStudies = async () => ((await (await fetch(`${base}/api/studies`)).json()) as unknown[]).length;
    const importVia = async (req: object, accept: boolean, shot: string): Promise<ImportOut> => {
      const pr = page.evaluate(`window.__mainHost.nifti.importVolume(${JSON.stringify(req)})`) as Promise<ImportOut>;
      await page.getByTestId("plugin-nifti-consent").waitFor({ state: "visible", timeout: 20_000 });
      await page.screenshot({ path: path.join(OUT_DIR, `${shot}.png`) });
      await page.getByTestId(accept ? "plugin-nifti-consent-ok" : "plugin-nifti-consent-cancel").click();
      return pr;
    };

    console.log("\n[1] exportSeries: 返ったパスのファイルを nibabel で読む（プラグインの JAR も同じファイルを読む）");
    const exported: Record<string, string> = {};
    for (const name of ["sagittal", "oblique"]) {
      const r = await exportOf(name);
      check(r.ok === true, `${name}: exportSeries が成功する`, r);
      if (!r.ok) continue;
      check(r.path.includes(path.join("graphy-plugin-nifti", PLUGIN_ID)) && fs.existsSync(r.path) && r.frames === 1 && r.slices === 16, `${name}: プラグインの一時フォルダに置かれた（16 枚・時相 1）`, r);
      const copy = path.join(OUT_DIR, `${name}.nii.gz`);
      fs.copyFileSync(r.path, copy);
      exported[name] = r.path;
      const c = py([TOOL, "check", name, copy, ph]);
      console.log(c.out.split("\n").filter(Boolean).map((l) => `    ${l.trim()}`).join("\n"));
      check(c.status === 0, `${name}: nibabel の独立照合（形・画素のビット一致・印の RAS・軸の向き）がすべて合格`);
      const j = await job({ path: r.path, mode: "inspect" });
      check(j.ok && j.result.magic === "n+1" && j.result.nx === 32 && j.result.ny === 24 && j.result.nz === 16 && j.result.datatype === 16, `${name}: プラグインの JAR が自分のコードでヘッダを読めた`, j);
    }
    const four = await exportOf("dyn");
    check(four.ok === true && four.frames === 3 && four.timeStepSec === 2, "4D: 3 時相・時間間隔 2 秒が返る", four);
    if (four.ok) {
      const copy = path.join(OUT_DIR, "dyn.nii.gz");
      fs.copyFileSync(four.path, copy);
      const c = py([TOOL, "4d", copy, ph]);
      check(c.status === 0, "4D: nibabel の独立照合（形・時間間隔・各時相の画素）が合格", c.out.slice(-300));
      exported.dyn = four.path;
    }

    console.log("\n[1b] 断る形は理由コードつきの ok:false（ファイルを渡さない）");
    for (const [name, reason] of [["tilt", "volume-sheared"], ["uneven4d", "nifti-uneven-phases"], ["mosaic", "nifti-mosaic"]] as const) {
      const r = await exportOf(name);
      check(r.ok === false && r.error === reason, `${name}: ${reason}`, r);
    }
    const leftovers = fs.readdirSync(path.join(os.tmpdir(), "graphy-plugin-nifti", PLUGIN_ID)).length;
    check(leftovers === 3, `断った分は一時フォルダにファイルを置いていない（置いたのは 3 本: ${leftovers}）`);

    console.log("\n[2] JAR が書き戻した NIfTI を importVolume → 確認画面 → 取り込む → もう一度書き出して一致");
    const j1 = await job({ path: exported.sagittal, mode: "copy" });
    check(j1.ok && typeof j1.result.path === "string" && fs.existsSync(j1.result.path as string), "JAR が自分の一時フォルダへ NIfTI を書いた", j1);
    const studiesBefore = await countStudies();
    const done = await importVia({ path: j1.result.path, sourceName: "bridge-copy.nii.gz", patient: { patientId: "H79-SPIKE", patientName: "Bridge^Check" }, modality: "CT", seriesDescription: "bridge" }, true, "consent-ok");
    check(done.ok === true && !!done.seriesInstanceUid && done.geometrySynthesized === false, "「取り込む」で新しいシリーズができる（向きは NIfTI のもの）", done);
    check(!fs.existsSync(j1.result.path as string), "取り込んだ一時ファイルは本体が消す");
    check((await countStudies()) === studiesBefore + 1, "検査が 1 件増える");
    if (done.ok) {
      const again = await fetch(`${base}/api/nifti/export`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ studyUid: done.studyInstanceUid, seriesUid: done.seriesInstanceUid }),
      });
      check(again.status === 200, "取り込んだシリーズをもう一度書き出せる", again.status);
      const f2 = path.join(OUT_DIR, "sagittal-reimported.nii.gz");
      fs.writeFileSync(f2, Buffer.from(await again.arrayBuffer()));
      const pc = py([TOOL, "pm", path.join(OUT_DIR, "sagittal.nii.gz"), f2, "allow-no-nan"]);
      console.log(pc.out.split("\n").filter(Boolean).map((l) => `    ${l.trim()}`).join("\n"));
      check(pc.status === 0, "往復: 形・affine・画素が最初に書き出したファイルと一致");
    }

    console.log("\n[3] 確認で「やめる」と取り込まない（先に 1 件取り込めることは [2] で確かめた）");
    const j2 = await job({ path: exported.oblique, mode: "copy" });
    const before = await countStudies();
    const cancelled = await importVia({ path: j2.result.path, patient: { patientId: "H79-CANCEL" }, modality: "CT" }, false, "consent-cancel");
    check(cancelled.ok === false && cancelled.cancelled === true, "「やめる」は cancelled", cancelled);
    check((await countStudies()) === before, `検査の数が変わらない（${before}）`);
    check(fs.existsSync(j2.result.path as string), "やめたときは、プラグインのファイルに触らない");
    fs.rmSync(path.dirname(j2.result.path as string), { recursive: true, force: true });

    console.log("\n[4] 負例: 一時フォルダの外・ほかのプラグインのフォルダは断られ、ファイルは消えない");
    const outside = path.join(OUT_DIR, "outside.nii.gz");
    fs.copyFileSync(path.join(OUT_DIR, "sagittal.nii.gz"), outside);
    const bad = (await page.evaluate(`window.__mainHost.nifti.importVolume(${JSON.stringify({ path: outside, patient: { patientId: "X" } })})`)) as ImportOut;
    check(bad.ok === false && /一時フォルダ|temp/i.test(bad.error ?? ""), `外のパスは本体が断る（確認画面も出ない）: ${bad.error}`);
    check(fs.existsSync(outside) && (await page.getByTestId("plugin-nifti-consent").count()) === 0, "断ったファイルは消さない・確認画面は出ていない");
    const otherDir = path.join(os.tmpdir(), "graphy-plugin-nifti", "some-other-plugin", "job");
    fs.mkdirSync(otherDir, { recursive: true });
    const other = path.join(otherDir, "x.nii.gz");
    fs.copyFileSync(path.join(OUT_DIR, "sagittal.nii.gz"), other);
    const bad2 = (await page.evaluate(`window.__mainHost.nifti.importVolume(${JSON.stringify({ path: other, patient: { patientId: "X" } })})`)) as ImportOut;
    check(bad2.ok === false && /このプラグイン|plugin/i.test(bad2.error ?? ""), `ほかのプラグインのフォルダは断る: ${bad2.error}`);
    check(fs.existsSync(other), "断ったファイルは消さない");
    fs.rmSync(path.join(os.tmpdir(), "graphy-plugin-nifti", "some-other-plugin"), { recursive: true, force: true });
    // 向きの無い NIfTI: 確認画面に警告
    const j3 = await job({ path: exported.sagittal, mode: "nosform" });
    const pr = page.evaluate(`window.__mainHost.nifti.importVolume(${JSON.stringify({ path: j3.result.path, patient: { patientId: "H79-NOSFORM" }, modality: "CT" })})`) as Promise<ImportOut>;
    await page.getByTestId("plugin-nifti-consent").waitFor({ state: "visible", timeout: 20_000 });
    check(await page.getByTestId("plugin-nifti-consent-synth").isVisible(), "向きが NIfTI に無いときは、確認画面に「向きを合成」の警告が出る");
    await page.screenshot({ path: path.join(OUT_DIR, "consent-synth.png") });
    await page.getByTestId("plugin-nifti-consent-cancel").click();
    check((await pr).cancelled === true, "警告を見て「やめる」→ 取り込まない");
    fs.rmSync(path.dirname(j3.result.path as string), { recursive: true, force: true });

    console.log("\n[5] release は自分のフォルダのファイルだけ消す");
    const rel = (p: string) => page.evaluate(`window.__mainHost.nifti.release(${JSON.stringify(p)})`) as Promise<{ ok: boolean; error?: string }>;
    const rOut = await rel(outside);
    check(rOut.ok === false && fs.existsSync(outside), "外のファイルは消さない（断る）", rOut);
    const rMine = await rel(exported.sagittal);
    check(rMine.ok === true && !fs.existsSync(exported.sagittal), "自分のフォルダのファイルは消える", rMine);
    console.log(`\n出力: ${OUT_DIR}`);
    return summary();
  } finally {
    await driver.stop().catch(() => undefined);
    fs.rmSync(path.join(DESKTOP_RUN_DATA_DIR, "plugins", PLUGIN_ID), { recursive: true, force: true });
    fs.rmSync(path.join(os.tmpdir(), "graphy-plugin-nifti", PLUGIN_ID), { recursive: true, force: true });
    fs.rmSync(work, { recursive: true, force: true });
  }
}

main().then((c) => process.exit(c), (e) => { console.error(e); process.exit(2); });
