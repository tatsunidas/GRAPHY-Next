/*
 * エクスポート・送信の窓の 3 状態チェックボックスが、共通部品（TriCheckbox.tsx）への置き換え（#389）の前後で変わらないことの検証。
 * GP-JOB-001 の「実機確認待ち」6。置き換え前（#388 の 91aab96）と置き換え後（この作業コピー）を、**その場で両方起動**して比べる。
 *
 * 実行:  cd backend && mvn -q -Dfrontend.skip=true -DskipTests clean package   （backend jar）
 *        置き換え前の作業コピー（git worktree add <dir> 91aab96 → frontend で npm ci）を OLD_FRONTEND に指定
 *        cd automator && OLD_FRONTEND=<dir>/frontend npx tsx src/spike/triCheckboxCompare.ts
 *
 * 同じ backend（standalone）に vite dev を 2 本向け、chromium（Playwright）で同じ操作列を流す:
 *   スタディの行を選ぶ → 窓（エクスポート／送信）を開く → 展開 → [A] スタディのチェックを入れる（全部選ばれる）
 *   → [B] シリーズを 1 つ外す（スタディは不確定）→ [C] 全部外す（none）→ [D] スタディのチェックをもう一度入れる
 * 各段階で、ページ内の全チェックボックスの {checked, indeterminate} と、窓のスクリーンショットの画素を新旧で比べる。
 * 負例: 操作を 1 つ減らした列は、状態の列が一致しない（比較が効いている証拠）。先に、不確定（indeterminate）が実際に出ている段階があることを確かめる。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { chromium, type Page } from "@playwright/test";

import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { importFixtureCategory, importPaths } from "../fixtures/importFixtures.js";
import { createChecker } from "./computeSpikeShared.js";

const { check, summary } = createChecker();
const ROOT = path.join(AUTOMATOR_ROOT, "..");
const NEW_FRONTEND = path.join(ROOT, "frontend");
const OLD_FRONTEND = process.env.OLD_FRONTEND;
const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "tri-checkbox-compare");
const HTTP = Number(process.env.GRAPHY_AUTOMATOR_HTTP_PORT ?? "48301");
const SCP = Number(process.env.GRAPHY_AUTOMATOR_SCP_PORT ?? "48314");
const VITE_NEW = Number(process.env.GRAPHY_AUTOMATOR_VITE_PORT ?? "48303");
const VITE_OLD = VITE_NEW + 1;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitHttp(url: string, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).status < 500) return;
    } catch {
      /* まだ */
    }
    await sleep(500);
  }
  throw new Error(`応答しない: ${url}`);
}

type Box = { checked: boolean; indeterminate: boolean };
type Step = { name: string; boxes: Box[]; png: Buffer };

const boxes = (p: Page): Promise<Box[]> =>
  p.locator("input[type=checkbox]").evaluateAll((els) => els.map((e) => ({ checked: (e as HTMLInputElement).checked, indeterminate: (e as HTMLInputElement).indeterminate })));

/** 窓を開いて操作列を流し、各段階の状態と画像を返す。skipB は負例（B を飛ばした列）。 */
async function run(url: string, dialog: "export" | "send", skipB: boolean): Promise<Step[]> {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    await page.addInitScript("localStorage.setItem('graphy.locale', 'ja')");
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: /^同意して使う/ }).click({ timeout: 20_000 }).catch(() => undefined);
    await page.getByRole("button", { name: "全期間" }).click({ timeout: 30_000 });
    await page.getByTestId("search-submit-button").click();
    const row = page.locator('[data-testid^="study-row-"]').first();
    await row.click({ timeout: 30_000 });
    await page.getByRole("button", { name: dialog === "export" ? /エクスポート/ : /送信/ }).first().click();
    const all = page.locator("input[type=checkbox]");
    await all.first().waitFor({ state: "visible", timeout: 20_000 });
    // 窓を開くと、取り込み直後のスタディは選ばれていて、シリーズが読み込まれて自動で展開される（▾）。展開済みなら押さない（押すと畳む）
    const expander = page.getByLabel("expand").first();
    for (let i = 0; i < 100 && !((await expander.textContent()) ?? "").includes("▾"); i++) await sleep(150);
    if (!((await expander.textContent()) ?? "").includes("▾")) await expander.click();
    for (let i = 0; i < 100 && (await all.count()) < 3; i++) await sleep(150);
    await sleep(400);
    const c = await all.count();
    const nSeries = c - 2; // 全体 = スタディ 1 ＋ シリーズ ＋ 窓の下の「同梱」1
    // ページ内の並びは [スタディ, シリーズ…, 同梱のチェック（窓の下）]。主画面にはチェックボックスは無い
    const studyBox = all.first();
    const seriesBox = (k: number) => all.nth(1 + k);
    const steps: Step[] = [];
    const snap = async (name: string) => {
      await sleep(700); // ボタンのホバー・遷移の途中を撮らない
      steps.push({ name, boxes: await boxes(page), png: await page.screenshot() });
    };
    if (nSeries < 2) throw new Error(`シリーズが 2 つ以上要ります（展開で増えたチェックボックス ${nSeries}）`);
    await snap("0 初期（展開後）");
    // 初期は取り込み直後でスタディが選ばれている。いったん外して、そこから入れる操作にそろえる
    if (await studyBox.isChecked()) await studyBox.click();
    await snap("A0 スタディを外す");
    await studyBox.click();
    await snap("A スタディにチェック");
    if (!skipB) {
      await seriesBox(nSeries - 1).click();
      await snap("B シリーズを 1 つ外す");
    }
    for (let k = 0; k < nSeries; k++) if (await seriesBox(k).isChecked()) await seriesBox(k).click();
    await snap("C 全部外す");
    await studyBox.click();
    await snap("D スタディにチェックし直す");
    return steps;
  } finally {
    await browser.close();
  }
}

