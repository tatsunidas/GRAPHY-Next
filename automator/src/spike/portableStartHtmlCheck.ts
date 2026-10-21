// START-VIEWER.html（案内ページ）の実 Google Chrome での検査。file:// で開き、OS 判定・表示・コピー・通信を確かめる。
//   START_HTML=<START-VIEWER.html のパス> npx tsx src/spike/portableStartHtmlCheck.ts
// User-Agent とプラットフォームを差し替えて Windows／Mac／Linux／スマートフォン（判定不能）を再現する
// （実機の Mac・Linux のブラウザでの判定は、この PC では確かめられない＝未達）。
import path from "node:path";
import { chromium, type Browser } from "@playwright/test";

const HTML = process.env.START_HTML!;
const OUT = process.env.PORTABLE_OUT ?? "C:/Users/t_kob/pvtest/app-out";
let fail = 0;
const check = (ok: boolean, name: string, d?: unknown) => {
  if (!ok) fail++;
  console.log(`  ${ok ? "合格" : "失敗"}  ${name}${ok || d === undefined ? "" : "  → " + JSON.stringify(d)}`);
};

const ENVS = {
  windows: { ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36", platform: "Win32", file: "START-VIEWER.bat" },
  mac: { ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36", platform: "MacIntel", file: "START-VIEWER.command" },
  linux: { ua: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36", platform: "Linux x86_64", file: "START-VIEWER.sh" },
  phone: { ua: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Mobile Safari/537.36", platform: "Linux armv81", file: "" },
} as const;
const ALL = ["START-VIEWER.bat", "START-VIEWER.command", "START-VIEWER.sh"];
const url = "file:///" + path.resolve(HTML).replace(/\\/g, "/");

async function open(browser: Browser, env: (typeof ENVS)[keyof typeof ENVS], locale: string) {
  const ctx = await browser.newContext({ userAgent: env.ua, locale, viewport: { width: 1000, height: 900 } });
  // 文字列で渡す（関数で渡すと tsx が補助関数を足して、ページ側で ReferenceError になる）。
  await ctx.addInitScript(
    `Object.defineProperty(navigator, "platform", { get: () => ${JSON.stringify(env.platform)} });` +
      `Object.defineProperty(navigator, "userAgentData", { get: () => undefined });`,
  );
  const page = await ctx.newPage();
  const requests: string[] = [];
  const errors: string[] = [];
  page.on("request", (r) => { if (!r.url().startsWith("file:") && !r.url().startsWith("data:")) requests.push(r.url()); });
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(url);
  return { ctx, page, requests, errors };
}

const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  console.log(`Chrome ${browser.version()}（フラグなし）／${url.replace(/^file:\/\/\/.*[\\/]/, "file:///…/")}`);
  for (const key of ["windows", "mac", "linux"] as const) {
    console.log(`\n[${key}]`);
    const env = ENVS[key];
    const { ctx, page, requests, errors } = await open(browser, env, "ja-JP");
    const primary = await page.locator(".primary-file code").allTextContents();
    check(primary.length === 1 && primary[0] === env.file, `主表示は ${env.file} の 1 つだけ`, primary);
    for (const other of ALL.filter((f) => f !== env.file)) check(!primary.includes(other), `主表示に ${other} が出ない（負例）`);
    check((await page.locator("#t-os").textContent())!.includes("このパソコン"), "日本語で見出しが出る（ja-JP）");
    const h = (await page.locator("#t-title").textContent())!;
    check(key === "linux" ? h.includes("実行してください") : h.includes("ダブルクリック"), `見出しが直感的な指示になっている（${key}）`, h);
    const size = (sel: string) => page.locator(sel).first().evaluate((e) => parseFloat(getComputedStyle(e).fontSize));
    const [hs, fs, ls, ws] = [await size("#t-title"), await size(".primary-file code"), await size("#t-lead"), await size("#t-why")];
    check(!h.includes("インストール") && hs > ls && hs > ws && fs > ls, "『インストール不要』の注記は見出し・ファイル名より小さい（見出し自体には出ない）", { hs, fs, ls, ws });
    check((await page.locator(`.others li.here code`).textContent()) === env.file, "『ほかの OS』の一覧で、この PC の行が強調される");
    check((await page.locator("#other-box").evaluate((e: HTMLDetailsElement) => e.open)) === false, "『ほかの OS』は閉じている");
    // コピー: file:// ではクリップボード権限が許可されないことがある。成功なら中身、失敗なら失敗の案内が出ること。
    await ctx.grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => undefined);
    await page.locator(".primary-file .btn").click();
    await page.waitForTimeout(500);
    const status = (await page.locator("#status").textContent()) ?? "";
    const clip = await page.evaluate(() => navigator.clipboard.readText().catch(() => null));
    check(status.includes("コピーしました") ? clip === env.file : status.includes("コピーできませんでした"), `コピーのボタン: ${status.includes("コピーしました") ? "コピーされ、中身がファイル名と一致" : "失敗時は失敗の案内が出る"}`, { status, clip });
    check(page.url() === url, "ボタンを押してもページは移動しない（起動は試みない）");
    // 言語
    await page.locator("#lang-en").click();
    check((await page.locator("#t-title").textContent()) === (key === "linux" ? "Run the file below to start" : "Double-click the file below to start"), "English に切り替わる");
    check((await page.locator(".primary-file code").textContent()) === env.file, "言語を切り替えても主表示は同じ");
    check((await page.locator("#t-sign-by").textContent())!.includes("GRAPHY") && (await page.locator("footer").textContent())!.includes("Visionary Imaging Services, Inc."), "署名が出る");
    check((await page.locator(".notice").textContent())!.includes("not for diagnostic use"), "非診断用の注意が出る（英語）");
    check(requests.length === 0, "外部への通信が 0 件", requests);
    check(errors.length === 0, "コンソールにエラーがない", errors);
    await page.locator("#lang-ja").click();
    await page.screenshot({ path: path.join(OUT, `start-html-${key}.png`) });
    await ctx.close();
  }

  console.log("\n[判定できない環境（スマートフォンの UA）]");
  const u = await open(browser, ENVS.phone, "en-US");
  const prim = await u.page.locator(".primary-file code").allTextContents();
  check(prim.length === 3 && ALL.every((f) => prim.includes(f)), "3 つのファイル名がすべて並ぶ", prim);
  check((await u.page.locator("#other-box").evaluate((e: HTMLDetailsElement) => e.open)) === true, "『ほかの OS』が開いている");
  check((await u.page.locator("#t-title").textContent()) === "Run the file below to start", "英語の環境では英語で始まる（en-US・判定不能は「実行」）");
  await u.page.screenshot({ path: path.join(OUT, "start-html-unknown.png") });
  await u.ctx.close();
} finally {
  await browser.close();
}
console.log(fail ? `\n失敗 ${fail}` : "\nすべて合格");
process.exit(fail ? 1 : 0);
