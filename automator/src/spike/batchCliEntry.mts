/*
 * 一括抽出の「Node から動かす CLI」が成り立つかの確認用の入口（段 2b-0 の検証専用。製品ではない）。
 *
 * フロントの TS（batchApi・batchQueue・batchSpec・batchPairs・datasetCsv）を無改変で束ねて Node／Electron 同梱の Node で動かし、
 * 既に動いている backend（--server）へ HTTP で繋いで、1 つの定義 × 1 アルバムを実行して表を書く。
 * `http.ts`（window・log に依存する）だけは束ねるときに Node 用の代役へ差し替える（batchCliFeasibility.ts の plugin）。
 *
 * automator の tsconfig（rootDir: src）の外のファイルを読むので、`.mts` にして `src/**\/*.ts` の型検査の対象から外している。
 *
 * 終了コード: 0＝成功、1＝定義の実行が失敗、2＝QC などで止まった／取り消し、3＝定義を読めない、4＝そのほかの例外（接続不可など）。
 */
import fs from "node:fs";
import path from "node:path";

import { cancelBatch, getBatch, getBatchResults, planBatch, submitBatch } from "../../../frontend/src/radiomics/batchApi";
import { applyLabelFilter, initialRows } from "../../../frontend/src/radiomics/batchPairs";
import { runQueue, type QueueEntry } from "../../../frontend/src/radiomics/batchQueue";
import { parseSpec } from "../../../frontend/src/radiomics/batchSpec";
import { assignSubjectCodes } from "../../../frontend/src/radiomics/datasetCsv";
import { defaultRoiFeatureForm } from "../../../frontend/src/radiomics/roiFeatureSettings";
import { httpGet } from "../../../frontend/src/http";

function arg(name: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  if (!v) throw new Error(`--${name} が要ります`);
  return v;
}

async function main(): Promise<number> {
  console.log(`runtime node=${process.versions.node} electron=${(process.versions as Record<string, string>).electron ?? "-"} subtle=${typeof globalThis.crypto?.subtle}`);
  const server = arg("server");
  const specPath = arg("spec");
  const albumId = Number(arg("album"));
  const outDir = arg("out");
  (globalThis as { __GRAPHY_CLI_BASE__?: string }).__GRAPHY_CLI_BASE__ = server;

  const parsed = await parseSpec(fs.readFileSync(specPath, "utf8"));
  if (!parsed.ok) {
    console.error(`定義を読めません: ${parsed.error} ${parsed.detail}`);
    return 3;
  }
  const spec = parsed.spec;
  console.log(`spec ${path.basename(specPath)} sha256=${spec.sha256} kind=${spec.kind}`);

  const albums = await httpGet<{ id: number; name: string }[]>("/api/albums");
  const album = albums.find((a) => a.id === albumId);
  if (!album) throw new Error(`アルバム ${albumId} がありません`);
  const uids = await httpGet<string[]>(`/api/albums/${albumId}/studies`);
  const pairs = await planBatch({ albumId, studyUids: null });
  const rows = applyLabelFilter(initialRows(pairs), []);
  const studyUids = Array.from(new Set(pairs.map((p) => p.studyUid)));
  const studies = studyUids.length === 0 ? [] : await httpGet<{ studyInstanceUid: string; patientId: string | null }[]>(
    `/api/studies?studyInstanceUid=${encodeURIComponent(studyUids.join(","))}`);
  const patientOf = new Map(studies.map((s) => [s.studyInstanceUid, s.patientId]));
  const subjects = assignSubjectCodes(uids, (u) => patientOf.get(u), studyUids);

  fs.mkdirSync(outDir, { recursive: true });
  const entry: QueueEntry = { id: 1, spec, enabled: true, state: "pending", message: null, files: 0 };
  const final = await runQueue([entry], {
    baseRows: rows, baseForm: defaultRoiFeatureForm(),
    output: { albumName: album.name, subjects, includePatientId: false, subjectsFile: true, bom: false },
    pollMs: 1000, isCancelled: () => false,
  }, {
    submit: submitBatch, get: getBatch, results: getBatchResults, cancel: cancelBatch,
    save: (files) => { for (const f of files) fs.writeFileSync(path.join(outDir, f.name), f.text, "utf8"); },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  }, () => undefined);
  const r = final[0];
  console.log(`state=${r.state} files=${r.files} ${r.message ?? ""}`);
  return r.state === "done" ? 0 : r.state === "failed" ? 1 : 2;
}

main().then((code) => process.exit(code), (e) => {
  console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(4);
});
