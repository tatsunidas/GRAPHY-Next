/*
 * 外部の計算機へ送る前の同意（main が描く窓）と監査ログの実機検証。設計: fw/remote-compute-design.md（段 4）。
 *
 * 実行:  cd automator && npx tsx src/spike/computeEgressCheck.ts
 *
 * 何を確かめるか（本物の Electron ＋ 本物の backend ＋ 本物の匿名化）:
 *   1. remote-compute を宣言していないプラグインは backend が 403 で弾く
 *   2. データを埋め込んだコードは要求の段階で弾く（code-embedded-data）
 *   3. 要求を作ると、匿名化した CT の npz ができる（まだ何も送らない）
 *   4. 同意は **main の窓**で出る。宛先・データ（SHA-256）・**コードの全文**が出る
 *   5. 確認のチェックを入れるまで「送信する」は押せない
 *   6. 送信する → approved:true／取り消す → approved:false
 *   7. **レンダラから内部経路は叩けない**（承認を偽造できない）・決定済みの要求は二度と聞かない
 *   8. 監査ログに 1 出来事 1 行が残り、**患者名・ID・コード全文・トークンが入らない**
 *
 * ⚠ 実際に送るのは段 5。ここで見るのは「送ってよいか」を決めるところまで。
 *
 * 前提: backend jar（`cd backend && mvn -q -Dfrontend.skip=true -DskipTests package`）・fixture ct-basic。
 */
import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";

import { DesktopDriver, DESKTOP_RUN_DATA_DIR } from "../driver/desktopDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { importFixtureCategory } from "../fixtures/importFixtures.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "compute-egress-check");
const PLUGIN_IDS = ["compute-egress-check", "compute-egress-denied"];
const ENDPOINT_ID = "automator-egress";
const AUDIT = path.join(DESKTOP_RUN_DATA_DIR, "compute-audit.jsonl");
// 監査ログにはコードの先頭 200 文字だけが残る。全文が残らないことを確かめるため、先頭を長くして
// 最後の行（float(v.mean())）が 200 文字より後ろに来るようにしておく。
const CODE = [
  "# automator: remote compute egress check (fw/remote-compute-design.md stage 4).",
  "# This header is intentionally long so that the last line falls beyond the 200-character code head",
  "# that the audit log keeps.",
  "import numpy as np",
  "z = np.load('inputs/0.npz')",
  "v = z['volume']",
  "print('__progress__', 1.0, 'done')",
  "print(v.shape, float(v.mean()))",
].join("\n");

