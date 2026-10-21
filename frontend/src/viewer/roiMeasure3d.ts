/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 3D の 2 点定規のモデル（患者 LPS mm）。`fw/roi-global-manager.md`。
 *
 * <p>距離は保存しない——端点 a,b から導く（編集して食い違う値を作らない）。
 * 形の計算・保存の混ぜ方は純関数で、窓にも保存にも依存しない。
 */
export type Vec3 = [number, number, number];

export interface Measure3d {
  id: string;
  a: Vec3;
  b: Vec3;
  label?: string;
  color?: string;
  visible?: boolean;
  locked?: boolean;
  studyUid?: string;
  seriesUid?: string;
  /** 最後の編集時刻（ISO）。保存の競合で新しい方を採る。 */
  updatedAt?: string;
  patientKey?: string;
}

const isVec3 = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === "number" && Number.isFinite(x));

export function measureDistanceMm(m: Pick<Measure3d, "a" | "b">): number {
  return Math.hypot(m.b[0] - m.a[0], m.b[1] - m.a[1], m.b[2] - m.a[2]);
}

/** 保存されていた定規を読む。端点が欠ける・非有限なら null（その 1 件だけ落とす）。 */
export function sanitizeMeasure3d(v: unknown): Measure3d | null {
  const s = v as Partial<Measure3d> | null;
  if (!s || typeof s.id !== "string" || !s.id) return null;
  if (!isVec3(s.a) || !isVec3(s.b)) return null;
  const out: Measure3d = { id: s.id, a: [...s.a], b: [...s.b] };
  if (typeof s.label === "string") out.label = s.label;
  if (typeof s.color === "string") out.color = s.color;
  if (typeof s.visible === "boolean") out.visible = s.visible;
  if (typeof s.locked === "boolean") out.locked = s.locked;
  if (typeof s.studyUid === "string") out.studyUid = s.studyUid;
  if (typeof s.seriesUid === "string") out.seriesUid = s.seriesUid;
  if (typeof s.updatedAt === "string") out.updatedAt = s.updatedAt;
  if (typeof s.patientKey === "string") out.patientKey = s.patientKey;
  return out;
}

/** 保存の競合で混ぜる（`mergeSolids` と同じ規則）: 新しい `updatedAt`、同時刻はローカル、墓標の id は除く、id 順。 */
export function mergeMeasures(remote: Measure3d[], local: Measure3d[], buried: Set<string>): Measure3d[] {
  const byId = new Map<string, Measure3d>();
  for (const r of remote) byId.set(r.id, r);
  for (const l of local) {
    const r = byId.get(l.id);
    byId.set(l.id, r && (r.updatedAt ?? "") > (l.updatedAt ?? "") ? r : l);
  }
  for (const id of buried) byId.delete(id);
  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
