/*
 * マスク無しの単純X線（DX）は、local の計算機にだけ渡せることの実機検証。設計: fw/remote-compute-design.md §3.2・§22
 *
 * 実行:  cd automator && GRAPHY_AUTOMATOR_HTTP_PORT=18890 GRAPHY_AUTOMATOR_SCP_PORT=18891 GRAPHY_AUTOMATOR_VITE_PORT=18893 \
 *          npx tsx src/spike/computeLocalCxrCheck.ts
 *   起動前に frontend/node_modules/.vite を消すこと。Linux 専用。
 *   前提: backend jar（このブランチで作ったもの）・fixture cxr-dx（実物の胸部X線）・jupyter_server と ipykernel の入った Python が PATH 上にあること。
 *
 * 本物の Electron ＋ 本物の backend ＋ 本物の Python で:
 *   1. 外部の計算機を宛先にすると、マスク無しの DX は 422 burnin-risky-modality で断られる（負例）
 *   2. local を宛先にすると通る。同意の窓に「焼き込みは塗らない」の注意が出る（スクリーンショットで目視）
 *   3. 承認 → 実行 → 届いたバイト列の SHA-256 が同意画面の値と一致・届いたデータに架空の患者情報・元の UID が無い
 *   4. 外部の宛先に対する DX の断りは、local を一度使った後でも変わらない
 */
import fs from "node:fs";
import path from "node:path";

import { DesktopDriver, DESKTOP_RUN_DATA_DIR } from "../driver/desktopDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { importFixtureCategory } from "../fixtures/importFixtures.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { approvedSha as readApprovedSha, consentWindow, createChecker, launchRunJobPlugin as launchPlugin, runJobOutcome as outcome } from "./computeSpikeShared.js";

const { check, summary } = createChecker();
const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "compute-local-cxr-check");
const PLUGIN_ID = "compute-runjob-check";
const AUDIT = path.join(DESKTOP_RUN_DATA_DIR, "compute-audit.jsonl");
const EXTERNAL_ID = "automator-external";
const PHI = ["TEST^NIH^CXR", "TEST-PHI-0001", "TEST HOSPITAL"];
// DX には患者座標が無いので npz の spacing は NaN になる（設計 §3.4）。JSON に NaN は書けないので null にする
const SCRIPT = [
  "import hashlib, json, os, math, numpy as np",
  "def clean(x):",
  "    if isinstance(x, float): return x if math.isfinite(x) else None",
  "    if isinstance(x, list): return [clean(i) for i in x]",
  "    if isinstance(x, dict): return {k: clean(v) for k, v in x.items()}",
  "    return x",
  "raw = open('inputs/0.npz', 'rb').read()",
  "z = np.load('inputs/0.npz')",
  "v = z['volume']",
  "print('__progress__', 0.5, 'loaded')",
  "summary = {",
  "    'sha256': hashlib.sha256(raw).hexdigest(),",
  "    'shape': list(v.shape),",
  "    'dtype': str(v.dtype),",
  "    'min': float(v.min()), 'max': float(v.max()), 'nonconstant': bool(v.max() > v.min()),",
  "    'spacing': clean([float(x) for x in z['spacing']]),",
  "    'meta': clean(json.loads(bytes(z['meta.json']))),",
  "}",
  "json.dump(summary, open('outputs/summary.json', 'w'))",
  "print('shape', v.shape)",
].join("\n");

const CODE = [
  "import numpy as np",
  "z = np.load('inputs/0.npz')",
  "print('__progress__', 1.0, 'done')",
  "print(z['volume'].shape)",
].join("\n");

