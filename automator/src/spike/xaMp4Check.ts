/*
 * XA シネの **MP4 書き出し**の実機検証（A10・`fw/angio-design.md` §14.3）。
 *
 * 準備:  cd bench && python3 make_phantom_xa.py --out ./phantom --series dsa
 *        cd backend && mvn -q -Dfrontend.skip=true -DskipTests package   ← 古い jar だと偽の失敗
 * 実行:  cd automator && npx tsx src/spike/xaMp4Check.ts
 *
 * 🚨 **「ファイルが落ちてきた」で合格にしない。** 動画は壊れていても再生器によっては
 * 何か映るし、**コマ順が入れ替わっていても絵は出る**。だから
 *   ① MP4 として読めるか（ffprobe）
 *   ② **フレーム数と fps が画面と一致するか**（尺が変わっていないか）
 *   ③ **画面と同じ絵になっているか**
 * まで見る。
 *
 * 🔑 ③の判定は**画面から取る**。1 回目は「DSA のマスク区間は一様なはず」という
 * こちらの思い込みで判定して落ちた——マスクは 5 フレームの平均なので、
 * **1 枚 − 平均はノイズが full amplitude で残る**（造影後の滑らかな血管より荒れる）。
 * ファントムの見た目を予想するのではなく、**同じフレームの画面統計と MP4 の統計を
 * 突き合わせる**（`__graphyDebug.getPixelStats()`）。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";

import { DesktopDriver } from "../driver/desktopDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { importPaths } from "../fixtures/importFixtures.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { waitForMainScreenReady } from "../checklist/items/shared/helpers.js";
import { dismissStartupDialogs, findBlockingOverlay } from "../common/dismissDialogs.js";

const REPO_ROOT = path.resolve(AUTOMATOR_ROOT, "..");
const PHANTOM_DIR = path.join(REPO_ROOT, "bench", "phantom", "GNBP-XA");
const TRUTH_PATH = path.join(PHANTOM_DIR, "truth.json");
const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "xa-mp4");
const HOST = "viewer2d-canvas-host";

const failures: string[] = [];
let passed = 0;

function check(cond: boolean, label: string, detail?: unknown): void {
  if (cond) {
    passed++;
    console.log(`  [ok  ] ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  } else {
    console.log(`  [FAIL] ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
    failures.push(label);
  }
}

interface DsaTruth {
  file: string;
  studyInstanceUid: string;
  maskFrames: number[];
}

/** ffprobe で 1 本目の映像ストリームを読む。 */
function probe(file: string): { frames: number; fps: number; width: number; height: number; codec: string } {
  const out = execFileSync(
    "ffprobe",
    [
      "-v", "error",
      "-select_streams", "v:0",
      "-count_frames",
      "-show_entries", "stream=nb_read_frames,r_frame_rate,width,height,codec_name",
      "-of", "json",
      file,
    ],
    { encoding: "utf8" },
  );
  const s = (JSON.parse(out) as { streams: Record<string, string>[] }).streams[0];
  const [num, den] = String(s.r_frame_rate).split("/").map(Number);
  return {
    frames: Number(s.nb_read_frames),
    fps: den ? num / den : num,
    width: Number(s.width),
    height: Number(s.height),
    codec: String(s.codec_name),
  };
}

/** 指定フレームの画素統計（平均・標準偏差）。 */
function frameStats(file: string, frameIndex: number, workDir: string): { mean: number; sd: number } {
  const png = path.join(workDir, `probe-${frameIndex}.png`);
  execFileSync(
    "ffmpeg",
    ["-y", "-v", "error", "-i", file, "-vf", `select=eq(n\\,${frameIndex})`, "-vframes", "1", png],
    { encoding: "utf8" },
  );
  // PNG を生の gray へ落として統計を取る（画素値の分布だけ見たいので rawvideo が速い）。
  const raw = path.join(workDir, `probe-${frameIndex}.gray`);
  execFileSync("ffmpeg", ["-y", "-v", "error", "-i", png, "-pix_fmt", "gray", "-f", "rawvideo", raw], {
    encoding: "utf8",
  });
  const buf = fs.readFileSync(raw);
  let sum = 0;
  for (const v of buf) sum += v;
  const mean = sum / buf.length;
  let acc = 0;
  for (const v of buf) acc += (v - mean) * (v - mean);
  return { mean, sd: Math.sqrt(acc / buf.length) };
}

/**
 * 指定フレームを表示して、**画像部分の**平均輝度を推定する。
 *
 * <p>canvas は画像の外側（レターボックスの黒）を含むので、平均をそのまま MP4 と比べられない。
 * **画像が canvas に占める面積比**で割り戻す。面積比は `imagePixelsToCanvasFraction` に
 * 画像の四隅を投げて求める（ズーム・パン・反転はビューポートの `worldToCanvas` に任せる）。
 *
 * <p>🔴 最初は `nonBlackFraction`（ほぼ黒でない画素の割合）で割っていたが**過補正**だった。
 * DSA では**画像の中に真っ黒な領域が普通にある**（背景が窓の下端に張り付く）ので、
 * 「黒くない割合」は画像の面積比より小さく出る。実測で 163 対 91 の食い違いになり、
 * アプリが壊れているように見えた。
 */
