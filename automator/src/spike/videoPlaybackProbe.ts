/*
 * 動画の再生コントロールの挙動を実機で測る**診断用**プローブ。
 *
 * 実行:  cd automator && npx tsx src/spike/videoPlaybackProbe.ts
 *
 * 利用者の報告（2026-09-06）:
 *   ① 再生ボタンを押しても再生されない
 *   ② ボタンが「一時停止」に切り替わらない
 *   ③ Loop のチェックを**外すと**ループする（逆）
 *
 * 🔴 これは合否ではなく**事実を測る**ためのもの。推測で直す前に、何が起きているかを数字で見る。
 */
import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";

import { DesktopDriver } from "../driver/desktopDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { importNonDicomPaths } from "../fixtures/importFixtures.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { waitForMainScreenReady } from "../checklist/items/shared/helpers.js";
import { dismissStartupDialogs } from "../common/dismissDialogs.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "video-playback-probe");
const FIXTURE = path.join(AUTOMATOR_ROOT, "fixtures", "video-mp4-avi", "tic-ramp.mp4");

interface Snap {
  t: number;
  btn: string;
  seek: number;
  frameText: string;
  /** 内部の `<video>`（VideoViewport が作る）の実状態。 */
  vidPaused: boolean | null;
  vidLoop: boolean | null;
  vidTime: number | null;
  loopChecked: boolean | null;
}

async function snap(page: Page, t: number): Promise<Snap> {
  return (await page.evaluate(`(() => {
    const play = document.querySelector('[data-testid="video-play"]');
    const seek = document.querySelector('[data-testid="video-seek"]');
    const ind = document.querySelector('[data-testid="video-frame-indicator"]');
    const cb = document.querySelector('[data-testid="video-loop"]');
    // VideoViewport は <video> を DOM に付けないことがあるので、document 全体から探す。
    const v = document.querySelector('video');
    return JSON.stringify({
      t: ${t},
      btn: play ? (play.getAttribute('data-playing') === '1' ? '⏸(playing)' : '▶(paused)') : '(無し)',
      seek: seek ? Number(seek.value) : -1,
      frameText: ind ? (ind.textContent || '').trim() : '',
      vidPaused: v ? v.paused : null,
      vidLoop: v ? v.loop : null,
      vidTime: v ? Number(v.currentTime.toFixed(3)) : null,
      loopChecked: cb ? cb.checked : null,
    });
  })()`).then((s) => JSON.parse(s as string))) as Snap;
}

async function series(page: Page, label: string, ms: number[]): Promise<Snap[]> {
  const out: Snap[] = [];
  let prev = 0;
  for (const m of ms) {
    await page.waitForTimeout(m - prev);
    prev = m;
    out.push(await snap(page, m));
  }
  console.log(`  [${label}]`);
  for (const s of out) {
    console.log(
      `    t=${String(s.t).padStart(5)}ms  btn=${s.btn}  seek=${String(s.seek).padStart(3)}  ` +
        `video{paused=${s.vidPaused} loop=${s.vidLoop} t=${s.vidTime}}  "${s.frameText}"`,
    );
  }
  return out;
}

async function clickPlay(page: Page): Promise<void> {
  await page.evaluate(`(() => {
    const play = document.querySelector('[data-testid="video-play"]');
    if (play) play.click();
  })()`);
}

async function main(): Promise<void> {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const driver = new DesktopDriver();
  await driver.start();
  try {
    const mainPage = driver.page;
    mainPage.on("dialog", (d) => void d.accept().catch(() => {}));
    await resetDb(driver.ports.http);
    await importNonDicomPaths(driver.ports.http, [FIXTURE], {
      patientId: "VIDEOPLAY",
      patientName: "VIDEO^PLAY",
    });
    await waitForMainScreenReady(mainPage, 60_000);
    await dismissStartupDialogs(mainPage);
    const dates = mainPage.locator('input[type="date"]');
    await dates.nth(0).fill("");
    await dates.nth(1).fill("");
    await mainPage.getByTestId("search-submit-button").click();
    await mainPage.waitForTimeout(1_200);
    await mainPage.locator('[data-testid^="study-row-"]').first().click();
    await mainPage.waitForTimeout(700);
    await mainPage.locator('[data-testid^="series-row-"]').first().click();
    await mainPage.waitForTimeout(400);
    const viewer = await driver.waitForNewPage(
      () => mainPage.getByTestId("viewer2d-toolbar-button").click(),
      (url) => url.includes("2dviewer"),
    );
    await viewer.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 30_000 });
    await viewer.waitForTimeout(4_000);

    console.log("\n===== ① 開いた直後（何もしていない） =====");
    const a = await series(viewer, "初期", [0, 500, 1500]);

    console.log("\n===== ② 再生ボタンを押した直後 =====");
    await clickPlay(viewer);
    const b = await series(viewer, "play 押下後", [100, 400, 1000, 2000]);

    console.log("\n===== ③ もう一度押す（一時停止のはず） =====");
    await clickPlay(viewer);
    const c = await series(viewer, "2 回目", [100, 800]);

    console.log("\n===== ④ Loop のチェックを外して再生 =====");
    await viewer.evaluate(`(() => {
      const cb = document.querySelector('[data-testid="video-loop"]');
      if (cb && cb.checked) cb.click();
    })()`);
    await viewer.waitForTimeout(400);
    await clickPlay(viewer);
    const d = await series(viewer, "loop 外して play", [100, 1000, 2500, 4000]);

    fs.writeFileSync(
      path.join(OUT_DIR, "probe.json"),
      JSON.stringify({ initial: a, play: b, second: c, noLoop: d }, null, 2),
    );
    await viewer.screenshot({ path: path.join(OUT_DIR, "viewer.png") }).catch(() => {});
  } finally {
    await driver.stop().catch(() => {});
  }
  console.log(`\n成果物: ${OUT_DIR}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
