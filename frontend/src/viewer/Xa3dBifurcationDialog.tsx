/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 3D QCA 分岐部（A6b）のダイアログ（`fw/angio-design.md` §21.4）。
 *
 * <h3>なぜ単一血管のダイアログに載せないのか</h3>
 * 単一血管（`Xa3dQcaDialog`）は **1 本ぶんの段**（2 方向 → アンカー → 再構成 → 断面 → 保存）で
 * 組み立ててある。分岐部はそれが **3 本ぶん**必要で、同じ画面に載せると
 * **どの段がどの枝の話なのか分からなくなる**（§21.2 が警告している「タスクが増えたら破綻する」形）。
 *
 * <h3>ここでの割り切り（画面に明記する）</h3>
 * - **枝ごとの手動アンカーは取らない**（端点だけを対応点にする）。3 本 ×（2 方向＋アンカー）は
 *   1 画面に載らない。角度補正が掛からなかった枝は**その旨を出す**（§10.2.3 の警告と同じ扱い）。
 *   厳密にやりたい枝は、単一血管のダイアログで個別に解析する。
 * - **カリーナ周辺は測らない**。除外した半径と長さを画面に必ず出す
 *   ——「病変が無い」のか「測っていない」のかが区別できなくなるため。
 * - **Medina 分類は出さない**。3 本の %DS を出して分類は人に委ねる（境界で跳ぶため）。
 */
import { useEffect, useMemo, useState } from "react";

import { useI18n } from "../i18n/i18n";
import { publishXaBifurcationSnapshot } from "./debugApi";
import { analyzeBifurcation, type BifurcationResult, type BranchId } from "./xaBifurcation";
import { type Vec3 } from "./xaGeometry";
import {
  fuseDiameterProfile,
  reconstructWithRefinement,
  type CrossSectionProfile,
  type XaCenterline2D,
} from "./xaRecon3d";
import { useQcaRuns } from "./xaRecon3dStore";

/** 分岐部で使う 3 本の役割。表示順もこれ。 */
const ROLES: BranchId[] = ["proximal", "distal", "side"];

const MIN_SEPARATION_DEG = 25;

interface BranchPick {
  a: string;
  b: string;
}

