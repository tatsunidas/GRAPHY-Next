/*
 * web モード（外部 PACS を DICOMweb で参照する BFF）で、MPR・3D・Curved MPR・Slicer の 4 画面が開くことの自動検査。
 *
 * 実 PACS は使わず、合成 CT 120 枚を `stubDicomWeb.ts` が配信する。同じファイルを standalone にも取り込み、
 * MPR の表示画素が 2 つの経路で一致することも確かめる。
 *
 * 実行（専用ポート。jar は `cd backend && mvn -q -DskipTests clean package` で作ったもの＝UI 同梱）:
 *   cd automator && npx tsx src/spike/webFourViewsCheck.ts
 * 環境変数: WFV_WEB_PORT（既定 18190）、WFV_STANDALONE_PORT（18191）、WFV_SCP_PORT（18192・18193 を使う）。
 *
 * 結果は 合格／失敗／未達 に分けて数える。負例（検出器が落ちること）も同じ実行で確かめる:
 *   - シリーズ一括取得が 500（prefetch が使えない PACS）→ インスタンス単位の取得に戻る → 「一括 1 回」の判定が落ちる
 *   - prefetch の POST をブラウザ側で止める（呼び出しを外した変異と同じ）→ 同じく落ちる
 *   - スタブを止める → 画面が開かない／エラー表示を検出する
 * 未達（この検査では確かめない）: 実 dcm4chee、Safari・モバイル、512 枚級のメモリ、ボリューム全画素の一致。
 */
import { chromium, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { StubDicomWeb } from "../fixtures/stubDicomWeb.js";
import { importPaths } from "../fixtures/importFixtures.js";
import { killProcessTree } from "../common/processUtils.js";
import { waitForBackendReady } from "../backend/healthcheck.js";
import { seedViewerSettings } from "../backend/seedSettings.js";

const WEB_PORT = Number(process.env.WFV_WEB_PORT ?? 18190);
const STANDALONE_PORT = Number(process.env.WFV_STANDALONE_PORT ?? 18191);
const SCP_PORT = Number(process.env.WFV_SCP_PORT ?? 18192);
const ROOT = path.resolve(AUTOMATOR_ROOT, "..");
const JAR = path.join(ROOT, "backend", "target", "graphy-next-backend.jar");
const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "web-four-views");
const RUN_DIR = path.join(OUT_DIR, "run");
const SCREENS = ["mpr", "viewer3d", "curvedmpr", "slicer"] as const;
type Screen = (typeof SCREENS)[number];

let passed = 0;
const failures: string[] = [];
const pending: string[] = [];
function check(cond: boolean, label: string, detail?: unknown): void {
  if (cond) { passed++; console.log(`  [ok  ] ${label}`); }
  else { failures.push(label); console.log(`  [FAIL] ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`); }
}
function notReached(label: string, why: string): void {
  pending.push(label);
  console.log(`  [未達] ${label} — ${why}`);
}

const procs: ChildProcess[] = [];
const webProcRef: { p: ChildProcess | null } = { p: null };
async function startBackend(profile: "web" | "standalone", port: number, scp: number, extra: string[]): Promise<void> {
  const cwd = path.join(RUN_DIR, profile);
  fs.mkdirSync(cwd, { recursive: true });
  const p = spawn("java", ["-jar", JAR, `--spring.profiles.active=${profile}`, `--server.port=${port}`, `--graphy.dicom.scp.port=${scp}`, ...extra], {
    cwd, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GRAPHY_AUTOMATOR: "1" },
  });
  p.stdout?.on("data", () => {});
  p.stderr?.on("data", () => {});
  procs.push(p);
  if (profile === "web") webProcRef.p = p;
  await waitForBackendReady(port, 120_000);
  await seedViewerSettings(port);
  const st = (await (await fetch(`http://127.0.0.1:${port}/api/status`)).json()) as { mode?: string };
  check(st.mode === profile, `${profile} プロファイルで起動している（/api/status の mode）`, st);
}