async function screenImageMeans(page: Page, frameIndices: number[], size: number): Promise<number[]> {
  const out: number[] = [];
  for (const i of frameIndices) {
    await page.getByTestId("cine-seek").fill(String(i));
    await page.waitForTimeout(1_200);
    const v = await page.evaluate((n) => {
      const dbg = (window as unknown as {
        __graphyDebug?: {
          getPixelStats?: () => { mean: number }[];
          imagePixelsToCanvasFraction?: (
            pts: readonly (readonly [number, number])[],
          ) => { fx: number; fy: number }[] | null;
        };
      }).__graphyDebug;
      const stats = dbg?.getPixelStats?.() ?? [];
      const corners = dbg?.imagePixelsToCanvasFraction?.([
        [0, 0],
        [n, n],
      ]);
      if (!stats.length || !corners || corners.length < 2) return NaN;
      const fw = Math.min(1, Math.abs(corners[1].fx - corners[0].fx));
      const fh = Math.min(1, Math.abs(corners[1].fy - corners[0].fy));
      const area = fw * fh;
      return area > 0.05 ? stats[0].mean / area : NaN;
    }, size);
    out.push(v);
  }
  return out;
}

async function openStudy(page: Page, studyUid: string): Promise<void> {
  await dismissStartupDialogs(page);
  const blocker = await findBlockingOverlay(page, "search-submit-button");
  if (blocker) throw new Error(`検索ボタンが別の要素に塞がれています: ${blocker}`);
  page.once("dialog", (d) => void d.accept());
  const dateInputs = page.locator('input[type="date"]');
  await dateInputs.nth(0).fill("");
  await dateInputs.nth(1).fill("");
  await page.getByTestId("search-submit-button").click();
  const row = page.locator(`[data-testid="study-row-${studyUid}"]`);
  await row.waitFor({ state: "visible", timeout: 20_000 });
  for (let i = 0; i < 3; i++) {
    await row.click();
    await page.waitForTimeout(800);
    if ((await page.locator('[data-testid^="series-row-"]').count()) > 0) return;
  }
  throw new Error(`スタディを開いてもシリーズ行が出ません: ${studyUid}`);
}

