/*
 * ホイール診断（環境設定 > ビューア）を実アプリで確かめるスパイク。
 *
 * 実行:  cd automator && GRAPHY_AUTOMATOR_VITE_PORT=18293 timeout 300 npx tsx src/spike/wheelDiagnosticsCheck.ts
 *   前に backend の jar を作り直しておく（古い jar を掴まないため）。ポートは 18290・18291・18293。
 *
 * ホイールは CDP の Input.dispatchMouseEvent（type: mouseWheel）で送る。**既知の deltaY を送って、表の値が一致するかを見る**。
 * ⚠️ CDP の合成入力は実機のマウスの値の代わりにならない。ハイパースクロール付き・ノッチ付きの実機での測定は別に行う（未達）。
 */
import fs from "node:fs";
import path from "node:path";

import { DesktopDriver } from "../driver/desktopDriver.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "wheel-diagnostics-check");
let passed = 0;
const failures: string[] = [];
function check(cond: boolean, label: string, detail?: unknown): void {
  if (cond) {
    passed++;
    console.log(`  [ok  ] ${label}`);
  } else {
    console.log(`  [FAIL] ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
    failures.push(label);
  }
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const d = new DesktopDriver({ http: 18290, scp: 18291 });
  await d.start();
  try {
    const main = d.page;
    await main.reload();
    await main.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
    // 更新のお知らせ（「新しい版があります」）が画面を覆うことがある。「後で（Later）」で閉じる（版のスキップはしない）。
    const later = main.getByRole("button", { name: "Later", exact: true });
    const shown = await later.waitFor({ state: "visible", timeout: 8000 }).then(() => true, () => false);
    if (shown) await later.click();
    await main.getByTestId("mainscreen-menu-system").click();
    await main.getByTestId("menu-item-settings").click();
    await main.getByTestId("settings-dialog").waitFor({ state: "visible", timeout: 10_000 });
    await main.getByTestId("settings-cat-viewer").click();
    const diag = main.getByTestId("wheel-diag");
    await diag.waitFor({ state: "attached", timeout: 10_000 });
    await diag.scrollIntoViewIfNeeded();
    await diag.locator("summary").click(); // 折りたたみを開く
    const pad = main.getByTestId("wheel-diag-pad");
    await pad.scrollIntoViewIfNeeded();
    const box = (await pad.boundingBox())!;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    const cdp = await main.context().newCDPSession(main);
    const wheel = async (x: number, y: number, deltaY: number) => {
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: 0, deltaY });
    };
    const summary = async () => {
      const el = main.getByTestId("wheel-diag-summary");
      return { count: Number(await el.getAttribute("data-count")), slices: Number(await el.getAttribute("data-slices")) };
    };
    const rowVals = async () => main.getByTestId("wheel-diag-row").evaluateAll((els) => els.map((e) => ({ dy: Number((e as HTMLElement).dataset.dy), mode: Number((e as HTMLElement).dataset.mode), step: Number((e as HTMLElement).dataset.step) })));

    console.log("① 開いた直後");
    let s = await summary();
    check(s.count === 0 && s.slices === 0, "0 件", s);

    console.log("② 離散ノッチ（deltaY=100 を 5 回）");
    for (let i = 0; i < 5; i++) { await wheel(cx, cy, 100); await main.waitForTimeout(40); }
    await main.waitForTimeout(300);
    s = await summary();
    check(s.count === 5 && s.slices === 5, "5 件・スライス 5", s);
    let rows = await rowVals();
    check(rows.length === 5 && rows.every((r) => r.dy === 100 && r.mode === 0 && r.step === 1), "表の deltaY・deltaMode・スライスが送った値と一致", rows);
    await main.screenshot({ path: path.join(OUT_DIR, "1-notch.png") });

    console.log("③ クリア → 細かい連続（deltaY=4 を 20 回 = 80px）");
    await main.getByTestId("wheel-diag-clear").click();
    s = await summary();
    check(s.count === 0, "クリアで 0 件", s);
    for (let i = 0; i < 20; i++) { await wheel(cx, cy, 4); await main.waitForTimeout(20); }
    await main.waitForTimeout(300);
    s = await summary();
    rows = await rowVals();
    check(s.count === 20 && s.slices === 2, "20 件・スライス 2（40px ごと）", s);
    check(rows.length === 20 && rows.every((r) => r.dy === 4 && r.mode === 0), "表の値が送った値と一致（deltaY=4）", rows.slice(0, 3));
    await main.screenshot({ path: path.join(OUT_DIR, "2-fine.png") });

    console.log("④ 逆向き（deltaY=-100）と、枠の外");
    await main.getByTestId("wheel-diag-clear").click();
    await wheel(cx, cy, -100);
    await main.waitForTimeout(200);
    rows = await rowVals();
    check(rows.length === 1 && rows[0].dy === -100 && rows[0].step === -1, "逆向きは deltaY=-100・スライス -1", rows);
    const before = await summary();
    const outside = (await main.getByTestId("wheel-diag-summary").boundingBox())!;
    await wheel(outside.x + 10, outside.y + 4, 100); // 枠の外（要約の行の上）
    await main.waitForTimeout(300);
    const after = await summary();
    check(after.count === before.count, "枠の外のホイールは記録されない（負例）", { before, after });

    console.log("⑤ レポート");
    const report = await main.getByTestId("wheel-diag-report").inputValue();
    check(report.includes("イベント数: 1") && report.includes("40px で 1 スライス"), "レポートにイベント数とビューアの定数が入る", report.slice(0, 200));
    await main.screenshot({ path: path.join(OUT_DIR, "3-report.png") });
  } finally {
    await d.stop();
  }
  console.log(`\n合格 ${passed} / 失敗 ${failures.length}`);
  if (failures.length) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
