/*
 * web モードの「NIfTI で書き出し…」（PM-IO-901 段 2b）の実アプリ検査: 実 PACS（dcm4chee）＋web モードの実 backend＋Chromium。
 *
 * 前提（ファイル冒頭の手順どおりに立てる。専用ポート）:
 *   docker compose（deploy/dcm4chee を専用ポートに替えたもの。DICOMweb 18080・DIMSE 21112）
 *   java -jar backend/target/graphy-next-backend.jar --spring.profiles.active=web --server.port=18691 \
 *     --graphy.dicom.scp.port=18692 --graphy.dicom.dicomweb.base-url=http://127.0.0.1:18080/dcm4chee-arc/aets/DCM4CHEE/rs
 * 実行:  cd automator && NIFTI_PY=<nibabel・pydicom・numpy の入った python> timeout 900 npx tsx src/spike/niftiWebCheck.ts
 *
 * 合成シリーズ（`check-nifti-markers.py make`。実行のたびに新しい UID）を storescu で PACS に入れ、web の画面でシリーズを選び、
 * **メニューを実際に押して**保存されたファイルを nibabel（本体の書き手とは別の実装）で照合する。既定のまま（未選択→選択→押す）の経路を通す。
 *  1. 未選択では押せず理由が出る（web でも）。
 *  2. 軸位・冠状・矢状・斜位: 保存 → 形・画素のビット一致・印の RAS・軸の向き。
 *  3. 負例: ガントリーチルト・欠け・焼き込みの多い種類（XA）は、理由つきの帯が出てダウンロードされない。
 *  4. 受け取りは 1 回だけ（API）。投入直後の DELETE でジョブが消える。
 * 結果は 合格・失敗・未達 に分けて数える。患者情報を含まない合成データ。
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium, type Browser, type Page } from "@playwright/test";

import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { createChecker } from "./computeSpikeShared.js";

const { check, summary } = createChecker();
const WEB = process.env.GRAPHY_WEB_URL ?? "http://127.0.0.1:18691";
const PACS_DIMSE = process.env.GRAPHY_PACS_DIMSE ?? "DCM4CHEE@127.0.0.1:21112";
const STORESCU = process.env.STORESCU ?? path.join(os.homedir(), "dcm4che-5.33.1", "bin", "storescu");
const PY = process.env.NIFTI_PY ?? "python3";
const TOOL = path.join(AUTOMATOR_ROOT, "scripts", "check-nifti-markers.py");
const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "nifti-web");

function py(args: string[]): { status: number; out: string } {
  const r = spawnSync(PY, ["-I", ...args], { encoding: "utf8" });
  return { status: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function store(dir: string): void {
  const r = spawnSync(STORESCU, ["-c", PACS_DIMSE, dir], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`storescu 失敗: ${r.stdout}${r.stderr}`);
}

/** 軸位の合成シリーズを、モダリティだけ XA にして新しい UID で作り直す（焼き込みが多い種類の負例）。 */
function makeXa(srcDir: string, dstDir: string): { study: string; series: string } {
  const code = [
    "import sys,os,pydicom",
    "from pydicom.uid import generate_uid",
    "src,dst=sys.argv[1],sys.argv[2]; os.makedirs(dst,exist_ok=True)",
    "st,se=generate_uid(),generate_uid()",
    "for n in sorted(os.listdir(src)):",
    "  ds=pydicom.dcmread(os.path.join(src,n))",
    "  ds.Modality='XA'; ds.SOPClassUID='1.2.840.10008.5.1.4.1.1.12.1'; ds.file_meta.MediaStorageSOPClassUID=ds.SOPClassUID",
    "  ds.StudyInstanceUID=st; ds.SeriesInstanceUID=se; ds.SOPInstanceUID=generate_uid(); ds.file_meta.MediaStorageSOPInstanceUID=ds.SOPInstanceUID",
    "  ds.PatientID='NIFTIWEB-XA'; ds.save_as(os.path.join(dst,n))",
    "print(st,se)",
  ].join("\n");
  const r = py(["-c", code, srcDir, dstDir]);
  if (r.status !== 0) throw new Error(`XA の合成に失敗: ${r.out}`);
  const [study, series] = r.out.trim().split(/\s+/);
  return { study, series };
}

/** 起動直後の「利用条件の確認」（同意するまで画面を覆う）。開発検証の localhost に限り「同意して使う」を押す（ユーザー指示 2026-10-25）。 */
async function acceptTerms(p: Page): Promise<void> {
  const agree = p.getByRole("button", { name: "同意して使う" });
  if (await agree.isVisible({ timeout: 8000 }).catch(() => false)) await agree.click();
}