async function pixelDiff(a: Buffer, b: Buffer): Promise<{ max: number; differing: number; total: number }> {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    // tsx が関数に付ける補助（__name）はページに無いので、ページで動かす部分は文字列で渡す
    return (await page.evaluate(`(async () => {
      const dec = async (s) => {
        const bin = atob(s);
        const u = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
        const bmp = await createImageBitmap(new Blob([u], { type: "image/png" }));
        const c = new OffscreenCanvas(bmp.width, bmp.height);
        const ctx = c.getContext("2d");
        ctx.drawImage(bmp, 0, 0);
        return ctx.getImageData(0, 0, bmp.width, bmp.height).data;
      };
      const x = await dec(${JSON.stringify(a.toString("base64"))});
      const y = await dec(${JSON.stringify(b.toString("base64"))});
      if (x.length !== y.length) return { max: 255, differing: -1, total: x.length / 4 };
      // 下端の状態バー（時計の秒が変わる）は比べない。差の範囲がそこだけに収まることは、別に確かめた（bbox）
      const w = Math.round(Math.sqrt(x.length / 4 * 1400 / 900));
      const cut = (x.length / 4 / w - 26) * w * 4;
      let max = 0, differing = 0;
      for (let i = 0; i < Math.min(cut, x.length); i += 4) {
        const d = Math.max(Math.abs(x[i] - y[i]), Math.abs(x[i + 1] - y[i + 1]), Math.abs(x[i + 2] - y[i + 2]));
        if (d > 0) differing++;
        if (d > max) max = d;
      }
      return { max, differing, total: x.length / 4 };
    })()`)) as { max: number; differing: number; total: number };
  } finally {
    await browser.close();
  }
}

