/*
 * モニター診断の「配置の略図・並び・向き・画素数」を実アプリで確かめるスパイク。
 *
 * 実行:  cd automator && GRAPHY_AUTOMATOR_VITE_PORT=18293 timeout 300 npx tsx src/spike/monitorLayoutCheck.ts
 *   前に backend の jar を作り直しておく（古い jar を掴まないため）。ポートは 18290・18291・18293。
 *
 * 真値は Electron の main プロセスの `screen.getAllDisplays()` の**生の値**。そこから、画面の値と**別に**（この検査の中で）予測を計算して照合する
 * （向き・物理画素・メガピクセル・並び）。接続されているモニターだけが対象。
 * ⚠️ 複数モニタ（縦回転を含む）の実機の確認は別に行う（未達）。この検査が見るのは、この環境で接続されているモニターの枚数ぶん。
 */
import fs from "node:fs";
import path from "node:path";

import { DesktopDriver } from "../driver/desktopDriver.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "monitor-layout-check");
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

interface RawDisplay { id: number; bounds: { x: number; y: number; width: number; height: number }; scaleFactor: number; rotation: number; size: { width: number; height: number } }

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

    // 真値: main プロセスの生の値
    const raw: RawDisplay[] = await d.app.evaluate(({ screen }) =>
      screen.getAllDisplays().map((x: { id: number; bounds: { x: number; y: number; width: number; height: number }; scaleFactor: number; rotation: number; size: { width: number; height: number } }) => ({ id: x.id, bounds: x.bounds, scaleFactor: x.scaleFactor, rotation: x.rotation, size: x.size })),
    );
    console.log(`  [info] 接続されているモニター: ${raw.length} 枚 ${JSON.stringify(raw.map((r) => ({ b: r.bounds, s: r.scaleFactor, rot: r.rotation })))}`);

    await main.getByTestId("mainscreen-menu-system").click();
    await main.getByTestId("menu-item-settings").click();
    await main.getByTestId("settings-dialog").waitFor({ state: "visible", timeout: 10_000 });
    await main.getByTestId("settings-cat-monitor").click();
    await main.getByTestId("mqc-layout").waitFor({ state: "visible", timeout: 10_000 });

    // 位置で対応させる（Electron のモニターの id は JavaScript の安全な整数を超えることがある。list-displays は getAllDisplays と同じ順）
    const rows = await main.getByTestId("mqc-display-row").evaluateAll((els) =>
      els.map((e, index) => ({ index, order: (e as HTMLElement).dataset.order, orientation: (e as HTMLElement).dataset.orientation, physical: (e as HTMLElement).dataset.physical, mp: (e as HTMLElement).dataset.mp })),
    );
    const boxes = await main.getByTestId("mqc-layout-box").evaluateAll((els) =>
      els.map((e) => ({ index: Number((e as HTMLElement).dataset.index), order: (e as HTMLElement).dataset.order })),
    );
    check(rows.length === raw.length && boxes.length === raw.length, `表の行・略図の箱が、接続モニターの枚数（${raw.length}）と一致`, { rows: rows.length, boxes: boxes.length });

    // 予測（画面の実装とは別に、ここで計算する）
    const sorted = raw.map((r, i) => ({ r, i })).sort((a, b) => a.r.bounds.x - b.r.bounds.x || a.r.bounds.y - b.r.bounds.y || a.i - b.i);
    for (const [i, r] of raw.entries()) {
      const expOrder = String(sorted.findIndex((x) => x.i === i) + 1);
      const expOrient = r.bounds.height > r.bounds.width ? "portrait" : r.bounds.width > r.bounds.height ? "landscape" : "square";
      const pw = Math.round(r.bounds.width * r.scaleFactor);
      const ph = Math.round(r.bounds.height * r.scaleFactor);
      const exact = Math.abs(r.bounds.width * r.scaleFactor - pw) < 1e-6 && Math.abs(r.bounds.height * r.scaleFactor - ph) < 1e-6;
      const expPhysical = `${exact ? "" : "≈"}${pw}×${ph}`;
      const expMp = ((pw * ph) / 1e6).toFixed(1);
      const row = rows[i];
      const box = boxes.find((x) => x.index === i);
      check(!!row && row.order === expOrder && box?.order === expOrder, `モニター #${i + 1}: 並び ${expOrder}（表・略図）`, { row, box });
      check(row?.orientation === expOrient, `モニター #${i + 1}: 向き ${expOrient}`, row);
      check(row?.physical === expPhysical, `モニター #${i + 1}: 物理画素 ${expPhysical}`, row);
      check(row?.mp === expMp, `モニター #${i + 1}: ${expMp} MP`, row);
    }
    // 既存の表の中身が残る
    const text = (await main.getByTestId("mqc-display-row").first().textContent()) ?? "";
    check(/\d+×\d+/.test(text) && (await main.getByTestId("mqc-display-row").first().locator("button").count()) === 1, "既存の列（解像度・パターン表示ボタン）が残る", text.slice(0, 120));
    await main.screenshot({ path: path.join(OUT_DIR, "1-monitor-layout.png") });
    // 表の行まで画面を送って撮る（略図の撮影では表が下に隠れる）
    await main.getByTestId("mqc-display-row").first().scrollIntoViewIfNeeded();
    await main.screenshot({ path: path.join(OUT_DIR, "2-monitor-table.png") });
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
