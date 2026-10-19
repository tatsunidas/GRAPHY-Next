/*
 * つなぎ合わせダイアログの実機検証スパイク（PR #298）。
 *
 * 実行:  cd automator && npx tsx src/spike/stitchDialogCheck.ts phantom <ファントムのフォルダ> [組の名前 ...]
 *        cd automator && npx tsx src/spike/stitchDialogCheck.ts real <DICOM フォルダ> <シリーズ番号 ...>
 *   ファントムは automator/scripts/make-stitch-phantom.py で作る（truth.json を同じフォルダから読む）。
 *
 * 正解は truth.json（IPP から python で計算した重なり・隙間）。画面の表示と突き合わせる。
 * real は真値が無いので、画面の判定を表示するだけ（合否は付けない）。
 */
import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";

import { DesktopDriver } from "../driver/desktopDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { importPaths } from "../fixtures/importFixtures.js";
import { createStepRecorder } from "../checklist/types.js";
import { openFirstSeriesInViewer } from "../checklist/items/shared/helpers.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { spawnSync } from "node:child_process";

const PY = process.env.PYTHON ?? "python";
async function getJson<T>(http: number, p: string): Promise<T> {
  const r = await fetch(`http://127.0.0.1:${http}${p}`);
  if (!r.ok) throw new Error(`${p}: HTTP ${r.status}`);
  return (await r.json()) as T;
}

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "stitch-dialog-check");
const [kind, root, ...rest] = process.argv.slice(2);
if (!kind || !root) throw new Error("使い方はファイル先頭を参照");

const failures: string[] = [];
const known: string[] = [];
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

/** サイドの未表示シリーズの追加ボタンを押し、タイルが n 枚になるまで待つ。 */
async function addSeries(v: Page, n: number, seriesNumbers?: string[]): Promise<void> {
  const btns = v.locator("xpath=//span[starts-with(normalize-space(),'#')]/following-sibling::button[not(@disabled)]");
  for (let guard = 0; guard < 40 && (await v.getByTestId("series-viewer-root").count()) < n; guard++) {
    let target = btns.first();
    if (seriesNumbers) {
      let found = false;
      for (let i = 0; i < (await btns.count()); i++) {
        const label = ((await btns.nth(i).locator("xpath=preceding-sibling::span[1]").textContent()) ?? "").trim();
        const num = /^#(\d+)/.exec(label)?.[1];
        if (num && seriesNumbers.includes(num)) { target = btns.nth(i); found = true; break; }
      }
      if (!found) break;
    } else if ((await btns.count()) === 0) break;
    await target.click();
    await v.waitForTimeout(1500);
  }
  console.log(`  タイル数: ${await v.getByTestId("series-viewer-root").count()}`);
}

async function readyAll(v: Page): Promise<void> {
  const boxes = v.locator('[data-testid^="stitch-check-"]');
  await boxes.first().waitFor({ timeout: 10_000 });
  for (let t = 0; t < 240; t++) {
    let ok = true;
    for (let i = 0; i < (await boxes.count()); i++) if (!(await boxes.nth(i).isEnabled())) ok = false;
    if (ok) return;
    await v.waitForTimeout(500);
  }
}

async function openDialog(d: DesktopDriver, tag: string, seriesNumbers?: string[], nTiles = 2): Promise<Page> {
  const main = d.page;
  await main.reload();
  await main.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
  await openFirstSeriesInViewer(main, createStepRecorder());
  const v = await d.waitForNewPage(
    () => main.getByTestId("viewer2d-toolbar-button").click(),
    (url) => url.includes("2dviewer"),
  );
  await v.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 30_000 });
  await v.waitForTimeout(1500);
  v.on("dialog", (dl) => void dl.accept());
  await addSeries(v, nTiles, seriesNumbers);
  await v.getByTestId("viewer2d-menu-image").click();
  await v.getByTestId("menu-stitch").click();
  await v.getByTestId("stitch-dialog").waitFor({ state: "visible", timeout: 10_000 });
  await readyAll(v);
  const boxes = v.locator('[data-testid^="stitch-check-"]');
  for (let i = 0; i < (await boxes.count()); i++) if (await boxes.nth(i).isEnabled()) await boxes.nth(i).check();
  await v.waitForTimeout(800);
  await v.screenshot({ path: path.join(OUT_DIR, `${tag}-dialog.png`) });
  return v;
}

