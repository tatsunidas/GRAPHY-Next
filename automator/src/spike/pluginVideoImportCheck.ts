/*
 * プラグインのための動画の取り込み（host API H47〜H49）の実機検証。
 *
 * 実行:  cd automator && npx tsx src/spike/pluginVideoImportCheck.ts
 *
 * 確かめること（本物の Electron ＋ backend ＋ ffmpeg）:
 *   1. H47 probe: 諸元（ffprobe 無しで）・数え直したフレーム数・SHA-256・取り込み済みでない
 *   2. H48: 本体の確認ダイアログが出る。**拒否すると札は出ず何も書かれない**
 *   3. H48: 奇数寸法の AVI（MJPEG）を US Multi-frame として取り込む。偶数寸法に変換される・
 *      SOP Class / Modality / [Plugin] 接頭辞 / 出所（ContributingEquipment）が本体の値になる
 *   4. H48: フレームごとの値の SR が書かれ、H49 で読み戻すと**丸めずに**同じ値が返る
 *   5. H48: 包める MP4（H.264・偶数寸法）は変換せずに包む。2 本目は 1 本目と同じ検査に入る
 *   6. 重複: 同じ動画は、新しい札でも**書かれず** duplicate が返る。probe も取り込み済みと言う
 *   7. SR の長さが動画のフレーム数と違えば、動画だけ取り込み SR は書かない（理由を返す）
 *   8. 既存の患者を選ぶと、その患者の ID・氏名で取り込まれる。新しい患者に既存の ID は使えない
 *   9. 札の範囲外（同意していないファイル）は backend に届く前に拒否される
 *
 * 前提: backend jar と、videoDisplayOpsCheck が作る 4 象限の動画（包める MP4）。
 *       検証用プラグインは mainScreenHostCheck と同じ `automator/plugins/mainscreen-host-check/`。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Page } from "@playwright/test";

import { DesktopDriver, DESKTOP_RUN_DATA_DIR } from "../driver/desktopDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { importNonDicomPaths } from "../fixtures/importFixtures.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { dismissStartupDialogs } from "../common/dismissDialogs.js";

const PLUGIN_ID = "mainscreen-host-check";
const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "plugin-video-import");
const SRC_DIR = path.join(AUTOMATOR_ROOT, "plugins", PLUGIN_ID);
const SPI_JAR = path.join(AUTOMATOR_ROOT, "..", "backend", "target", "graphy-next-backend-plugin-api.jar");
const FIX_DIR = path.join(AUTOMATOR_ROOT, "fixtures", "video-mp4-avi", "plugin-import");
const MP4 = path.join(AUTOMATOR_ROOT, "fixtures", "video-mp4-avi", "display-ops", "quadrants.mp4");

const failures: string[] = [];
let passed = 0;
function check(cond: boolean, label: string, detail?: unknown): void {
  const d = detail === undefined ? "" : ` — ${JSON.stringify(detail)}`.slice(0, 400);
  if (cond) {
    passed++;
    console.log(`  [ok  ] ${label}${d}`);
  } else {
    console.log(`  [FAIL] ${label}${d}`);
    failures.push(label);
  }
}

/** mainScreenHostCheck と同じ検証用プラグインを置く。 */
function installPlugin(): void {
  const dst = path.join(DESKTOP_RUN_DATA_DIR, "plugins", PLUGIN_ID);
  fs.rmSync(dst, { recursive: true, force: true });
  fs.mkdirSync(dst, { recursive: true });
  for (const name of ["plugin.json", "ui.js"]) fs.copyFileSync(path.join(SRC_DIR, name), path.join(dst, name));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "jobprobe-"));
  execFileSync("javac", ["--release", "17", "-cp", SPI_JAR, "-d", work, path.join(SRC_DIR, "java", "JobProbe.java")]);
  execFileSync("jar", ["--create", "--file", path.join(dst, "job-probe.jar"), "-C", work, "."]);
  fs.rmSync(work, { recursive: true, force: true });
}

/** 奇数寸法・MJPEG の AVI（変換の経路を通す）。フレームごとに明るさが変わる。 */
function makeAvi(name: string, frames: number): string {
  fs.mkdirSync(FIX_DIR, { recursive: true });
  const out = path.join(FIX_DIR, name);
  if (fs.existsSync(out)) return out;
  execFileSync("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", `color=c=black:s=321x241:r=15:d=${frames / 15}`,
    "-vf", "geq=lum='16+N*5':cb=128:cr=128",
    "-c:v", "mjpeg", "-q:v", "3", out,
  ]);
  return out;
}

