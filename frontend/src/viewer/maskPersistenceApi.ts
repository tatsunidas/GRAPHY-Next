/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 塗り ROI の保存 API のクライアント（`/api/roi-masks`）。スキーマは {@link ./maskPersistence} が正本。
 *
 * <p>🔴 `patientKey` はクエリで渡す（PatientID に `/` が入る患者がいる。`roiPersistenceApi.ts` と同じ理由）。
 * 画素は JSON ではなく multipart のバイナリで送る（base64 の 33% 膨張と、JSON 文字列の長さ上限を避ける）。
 */
import { apiBase } from "../apiBase";
import { extractErrorMessage, HttpError, httpGet, httpSend, KEEPALIVE_MAX_BYTES } from "../http";
import type { SavedMaskSummary } from "./maskPersistence";

const q = (patientKey: string): string => `patientKey=${encodeURIComponent(patientKey)}`;

export const listMasks = (patientKey: string): Promise<SavedMaskSummary[]> =>
  httpGet<SavedMaskSummary[]>(`/api/roi-masks?${q(patientKey)}`);

/** 圧縮済みの画素。無ければ HttpError(404)。 */
export async function fetchMaskFrames(maskUid: string): Promise<Uint8Array> {
  const res = await fetch(`${apiBase()}/api/roi-masks/${encodeURIComponent(maskUid)}/frames`);
  if (!res.ok) throw new HttpError(await extractErrorMessage(res), res.status);
  return new Uint8Array(await res.arrayBuffer());
}

export interface SaveMaskArgs {
  patientKey: string;
  seriesUid: string;
  frameCount: number;
  /** 新規は null。読んだ／前回保存した版。 */
  version: number | null;
  meta: string;
  frames: Uint8Array;
}

/** 保存。409（版の食い違い）・413（大きすぎる）は HttpError の status で見分ける。 */
export async function saveMask(maskUid: string, a: SaveMaskArgs): Promise<SavedMaskSummary> {
  const form = new FormData();
  form.append("meta", new Blob([a.meta], { type: "application/json" }));
  form.append("frames", new Blob([a.frames as BlobPart], { type: "application/octet-stream" }), "frames.bin");
  const ver = a.version === null ? "" : `&version=${a.version}`;
  const url = `${apiBase()}/api/roi-masks/${encodeURIComponent(maskUid)}?${q(a.patientKey)}&seriesUid=${encodeURIComponent(a.seriesUid)}&frameCount=${a.frameCount}${ver}`;
  // 本体が小さいときは、閉じる・再読み込みの最中でも送り切れるように keepalive にする（大きいと要求ごと失敗する）。
  const keepalive = a.frames.length + a.meta.length <= KEEPALIVE_MAX_BYTES;
  const res = await fetch(url, { method: "PUT", body: form, keepalive });
  if (!res.ok) throw new HttpError(await extractErrorMessage(res), res.status);
  return (await res.json()) as SavedMaskSummary;
}

export const deleteMask = (maskUid: string, patientKey: string): Promise<void> =>
  httpSend<void>(`/api/roi-masks/${encodeURIComponent(maskUid)}?${q(patientKey)}`, "DELETE");
