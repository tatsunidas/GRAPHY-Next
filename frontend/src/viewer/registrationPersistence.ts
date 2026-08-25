/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 位置合わせ記録の保存・読み出し（backend の `/api/registrations/{patientKey}`）。
 *
 * <p>形式の正本は {@link ./registrationRecord}（純関数・テスト対象）。ここは
 * <b>通信と、変位場の Base64 往復</b>だけを担う。`Float32Array` は JSON に載らないので、
 * 保存時に符号化し、読み出し時に復元する。
 */

import { apiBase } from "../apiBase";
import type { RegistrationResult } from "./regResult";
import {
  decodeFloat32,
  encodeFloat32,
  REGISTRATION_RECORD_VERSION,
  type RegistrationDocument,
  type RegistrationRecord,
} from "./registrationRecord";

interface DocumentDto {
  patientKey: string;
  json: string | null;
  recordCount: number;
  updatedAt: string | null;
  version: number | null;
}

/** 読み出した文書と、保存時に返送する版。 */
export interface LoadedDocument {
  readonly doc: RegistrationDocument;
  readonly version: number | null;
}

/** 変位場を Base64 で持つ、保存用の形。 */
type StoredResult = Omit<RegistrationResult, "dvf"> & {
  dvf?: {
    displacementsBase64: string;
    dims: [number, number, number];
    origin: [number, number, number];
    spacing: [number, number, number];
    jacobian: { min: number; max: number; negativeFraction: number };
    maxDisplacementMm: number;
  } | null;
};

function toStored(r: RegistrationResult | null): StoredResult | null {
  if (!r) return null;
  const { dvf, ...rest } = r;
  if (!dvf) return { ...rest, dvf: null };
  return {
    ...rest,
    dvf: {
      displacementsBase64: encodeFloat32(dvf.displacements),
      dims: dvf.dims,
      origin: dvf.origin,
      spacing: dvf.spacing,
      jacobian: dvf.jacobian,
      maxDisplacementMm: dvf.maxDisplacementMm,
    },
  };
}

function fromStored(r: StoredResult | null | undefined): RegistrationResult | null {
  if (!r) return null;
  const { dvf, ...rest } = r;
  if (!dvf) return { ...rest, dvf: null };
  return {
    ...rest,
    dvf: {
      displacements: decodeFloat32(dvf.displacementsBase64),
      dims: dvf.dims,
      origin: dvf.origin,
      spacing: dvf.spacing,
      jacobian: dvf.jacobian,
      maxDisplacementMm: dvf.maxDisplacementMm,
    },
  };
}

/** 患者の記録をすべて読む。未保存でも例外にしない（空の文書を返す）。 */
export async function loadRegistrations(patientKey: string): Promise<LoadedDocument> {
  const empty: LoadedDocument = {
    doc: { version: REGISTRATION_RECORD_VERSION, records: [] },
    version: null,
  };
  if (!patientKey) return empty;
  try {
    // 🔴 キーはクエリで渡す（パスの `%2F` は Tomcat が 400 にする。roiPersistenceApi.ts の注記）。
    const res = await fetch(`${apiBase()}/api/registrations?patientKey=${encodeURIComponent(patientKey)}`);
    if (!res.ok) return empty;
    const dto = (await res.json()) as DocumentDto;
    if (!dto.json) return { doc: empty.doc, version: dto.version };
    const raw = JSON.parse(dto.json) as { version: number; records: (RegistrationRecord & { registration?: StoredResult | null })[] };
    return {
      doc: {
        version: raw.version ?? REGISTRATION_RECORD_VERSION,
        records: (raw.records ?? []).map((r) => ({ ...r, registration: fromStored(r.registration) })),
      },
      version: dto.version,
    };
  } catch {
    // 保存が読めないことで位置合わせ自体が使えなくなるのは筋が悪い。空として続行する。
    return empty;
  }
}

/**
 * 患者の記録を保存する。
 *
 * @param version 直前に読んだ版。**読まずに保存しない**（別ウィンドウの記録を消さないため）。
 * @returns 新しい版。競合（409）なら `null`。
 */
export async function saveRegistrations(
  patientKey: string,
  doc: RegistrationDocument,
  version: number | null,
): Promise<number | null> {
  const payload = {
    version: doc.version,
    records: doc.records.map((r) => ({ ...r, registration: toStored(r.registration) })),
  };
  const res = await fetch(`${apiBase()}/api/registrations?patientKey=${encodeURIComponent(patientKey)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      json: JSON.stringify(payload),
      recordCount: doc.records.length,
      version,
    }),
  });
  if (res.status === 409) return null;
  if (!res.ok) throw new Error(`位置合わせの保存に失敗しました (HTTP ${res.status})`);
  const dto = (await res.json()) as DocumentDto;
  return dto.version;
}