async function createRequest(base: string, body: unknown): Promise<{ status: number; json: any }> {
  const r = await fetch(`${base}/api/plugins/${PLUGIN_ID}/compute/egress`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json().catch(() => null) };
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const dst = path.join(DESKTOP_RUN_DATA_DIR, "plugins", PLUGIN_ID);
  fs.mkdirSync(dst, { recursive: true });
  for (const n of ["plugin.json", "ui.js"]) fs.copyFileSync(path.join(AUTOMATOR_ROOT, "plugins", PLUGIN_ID, n), path.join(dst, n));
  fs.rmSync(AUDIT, { force: true });

  const driver = new DesktopDriver();
  let endpointsFile: string | null = null;
  let endpointsBackup: string | null = null;
  try {
    await driver.start();
    const page = driver.page;
    page.on("console", (m) => {
      if (m.type() === "error") console.log(`  [renderer error] ${m.text()}`);
    });
    await resetDb(driver.ports.http);
    await importFixtureCategory(driver.ports.http, "cxr-dx");
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
    const cwd = await driver.app.evaluate(({ dialog }) => {
      dialog.showMessageBoxSync = (() => 0) as typeof dialog.showMessageBoxSync;
      return process.cwd();
    });
    endpointsFile = path.join(cwd, "compute-endpoints.json");
    endpointsBackup = fs.existsSync(endpointsFile) ? fs.readFileSync(endpointsFile, "utf8") : null;

    const base = `http://localhost:${driver.ports.http}`;
    const studies = (await (await fetch(`${base}/api/studies`)).json()) as { studyInstanceUid: string; patientId: string }[];
    const series = (await (await fetch(`${base}/api/studies/${studies[0].studyInstanceUid}/series`)).json()) as {
      seriesInstanceUid: string; modality: string; numberOfInstances: number;
    }[];
    const dx = series.find((s) => s.modality === "DX");
    check(studies.length === 1 && !!dx, "実物の DX が 1 件取り込まれている（操作が効いている前提）", series);
    if (!dx) throw new Error("DX が取り込まれていません");
    const input = { studyUid: studies[0].studyInstanceUid, seriesUid: dx.seriesInstanceUid };

    // 外部の計算機を 1 つ登録する（送らないので到達できなくてよい）
    const set = await page.evaluate(
      async (id) =>
        (window as unknown as { graphyDesktop: { computeEndpointsSet: (c: unknown) => Promise<{ ok: boolean }> } })
          .graphyDesktop.computeEndpointsSet({ endpoints: [{ id, label: "Automator external GPU", url: "https://gpu.example.org/hub/" }] }),
      EXTERNAL_ID,
    );
    check(set.ok === true, "外部の計算機を登録できる", set);

    console.log("\n[1] 外部の宛先は、マスク無しの DX を断る（負例）");
    const ext = await createRequest(base, { endpointId: EXTERNAL_ID, inputs: [input], code: CODE });
    check(ext.status === 422 && ext.json?.error === "burnin-risky-modality", "外部宛て: 422 burnin-risky-modality", ext);

    console.log("\n[2] local の宛先は通り、同意画面に注意が出る（正例）");
    await launchPlugin(page, { ...input, endpointId: "local", script: SCRIPT });
    const win = await consentWindow(driver, 180_000);
    const title = (await win.locator("#title").textContent()) ?? "";
    const note = (await win.getByTestId("consent-note").textContent()) ?? "";
    const modality = (await win.locator("#data-body tr").first().textContent()) ?? "";
    check(/この PC|this PC/.test(title), "題が『この PC でコードを実行します』（ja/en）", title);
    check(/焼き込み|burned into/.test(note) && /塗らず|not painted/.test(note), "注意に『焼き込みは塗らない』が出る", note);
    check(/DX/.test(modality), "データの種類に DX が出る", modality);
    await win.screenshot({ path: path.join(OUT_DIR, "consent-local-dx.png") });

    const approvedSha = await readApprovedSha(win);
    await win.getByTestId("consent-ack").check();
    await win.getByTestId("consent-send").click();
    const run = await outcome(page, 240_000);
    const o = run.outcome;
    fs.writeFileSync(path.join(OUT_DIR, "outcome.json"), JSON.stringify(run, null, 2));

    console.log("\n[3] 実行と結果");
    check(o.ok === true && o.status === "ok", "実行が最後まで走る", { error: o.error, stderr: o.stderr, ev: o.errorValue });
    const s = o.summary ?? {};
    check(s.sha256 === approvedSha && approvedSha.length === 64, "🔴 届いたバイト列の SHA-256 が同意画面の値と一致する", { received: s.sha256, approved: approvedSha });
    check(Array.isArray(s.shape) && s.shape.slice(-2).join("x") === "1024x1024" && s.nonconstant === true, "実物の画素（1024x1024・定数でない）が届いている", { shape: s.shape, min: s.min, max: s.max });
    const metaText = JSON.stringify(s.meta ?? {});
    check(![studies[0].patientId, dx.seriesInstanceUid, ...PHI].some((p) => metaText.includes(p)), "🔴 届いたデータに患者 ID・元の UID・架空の患者情報が無い", s.meta);

    const events = fs.readFileSync(AUDIT, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const req = events.find((e: { event: string }) => e.event === "egress-requested");
    check(req?.endpointKind === "local", "監査: endpointKind=local", req);
    check(events.find((e: { event: string }) => e.event === "compute-finished")?.outcome === "ok", "監査: 結果 ok");

    console.log("\n[4] local を使った後も、外部の宛先は断る（負例）");
    const ext2 = await createRequest(base, { endpointId: EXTERNAL_ID, inputs: [input], code: CODE });
    check(ext2.status === 422 && ext2.json?.error === "burnin-risky-modality", "外部宛て: 422 burnin-risky-modality（変わらない）", ext2);
  } finally {
    if (endpointsFile) {
      if (endpointsBackup !== null) fs.writeFileSync(endpointsFile, endpointsBackup);
      else fs.rmSync(endpointsFile, { force: true });
    }
    await driver.stop();
  }
  if (summary() > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