const failures: string[] = [];
let passed = 0;
function check(cond: boolean, label: string, detail?: unknown): void {
  if (cond) {
    passed++;
    console.log(`  [ok  ] ${label}`);
  } else {
    console.log(`  [FAIL] ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
    failures.push(label);
  }
}

function installVerificationPlugins(): void {
  for (const id of PLUGIN_IDS) {
    const src = path.join(AUTOMATOR_ROOT, "plugins", id);
    const dst = path.join(DESKTOP_RUN_DATA_DIR, "plugins", id);
    fs.mkdirSync(dst, { recursive: true });
    for (const name of fs.readdirSync(src)) fs.copyFileSync(path.join(src, name), path.join(dst, name));
  }
}

interface Ctx {
  driver: DesktopDriver;
  base: string;
}

async function createRequest(ctx: Ctx, pluginId: string, body: unknown): Promise<{ status: number; json: any }> {
  const r = await fetch(`${ctx.base}/api/plugins/${pluginId}/compute/egress`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json().catch(() => null) };
}

/** レンダラから同意を求め、main の同意窓を掴む。 */
async function openConsent(ctx: Ctx, page: Page, requestId: string): Promise<Page> {
  await page.evaluate((id) => {
    const w = window as unknown as { __consent?: unknown; graphyDesktop: { computeConfirm: (id: string) => Promise<unknown> } };
    w.__consent = undefined;
    void w.graphyDesktop.computeConfirm(id).then((r) => (w.__consent = r));
  }, requestId);
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const win = ctx.driver.app.windows().find((w) => w.url().endsWith("computeConsent.html"));
    if (win) {
      await win.getByTestId("consent-code").waitFor({ state: "visible", timeout: 10_000 });
      await win.waitForFunction(() => (document.getElementById("code")?.textContent ?? "").length > 0);
      return win;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("同意の窓が開きません");
}

async function consentResult(page: Page): Promise<any> {
  await page.waitForFunction(() => (window as unknown as { __consent?: unknown }).__consent !== undefined, null, {
    timeout: 15_000,
  });
  return page.evaluate(() => (window as unknown as { __consent?: unknown }).__consent);
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  installVerificationPlugins();
  fs.rmSync(AUDIT, { force: true });

  const driver = new DesktopDriver();
  let endpointsFile: string | null = null;
  let endpointsBackup: string | null = null;
  try {
    await driver.start();
    const ctx: Ctx = { driver, base: `http://localhost:${driver.ports.http}` };
    const page = driver.page;
    await resetDb(driver.ports.http);
    await importFixtureCategory(driver.ports.http, "ct-basic");

    // 接続先を 1 つ登録する（送り先の追加の確認は段 2 で見たので、ここは「許可」で通す）
    const cwd = await driver.app.evaluate(({ dialog }) => {
      dialog.showMessageBoxSync = (() => 0) as typeof dialog.showMessageBoxSync;
      return process.cwd();
    });
    endpointsFile = path.join(cwd, "compute-endpoints.json");
    endpointsBackup = fs.existsSync(endpointsFile) ? fs.readFileSync(endpointsFile, "utf8") : null;
    const saved = await page.evaluate(
      (id) =>
        (window as unknown as { graphyDesktop: { computeEndpointsSet: (c: unknown) => Promise<{ ok: boolean }> } })
          .graphyDesktop.computeEndpointsSet({ endpoints: [{ id, label: "Automator GPU", url: "https://gpu.example.org/hub/" }] }),
      ENDPOINT_ID,
    );
    if (!saved.ok) throw new Error("接続先を登録できません: " + JSON.stringify(saved));

    const studies = (await (await fetch(`${ctx.base}/api/studies`)).json()) as { studyInstanceUid: string; patientName: string; patientId: string }[];
    const study = studies[0];
    const series = (await (await fetch(`${ctx.base}/api/studies/${study.studyInstanceUid}/series`)).json()) as {
      seriesInstanceUid: string;
      modality: string;
    }[];
    const ct = series.find((s) => s.modality === "CT") ?? series[0];
    console.log(`対象: ${ct.modality} series (${study.patientId})`);
    const input = { studyUid: study.studyInstanceUid, seriesUid: ct.seriesInstanceUid, format: "npz" };

    // --- 1・2. 要求の段階で弾くもの ---
    console.log("\n[1] 要求の段階で弾く");
    const denied = await createRequest(ctx, "compute-egress-denied", { endpointId: ENDPOINT_ID, inputs: [input], code: CODE });
    check(denied.status === 403 && denied.json?.error === "permission-denied", "🔴 remote-compute 未宣言は 403", denied);
    const embedded = await createRequest(ctx, "compute-egress-check", {
      endpointId: ENDPOINT_ID,
      inputs: [input],
      code: "px = '" + "QUJD".repeat(2000) + "'",
    });
    check(embedded.status === 422 && embedded.json?.error === "code-embedded-data", "🔴 データを埋め込んだコードは弾く", embedded.json);

    // --- 3・4・5・6. 同意して送ってよいことにする ---
    console.log("\n[2] 同意（送信する）");
    const req1 = await createRequest(ctx, "compute-egress-check", { endpointId: ENDPOINT_ID, inputs: [input], code: CODE });
    check(req1.status === 200 && /^egr_/.test(req1.json?.requestId ?? ""), "要求ができる（匿名化した npz を作る）", req1);
    const ds = req1.json?.datasets?.[0];
    check(ds?.format === "npz" && ds?.bytes > 0 && /^[0-9a-f]{64}$/.test(ds?.sha256 ?? ""), "データセットの要約（大きさ・SHA-256）", ds);

    const win = await openConsent(ctx, page, req1.json.requestId);
    check(true, "🔴 同意は main の窓で出る（レンダラの外）");
    check((await win.getByTestId("consent-url").textContent()) === "https://gpu.example.org/hub/", "宛先の URL が出る");
    check((await win.getByTestId("consent-code").textContent()) === CODE, "🔴 コードの全文がそのまま出る");
    const table = (await win.getByTestId("consent-datasets").textContent()) ?? "";
    check(table.includes(ds?.sha256 ?? "x") && table.includes("CT"), "データの SHA-256 と種類が出る", table);
    check(await win.getByTestId("consent-send").isDisabled(), "🔴 確認のチェックまで「送信する」は押せない");
    await win.screenshot({ path: path.join(OUT_DIR, "1-consent.png") });
    await win.getByTestId("consent-ack").check();
    check(!(await win.getByTestId("consent-send").isDisabled()), "チェックを入れると押せる");
    await win.getByTestId("consent-send").click();
    const r1 = await consentResult(page);
    check(r1?.ok === true && r1?.approved === true, "送信する → approved:true", r1);
    const again = await page.evaluate(
      (id) => (window as unknown as { graphyDesktop: { computeConfirm: (id: string) => Promise<unknown> } }).graphyDesktop.computeConfirm(id),
      req1.json.requestId,
    );
    check((again as { error?: string })?.error === "not-pending", "決定済みの要求は二度と聞かない", again);

    // --- 6. 取り消す ---
    console.log("\n[3] 同意（取り消す）");
    const req2 = await createRequest(ctx, "compute-egress-check", { endpointId: ENDPOINT_ID, inputs: [input], code: CODE });
    const win2 = await openConsent(ctx, page, req2.json.requestId);
    await win2.getByTestId("consent-cancel").click();
    const r2 = await consentResult(page);
    check(r2?.ok === true && r2?.approved === false, "取り消す → approved:false", r2);

    // --- 7. レンダラから承認を偽造できない ---
    console.log("\n[4] 迂回できない");
    const req3 = await createRequest(ctx, "compute-egress-check", { endpointId: ENDPOINT_ID, inputs: [input], code: CODE });
    const forged = await page.evaluate(async ({ base, id }) => {
      try {
        const r = await fetch(`${base}/api/internal/compute/egress/${id}/decision`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ approve: true, contentHash: "x" }),
        });
        return r.status;
      } catch (e) {
        return String(e); // CORS で読めない場合も「通らなかった」
      }
    }, { base: ctx.base, id: req3.json.requestId });
    check(forged === 404 || typeof forged === "string", "🔴 レンダラからの承認は内部経路で弾かれる", forged);
    const bad = await page.evaluate(() =>
      (window as unknown as { graphyDesktop: { computeConfirm: (id: string) => Promise<unknown> } }).graphyDesktop.computeConfirm("../x"),
    );
    check((bad as { error?: string })?.error === "bad-request-id", "形の悪い id は受け付けない", bad);

    // --- 8. 監査ログ ---
    console.log("\n[5] 監査ログ");
    const lines = fs.existsSync(AUDIT)
      ? fs.readFileSync(AUDIT, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>)
      : [];
    const events = lines.map((l) => l.event);
    check(events.includes("egress-refused"), "弾いた要求が残る", events);
    check(events.filter((e) => e === "egress-requested").length === 3, "要求が 3 件残る", events);
    check(events.includes("egress-approved") && events.includes("egress-denied"), "承認と拒否が残る", events);
    const raw = fs.existsSync(AUDIT) ? fs.readFileSync(AUDIT, "utf8") : "";
    check(!raw.includes(study.patientId) && !raw.includes(study.patientName ?? "\u0000"), "🔴 患者名・ID が入らない");
    check(!raw.includes("float(v.mean())"), "🔴 コードの全文は入らない（先頭とハッシュだけ）");
    check(!raw.includes(ct.seriesInstanceUid), "元のシリーズ UID は入らない");
  } finally {
    await driver.stop();
    if (endpointsFile) {
      if (endpointsBackup !== null) fs.writeFileSync(endpointsFile, endpointsBackup);
      else fs.rmSync(endpointsFile, { force: true });
    }
  }
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
