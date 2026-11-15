/*
 * 描画プロセスが落ちたとき、本体が読み込み直して操作できる状態に戻すかの実機検証
 * （desktop/rendererRecovery.js と main.js の render-process-gone ハンドラ）。
 *
 * 準備:  cd backend && mvn -q -Dfrontend.skip=true -DskipTests package   （古い jar を掴まない）
 * 実行:  cd automator && GRAPHY_AUTOMATOR_HTTP_PORT=28490 GRAPHY_AUTOMATOR_SCP_PORT=28491 GRAPHY_AUTOMATOR_VITE_PORT=28493 \
 *          timeout 300 npx tsx src/spike/rendererRecoveryCheck.ts
 *        負例（ハンドラを外す。検査が落ちるはず）: RECOVERY_NEGATIVE=1 を付ける
 *
 * 確かめること:
 * 1. 落とす（forcefullyCrashRenderer）→ 窓が読み込み直され、検索欄が見える（スクリーンショットでも白くない）＋案内が出る。
 * 2. 読み込み直しの最中にもう一度落とす → 読み込み直さず、「続けて」の案内が出る（歯止め）。
 * 3. 利用者が開き直して（reload）読み込みが終わったあとに落ちたら、また読み込み直す（新しい 1 回目）。
 * 案内（dialog.showMessageBox）は、検査のあいだ main で差し替えて内容を記録する。
 */
import fs from "node:fs";
import path from "node:path";

import { DesktopDriver } from "../driver/desktopDriver.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { waitForMainScreenReady } from "../checklist/items/shared/helpers.js";
import { dismissStartupDialogs } from "../common/dismissDialogs.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "renderer-recovery");
const NEGATIVE = process.env.RECOVERY_NEGATIVE === "1";

let pass = 0;
let fail = 0;
function check(cond: boolean, label: string, detail?: unknown): void {
  if (cond) pass++;
  else fail++;
  console.log(`  [${cond ? "ok  " : "FAIL"}] ${label}${detail === undefined ? "" : ` ${JSON.stringify(detail)}`}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const driver = new DesktopDriver();
  await driver.start();
  try {
    const page = driver.page;
    await waitForMainScreenReady(page);
    await dismissStartupDialogs(page);

    // main に検査用の細工（案内の記録・読み込み開始の数え上げ）。アプリのコードは変えない
    await driver.app.evaluate(({ app, dialog, BrowserWindow }: any, negative: boolean) => {
      const g = globalThis as any;
      g.__dlg = [];
      g.__loads = 0;
      dialog.showMessageBox = async (_w: unknown, o: any) => {
        g.__dlg.push({ message: o.message, detail: o.detail, buttons: o.buttons });
        return { response: 0, checkboxChecked: false };
      };
      const wc = BrowserWindow.getAllWindows().find((w: any) => !w.isDestroyed() && /index\.html|:\d+\/?(#.*)?$/.test(w.webContents.getURL()))!.webContents;
      g.__wc = wc;
      wc.on("did-start-loading", () => g.__loads++);
      if (negative) app.removeAllListeners("render-process-gone");
    }, NEGATIVE);

    const dlgs = (): Promise<{ message: string; detail: string; buttons: string[] }[]> => driver.app.evaluate(() => (globalThis as any).__dlg);
    const loads = (): Promise<number> => driver.app.evaluate(() => (globalThis as any).__loads);
    const crash = () => driver.app.evaluate(() => (globalThis as any).__wc.forcefullyCrashRenderer());
    // 落ちた窓の Playwright の Page は復帰しないので、main から webContents を直接読む（検索欄の有無・画面を白く描いていないか）
    const searchVisible = async (ms: number): Promise<boolean> => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        const ok = await driver.app
          .evaluate(async () => {
            const wc = (globalThis as any).__wc;
            if (wc.isDestroyed() || wc.isCrashed() || wc.isLoading()) return false;
            const probe = wc.executeJavaScript("!!document.querySelector('[data-testid=search-patientid-input]') && document.body.innerText.length > 100").catch(() => false);
            // 落ちかけの窓は結果を返さないことがあるので、2 秒で切る
            return (await Promise.race([probe, new Promise((r) => setTimeout(() => r(false), 2000))])) === true;
          })
          .catch(() => false);
        if (ok) return true;
        await sleep(300);
      }
      return false;
    };
    /** main 側の capturePage で撮る（落ちた Page に依存しない）。 */
    const shot = async (name: string): Promise<void> => {
      const b64: string = await driver.app.evaluate(async () => (await (globalThis as any).__wc.capturePage()).toPNG().toString("base64"));
      fs.writeFileSync(path.join(OUT_DIR, name), Buffer.from(b64, "base64"));
    };

    // 1. 落とす → 読み込み直される
    console.log("\n[1] 描画プロセスを落とす");
    const before = await loads();
    await crash();
    check(await searchVisible(NEGATIVE ? 8_000 : 30_000), "落ちたあと、検索欄が見える（読み込み直された）");
    await shot("1-after-crash.png");
    check((await loads()) === before + 1, "読み込み直しは 1 回", { before, now: await loads() });
    let d = await dlgs();
    check(d.length === 1 && /読み込み直しました/.test(d[0]?.message ?? ""), "案内が出る（読み込み直した旨）", d);
    check(!/Colab/.test(d[0]?.detail ?? ""), "Colab を確保していないので解放の案内は出ない");

    // 2. 読み込み直しの最中にもう一度落とす → 歯止め
    console.log("\n[2] 読み込み直しの最中にもう一度落とす");
    await driver.app.evaluate(() => {
      const wc = (globalThis as any).__wc;
      wc.once("did-start-loading", () => setTimeout(() => wc.forcefullyCrashRenderer(), 30));
    });
    const l2 = await loads();
    await crash();
    await sleep(6_000);
    d = await dlgs();
    check(d.length === 3, "案内が 2 件増える（最初の落ち＋続けての落ち）", d.map((x) => x.message));
    check(/続けて/.test(d[d.length - 1]?.message ?? ""), "最後の案内は「続けて異常終了」");
    check((await loads()) === l2 + 1, "2 回目の落ちでは読み込み直さない（読み込みは最初の 1 回だけ）", { l2, now: await loads() });

    // 3. 利用者が開き直す（reload）→ 読み込み完了 → また落ちたら新しい 1 回目として読み込み直す
    console.log("\n[3] 開き直したあとに落とす");
    await driver.app.evaluate(() => (globalThis as any).__wc.reload());
    check(await searchVisible(30_000), "開き直すと検索欄が見える");
    await shot("3-reopened.png");
    const nDlg = (await dlgs()).length;
    await crash();
    check(await searchVisible(30_000), "読み込みを終えたあとの落ちは、また読み込み直される");
    check((await dlgs()).length === nDlg + 1 && /読み込み直しました/.test((await dlgs()).at(-1)?.message ?? ""), "案内は「読み込み直した」に戻る");
    await shot("3-after-second-crash.png");
  } finally {
    await driver.stop();
  }
  console.log(`\n${pass} passed, ${fail} failed${NEGATIVE ? "（負例: 失敗が出るのが正）" : ""}`);
  process.exitCode = fail > 0 ? 1 : 0;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
