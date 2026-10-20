/*
 * 第三者プラグインの通し検査（OX-PLG-007 段 1）。テンプレートから作ったプラグインを、第三者が自分の鍵で署名して
 * GitHub Release に出したときに、利用者の導入が仕様どおり通り・乗っ取りが拒否されることを、本物の GitHub と本物の
 * backend で確かめる。
 *
 * 実行:  cd automator && E2E_REPO=tatsunidas/graphy-next-plugin-e2e-check \
 *          E2E_KEY_A=5E0F9AAFBDA930EB E2E_KEY_B=98EA93CE0F6A5CEC npx tsx src/spike/pluginThirdPartyCheck.ts
 * 前提:  検査用リポジトリに Release がある（正例 v0.1.0・v0.1.1＝テンプレートの release.yml が作ったもの、
 *        負例 v0.2.0〜v0.2.3＝攻撃者の操作を手で再現したもの）。鍵 A（作者）・B（乗っ取り役）は使い捨ての検査鍵で、
 *        公式鍵（98EA7C6BA2D50118）・本体の trusted-keys とは無関係。鍵 ID は minisign.pub のコメントと同じ表記（大文字）。
 *
 * 何を確かめるか:
 *   E2E_POSITIVE_ONLY=1 のときは負例を省く（雛形から作った使い捨てのリポジトリには負例用のリリースが無い。段 2a の確認用）
 *   正例 1  v0.1.0: 署名あり・鍵は初めて（first-use）→ 同意画面が要る。導入すると台帳に鍵 A が固定される
 *   正例 2  v0.1.1: 固定した鍵 A と同じ → pinned・押すだけ（autoInstallable）。導入できる
 *   負例（固定済みの A に対して。いずれも「届いている」ことを確かめたうえで、拒否・台帳不変を見る）
 *     (a) v0.2.0 zip を改ざん（sha256・署名は正規のまま）  (b) v0.2.1 鍵 B で署名・公開鍵は A のまま
 *     (c) v0.2.2 署名を剥がす                             (d) v0.2.3 鍵 B で署名し公開鍵も B に差し替え（鍵ごと乗っ取り）
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { DesktopDriver, DESKTOP_RUN_DATA_DIR } from "../driver/desktopDriver.js";
import { createChecker } from "./computeSpikeShared.js";

const REPO = process.env.E2E_REPO ?? "";
const KEY_A = (process.env.E2E_KEY_A ?? "").toUpperCase();
const KEY_B = (process.env.E2E_KEY_B ?? "").toUpperCase();
const positiveOnly = process.env.E2E_POSITIVE_ONLY === "1";
if (!REPO || !KEY_A || (!positiveOnly && !KEY_B)) throw new Error("E2E_REPO / E2E_KEY_A（負例も見るなら E2E_KEY_B）を環境変数で渡してください");
const OFFICIAL = "98EA7C6BA2D50118";
if (KEY_A === OFFICIAL || (KEY_B && KEY_B === OFFICIAL)) throw new Error("検査鍵に公式鍵が指定されている");

const PORTS = { http: 19490, scp: 19491, vite: 19493 };
const PLUGINS_DIR = path.join(DESKTOP_RUN_DATA_DIR, "plugins");
const base = `http://localhost:${PORTS.http}`;
const { check, summary } = createChecker();
const pending: string[] = [];
function pend(label: string, why: string): void {
  console.log(`  [未達] ${label} — ${why}`);
  pending.push(label);
}

interface Preview {
  id: string; version: string; signature: string; signerKeyId: string | null; signatureProblem: string | null;
  autoInstallable: boolean; installable: boolean; integrityVerified: boolean; sha256: string; trust: string;
}
interface Ledger { id: string; version: string; trust: string; signerKeyId: string | null; signerPublicKey: string | null }

async function post(url: string, body: unknown): Promise<{ status: number; json: any }> {
  const r = await fetch(`${base}${url}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const text = await r.text();
  let json: any = text;
  try { json = JSON.parse(text); } catch { /* 本文が JSON でない */ }
  return { status: r.status, json };
}
const inspect = (version: string) => post("/api/plugin-manager/inspect/github", { repo: REPO, version });
const install = (version: string, sha: string) =>
  post("/api/plugin-manager/install/github", { repo: REPO, version, confirmedSha256: sha, acknowledgeUnverified: false });

