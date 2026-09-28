/*
 * メイン画面のプラグイン host（H42）と、共通の host API（H43〜H46）の実機検証。
 *
 * 実行:  cd automator && npx tsx src/spike/mainScreenHostCheck.ts
 *
 * 確かめること（本物の Electron ＋ backend ＋ プラグイン配信経路）:
 *   1. `mainscreen.menu` のプラグインがメイン画面のプラグインメニューに出て、押すと窓が開く（H42 openWindow）。
 *      窓には本体が入れる出所（プラグイン名）が出る
 *   2. H44 `db.searchPatients` が取り込んだ患者を返し、部分一致で絞れる
 *   3. H42 保存領域: patientKey を渡して書いて読める。古い版で書くと衝突として弾かれる
 *   4. H45 `runBackendJob`: JAR が `__progress` で報告した進み具合が画面側に届き、結果が返る。
 *      取り消すと JAR が `__cancelled` を見て止まり「取り消し」として返る。JAR の例外は `{ok:false, error}`。
 *      同期の `runBackend` では `__progress` が渡らない
 *   5. H46 `db.notifyChanged`: 呼んだウィンドウ（メイン画面）自身が一覧を読み直す
 *   6. H43 `file.pickFiles` は関数として渡っている（OS のダイアログは自動では押せないので、選ぶ操作は手で確かめる）
 *
 * 前提: backend jar（`cd backend && mvn -q -Dfrontend.skip=true -DskipTests package`。
 *       `target/graphy-next-backend-plugin-api.jar` も同時にできる）と、videoDisplayOpsCheck が作る 4 象限の動画。
 *       検証用プラグインの原本は `automator/plugins/mainscreen-host-check/`。JAR はここで javac で組む。
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
const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "mainscreen-host-check");
const SRC_DIR = path.join(AUTOMATOR_ROOT, "plugins", PLUGIN_ID);
const SPI_JAR = path.join(AUTOMATOR_ROOT, "..", "backend", "target", "graphy-next-backend-plugin-api.jar");

const failures: string[] = [];
let passed = 0;
function check(cond: boolean, label: string, detail?: unknown): void {
  const d = detail === undefined ? "" : ` — ${JSON.stringify(detail)}`;
  if (cond) {
    passed++;
    console.log(`  [ok  ] ${label}${d}`);
  } else {
    console.log(`  [FAIL] ${label}${d}`);
    failures.push(label);
  }
}

/** 検証用プラグインを組んで backend の plugins フォルダへ置く（JAR は SPI の JAR だけに依存）。 */
function installPlugin(): void {
  if (!fs.existsSync(SPI_JAR)) throw new Error(`SPI の JAR がありません（backend を package してください）: ${SPI_JAR}`);
  const dst = path.join(DESKTOP_RUN_DATA_DIR, "plugins", PLUGIN_ID);
  fs.rmSync(dst, { recursive: true, force: true });
  fs.mkdirSync(dst, { recursive: true });
  for (const name of ["plugin.json", "ui.js"]) fs.copyFileSync(path.join(SRC_DIR, name), path.join(dst, name));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "jobprobe-"));
  execFileSync("javac", ["--release", "17", "-cp", SPI_JAR, "-d", work, path.join(SRC_DIR, "java", "JobProbe.java")], {
    stdio: "inherit",
  });
  execFileSync("jar", ["--create", "--file", path.join(dst, "job-probe.jar"), "-C", work, "."], { stdio: "inherit" });
  fs.rmSync(work, { recursive: true, force: true });
  console.log(`検証用プラグインを配置: ${dst}`);
}

/** host のメソッドをページの中で呼ぶ（プラグインが window.__mainHost に置いた host そのもの）。 */
function inHost<T>(page: Page, body: string): Promise<T> {
  return page.evaluate(`(async () => { const host = window.__mainHost; ${body} })()`) as Promise<T>;
}

