/*
 * テクスチャのマップのジョブ（既定のダイアログと同じ要求）が、どの段階で時間を使うかを、jar ごとに記録する（回帰の切り分け）。
 *
 * 実行:  cd automator && JAR=<backend jar> LABEL=<名前> [STRIDE=4 KERNEL=3] [LIMIT_S=900] \
 *          GRAPHY_AUTOMATOR_HTTP_PORT=21090 GRAPHY_AUTOMATOR_SCP_PORT=21091 npx tsx src/spike/textureJobProgressCheck.ts
 *   実 PET（PSMA）と SEG を取り込み、margin 無し（backend の既定の余白）・カーネル・ストライドを指定してジョブを投げ、
 *   10 秒ごとに状態・終えたスライス数・経過時間を出す。backend のログ（[texture] の行）は .results/texture-job-progress/backend-<LABEL>.log。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import { importPaths } from "../fixtures/importFixtures.js";
import { waitForBackendReady } from "../backend/healthcheck.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "texture-job-progress");
const PSMA = path.join(os.homedir(), "graphy-demo-samples", "PSMA_0198cdca94fbb95f", "PET", "CT whole-body PSMA");
const HTTP = Number(process.env.GRAPHY_AUTOMATOR_HTTP_PORT ?? 21090);
const SCP = Number(process.env.GRAPHY_AUTOMATOR_SCP_PORT ?? 21091);
const JAR = process.env.JAR!;
const LABEL = process.env.LABEL ?? "run";
const KERNEL = Number(process.env.KERNEL ?? 7);
const STRIDE = Number(process.env.STRIDE ?? 1);
const LIMIT_S = Number(process.env.LIMIT_S ?? 900);
const ADD_OPENS = ["--add-opens", "java.base/java.io=ALL-UNNAMED", "--add-opens", "java.desktop/javax.imageio.stream=ALL-UNNAMED"];

async function call<T>(p: string, method: string, body?: unknown): Promise<T> {
  const res = await fetch(`http://127.0.0.1:${HTTP}${p}`, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!res.ok) throw new Error(`${method} ${p} → HTTP ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const dataDir = path.join(OUT_DIR, `data-${LABEL}`);
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.mkdirSync(dataDir, { recursive: true });
  const log = fs.openSync(path.join(OUT_DIR, `backend-${LABEL}.log`), "w");
  const proc = spawn("java", [...ADD_OPENS, "-jar", JAR, "--spring.profiles.active=standalone", `--server.port=${HTTP}`, `--graphy.dicom.scp.port=${SCP}`],
    { cwd: dataDir, stdio: ["ignore", log, log], env: { ...process.env, GRAPHY_AUTOMATOR: "1" } });
  try {
    await waitForBackendReady(HTTP, 120_000);
    await importPaths(HTTP, [PSMA]);
    const studies = await call<{ studyInstanceUid: string }[]>("/api/studies", "GET");
    const studyUid = studies[0].studyInstanceUid;
    const series = await call<{ seriesInstanceUid: string; modality: string }[]>(`/api/studies/${studyUid}/series`, "GET");
    const pet = series.find((s) => s.modality === "PT")!;
    const seg = series.find((s) => s.modality === "SEG")!;
    const req = { studyInstanceUid: studyUid, sourceSeriesUid: pet.seriesInstanceUid, maskSeriesUid: seg.seriesInstanceUid, maskChannel: 0,
      feature: "FIRSTORDER_Mean", filterSize: KERNEL, stride: STRIDE, force2D: false, channel: 0, timePoint: 0, settings: { MASK_LABEL_INT: "1" },
      margin: null, seriesDescription: `progress ${LABEL}`, seriesNumber: null };
    console.log(`[${LABEL}] jar=${JAR} kernel=${KERNEL} stride=${STRIDE} margin=null 上限 ${LIMIT_S}s`);
    const t0 = Date.now();
    const job = await call<{ jobId: string }>("/api/series/texture/jobs", "POST", req);
    let last = "";
    while ((Date.now() - t0) / 1000 < LIMIT_S) {
      const st = await call<{ state: string; slicesDone: number; slicesTotal: number; elapsedMs: number; error?: string }>(`/api/series/texture/jobs/${job.jobId}`, "GET");
      const line = `${st.state} ${st.slicesDone}/${st.slicesTotal}`;
      console.log(`  t=${Math.round((Date.now() - t0) / 1000)}s  ${line}  (job 経過 ${Math.round(st.elapsedMs / 1000)}s)${st.error ? " " + st.error : ""}`);
      last = line;
      if (st.state === "DONE" || st.state === "FAILED" || st.state === "CANCELLED") break;
      await new Promise((r) => setTimeout(r, 10_000));
    }
    console.log(`[${LABEL}] 終了時点: ${last}  合計 ${Math.round((Date.now() - t0) / 1000)}s`);
    await call(`/api/series/texture/jobs/${job.jobId}`, "DELETE").catch(() => undefined);
  } finally {
    proc.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 5000));
    if (proc.exitCode == null) proc.kill("SIGKILL");
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