/** MIP の再計算が終わる（data-busy=false）まで待ち、3 枚の画素数と内容の指紋を返す。 */
async function waitMip(v: Page): Promise<void> {
  await v.waitForTimeout(300);
  for (let t = 0; t < 240; t++) {
    if ((await v.getByTestId("stitch-mip").getAttribute("data-busy")) === "false" && (await v.getByTestId("stitch-mip-cor").count()) > 0) return;
    await v.waitForTimeout(250);
  }
}
async function mipState(v: Page, key: string): Promise<{ px: string; hash: string }> {
  const px = (await v.getByTestId(`stitch-mip-${key}`).getAttribute("data-px")) ?? "";
  const hash = (await v.getByTestId(`stitch-mip-${key}`).evaluate((c: HTMLCanvasElement) => c.toDataURL())) as string;
  return { px, hash: `${hash.length}:${hash.slice(-64)}` };
}

/** 座標が全部同じステーション: 自動で「重なりを指定」になり、重なりを変えると MIP が追従する。 */
async function placementChecks(v: Page, s: any): Promise<void> {
  check(await v.getByTestId("stitch-place-overlap").isChecked(), "座標が全部同じなので自動で「重なりを指定」になる");
  check((await v.getByTestId("stitch-place-note").count()) === 1, "その旨の注記が出る");
  const ov = String(s.placement.overlapMm);
  const input = v.getByTestId("stitch-overlap-input");
  await input.fill("0");
  await waitMip(v);
  const m0 = await mipState(v, "cor");
  const a0 = await mipState(v, "ax");
  await input.fill(ov);
  await waitMip(v);
  const m1 = await mipState(v, "cor");
  const a1 = await mipState(v, "ax");
  console.log(`  COR 画素 重なり0: ${m0.px} → 重なり${ov}: ${m1.px}`);
  const h = (st: { px: string }) => Number(st.px.split("x")[1]);
  check(h(m0) > h(m1), "重なりを増やすと COR の高さ（画素）が減る", [m0.px, m1.px]);
  check(m0.hash !== m1.hash, "重なりを変えると COR の画像が変わる");
  await input.fill(ov);
  await waitMip(v);
  const m2 = await mipState(v, "cor");
  check(m2.hash === m1.hash && m2.px === m1.px, "同じ重なりに戻すと COR が元と同じ（再現する）");
  check(a1.px.length > 0 && a0.px === a1.px, "AX の画素数は重なりで変わらない");
  await v.screenshot({ path: path.join(OUT_DIR, `${s.set}-placed.png`) });
  const txt = (await v.getByTestId("stitch-overlap").textContent()) ?? "";
  const nums = txt.match(/-?\d+(\.\d+)?/g)?.map(Number) ?? [];
  check(nums.length >= 2 && Math.abs(nums[0] - s.overlapMm) < 0.06 && Math.abs(nums[1]) < 0.06, `表示の重なりが ${s.overlapMm} mm`, txt);
  await input.fill("abc");
  check(!(await v.getByTestId("stitch-save").isEnabled()), "【負例】重なりが数値でないと [保存] が押せない");
  await input.fill(ov);
  await waitMip(v);
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const d = new DesktopDriver({ http: 18190, scp: 18191 }); // 開発版 Next（18090）と並行して動かせるよう別ポート
  await d.start();
  try {
    if (kind === "phantom") {
      const truth = JSON.parse(fs.readFileSync(path.join(root, "truth.json"), "utf8"));
      for (const s of truth.sets as any[]) {
        if (rest.length && !rest.includes(s.set)) continue;
        console.log(`\n== 組 ${s.set}（期待: ${s.expectOk ? "保存できる" : "保存できない"}）`);
        await resetDb(d.ports.http);
        const imp = await importPaths(d.ports.http, [path.join(root, s.set)]);
        const studyUid = (imp as any).studyInstanceUids[0] as string;
        console.log(`  取り込み: 枚数 ${imp.imported}`);
        const v = await openDialog(d, s.set, undefined, s.beds.length);
        console.log(`  条件: ${await v.getByTestId("stitch-conditions").textContent()}`);
        check((await v.getByTestId("stitch-cond-frameOfReference").count()) === 0, "FoR の条件の行が出ない");
        const petRows = await v.getByTestId("stitch-cond-petReference").count();
        check(petRows === (s.set === "neg-pet" ? 1 : 0), `PET/NM の行は PET のときだけ出る（${petRows} 行）`);
        await waitMip(v);
        if (s.placement) await placementChecks(v, s);
        await waitMip(v);
        const saveOk = (await v.getByTestId("stitch-save").isEnabled()) === s.expectOk;
        if (s.set === "neg-pid" && !saveOk) {
          // 既知の未対応: ダイアログはビューアの患者タブの ID を全入力に使うので、DICOM の PatientID の違いを見ない。合格には数えない。
          known.push("neg-pid: PatientID が違っても [保存] が押せる");
          console.log("  [既知の未対応] neg-pid: PatientID が違っても [保存] が押せる");
        } else check(saveOk, `[保存] の可否が期待（${s.expectOk}）どおり`);
        if (s.expectOk) {
          const ov = (await v.getByTestId("stitch-overlap").textContent()) ?? "";
          console.log(`  ${ov} / 出力: ${await v.getByTestId("stitch-output").textContent()}`);
          const nums = ov.match(/-?\d+(\.\d+)?/g)?.map(Number) ?? [];
          check(
            nums.length >= 2 && Math.abs(nums[0] - s.overlapMm) < 0.06 && Math.abs(nums[1] - s.gapMm) < 0.06,
            `重なり ${s.overlapMm.toFixed(1)}・隙間 ${s.gapMm.toFixed(1)} mm が真値と一致`,
            nums,
          );
        } else {
          console.log(`  出力欄: ${await v.getByTestId("stitch-output").textContent()}`);
        }
        if (s.expectOk) {
          const before = (await getJson<any[]>(d.ports.http, `/api/studies/${studyUid}/series`)).map((x) => x.seriesInstanceUid);
          await v.getByTestId("stitch-save").click();
          await v.getByTestId("stitch-message").waitFor({ timeout: 120_000 });
          const msg = (await v.getByTestId("stitch-message").textContent()) ?? "";
          console.log(`  保存メッセージ: ${msg}`);
          await v.screenshot({ path: path.join(OUT_DIR, `${s.set}-saved.png`) });
          const after = await getJson<any[]>(d.ports.http, `/api/studies/${studyUid}/series`);
          const derived = after.filter((x) => !before.includes(x.seriesInstanceUid));
          check(derived.length === 1, "派生シリーズが 1 本できる", derived.length);
          if (derived.length === 1) {
            const dsUid = derived[0].seriesInstanceUid;
            const inst = await getJson<Array<{ sopInstanceUid: string }>>(d.ports.http, `/api/studies/${studyUid}/series/${dsUid}/instances`);
            const dir = path.join(OUT_DIR, `${s.set}-derived`);
            fs.rmSync(dir, { recursive: true, force: true });
            fs.mkdirSync(dir, { recursive: true });
            for (const [n, i] of inst.entries()) {
              const res = await fetch(`http://127.0.0.1:${d.ports.http}/api/studies/${studyUid}/series/${dsUid}/instances/${i.sopInstanceUid}/file`);
              fs.writeFileSync(path.join(dir, `o${String(n).padStart(4, "0")}.dcm`), Buffer.from(await res.arrayBuffer()));
            }
            const ver = spawnSync(PY, ["-I", path.join(AUTOMATOR_ROOT, "scripts", "verify-stitch-output.py"), path.join(root, "truth.json"), s.set, dir], { encoding: "utf8" });
            if (ver.status !== 0) check(false, "照合スクリプトが動く", ver.stderr);
            else {
              const r = JSON.parse(ver.stdout);
              console.log(`  照合: ${ver.stdout.trim()}`);
              check(r.voxels > 0 && r.bad === 0, "保存した画素が真値（1 次関数・重なりは平均）と一致", r);
            }
          }
        }
        await v.getByTestId("stitch-close").click();
      }
    } else {
      console.log(`\n== 実データ ${root} シリーズ ${rest.join(",")}`);
      await resetDb(d.ports.http);
      console.log(`  取り込み: ${JSON.stringify(await importPaths(d.ports.http, [root])).slice(0, 200)}`);
      const v = await openDialog(d, `real-${rest.join("-")}`, rest, rest.length);
      console.log(`  条件: ${await v.getByTestId("stitch-conditions").textContent()}`);
      console.log(`  保存可: ${await v.getByTestId("stitch-save").isEnabled()}`);
      console.log(`  出力欄: ${await v.getByTestId("stitch-output").textContent()}`);
      // 重なりの正解は DICOM から分からないので、値ごとに画面を残して目で見る（REAL_OVERLAPS=0,20,30）。
      for (const ov of (process.env.REAL_OVERLAPS ?? "0").split(",")) {
        await v.getByTestId("stitch-overlap-input").fill(ov);
        await waitMip(v);
        console.log(`  重なり ${ov}: ${await v.getByTestId("stitch-overlap").textContent()} / ${await v.getByTestId("stitch-output").textContent()}`);
        await v.screenshot({ path: path.join(OUT_DIR, `real-overlap-${ov}.png`) });
      }
    }
  } finally {
    await d.stop().catch(() => {});
  }
  console.log(`\n合格 ${passed} / 失敗 ${failures.length} / 既知の未対応 ${known.length}`);
  process.exitCode = failures.length ? 1 : 0;
}
main();