/** 画像（PNG）が一様でないか。about:blank のページで復号して、色の種類と標準偏差を見る。 */
async function pngStats(helper: Page, png: Buffer): Promise<{ colors: number; std: number; lit: number }> {
  return helper.evaluate(async (b64) => {
    const img = new Image();
    await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = () => rej(new Error("decode")); img.src = `data:image/png;base64,${b64}`; });
    const c = document.createElement("canvas");
    c.width = img.width; c.height = img.height;
    const g = c.getContext("2d")!;
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    const seen = new Set<number>();
    let sum = 0, sum2 = 0, n = 0, lit = 0;
    for (let i = 0; i < d.length; i += 4) {
      seen.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
      const v = (d[i] + d[i + 1] + d[i + 2]) / 3;
      sum += v; sum2 += v * v; n++;
      if (v > 40) lit++;
    }
    const mean = sum / n;
    return { colors: seen.size, std: Math.sqrt(Math.max(0, sum2 / n - mean * mean)), lit: lit / n };
  }, png.toString("base64"));
}

/** 既知の食い違い（製品側。この検査では直さず、報告する）。web プロファイルに無い経路への fire-and-forget の登録。 */
const KNOWN_HTTP = /^404 \/api\/dbadmin\/retention\/in-use\/register/;
const ERR_RE = /指定されていません|取得できません|読み込めません|見つかりません|失敗しました|エラー|再試行|ボリュームを作れません|cannot|could not|failed|error|not found|retry|not specified|no context/i;

interface Opened {
  ok: boolean;
  errorText: string | null;
  canvases: number;
  stats: { colors: number; std: number; lit: number } | null;
  consoleErrors: string[];
  httpErrors: string[];
  has3dView: boolean | null;
  shot: string;
}

async function seedCtx(page: Page, base: string): Promise<void> {
  await page.goto(`${base}/`, { waitUntil: "domcontentloaded" });
  const ok = await page.evaluate(async () => {
    const studies = (await (await fetch("/api/studies")).json()) as Array<{ studyInstanceUid: string }>;
    if (!studies.length) return false;
    const series = (await (await fetch(`/api/studies/${studies[0].studyInstanceUid}/series`)).json()) as unknown[];
    if (!series.length) return false;
    // 画面ごとに読むキーが違う（MprScreen・Viewer3DScreen・CurvedMprScreen・SlicerScreen の各 start()）。
    const v = JSON.stringify({ study: studies[0], series: series[0], ts: Date.now() });
    for (const k of ["graphy-mpr-ctx", "graphy-viewer3d-ctx", "graphy-curvedmpr-ctx", "graphy-slicer-ctx"]) localStorage.setItem(k, v);
    return true;
  });
  if (!ok) throw new Error(`検査が一覧に出ません: ${base}`);
}

