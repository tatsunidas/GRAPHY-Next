/*
 * アシスタントの添付（S3: テキスト／PDF／Word／Excel／PowerPoint／動画）の実機検証。
 *
 * 実行:  cd automator && npx tsx src/spike/assistantAttachmentsCheck.ts
 *
 * 本物の Electron ＋ loopback の偽 OpenAI 互換サーバーで、添付が「テキスト＋画像」として送られることを確かめる。
 *   1. 各形式を添付 → チップに種類と文字数 → 送信 → 偽サーバーが受けた本文に内容が入る（PDF は同梱 worker が動く）
 *   2. 動画: renderer 内で作った webm から 6 コマが画像として送られる
 *   3. 旧形式・UTF-8 以外・壊れたファイルは理由つきで弾く（負例）
 *   4. 識別子らしき記述がある文書には警告が付く／ない文書には付かない
 *   5. この PC の外（https 宛て）では確認が出て、確認するまで送信されない／ローカル宛てでは出ない
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";

import { DesktopDriver } from "../driver/desktopDriver.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { createChecker } from "./computeSpikeShared.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "assistant-attachments-check");
const PORTS = { http: 19320, scp: 19321, vite: 19323 };
const { check, summary } = createChecker();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function startFake(port: number) {
  const seen: string[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      seen.push(Buffer.concat(chunks).toString("utf8"));
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "了解" } }] })}\n\n`);
      res.end(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
    });
  });
  server.listen(port, "127.0.0.1");
  return { server, seen };
}
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
    s.on("error", reject);
  });
}

/** 合成の文書（患者情報を含まない）を python3 の zipfile で作る。 */
function makeOffice(dir: string, withId: boolean): Record<string, string> {
  const py = `
import sys, zipfile
d = sys.argv[1]; wid = sys.argv[2] == "1"
def z(name, files):
    with zipfile.ZipFile(d + "/" + name, "w", zipfile.ZIP_DEFLATED) as f:
        for k, v in files.items(): f.writestr(k, v)
z("a.docx", {"word/document.xml": "<w:document><w:body><w:p><w:r><w:t>肺結節の評価DOCX</w:t></w:r></w:p>" + ("<w:p><w:r><w:t>PatientName: TEST^X</w:t></w:r></w:p>" if wid else "") + "</w:body></w:document>"})
z("a.xlsx", {"xl/workbook.xml": '<workbook><sheets><sheet name="結果" sheetId="1" r:id="rId1"/></sheets></workbook>',
  "xl/_rels/workbook.xml.rels": '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
  "xl/sharedStrings.xml": "<sst><si><t>項目XLSX</t></si></sst>",
  "xl/worksheets/sheet1.xml": '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>42</v></c></row></sheetData></worksheet>'})
z("a.pptx", {"ppt/slides/slide1.xml": "<p:sld><a:p><a:r><a:t>スライドPPTX</a:t></a:r></a:p></p:sld>"})
z("broken.docx", {"x.txt": "no document.xml"})
`;
  execFileSync("python3", ["-I", "-c", py, dir, withId ? "1" : "0"]);
  return Object.fromEntries(["a.docx", "a.xlsx", "a.pptx", "broken.docx"].map((n) => [n, path.join(dir, n)]));
}

