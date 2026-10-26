/*
 * 受信時の可逆圧縮（設定 ＞ DICOM ネットワーク ＞ 受信時の画像圧縮）の実アプリ検査。
 *
 * 実行:  cd automator && GRAPHY_AUTOMATOR_HTTP_PORT=19610 GRAPHY_AUTOMATOR_SCP_PORT=19611 GRAPHY_AUTOMATOR_VITE_PORT=19613 \
 *          npx tsx src/spike/receiveCompressCheck.ts
 *        （合成 CT の生成に pydicom・numpy のある python3、C-STORE に dcm4che の storescu（~/dcm4che-* ）が要る）
 *
 * 合成の 3 検査（画素は a と b が同一、c は b から 5×5 画素だけ +500）を C-STORE で送る。
 *   b（設定オフ）: 非圧縮のまま保存される（基準）
 *   a（設定オン）: 保管庫の転送構文が JPEG-LS 可逆になり、ファイルが小さくなる
 *   表示: 2D ビューアで a と b を開き、キャンバスのスクリーンショットが一致する（画素の可逆性そのものは受信側の全バイト比較が保証。ここは表示まで届くかの確認）
 *   負例: c（画素が違う）は b と一致しない（比較器が差を見抜く）
 *   多重圧縮の禁止: a の保管済みファイル（圧縮済み）を再送しても、保管庫のファイルは 1 バイトも変わらない
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import os from "node:os";
import type { Page } from "@playwright/test";

import { resetDb } from "../backend/dbReset.js";
import { dismissStartupDialogs } from "../common/dismissDialogs.js";
import { DesktopDriver } from "../driver/desktopDriver.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { createChecker } from "./computeSpikeShared.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "receive-compress-check");
const { check, summary } = createChecker();
const JPEGLS = "1.2.840.10008.1.2.4.80";
const EVR_LE = "1.2.840.10008.1.2.1";

interface Study { studyUid: string; seriesUid: string; sops: string[]; patientId: string }
type Truth = { a: Study; b: Study; c: Study };

function synth(): { dir: string; truth: Truth } {
  const dir = path.join(OUT_DIR, "synth");
  fs.rmSync(dir, { recursive: true, force: true });
  const r = spawnSync("python3", ["-I", path.join(import.meta.dirname, "receiveCompressSynth.py"), dir], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`合成データを作れません: ${r.stderr}`);
  return { dir, truth: JSON.parse(fs.readFileSync(path.join(dir, "truth.json"), "utf8")) as Truth };
}

function findStorescu(): string {
  const home = os.homedir();
  const d = fs.readdirSync(home).filter((n) => n.startsWith("dcm4che-")).sort().reverse()[0];
  const p = d ? path.join(home, d, "bin", "storescu") : "";
  if (!p || !fs.existsSync(p)) throw new Error("storescu（~/dcm4che-*/bin）が見つかりません");
  return p;
}

function storescu(bin: string, port: number, target: string): void {
  const r = spawnSync(bin, ["-c", `GRAPHYNEXT@127.0.0.1:${port}`, target], { encoding: "utf8", timeout: 120_000 });
  if (r.status !== 0) throw new Error(`storescu 失敗 (exit=${r.status}): ${(r.stdout + r.stderr).slice(-400)}`);
}

async function getJson<T>(base: string, p: string): Promise<T> {
  const r = await fetch(base + p);
  if (!r.ok) throw new Error(`${p} → ${r.status}`);
  return (await r.json()) as T;
}

async function instances(base: string, s: Study): Promise<{ sopInstanceUid: string; transferSyntaxUid: string }[]> {
  return getJson(base, `/api/studies/${s.studyUid}/series/${s.seriesUid}/instances`);
}

