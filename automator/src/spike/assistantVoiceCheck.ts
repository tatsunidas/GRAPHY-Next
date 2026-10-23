/*
 * アシスタントの音声入力（S2b: マイク → 文字起こし → 入力欄）の実機検証。
 *
 * 実行:  cd automator && npx tsx src/spike/assistantVoiceCheck.ts
 *
 * 本物の Electron ＋ Chromium の偽マイク（--use-file-for-fake-audio-capture）＋ loopback の偽 OpenAI 互換サーバー。
 *   1. 録音 → 停止 → 偽サーバーが 16 kHz mono WAV（440 Hz の音が入っている）を受け、返した文が入力欄に入る。送信はされない
 *   2. 続けて録音すると追記される
 *   3. 提供元が無いとマイクは無効で理由が出る（負例）
 *   4. この PC の外（https 宛て）は確認が出て、確認するまで録音も送信もされない／やめると何も起きない
 *   5. 権限: アシスタント窓の音声だけ許され、映像と他の窓は拒否される（mediaPermission.js）
 * 注: --use-fake-ui-for-media-stream は付けない（付けると本体の許可ハンドラを通らず、権限の検査にならない）。
 */
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";

import { DesktopDriver } from "../driver/desktopDriver.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { createChecker } from "./computeSpikeShared.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "assistant-voice-check");
const PORTS = { http: 19330, scp: 19331, vite: 19333 };
const { check, summary } = createChecker();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TONE_HZ = 440;

function writeToneWav(file: string, seconds: number): void {
  const rate = 48000;
  const n = rate * seconds;
  const b = Buffer.alloc(44 + n * 2);
  b.write("RIFF", 0); b.writeUInt32LE(36 + n * 2, 4); b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write("data", 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(12000 * Math.sin((2 * Math.PI * TONE_HZ * i) / rate)), 44 + i * 2);
  fs.writeFileSync(file, b);
}

/** 受けた WAV を調べる: 形式・長さ(秒)・最大振幅・ゼロ交差から推定した周波数。 */
function inspectWav(buf: Buffer) {
  const rate = buf.readUInt32LE(24);
  const ch = buf.readUInt16LE(22);
  const bits = buf.readUInt16LE(34);
  const n = (buf.length - 44) / 2;
  let peak = 0;
  let zc = 0;
  let prev = 0;
  for (let i = 0; i < n; i++) {
    const v = buf.readInt16LE(44 + i * 2);
    peak = Math.max(peak, Math.abs(v));
    if (prev < 0 && v >= 0) zc++;
    prev = v;
  }
  return { riff: buf.subarray(0, 4).toString(), rate, ch, bits, seconds: n / rate, peak, hz: (zc * rate) / n };
}

