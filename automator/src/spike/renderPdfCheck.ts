/*
 * プラグイン向け host.renderPdf（HTML → PDF）の実機検証。
 *
 * 実行: cd automator && GRAPHY_AUTOMATOR_HTTP_PORT=287xx GRAPHY_AUTOMATOR_SCP_PORT=287xx GRAPHY_AUTOMATOR_VITE_PORT=287xx \
 *        setsid nohup timeout 600 npx tsx src/spike/renderPdfCheck.ts </dev/null >log 2>&1 &
 *
 * 確かめること（本物の Electron）:
 *   1. 日本語・表・data: の画像を含む HTML から PDF が出る（%PDF・1 ページ以上）。出力は pdftoppm で描いて目で見る
 *   2. 負例: HTML に外部の http 画像・CSS・iframe・file: の画像・script を入れても、受け側の loopback サーバーへの
 *      アクセスが 0 件、script は動かない、file: の中身（このホストの /etc/hostname）が PDF に出ない
 *   3. 不正な要求（過大・型違い）は PDF を作らずエラーを返す
 *   環境変数 GRAPHY_PDF_SPIKE_EXPECT_LEAK=1 は**対照実験用**（ガードを一時的に外した main で、アクセスが >0 になることを確かめる）。
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { DesktopDriver } from "../driver/desktopDriver.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";

const OUT = path.join(AUTOMATOR_ROOT, ".results", "render-pdf");
fs.mkdirSync(OUT, { recursive: true });
const expectLeak = process.env.GRAPHY_PDF_SPIKE_EXPECT_LEAK === "1";
const failures: string[] = [];
const check = (c: boolean, l: string, d?: unknown) => {
  console.log(`  [${c ? "ok  " : "FAIL"}] ${l}${c ? "" : " — " + JSON.stringify(d)}`);
  if (!c) failures.push(l);
};

// 受け側: 何かが取りに来たら記録する
const hits: string[] = [];
const probe = http.createServer((req, res) => { hits.push(req.url ?? ""); res.writeHead(200, { "content-type": "image/png" }); res.end(); });
await new Promise<void>((r) => probe.listen(0, "127.0.0.1", () => r()));
const probePort = (probe.address() as { port: number }).port;

// 1 ピクセルの PNG（data: の画像が通ることの正例）
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const html = (hostile: boolean) => `<!doctype html><html><head><meta charset="utf-8"><title>t</title>
<style>@page{size:A4;margin:14mm} body{font:12px sans-serif} table{border-collapse:collapse} td,th{border:1px solid #888;padding:3px 8px}</style>
${hostile ? `<link rel="stylesheet" href="http://127.0.0.1:${probePort}/x.css">` : ""}</head><body>
<h1>4D Flow レポート（確認用）</h1>
<p>日本語の表示: 流量 171.2 mL/min・要確認・判定不能。</p>
<table><tr><th>血管</th><th>4D</th><th>2D</th></tr><tr><td>R-ICA</td><td>171.2</td><td>158.0</td></tr></table>
<p><img alt="px" width="40" height="40" src="data:image/png;base64,${PNG}"></p>
${hostile ? `
<img src="http://127.0.0.1:${probePort}/img.png">
<iframe src="http://127.0.0.1:${probePort}/frame.html"></iframe>
<img src="file:///etc/hostname">
<iframe src="file:///etc/hostname" width="300" height="60"></iframe>
<script>document.write("SCRIPT-RAN-MARKER"); fetch("http://127.0.0.1:${probePort}/fetch");</script>` : ""}
</body></html>`;

const driver = new DesktopDriver();
await driver.start();
try {
  const page = driver.page;
  await page.waitForLoadState("domcontentloaded");
  const call = async (req: unknown) => page.evaluate(async (r) => {
    const d = (window as unknown as { graphyDesktop?: { renderPdf?: (x: unknown) => Promise<{ ok: boolean; bytes?: Uint8Array; error?: string; blocked?: string[] }> } }).graphyDesktop;
    if (!d?.renderPdf) return { ok: false, error: "no-renderPdf-in-preload" };
    const res = await d.renderPdf(r);
    return res.ok ? { ok: true, b64: btoa(String.fromCharCode(...(res.bytes as Uint8Array).slice(0, 4))) + "|" + (res.bytes as Uint8Array).length, blocked: res.blocked, all: Array.from(res.bytes as Uint8Array) } : res;
  }, req);

  // 1. 正例
  const ok = (await call({ html: html(false) })) as { ok: boolean; all?: number[]; error?: string };
  check(ok.ok === true, "PDF が出る", ok.error);
  if (ok.ok && ok.all) {
    const f = path.join(OUT, "ok.pdf");
    fs.writeFileSync(f, Buffer.from(ok.all));
    check(Buffer.from(ok.all.slice(0, 5)).toString() === "%PDF-", "先頭が %PDF-");
    const info = execFileSync("pdfinfo", [f]).toString();
    check(/Pages:\s+1/.test(info), "1 ページ", info.split("\n").filter((l) => /Pages|Page size/.test(l)));
    check(/A4|595/.test(info), "A4", info);
    execFileSync("pdftoppm", ["-png", "-r", "60", "-f", "1", "-l", "1", f, path.join(OUT, "ok")]);
    const txt = execFileSync("pdftotext", [f, "-"]).toString();
    check(txt.includes("流量 171.2 mL/min") && txt.includes("R-ICA"), "日本語と表の文字が PDF に入っている", txt.slice(0, 120));
  }

  // 2. 負例（外部へ出ない・script が動かない・file: が読まれない）
  hits.length = 0;
  const bad = (await call({ html: html(true) })) as { ok: boolean; all?: number[]; blocked?: string[]; error?: string };
  check(bad.ok === true, "敵対的な HTML でも PDF は出る（外部だけ止める）", bad.error);
  await new Promise((r) => setTimeout(r, 1500));
  if (expectLeak) {
    check(hits.length > 0, "【対照実験】ガードを外すと外部アクセスが出る（検査が落ちうることの確認）", hits);
  } else {
    check(hits.length === 0, "外部 http へのアクセスが 0 件（画像・CSS・iframe・fetch）", hits);
    check((bad.blocked ?? []).length >= 3, "止めた要求が記録されている（検査が空振りでないことの確認）", bad.blocked);
  }
  if (bad.ok && bad.all) {
    const f = path.join(OUT, "hostile.pdf");
    fs.writeFileSync(f, Buffer.from(bad.all));
    const txt = execFileSync("pdftotext", [f, "-"]).toString();
    const hostname = fs.readFileSync("/etc/hostname", "utf8").trim();
    if (!expectLeak) {
      check(!txt.includes("SCRIPT-RAN-MARKER"), "script が動いていない");
      check(hostname.length > 0 && !txt.includes(hostname), "file: の中身（/etc/hostname）が PDF に出ていない", hostname);
    }
    execFileSync("pdftoppm", ["-png", "-r", "60", "-f", "1", "-l", "1", f, path.join(OUT, "hostile")]);
  }

  // 3. 不正な要求
  check(((await call({ html: "" })) as { error?: string }).error === "bad-request", "空の HTML は bad-request");
  check(((await call({ html: "x", pageSize: "A3" })) as { error?: string }).error === "bad-request", "未知の用紙は bad-request");
  check(((await call({ html: "a".repeat(9 * 1024 * 1024) })) as { error?: string }).error === "too-large", "9 MB は too-large");
  const again = (await call({ html: html(false) })) as { ok: boolean };
  check(again.ok === true, "失敗のあとも次の要求が通る");
  console.log(failures.length === 0 ? "ALL OK" : `FAILURES: ${failures.join(" / ")}`);
} finally {
  probe.close();
  await driver.stop().catch(() => undefined);
}
