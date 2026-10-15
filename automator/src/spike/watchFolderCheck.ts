/*
 * 監視フォルダからの自動取り込みの実機検証（画面から操作する）。
 *
 * 実行:  cd automator && npx tsx src/spike/watchFolderCheck.ts
 *        （合成 CT の生成に pydicom・numpy のある Python が要る: GRAPHY_TEST_PYTHON、既定は python）
 *        backend の jar が要る: cd backend && mvn -q -Dfrontend.skip=true -DskipTests clean package
 *
 * 流れ: 環境設定 ＞ 自動取り込みを画面で開き、フォルダ・間隔を入れて保存 → 最終走査が進む → 書き込み途中のファイル
 * （半分だけ書き、追記を続ける）は取り込まれず「待機中」 → 書き終えると取り込まれる → 残りをまとめて置く →
 * 非 DICOM はスキップ・壊れた DICOM は失敗（パス付き） → DB フォルダの中は監視先にできない → 無効にすると止まる。
 * 画面の判定はスクリーンショットも見る（.results/watch-folder-check/*.png）。
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";

import type { Page } from "@playwright/test";

import { resetDb } from "../backend/dbReset.js";
import { dismissStartupDialogs } from "../common/dismissDialogs.js";
import { DesktopDriver, DESKTOP_RUN_DATA_DIR } from "../driver/desktopDriver.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { createChecker } from "./computeSpikeShared.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "watch-folder-check");
const PHANTOM_DIR = path.join(OUT_DIR, "phantom");
const WATCH_DIR = path.join(OUT_DIR, "watch");
const INTERVAL_SEC = 2;
const { check, summary } = createChecker();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(fn: () => Promise<boolean>, timeoutMs: number, stepMs = 500): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(stepMs);
  }
  return false;
}

async function num(page: Page, id: string): Promise<number> {
  return Number((await page.getByTestId(id).innerText()).trim());
}

/** 合成 NIfTI-1（int16、6×5×4、間隔 列 2・行 3・スライス 5 mm）。 */
function makeNifti(file: string, seed: number): void {
  const nx = 6, ny = 5, nz = 4;
  const b = Buffer.alloc(352 + nx * ny * nz * 2);
  b.writeInt32LE(348, 0);
  [3, nx, ny, nz, 1, 1].forEach((v, i) => b.writeInt16LE(v, 40 + i * 2));
  b.writeInt16LE(4, 70); // int16
  b.writeInt16LE(16, 72);
  [1, 2, 3, 5, 0, 0, 0, 0].forEach((v, i) => b.writeFloatLE(v, 76 + i * 4));
  b.writeFloatLE(352, 108);
  b.writeFloatLE(1, 112);
  b.writeUInt8(2, 123);
  b.writeInt16LE(1, 254);
  const srow = [[2, 0, 0, 10], [0, 3, 0, 20], [0, 0, 5, 30]];
  srow.forEach((r, ri) => r.forEach((v, i) => b.writeFloatLE(v, 280 + ri * 16 + i * 4)));
  for (let i = 0; i < nx * ny * nz; i++) b.writeInt16LE(seed + i, 352 + i * 2);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, file.endsWith(".gz") ? zlib.gzipSync(b) : b);
}

async function openPanel(page: Page): Promise<void> {
  await page.getByTestId("mainscreen-menu-system").click();
  await page.getByTestId("menu-item-settings").click();
  await page.getByTestId("settings-cat-importWatch").click();
  await page.getByTestId("import-watch-panel").waitFor({ state: "visible", timeout: 10_000 });
}

