/*
 * メイン画面の［ファイル］→「NIfTI で書き出し…」の実アプリ検査（Chromium＋実 backend〈standalone〉＋合成 CT）。
 *
 * 段 1a の合成シリーズ（`check-nifti-markers.py make`: 軸位・冠状・矢状・斜位・チルト・欠け。LPS の既知の 3 点に印）を取り込み、
 * **メニューを実際に押して**保存されたファイルを、nibabel（本体の書き手とは別の実装）で照合する。
 *
 * 実行:  cd automator && NIFTI_PY=<nibabel・pydicom・numpy の入った python> timeout 900 npx tsx src/spike/niftiExportCheck.ts
 *
 *  1. 既定（シリーズ未選択）では項目が押せず、理由が出る（負例）。
 *  2. 矢状・軸位・冠状・斜位を選んで押す → .nii.gz が保存される（既定名 CT_S<番号>）。nibabel で形・画素・印の RAS・軸の向きを照合。
 *  3. 保存したファイルを本体の NIfTI 取り込みで戻し、もう一度書き出す → 最初のファイルと形・affine・画素が一致（往復）。
 *  4. 負例: ガントリーチルト・欠けたスライスは、理由つきの帯が出て、ファイルは保存されない。
 *  5. 画面を目で確認（メニュー・成功の帯・失敗の帯）。
 * 結果は 合格・失敗・未達 に分けて数える。患者情報を含まない合成データ。
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Page } from "@playwright/test";

import { resetDb } from "../backend/dbReset.js";
import { WebDriver } from "../driver/webDriver.js";
import { importPaths } from "../fixtures/importFixtures.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { createChecker } from "./computeSpikeShared.js";

const { check, summary } = createChecker();
const PY = process.env.NIFTI_PY ?? "python3";
const TOOL = path.join(AUTOMATOR_ROOT, "scripts", "check-nifti-markers.py");
const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "nifti-export-ui");

function py(args: string[]): { status: number; out: string } {
  const r = spawnSync(PY, ["-I", ...args], { encoding: "utf8" });
  return { status: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

async function openFileMenu(p: Page): Promise<void> {
  await p.getByRole("button", { name: /^(ファイル|File)$/ }).first().click();
}

async function selectSeries(p: Page, study: string, series: string): Promise<void> {
  await p.reload();
  await p.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 30_000 });
  await p.getByTestId("search-allperiod-chip").click();
  await p.getByTestId("search-submit-button").click();
  await p.locator(`[data-testid="study-row-${study}"]`).click();
  await p.locator(`[data-testid="series-row-${series}"]`).click();
  await p.waitForTimeout(800);
}

async function main(): Promise<number> {
  const probe = py(["-c", "import nibabel, pydicom, numpy"]);
  if (probe.status !== 0) {
    console.log(`【未達】nibabel / pydicom / numpy が使えません（NIFTI_PY=${PY}）。独立照合ができないので合格にしません。\n${probe.out}`);
    return 2;
  }
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.rmSync(path.join(AUTOMATOR_ROOT, ".results", "run-data", "web"), { recursive: true, force: true });
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "nifti-export-ui-"));
  const ph = path.join(work, "ph");
  const made = py([TOOL, "make", ph]);
  if (made.status !== 0) throw new Error(`合成シリーズを作れませんでした: ${made.out}`);
  const truth = JSON.parse(fs.readFileSync(path.join(ph, "truth.json"), "utf8")) as Record<string, { study: string; series: string }>;

  const d = new WebDriver({ http: 18680, scp: 18681, vite: 18683 }, { viewport: { width: 1400, height: 900 }, locale: "ja-JP" });
  await d.start();
  try {
    await resetDb(d.ports.http);
    const imp = await importPaths(d.ports.http, Object.keys(truth).map((n) => path.join(ph, n)));
    check(imp.failed === 0 && imp.imported === 16 * 5 + 15, "（前提）合成シリーズ（16 枚×5 と欠け 15 枚）を取り込めた", imp);
    const status = (await (await fetch(`http://127.0.0.1:${d.ports.http}/api/status`)).json()) as { mode?: string };
    check(status.mode === "standalone", "（前提）backend は standalone で動いている（web モードでは書き出せない）", status.mode);

    const p = d.page;
    await p.reload();
    await p.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 30_000 });

    console.log("\n[1] 既定（シリーズ未選択）: 項目が押せず、理由が出る（負例）");
    await openFileMenu(p);
    const item = p.getByTestId("menu-item-nifti-export");
    await item.waitFor({ state: "visible" });
    check(await item.isDisabled(), "シリーズ未選択では項目が押せない", null);
    check(/シリーズを 1 本選んで/.test((await item.getAttribute("title")) ?? ""), "理由が title に出る", await item.getAttribute("title"));
    await p.screenshot({ path: path.join(OUT_DIR, "1-menu-disabled.png") });
    await p.keyboard.press("Escape");
    await p.mouse.click(5, 5);

    console.log("\n[2] 4 つの向き: メニューを押して保存 → nibabel で照合");
    const saved: Record<string, string> = {};
    for (const name of ["sagittal", "axial", "coronal", "oblique"]) {
      await selectSeries(p, truth[name].study, truth[name].series);
      await openFileMenu(p);
      const it = p.getByTestId("menu-item-nifti-export");
      check(await it.isEnabled(), `${name}: シリーズを選ぶと項目が押せる`, null);
      const [dl] = await Promise.all([p.waitForEvent("download", { timeout: 60_000 }), it.click()]);
      const f = path.join(OUT_DIR, `${name}.nii.gz`);
      await dl.saveAs(f);
      saved[name] = f;
      check(/^CT_S\d+\.nii\.gz$/.test(dl.suggestedFilename()), `${name}: 既定名が <モダリティ>_S<番号>（患者情報なし）`, dl.suggestedFilename());
      const msg = p.getByTestId("nifti-export-msg");
      await msg.waitFor({ state: "visible", timeout: 20_000 });
      const msgText = await msg.innerText();
      check(/書き出しました（16 枚）/.test(msgText), `${name}: 成功の帯に枚数が出る`, msgText);
      if (name === "sagittal") await p.screenshot({ path: path.join(OUT_DIR, "2-exported-sagittal.png") });
      const r = py([TOOL, "check", name, f, ph]);
      console.log(r.out.split("\n").filter(Boolean).map((l) => `    ${l.trim()}`).join("\n"));
      check(r.status === 0, `${name}: nibabel の独立照合（形・画素のビット一致・印の RAS・軸の向き）がすべて合格`);
    }

    console.log("\n[3] 往復: 保存した矢状の .nii.gz を取り込み直し、もう一度書き出す → 最初のファイルと一致");
    const base = `http://127.0.0.1:${d.ports.http}`;
    const ir = await fetch(`${base}/api/nifti/import`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: saved.sagittal, modality: "CT", patientId: "NIFTI-ROUNDTRIP", patientName: "Round^Trip", seriesDescription: "roundtrip" }),
    });
    const imported = (await ir.json()) as { studyInstanceUid: string; seriesInstanceUid: string; error: string | null };
    check(ir.ok && !imported.error, "（前提）書き出した NIfTI を本体の取り込みで戻せた", imported);
    const again = await fetch(`${base}/api/nifti/export`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ studyUid: imported.studyInstanceUid, seriesUid: imported.seriesInstanceUid }),
    });
    check(again.status === 200, "取り込み直したシリーズをもう一度書き出せる", again.status);
    const f2 = path.join(OUT_DIR, "sagittal-roundtrip.nii.gz");
    fs.writeFileSync(f2, Buffer.from(await again.arrayBuffer()));
    const pc = py([TOOL, "pm", saved.sagittal, f2, "allow-no-nan"]);
    console.log(pc.out.split("\n").filter(Boolean).map((l) => `    ${l.trim()}`).join("\n"));
    check(pc.status === 0, "往復: 形・affine（1e-4）・画素（NaN を含めビット一致）が最初のファイルと同じ");

    console.log("\n[4] 負例: ガントリーチルト・欠けたスライスは、理由つきの帯が出て、ファイルは保存されない");
    for (const [name, reason, word] of [["tilt", "volume-sheared", /ガントリーチルト/], ["gap", "npz-uneven-spacing", /間隔が一定でない|欠けた/]] as const) {
      await selectSeries(p, truth[name].study, truth[name].series);
      await openFileMenu(p);
      let downloaded = false;
      const onDl = () => { downloaded = true; };
      p.on("download", onDl);
      await p.getByTestId("menu-item-nifti-export").click();
      const msg = p.getByTestId("nifti-export-msg");
      await msg.filter({ hasText: /書き出せませんでした/ }).waitFor({ state: "visible", timeout: 20_000 });
      await p.waitForTimeout(1500);
      p.off("download", onDl);
      const t = await msg.innerText();
      check(word.test(t), `${name}（${reason}）: 理由の文言が帯に出る`, t);
      check(!downloaded, `${name}: ファイルは保存されない（ダウンロードが起きない）`, null);
      await p.screenshot({ path: path.join(OUT_DIR, `4-refused-${name}.png`) });
    }
    console.log(`\n出力: ${OUT_DIR}`);
    return summary();
  } finally {
    await d.stop();
    fs.rmSync(work, { recursive: true, force: true });
  }
}

main().then((c) => process.exit(c), (e) => { console.error(e); process.exit(2); });