function inHost<T>(page: Page, body: string): Promise<T> {
  return page.evaluate(`(async () => { const host = window.__mainHost; ${body} })()`) as Promise<T>;
}

/** 同意を求め、本体のダイアログを押す。`accept=false` なら取り消す。 */
async function consent(page: Page, req: unknown, accept = true): Promise<{ ok: boolean; consentToken?: string; cancelled?: boolean }> {
  const p = inHost<{ ok: boolean; consentToken?: string; cancelled?: boolean }>(
    page,
    `return host.video.requestImportConsent(${JSON.stringify(req)});`,
  );
  await page.getByTestId("plugin-video-consent").waitFor({ state: "visible", timeout: 20_000 });
  await page.screenshot({ path: path.join(OUT_DIR, `consent-${Date.now()}.png`) }).catch(() => {});
  await page.getByTestId(accept ? "plugin-video-consent-ok" : "plugin-video-consent-cancel").click();
  return p;
}

interface TagRow {
  tag: string;
  name: string;
  value: string;
  depth: number;
}
async function tags(port: number, sop: string): Promise<TagRow[]> {
  return (await (await fetch(`http://127.0.0.1:${port}/api/instances/${encodeURIComponent(sop)}/tags`)).json()) as TagRow[];
}
const tagVal = (rows: TagRow[], tag: string) =>
  rows.find((r) => r.depth === 0 && r.tag.replace(/[^0-9a-f]/gi, "").toUpperCase() === tag)?.value ?? null;
const nestedVal = (rows: TagRow[], tag: string) =>
  rows.find((r) => r.depth > 0 && r.tag.replace(/[^0-9a-f]/gi, "").toUpperCase() === tag)?.value ?? null;

