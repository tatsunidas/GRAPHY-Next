/*
 * 通信テスト（Settings ＞ DICOM 通信先 ＞ ［通信テスト］）と、通信先ごとの検索方式の実アプリ検査。
 *
 * 実行:  cd automator && GRAPHY_AUTOMATOR_HTTP_PORT=18420 GRAPHY_AUTOMATOR_SCP_PORT=18421 GRAPHY_AUTOMATOR_VITE_PORT=18423 \
 *          npx tsx src/spike/qrProbeCheck.ts
 *   事前: backend の jar を再ビルド（`cd backend && mvn -q -Dfrontend.skip=true -DskipTests clean package`）、
 *         偽の Q/R SCP を 2 つ起動（backend/src/test/.../qr/FakeQrScpMain。test-compile 後に test-classes＋依存の classpath で）:
 *           18424 RELAY1 DROP_ON_KEYS NumberOfStudyRelatedSeries,NumberOfStudyRelatedInstances false   ← 切断型（実例の再現）
 *           18425 PEER NORMAL 0 true GRAPHYNEXT                                                          ← 何も変えずに通る相手
 *         18429 は何も待ち受けない（届かない相手）。
 * 見るもの:
 *   負例: 既定のままの 切断型への検索は、Q/R 画面に「返事をせずに接続を切りました」と出る（0 件に見せない）
 *   正例: ［通信テスト］で最小の項目なら通ると分かり、［採用］→［保存］で通信先に書かれ、Q/R で検査が出る
 *   既定のまま通す経路: PEER は何も変えずに ✓、採用ボタンが出ず、保存しても find は付かない
 * 画面はスクリーンショットを .results/qr-probe-check に残す（目視用）。
 */
import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";

import { resetDb } from "../backend/dbReset.js";
import { dismissStartupDialogs } from "../common/dismissDialogs.js";
import { WebDriver } from "../driver/webDriver.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { createChecker } from "./computeSpikeShared.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "qr-probe-check");
const { check, summary } = createChecker();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function openSettings(page: Page): Promise<void> {
  await page.getByTestId("mainscreen-menu-system").click();
  await page.getByTestId("menu-item-settings").click();
  await page.getByTestId("settings-cat-dicomSend").click();
  await page.getByTestId("probe-open-0").waitFor({ state: "visible", timeout: 15_000 });
}

const tone = (page: Page, id: string) => page.getByTestId(`probe-row-${id}`).getAttribute("data-tone");

async function runProbe(page: Page, i: number): Promise<void> {
  await page.getByTestId(`probe-open-${i}`).click();
  await page.getByTestId("probe-start").click();
  await page.getByTestId("probe-summary").waitFor({ state: "visible", timeout: 150_000 });
}

