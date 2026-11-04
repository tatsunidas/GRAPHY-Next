/*
 * Gemini 3 系（2026-12-01 に gemini-2.5-flash の転送先になる gemini-3.5-flash-lite）の「厳しい検証」を模した偽サーバーで、
 * アシスタントの関数呼び出しの往復が通ることを実アプリで確かめる。
 *
 * 実行:  cd automator && npx tsx src/spike/assistantGeminiStrictCheck.ts
 *
 * 本物の Electron ＋ backend ＋ fixture(ct-basic, 43 枚) の #2dviewer 窓 ＋ loopback の偽 Gemini サーバー（SSE）。
 * 偽サーバーは、通知にある次の違反を HTTP 400 で弾く:
 *   - FunctionResponse に id・name が無い／直前のモデルの functionCall.id と一致しない
 *   - モデルが返した thoughtSignature を、次の要求の functionCall に戻していない
 *   - generationConfig に temperature / topP / topK / candidateCount がある
 *   - ツールを渡すチャットに thinkingConfig.thinkingLevel が無い
 *   - 末尾が user でない（model の先読み）
 * 画面の値は 2D 窓のスライダから直接読む。
 * 🚨 これは通知の文言に合わせた想定の検査で、実 API が受け付けるかは確かめない（実 API は未達。利用者が確認する）。
 */
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import type { Page } from "playwright";

import { DesktopDriver } from "../driver/desktopDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { importFixtureCategory } from "../fixtures/importFixtures.js";
import { openFirstSeriesInViewer } from "../checklist/items/shared/helpers.js";
import { createStepRecorder } from "../checklist/types.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { createChecker } from "./computeSpikeShared.js";
import { clickDismissing, dismissUpdateDialog } from "./dismissUpdateDialog.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "assistant-gemini-strict-check");
const PORTS = { http: 19550, scp: 19551, vite: 19553 };
const { check, summary } = createChecker();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Part { text?: string; thoughtSignature?: string; functionCall?: { id?: string; name?: string; args?: unknown }; functionResponse?: { id?: string; name?: string; response?: { result?: string } } }
interface Content { role: string; parts: Part[] }
interface Body { contents?: Content[]; tools?: unknown[]; generationConfig?: Record<string, unknown> }

/** 3 系の厳しさを模した検査。違反の一覧を返す（空なら通る）。 */
function violations(b: Body): string[] {
  const v: string[] = [];
  const contents = b.contents ?? [];
  if (contents.length === 0 || contents[contents.length - 1].role !== "user") v.push("末尾が user でない（先読み）");
  const g = b.generationConfig ?? {};
  for (const k of ["temperature", "topP", "topK", "candidateCount"]) if (k in g) v.push(`generationConfig.${k} は廃止`);
  if (Array.isArray(b.tools) && b.tools.length > 0) {
    const tc = g.thinkingConfig as { thinkingLevel?: string } | undefined;
    if (!tc || typeof tc.thinkingLevel !== "string") v.push("ツールを渡すチャットに thinkingConfig.thinkingLevel が無い");
  }
  contents.forEach((c, i) => {
    if (c.role === "model") {
      for (const p of c.parts) if (p.functionCall && !p.thoughtSignature && SIGNED.has(String(p.functionCall.id))) v.push(`model[${i}] の functionCall に thoughtSignature が無い`);
    }
    if (c.role === "user" && c.parts.some((p) => p.functionResponse)) {
      const prev = contents[i - 1];
      const calls = (prev?.parts ?? []).filter((p) => p.functionCall).map((p) => p.functionCall!);
      c.parts.forEach((p, k) => {
        if (!p.functionResponse) return;
        const fr = p.functionResponse;
        if (!fr.name) v.push(`functionResponse[${k}] に name が無い`);
        if (!fr.id) v.push(`functionResponse[${k}] に id が無い`);
        else if (!calls.some((fc) => fc.id === fr.id)) v.push(`functionResponse[${k}].id=${fr.id} が直前の functionCall.id と一致しない`);
      });
    }
  });
  return v;
}