async function main(): Promise<void> {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  if (!fs.existsSync(MP4)) throw new Error(`fixture がありません（videoDisplayOpsCheck を先に回す）: ${MP4}`);
  const odd = makeAvi("odd-321x241.avi", 30);
  const short = makeAvi("odd-short-20.avi", 20);
  const third = makeAvi("odd-third-12.avi", 12);
  installPlugin();
  const driver = new DesktopDriver();
  await driver.start();
  const port = driver.ports.http;
  try {
    const page = driver.page;
    const pageErrors: string[] = [];
    page.on("pageerror", (e) => pageErrors.push(String(e?.stack ?? e)));
    await resetDb(port);
    await importNonDicomPaths(port, [MP4], { patientId: "EXIST-001", patientName: "EXIST^PATIENT", seriesDescription: "seed" });
    await page.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
    await dismissStartupDialogs(page);
    await page.getByTestId("mainscreen-menu-plugins").click();
    await page.getByTestId(`plugin-item-${PLUGIN_ID}`).click();
    await page.getByTestId("mainscreen-host-check-panel").waitFor({ state: "visible", timeout: 20_000 });

    // ── 1. probe
    const pr = await inHost<{ codec: string; width: number; height: number; frameCount: number; sha256: string; alreadyImported: unknown }>(
      page,
      `return host.video.probe(${JSON.stringify(odd)});`,
    );
    check(pr.codec === "mjpeg" && pr.width === 321 && pr.height === 241 && pr.frameCount === 30, "[1] ★probe が ffprobe 無しで諸元とフレーム数を返す", pr);
    check(/^[0-9a-f]{64}$/.test(pr.sha256) && pr.alreadyImported === null, "[1b] SHA-256 を返し、未取り込みと言う");

    // ── 2. 拒否
    const NEW = { create: { patientId: "UVS-NEW-001", patientName: "NEW^PATIENT", sex: "F" } };
    const denied = await consent(page, { patient: NEW, paths: [odd], modality: "US" }, false);
    check(denied.ok === false && denied.cancelled === true, "[2] ★確認ダイアログで取り消すと札は出ない", denied);

    // ── 3. 変換して US Multi-frame
    const cpr = Array.from({ length: 30 }, (_, i) => (i === 7 ? 1 / 3 : i * 0.001 + 1.2345678901234567e-7));
    const mad = Array.from({ length: 30 }, (_, i) => 0.5 - i * 1e-9);
    const c1 = await consent(page, {
      patient: NEW,
      paths: [odd, MP4],
      modality: "US",
      frameValues: { description: "CPR / MAD（元の動画で採点）" },
    });
    check(c1.ok && !!c1.consentToken, "[2b] 同意すると札が出る");
    const progress: number[] = [];
    await page.exposeFunction("__progressSeen", (p: number) => progress.push(p)).catch(() => undefined);
    const r1 = await inHost<{ ok: boolean; result: Record<string, unknown>; error?: string }>(
      page,
      `return host.video.importAsDicom({ consentToken: ${JSON.stringify(c1.consentToken)}, path: ${JSON.stringify(odd)},
         patient: ${JSON.stringify(NEW)}, modality: "US", studyDescription: "UVS import", seriesDescription: "odd",
         frameValues: { series: [{ key: "CPR", label: "Colored pixel ratio", values: ${JSON.stringify(cpr)} },
                                 { key: "MAD", label: "Mean absolute difference", values: ${JSON.stringify(mad)} }],
                        params: { scoreSource: "SOURCE_VIDEO" } } },
         { pollMs: 150, onProgress: (p) => window.__progressSeen(p) });`,
    );
    const res1 = r1.result ?? {};
    check(r1.ok && res1.duplicate === false && res1.transcoded === true && res1.numberOfFrames === 30, "[3] ★奇数寸法の AVI を変換して取り込める（30 フレーム）", r1);
    check(progress.some((p) => p > 0 && p < 1), "[3b] 途中の進み具合が届く", progress.slice(0, 8));
    const sop1 = String(res1.sopInstanceUid);
    const t1 = await tags(port, sop1);
    check(tagVal(t1, "00080016") === "1.2.840.10008.5.1.4.1.1.3.1" && tagVal(t1, "00080060") === "US", "[3c] ★SOP Class が US Multi-frame・Modality が US", {
      cls: tagVal(t1, "00080016"),
      mod: tagVal(t1, "00080060"),
    });
    check(tagVal(t1, "00280010") === "240" && tagVal(t1, "00280011") === "320", "[3d] 偶数寸法（320×240）に変換されている", {
      rows: tagVal(t1, "00280010"),
      cols: tagVal(t1, "00280011"),
    });
    check((tagVal(t1, "0008103E") ?? "").startsWith("[Plugin] odd") && (nestedVal(t1, "00081090") ?? "") === "Main Screen Host Check", "[3e] ★[Plugin] 接頭辞と出所（プラグイン名）を本体が入れる", {
      desc: tagVal(t1, "0008103E"),
      model: nestedVal(t1, "00081090"),
    });
    check(tagVal(t1, "00100020") === "UVS-NEW-001" && tagVal(t1, "00100040") === "F", "[3f] 新しい患者の ID・性別で書かれる");

    // ── 4. SR の読み戻し
    const fv = await inHost<{ series: { key: string; values: number[] }[]; params: Record<string, string> } | null>(
      page,
      `return host.video.readFrameValues(${JSON.stringify(sop1)});`,
    );
    check(!!res1.frameValuesSopInstanceUid && !res1.frameValuesError, "[4] フレームごとの値の SR が書かれた", res1.frameValuesSopInstanceUid);
    check(
      !!fv && JSON.stringify(fv.series.find((s) => s.key === "CPR")?.values) === JSON.stringify(cpr) &&
        JSON.stringify(fv.series.find((s) => s.key === "MAD")?.values) === JSON.stringify(mad) && fv.params.scoreSource === "SOURCE_VIDEO",
      "[4b] ★H49 で読み戻すと丸めずに同じ値（1/3・1.23e-7・0.5-1e-9）が返る",
      fv?.series.map((s) => s.values.slice(0, 3)),
    );

    // ── 5. 包める MP4 は変換しない・同じ検査に入る
    const r2 = await inHost<{ ok: boolean; result: Record<string, unknown> }>(
      page,
      `return host.video.importAsDicom({ consentToken: ${JSON.stringify(c1.consentToken)}, path: ${JSON.stringify(MP4)},
         patient: ${JSON.stringify(NEW)}, modality: "US", studyInstanceUid: ${JSON.stringify(res1.studyInstanceUid)} });`,
    );
    // 4 象限の MP4 は seed として EXIST-001 に取り込み済み（別の経路＝SHA 由来の UID ではない）なので新規扱い
    check(r2.ok && r2.result.transcoded === false && r2.result.studyInstanceUid === res1.studyInstanceUid, "[5] ★包める MP4 は変換せず、2 本目は同じ検査に入る", r2);

    // ── 9. 札の範囲外
    const outside = await inHost<{ ok: boolean; error?: string }>(
      page,
      `return host.video.importAsDicom({ consentToken: ${JSON.stringify(c1.consentToken)}, path: ${JSON.stringify(short)},
         patient: ${JSON.stringify(NEW)}, modality: "US" });`,
    );
    check(!outside.ok && outside.error === "path-not-consented", "[9] 同意していないファイルは拒否される", outside);

    // ── 6. 重複
    const pr2 = await inHost<{ alreadyImported: { sopInstanceUid: string } | null }>(page, `return host.video.probe(${JSON.stringify(odd)});`);
    check(pr2.alreadyImported?.sopInstanceUid === sop1, "[6] probe が取り込み済み（同じ SOP）と言う", pr2.alreadyImported);
    const c2 = await consent(page, { patient: { patientKey: "EXIST-001" }, paths: [odd, short, third], modality: "US", frameValues: { description: "CPR" } });
    const dup = await inHost<{ ok: boolean; result: Record<string, unknown> }>(
      page,
      `return host.video.importAsDicom({ consentToken: ${JSON.stringify(c2.consentToken)}, path: ${JSON.stringify(odd)},
         patient: { patientKey: "EXIST-001" }, modality: "US" });`,
    );
    check(dup.ok && dup.result.duplicate === true && dup.result.sopInstanceUid === sop1, "[6b] ★同じ動画は別の患者を選んでも取り込まれず duplicate が返る", dup.result);

    // ── 7. 長さ違いの SR
    const bad = await inHost<{ ok: boolean; result: Record<string, unknown> }>(
      page,
      `return host.video.importAsDicom({ consentToken: ${JSON.stringify(c2.consentToken)}, path: ${JSON.stringify(short)},
         patient: { patientKey: "EXIST-001" }, modality: "US",
         frameValues: { series: [{ key: "CPR", label: "c", values: [${Array(10).fill(0).join(",")}] }] } });`,
    );
    check(
      bad.ok && bad.result.numberOfFrames === 20 && !bad.result.frameValuesSopInstanceUid && /20/.test(String(bad.result.frameValuesError)),
      "[7] ★SR の長さが動画のフレーム数と違えば、動画だけ取り込み SR は書かない（理由つき）",
      bad.result,
    );

    // ── 8. 既存の患者
    const t3 = await tags(port, String(bad.result.sopInstanceUid));
    check(tagVal(t3, "00100020") === "EXIST-001" && tagVal(t3, "00100010") === "EXIST^PATIENT", "[8] ★既存の患者を選ぶと、その患者の ID・氏名で書かれる", {
      id: tagVal(t3, "00100020"),
      name: tagVal(t3, "00100010"),
    });
    const c3 = await consent(page, { patient: { create: { patientId: "EXIST-001", patientName: "X" } }, paths: [third], modality: "US" });
    const clash = await inHost<{ ok: boolean; error?: string }>(
      page,
      `return host.video.importAsDicom({ consentToken: ${JSON.stringify(c3.consentToken)}, path: ${JSON.stringify(third)},
         patient: { create: { patientId: "EXIST-001", patientName: "X" } }, modality: "US" });`,
    );
    check(!clash.ok && /既にあります|already/.test(clash.error ?? ""), "[8b] 新しい患者に既存の患者 ID は使えない", clash);

    await page.screenshot({ path: path.join(OUT_DIR, "9-end.png") }).catch(() => {});
    check(pageErrors.length === 0, "[10] 画面の例外（pageerror）が 0 件", pageErrors.slice(0, 3));
  } finally {
    await driver.stop();
  }

  console.log("\n=== 結果 ===");
  if (failures.length === 0) {
    console.log(`${passed} 項目すべて OK。スクリーンショット: ${OUT_DIR}`);
  } else {
    console.log(`${passed} 項目 OK / FAIL ${failures.length} 件:`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exitCode = 1;
  }
}

await main();