async function main(): Promise<void> {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(WATCH_DIR, { recursive: true });
  const py = process.env.GRAPHY_TEST_PYTHON ?? "python";
  const gen = spawnSync(py, [path.join(AUTOMATOR_ROOT, "scripts", "make-ct-quant-phantom.py"), PHANTOM_DIR], { encoding: "utf8" });
  if (gen.status !== 0) throw new Error(`ファントムを作れませんでした: ${gen.stderr}`);
  const truth = JSON.parse(fs.readFileSync(path.join(PHANTOM_DIR, "truth.json"), "utf8"));
  const slices = fs.readdirSync(PHANTOM_DIR).filter((f) => f.endsWith(".dcm")).sort();
  console.log(`    合成 CT: ${slices.length} 枚`);

  const driver = new DesktopDriver();
  const base = `http://127.0.0.1:${driver.ports.http}`;
  const studyCount = async (): Promise<number> => {
    const list = (await (await fetch(`${base}/api/studies`)).json()) as { studyInstanceUid: string }[];
    return list.filter((s) => s.studyInstanceUid === truth.studyUid).length;
  };
  const instanceCount = async (): Promise<number> => {
    const res = await fetch(`${base}/api/studies/${truth.studyUid}/series`);
    if (!res.ok) return 0;
    const series = (await res.json()) as { numberOfInstances?: number }[];
    return series.reduce((a, s) => a + (s.numberOfInstances ?? 0), 0);
  };

  try {
    await driver.start();
    const page = driver.page;
    page.on("dialog", (d) => void d.accept());
    await resetDb(driver.ports.http);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
    await dismissStartupDialogs(page);
    // 一覧は「全期間」で検索しておく（取り込みのあと、更新を押すまで一覧が変わらないことを見るため）
    const dates = page.locator('input[type="date"]');
    await dates.nth(0).fill("");
    await dates.nth(1).fill("");
    await page.getByTestId("search-submit-button").click();

    let expected = slices.length;
    console.log("\n[0] 前提: web でない backend（standalone）で状態 API が 200");
    const st = await fetch(`${base}/api/import/watch/status`);
    check(st.status === 200, "GET /api/import/watch/status が 200", st.status);
    check((await studyCount()) === 0, "操作前は対象の検査が 0 件（検出器が空振りでないことの前提）");

    console.log("\n[1] 画面で有効化");
    await openPanel(page);
    await page.screenshot({ path: path.join(OUT_DIR, "01-initial.png") });
    check((await page.getByTestId("import-watch-last").innerText()).trim() !== "" && (await num(page, "import-watch-imported")) === 0, "初期は取込 0");
    check(await page.getByTestId("import-watch-save").isEnabled(), "無効のままなら保存できる");
    await page.getByTestId("import-watch-enabled").check();
    check(!(await page.getByTestId("import-watch-save").isEnabled()), "有効にしてフォルダと間隔が空のうちは保存できない（負例）");
    await page.getByTestId("import-watch-folder").fill(WATCH_DIR);
    await page.getByTestId("import-watch-interval").fill("abc");
    check(!(await page.getByTestId("import-watch-save").isEnabled()), "間隔が数字でないと保存できない（負例）");
    await page.getByTestId("import-watch-interval").fill(String(INTERVAL_SEC));
    await page.getByTestId("import-watch-save").click();
    const last0 = await page.getByTestId("import-watch-last").innerText();
    const advanced = await until(async () => (await page.getByTestId("import-watch-last").innerText()) !== last0, 10_000);
    check(advanced, "保存すると「最終走査」の時刻が進む", last0);
    const last1 = await page.getByTestId("import-watch-last").innerText();
    check(await until(async () => (await page.getByTestId("import-watch-last").innerText()) !== last1, 10_000), "さらに間隔ごとに進み続ける");
    await page.screenshot({ path: path.join(OUT_DIR, "02-enabled.png") });

    console.log("\n[2] 書き込み途中のファイルは取り込まない");
    const first = path.join(PHANTOM_DIR, slices[0]);
    const bytes = fs.readFileSync(first);
    const dest = path.join(WATCH_DIR, slices[0]);
    fs.writeFileSync(dest, bytes.subarray(0, Math.floor(bytes.length / 4)));
    let imported = 0;
    for (let i = 2; i <= 4; i++) {
      await sleep(1500); // 間隔（2 秒）より短い周期で追記し続ける
      fs.appendFileSync(dest, bytes.subarray(Math.floor((bytes.length * (i - 1)) / 4), Math.floor((bytes.length * i) / 4)));
      imported += await num(page, "import-watch-imported");
    }
    check(imported === 0, "追記が続いている間は取込が 0 のまま", imported);
    check((await num(page, "import-watch-waiting")) >= 1, "待機中に数えられる", await num(page, "import-watch-waiting"));
    check((await studyCount()) === 0, "一覧（検査）にも出ない");
    await page.screenshot({ path: path.join(OUT_DIR, "03-writing.png") });
    check(await until(async () => (await num(page, "import-watch-imported")) === 1, 4 * INTERVAL_SEC * 1000 + 4000), "追記が止まると取り込まれる（取込 1）");
    check((await studyCount()) === 1, "検査が一覧に出る");
    check((await instanceCount()) === 1, "画像が 1 枚");
    check(fs.readFileSync(dest).equals(bytes), "元のファイルはフォルダに残り、中身は変わらない");

    console.log("\n[3] 残りをまとめて置く（サブフォルダ含む）");
    const sub = path.join(WATCH_DIR, "p1", "study");
    fs.mkdirSync(sub, { recursive: true });
    for (const f of slices.slice(1)) fs.copyFileSync(path.join(PHANTOM_DIR, f), path.join(sub, f));
    check(await until(async () => (await num(page, "import-watch-imported")) === slices.length, 6 * INTERVAL_SEC * 1000 + 8000), `取込が ${slices.length} になる`, await num(page, "import-watch-imported"));
    check((await instanceCount()) === slices.length, `保管庫の画像が ${slices.length} 枚（重複なし）`, await instanceCount());
    await sleep(3 * INTERVAL_SEC * 1000);
    check((await num(page, "import-watch-imported")) === slices.length && (await instanceCount()) === slices.length, "何回走査しても増えない（1 回しか取り込まない）");

    console.log("\n[3b] 状態バー: 件数・一覧の更新を促す表示");
    const bar = page.getByTestId("statusbar-import-watch");
    const apiImported = async (): Promise<number> => ((await (await fetch(`${base}/api/import/watch/status`)).json()) as { imported: number }).imported;
    check(await until(async () => (await bar.count()) > 0 && (await bar.innerText()).includes(String(slices.length)), 8000), "状態バーの「取込」が増える", await bar.innerText().catch(() => ""));
    check((await apiImported()) === slices.length, "状態バーの数値が backend の状態と一致", await apiImported());
    const newBtn = page.getByTestId("statusbar-import-watch-new");
    check(await until(async () => (await newBtn.count()) > 0, 8000), "「新しい取り込みがあります」が出る");
    check((await newBtn.innerText()).includes(String(slices.length)), "件数が取り込んだ数", await newBtn.innerText());
    await page.screenshot({ path: path.join(OUT_DIR, "03b-statusbar.png") });
    await page.getByTestId("dialog-close-button").click();
    await sleep(500);
    check((await page.locator(`[data-testid="study-row-${truth.studyUid}"]`).count()) === 0, "更新を押すまで、一覧は勝手に変わらない（負例）");
    await newBtn.click();
    await page.locator(`[data-testid="study-row-${truth.studyUid}"]`).waitFor({ state: "visible", timeout: 10_000 });
    check(true, "更新を押すと一覧に検査が出る");
    check(await until(async () => (await newBtn.count()) === 0, 8000), "押したあと、促す表示が消える");
    await page.screenshot({ path: path.join(OUT_DIR, "03c-after-reload.png") });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
    await dismissStartupDialogs(page);
    check(await until(async () => (await bar.count()) > 0, 10_000), "再読み込み後も状態バーに出る");
    await sleep(2 * 3000 + 1000); // 状態バーの問い合わせ周期（3 秒）を 2 回待つ
    check((await newBtn.count()) === 0, "画面を開く前の取込では促さない（負例）");

    console.log("\n[3c] [今すぐ走査]: 間隔を待たずに 1 回走る");
    await openPanel(page);
    await page.getByTestId("import-watch-interval").fill("600");
    await page.getByTestId("import-watch-save").click();
    await sleep(1500);
    const idleLast = await page.getByTestId("import-watch-last").innerText();
    fs.copyFileSync(first, path.join(WATCH_DIR, "now1.dcm"));
    await sleep(3000);
    check((await page.getByTestId("import-watch-last").innerText()) === idleLast, "間隔が 600 秒なら、置いても自動では走査されない（前提）");
    const beforeNow = await num(page, "import-watch-imported");
    await page.getByTestId("import-watch-scan-now").click();
    check(await until(async () => (await num(page, "import-watch-waiting")) === 1, 8000), "1 回押すと走査が走り、待機 1");
    check((await page.getByTestId("import-watch-last").innerText()) !== idleLast, "最終走査の時刻が進む");
    check((await num(page, "import-watch-imported")) === beforeNow, "1 回目はまだ取り込まない（初見）");
    await page.getByTestId("import-watch-scan-now").click();
    check(await until(async () => (await num(page, "import-watch-imported")) === beforeNow + 1, 8000), "もう 1 回押すと取り込まれる");
    expected += 1;
    await page.screenshot({ path: path.join(OUT_DIR, "03d-scan-now.png") });
    await page.getByTestId("import-watch-interval").fill(String(INTERVAL_SEC));
    await page.getByTestId("import-watch-save").click();
    await sleep(1500);

    console.log("\n[3d] NIfTI（患者情報はサイドカー）と、患者情報が無い NIfTI の保留");
    const patientsApi = async (): Promise<{ patientId: string; patientName: string | null }[]> => (await (await fetch(`${base}/api/studies`)).json()) as { patientId: string; patientName: string | null }[];
    const importedNow = await num(page, "import-watch-imported");
    makeNifti(path.join(WATCH_DIR, "subjA", "t1.nii.gz"), 100);
    fs.writeFileSync(path.join(WATCH_DIR, "subjA", "t1.json"), JSON.stringify({ PatientID: "SP-A", PatientName: "Spike^Alpha", PatientBirthDate: "19800102", PatientSex: "F" }));
    makeNifti(path.join(WATCH_DIR, "subjB", "t2.nii.gz"), 200); // 患者情報なし
    fs.copyFileSync(first, path.join(WATCH_DIR, "loose2.dcm")); // DICOM は保留に巻き込まれない
    check(await until(async () => (await num(page, "import-watch-imported")) === importedNow + 2, 8 * INTERVAL_SEC * 1000), "NIfTI（サイドカーつき）と DICOM が取り込まれる", await num(page, "import-watch-imported"));
    expected += 2;
    check(await until(async () => (await num(page, "import-watch-held")) === 1, 4 * INTERVAL_SEC * 1000), "患者情報の無い NIfTI は保留 1");
    check((await page.getByTestId("import-watch-held-items").innerText()).includes("t2.nii.gz"), "保留の警告にパスが出る");
    check((await page.getByTestId("import-watch-error").count()) === 0, "保留は異常ではない（走査は止まらない）");
    const ps = await patientsApi();
    check(ps.some((p) => p.patientId === "SP-A" && p.patientName === "Spike^Alpha"), "NIfTI の患者情報がサイドカーの値で入る");
    check(!ps.some((p) => p.patientId === "NIFTI"), "保留の NIfTI は取り込まれていない（既定の患者が増えていない）");
    await page.screenshot({ path: path.join(OUT_DIR, "03e-held.png") });
    fs.writeFileSync(path.join(WATCH_DIR, "subjB", "t2.json"), JSON.stringify({ PatientID: "SP-B" }));
    check(await until(async () => (await num(page, "import-watch-held")) === 0 && (await patientsApi()).some((p) => p.patientId === "SP-B"), 8 * INTERVAL_SEC * 1000), "あとからサイドカーが揃うと保留が解けて取り込まれる");
    expected += 1;
    await page.screenshot({ path: path.join(OUT_DIR, "03f-held-resolved.png") });

    console.log("\n[4] 非 DICOM はスキップ、壊れた DICOM は失敗");
    fs.writeFileSync(path.join(WATCH_DIR, "readme.txt"), "not dicom");
    fs.writeFileSync(path.join(WATCH_DIR, "bad.dcm"), bytes.subarray(0, 140));
    check(await until(async () => (await num(page, "import-watch-failed")) === 1 && (await num(page, "import-watch-skipped")) === 1, 6 * INTERVAL_SEC * 1000), "スキップ 1・失敗 1", { skipped: await num(page, "import-watch-skipped"), failed: await num(page, "import-watch-failed") });
    check((await page.getByTestId("import-watch-failures").innerText()).includes("bad.dcm"), "失敗はパス付きで画面に出る");
    check((await num(page, "import-watch-imported")) === expected, "他の取込は影響を受けない");
    await page.screenshot({ path: path.join(OUT_DIR, "04-failures.png") });

    console.log("\n[5] DB フォルダの中は監視先にできない");
    const dbDir = path.join(DESKTOP_RUN_DATA_DIR, "data");
    fs.mkdirSync(dbDir, { recursive: true });
    await page.getByTestId("import-watch-folder").fill(dbDir);
    await page.getByTestId("import-watch-save").click();
    check(await until(async () => (await page.getByTestId("import-watch-error").count()) > 0, 8000), "エラーがパネルに出る");
    await page.screenshot({ path: path.join(OUT_DIR, "05-overlap.png") });
    check((await page.getByTestId("import-watch-error").innerText()).match(/循環|loop/) !== null, "理由（循環になる）が読める", await page.getByTestId("import-watch-error").innerText().catch(() => ""));
    await page.getByTestId("import-watch-folder").fill(path.join(OUT_DIR, "no-such-folder"));
    await page.getByTestId("import-watch-save").click();
    check(await until(async () => /見つかりません|not found/.test(await page.getByTestId("import-watch-error").innerText().catch(() => "")), 8000), "存在しないフォルダもエラーが出て、アプリは動き続ける");
    check((await page.getByTestId("import-watch-panel").count()) === 1, "画面は生きている");

    console.log("\n[6] 無効にすると取り込まれず、最終走査も進まない");
    await page.getByTestId("import-watch-folder").fill(WATCH_DIR);
    await page.getByTestId("import-watch-save").click();
    check(await until(async () => (await page.getByTestId("import-watch-error").count()) === 0, 8000), "フォルダを戻すとエラーが消える");
    await page.getByTestId("import-watch-enabled").uncheck();
    await page.getByTestId("import-watch-save").click();
    await sleep(2 * INTERVAL_SEC * 1000);
    const lastOff = await page.getByTestId("import-watch-last").innerText();
    const before = await num(page, "import-watch-imported");
    fs.copyFileSync(first, path.join(WATCH_DIR, "extra.dcm")); // 同じ SOP のコピー（大きさ・時刻は新しいファイル）
    await sleep(4 * INTERVAL_SEC * 1000);
    check((await page.getByTestId("import-watch-last").innerText()) === lastOff, "最終走査の時刻が進まない");
    check((await num(page, "import-watch-imported")) === before, "ファイルを置いても取り込まれない");
    await page.screenshot({ path: path.join(OUT_DIR, "06-disabled.png") });
  } finally {
    await driver.stop();
  }
  const failed = summary();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