async function ledger(): Promise<Ledger[]> {
  const r = await fetch(`${base}/api/plugin-manager/installed`);
  if (!r.ok) throw new Error(`installed → HTTP ${r.status}`);
  return (await r.json()) as Ledger[];
}

/** 台帳とプラグインフォルダの指紋。拒否のあとに変わっていないことを見る。 */
function fingerprint(): string {
  const h = crypto.createHash("sha256");
  const walk = (d: string): void => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((x, y) => x.name.localeCompare(y.name))) {
      const p = path.join(d, e.name);
      if (e.name === "catalog-cache.json") continue;
      if (e.isDirectory()) walk(p);
      else { h.update(path.relative(PLUGINS_DIR, p)); h.update(fs.readFileSync(p)); }
    }
  };
  walk(PLUGINS_DIR);
  return h.digest("hex");
}

async function ensureOptIn(driver: DesktopDriver): Promise<void> {
  const st = (await (await fetch(`${base}/api/plugin-manager/status`)).json()) as { installEnabled: boolean };
  if (st.installEnabled) return;
  await driver.app.evaluate(({ dialog }) => {
    dialog.showMessageBoxSync = (() => 0) as typeof dialog.showMessageBoxSync; // 「許可する」
  });
  const ok = await driver.page.evaluate(() =>
    (window as unknown as { graphyDesktop: { pluginInstallOptIn: (b: boolean) => Promise<{ ok: boolean }> } })
      .graphyDesktop.pluginInstallOptIn(true).then((r) => r.ok));
  if (!ok) throw new Error("opt-in failed");
}

function cleanPlugins(): void {
  for (const f of ["installed.json", "bundled.json", "catalog-cache.json"]) fs.rmSync(path.join(PLUGINS_DIR, f), { force: true });
  fs.rmSync(path.join(PLUGINS_DIR, "e2e-check"), { recursive: true, force: true });
}

/** 負例の 1 件。届いていること（本物のリリースを読めたこと）と、拒否と、台帳の不変を見る。 */
async function negative(label: string, version: string, expectFetched: RegExp): Promise<void> {
  const before = fingerprint();
  const ledgerBefore = JSON.stringify(await ledger());
  const r = await inspect(version);
  const detail = r.status === 200
    ? `preview signature=${r.json.signature} problem=${r.json.signatureProblem} installable=${r.json.installable} auto=${r.json.autoInstallable}`
    : `HTTP ${r.status} ${JSON.stringify(r.json).slice(0, 300)}`;
  console.log(`    ${label} → ${detail}`);

  // 届いていること: 200 なら中身（版）が読めている。失敗なら、理由がこのリリースの検査結果であって「見つからない」等ではない
  const reached = r.status === 200 ? r.json.version === version : expectFetched.test(JSON.stringify(r.json));
  check(reached, `${label}: 本物のリリースに届いている（検査の前提）`, detail);

  const rejectedAtInspect = r.status !== 200 || r.json.autoInstallable === false && r.json.installable === false
    || r.json.signature === "invalid";
  check(rejectedAtInspect, `🔴 ${label}: 導入前検査で拒否される（押すだけで入らない・同意画面でも通せない）`, detail);

  // 検査で通ってしまっても、実際の導入で止まること（二重の確認）。検査で 200 のときだけ試す
  if (r.status === 200 && r.json.sha256) {
    const inst = await install(version, r.json.sha256);
    check(inst.status !== 200, `🔴 ${label}: 実際の導入も拒否される`, `HTTP ${inst.status}`);
  }
  check(fingerprint() === before && JSON.stringify(await ledger()) === ledgerBefore, `🔴 ${label}: 台帳・プラグインフォルダが変わらない`);
}

