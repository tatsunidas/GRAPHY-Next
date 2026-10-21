// 本体の backend が返すシリーズのレイアウトと、ポータブル版がブラウザ側でヘッダから組むレイアウトを、
// 同じデータで突き合わせる（スライスの並び・次元の数・間隔）。旧と新をその場で両方実行する。
//   PORTABLE_FIXTURE=<DICOM のフォルダ（; 区切りで複数）> PORTABLE_MEDIA=<上と同じデータを Export した媒体のルート>
//   npx tsx src/spike/portableLayoutCompare.ts
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { pathToFileURL } from "node:url";

// frontend のソースを実行時に読み込む（automator の tsc の rootDir の外にあるため静的 import にしない）。
const FE = path.join(AUTOMATOR_ROOT, "..", "frontend", "portable", "src");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { buildLayoutDto, readHeaders } = (await import(pathToFileURL(path.join(FE, "layout.ts")).href)) as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { parseDicomDirBytes } = (await import(pathToFileURL(path.join(FE, "dicomdir.ts")).href)) as any;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const JAR = path.join(AUTOMATOR_ROOT, "..", "backend", "target", "graphy-next-backend.jar");
const MEDIA = process.env.PORTABLE_MEDIA!;
let fail = 0;
let known = 0;
const check = (ok: boolean, name: string, d?: unknown) => {
  if (!ok) fail++;
  console.log(`  ${ok ? "合格" : "失敗"}  ${name}${ok || d === undefined ? "" : "  → " + JSON.stringify(d)}`);
};

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
}

interface Dto {
  nZ: number; nC: number; nT: number;
  cells: { c: number; z: number; t: number; sopInstanceUid: string; frame?: number }[];
  pixelSpacingRow: number; pixelSpacingCol: number; imageWidth: number; imageHeight: number;
  zSpatial: { z: number; imagePositionPatient: number[] }[] | null;
  axes?: { stackAxis: string } | null;
}

const dataDir = path.join(AUTOMATOR_ROOT, ".results", "portable-compare");
fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(dataDir, { recursive: true });
const httpPort = await freePort();
const be = spawn("java", ["--add-opens", "java.base/java.io=ALL-UNNAMED", "--add-opens", "java.desktop/javax.imageio.stream=ALL-UNNAMED", "-jar", JAR, "--spring.profiles.active=standalone", `--server.port=${httpPort}`, `--graphy.dicom.scp.port=${await freePort()}`], { cwd: dataDir, stdio: "ignore" });
const launcher = spawn(`"${path.join(MEDIA, "START-VIEWER.bat")}"`, [], { cwd: MEDIA, env: { ...process.env, GRAPHY_VIEWER_NO_BROWSER: "1", GRAPHY_VIEWER_IDLE_SECONDS: "90" }, shell: true, stdio: ["ignore", "pipe", "pipe"] });
let lout = "";
launcher.stdout?.on("data", (d: Buffer) => (lout += d.toString()));
try {
  const base = `http://127.0.0.1:${httpPort}`;
  for (let i = 0; i < 240; i++) {
    try { if ((await fetch(`${base}/api/studies`)).ok) break; } catch { /* まだ */ }
    await sleep(500);
  }
  const paths = (process.env.PORTABLE_FIXTURE ?? "").split(path.delimiter).map((x) => x.replace(/\\/g, "/"));
  const imp = await fetch(`${base}/api/import/paths`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ paths }) });
  check(imp.ok, "（前提）フィクスチャを backend に取り込めた");

  let url = "";
  for (let i = 0; i < 300 && !url; i++) { const m = lout.match(/VIEWER_URL=(\S+)/); if (m) url = m[1]; else await sleep(200); }
  const root = url.replace(/VIEWER\/index\.html$/, "");
  const model = parseDicomDirBytes(new Uint8Array(await (await fetch(`${root}DICOMDIR`)).arrayBuffer()), {
    image: (rel: string) => ({ url: root + rel.split("/").map(encodeURIComponent).join("/") }),
    video: () => ({}),
  });

  const exportedRes = await fetch(`${root}VIEWER/layouts.json`);
  check(exportedRes.ok, "Export した媒体に VIEWER/layouts.json がある", exportedRes.status);
  const exported = (exportedRes.ok ? await exportedRes.json() : {}) as Record<string, Dto>;
  let compared = 0;
  for (const p of model.patients) for (const s of p.studies) for (const se of s.series) {
    if (!se.images.length || ["SEG", "RTSTRUCT"].includes(se.modality)) continue;
    const label = `${se.modality} シリーズ${se.number ?? "?"}（${se.images.length} 枚）`;
    const res = await fetch(`${base}/api/studies/${s.studyUid}/series/${se.seriesUid}/layout`);
    if (!res.ok) { check(false, `${label}: backend のレイアウトを取得できる`, res.status); continue; }
    const theirs = (await res.json()) as Dto;
    const fromHeaders = buildLayoutDto(await readHeaders(se.images.filter((im: { url?: string }) => im.url).map((im: { sopUid: string; url?: string; instanceNumber: number }) => ({ sopUid: im.sopUid, url: im.url!, instanceNumber: im.instanceNumber })))) as unknown as Dto;
    compared++;
    const order = (d: Dto) => [...d.cells].sort((a, b) => a.c - b.c || a.t - b.t || a.z - b.z).map((x) => `${x.sopInstanceUid}#${x.frame ?? -1}`).join(",");
    const same = (a: Dto, b: Dto) =>
      a.nZ === b.nZ && a.nC === b.nC && a.nT === b.nT && order(a) === order(b) &&
      Math.abs(a.pixelSpacingRow - b.pixelSpacingRow) < 1e-9 && Math.abs(a.pixelSpacingCol - b.pixelSpacingCol) < 1e-9 &&
      a.imageWidth === b.imageWidth && a.imageHeight === b.imageHeight &&
      (a.axes?.stackAxis ?? "z") === (b.axes?.stackAxis ?? "z") &&
      (!a.zSpatial || !b.zSpatial || a.zSpatial.every((z, i) => z.imagePositionPatient.every((v, k) => Math.abs(v - b.zSpatial![i].imagePositionPatient[k]) < 1e-6)));
    const dims = (d: Dto) => `${d.nZ}×${d.nC}×${d.nT}`;
    check(!!exported[se.seriesUid] && same(theirs, exported[se.seriesUid]), `${label}: Export の layouts.json が本体のレイアウトと一致（並び・次元・間隔・位置・軸）`, exported[se.seriesUid] ? { theirs: dims(theirs), exported: dims(exported[se.seriesUid]) } : "載っていない");
    if (same(theirs, fromHeaders)) {
      check(true, `${label}: （代替）ヘッダから組んだレイアウトも一致`);
    } else {
      known++;
      console.log(`  未達  ${label}: （代替）ヘッダから組んだレイアウトは本体と違う（本体 ${dims(theirs)} / 代替 ${dims(fromHeaders)}）。layouts.json が無い媒体でだけ起きる`);
    }
  }
  check(compared >= 4, `比較したシリーズ数 ${compared}（4 以上）`);
} finally {
  be.kill();
  if (launcher.pid) spawn("taskkill", ["/PID", String(launcher.pid), "/T", "/F"], { stdio: "ignore" });
}
console.log(`${fail ? `失敗 ${fail}` : "失敗なし"}／未達（代替経路の既知の差） ${known}`);
process.exit(fail ? 1 : 0);