async function selectSeries(p: Page, study: string, series: string): Promise<void> {
  await p.reload();
  await p.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
  await acceptTerms(p);
  await p.getByTestId("search-allperiod-chip").click();
  await p.getByTestId("search-submit-button").click();
  await p.locator(`[data-testid="study-row-${study}"]`).click({ timeout: 30_000 });
  await p.locator(`[data-testid="series-row-${series}"]`).click({ timeout: 30_000 });
  await p.waitForTimeout(800);
}

async function pressExport(p: Page): Promise<void> {
  await p.getByRole("button", { name: /^(ファイル|File)$/ }).first().click();
  await p.getByTestId("menu-item-nifti-export").click();
}

async function main(): Promise<number> {
  const probe = py(["-c", "import nibabel, pydicom, numpy"]);
  if (probe.status !== 0) {
    console.log(`【未達】nibabel / pydicom / numpy が使えません（NIFTI_PY=${PY}）。独立照合ができないので合格にしません。\n${probe.out}`);
    return 2;
  }
  const st = (await fetch(`${WEB}/api/status`).then((r) => r.json()).catch(() => null)) as { mode?: string } | null;
  if (!st || st.mode !== "web") {
    console.log(`【未達】web モードの backend が ${WEB} にありません（${JSON.stringify(st)}）。ファイル冒頭を参照。`);
    return 2;
  }
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "nifti-web-"));
  const ph = path.join(work, "ph");
  const made = py([TOOL, "make", ph]);
  if (made.status !== 0) throw new Error(`合成シリーズを作れませんでした: ${made.out}`);
  const truth = JSON.parse(fs.readFileSync(path.join(ph, "truth.json"), "utf8")) as Record<string, { study: string; series: string }>;
  const names = ["sagittal", "axial", "coronal", "oblique", "tilt", "gap"];
  for (const n of names) store(path.join(ph, n));
  const xa = makeXa(path.join(ph, "axial"), path.join(work, "xa"));
  store(path.join(work, "xa"));

  let browser: Browser | null = null;
  try {
    browser = await chromium.launch();
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, locale: "ja-JP", acceptDownloads: true });
    const p = await ctx.newPage();
    const errors: string[] = [];
    p.on("pageerror", (e) => errors.push(String(e)));
    await p.goto(`${WEB}/`, { waitUntil: "domcontentloaded" });
    await p.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
    await acceptTerms(p);

    console.log("\n[1] 既定（シリーズ未選択）: 項目が押せず、理由が出る（web でも）");
    await p.getByRole("button", { name: /^(ファイル|File)$/ }).first().click();
    const item = p.getByTestId("menu-item-nifti-export");
    await item.waitFor({ state: "visible" });
    check(await item.isDisabled(), "シリーズ未選択では項目が押せない", null);
    check(/シリーズを 1 本選んで/.test((await item.getAttribute("title")) ?? ""), "理由が title に出る（「デスクトップ版のみ」ではない）", await item.getAttribute("title"));
    await p.screenshot({ path: path.join(OUT_DIR, "1-menu-disabled.png") });
    await p.keyboard.press("Escape");
    await p.mouse.click(5, 5);

    console.log("\n[2] 4 つの向き: メニューを押して保存 → nibabel で照合");
    const saved: Record<string, string> = {};
    for (const name of ["sagittal", "axial", "coronal", "oblique"]) {
      await selectSeries(p, truth[name].study, truth[name].series);
      await p.getByRole("button", { name: /^(ファイル|File)$/ }).first().click();
      const it = p.getByTestId("menu-item-nifti-export");
      check(await it.isEnabled(), `${name}: シリーズを選ぶと項目が押せる（web）`, null);
      const [dl] = await Promise.all([p.waitForEvent("download", { timeout: 120_000 }), it.click()]);
      const f = path.join(OUT_DIR, `${name}.nii.gz`);
      await dl.saveAs(f);
      saved[name] = f;
      check(/^CT_S\d+\.nii\.gz$/.test(dl.suggestedFilename()), `${name}: 既定名が <モダリティ>_S<番号>（患者情報なし）`, dl.suggestedFilename());
      const msg = p.getByTestId("nifti-export-msg");
      await msg.filter({ hasText: /書き出しました/ }).waitFor({ state: "visible", timeout: 30_000 });
      const text = await msg.innerText();
      check(/書き出しました（16 枚）/.test(text), `${name}: 成功の帯に枚数が出る`, text);
      if (name === "sagittal") await p.screenshot({ path: path.join(OUT_DIR, "2-exported-sagittal.png") });
      const r = py([TOOL, "check", name, f, ph]);
      console.log(r.out.split("\n").filter(Boolean).map((l) => `    ${l.trim()}`).join("\n"));
      check(r.status === 0, `${name}: nibabel の独立照合（形・画素のビット一致・印の RAS・軸の向き）がすべて合格`);
    }

    console.log("\n[3] 負例: チルト・欠け・焼き込みの多い種類（XA）は、理由つきの帯が出て、ファイルは保存されない");
    const refusals: [string, { study: string; series: string }, RegExp][] = [
      ["tilt", truth.tilt, /ガントリーチルト/],
      ["gap", truth.gap, /間隔が一定でない|欠けた/],
      ["xa", xa, /焼き込まれていることが多く/],
    ];
    for (const [name, ids, word] of refusals) {
      await selectSeries(p, ids.study, ids.series);
      let downloaded = false;
      const onDl = () => { downloaded = true; };
      p.on("download", onDl);
      await pressExport(p);
      const msg = p.getByTestId("nifti-export-msg");
      await msg.filter({ hasText: /書き出せませんでした/ }).waitFor({ state: "visible", timeout: 60_000 });
      await p.waitForTimeout(1500);
      p.off("download", onDl);
      const t = await msg.innerText();
      check(word.test(t), `${name}: 理由の文言が帯に出る`, t);
      check(!downloaded, `${name}: ファイルは保存されない（ダウンロードが起きない）`, null);
      await p.screenshot({ path: path.join(OUT_DIR, `3-refused-${name}.png`) });
    }

    console.log("\n[4] API: 受け取りは 1 回だけ／投入直後の DELETE でジョブが消える／standalone 用の同期 API は web で 501");
    const post = async () =>
      fetch(`${WEB}/api/nifti/export-job`, {
        method: "POST", headers: { "Content-Type": "application/json", "X-Graphy-Request": "1" },
        body: JSON.stringify({ studyUid: truth.axial.study, seriesUid: truth.axial.series }),
      });
    const noHeader = await fetch(`${WEB}/api/nifti/export-job`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ studyUid: truth.axial.study, seriesUid: truth.axial.series }),
    });
    check(noHeader.status === 403, "負例: X-Graphy-Request ヘッダが無い投入は 403（CSRF の守り）", noHeader.status);
    const j1 = await post();
    check(j1.status === 202, "投入は 202", j1.status);
    const id1 = ((await j1.json()) as { jobId: string }).jobId;
    let state = "";
    for (let i = 0; i < 100 && state !== "DONE"; i++) {
      await new Promise((r) => setTimeout(r, 300));
      state = ((await (await fetch(`${WEB}/api/anonymizer/jobs/${id1}`)).json()) as { state: string }).state;
    }
    check(state === "DONE", "ジョブが DONE になる", state);
    const f1 = await fetch(`${WEB}/api/nifti/export-job/${id1}/file`);
    check(f1.status === 200 && (await f1.arrayBuffer()).byteLength > 0, "1 回目の受け取りは 200 で本体がある", f1.status);
    const f2 = await fetch(`${WEB}/api/nifti/export-job/${id1}/file`);
    check(f2.status === 404, "2 回目の受け取りは 404（受け取れるのは 1 回だけ）", f2.status);
    const j2 = await post();
    const id2 = ((await j2.json()) as { jobId: string }).jobId;
    const del = await fetch(`${WEB}/api/anonymizer/jobs/${id2}`, { method: "DELETE", headers: { "X-Graphy-Request": "1" } });
    check(del.ok, "DELETE が通る", del.status);
    const gone = await fetch(`${WEB}/api/anonymizer/jobs/${id2}`);
    check(gone.status === 404, "DELETE 後はジョブが無い", gone.status);
    const sync = await fetch(`${WEB}/api/nifti/export`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ studyUid: truth.axial.study, seriesUid: truth.axial.series }),
    });
    check(sync.status === 501, "同期の /api/nifti/export は web で 501（画面は使わない）", sync.status);

    check(errors.length === 0, "ページの未処理エラーが 0", errors);
    console.log("\n【未達】実行中のジョブを画面の［中止］で止める経路（小さい合成では一瞬で終わる）。単体（api のモック）でのみ確認。Electron は web モードの対象外。");
    console.log(`出力: ${OUT_DIR}`);
    return summary();
  } finally {
    await browser?.close();
    fs.rmSync(work, { recursive: true, force: true });
  }
}

main().then((c) => process.exit(c), (e) => { console.error(e); process.exit(2); });