async function main(): Promise<void> {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  installPlugin();
  const driver = new DesktopDriver();
  await driver.start();
  try {
    const page = driver.page;
    const pageErrors: string[] = [];
    page.on("pageerror", (e) => pageErrors.push(String(e?.stack ?? e)));
    page.on("dialog", (d) => void d.accept().catch(() => {}));
    await resetDb(driver.ports.http);
    // 患者は 1 人あれば足りる。videoDisplayOpsCheck の 4 象限の動画を借りる（無ければ先にそちらを回す）
    const video = path.join(AUTOMATOR_ROOT, "fixtures", "video-mp4-avi", "display-ops", "quadrants.mp4");
    if (!fs.existsSync(video)) throw new Error(`fixture がありません（videoDisplayOpsCheck を先に回すと作られる）: ${video}`);
    const imported = await importNonDicomPaths(driver.ports.http, [video], {
      patientId: "HOSTCHK-001",
      patientName: "HOST^CHECK",
      seriesDescription: "host check",
    });
    console.log(`fixture import: ${JSON.stringify(imported)}`);
    await page.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
    await dismissStartupDialogs(page);

    // ── 1. メニューから開く
    await page.getByTestId("mainscreen-menu-plugins").click();
    await page.getByTestId(`plugin-item-${PLUGIN_ID}`).click();
    await page.getByTestId("mainscreen-host-check-panel").waitFor({ state: "visible", timeout: 20_000 });
    const panelText = (await page.getByTestId("mainscreen-host-check-panel").textContent()) ?? "";
    check(panelText.includes("surface=mainscreen.menu"), "[1] ★メイン画面のプラグインメニューから開け、窓が出る（H42 openWindow）", panelText);
    const origin = await page.evaluate(() => document.body.innerText.includes("Main Screen Host Check"));
    check(origin, "[1b] 窓に出所（プラグイン名）が出る");
    await page.screenshot({ path: path.join(OUT_DIR, "1-window.png") }).catch(() => {});
    const kinds = await inHost<Record<string, string>>(
      page,
      `return {
        pickFiles: typeof host.file.pickFiles, saveAs: typeof host.file.saveAs,
        runBackendJob: typeof host.runBackendJob, search: typeof host.db.searchPatients,
        notify: typeof host.db.notifyChanged, load: typeof host.loadStore, save: typeof host.saveStore,
        del: typeof host.deleteStore };`,
    );
    check(Object.values(kinds).every((k) => k === "function"), "[1c] H42〜H46 の関数がそろって渡っている（H43 pickFiles を含む）", kinds);

    // ── 2. 患者検索
    const all = await inHost<{ patientKey: string; patientId: string; patientName: string; studyCount: number }[]>(
      page,
      `return host.db.searchPatients("");`,
    );
    check(all.length >= 1 && all.every((p) => p.patientKey && p.studyCount >= 1), "[2] ★searchPatients が取り込んだ患者を返す", all);
    const target = all[0];
    const part = (target?.patientId || target?.patientName || "").slice(0, 3);
    const hit = await inHost<{ patientKey: string }[]>(page, `return host.db.searchPatients(${JSON.stringify(part)});`);
    check(hit.some((p) => p.patientKey === target?.patientKey), "[2b] 部分一致で絞れる", { part, hit: hit.length });
    const none = await inHost<unknown[]>(page, `return host.db.searchPatients("__no_such_patient__");`);
    check(none.length === 0, "[2c] 当たらなければ空");

    // ── 3. 保存領域
    const store = await inHost<{ first: unknown; loaded: { json: string | null; version: number | null }; stale: unknown }>(
      page,
      `const key = ${JSON.stringify(target?.patientKey ?? "")};
       await host.deleteStore(key);
       const first = await host.saveStore(JSON.stringify({ n: 1 }), { patientKey: key, version: null });
       const loaded = await host.loadStore(key);
       const stale = await host.saveStore(JSON.stringify({ n: 2 }), { patientKey: key, version: null });
       return { first, loaded, stale };`,
    );
    check(
      (store.first as { ok?: boolean }).ok === true && store.loaded.json === JSON.stringify({ n: 1 }),
      "[3] ★patientKey を渡して保存領域に書いて読める（H42）",
      store,
    );
    check((store.stale as { conflict?: boolean }).conflict === true, "[3b] 古い版（null）で書くと衝突として弾かれる", store.stale);

    // ── 4. ジョブ
    const job = await inHost<{ outcome: { ok: boolean; result?: { steps: number; hadProgress: boolean } }; seen: [number, string][] }>(
      page,
      `const seen = [];
       const outcome = await host.runBackendJob({ op: "progress" }, { pollMs: 100, onProgress: (p, m) => seen.push([p, m]) });
       return { outcome, seen };`,
    );
    check(job.outcome.ok && job.outcome.result?.steps === 5 && job.outcome.result.hadProgress, "[4] ★runBackendJob が JAR の結果を返す（JAR に __progress が渡る）", job.outcome);
    const mids = job.seen.filter(([p]) => p > 0 && p < 1);
    check(mids.length >= 1 && mids.every(([, m]) => /^step \d$/.test(m)), "[4b] ★途中の進み具合と説明が画面側に届く", job.seen);
    const cancel = await inHost<{ ok: boolean; cancelled?: boolean }>(
      page,
      `const ac = new AbortController();
       setTimeout(() => ac.abort(), 600);
       return host.runBackendJob({ op: "wait-cancel" }, { pollMs: 100, signal: ac.signal });`,
    );
    check(cancel.ok === false && cancel.cancelled === true, "[4c] ★取り消すと JAR が __cancelled を見て止まり、取り消しとして返る", cancel);
    const fail = await inHost<{ ok: boolean; error?: string }>(page, `return host.runBackendJob({ op: "fail" }, { pollMs: 100 });`);
    check(fail.ok === false && fail.error === "probe-fail", "[4d] JAR の例外は投げずに {ok:false, error} で返る", fail);
    const sync = (await inHost<{ hadProgress: boolean; hadCancelled: boolean }>(page, `return host.runBackend({ op: "sync" });`)) ?? {};
    check(sync.hadProgress === false && sync.hadCancelled === false, "[4e] 同期の runBackend では __progress / __cancelled は渡らない", sync);

    // ── 5. 一覧の読み直し
    const reloaded = page
      .waitForRequest((r) => /\/api\/studies(\?|$)/.test(r.url()) && r.method() === "GET", { timeout: 10_000 })
      .then(() => true)
      .catch(() => false);
    await inHost(page, `host.db.notifyChanged({ patientId: "x" }); return null;`);
    check(await reloaded, "[5] ★notifyChanged で、呼んだメイン画面自身が一覧を読み直す（H46）");

    check(pageErrors.length === 0, "[6] 画面の例外（pageerror）が 0 件", pageErrors.slice(0, 3));
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