export function Xa3dBifurcationDialog({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const runs = useQcaRuns();
  const [picks, setPicks] = useState<Record<BranchId, BranchPick>>({
    proximal: { a: "", b: "" },
    distal: { a: "", b: "" },
    side: { a: "", b: "" },
  });
  const [result, setResult] = useState<BifurcationResult | null>(null);
  /** 角度補正が掛からなかった枝（出自として必ず出す）。 */
  const [unrefined, setUnrefined] = useState<BranchId[]>([]);
  const [error, setError] = useState<string | null>(null);

  const ready = useMemo(
    () => ROLES.every((r) => picks[r].a && picks[r].b && picks[r].a !== picks[r].b),
    [picks],
  );

  const setPick = (role: BranchId, side: "a" | "b", key: string) => {
    setPicks((p) => ({ ...p, [role]: { ...p[role], [side]: key } }));
    setResult(null);
    setUnrefined([]);
    setError(null);
  };

  const run = () => {
    const branches: { id: BranchId; points: Vec3[]; profile: CrossSectionProfile }[] = [];
    const notRefined: BranchId[] = [];
    for (const role of ROLES) {
      // 🚨 同じフレームから 3 区間を取るので、**imageId ではなく runKey** で引く。
      const runA = runs.find((r) => r.runKey === picks[role].a);
      const runB = runs.find((r) => r.runKey === picks[role].b);
      if (!runA || !runB) {
        setError(t("xa3dbif.needRuns"));
        return;
      }
      const a: XaCenterline2D = { geometry: runA.geometry, points: runA.centerline };
      const b: XaCenterline2D = { geometry: runB.geometry, points: runB.centerline };
      const { result: r, refinement } = reconstructWithRefinement(a, b, {
        // 端点だけを対応点にする（手動アンカーは取らない。上の割り切り）。
        anchors: [
          { pixelA: runA.centerline[0], pixelB: runB.centerline[0] },
          {
            pixelA: runA.centerline[runA.centerline.length - 1],
            pixelB: runB.centerline[runB.centerline.length - 1],
          },
        ],
        minSeparationDeg: MIN_SEPARATION_DEG,
      });
      if (!r) {
        setError(t("xa3dbif.failedBranch", { branch: t(`xa3dbif.role.${role}`) }));
        return;
      }
      if (!refinement) notRefined.push(role);
      const sections = fuseDiameterProfile(
        r.points,
        {
          geometry: runA.geometry,
          profile: {
            diameters: runA.diameters,
            pathIndices: runA.diameterPathIndices,
            pointCount: runA.centerline.length,
            unit: runA.unit,
          },
        },
        {
          geometry: refinement?.geometryB ?? runB.geometry,
          profile: {
            diameters: runB.diameters,
            pathIndices: runB.diameterPathIndices,
            pointCount: runB.centerline.length,
            unit: runB.unit,
          },
        },
        r.match,
      );
      branches.push({ id: role, points: r.points, profile: sections });
    }
    const analysis = analyzeBifurcation(branches);
    if (!analysis) {
      setError(t("xa3dbif.failed"));
      return;
    }
    setError(null);
    setUnrefined(notRefined);
    setResult(analysis);
  };

  // 実機検証（automator）が数値で突き合わせられるように公開する（DEV 以外では何もしない）。
  useEffect(() => {
    publishXaBifurcationSnapshot(
      result
        ? {
            carina: [...result.carina] as [number, number, number],
            endpointSpreadMm: result.endpointSpreadMm,
            confluenceRadiusMm: result.confluenceRadiusMm,
            branches: result.branches.map((b) => ({ ...b })),
            angles: { ...result.angles },
            consistency: {
              finet: result.consistency.finet ? { ...result.consistency.finet } : null,
              murray: result.consistency.murray ? { ...result.consistency.murray } : null,
            },
            warnings: result.warnings.map((w) => ({ ...w })),
            unrefinedBranches: [...unrefined],
          }
        : null,
    );
  });

  const fmt = (v: number | null, digits = 2): string => (v == null ? "—" : v.toFixed(digits));

  return (
    <div style={backdrop} onMouseDown={onClose}>
      <div style={panel} onMouseDown={(e) => e.stopPropagation()} data-testid="xa3dbif-dialog">
        <div style={title}>{t("xa3dbif.title")}</div>
        <div style={hint}>{t("xa3dbif.scope")}</div>

        {runs.length < 2 ? (
          <div style={hint} data-testid="xa3dbif-need-runs">
            {t("xa3dbif.needRuns")}
          </div>
        ) : (
          <table style={table}>
            <tbody>
              {ROLES.map((role) => (
                <tr key={role}>
                  <td style={th}>{t(`xa3dbif.role.${role}`)}</td>
                  {(["a", "b"] as const).map((side) => (
                    <td key={side} style={{ padding: "2px 8px 2px 0" }}>
                      <select
                        style={select}
                        data-testid={`xa3dbif-${role}-${side}`}
                        value={picks[role][side]}
                        onChange={(e) => setPick(role, side, e.target.value)}
                      >
                        <option value="">{t("xa3dbif.pickView")}</option>
                        {runs.map((r) => (
                          <option key={r.runKey} value={r.runKey}>
                            {r.label}
                          </option>
                        ))}
                      </select>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div style={row}>
          <button style={primaryBtn} data-testid="xa3dbif-run" disabled={!ready} onClick={run}>
            {t("xa3dbif.run")}
          </button>
          <span style={hint}>{t("xa3dbif.noAnchors")}</span>
        </div>

        {error && (
          <div style={errorText} data-testid="xa3dbif-error">
            {error}
          </div>
        )}

        {result && (
          <div style={{ marginTop: 8 }} data-testid="xa3dbif-result">
            {/* 🚨 「どこを測っていないか」を数値で先に出す。 */}
            <div style={hint} data-testid="xa3dbif-confluence">
              {t("xa3dbif.confluence", { mm: result.confluenceRadiusMm.toFixed(2) })}
            </div>
            <table style={table}>
              <thead>
                <tr>
                  <td style={th}>{t("xa3dbif.branch")}</td>
                  <td style={th}>RVD</td>
                  <td style={th}>MLD</td>
                  <td style={th}>%DS</td>
                  <td style={th}>{t("xa3dbif.lesionLength")}</td>
                  <td style={th}>{t("xa3dbif.excluded")}</td>
                </tr>
              </thead>
              <tbody>
                {result.branches.map((b) => (
                  <tr key={b.id} data-testid={`xa3dbif-branch-${b.id}`}>
                    <td style={th}>{t(`xa3dbif.role.${b.id}`)}</td>
                    <td style={td}>{fmt(b.rvdMm)}</td>
                    <td style={td}>{fmt(b.mldMm)}</td>
                    <td style={td} data-testid={`xa3dbif-ds-${b.id}`}>
                      {fmt(b.percentDiameterStenosis, 1)}
                    </td>
                    <td style={td}>{fmt(b.lesionLengthMm, 1)}</td>
                    <td style={td} data-testid={`xa3dbif-excluded-${b.id}`}>
                      {fmt(b.excludedLengthMm, 1)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {/* 角度。**どの 2 本の角なのか**を必ず名前で出す（「分岐角」だけでは通じない）。 */}
            <div style={row}>
              <span style={metric} data-testid="xa3dbif-angle-distal-side">
                {t("xa3dbif.angle.distalSide")} <b>{fmt(result.angles.distalToSideDeg, 1)}°</b>
              </span>
              <span style={metric} data-testid="xa3dbif-angle-proximal-side">
                {t("xa3dbif.angle.proximalSide")} <b>{fmt(result.angles.proximalToSideDeg, 1)}°</b>
              </span>
              <span style={metric}>
                {t("xa3dbif.angle.proximalDistal")} <b>{fmt(result.angles.proximalToDistalDeg, 1)}°</b>
              </span>
            </div>

            {/* Finet / Murray は**差だけ**。径の推定には使っていないことを画面にも書く。 */}
            <div style={row}>
              <span style={metric} data-testid="xa3dbif-finet">
                Finet {fmt(result.consistency.finet?.expectedMm ?? null)} mm（
                {fmt(result.consistency.finet?.deviationPercent ?? null, 1)}%）
              </span>
              <span style={metric} data-testid="xa3dbif-murray">
                Murray {fmt(result.consistency.murray?.expectedMm ?? null)} mm（
                {fmt(result.consistency.murray?.deviationPercent ?? null, 1)}%）
              </span>
            </div>
            <div style={hint}>{t("xa3dbif.consistencyNote")}</div>

            {result.warnings.map((w) => (
              <div key={`${w.code}:${w.branch}`} style={warn} data-testid={`xa3dbif-warn-${w.code}`}>
                {t(`xa3dbif.warn.${w.code}`, {
                  branch: w.branch ? t(`xa3dbif.role.${w.branch}`) : "",
                  value: w.value.toFixed(2),
                  threshold: w.threshold.toFixed(2),
                })}
              </div>
            ))}
            {unrefined.length > 0 && (
              <div style={warn} data-testid="xa3dbif-unrefined">
                {t("xa3dbif.unrefined", {
                  branches: unrefined.map((b) => t(`xa3dbif.role.${b}`)).join(" / "),
                })}
              </div>
            )}
            {/* 🚨 出さないものを明示する。 */}
            <div style={hint} data-testid="xa3dbif-no-medina">
              {t("xa3dbif.noMedina")}
            </div>
          </div>
        )}

        <div style={{ ...row, justifyContent: "flex-end" }}>
          <button style={btn} data-testid="xa3dbif-close" onClick={onClose}>
            {t("common.close")}
          </button>
        </div>
      </div>
    </div>
  );
}

const backdrop: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.45)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 40,
};
const panel: React.CSSProperties = {
  background: "#f7f9fb",
  color: "#20303f",
  borderRadius: 6,
  padding: 14,
  minWidth: 640,
  maxWidth: "90vw",
  maxHeight: "88vh",
  overflow: "auto",
  boxShadow: "0 8px 32px rgba(0,0,0,0.35)",
};
const title: React.CSSProperties = { fontSize: 14, fontWeight: 600, marginBottom: 6 };
const row: React.CSSProperties = { display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", marginTop: 8 };
const hint: React.CSSProperties = { fontSize: 11, color: "#44586a", marginTop: 4, lineHeight: 1.5 };
const warn: React.CSSProperties = { fontSize: 11, color: "#8a4b00", marginTop: 4 };
const errorText: React.CSSProperties = { fontSize: 12, color: "#a11", marginTop: 6 };
const metric: React.CSSProperties = { fontSize: 12, fontVariantNumeric: "tabular-nums" };
const table: React.CSSProperties = { fontSize: 12, borderCollapse: "collapse", marginTop: 8 };
const th: React.CSSProperties = { textAlign: "left", padding: "2px 10px 2px 0", color: "#66788a" };
const td: React.CSSProperties = { textAlign: "right", padding: "2px 16px 2px 0", fontVariantNumeric: "tabular-nums" };
const select: React.CSSProperties = { fontSize: 12, padding: "2px 4px", minWidth: 170 };
const btn: React.CSSProperties = {
  fontSize: 12,
  padding: "4px 10px",
  borderRadius: 4,
  border: "1px solid #b9c6d2",
  background: "#fff",
  cursor: "pointer",
};
const primaryBtn: React.CSSProperties = { ...btn, background: "#2c6fb5", color: "#fff", borderColor: "#2c6fb5" };