async function main(): Promise<void> {
  if (!fs.existsSync(TRUTH_PATH)) {
    throw new Error(`ファントムがありません: ${PHANTOM_DIR}`);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const truth = (JSON.parse(fs.readFileSync(TRUTH_PATH, "utf8")) as { dsa: DsaTruth }).dsa;
  const file = path.join(PHANTOM_DIR, truth.file);
  const savePath = path.join(OUT_DIR, "exported.mp4");
  fs.rmSync(savePath, { force: true });

  const driver = new DesktopDriver();
  await driver.start();
  try {
    const page = driver.page;
    await resetDb(driver.ports.http);
    const imp = await importPaths(driver.ports.http, [file]);
    if (imp.imported !== 1) throw new Error(`取込に失敗: ${JSON.stringify(imp)}`);

    // ダウンロードを既知のパスへ落とす（Electron は既定でダイアログか既定フォルダへ落ちる）。
    await driver.app.evaluate(({ session }, sp) => {
      session.defaultSession.removeAllListeners("will-download");
      (globalThis as Record<string, unknown>).__mp4Download = null;
      session.defaultSession.on("will-download", (_e: unknown, item: Record<string, never>) => {
        const it = item as unknown as {
          setSavePath: (p: string) => void;
          getFilename: () => string;
          getMimeType: () => string;
          once: (ev: string, cb: (e: unknown, state: string) => void) => void;
        };
        it.setSavePath(sp);
        it.once("done", (_ev: unknown, state: string) => {
          (globalThis as Record<string, unknown>).__mp4Download = {
            state,
            filename: it.getFilename(),
            mimeType: it.getMimeType(),
          };
        });
      });
    }, savePath);

    await waitForMainScreenReady(page, 60_000);
    await openStudy(page, truth.studyInstanceUid);
    await page.locator('[data-testid^="series-row-"]').first().click();
    await page.getByTestId(HOST).waitFor({ state: "visible", timeout: 60_000 });
    await page.waitForTimeout(2_500);

    // 画面の fps とフレーム数を控える（**動画がこれと一致するか**が本題）。
    // 🚨 期待値をここで**ハードコードしない**。1 回目はこれを 15 と決め打ちして、
    //    「アプリが 10fps で書き出した」のか「アプリが正しく 10fps だった」のかを
    //    区別できない失敗を出した（automator の衛生: 合格の根拠は画面から取る）。
    const shown = await page.evaluate(() => {
      const seek = document.querySelector('[data-testid="cine-seek"]') as HTMLInputElement | null;
      const fpsEl = document.querySelector('[data-testid="cine-fps"]');
      const m = /([\d.]+)\s*fps/i.exec(fpsEl?.textContent ?? "");
      return { max: seek ? Number(seek.max) : null, fps: m ? Number(m[1]) : null };
    });
    const frameCount = shown.max != null ? shown.max + 1 : null;
    check(!!frameCount && frameCount > 1, "[前提] シネのフレーム数を読めた", frameCount);
    check(shown.fps != null && shown.fps > 0, "[前提] 画面の再生速度（fps）を読めた", shown.fps);

    // DSA ON（「画面と同じ絵」＝差分が出ることまで見る）。
    await page.getByTestId("dsa-check").click();
    await page.getByTestId("dsa-mask").waitFor({ state: "visible", timeout: 120_000 });
    await page.waitForTimeout(2_500);

    // ── MP4 書き出し ────────────────────────────────────────────────
    page.once("dialog", (d) => void d.accept()); // 焼き込み文字の確認ダイアログ
    await page.getByTestId("xa-export-mp4").click();
    let done = false;
    for (let i = 0; i < 180; i++) {
      await page.waitForTimeout(1_000);
      const st = await driver.app.evaluate(() => (globalThis as Record<string, unknown>).__mp4Download);
      if (st && (st as { state: string }).state === "completed") {
        done = true;
        break;
      }
    }
    check(done, "[書き出し] MP4 のダウンロードが完了した");
    check(fs.existsSync(savePath) && fs.statSync(savePath).size > 0, "[書き出し] ファイルが空でない", {
      bytes: fs.existsSync(savePath) ? fs.statSync(savePath).size : 0,
    });

    // ── 中身を見る（「落ちてきた」で合格にしない）─────────────────────
    const info = probe(savePath);
    check(info.codec === "h264", "[中身] H.264 で書かれている", info.codec);
    check(
      frameCount != null && info.frames === frameCount,
      "[中身] ★フレーム数が画面と一致する（欠落・重複が無い）",
      { shown: frameCount, mp4: info.frames },
    );
    check(
      shown.fps != null && Math.abs(info.fps - shown.fps) < 0.51,
      "[中身] ★再生速度が画面の fps と一致する（尺が変わっていない）",
      { shownFps: shown.fps, mp4Fps: info.fps },
    );
    check(
      info.width % 2 === 0 && info.height % 2 === 0,
      "[中身] 幅・高さが偶数（yuv420p の要求）",
      { w: info.width, h: info.height },
    );

    // ③ **画面と同じ絵か。** 予想ではなく、同じフレームの画面統計と突き合わせる。
    const midIndex = Math.floor((frameCount ?? 10) / 2);
    const mp4First = frameStats(savePath, 0, OUT_DIR);
    const mp4Mid = frameStats(savePath, midIndex, OUT_DIR);
    const screen = await screenImageMeans(page, [0, midIndex], info.width);
    // 画像部分の平均どうしを比べる（レターボックスは割り戻し済み）。
    // 🔴 差分だけを見る版は**近い値どうしの符号**に振り回されて役に立たなかった
    //    （画面 −1.7 に対し MP4 +3.6 で落ちる）。絶対値で見るほうが素直で、
    //    掴みたい壊れ方（自動 W/L で中間調へ寄る）にもよく効く。
    const diffFirst = Math.abs(screen[0] - mp4First.mean);
    const diffMid = Math.abs(screen[1] - mp4Mid.mean);
    check(
      diffFirst < 25 && diffMid < 25,
      "[中身] ★画面と同じ絵になっている（画像部分の明るさが一致）",
      {
        screen: { first: Number(screen[0].toFixed(1)), mid: Number(screen[1].toFixed(1)) },
        mp4: { first: Number(mp4First.mean.toFixed(1)), mid: Number(mp4Mid.mean.toFixed(1)) },
        diff: { first: Number(diffFirst.toFixed(1)), mid: Number(diffMid.toFixed(1)) },
      },
    );
    const mp4Delta = mp4Mid.mean - mp4First.mean;
    // 🚨 フレームごとに自動 W/L していると、**どのフレームも平均が真ん中へ寄る**
    //    （窓が毎回そのフレームに合わせ直されるため）。実機で踏んだ壊れ方はこれ。
    check(
      Math.abs(mp4Delta) > 1,
      "[中身] ★フレームごとに窓を作り直していない（明暗の差が潰れていない）",
      { mp4Delta: Number(mp4Delta.toFixed(2)) },
    );

    fs.writeFileSync(
      path.join(OUT_DIR, "result.json"),
      JSON.stringify({ shownFrames: frameCount, shownFps: shown.fps, info, mp4First, mp4Mid, screen }, null, 2),
    );
  } finally {
    await driver.stop();
  }

  console.log(`\n===== XA シネの MP4 書き出し =====`);
  console.log(`合格 ${passed} / 失敗 ${failures.length}`);
  if (failures.length) {
    console.log("失敗:");
    failures.forEach((f) => console.log(`  - ${f}`));
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