async function storedFile(base: string, s: Study, sop: string): Promise<Buffer> {
  const r = await fetch(`${base}/api/studies/${s.studyUid}/series/${s.seriesUid}/instances/${sop}/file`);
  if (!r.ok) throw new Error(`file ${sop} → ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

async function setCompressViaUi(page: Page, value: "off" | "jpegls"): Promise<void> {
  await page.getByTestId("mainscreen-menu-system").click();
  await page.getByTestId("menu-item-settings").click();
  await page.getByTestId("settings-cat-dicom").click();
  const sel = page.getByTestId("settings-field-dicom.receiveCompress");
  await sel.waitFor({ state: "visible", timeout: 10_000 });
  await sel.selectOption(value);
  await sel.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(OUT_DIR, `settings-${value}.png`) });
  await page.getByTestId("dialog-close-button").click();
  await page.getByTestId("settings-dialog").waitFor({ state: "hidden", timeout: 5_000 });
}

async function searchAll(page: Page): Promise<void> {
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
  await dismissStartupDialogs(page);
  await page.getByTestId("search-allperiod-chip").click();
  await page.getByTestId("search-submit-button").click();
}

/** 2D ビューアで s を開き、3 枚それぞれのキャンバスだけのスクリーンショット（4 隅の文字は隠す）を返す。 */
async function viewerShots(driver: DesktopDriver, page: Page, s: Study, name: string): Promise<Buffer[]> {
  await page.locator(`[data-testid="study-row-${s.studyUid}"]`).click();
  await page.locator(`[data-testid="series-row-${s.seriesUid}"]`).click();
  const viewer = await driver.waitForNewPage(() => page.getByTestId("viewer2d-toolbar-button").click(), (u) => u.includes("2dviewer"));
  const host = viewer.getByTestId("viewer2d-canvas-host").first();
  await host.waitFor({ state: "visible", timeout: 30_000 });
  await viewer.addStyleTag({ content: '[data-testid^="corner-text"]{display:none !important}' });
  await viewer.waitForTimeout(2_500); // 描画の完了待ち（画素の読み込み・復号）
  const out: Buffer[] = [];
  for (let i = 0; i < 3; i++) {
    if (i > 0) {
      await host.hover();
      await viewer.mouse.wheel(0, 120); // 次のスライスへ
      await viewer.waitForTimeout(1_500);
    }
    const buf = await host.screenshot();
    fs.writeFileSync(path.join(OUT_DIR, `${name}-slice${i + 1}.png`), buf);
    out.push(buf);
  }
  await viewer.close({ runBeforeUnload: true });
  return out;
}

async function main(): Promise<void> {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const { dir, truth } = synth();
  const bin = findStorescu();
  const driver = new DesktopDriver();
  const base = `http://127.0.0.1:${driver.ports.http}`;
  const scp = driver.ports.scp;
  const sizeOnDisk = (s: "a" | "b" | "c") => fs.readdirSync(path.join(dir, s)).reduce((n, f) => n + fs.statSync(path.join(dir, s, f)).size, 0);

  try {
    await driver.start();
    const page = driver.page;
    await resetDb(driver.ports.http);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
    await dismissStartupDialogs(page);

    console.log("\n[0] 前提（検出器が空振りでないこと）");
    // UID の長さが違うだけで数バイトずれる。圧縮で大きく変わるかを見るので、同程度であればよい
    check(Math.abs(sizeOnDisk("a") - sizeOnDisk("b")) < 64, "送るファイルの大きさは a と b でほぼ同じ", [sizeOnDisk("a"), sizeOnDisk("b")]);
    // 設定は reset の対象外で、前回の実行の「オン」が残る。基準を作るため、はじめにオフへ戻す（既定がオフであることは単体テストが見る）。
    await fetch(`${base}/api/settings`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ "dicom.receiveCompress": "off" }) });
    const st0 = await getJson<{ mode: string; available: boolean }>(base, "/api/dicom/receive-compress/status");
    check(st0.mode === "off", "開始時はオフ", st0);
    check(st0.available === true, "圧縮のネイティブが使える（使えないなら以降は成立しない）", st0);

    console.log("\n[1] 設定オフで b を受信（基準）");
    storescu(bin, scp, path.join(dir, "b"));
    const ib = await instances(base, truth.b);
    check(ib.length === 3, "b の 3 枚が索引にある", ib);
    check(ib.every((i) => i.transferSyntaxUid === EVR_LE), "オフでは非圧縮（Explicit VR Little Endian）のまま", ib.map((i) => i.transferSyntaxUid));

    console.log("\n[2] 設定画面でオンにして a を受信");
    await setCompressViaUi(page, "jpegls");
    const saved = await getJson<Record<string, string>>(base, "/api/settings");
    check(saved["dicom.receiveCompress"] === "jpegls", "設定が backend に保存された", saved["dicom.receiveCompress"]);
    storescu(bin, scp, path.join(dir, "a"));
    const ia = await instances(base, truth.a);
    check(ia.length === 3, "a の 3 枚が索引にある", ia);
    check(ia.every((i) => i.transferSyntaxUid === JPEGLS), "オンでは JPEG-LS 可逆（…4.80）になった", ia.map((i) => i.transferSyntaxUid));
    const fa = await Promise.all(truth.a.sops.map((s) => storedFile(base, truth.a, s)));
    const fb = await Promise.all(truth.b.sops.map((s) => storedFile(base, truth.b, s)));
    const sa = fa.reduce((n, b) => n + b.length, 0);
    const sb = fb.reduce((n, b) => n + b.length, 0);
    check(sa < sb, `保管庫のファイルが小さくなった（${sa} < ${sb} バイト）`, [sa, sb]);
    const st1 = await getJson<{ compressed: number; failed: number; skipped: Record<string, number> }>(base, "/api/dicom/receive-compress/status");
    check(st1.compressed === 3 && st1.failed === 0, "状態: 圧縮 3 件・失敗 0", st1);

    console.log("\n[3] c（画素が一部違う）はオンで受信し、あとで負例に使う");
    storescu(bin, scp, path.join(dir, "c"));
    const stC = await getJson<{ compressed: number }>(base, "/api/dicom/receive-compress/status");
    check(stC.compressed === 6, "状態: a と c の計 6 件を圧縮した", stC);

    console.log("\n[4] 2D ビューアの表示画素（a と b は一致、c は不一致。差は表示で見える大きさ）");
    await searchAll(page);
    await page.locator(`[data-testid="study-row-${truth.a.studyUid}"]`).waitFor({ state: "visible", timeout: 20_000 });
    const shotB = await viewerShots(driver, page, truth.b, "viewer-b-uncompressed").catch(async (e) => {
      const diag = await Promise.race([
        page.evaluate(() => new Promise((res) => {
          const t0 = performance.now();
          requestAnimationFrame(() => res({ vis: document.visibilityState, focus: document.hasFocus(), rafMs: Math.round(performance.now() - t0), btn: (document.querySelector('[data-testid="viewer2d-toolbar-button"]') as HTMLButtonElement | null)?.disabled })); setTimeout(() => res({ vis: document.visibilityState, rafMs: "no-raf-in-3s" }), 3000);
        })),
        new Promise((res) => setTimeout(() => res("evaluate-hung"), 8000)),
      ]);
      console.log("DIAG", JSON.stringify(diag));
      throw e;
    });
    const shotA = await viewerShots(driver, page, truth.a, "viewer-a-jpegls");
    const shotC = await viewerShots(driver, page, truth.c, "viewer-c-differs");
    check(shotB[0].length > 2_000, "基準の表示が空でない（画像が描かれている）", shotB[0].length);
    check(!shotB[0].equals(shotB[1]) && !shotB[1].equals(shotB[2]), "基準の 3 枚は互いに違う画像（スライス送りが効いている）", shotB.map((b) => b.length));
    for (let i = 0; i < 3; i++) {
      check(shotA[i].equals(shotB[i]), `圧縮して受信した a の ${i + 1} 枚目の表示が、非圧縮の b と画素まで一致する`, [shotA[i].length, shotB[i].length]);
    }
    check(shotC[0].equals(shotB[0]) && shotC[2].equals(shotB[2]), "c は 1・3 枚目が b と同じ（比較が安定している）", [shotC[0].length, shotB[0].length]);
    check(!shotC[1].equals(shotB[1]), "負例: 画素が違う c の 2 枚目は b と一致しない（比較器が差を見抜く）", [shotC[1].length, shotB[1].length]);

    console.log("\n[5] 多重圧縮の禁止: 圧縮済みの a を再送しても、保管庫のファイルが 1 バイトも変わらない");
    const resendDir = path.join(OUT_DIR, "resend");
    fs.mkdirSync(resendDir, { recursive: true });
    fa.forEach((b, i) => fs.writeFileSync(path.join(resendDir, `a${i}.dcm`), b)); // 保管庫の（圧縮済み）ファイルをそのまま送る
    const skippedBefore = (await getJson<{ skipped: Record<string, number> }>(base, "/api/dicom/receive-compress/status")).skipped["already-compressed"] ?? 0;
    storescu(bin, scp, resendDir);
    const fa2 = await Promise.all(truth.a.sops.map((s) => storedFile(base, truth.a, s)));
    check(fa2.every((b, i) => b.equals(fa[i])), "再送後の保管庫のファイルが、再送前と同一（バイト一致）");
    const st2 = await getJson<{ compressed: number; skipped: Record<string, number> }>(base, "/api/dicom/receive-compress/status");
    check((st2.skipped["already-compressed"] ?? 0) === skippedBefore + 3, "状態: 圧縮済みで見送り +3 件", st2);
    check(st2.compressed === stC.compressed, "再送で圧縮件数が増えていない（多重圧縮なし）", [stC.compressed, st2.compressed]);
  } finally {
    await driver.stop();
  }
  process.exitCode = summary() === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