const SIGNED = new Set<string>(); // 署名を付けて返した呼び出しの id
let callSeq = 0;
const seen: { path: string; body: Body; status: number; violations: string[] }[] = [];

function startFake(port: number) {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      let body: Body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* */ }
      const url = req.url ?? "";
      const stream = url.includes(":streamGenerateContent");
      const vs = violations(body);
      if (vs.length > 0) {
        seen.push({ path: url, body, status: 400, violations: vs });
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { code: 400, message: vs.join(" / "), status: "INVALID_ARGUMENT" } }));
        return;
      }
      seen.push({ path: url, body, status: 200, violations: [] });
      const contents = body.contents ?? [];
      const last = contents[contents.length - 1];
      const answered = (last?.parts ?? []).filter((p) => p.functionResponse);
      let parts: Part[];
      if (answered.length === 0) {
        // 1 手目: getState（署名付き）
        const id = `fc-${++callSeq}`; SIGNED.add(id);
        parts = [{ functionCall: { id, name: "getState", args: {} }, thoughtSignature: `SIG-${id}` }];
      } else if (answered.some((p) => p.functionResponse!.name === "getState")) {
        // 2 手目: 状態の枚数から最後の index を計算して goToSlice
        let n = 0;
        try { n = JSON.parse(answered[0].functionResponse!.response!.result ?? "{}").state.tiles[0].sliceCount; } catch { /* */ }
        const id = `fc-${++callSeq}`; SIGNED.add(id);
        parts = [{ functionCall: { id, name: "goToSlice", args: { index: Math.max(0, n - 1) } }, thoughtSignature: `SIG-${id}` }];
      } else {
        parts = [{ text: "最後のスライスに移動しました。" }];
      }
      const payload = { candidates: [{ content: { role: "model", parts }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 }, modelVersion: "gemini-3.5-flash-lite-fake" };
      if (stream) {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
        res.end();
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(payload));
      }
    });
  });
  server.listen(port, "127.0.0.1");
  return server;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
    s.on("error", reject);
  });
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const fakePort = await freePort();
  const fake = startFake(fakePort);
  const driver = new DesktopDriver(PORTS);
  let dataDir = "";
  const clean = () => { for (const f of ["ai-providers.json", "secrets.enc.json"]) if (dataDir && fs.existsSync(path.join(dataDir, f))) fs.rmSync(path.join(dataDir, f)); };
  try {
    await driver.start();
    const info = await driver.app.evaluate(({ dialog, app }) => {
      dialog.showMessageBoxSync = (() => 0) as typeof dialog.showMessageBoxSync;
      return { cwd: process.cwd(), userData: app.getPath("userData") };
    });
    dataDir = info.cwd;
    clean();
    const main: Page = driver.page;
    await resetDb(driver.ports.http);
    await importFixtureCategory(driver.ports.http, "ct-basic");
    await main.reload({ waitUntil: "domcontentloaded" });
    await main.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 30_000 });
    await dismissUpdateDialog(main);
    await openFirstSeriesInViewer(main, createStepRecorder());
    await dismissUpdateDialog(main);
    const viewer = await driver.waitForNewPage(() => clickDismissing(main, main.getByTestId("viewer2d-toolbar-button")), (u) => u.includes("2dviewer"));
    await viewer.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 20_000 });
    await viewer.waitForTimeout(2500);
    const max = Number(await viewer.getByTestId("dim-slider-z").first().getAttribute("max"));
    const slider = async () => Number(await viewer.getByTestId("dim-slider-z").first().inputValue());

    const setProvider = (extra: Record<string, unknown>) => main.evaluate(
      (cfg) => (window as unknown as { graphyDesktop: { aiProvidersSet: (c: unknown) => Promise<{ ok: boolean; problems?: string[] }> } }).graphyDesktop.aiProvidersSet(cfg),
      { providers: [{ id: "gem3", label: "Gemini3(偽)", kind: "gemini", endpoint: `http://127.0.0.1:${fakePort}`, auth: "none", models: { "text-to-text": "gemini-3.5-flash-lite" }, ...extra }], defaults: { "text-to-text": "gem3" } },
    );
    const r0 = await setProvider({});
    check(r0.ok === true, "偽の Gemini 3 を提供元に保存できる（loopback・鍵なし）", r0);

    const win = await driver.waitForNewPage(async () => {
      await dismissUpdateDialog(main);
      await clickDismissing(main, main.getByTestId("mainscreen-menu-system"));
      await clickDismissing(main, main.getByTestId("menu-item-assistant"));
    }, (u) => u.includes("#assistant"));
    await win.getByTestId("assistant-input").waitFor({ state: "visible", timeout: 20_000 });
    await sleep(600);
    const ask = async (q: string) => {
      await win.getByTestId("assistant-input").fill(q);
      await win.getByTestId("assistant-send").click();
      await win.getByTestId("assistant-send").waitFor({ state: "visible", timeout: 60_000 });
      await sleep(300);
    };

    console.log("\n[1] 既定（medium）で、getState → goToSlice → 本文の往復が 400 なしで通る");
    seen.length = 0;
    await ask("最後のスライスを表示して");
    const bad = seen.filter((s) => s.status !== 200);
    check(seen.length === 3, "要求は 3 回（getState・goToSlice・本文）", seen.map((s) => s.status));
    check(bad.length === 0, "🔴 厳しい検証に 1 件も弾かれない", bad.map((b) => b.violations));
    check(await slider() === max, "🔴 2D 窓のスライスが実際に最後（42）になった（スライダ）", { slider: await slider(), max });
    const last = win.getByTestId("assistant-msg-bot").last();
    check(((await last.innerText()) ?? "").includes("最後のスライスに移動しました"), "本文が画面に出る");
    const t0 = seen[0].body.generationConfig as { thinkingConfig?: { thinkingLevel?: string } } | undefined;
    check(t0?.thinkingConfig?.thinkingLevel === "medium", "ツールを渡す要求に thinkingLevel=medium（既定）", t0);
    const secondTurn = seen[1].body.contents ?? [];
    const fr = secondTurn[secondTurn.length - 1].parts[0].functionResponse;
    check(fr?.id === "fc-1" && fr?.name === "getState", "🔴 2 回目の要求の functionResponse に、モデルの id と name が戻る", fr);
    await win.screenshot({ path: path.join(OUT_DIR, "1-assistant.png") });
    await viewer.screenshot({ path: path.join(OUT_DIR, "2-viewer.png") });

    console.log("\n[2] 提供元の thinkingLevel（high）が要求に載る");
    const r1 = await setProvider({ thinkingLevel: "high" });
    check(r1.ok === true, "thinkingLevel を付けて保存できる", r1);
    await win.reload({ waitUntil: "domcontentloaded" });
    await win.getByTestId("assistant-input").waitFor({ state: "visible", timeout: 20_000 });
    seen.length = 0;
    await ask("最後のスライスを表示して");
    const hi = seen[0]?.body.generationConfig as { thinkingConfig?: { thinkingLevel?: string } } | undefined;
    check(hi?.thinkingConfig?.thinkingLevel === "high", "要求に thinkingLevel=high", hi);
    check(seen.every((s) => s.status === 200), "ここでも 400 なし", seen.map((s) => s.status));

    console.log("\n[3] 負例: 不正な thinkingLevel は保存できない");
    const r2 = await setProvider({ thinkingLevel: "max" });
    check(r2.ok === false, "🔴 thinkingLevel=max は拒否される", r2);
  } finally {
    fs.writeFileSync(path.join(OUT_DIR, "requests.json"), JSON.stringify(seen, null, 2));
    await driver.stop();
    fake.close();
    clean();
  }
  const failed = summary();
  fs.writeFileSync(path.join(OUT_DIR, "result.json"), JSON.stringify({ failed }, null, 2));
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((e) => { console.error(e); process.exit(1); });