async function main(): Promise<void> {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const driver = new WebDriver(undefined, { viewport: { width: 1400, height: 1700 }, locale: "ja-JP" });
  const base = `http://127.0.0.1:${driver.ports.http}`;
  const shot = (p: Page, name: string) => p.screenshot({ path: path.join(OUT_DIR, `${name}.png`), fullPage: true });
  const putSettings = (kv: Record<string, string>) =>
    fetch(`${base}/api/settings`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(kv) });
  const getSettings = async () => (await (await fetch(`${base}/api/settings`)).json()) as Record<string, string>;

  try {
    await driver.start();
    const page = driver.page;
    await page.addInitScript(() => { try { localStorage.setItem("graphy.locale", "ja"); } catch { /* */ } });
    await resetDb(driver.ports.http);
    await putSettings({
      "dicom.remoteAes": JSON.stringify([
        { aeTitle: "RELAY1", host: "127.0.0.1", port: 18424, tls: false },
        { aeTitle: "PEER", host: "127.0.0.1", port: 18425, tls: false },
        { aeTitle: "GONE", host: "127.0.0.1", port: 18429, tls: false },
      ]),
    });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
    await dismissStartupDialogs(page);

    console.log("\n[1] 負例: 既定のままの 切断型への検索は、API が分類つきのエラーで返す（0 件にしない）");
    const r1 = await fetch(`${base}/api/dicom/qr/find-studies`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ host: "127.0.0.1", port: 18424, calledAet: "RELAY1", matchKeys: {}, tls: false }),
    });
    const b1 = (await r1.json()) as Record<string, unknown>;
    check(r1.status === 502 && b1.kind === "DROPPED", "HTTP 502・kind=DROPPED（相手が応答せず切断）", { status: r1.status, body: b1 });
    const r1b = await fetch(`${base}/api/dicom/qr/find-studies`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ host: "127.0.0.1", port: 18425, calledAet: "PEER", matchKeys: {}, tls: false }),
    });
    const rows1b = (await r1b.json()) as { studyInstanceUid: string }[];
    check(r1b.status === 200 && rows1b.length === 1, "対照: 何も変えずに通る相手（PEER）は同じ検索で 1 件返る", { status: r1b.status, n: rows1b.length });

    console.log("\n[2] 負例: Q/R 画面（まだ何も設定していない）には、分類した説明が出る");
    await page.goto(`http://localhost:${driver.ports.vite}/#qr`, { waitUntil: "domcontentloaded" });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => /返事をせずに接続を切りました/.test(document.body.innerText), null, { timeout: 60_000 }).catch(() => undefined);
    // 通信先のタブは RELAY1 / PEER（GONE は疎通が通らず出ない）。RELAY1 のタブを開く
    await page.getByRole("button", { name: /RELAY1/ }).first().click().catch(() => undefined);
    await sleep(800);
    const qrText1 = await page.evaluate(() => document.body.innerText);
    check(/返事をせずに接続を切りました/.test(qrText1), "Q/R に「返事をせずに接続を切りました」と出る", qrText1.slice(0, 300));
    check(!/GONE/.test(qrText1), "届かない相手（GONE）は、疎通が通らないのでタブに出ない");
    await shot(page, "01-qr-before");

    console.log("\n[3] 正例: ［通信テスト］で通る探し方が見つかる（切断型）");
    await page.goto(`http://localhost:${driver.ports.vite}/`, { waitUntil: "domcontentloaded" });
    await dismissStartupDialogs(page);
    await openSettings(page);
    await runProbe(page, 0);
    await shot(page, "02-probe-psp");
    // 結果が出たら、自動で見える位置までスクロールされている（背の低いダイアログでも結果が隠れない）
    check(await page.getByTestId("probe-summary").evaluate((el) => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; }), "結論の行が、画面内に見えている");
    check((await tone(page, "echo")) === "ok", "① つながる ✓");
    check((await tone(page, "find")) === "ok", "② 検査を探せる ✓（標準では通らないが、通る探し方がある）");
    check((await tone(page, "get")) === "ng" && (await tone(page, "move")) === "ng", "③ GET・④ MOVE は ✕（この相手は受けない）");
    const findText = await page.getByTestId("probe-row-find").innerText();
    check(/標準の探し方では通らず/.test(findText), "②の文言「標準の探し方では通らず、…なら通りました」", findText.slice(0, 200));
    check((await page.getByTestId("probe-row-get").innerText()).includes("→"), "✕ の行に「次にすること」が出る");
    check(((await page.getByTestId("probe-pattern-find-standard").textContent()) ?? "").includes("通らない"), "探し方ごとの結果: 標準は「通らない」");
    check(((await page.getByTestId("probe-pattern-find-minimal").textContent()) ?? "").includes("通った"), "探し方ごとの結果: 最小の項目は「通った」");
    const report = (await page.getByTestId("probe-report").textContent().catch(() => "")) ?? "";
    check(/EOFException in State: Sta6/.test(report), "「詳しく見る」に、実例と同じ切断の証拠（EOFException in State: Sta6）", report.slice(0, 400));
    check(!/FAKE\^PATIENT|FAKE1/.test(report + findText), "患者の値（偽の氏名・ID）は画面にも報告にも出ない");

    console.log("\n[4] 採用 → 保存 → Q/R で検査が出る");
    check((await getSettings())["dicom.remoteAes"].includes('"find"') === false, "採用の前は find が保存されていない");
    await page.getByTestId("probe-adopt").click();
    check(await page.getByTestId("probe-adopted").isVisible(), "採用した旨が出る（保存はまだ）");
    check(!(await getSettings())["dicom.remoteAes"].includes('"find"'), "保存するまでは find が保存されない");
    await page.getByRole("button", { name: "保存", exact: true }).first().click();
    await page.waitForFunction(async () => true);
    await sleep(800);
    const saved = JSON.parse((await getSettings())["dicom.remoteAes"]) as { aeTitle: string; find?: { studyKeys?: string[] } }[];
    const relay = saved.find((a) => a.aeTitle === "RELAY1");
    check(!!relay?.find?.studyKeys?.includes("StudyInstanceUID") && !relay.find.studyKeys.includes("NumberOfStudyRelatedSeries"),
      "RELAY1 に、通った探し方（返却項目を減らしたもの）が保存された", relay);
    check(saved.find((a) => a.aeTitle === "PEER")?.find === undefined, "ほかの通信先（PEER）には find が付かない");
    const r4 = await fetch(`${base}/api/dicom/qr/find-studies`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ host: "127.0.0.1", port: 18424, calledAet: "RELAY1", matchKeys: {}, tls: false }),
    });
    const rows4 = (await r4.json()) as { studyInstanceUid: string }[];
    check(r4.status === 200 && rows4.length === 1 && rows4[0].studyInstanceUid === "1.2.fake.study",
      "同じ検索（API）が、保存した通信先の設定で通る（検査 UID が相手の値と一致）", { status: r4.status, rows4 });
    await page.goto(`http://localhost:${driver.ports.vite}/#qr`, { waitUntil: "domcontentloaded" });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => /FAKE/.test(document.body.innerText), null, { timeout: 60_000 }).catch(() => undefined);
    await page.getByRole("button", { name: /RELAY1/ }).first().click().catch(() => undefined);
    await sleep(1000);
    const qrText4 = await page.evaluate(() => document.body.innerText);
    check(!/返事をせずに接続を切りました/.test(qrText4), "Q/R に切断のエラーが出なくなった");
    check(/FAKE/.test(qrText4), "Q/R の一覧に検査（偽の患者名 FAKE）が出る", qrText4.slice(0, 300));
    await shot(page, "03-qr-after");

    console.log("\n[5] 既定のまま通す経路: PEER は何も変えずに全部 ✓。採用ボタンは出ない");
    await page.goto(`http://localhost:${driver.ports.vite}/`, { waitUntil: "domcontentloaded" });
    await dismissStartupDialogs(page);
    await openSettings(page);
    await runProbe(page, 1);
    await shot(page, "04-probe-peer");
    const peerFind = await page.getByTestId("probe-row-find").innerText();
    check((await tone(page, "find")) === "ok" && /標準の探し方のままで使えます/.test(peerFind), "② 標準のままで使える", peerFind.slice(0, 200));
    check((await tone(page, "get")) === "ok" && (await tone(page, "move")) === "ok", "③ GET・④ MOVE も ✓");
    check((await page.getByTestId("probe-adopt").count()) === 0, "採用ボタンは出ない");

    console.log("\n[6] 届かない相手: ① が ✕ で、以降は試さない");
    await page.getByTestId("probe-open-1").click(); // 閉じる
    await runProbe(page, 2);
    await shot(page, "05-probe-gone");
    check((await tone(page, "echo")) === "ng" && (await tone(page, "find")) === "muted", "① ✕・② 以降は「試していません」");
    check((await page.getByTestId("probe-row-echo").innerText()).includes("→"), "①に「次にすること」が出る");
  } finally {
    await driver.stop();
  }
  process.exit(summary() === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