async function main(): Promise<void> {
  cleanPlugins();
  const driver = new DesktopDriver(PORTS);
  try {
    await driver.start();
    await driver.page.reload({ waitUntil: "domcontentloaded" });
    await ensureOptIn(driver);

    console.log("\n[正例 1] 初めての署名者（v0.1.0）");
    const p1 = await inspect("0.1.0");
    check(p1.status === 200, "inspect が 2xx", `HTTP ${p1.status} ${JSON.stringify(p1.json).slice(0, 200)}`);
    const v1 = p1.json as Preview;
    check(v1.id === "e2e-check" && v1.version === "0.1.0", "id・版が読めている", [v1.id, v1.version]);
    check(v1.signature === "first-use", "署名は first-use（初めての鍵）", v1.signature);
    check(v1.signerKeyId?.toUpperCase() === KEY_A, "署名の鍵 ID は作者の鍵 A", v1.signerKeyId);
    check(v1.autoInstallable === false, "同意画面が要る（押すだけでは入らない）");
    check(v1.integrityVerified === true, "sha256 で完全性を確認できた");
    const i1 = await install("0.1.0", v1.sha256);
    check(i1.status === 200, "同意したあとの導入が通る", `HTTP ${i1.status} ${JSON.stringify(i1.json).slice(0, 200)}`);
    const l1 = (await ledger()).find((p) => p.id === "e2e-check");
    check(l1?.version === "0.1.0", "台帳に 0.1.0 が入った", l1);
    check(l1?.signerKeyId?.toUpperCase() === KEY_A && !!l1?.signerPublicKey, "台帳に鍵 A の ID と公開鍵が固定された", l1);
    console.log(`    台帳: trust=${l1?.trust}`);

    console.log("\n[正例 2] 同じ署名者の更新（v0.1.1）");
    const p2 = await inspect("0.1.1");
    check(p2.status === 200 && p2.json.signature === "pinned", "署名は pinned（固定した鍵と同じ）", p2.json.signature);
    check(p2.json.autoInstallable === true, "押すだけで入る（同意画面なし）");
    const i2 = await install("0.1.1", p2.json.sha256);
    check(i2.status === 200, "更新の導入が通る", `HTTP ${i2.status}`);
    check((await ledger()).find((p) => p.id === "e2e-check")?.version === "0.1.1", "台帳が 0.1.1 になった");

    if (positiveOnly) {
      pend("負例（zip 改ざん・別の鍵・署名の剥がし・鍵ごとの差し替え）", "E2E_POSITIVE_ONLY=1 のため省略（段 1 の完全な検査で確認済み）");
    } else {
      console.log("\n[負例] 固定済みの鍵 A に対する乗っ取り");
      await negative("(a) zip を改ざん", "0.2.0", /sha256|checksum|digest|signature/i);
      await negative("(b) 鍵 B で署名・公開鍵は A のまま", "0.2.1", /signature|key/i);
      await negative("(c) 署名を剥がす", "0.2.2", /signature|unsigned|key/i);
      await negative("(d) 鍵 B で署名し公開鍵も B に差し替え", "0.2.3", /signature|key/i);
      check(KEY_B !== KEY_A, "（前提）乗っ取り役の鍵 B は作者の鍵 A と別");
    }
  } finally {
    await driver.stop().catch(() => {});
    cleanPlugins();
  }

  pend("Windows・macOS 実機", "Linux 機のみで実行した");
  pend("ネットワーク断・GitHub のレート制限時の挙動", "本検査の範囲外");
  const failed = summary();
  console.log(`未達 ${pending.length} 件: ${pending.join(" / ")}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