function startFake(port: number) {
  const audio: Buffer[] = [];
  const chats: string[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      if (body.includes('"input_audio"')) {
        const j = JSON.parse(body);
        audio.push(Buffer.from(j.messages[0].content[0].input_audio.data, "base64"));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: `language Japanese<asr_text>これは音声入力の試験${audio.length}です` } }] }));
        return;
      }
      chats.push(body);
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "了解" } }] })}\n\n`);
      res.end(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
    });
  });
  server.listen(port, "127.0.0.1");
  return { server, audio, chats };
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
  const tone = path.join(OUT_DIR, "tone.wav");
  writeToneWav(tone, 30);
  const port = await freePort();
  const fake = startFake(port);
  const driver = new DesktopDriver(PORTS, { extraElectronArgs: ["--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${tone}`] });
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
    type Bridge = {
      aiProvidersSet: (c: unknown) => Promise<{ ok: boolean }>;
      secretSet: (k: string, v: string) => Promise<{ ok: boolean }>;
    };
    const setProviders = (cfg: unknown) => main.evaluate((c) => (window as unknown as { graphyDesktop: Bridge }).graphyDesktop.aiProvidersSet(c), cfg);
    const chat = { id: "local", label: "ローカル", kind: "openai", endpoint: `http://127.0.0.1:${port}`, auth: "none", toolMode: "none", models: { "text-to-text": "tiny" } };
    const stt = { id: "stt-fake", label: "偽の音声認識", kind: "openai", endpoint: `http://127.0.0.1:${port}`, auth: "none", toolMode: "none", models: { "speech-to-text": "asr" }, paths: { "speech-to-text": "/v1/chat/completions" } };
    const saved = await setProviders({ providers: [chat, stt], defaults: { "text-to-text": "local", "speech-to-text": "stt-fake" } });
    check(saved.ok, "音声認識の提供元を保存できる", saved);

    const win = await driver.waitForNewPage(async () => {
      await main.getByTestId("mainscreen-menu-system").evaluate((el) => (el as HTMLElement).click());
      await main.getByTestId("menu-item-assistant").click();
    }, (u) => u.includes("#assistant"));
    await win.setViewportSize({ width: 520, height: 780 }); // 既定のアシスタント窓の大きさ（既定のままだと極端に細い）
    await win.getByTestId("assistant-input").waitFor({ state: "visible", timeout: 20_000 });
    await sleep(800);

    console.log("\n[1] 録音 → 停止 → 入力欄に文字が入る（送信はされない）");
    const mic = win.getByTestId("assistant-voice");
    check(await mic.isEnabled(), "マイクボタンが使える");
    const destText = (await win.getByTestId("assistant-voice-dest").textContent()) ?? "";
    check(/この PC|this PC/.test(destText), "送信先が「この PC の中」と常時出ている", destText);
    await mic.click();
    await win.getByTestId("assistant-voice-recording").waitFor({ state: "visible", timeout: 15_000 });
    check(true, "録音中の表示が出る");
    await win.screenshot({ path: path.join(OUT_DIR, "1-recording.png") });
    await sleep(2500);
    await win.getByTestId("assistant-voice-stop").click();
    await win.getByTestId("assistant-voice-dest").waitFor({ state: "visible", timeout: 30_000 });
    const input = win.getByTestId("assistant-input");
    check((await input.inputValue()).includes("これは音声入力の試験1です"), "返った文が入力欄に入る（language 表記は無い）", await input.inputValue());
    check(!(await input.inputValue()).includes("asr_text"), "🔴 モデルの目印(<asr_text>)が入力欄に残らない");
    check(fake.audio.length === 1, "文字起こしの要求は 1 回", fake.audio.length);
    check(fake.chats.length === 0 && (await win.getByTestId("assistant-msg-user").count()) === 0, "🔴 自動では送信されない（会話の要求ゼロ）");
    const w = inspectWav(fake.audio[0]);
    check(w.riff === "RIFF" && w.rate === 16000 && w.ch === 1 && w.bits === 16, "受けた音声は 16 kHz・mono・16 bit の WAV", w);
    check(w.seconds > 1.5 && w.seconds < 6, "録音の長さが実際の録音時間と合う（約 2.5 秒）", w.seconds);
    check(w.peak > 2000, "無音ではない（偽マイクの音が入っている）", w.peak);
    check(Math.abs(w.hz - TONE_HZ) < 15, `440 Hz の音がそのまま入っている`, w.hz);
    await win.screenshot({ path: path.join(OUT_DIR, "2-transcribed.png") });

    console.log("\n[2] 続けて録音すると追記される");
    await mic.click();
    await win.getByTestId("assistant-voice-recording").waitFor({ state: "visible", timeout: 15_000 });
    await sleep(1500);
    await win.getByTestId("assistant-voice-stop").click();
    await win.getByTestId("assistant-voice-dest").waitFor({ state: "visible", timeout: 30_000 });
    const v2 = await input.inputValue();
    check(v2.includes("試験1です") && v2.includes("試験2です"), "既存の文の後ろに追記される", v2);
    // 取消: 録音して取り消すと何も送られず入力欄も変わらない
    const before = fake.audio.length;
    await mic.click();
    await win.getByTestId("assistant-voice-recording").waitFor({ state: "visible", timeout: 15_000 });
    await win.getByTestId("assistant-voice-cancel").click();
    await win.getByTestId("assistant-voice-dest").waitFor({ state: "visible", timeout: 10_000 });
    await sleep(500);
    check(fake.audio.length === before && (await input.inputValue()) === v2, "🔴 取り消すと送信されず入力欄も変わらない");

    console.log("\n[5] 権限（mediaPermission.js）");
    const perm = await win.evaluate(async () => {
      const r: Record<string, string> = {};
      for (const [k, c] of [["audio", { audio: true }], ["video", { video: true }], ["both", { audio: true, video: true }]] as const) {
        try { (await navigator.mediaDevices.getUserMedia(c)).getTracks().forEach((t) => t.stop()); r[k] = "granted"; } catch (e) { r[k] = (e as Error).name; }
      }
      return r;
    });
    check(perm.audio === "granted", "アシスタント窓の音声は許される", perm);
    check(perm.video === "NotAllowedError" && perm.both === "NotAllowedError", "🔴 映像つきの要求は拒否される", perm);
    const other = await main.evaluate(async () => {
      try { (await navigator.mediaDevices.getUserMedia({ audio: true })).getTracks().forEach((t) => t.stop()); return "granted"; } catch (e) { return (e as Error).name; }
    });
    check(other === "NotAllowedError", "🔴 アシスタント以外の窓(プラグインと同じ realm)の音声は拒否される", other);

    console.log("\n[4] この PC の外（https 宛て）は確認が出る");
    const cloud = { id: "cloud-stt", label: "クラウド音声", kind: "openai", endpoint: "https://llm.example.invalid", models: { "speech-to-text": "whisper-1" } };
    check((await main.evaluate((k) => (window as unknown as { graphyDesktop: Bridge }).graphyDesktop.secretSet("ai.provider.cloud-stt.apiKey", k), "dummy-key-for-test")).ok !== false, "ダミー鍵を入れる");
    check((await setProviders({ providers: [chat, stt, cloud], defaults: { "text-to-text": "local", "speech-to-text": "cloud-stt" } })).ok, "クラウドの音声認識を既定にして保存できる");
    await win.reload({ waitUntil: "domcontentloaded" });
    await win.getByTestId("assistant-voice").waitFor({ state: "visible", timeout: 20_000 });
    await sleep(500);
    const dest2 = (await win.getByTestId("assistant-voice-dest").textContent()) ?? "";
    check(dest2.includes("llm.example.invalid"), "送信先のホスト名が常時出る", dest2);
    const n0 = fake.audio.length;
    await win.getByTestId("assistant-voice").click();
    await win.getByTestId("assistant-voice-confirm").waitFor({ state: "visible", timeout: 10_000 });
    check((await win.getByTestId("assistant-voice-recording").count()) === 0, "🔴 確認するまで録音は始まらない");
    await win.screenshot({ path: path.join(OUT_DIR, "3-confirm.png") });
    await win.getByTestId("assistant-voice-confirm-no").click();
    await sleep(500);
    check((await win.getByTestId("assistant-voice-confirm").count()) === 0 && (await win.getByTestId("assistant-voice-recording").count()) === 0 && fake.audio.length === n0, "やめると何も起きない");

    console.log("\n[3] 提供元が無い（負例）");
    check((await setProviders({ providers: [chat], defaults: { "text-to-text": "local" } })).ok, "音声認識の提供元を外して保存できる");
    await win.reload({ waitUntil: "domcontentloaded" });
    await win.getByTestId("assistant-voice-unavailable").waitFor({ state: "visible", timeout: 20_000 });
    check(!(await win.getByTestId("assistant-voice").isEnabled()), "🔴 提供元が無いとマイクは押せない");
    check(/提供元|provider/.test((await win.getByTestId("assistant-voice-unavailable").textContent()) ?? ""), "理由が画面に出る");
    await win.screenshot({ path: path.join(OUT_DIR, "4-unavailable.png") });
  } finally {
    clean();
    fake.server.close();
    await driver.stop().catch(() => undefined);
  }
  process.exit(summary() > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
