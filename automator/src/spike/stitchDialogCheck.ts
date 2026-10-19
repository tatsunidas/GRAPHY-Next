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
import os from "node:os";
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
/** 並びを bed1, bed2, ... の順に手で直す（どのステーションも同じ内容の合成データでは、端の一致度では順序が決まらない）。 */
async function forceOrder(v: Page, s: any): Promise<void> {
  const names = async () => (await v.getByTestId("stitch-order").locator("span").allTextContents()).map((t) => t.replace(/^\d+\.\s*/, ""));
  for (let t = 0; t < 40 && (await v.getByTestId("stitch-match").count()) === 0 && (await v.getByTestId("stitch-match-busy").count()) > 0; t++) await v.waitForTimeout(250);
  for (let i = 0; i < s.beds.length; i++) {
    const want = `${s.set} bed${i + 1}`;
    let cur = await names();
    for (let g = 0; g < 10 && cur[i] !== want; g++) {
      const j = cur.indexOf(want);
      await v.getByTestId(`stitch-up-${j}`).click();
      await v.waitForTimeout(300);
      cur = await names();
    }
  }
  await waitMip(v);
}

async function placementChecks(v: Page, s: any): Promise<void> {
  await forceOrder(v, s);
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

/** [保存] を押し、新しくできた派生シリーズをフォルダへ取り出して返す（できなければ null）。 */
async function saveAndDownload(v: Page, d: DesktopDriver, studyUid: string, tag: string): Promise<string | null> {
  const before = (await getJson<any[]>(d.ports.http, `/api/studies/${studyUid}/series`)).map((x) => x.seriesInstanceUid);
  await v.getByTestId("stitch-save").click();
  await v.getByTestId("stitch-message").filter({ hasText: /\d+/ }).waitFor({ timeout: 120_000 });
  console.log(`  保存メッセージ(${tag}): ${await v.getByTestId("stitch-message").textContent()}`);
  await v.screenshot({ path: path.join(OUT_DIR, `${tag}-saved.png`) });
  const after = await getJson<any[]>(d.ports.http, `/api/studies/${studyUid}/series`);
  const derived = after.filter((x) => !before.includes(x.seriesInstanceUid));
  check(derived.length === 1, `派生シリーズが 1 本できる（${tag}）`, derived.length);
  if (derived.length !== 1) return null;
  const dsUid = derived[0].seriesInstanceUid;
  const inst = await getJson<Array<{ sopInstanceUid: string }>>(d.ports.http, `/api/studies/${studyUid}/series/${dsUid}/instances`);
  const dir = path.join(OUT_DIR, `${tag}-derived`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const [n, i] of inst.entries()) {
    const res = await fetch(`http://127.0.0.1:${d.ports.http}/api/studies/${studyUid}/series/${dsUid}/instances/${i.sopInstanceUid}/file`);
    fs.writeFileSync(path.join(dir, `o${String(n).padStart(4, "0")}.dcm`), Buffer.from(await res.arrayBuffer()));
  }
  return dir;
}

/** DICOM タグ（IOP・IPP・間隔・ピクセル間隔・識別子）の照合結果を数える。 */
function reportTags(out: string, status: number | null, err: string, tag: string): void {
  if (status !== 0) { check(false, `タグの照合スクリプトが動く（${tag}）`, err); return; }
  const r = JSON.parse(out) as { checks: Array<[string, boolean, string]>; pass: number; fail: number };
  console.log(`  タグ照合(${tag}): ${r.pass} 合格 / ${r.fail} 失敗`);
  for (const [name, ok, detail] of r.checks) if (!ok) check(false, `タグ: ${name}（${tag}）`, detail);
  check(r.fail === 0 && r.pass > 0, `保存したタグが期待どおり（${tag}・${r.pass} 項目）`);
}

/** [保存] を押し、新しくできた派生シリーズの画素を真値（blend・gains の期待値）と、DICOM タグを入力側の値と照合する。 */
async function saveAndVerify(v: Page, d: DesktopDriver, s: any, studyUid: string, blend: "linear" | "mean", gains: boolean, tag: string): Promise<void> {
  const dir = await saveAndDownload(v, d, studyUid, tag);
  if (!dir) return;
  const tg = spawnSync(PY, ["-I", path.join(AUTOMATOR_ROOT, "scripts", "verify-stitch-tags.py"), "phantom", path.join(root, "truth.json"), s.set, dir], { encoding: "utf8" });
  reportTags(tg.stdout, tg.status, tg.stderr, tag);
  const args = ["-I", path.join(AUTOMATOR_ROOT, "scripts", "verify-stitch-output.py"), path.join(root, "truth.json"), s.set, dir, blend];
  if (gains) args.push("gains");
  const ver = spawnSync(PY, args, { encoding: "utf8" });
  if (ver.status !== 0) { check(false, `照合スクリプトが動く（${tag}）`, ver.stderr); return; }
  const r = JSON.parse(ver.stdout);
  console.log(`  照合(${tag}): ${ver.stdout.trim()}`);
  check(r.voxels > 0 && r.bad === 0, `保存した画素が真値（${blend}${gains ? "・信号合わせ" : ""}）と一致（${tag}）`, r);
}

/** 端の一致度: 自動で正しい並び順・重なりになり、手で並べ替えた後は上書きされない。 */
async function matchChecks(v: Page, s: any): Promise<void> {
  const names = async () => (await v.getByTestId("stitch-order").locator("span").allTextContents()).map((t) => t.replace(/^\d+\.\s*/, ""));
  for (let t = 0; t < 40 && (await v.getByTestId("stitch-match").count()) === 0; t++) await v.waitForTimeout(250);
  const expectNames = (s.expectedOrder as number[]).map((i) => `${s.set} bed${i + 1}`);
  const got = await names();
  console.log(`  自動の並び: ${got.join(" → ")}（期待 ${expectNames.join(" → ")}）`);
  check(JSON.stringify(got) === JSON.stringify(expectNames), "端の一致度で並び順が自動で正しくなる（シリーズ番号の順ではない）", got);
  const ovText = await v.getByTestId("stitch-overlap-input").inputValue();
  check(Math.abs(Number(ovText) - s.placement.overlapMm) < 0.06, `重なりの初期値が推定値（${s.placement.overlapMm} mm）になる`, ovText);
  for (const n of [0, 1]) {
    const pair = v.getByTestId(`stitch-match-pair-${n}`);
    const score = Number(await pair.getAttribute("data-score"));
    const ov = Number(await pair.getAttribute("data-overlap"));
    check(score > 0.9 && Math.abs(ov - s.placement.overlapMm) < 0.06, `組 ${n + 1} の一致度 ${score}・重なり ${ov} mm`, [score, ov]);
  }
  await v.screenshot({ path: path.join(OUT_DIR, `${s.set}-match.png`) });
  // 手で並べ替えたら、その順が保たれる（自動で上書きされない）
  await v.getByTestId("stitch-down-0").click();
  await v.waitForTimeout(1500);
  const manual = await names();
  check(manual[0] === got[1] && manual[1] === got[0], "手で並べ替えた順が保たれる（上書きされない）", manual);
  await v.getByTestId("stitch-up-1").click(); // 元に戻す
  await v.waitForTimeout(500);
  check(JSON.stringify(await names()) === JSON.stringify(got), "元の順に戻せる");
}

/** 重なりの指定「組ごと」: 既定は共通・切替直後は結果が同じ・組ごとの値がそのまま出力の長さに出る・不正値で保存できない。 */
async function perPairChecks(v: Page, d: DesktopDriver, s: any, studyUid: string, truth: any): Promise<void> {
  const total = async () => {
    const nums = ((await v.getByTestId("stitch-overlap").textContent()) ?? "").match(/-?\d+(\.\d+)?/g)?.map(Number) ?? [];
    return nums;
  };
  const dz = truth.spacingMm.slice as number, nz = truth.slices as number, nb = s.beds.length as number;
  check(await v.getByTestId("stitch-scope-common").isChecked(), "【組ごと】既定は「共通」");
  check((await v.getByTestId("stitch-pair-input-0").count()) === 0, "【組ごと】共通のときは組ごとの欄が出ない");
  const before = await total();
  await v.getByTestId("stitch-scope-pair").check();
  await waitMip(v);
  const vals = [] as string[];
  for (let i = 0; i < nb - 1; i++) vals.push(await v.getByTestId(`stitch-pair-input-${i}`).inputValue());
  check(vals.length === nb - 1 && vals.every((x) => Number(x) === s.placement.overlapMm), "【組ごと】切替直後は各組が共通の値で初期化される", vals);
  const same = await total();
  check(same[0] === before[0] && same[1] === before[1], "【組ごと】切替直後は重なり・隙間が変わらない", [before, same]);
  // 8 mm と 4 mm: 合計 12 mm。出力の枚数 = (全長 − 12) / DZ
  await v.getByTestId("stitch-pair-input-0").fill("8");
  await v.getByTestId("stitch-pair-input-1").fill("4");
  await waitMip(v);
  const t1 = await total();
  check(Math.abs(t1[0] - 12) < 0.06 && Math.abs(t1[1]) < 0.06, "【組ごと】組ごとの重なりの合計（8+4=12 mm）が表示される", t1);
  const dir = await saveAndDownload(v, d, studyUid, `${s.set}-pair`);
  if (dir) {
    const n = fs.readdirSync(dir).filter((f) => f.endsWith(".dcm")).length;
    const exp = (nb * nz * dz - 12) / dz;
    check(Math.abs(n - exp) < 0.51, `【組ごと】保存した枚数が期待（${exp}）どおり`, n);
  }
  await v.getByTestId("stitch-pair-input-1").fill("-4");
  await waitMip(v);
  const t2 = await total();
  check(Math.abs(t2[0] - 8) < 0.06 && Math.abs(t2[1] - 4) < 0.06, "【組ごと】負の値はその組だけ隙間（8 mm 重なり・4 mm 隙間）", t2);
  await v.getByTestId("stitch-pair-input-1").fill("abc");
  check(!(await v.getByTestId("stitch-save").isEnabled()), "【負例】組ごとの欄が数値でないと [保存] が押せない");
  await v.getByTestId("stitch-pair-input-1").fill("8");
  await v.getByTestId("stitch-scope-common").check();
  await waitMip(v);
  const back = await total();
  check(back[0] === before[0] && back[1] === before[1], "【組ごと】「共通」に戻すと共通の値（8 mm）の結果に戻る", [before, back]);
}

/** 位置合わせ後の出力を align 真値と照合する（2 本目だけが覆う位置の相対 RMS）。 */
function alignRms(dir: string, setName: string): { rel2: number; rel1: number; alignmentRecorded: boolean; voxels2: number; seriesDescription: string; pixelSpacing: number[]; spacingBetweenSlices: number | null; iop: number[] } | null {
  const r = spawnSync(PY, ["-I", path.join(AUTOMATOR_ROOT, "scripts", "verify-stitch-align.py"), path.join(root, "truth.json"), setName, dir], { encoding: "utf8" });
  if (r.status !== 0) { check(false, `位置合わせの照合スクリプトが動く（${setName}）`, r.stderr); return null; }
  console.log(`  位置合わせ照合: ${r.stdout.trim().slice(0, 400)}`);
  return JSON.parse(r.stdout);
}

async function waitAlignIdle(v: Page): Promise<void> {
  await v.waitForTimeout(400);
  for (let t = 0; t < 240; t++) {
    const busy = await v.getByTestId("align-check").getAttribute("data-busy");
    const ncc = await v.getByTestId("align-check-ncc").getAttribute("data-ncc");
    if (busy === "false" && ncc !== null && (await v.getByTestId("align-check-cor").count()) > 0) return;
    await v.waitForTimeout(250);
  }
}
async function nccNow(v: Page): Promise<number> {
  await waitAlignIdle(v);
  return Number((await v.getByTestId("align-check-ncc").getAttribute("data-ncc")) || "NaN");
}

/** 位置合わせ: 既知のずれの内容を、自動・手動で戻し、保存した画素が真値に一致する。負例（ずれたまま）と対で見る。 */
async function alignChecks(v: Page, d: DesktopDriver, s: any, studyUid: string): Promise<void> {
  const tag = s.set;
  await v.getByTestId("stitch-align-toggle").click();
  await v.getByTestId("stitch-align").waitFor({ timeout: 5000 });
  const rows = v.locator('[data-testid^="align-row-"]');
  check((await rows.count()) === 2, "【位置合わせ】シリーズごとの行が出る", await rows.count());
  const row1 = rows.filter({ hasText: `${tag} bed1` });
  const row2 = rows.filter({ hasText: `${tag} bed2` });
  const mk = row1.locator('[data-testid^="align-make-ref-"]');
  if ((await mk.count()) > 0) await mk.click();
  const id2 = ((await row2.getAttribute("data-testid")) ?? "").replace("align-row-", "");
  check((await v.getByTestId(`align-ref-${(((await row1.getAttribute("data-testid")) ?? "").replace("align-row-", ""))}`).count()) === 1, "【位置合わせ】bed1 が基準になる");
  check((await v.getByTestId(`align-make-ref-${id2}`).count()) === 1 && (await v.getByTestId(`align-tx-${id2}`).count()) === 1, "【位置合わせ】基準以外には入力欄がある");
  const before = await nccNow(v);
  console.log(`  ずれたままの重なりの相関: ${before}`);
  await v.screenshot({ path: path.join(OUT_DIR, `${tag}-align-before.png`) });
  await v.getByTestId("align-check").screenshot({ path: path.join(OUT_DIR, `${tag}-overlay-before.png`) });
  const dirNeg = await saveAndDownload(v, d, studyUid, `${tag}-unaligned`);
  const neg = dirNeg ? alignRms(dirNeg, tag) : null;
  if (neg) check(neg.rel2 > 0.3 && !neg.alignmentRecorded, "【負例】ずれたまま保存すると 2 本目の値は真値から大きく外れる（位置合わせの記述なし）", neg);
  // 自動
  const rotSet = Math.abs(s.align.rotz) > 0;
  await v.getByTestId(rotSet ? "align-auto-rigid" : "align-auto-translation").check();
  await v.getByTestId("align-auto-run").click();
  await v.getByTestId("align-auto-result").waitFor({ timeout: 180_000 });
  for (let t = 0; t < 240 && (await v.getByTestId("align-auto-run").isDisabled()); t++) await v.waitForTimeout(500);
  const kind = await v.getByTestId("align-auto-result").locator("[data-kind]").first().getAttribute("data-kind");
  check(kind === "applied", "【位置合わせ】自動で合わせると「適用」になる", kind);
  const field = async (k: string) => Number(await v.getByTestId(`align-${k}-${id2}`).inputValue());
  const [tx, ty, tz, rz] = [await field("tx"), await field("ty"), await field("tz"), await field("rz")];
  console.log(`  自動の結果: t=(${tx}, ${ty}, ${tz}) rz=${rz}`);
  if (!rotSet) {
    const e = s.align.t as number[];
    check(Math.abs(tx + e[0]) < 0.8 && Math.abs(ty + e[1]) < 0.8 && Math.abs(tz + e[2]) < 0.8, "【位置合わせ】自動の平行移動が、与えたずれの逆", [tx, ty, tz]);
    check(rz === 0, "【位置合わせ】「平行移動のみ」では回転しない", rz);
  } else {
    check(Math.abs(rz + s.align.rotz) < 1.0, "【位置合わせ】自動の回転が、与えたずれの逆（z まわり）", rz);
  }
  const after = await nccNow(v);
  check(after > 0.99 && after > before + 0.02, "【位置合わせ】重なりの相関が上がって 0.99 を超える", [before, after]);
  await v.screenshot({ path: path.join(OUT_DIR, `${tag}-align-after.png`) });
  await v.getByTestId("align-check").screenshot({ path: path.join(OUT_DIR, `${tag}-overlay-after.png`) });
  const dirOk = await saveAndDownload(v, d, studyUid, `${tag}-aligned`);
  const ok = dirOk ? alignRms(dirOk, tag) : null;
  if (ok) check(ok.rel2 < (rotSet ? 0.25 : 0.12) && ok.alignmentRecorded, `【位置合わせ】合わせて保存した 2 本目の値が真値に一致（相対 RMS ${ok.rel2.toFixed(3)}）し、記述が残る`, ok);
  if (neg && ok) check(ok.rel2 < neg.rel2 / 3, "【位置合わせ】合わせた方が、ずれたままより誤差が 1/3 未満", [neg.rel2, ok.rel2]);
  if (rotSet) return;
  // 手動: リセット → 逆のずれを欄に入れる
  await v.getByTestId("align-reset-all").click();
  const back = await nccNow(v);
  check(Math.abs(back - before) < 1e-3, "【位置合わせ】リセットでずれたままに戻る", [before, back]);
  const e = s.align.t as number[];
  await v.getByTestId(`align-tx-${id2}`).fill(String(-e[0]));
  await v.getByTestId(`align-ty-${id2}`).fill(String(-e[1]));
  await v.getByTestId(`align-tz-${id2}`).fill(String(-e[2]));
  const man = await nccNow(v);
  check(man > 0.999, "【位置合わせ】手で逆のずれを入れると相関がほぼ 1", man);
  await v.getByTestId(`align-tx-${id2}-plus`).click();
  const off = await nccNow(v);
  check(off < man - 0.003, "【位置合わせ】＋ボタンで 1 mm 動かすと相関が下がる（操作が効いている）", [man, off]);
  await v.getByTestId(`align-tx-${id2}-minus`).click();
  // 反転・拡大の警告と不正値
  await v.getByTestId(`align-flipX-${id2}`).check();
  check((await v.getByTestId(`align-warn-flip-${id2}`).count()) === 1, "【位置合わせ】反転を指定すると警告が出る");
  await v.getByTestId(`align-flipX-${id2}`).uncheck();
  check((await v.getByTestId(`align-warn-flip-${id2}`).count()) === 0, "【位置合わせ】反転を外すと警告が消える");
  await v.getByTestId(`align-s-${id2}`).fill("0");
  await v.waitForTimeout(300);
  check(!(await v.getByTestId("stitch-save").isEnabled()), "【負例】拡大率が 0 だと [保存] が押せない");
  await v.getByTestId(`align-s-${id2}`).fill("120");
  await v.waitForTimeout(300);
  check((await v.getByTestId(`align-warn-scale-${id2}`).count()) === 1, "【位置合わせ】拡大率が 5% を超えると警告が出る");
  await v.screenshot({ path: path.join(OUT_DIR, `${tag}-align-warn.png`) });
}

/** 基準シリーズの引き継ぎ: 基準を選ばない間は従来どおり、明示すると出力の間隔・向き・説明（属性）が基準のものになる。 */
async function refInheritChecks(v: Page, d: DesktopDriver, s: any, studyUid: string): Promise<void> {
  const tag = s.set;
  await v.getByTestId("stitch-align-toggle").click();
  await v.getByTestId("stitch-align").waitFor({ timeout: 5000 });
  const rows = v.locator('[data-testid^="align-row-"]');
  const idOf = async (name: string) => (((await rows.filter({ hasText: `${tag} ${name}` }).getAttribute("data-testid")) ?? "").replace("align-row-", ""));
  const id1 = await idOf("bed1"), id2 = await idOf("bed2");
  const [col, row] = [truth0.spacingMm.col as number, truth0.spacingMm.row as number];
  // 既定: 基準を選ばない。基準でない側を 95% にしても、間隔は拡大前の最小値のまま・説明は最も手前（bed1）
  const moving = (await v.getByTestId(`align-ref-${id1}`).count()) === 1 ? id2 : id1;
  await v.getByTestId(`align-s-${moving}`).fill("95");
  await v.waitForTimeout(600);
  const outTxt = (await v.getByTestId("stitch-sp-col").inputValue()) + "/" + (await v.getByTestId("stitch-sp-row").inputValue());
  console.log(`  既定の出力の間隔欄: ${outTxt}`);
  check(Number(await v.getByTestId("stitch-sp-col").inputValue()) === col && Number(await v.getByTestId("stitch-sp-row").inputValue()) === row, "【基準】基準を選ばないとき、拡大しても出力の間隔は拡大前の最小値のまま", outTxt);
  const dA = await saveAndDownload(v, d, studyUid, `${tag}-ref-default`);
  const a = dA ? alignRms(dA, tag) : null;
  if (a) {
    check(a.seriesDescription.includes("bed1"), "【基準】基準を選ばないと、属性は最も手前のシリーズ（bed1）から引き継ぐ", a.seriesDescription);
    check(Math.abs(a.pixelSpacing[0] - row) < 1e-6 && Math.abs(a.pixelSpacing[1] - col) < 1e-6, "【基準】保存した PixelSpacing が拡大前の最小値", a.pixelSpacing);
  }
  // 明示: bed2 を基準にして bed1 を 95%
  if ((await v.getByTestId(`align-make-ref-${id1}`).count()) === 1) await v.getByTestId(`align-make-ref-${id1}`).click();
  await v.getByTestId(`align-make-ref-${id2}`).click(); // 明示的な選択（bed2 が基準）
  await v.getByTestId(`align-s-${id1}`).fill("95");
  await v.waitForTimeout(600);
  check((await v.getByTestId(`align-ref-${id2}`).count()) === 1, "【基準】bed2 を基準にできる");
  const dB = await saveAndDownload(v, d, studyUid, `${tag}-ref-bed2`);
  const b = dB ? alignRms(dB, tag) : null;
  if (b) {
    check(b.seriesDescription.includes("bed2"), "【基準】基準にした bed2 から属性（シリーズ名）を引き継ぐ", b.seriesDescription);
    check(Math.abs(b.pixelSpacing[0] - row) < 1e-6 && Math.abs(b.pixelSpacing[1] - col) < 1e-6 && b.pixelSpacing[1] !== col * 0.95, "【基準】bed1 を 95% にしても、PixelSpacing は基準（bed2）の元の値", b.pixelSpacing);
    check(b.spacingBetweenSlices !== null && Math.abs(b.spacingBetweenSlices - (truth0.spacingMm.slice as number)) < 1e-6, "【基準】スライス間隔も基準の元の値", b.spacingBetweenSlices);
    check(b.iop.every((x: number, i: number) => Math.abs(x - [1, 0, 0, 0, 1, 0][i]) < 1e-6), "【基準】IOP は基準の向き", b.iop);
  }
}

/** 向きが違う入力: 既定では結合できず、許可すると結合できる。 */
async function obliqueChecks(v: Page): Promise<void> {
  check((await v.getByTestId("stitch-orientation-hint").count()) === 1, "【向き】向きが違うと、位置合わせで許可できるという案内が出る");
  check(!(await v.getByTestId("stitch-save").isEnabled()), "【向き】既定では保存できない");
  await v.getByTestId("stitch-align-toggle").click();
  const rows = v.locator('[data-testid^="align-row-"]');
  check((await v.locator('[data-testid^="align-angle-"]').count()) >= 1, "【向き】基準との角度が出る");
  await v.getByTestId("align-oblique").check();
  await v.waitForTimeout(800);
  check(await v.getByTestId("stitch-save").isEnabled(), "【向き】向きの違いを許すと保存できる", await v.getByTestId("stitch-output").textContent());
  console.log(`  向き違いの出力欄: ${await v.getByTestId("stitch-output").textContent()} / 行 ${await rows.count()}`);
  await v.screenshot({ path: path.join(OUT_DIR, "oblique-allowed.png") });
  await v.getByTestId("align-oblique").uncheck();
  await v.waitForTimeout(500);
  check(!(await v.getByTestId("stitch-save").isEnabled()), "【向き】許可を外すとまた保存できない");
}

let truth0: any = null;
async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  if (kind === "phantom") truth0 = JSON.parse(fs.readFileSync(path.join(root, "truth.json"), "utf8"));
  const d = new DesktopDriver({ http: 18190, scp: 18191 }, { extraElectronArgs: process.env.STITCH_ELECTRON_ARGS ? process.env.STITCH_ELECTRON_ARGS.split(" ") : [] }); // 開発版 Next（18090）と並行して動かせるよう別ポート
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
        if (s.align) {
          await alignChecks(v, d, s, studyUid);
          await v.getByTestId("stitch-close").click();
          if (s.set === "align-shift") {
            const v2 = await openDialog(d, `${s.set}-ref`, undefined, 2);
            await refInheritChecks(v2, d, s, studyUid);
            await v2.getByTestId("stitch-close").click();
          }
          continue;
        }
        if (s.set === "neg-rot5") await obliqueChecks(v);
        if (s.set === "match3") await matchChecks(v, s);
        else if (s.placement) await placementChecks(v, s);
        if (s.set === "stations3") await perPairChecks(v, d, s, studyUid, truth);
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
          await saveAndVerify(v, d, s, studyUid, "linear", false, `${s.set}-linear`);
          if (s.set === "c") {
            // 重なりの扱いを「平均」に切り替えて保存し、平均の期待値と照合する（切替で結果が変わることも確かめる）。
            await v.getByTestId("stitch-blend-mean").check();
            await waitMip(v);
            await saveAndVerify(v, d, s, studyUid, "mean", false, `${s.set}-mean`);
            await v.getByTestId("stitch-blend-linear").check();
          }
          if (s.set === "gain") {
            await v.getByTestId("stitch-gain").check();
            await waitMip(v);
            const gl = v.getByTestId("stitch-gains").locator("[data-gain]");
            const got = [] as number[];
            for (let i = 0; i < (await gl.count()); i++) got.push(Number(await gl.nth(i).getAttribute("data-gain")));
            console.log(`  推定した倍率: ${got.join(", ")}`);
            const exp = s.beds.map((b: any) => b.gainExpected);
            check(got.length === exp.length && got.every((g, i) => Math.abs(g - exp[i]) < 2e-3), "推定した倍率が真値（1, 0.8）と一致", got);
            await saveAndVerify(v, d, s, studyUid, "linear", true, `${s.set}-gains`);
          }
        }
        await v.getByTestId("stitch-close").click();
      }
    } else {
      console.log(`\n== 実データ ${root} シリーズ ${rest.join(",")}`);
      await resetDb(d.ports.http);
      const impR = await importPaths(d.ports.http, [root]);
      console.log(`  取り込み: ${JSON.stringify(impR).slice(0, 200)}`);
      const v = await openDialog(d, `real-${rest.join("-")}`, rest, rest.length);
      console.log(`  条件: ${await v.getByTestId("stitch-conditions").textContent()}`);
      console.log(`  保存可: ${await v.getByTestId("stitch-save").isEnabled()}`);
      console.log(`  出力欄: ${await v.getByTestId("stitch-output").textContent()}`);
      // 端の一致度による自動判定の結果（並び順・重なり）
      for (let t = 0; t < 240 && (await v.getByTestId("stitch-match").count()) === 0; t++) await v.waitForTimeout(500);
      console.log(`  自動の並び: ${(await v.getByTestId("stitch-order").locator("span").allTextContents()).join(" → ")}`);
      console.log(`  端の一致度: ${(await v.getByTestId("stitch-match").textContent())?.replace(/\s+/g, " ")}`);
      console.log(`  重なり欄の初期値: ${await v.getByTestId("stitch-overlap-input").inputValue()} mm`);
      if (process.env.REAL_COORD) {
        // 「座標どおり」: 座標が全部同じ実データで何が起きるか（エラーになるのか、意味のない結果になるのか）を確かめる。
        await v.getByTestId("stitch-place-coord").check();
        await waitMip(v);
        console.log(`  [座標どおり] ${await v.getByTestId("stitch-overlap").textContent()} / ${await v.getByTestId("stitch-output").textContent()} / 保存可 ${await v.getByTestId("stitch-save").isEnabled()}`);
        console.log(`  [座標どおり] 並び: ${(await v.getByTestId("stitch-ranges").textContent())?.replace(/\s+/g, " ")}`);
        await v.screenshot({ path: path.join(OUT_DIR, "real-coord.png") });
        return;
      }
      // 重なりの正解は DICOM から分からないので、REAL_OVERLAP があればそれを入れ、無ければ自動の値のまま
      if (process.env.REAL_OVERLAP) await v.getByTestId("stitch-overlap-input").fill(process.env.REAL_OVERLAP);
      // 境目の段差の指標: COR 画像の行ごとの平均輝度（0〜255）の、隣り合う行の差の最大を、2 つの境目（重なりの中心 ± 重なり/2 ± 1 行）に限って測る。
      // ステーションは 3 本・各 REAL_STATION_MM（既定 300 mm）・重なりは欄の値。小さいほど滑らか。
      const step = async () => {
        const ov = Number(await v.getByTestId("stitch-overlap-input").inputValue());
        const len = Number(process.env.REAL_STATION_MM ?? "300");
        return (await v.getByTestId("stitch-mip-cor").evaluate((c: HTMLCanvasElement, a: { ov: number; len: number }) => {
          const ctx = c.getContext("2d")!;
          const { data, width, height } = ctx.getImageData(0, 0, c.width, c.height);
          const means: number[] = [];
          for (let y = 0; y < height; y++) {
            let sum = 0;
            for (let x = 0; x < width; x++) sum += data[(y * width + x) * 4];
            means.push(sum / width);
          }
          const total = 3 * a.len - 2 * a.ov;
          const mmPerRow = total / height;
          let mx = 0;
          for (const k of [1, 2]) {
            const centerFromBottom = k * a.len - (k - 0.5) * a.ov; // k 番目の境目の重なりの中心（下端から）
            const lo = Math.floor((total - (centerFromBottom + a.ov / 2)) / mmPerRow) - 1;
            const hi = Math.ceil((total - (centerFromBottom - a.ov / 2)) / mmPerRow) + 1;
            for (let y = Math.max(1, lo); y <= Math.min(height - 1, hi); y++) mx = Math.max(mx, Math.abs(means[y] - means[y - 1]));
          }
          return mx;
        }, { ov, len })) as number;
      };
      const variants: Array<[string, "mean" | "linear", boolean]> = [["mean", "mean", false], ["linear", "linear", false], ["linear+gain", "linear", true]];
      for (const [name, mode, gain] of process.env.REAL_SKIP_VARIANTS ? [] : variants) {
        await v.getByTestId(`stitch-blend-${mode}`).check();
        if ((await v.getByTestId("stitch-gain").isChecked()) !== gain) await v.getByTestId("stitch-gain").click();
        await waitMip(v);
        const gains = gain ? (await v.getByTestId("stitch-gains").textContent())?.replace(/\s+/g, " ") : "";
        console.log(`  [${name}] 段差の指標 ${(await step()).toFixed(2)} ${gains ?? ""}`);
        await v.screenshot({ path: path.join(OUT_DIR, `real-${name}.png`) });
      }
      if (process.env.REAL_SAVE) {
        // 実データを保存し、DICOM タグを入力のシリーズ（rest）から独立に計算した期待値と照合する。
        const studyUid = (impR as any).studyInstanceUids[0] as string;
        await v.getByTestId("stitch-blend-linear").check();
        if (await v.getByTestId("stitch-gain").isChecked()) await v.getByTestId("stitch-gain").click();
        await waitMip(v);
        v.on("console", (m) => { if (/error|crash|memory/i.test(m.text())) console.log(`  [renderer] ${m.text().slice(0, 200)}`); });
        v.on("crash", () => console.log("  [renderer] crash イベント"));
        // レンダラが落ちたとき、Electron の main が受ける理由（oom / crashed / killed など）を残す。
        await d.app.evaluate(({ app }) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (globalThis as any).__gone = [];
          app.on("render-process-gone", (_e: unknown, _wc: unknown, det: unknown) => { (globalThis as any).__gone.push(det); });
        });
        let dir: string | null = null;
        try {
          dir = await saveAndDownload(v, d, studyUid, "real");
        } catch (err) {
          console.log(`  [保存で例外] ${String(err).split("\n")[0]}`);
          console.log(`  [空きメモリ] ${Math.round(os.freemem() / 1048576)} MB / ${Math.round(os.totalmem() / 1048576)} MB`);
          await new Promise((r) => setTimeout(r, 1500));
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          console.log(`  [render-process-gone] ${JSON.stringify(await d.app.evaluate(() => (globalThis as any).__gone))}`);
        }
        if (dir) {
          const tg = spawnSync(PY, ["-I", path.join(AUTOMATOR_ROOT, "scripts", "verify-stitch-tags.py"), "source", dir, root, rest.join(","), process.env.REAL_N ?? "0"], { encoding: "utf8" });
          reportTags(tg.stdout, tg.status, tg.stderr, "real");
          const info = JSON.parse(tg.stdout).info;
          console.log(`  入力にあって出力に無いタグ: ${(info["入力にあって出力に無いタグ"] ?? []).join(", ")}`);
          console.log(`  SOPClass: ${info["SOPClass（入力 → 出力）"]} / FoR: ${info["FrameOfReferenceUID（入力の先頭 → 出力）"]}`);
        }
      }
    }
  } finally {
    await d.stop().catch(() => {});
  }
  console.log(`\n合格 ${passed} / 失敗 ${failures.length} / 既知の未対応 ${known.length}`);
  process.exitCode = failures.length ? 1 : 0;
}
main();
