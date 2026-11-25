/*
 * 旧 jar（#766 より前の main）が実際に作ったマップ・フィルタ済みシリーズを、新しい jar が扱うときの検査（模したものでなく、実物）。
 *
 * 実行（2 段。どちらも専用ポート・前景＋timeout。前提: OLD_JAR=旧 jar、新 jar は今のコードで作り直してある）:
 *   OLDJAR_PHASE=make  GRAPHY_AUTOMATOR_BACKEND_JAR=$OLD_JAR  ... npx tsx src/spike/oldJarMapCheck.ts   # 旧 jar でマップを作って書き出す
 *   OLDJAR_PHASE=check ...                                    npx tsx src/spike/oldJarMapCheck.ts   # 新 jar で取り込み、断られることを確かめる
 *   MAP_ROOT=症例フォルダ（CT/ と SEG/ を持つ）。OLDJAR_OUT=書き出しの置き場。
 *
 *   make : 旧版の形（Secondary Capture・ImageType 3 つ目 TEXTURE・BitsStored=15）で、32768 以上の画素が実在することも確かめる。
 *   check: 取り込んだ旧版のシリーズは、ROI 特徴量・NIfTI の書き出しの両方で理由つきで断られる。
 *          正例として、新 jar が作ったマップは ROI 特徴量・NIfTI の書き出しの両方を通る（負例だけで済ませない）。
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { DesktopDriver } from "../driver/desktopDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { importPaths } from "../fixtures/importFixtures.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { PY, PY_FLAGS } from "./pythonCmd.js";

const ROOT = process.env.MAP_ROOT ?? "";
const OUT = process.env.OLDJAR_OUT ?? path.join(AUTOMATOR_ROOT, ".results", "old-jar-map");
const PHASE = process.env.OLDJAR_PHASE ?? "";
const failures: string[] = [];
let passed = 0;
function check(cond: boolean, label: string, detail?: unknown): void {
  if (cond) { passed++; console.log(`  [ok  ] ${label}`); } else { console.log(`  [FAIL] ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`); failures.push(label); }
}
async function call<T>(base: string, p: string, method: string, body?: unknown): Promise<T> {
  const res = await fetch(`${base}${p}`, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!res.ok) throw new Error(`${method} ${p} → HTTP ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}
interface Series { seriesInstanceUid: string; modality: string | null; seriesDescription: string | null }
interface Inst { sopInstanceUid: string }
async function textureMap(base: string, studyUid: string, src: string, seg: string, desc: string): Promise<string> {
  const job = await call<{ jobId: string }>(base, "/api/series/texture/jobs", "POST", { studyInstanceUid: studyUid, sourceSeriesUid: src, maskSeriesUid: seg,
    maskChannel: 0, feature: "FIRSTORDER_Mean", filterSize: 3, stride: 1, force2D: false, channel: 0, timePoint: 0, settings: { MASK_LABEL_INT: "1" },
    margin: 0, seriesDescription: desc, seriesNumber: null });
  for (let i = 0; i < 900; i++) {
    const st = await call<{ state: string; error?: string }>(base, `/api/series/texture/jobs/${job.jobId}`, "GET");
    if (st.state === "DONE") break;
    if (st.state === "FAILED" || st.state === "CANCELLED") throw new Error(`job ${st.state}: ${st.error}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  const all = await call<Series[]>(base, `/api/studies/${studyUid}/series`, "GET");
  const made = all.find((s) => s.seriesDescription === desc);
  if (!made) throw new Error(`マップのシリーズが見つからない: ${desc}`);
  return made.seriesInstanceUid;
}
async function download(base: string, studyUid: string, seriesUid: string, dir: string): Promise<string[]> {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const inst = await call<Inst[]>(base, `/api/studies/${studyUid}/series/${seriesUid}/instances`, "GET");
  for (const i of inst) {
    const res = await fetch(`${base}/api/instances/${i.sopInstanceUid}/file`);
    if (!res.ok) throw new Error(`download ${i.sopInstanceUid}: HTTP ${res.status}`);
    fs.writeFileSync(path.join(dir, `${i.sopInstanceUid}.dcm`), Buffer.from(await res.arrayBuffer()));
  }
  return inst.map((i) => i.sopInstanceUid);
}
async function features(base: string, body: Record<string, unknown>): Promise<unknown> {
  const s = await call<{ jobId: string }>(base, "/api/radiomics/features/jobs", "POST", body);
  for (let i = 0; i < 900; i++) {
    const st = await call<{ state: string; result?: unknown; error?: string }>(base, `/api/radiomics/features/jobs/${s.jobId}`, "GET");
    if (st.state === "DONE") return st.result;
    if (st.state === "FAILED" || st.state === "CANCELLED") throw new Error(`job ${st.state}: ${st.error}`);
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("job timeout");
}
async function niftiExport(base: string, studyUid: string, seriesUid: string): Promise<{ status: number; text: string }> {
  const res = await fetch(`${base}/api/nifti/export`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ studyUid, seriesUid }) });
  return { status: res.status, text: res.status === 200 ? "" : await res.text() };
}
const inspect = (dir: string): { sop: string; kind: string; bitsStored: number; highBit: number; max: number } => {
  const code = `import glob,json,sys,pydicom,numpy as np
fs=sorted(glob.glob(sys.argv[1]+'/*.dcm'));d=pydicom.dcmread(fs[0]);mx=max(int(np.frombuffer(pydicom.dcmread(f).PixelData,dtype='<u2').max()) for f in fs)  # 生のバイト（pydicom の pixel_array は BitsStored で切る）
print(json.dumps({'sop':str(d.SOPClassUID.name),'kind':'\\\\'.join(map(str,d.ImageType)),'bitsStored':int(d.BitsStored),'highBit':int(d.HighBit),'max':mx}))`;
  const r = spawnSync(PY, [...PY_FLAGS, "-c", code, dir], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr);
  return JSON.parse(r.stdout);
};

async function main(): Promise<void> {
  if (!ROOT || !fs.existsSync(ROOT) || !["make", "check"].includes(PHASE)) { console.log("[未達] MAP_ROOT・OLDJAR_PHASE=make|check を指定してください"); process.exitCode = 2; return; }
  fs.mkdirSync(OUT, { recursive: true });
  const d = new DesktopDriver();
  await d.start();
  const base = `http://127.0.0.1:${d.ports.http}`;
  try {
    await resetDb(d.ports.http);
    await importPaths(d.ports.http, [ROOT]);
    const studies = await call<{ studyInstanceUid: string }[]>(base, "/api/studies", "GET");
    const studyUid = studies[0].studyInstanceUid;
    const series = await call<Series[]>(base, `/api/studies/${studyUid}/series`, "GET");
    const ct = series.find((s) => s.modality === "CT")!;
    const seg = series.find((s) => s.modality === "SEG")!;
    if (PHASE === "make") {
      console.log("[make] 旧 jar でマップを作る");
      const uid = await textureMap(base, studyUid, ct.seriesInstanceUid, seg.seriesInstanceUid, "OLD-JAR map");
      const dir = path.join(OUT, "oldmap");
      await download(base, studyUid, uid, dir);
      const info = inspect(dir);
      console.log(`  旧 jar のマップ: ${JSON.stringify(info)}`);
      check(info.sop === "Secondary Capture Image Storage" && info.kind.split("\\")[2] === "TEXTURE" && info.bitsStored === 15 && info.highBit === 15,
        "旧 jar のマップは、旧版の形（SC・TEXTURE・BitsStored=15・HighBit=15）", info);
      check(info.max >= 32768, "32768 以上の画素が（生のバイトに）実在する（BitsStored=15 で切ると値が化ける）", info.max);
      fs.writeFileSync(path.join(OUT, "make.json"), JSON.stringify({ seriesInstanceUid: uid }));
    } else {
      console.log("[check] 新 jar で、旧 jar が作ったマップを取り込む");
      const old = path.join(OUT, "oldmap");
      check(fs.existsSync(old) && fs.readdirSync(old).length > 0, "前提: 旧 jar のマップが書き出してある", old);
      await importPaths(d.ports.http, [old]);
      const all = await call<Series[]>(base, `/api/studies/${studyUid}/series`, "GET");
      const oldS = all.find((s) => s.seriesDescription === "OLD-JAR map");
      check(!!oldS, "旧 jar のマップを取り込めた");
      const body = { studyInstanceUid: studyUid, sourceSeriesUid: oldS!.seriesInstanceUid, maskSeriesUid: seg.seriesInstanceUid, maskChannel: 0, channel: 0, timePoint: 0,
        settings: {}, recompute: true, roiModes: ["WHOLE_3D"] };
      let msg = "";
      try { await features(base, body); } catch (e) { msg = String((e as Error).message); }
      console.log(`  ROI 特徴量の断り: ${msg.slice(0, 120)}`);
      check(msg.includes("旧版で作られた"), "ROI 特徴量: 旧 jar のマップは理由つきで断られる", msg);
      const ex = await niftiExport(base, studyUid, oldS!.seriesInstanceUid);
      console.log(`  NIfTI 書き出し: HTTP ${ex.status} ${ex.text.slice(0, 80)}`);
      // 実アプリの書き出しは、SC（Secondary Capture）を焼き込み注釈の危険な SOP クラスとして先に断る（burnin-risky-sop-class）ので、
      // VolumeAssembler の npz-misdeclared-map（課題 32）までは届かない。ここで確かめるのは「黙って化けた値を書き出さない」まで。
      // npz-misdeclared-map 自体は単体の試験（NiftiWriterTest）で確かめている。この経路での確認は未達として残す。
      check(ex.status === 422 && /burnin-risky-sop-class|npz-misdeclared-map/.test(ex.text), "NIfTI の書き出し: 旧 jar のマップは断られる（値を書き出さない）", ex);
      console.log(`  [参考] 断った理由: ${ex.text.includes("npz-misdeclared-map") ? "npz-misdeclared-map（課題 32 の判定）" : "burnin-risky-sop-class（焼き込みの保護が先に断る。課題 32 の判定には届かない）"}`);
      // 正例: 新 jar が作ったマップは、どちらも通る
      const fresh = await textureMap(base, studyUid, ct.seriesInstanceUid, seg.seriesInstanceUid, "NEW-JAR map");
      let freshErr = "";
      try { await features(base, { ...body, sourceSeriesUid: fresh }); } catch (e) { freshErr = String((e as Error).message); }
      check(freshErr === "", "（正例）新 jar のマップは ROI 特徴量の入力になる", freshErr);
      const ex2 = await niftiExport(base, studyUid, fresh);
      check(ex2.status === 200, "（正例）新 jar のマップは NIfTI に書き出せる", ex2);
    }
  } finally {
    await d.stop();
  }
  console.log(`\n結果: 合格 ${passed} / 失敗 ${failures.length}`);
  if (failures.length) { console.log(failures.map((x) => `  - ${x}`).join("\n")); process.exitCode = 1; }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