async function openScreen(ctx: BrowserContext, helper: Page, base: string, screen: Screen, tag: string, settleMs: number, reseed = true): Promise<Opened> {
  // 検査の指定は別のページで書き、描画するページは最初から対象の画面で読み込む（遷移途中で中断された要求を誤って数えない）。
  if (reseed) {
    const sp = await ctx.newPage();
    await seedCtx(sp, base).finally(() => sp.close().catch(() => {}));
  }
  const page = await ctx.newPage();
  const consoleErrors: string[] = [];
  const httpErrors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 200)); });
  page.on("response", (r) => { if (r.status() >= 400) httpErrors.push(`${r.status()} ${r.url().replace(base, "").slice(0, 120)}`); });
  page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${String(e).slice(0, 200)}`));
  await page.addInitScript(() => {
    // 確認ダイアログは CDP を止める。応答を返して素通しにする。
    window.alert = () => {}; window.confirm = () => true; window.prompt = () => null;
  });
  try {
    await page.goto(`${base}/#${screen}`, { waitUntil: "domcontentloaded" });
    // 描画の完了を待つ（ソフトウェア描画の 3D は遅い）。画面ごとの目印があれば先に待つ。
    const mark = screen === "viewer3d" ? '[data-testid="viewer3d-mode-slab"]' : screen === "mpr" ? '[data-testid="mpr-viewport"]' : "canvas";
    await page.locator(mark).first().waitFor({ state: "visible", timeout: 60_000 }).catch(() => {});
    await page.waitForTimeout(settleMs);
    const shot = path.join(OUT_DIR, `${tag}-${screen}.png`);
    await page.screenshot({ path: shot });
    const text = await page.evaluate(() => document.body.innerText);
    const errorText = ERR_RE.exec(text)?.[0] ?? null;
    const canvases = await page.locator("canvas").count();
    const stats = await pngStats(helper, fs.readFileSync(shot));
    // 画面全体ではなく、描画の領域（最大のキャンバス）が一様でないことを見る。
    const biggest = await page.evaluate(() => {
      let best: { i: number; a: number } | null = null;
      document.querySelectorAll("canvas").forEach((c, i) => { const a = c.clientWidth * c.clientHeight; if (!best || a > best.a) best = { i, a }; });
      return best ? (best as { i: number }).i : -1;
    });
    let cstats: { colors: number; std: number; lit: number } | null = stats;
    if (biggest >= 0) cstats = await pngStats(helper, await page.locator("canvas").nth(biggest).screenshot());
    // 3D は暗く小さな物体（球）を描画ペインの中央に描く。ペイン全体の明るい画素の割合は小さく、HUD の文字にも
    // 影響されるので、中央の窓（幅・高さの 20%）に画素があるかで見る。本番ビルドには __graphyDebug が無い（DEV のみ）。
    let has3dView: boolean | null = null;
    let centerLit = 0;
    if (screen === "viewer3d" && biggest >= 0) {
      const box = await page.locator("canvas").nth(biggest).boundingBox();
      if (box) {
        const w = box.width * 0.2, h = box.height * 0.2;
        const clip = { x: box.x + (box.width - w) / 2, y: box.y + (box.height - h) / 2, width: w, height: h };
        centerLit = (await pngStats(helper, await page.screenshot({ clip }))).lit;
      }
      has3dView = centerLit >= 0.05;
    }
    const painted = screen === "viewer3d" ? has3dView === true && !!cstats && cstats.colors > 50 : !!cstats && cstats.colors > 50 && cstats.std > 5 && cstats.lit >= 0.05;
    return { ok: canvases > 0 && painted && !errorText, errorText, canvases, stats: cstats, consoleErrors, httpErrors, has3dView, shot };
  } finally {
    await page.close().catch(() => {});
  }
}