function makePdf(file: string): void {
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    "<< /Length 44 >>\nstream\nBT /F1 18 Tf 10 50 Td (Hello PDFTEXT) Tj ET\nendstream",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offs: number[] = [];
  objs.forEach((o, i) => { offs[i] = pdf.length; pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => String(o).padStart(10, "0") + " 00000 n \n").join("")}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  fs.writeFileSync(file, pdf);
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const office = makeOffice(OUT_DIR, false);
  const officeId = makeOffice(fs.mkdtempSync(path.join(OUT_DIR, "id-")), true);
  const pdfFile = path.join(OUT_DIR, "a.pdf");
  makePdf(pdfFile);
  const txt = path.join(OUT_DIR, "a.txt");
  fs.writeFileSync(txt, "TXT本文です");
  const sjis = path.join(OUT_DIR, "sjis.txt");
  fs.writeFileSync(sjis, Buffer.from([0x83, 0x65, 0x83, 0x58, 0x83, 0x67]));
  const legacy = path.join(OUT_DIR, "old.doc");
  fs.writeFileSync(legacy, "x");

  const port = await freePort();
  const fake = startFake(port);
  const driver = new DesktopDriver(PORTS);
  let dataDir = "";
  const clean = () => {
    for (const f of ["ai-providers.json", "secrets.enc.json"]) if (dataDir && fs.existsSync(path.join(dataDir, f))) fs.rmSync(path.join(dataDir, f));
  };
  try {
    await driver.start();
    dataDir = await driver.app.evaluate(({ dialog }) => {
      dialog.showMessageBoxSync = (() => 0) as typeof dialog.showMessageBoxSync;
      return process.cwd();
    });
    clean();
    await driver.page.reload({ waitUntil: "domcontentloaded" });
    const main = driver.page;
    type Bridge = { aiProvidersSet: (c: unknown) => Promise<{ ok: boolean }> };
    const setProviders = (cfg: unknown) => main.evaluate((c) => (window as unknown as { graphyDesktop: Bridge }).graphyDesktop.aiProvidersSet(c), cfg);
    const local = { id: "local", label: "ローカル", kind: "openai", endpoint: `http://127.0.0.1:${port}`, auth: "none", toolMode: "none", models: { "text-to-text": "tiny", "image-to-text": "tiny-vision" } };
    check((await setProviders({ providers: [local], defaults: { "text-to-text": "local", "image-to-text": "local" } })).ok, "ローカル提供元を保存できる");
    const win = await driver.waitForNewPage(async () => {
      await main.getByTestId("mainscreen-menu-system").click();
      await main.getByTestId("menu-item-assistant").click();
    }, (u) => u.includes("#assistant"));
    await win.getByTestId("assistant-input").waitFor({ state: "visible", timeout: 20_000 });
    await sleep(500);
    const fileInput = win.locator('input[type="file"]');
    const chips = win.getByTestId("assistant-attach-chip");
    const lastReq = () => JSON.parse(fake.seen[fake.seen.length - 1]);
    const reqText = () => String(lastReq().messages.at(-1).content?.[0]?.text ?? lastReq().messages.at(-1).content);
    const sendAndWait = async (q: string) => {
      const n = fake.seen.length;
      await win.getByTestId("assistant-input").fill(q);
      await win.getByTestId("assistant-send").click();
      await win.getByTestId("assistant-send").waitFor({ state: "visible", timeout: 20_000 });
      check(fake.seen.length === n + 1, `送信された（${q}）`);
    };

    console.log("\n[1] 各形式を添付して送る");
    await fileInput.setInputFiles([txt, pdfFile, office["a.docx"], office["a.xlsx"], office["a.pptx"]]);
    await chips.nth(4).waitFor({ state: "visible", timeout: 30_000 });
    check((await chips.count()) === 5, "チップが 5 件出る");
    const chipTexts = await chips.allTextContents();
    check(chipTexts.some((t) => t.includes("a.pdf") && /文字|chars/.test(t)), "PDF のチップに文字数が出る（pdfjs の worker が動いた）", chipTexts);
    check((await win.getByTestId("assistant-attach-phi").count()) === 0, "🔴 識別子のない文書に警告は付かない");
    await win.screenshot({ path: path.join(OUT_DIR, "1-chips.png") });
    await sendAndWait("要約して");
    const t1 = reqText();
    for (const k of ["TXT本文です", "Hello PDFTEXT", "肺結節の評価DOCX", "項目XLSX\t42", "スライドPPTX", "[添付: a.pdf"]) check(t1.includes(k), `送信本文に「${k}」が入る`);
    check(t1.endsWith("要約して"), "利用者の質問が末尾に付く");
    check((await chips.count()) === 0, "送信後に添付は空になる");
    const shown = (await win.getByTestId("assistant-msg-user").last().textContent()) ?? "";
    check(shown.includes("📎 a.pdf") && !shown.includes("Hello PDFTEXT"), "吹き出しにはファイル名だけ出し、本文は出さない");
    await win.screenshot({ path: path.join(OUT_DIR, "2-sent.png") });
    await sendAndWait("続けて");
    check(!JSON.stringify(lastReq().messages).includes("Hello PDFTEXT"), "🔴 次の送信に前回の添付本文は載らない");

    console.log("\n[2] 動画");
    const webm = await win.evaluate(async () => {
      const c = document.createElement("canvas"); c.width = 160; c.height = 120;
      const ctx = c.getContext("2d")!;
      const rec = new MediaRecorder(c.captureStream(15), { mimeType: "video/webm" });
      const parts: Blob[] = [];
      rec.ondataavailable = (e) => parts.push(e.data);
      const done = new Promise<void>((r) => (rec.onstop = () => r()));
      rec.start();
      const t0 = performance.now();
      while (performance.now() - t0 < 2000) { ctx.fillStyle = `hsl(${(performance.now() / 5) % 360},80%,50%)`; ctx.fillRect(0, 0, 160, 120); await new Promise((r) => setTimeout(r, 50)); }
      rec.stop(); await done;
      const buf = new Uint8Array(await new Blob(parts).arrayBuffer());
      let s = ""; for (const b of buf) s += String.fromCharCode(b);
      return btoa(s);
    });
    const vfile = path.join(OUT_DIR, "clip.webm");
    fs.writeFileSync(vfile, Buffer.from(webm, "base64"));
    await fileInput.setInputFiles(vfile);
    await chips.first().waitFor({ state: "visible", timeout: 30_000 });
    check(/6/.test((await chips.first().textContent()) ?? ""), "動画のチップに 6 コマと出る", await chips.first().textContent());
    await sendAndWait("この動画は何ですか");
    const imgs = JSON.stringify(lastReq()).match(/"type":"image_url"/g)?.length ?? 0;
    check(imgs === 6, "動画のコマが画像 6 枚で送られる", imgs);
    check(lastReq().model === "tiny-vision", "画像つきは image-to-text のモデルで送る", lastReq().model);

    console.log("\n[3] 負例");
    for (const [f, re] of [[legacy, /旧形式|Legacy/], [sjis, /対応していない形式|Unsupported/], [office["broken.docx"], /壊れて|damaged/]] as const) {
      await fileInput.setInputFiles(f);
      await win.getByText(re).first().waitFor({ state: "visible", timeout: 10_000 }).catch(() => undefined);
      check((await win.getByText(re).count()) >= 1, `🔴 ${path.basename(f)} は理由つきで弾く`);
      check((await chips.count()) === 0, `${path.basename(f)} はチップにならない`);
    }

    console.log("\n[4] 識別子の警告");
    await fileInput.setInputFiles(officeId["a.docx"]);
    await win.getByTestId("assistant-attach-phi").waitFor({ state: "visible", timeout: 10_000 });
    check(true, "識別子らしき記述のある docx に警告が付く");
    await win.screenshot({ path: path.join(OUT_DIR, "3-phi.png") });
    check((await win.getByTestId("assistant-attach-confirm").count()) === 0, "ローカル宛てでは確認が出ない");
    await win.getByRole("button", { name: /この添付を外す|Remove this attachment/ }).click();

    console.log("\n[5] この PC の外への送信は確認が出る");
    // 鍵なしは loopback のみ許す仕様なので、https の宛てには（ダミーの）鍵を入れる。宛先は存在しない名前で、送信まで進めない。
    const cloud = { id: "cloud", label: "クラウド", kind: "openai", endpoint: "https://llm.example.invalid", toolMode: "none", models: { "text-to-text": "big" } };
    check((await setProviders({ providers: [cloud], defaults: { "text-to-text": "cloud" } })).ok, "クラウド提供元を保存できる");
    await main.evaluate(() => (window as unknown as { graphyDesktop: { secretSet: (k: string, v: string) => Promise<unknown> } }).graphyDesktop.secretSet("ai.provider.cloud.apiKey", "dummy-not-a-real-key"));
    await win.reload({ waitUntil: "domcontentloaded" });
    await win.getByTestId("assistant-input").waitFor({ state: "visible", timeout: 10_000 });
    await sleep(500);
    const before = fake.seen.length;
    await win.locator('input[type="file"]').setInputFiles(txt);
    await chips.first().waitFor({ state: "visible", timeout: 10_000 });
    check(((await win.getByTestId("assistant-attach-dest").textContent()) ?? "").includes("llm.example.invalid"), "宛先ホストを常時表示する");
    await win.getByTestId("assistant-input").fill("送る");
    await win.getByTestId("assistant-send").click();
    await win.getByTestId("assistant-attach-confirm").waitFor({ state: "visible", timeout: 10_000 });
    check((await chips.count()) === 1 && (await win.getByTestId("assistant-msg-user").count()) === 0, "🔴 確認が済むまで送信されず、添付も残る");
    await win.screenshot({ path: path.join(OUT_DIR, "4-confirm.png") });
    await win.getByRole("button", { name: /やめる|Cancel/ }).click();
    check((await win.getByTestId("assistant-attach-confirm").count()) === 0 && fake.seen.length === before, "やめると何も送られない");
  } finally {
    await driver.stop();
    fake.server.close();
    clean();
  }
  const failed = summary();
  fs.writeFileSync(path.join(OUT_DIR, "result.json"), JSON.stringify({ failed }, null, 2));
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((e) => { console.error(e); process.exit(1); });
