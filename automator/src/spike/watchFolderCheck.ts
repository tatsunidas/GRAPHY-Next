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

    console.log("\n[0] 前提: web でない backend（standalone）で状態 API が 200");
    const st = await fetch(`${base}/api/import/watch/status`);
    check(st.status === 200, "GET /api/import/watch/status が 200", st.status);
    check((await studyCount()) === 0, "操作前は対象の検査が 0 件（検出器が空振りでないことの前提）");

    console.log("\n[1] 画面で有効化");
    await page.getByTestId("mainscreen-menu-system").click();
    await page.getByTestId("menu-item-settings").click();
    await page.getByTestId("settings-cat-importWatch").click();
    await page.getByTestId("import-watch-panel").waitFor({ state: "visible", timeout: 10_000 });
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

    console.log("\n[4] 非 DICOM はスキップ、壊れた DICOM は失敗");
    fs.writeFileSync(path.join(WATCH_DIR, "readme.txt"), "not dicom");
    fs.writeFileSync(path.join(WATCH_DIR, "bad.dcm"), bytes.subarray(0, 140));
    check(await until(async () => (await num(page, "import-watch-failed")) === 1 && (await num(page, "import-watch-skipped")) === 1, 6 * INTERVAL_SEC * 1000), "スキップ 1・失敗 1", { skipped: await num(page, "import-watch-skipped"), failed: await num(page, "import-watch-failed") });
    check((await page.getByTestId("import-watch-failures").innerText()).includes("bad.dcm"), "失敗はパス付きで画面に出る");
    check((await num(page, "import-watch-imported")) === slices.length, "他の取込は影響を受けない");
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
