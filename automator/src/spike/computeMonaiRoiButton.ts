/*
 * MONAI プラグイン「点 ROI から読み込む」の実機検証（Colab は使わない）。
 *
 * 実行:  cd automator && npx tsx src/spike/computeMonaiRoiButton.ts
 *
 * 何を確かめるか: ビューアで点 ROI を何枚かのスライスに置き、ボタンで入力欄に出た患者座標（LPS）の位置の
 * 画素値を、NIfTI（取り込み元）から独立に読む。ビューアが表示する同じ点の値と一致すれば、
 * 画素座標→患者座標の換算（x・y・スライス番号の向きを含む）が正しい。
 * 負例: 同じ座標を「z 反転」「x と y の入れ替え」で読むと一致率が落ちること（検査が向きの誤りを見分けられること）。
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import type { Page } from "@playwright/test";

import { resetDb } from "../backend/dbReset.js";
import { DesktopDriver } from "../driver/desktopDriver.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { installOfficialPlugin, openViewer } from "./computeMonaiShared.js";
import { createChecker } from "./computeSpikeShared.js";

const DATA = path.join(os.homedir(), "monai-verify-data");
const PY = path.join(DATA, ".venv", "bin", "python");
const PROBE = path.join(AUTOMATOR_ROOT, "tools", "monai_roi_probe.py");
const IMAGE = path.join(DATA, "msd", "x", "Task09_Spleen", "imagesTr", "spleen_56.nii.gz");
const HOST = "viewer2d-canvas-host";
const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "compute-monai-roi-button");

const { check, summary } = createChecker();

async function clickCanvas(page: Page, x: number, y: number): Promise<void> {
  await page.evaluate(`(function(){
    var canvas = document.querySelector('[data-testid="${HOST}"] canvas');
    var r = canvas.getBoundingClientRect();
    function fire(type, btns){
      var c = { bubbles:true, cancelable:true, composed:true, clientX:r.left+${x}, clientY:r.top+${y}, button:0, buttons:btns };
      canvas.dispatchEvent(new PointerEvent(type, Object.assign({}, c, { pointerId:1, pointerType:"mouse", isPrimary:true })));
      canvas.dispatchEvent(new MouseEvent(type.replace("pointer","mouse"), c));
    }
    fire("pointermove",0); fire("pointerdown",1); fire("pointerup",0);
  })()`);
  await page.waitForTimeout(500);
}

const probe = (points: string, flag?: string): (number | null)[] => {
  const r = spawnSync(PY, ["-I", PROBE, "--image", IMAGE, "--points", points, ...(flag ? [flag] : [])], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`画素値の読み取りに失敗: ${r.stderr}`);
  return JSON.parse(r.stdout);
};

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  installOfficialPlugin();
  const driver = new DesktopDriver();
  try {
    await driver.start();
    const page = driver.page;
    page.on("dialog", (d) => void d.accept());
    await resetDb(driver.ports.http);
    const base = `http://localhost:${driver.ports.http}`;
    const r = await fetch(`${base}/api/nifti/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: IMAGE, modality: "CT", patientId: "VERIFY-roi", patientName: "VERIFY^roi", seriesDescription: "spleen_56" }),
    });
    const j = (await r.json()) as { studyInstanceUid: string; seriesInstanceUid: string; error?: string };
    if (!r.ok || j.error) throw new Error(`取り込みに失敗: ${JSON.stringify(j)}`);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });

    const v = await openViewer(driver, page, j.studyInstanceUid, j.seriesInstanceUid);
    await v.getByTestId("monai-bundle").selectOption("vista3d");

    // 点 ROI ツールを選ぶ
    await v.getByTestId("viewer2d-menu-roi").click();
    await v.getByRole("button", { name: /^(✓ )?(点 ROI|Point ROI)$/ }).first().click();
    await v.waitForTimeout(300);

    const dims = await v.getByTestId("dim-slider-z").evaluate((el) => ({ min: Number((el as HTMLInputElement).min), max: Number((el as HTMLInputElement).max) }));
    const box = await v.getByTestId(HOST).evaluate((el) => ({ w: el.clientWidth, h: el.clientHeight }));
    // 3 枚のスライス × 4 点。点は体の内側（画面中央付近）に散らして、画素値に差が出るようにする
    const slices = [0.3, 0.5, 0.7].map((f) => Math.round(dims.min + (dims.max - dims.min) * f));
    const spots = [[0.4, 0.4], [0.6, 0.4], [0.4, 0.6], [0.6, 0.6]];
    // 1 点ずつ置いては読む（新しく増えた ROI と新しく増えた行を対応させる）
    const viewerValues: (number | null)[] = [];
    const lines: string[] = [];
    const seenUids = new Set<string>();
    const seenLines = new Set<string>();
    let placed = 0;
    for (const z of slices) {
      await v.getByTestId("dim-slider-z").fill(String(z));
      await v.waitForTimeout(900);
      for (const [fx, fy] of spots) {
        const pointBtn = v.getByRole("button", { name: /^(✓ )?(点 ROI|Point ROI)$/ }).first();
        if (!(await pointBtn.isVisible())) await v.getByTestId("viewer2d-menu-roi").click();
        if (!(await pointBtn.isVisible({ timeout: 3000 }).catch(() => false))) {
          await v.screenshot({ path: path.join(OUT_DIR, "debug-menu.png") });
          console.log("  見えるボタン:", JSON.stringify(await v.getByRole("button").allTextContents()));
        }
        await pointBtn.click();
        await v.waitForTimeout(250);
        await clickCanvas(v, Math.round(box.w * fx), Math.round(box.h * fy));
        placed++;
        // ROI は累積する（全消去は効かなかった）ので、新しく増えた 1 つを uid と行の差で特定する
        const rows = (await v.evaluate(`window.__graphyDebug.getRoiStatsPair()`)) as Array<{ uid: string; byUidMean: number | null }>;
        const fresh = rows.filter((r) => !seenUids.has(r.uid));
        check(fresh.length === 1 && rows.length === placed, `点 ${placed}: ROI が 1 つ増える`, { rows: rows.length, fresh: fresh.length });
        fresh.forEach((r) => seenUids.add(r.uid));
        viewerValues.push(fresh[0]?.byUidMean ?? null);
        // 最初の loadVolume は時間がかかる。行が ROI の数になるまで、ボタンを押し直しながら待つ（最大 20 秒）
        let t: string[] = [];
        for (let w = 0; w < 10 && t.length < placed; w++) {
          await v.getByTestId("monai-points").fill("");
          await v.getByTestId("monai-points-from-rois").click();
          await v.waitForTimeout(2000);
          t = (await v.getByTestId("monai-points").inputValue()).trim().split("\n").filter(Boolean);
        }
        const added = t.filter((l) => !seenLines.has(l));
        check(t.length === placed && added.length === 1, `点 ${placed}: ボタンで ROI の数だけ行が出て、新しい行が 1 つ`, { lines: t.length, added: added.length });
        added.forEach((l) => seenLines.add(l));
        lines.push(added[0] ?? "");
      }
    }
    console.log(`  ビューアの値: ${JSON.stringify(viewerValues)}`);
    console.log(`  入力欄:\n    ${lines.join("\n    ")}`);
    await v.screenshot({ path: path.join(OUT_DIR, "roi-button.png") });
    const text = lines.join("\n");

    const truth = probe(text);
    console.log(`  NIfTI の値: ${JSON.stringify(truth)}`);
    const match = (a: (number | null)[], b: (number | null)[]) => a.filter((x, i) => x != null && b[i] != null && Math.abs(x - (b[i] as number)) < 0.5).length;
    const good = match(viewerValues, truth);
    // ビューアが値を返さない点（体の外など）は比べられないので分母から外し、数を表示する
    const comparable = viewerValues.filter((x) => x != null).length;
    console.log(`  比べられる点: ${comparable}/${placed}`);
    check(comparable >= Math.ceil(placed * 0.8), "ビューアが値を返す点が十分ある（比べる相手がある）", viewerValues);
    check(good >= Math.ceil(comparable * 0.9), `画面の値と NIfTI の値が一致する（${good}/${comparable}）`);
    for (const [flag, name] of [["--flip-z", "z 反転"], ["--swap-xy", "x と y の入れ替え"]] as const) {
      const bad = match(viewerValues, probe(text, flag));
      console.log(`  負例 ${name}: 一致 ${bad}/${placed}`);
      check(bad <= Math.floor(comparable * 0.5), `負例（${name}）では一致率が落ちる`, { bad, placed });
    }
  } finally {
    await driver.stop().catch(() => {});
  }
  summary();
}

main().catch((e) => { console.error(e); process.exit(1); });