async function main(): Promise<void> {
  if (!OLD_FRONTEND || !fs.existsSync(path.join(OLD_FRONTEND, "node_modules"))) throw new Error("OLD_FRONTEND（置き換え前の frontend。npm ci 済み）を指定してください");
  const oldTri = fs.existsSync(path.join(OLD_FRONTEND, "src", "mainscreen", "TriCheckbox.tsx"));
  check(!oldTri, "（前提）OLD_FRONTEND は置き換え前（TriCheckbox.tsx が無い）", OLD_FRONTEND);
  check(fs.existsSync(path.join(NEW_FRONTEND, "src", "mainscreen", "TriCheckbox.tsx")), "（前提）この作業コピーは置き換え後（TriCheckbox.tsx がある）");
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "graphy-tri-check-"));
  const procs: ChildProcess[] = [];
  try {
    const backend = spawn(
      "java",
      [
        "--add-opens", "java.base/java.io=ALL-UNNAMED",
        "--add-opens", "java.desktop/javax.imageio.stream=ALL-UNNAMED",
        "-jar", path.join(ROOT, "backend", "target", "graphy-next-backend.jar"),
        "--spring.profiles.active=standalone",
        `--server.port=${HTTP}`,
        `--graphy.dicom.scp.port=${SCP}`,
      ],
      { cwd: dataDir, stdio: "ignore", env: { ...process.env, GRAPHY_AUTOMATOR: "1", GRAPHY_MAIN_SECRET: crypto.randomBytes(16).toString("hex") } },
    );
    procs.push(backend);
    await waitHttp(`http://localhost:${HTTP}/api/status`);
    await importFixtureCategory(HTTP, "ct-basic");
    // ct-basic だけではシリーズが 1 つなので、同じ患者の別シリーズ（~/graphy-demo-samples/HCC_001。環境変数 TRI_EXTRA_DIR）も足して不確定の段階を作る
    const extra = process.env.TRI_EXTRA_DIR ?? path.join(os.homedir(), "graphy-demo-samples", "HCC_001");
    if (fs.existsSync(extra)) await importPaths(HTTP, [extra]);
    for (const [dir, port] of [[NEW_FRONTEND, VITE_NEW], [OLD_FRONTEND, VITE_OLD]] as const) {
      const v = spawn("npm", ["run", "dev", "--", "--port", String(port), "--strictPort"], {
        cwd: dir,
        stdio: "ignore",
        detached: true,
        env: { ...process.env, VITE_BACKEND_URL: `http://localhost:${HTTP}` },
      });
      procs.push(v);
      await waitHttp(`http://localhost:${port}/`);
    }

    for (const dialog of ["export", "send"] as const) {
      console.log(`\n[${dialog}] 新旧を同じ操作列で`);
      const nw = await run(`http://localhost:${VITE_NEW}/`, dialog, false);
      const old = await run(`http://localhost:${VITE_OLD}/`, dialog, false);
      for (const s of nw) fs.writeFileSync(path.join(OUT_DIR, `${dialog}-new-${s.name.split(" ")[0]}.png`), s.png);
      for (const s of old) fs.writeFileSync(path.join(OUT_DIR, `${dialog}-old-${s.name.split(" ")[0]}.png`), s.png);
      const states = (xs: Step[]) => xs.map((s) => s.boxes.map((b) => (b.indeterminate ? "~" : b.checked ? "x" : "_")).join(""));
      console.log(`  新: ${JSON.stringify(states(nw))}`);
      console.log(`  旧: ${JSON.stringify(states(old))}`);
      check(nw.length === 6 && old.length === 6, "（前提）新旧とも 6 段階を取れた", [nw.length, old.length]);
      check(nw.some((s) => s.boxes.some((b) => b.indeterminate)) && old.some((s) => s.boxes.some((b) => b.indeterminate)), "（前提）不確定（indeterminate）の段階が新旧とも実在する（これが無いと比べる意味がない）");
      check(JSON.stringify(states(nw)) === JSON.stringify(states(old)), `🔴 ${dialog}: 各段階のチェック状態の列が新旧で一致する`, { nw: states(nw), old: states(old) });
      // 画素の比べ方: 同じコードを 2 回撮った差（新×新・旧×旧）が、この環境の描画の揺れ（アンチエイリアス・キャレットの点滅など）。
      // 新×旧の差がその揺れの最大を超えなければ、置き換えによる見た目の違いは無い、と判定する（固定のしきい値は置かない）
      const nw2 = await run(`http://localhost:${VITE_NEW}/`, dialog, false);
      const old2 = await run(`http://localhost:${VITE_OLD}/`, dialog, false);
      let floor = 0;
      for (let i = 0; i < nw.length; i++) {
        floor = Math.max(floor, (await pixelDiff(nw[i].png, nw2[i].png)).max, (await pixelDiff(old[i].png, old2[i].png)).max);
      }
      console.log(`  描画の揺れ（同じコード同士の最大差）: ${floor}`);
      for (let i = 0; i < nw.length; i++) {
        const d = await pixelDiff(nw[i].png, old[i].png);
        check(d.max <= floor, `${dialog} ${nw[i].name}: 新旧の画素差が描画の揺れ以内（最大差 ${d.max} ≤ ${floor}・差のある画素 ${d.differing}）`, d);
      }
      // 負例: B を飛ばした列は、状態の列が一致しない
      const neg = await run(`http://localhost:${VITE_NEW}/`, dialog, true);
      check(neg.length === 5 && JSON.stringify(states(neg)) !== JSON.stringify(states(nw)), `（負例）${dialog}: 操作を 1 つ飛ばした列は状態の列が一致しない（比較が効いている）`, states(neg));
    }
  } finally {
    for (const p of procs.reverse()) {
      try {
        if (p.pid) process.kill(-p.pid, "SIGTERM");
      } catch {
        p.kill();
      }
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
  if (summary() > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