/** web の backend を作り直す（BFF のキャッシュが空になる。負例を「冷えた状態」から始めるため）。 */
async function restartWeb(stubPort: number): Promise<void> {
  if (webProcRef.p) killProcessTree(webProcRef.p);
  for (let i = 0; i < 60; i++) {
    const alive = await fetch(`http://127.0.0.1:${WEB_PORT}/api/status`).then(() => true).catch(() => false);
    if (!alive) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  await startBackend("web", WEB_PORT, SCP_PORT, [`--graphy.dicom.dicomweb.base-url=http://127.0.0.1:${stubPort}`]);
}

async function main(): Promise<void> {
  if (!fs.existsSync(JAR)) { console.log(`jar が無い: ${JAR}\n先に cd backend && mvn -q -DskipTests clean package`); process.exitCode = 1; return; }
  console.log(`jar: ${JAR} (${fs.statSync(JAR).mtime.toISOString()})`);
  fs.rmSync(RUN_DIR, { recursive: true, force: true });
  fs.mkdirSync(RUN_DIR, { recursive: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const synthDir = path.join(RUN_DIR, "synth");
  fs.mkdirSync(synthDir);
  const py = spawnSync("python3", ["-I", path.join(AUTOMATOR_ROOT, "src", "spike", "webSynthCt.py"), synthDir], { encoding: "utf8" });
  if (py.status !== 0) throw new Error(`合成 CT を作れません: ${py.stderr}`);
  const meta = JSON.parse(py.stdout) as { studyInstanceUid: string; count: number };
  console.log(`合成 CT: ${meta.count} 枚 study=${meta.studyInstanceUid}`);

  const stub = new StubDicomWeb(synthDir);
  const stubPort = await stub.start();
  let browser: Browser | null = null;
  try {
    await startBackend("web", WEB_PORT, SCP_PORT, [`--graphy.dicom.dicomweb.base-url=http://127.0.0.1:${stubPort}`]);
    await startBackend("standalone", STANDALONE_PORT, SCP_PORT + 1, []);
    const files = fs.readdirSync(synthDir).filter((f) => f.endsWith(".dcm")).map((f) => path.join(synthDir, f));
    const imp = await importPaths(STANDALONE_PORT, files);
    check(imp.imported === meta.count && imp.failed === 0, `standalone に合成 CT ${meta.count} 枚を取り込めた`, { imported: imp.imported, failed: imp.failed });

    browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, locale: "ja-JP" });
    const helper = await ctx.newPage();
    await helper.goto("about:blank");

    const webBase = `http://127.0.0.1:${WEB_PORT}`;
    const stdBase = `http://127.0.0.1:${STANDALONE_PORT}`;

    // ── 前提: web の一覧がスタブの検査を返す（これが無いと以降の「開く」は意味を持たない）
    const wl = await (await fetch(`${webBase}/api/studies`)).json() as Array<{ studyInstanceUid: string }>;
    check(wl.length === 1 && wl[0].studyInstanceUid === stub.studyUid, "web の検査一覧にスタブの検査が出る（QIDO 経由）", { n: wl.length });
    check(stub.counts.qido > 0, "スタブが QIDO の要求を受けた（BFF が本当にスタブを見ている）", stub.counts);

    // ── 検出器の負例: 真っ黒な画像は「描画された」と判定されない
    const blank = await helper.evaluate(() => { const c = document.createElement("canvas"); c.width = 400; c.height = 300; const g = c.getContext("2d")!; g.fillStyle = "#000"; g.fillRect(0, 0, 400, 300); return c.toDataURL("image/png").split(",")[1]; });
    const bs = await pngStats(helper, Buffer.from(blank, "base64"));
    check(bs.lit < 0.05 && bs.colors <= 50, "検出器の負例: 真っ黒な画像は「描画された」と判定されない", bs);

    // ── 正例: web で 4 画面
    console.log("\n[web] 4 画面");
    for (const [i, s] of SCREENS.entries()) {
      // 画面ごとに BFF のキャッシュとブラウザのキャッシュを空にする（温まっていると、個別取得が 0 回なのが prefetch のおかげか分からない）。
      if (i > 0) await restartWeb(stubPort);
      const sctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, locale: "ja-JP" });
      stub.resetCounts();
      const r = await openScreen(sctx, helper, webBase, s, "web", s === "viewer3d" ? 15_000 : 8_000);
      await sctx.close();
      console.log(`  ${s}: canvases=${r.canvases} colors=${r.stats?.colors} std=${r.stats?.std.toFixed(1)} lit=${r.stats?.lit.toFixed(2)} err=${r.errorText} bulk=${stub.counts.seriesBulk} instance=${stub.counts.instance} console=${r.consoleErrors.length} http4xx=${r.httpErrors.length} 3dCenterLit=${r.has3dView}`);
      check(r.ok, `${s}: 描画される・エラー表示なし`, { has3dView: r.has3dView, canvases: r.canvases, stats: r.stats, errorText: r.errorText, shot: r.shot });
      const unknownHttp = r.httpErrors.filter((h) => !KNOWN_HTTP.test(h));
      const knownHttp = r.httpErrors.length - unknownHttp.length;
      if (knownHttp > 0) console.log(`  [既知] ${s}: ${knownHttp} 件の 404（/api/dbadmin/retention/in-use/register）。製品側の食い違いとして報告（この検査では直さない）`);
      const unknownConsole = r.consoleErrors.filter((c) => !(knownHttp > 0 && /status of 404/.test(c)));
      check(unknownConsole.length === 0 && unknownHttp.length === 0, `${s}: 上記の既知 1 件を除き、console エラー・pageerror・HTTP 4xx/5xx が無い`, { console: unknownConsole.slice(0, 3), http: unknownHttp.slice(0, 5) });
      check(stub.counts.seriesBulk === 1 && stub.counts.instance === 0, `${s}: 取得はシリーズ一括 1 回・インスタンス単位 0 回（120 回取りに行かない）`, stub.counts);
    }

    // ── 画素一致: 同じ合成 CT を standalone と web で開いた MPR の表示
    console.log("\n[画素一致] standalone と web の MPR");
    const shotHash = async (base: string): Promise<{ hash: string; mean: number | null; lit: number }> => {
      const page = await ctx.newPage();
      await page.addInitScript(() => { window.alert = () => {}; window.confirm = () => true; window.prompt = () => null; });
      try {
        const sp = await ctx.newPage();
        await seedCtx(sp, base).finally(() => sp.close().catch(() => {}));
        await page.goto(`${base}/#mpr`, { waitUntil: "domcontentloaded" });
        await page.locator('[data-testid="mpr-viewport"]').first().waitFor({ state: "visible", timeout: 60_000 });
        await page.waitForTimeout(8_000);
        const png = await page.locator('[data-testid="mpr-viewport"]').first().screenshot();
        fs.writeFileSync(path.join(OUT_DIR, `pix-${base.includes(String(WEB_PORT)) ? "web" : "standalone"}-axial.png`), png);
        const mean = await page.evaluate(() => {
          const g = (window as unknown as { __graphyDebug?: { getImagePixelRange?: () => Array<{ mean: number | null }> } }).__graphyDebug;
          const r = g?.getImagePixelRange?.() ?? [];
          return r.length ? r[0].mean : null;
        });
        return { hash: crypto.createHash("sha256").update(png).digest("hex"), mean, lit: (await pngStats(helper, png)).lit };
      } finally { await page.close().catch(() => {}); }
    };
    const a = await shotHash(stdBase);
    const b = await shotHash(webBase);
    console.log(`  standalone sha256=${a.hash.slice(0, 16)} mean=${a.mean} / web sha256=${b.hash.slice(0, 16)} mean=${b.mean}`);
    check(a.lit >= 0.05 && b.lit >= 0.05, "比べる 2 枚とも画像が描かれている（空の画面どうしの一致を合格にしない）", { standalone: a.lit, web: b.lit });
    check(a.hash === b.hash, "MPR axial の表示画素（要素のスクリーンショット）が standalone と web で一致する", { standalone: a.hash.slice(0, 16), web: b.hash.slice(0, 16) });
    // __graphyDebug は DEV ビルドだけに入る（本番ビルドの jar には無い）ので、値の突き合わせは表示画素で行う。
    notReached("ボリューム全画素の一致", "表示画素（MPR axial 中心スライス）の一致までを確かめた。本番ビルドにはボリュームの値を読む口が無く、この検査では新設しない");
    notReached("Curved MPR のプレビューと Slicer の再構成", "中心線の指定・再構成の操作は行わない。確かめたのは、各画面が web でボリュームを組んで参照断面を描くところまで");

    // ── 負例 1: シリーズ一括取得が 500 → インスタンス単位に戻る（「一括 1 回」の判定が落ちること）
    console.log("\n[負例] 一括取得が 500 の PACS");
    await restartWeb(stubPort);
    stub.failSeriesBulk = true; stub.resetCounts();
    const bctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, locale: "ja-JP" });
    const n1 = await openScreen(bctx, helper, webBase, "mpr", "neg-bulk500", 8_000);
    await bctx.close();
    stub.failSeriesBulk = false;
    console.log(`  bulk=${stub.counts.seriesBulk} instance=${stub.counts.instance} ok=${n1.ok}`);
    check(stub.counts.instance >= meta.count, "一括が使えないと、インスタンス単位の取得に戻る（約 120 回）", stub.counts);
    check(!(stub.counts.seriesBulk === 1 && stub.counts.instance === 0), "→ 正例の判定（一括 1 回・単位 0 回）はこの状態で落ちる", stub.counts);
    check(n1.ok, "BFF の個別取得への戻りは機能し、画面は開く（既存仕様）", { stats: n1.stats, errorText: n1.errorText });

    // ── 負例 2: prefetch の呼び出しを外した変異（ブラウザ側で POST を止める）
    console.log("\n[負例] prefetch の呼び出しを外した変異");
    await restartWeb(stubPort);
    stub.resetCounts();
    const mctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, locale: "ja-JP" });
    await mctx.route("**/prefetch", (route) => route.abort());
    const n2 = await openScreen(mctx, helper, webBase, "mpr", "neg-noprefetch", 8_000);
    await mctx.close();
    console.log(`  bulk=${stub.counts.seriesBulk} instance=${stub.counts.instance} ok=${n2.ok}`);
    check(stub.counts.seriesBulk === 0 && stub.counts.instance >= meta.count, "prefetch を外すと、一括 0 回・インスタンス単位 約 120 回になる", stub.counts);
    check(!(stub.counts.seriesBulk === 1 && stub.counts.instance === 0), "→ 正例の判定はこの状態で落ちる", stub.counts);

    // ── 負例 3: スタブを止める → 開けないことを検出できる
    console.log("\n[負例] PACS（スタブ）を止める");
    const downCtx = await browser.newContext({ viewport: { width: 1400, height: 900 }, locale: "ja-JP" });
    await restartWeb(stubPort); // キャッシュを空に（止める前に作り直す。ctx は止める前に書く）
    const seedPage2 = await downCtx.newPage();
    await seedCtx(seedPage2, webBase);
    await seedPage2.close();
    await stub.stop();
    for (const s of ["mpr", "viewer3d"] as const) {
      const n3 = await openScreen(downCtx, helper, webBase, s, `neg-stubdown`, 6_000, false);
      console.log(`  ${s}: ok=${n3.ok} err=${n3.errorText} canvases=${n3.canvases} 3dView=${n3.has3dView}`);
      check(!n3.ok, `PACS が止まっていると、${s} は「開けた」と判定しない（検出器が空振りしない）`, { errorText: n3.errorText, stats: n3.stats, has3dView: n3.has3dView });
    }
    await downCtx.close();

    notReached("実 dcm4chee での 4 画面", "実 PACS を使わない検査（スタブ）。deploy/dcm4chee/VERIFY-web.md の手動手順に残る");
    notReached("Safari・モバイルブラウザでの表示", "headless Chromium（ソフトウェア描画）のみ");
    notReached("512 枚級の CT での BFF のメモリ", "本検査は 120 枚・64×64。メモリは別項目で実測する");
  } finally {
    if (browser) await browser.close().catch(() => {});
    await stub.stop().catch(() => {});
    for (const p of procs) killProcessTree(p);
  }
  console.log(`\n合格 ${passed} / 失敗 ${failures.length} / 未達 ${pending.length}`);
  if (failures.length) { console.log("失敗:\n- " + failures.join("\n- ")); process.exitCode = 1; }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
