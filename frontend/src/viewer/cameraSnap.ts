/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 3D Viewer の向きスナップ（全モード共通・純関数）。患者 LPS（+X=L, +Y=P, +Z=S）。
 * 放射線科の慣例に合わせる:
 * - Axial: 足側から見上げる（視線 +S、上 = A、画面右 = 患者 L）。
 * - Coronal: 前から見る（視線 +P、上 = S、画面右 = 患者 L）。
 * - Sagittal: 患者の左から見る（視線 −X、上 = S、画面右 = P＝前が左）。
 * 「反対側から」は視線を反転（上は同じ）。画面右 = 視線 × 上。
 */
import type { Vec3 } from "./slabGeometry";

export type SnapKind = "AX" | "COR" | "SAG";

export function snapCamera(kind: SnapKind, flip = false): { dop: Vec3; viewUp: Vec3 } {
  const base: Record<SnapKind, { dop: Vec3; viewUp: Vec3 }> = {
    AX: { dop: [0, 0, 1], viewUp: [0, -1, 0] },
    COR: { dop: [0, 1, 0], viewUp: [0, 0, 1] },
    SAG: { dop: [-1, 0, 0], viewUp: [0, 0, 1] },
  };
  const { dop, viewUp } = base[kind];
  const neg = (v: number) => (v === 0 ? 0 : -v);
  return { dop: flip ? [neg(dop[0]), neg(dop[1]), neg(dop[2])] : dop, viewUp };
}
