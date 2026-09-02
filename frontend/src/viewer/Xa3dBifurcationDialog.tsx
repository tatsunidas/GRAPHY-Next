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
import {
  analyzeBifurcation,
  suggestBifurcationWorkingAngles,
  type BifurcationResult,
  type BifurcationWorkingAngle,
  type BranchId,
} from "./xaBifurcation";
import { formatViewAngles, type Vec3, type XaViewGeometry } from "./xaGeometry";
import {
  fuseDiameterProfile,
  reconstructWithRefinement,
  type CrossSectionProfile,
  type XaCenterline2D,
} from "./xaRecon3d";
import { useQcaRuns, type XaQcaRun } from "./xaRecon3dStore";

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
  /** 再構成した 3D 中心線。表示には使わず、実機検証の切り分けだけに出す（`debugApi`）。 */
  const [branchPoints, setBranchPoints] = useState<{ id: BranchId; points: Vec3[] }[]>([]);
  /** 分岐部が重ならずに見える撮影角度の候補（§21.4.4）。 */
  const [workingAngles, setWorkingAngles] = useState<BifurcationWorkingAngle[]>([]);
  const [error, setError] = useState<string | null>(null);

  const ready = useMemo(
    () => ROLES.every((r) => picks[r].a && picks[r].b && picks[r].a !== picks[r].b),
    [picks],
  );

  const setPick = (role: BranchId, side: "a" | "b", key: string) => {
    setPicks((p) => ({ ...p, [role]: { ...p[role], [side]: key } }));
    setResult(null);
    setUnrefined([]);
    setBranchPoints([]);
    setWorkingAngles([]);
    setError(null);
  };

  const run = () => {
    const branches: { id: BranchId; points: Vec3[]; profile: CrossSectionProfile }[] = [];
    const notRefined: BranchId[] = [];
    // 候補角度の走査に使う土台（SID/SOD 等）。**判定に効くのは角度だけ**なので、
    // どの枝の方向 A でも構わない（`suggestBifurcationWorkingAngles` の注記）。
    let baseGeometry: XaViewGeometry | null = null;
    for (const role of ROLES) {
      // 🚨 同じフレームから 3 区間を取るので、**imageId ではなく runKey** で引く。
      const runA = runs.find((r) => r.runKey === picks[role].a);
      const runB = runs.find((r) => r.runKey === picks[role].b);
      if (!runA || !runB) {
        setError(t("xa3dbif.needRuns"));
        return;
      }
      if (!baseGeometry) baseGeometry = runA.geometry;
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
    setBranchPoints(branches.map((b) => ({ id: b.id, points: b.points })));
    setWorkingAngles(
      baseGeometry
        ? suggestBifurcationWorkingAngles(
            branches,
            analysis.carina,
            analysis.confluenceRadiusMm,
            baseGeometry,
          )
        : [],
    );
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
            workingAngles: workingAngles.map((c) => ({
              primaryAngleDeg: c.primaryAngleDeg,
              secondaryAngleDeg: c.secondaryAngleDeg,
              minVisibleFraction: c.minVisibleFraction,
              overlapLengthMm: c.overlapLengthMm,
              overlapPair: [...c.overlapPair],
              edgeAware: c.edgeAware,
              score: c.score,
            })),
            unrefinedBranches: [...unrefined],
            branchPoints: branchPoints.map((b) => ({
              id: b.id,
              points: b.points.map((p) => [p[0], p[1], p[2]] as [number, number, number]),
            })),
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

        {runs.length >= 2 && <BranchPreview runs={runs} picks={picks} />}

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
            {/* ワーキングアングル（§21.4.4）。**短縮だけでなく重なりも見て選ぶ**。 */}
            <div style={row}>
              <span style={metric}>{t("xa3dbif.workingAngles")}</span>
            </div>
            {workingAngles.length === 0 ? (
              <div style={hint} data-testid="xa3dbif-working-angles-none">
                {t("xa3dbif.workingAngles.none")}
              </div>
            ) : (
              <>
                <div style={hint} data-testid="xa3dbif-working-angles">
                  {workingAngles
                    .map((c) =>
                      t("xa3dbif.workingAngles.item", {
                        view: formatViewAngles(c.primaryAngleDeg, c.secondaryAngleDeg),
                        visible: `${(c.minVisibleFraction * 100).toFixed(0)}%`,
                        overlap: c.overlapLengthMm.toFixed(1),
                        pair: c.overlapPair.map((b) => t(`xa3dbif.role.${b}`)).join("↔"),
                      }),
                    )
                    .join(" ／ ")}
                </div>
                {!workingAngles[0].edgeAware && (
                  <div style={warn} data-testid="xa3dbif-working-angles-centerline">
                    {t("xa3dbif.workingAngles.centerline")}
                  </div>
                )}
              </>
            )}
            <div style={hint}>{t("xa3dbif.workingAngles.caveat")}</div>

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
  borderWidth: "1px",
  borderStyle: "solid",
  borderColor: "#b9c6d2",
  background: "#fff",
  cursor: "pointer",
};
const primaryBtn: React.CSSProperties = { ...btn, background: "#2c6fb5", color: "#fff", borderColor: "#2c6fb5" };

/** 枝ごとの色。表・プレビューで**同じ色**を使う（別の色にすると対応を覚え直させることになる）。 */
const BRANCH_COLORS: Record<string, string> = {
  proximal: "#6d9be0",
  distal: "#3f8f6f",
  side: "#e07a5f",
};

/**
 * どのランをどの枝に割り当てたかを、**中心線の絵**で示す。
 *
 * <h3>なぜ要るのか（実機で言われた・2026-09-02）</h3>
 * 一覧の文字列は `#2 · LAO 60° / CRA 20° · f1 · 118px` のような形で、**同じ方向に 3 本引くと
 * 角度もフレームも同じ**、px も近い行が並ぶ。番号を付けても「#2 が画面のどの線か」は
 * 覚えていないと分からない。**登録済みの中心線をそのまま描いて、割り当てた枝の色で塗る**のが
 * いちばん短い説明になる。
 *
 * <p>🔴 画素は持たない（登録簿は中心線と幾何だけを保持する設計）。**線だけを描く。**
 */
function BranchPreview({
  runs,
  picks,
}: {
  runs: readonly XaQcaRun[];
  picks: Record<string, { a: string; b: string }>;
}) {
  const { t } = useI18n();
  const W = 240;
  const H = 170;
  /** ランごとに「どの枝の、どちら側か」を引けるようにする。 */
  const assigned = new Map<string, { role: string; side: "a" | "b" }>();
  for (const role of Object.keys(picks)) {
    for (const side of ["a", "b"] as const) {
      const key = picks[role][side];
      if (key) assigned.set(key, { role, side });
    }
  }
  // 方向ごとにまとめる（同じ幾何のランは同じ絵の中に描く）。
  const byView = new Map<string, XaQcaRun[]>();
  for (const r of runs) {
    const k = `${r.geometry.primaryAngleDeg}/${r.geometry.secondaryAngleDeg}/${r.frameIndex}`;
    const list = byView.get(k) ?? [];
    list.push(r);
    byView.set(k, list);
  }

  return (
    <div style={{ display: "flex", gap: 10, flexWrap: "wrap", margin: "8px 0" }}>
      {[...byView.entries()].map(([k, list]) => {
        // すべての中心線が入る矩形へ収める。
        let x0 = Infinity;
        let y0 = Infinity;
        let x1 = -Infinity;
        let y1 = -Infinity;
        for (const r of list) {
          for (const [x, y] of r.centerline) {
            if (x < x0) x0 = x;
            if (x > x1) x1 = x;
            if (y < y0) y0 = y;
            if (y > y1) y1 = y;
          }
        }
        const sx = x1 > x0 ? (W - 24) / (x1 - x0) : 1;
        const sy = y1 > y0 ? (H - 34) / (y1 - y0) : 1;
        const sc = Math.min(sx, sy);
        const px = (x: number) => 12 + (x - x0) * sc;
        const py = (y: number) => 24 + (y - y0) * sc;
        return (
          <svg
            key={k}
            width={W}
            height={H}
            data-testid="xa3dbif-preview"
            style={{ background: "#eef2f6", border: "1px solid #c3ced9", borderRadius: 3 }}
          >
            <text x={8} y={14} fontSize={11} fill="#44586a">
              {list[0]?.label.replace(/^#\d+ · /, "") ?? ""}
            </text>
            {list.map((r) => {
              const a = assigned.get(r.runKey);
              const color = a ? BRANCH_COLORS[a.role] ?? "#8a95a1" : "#b7c2cd";
              const num = /^#(\d+)/.exec(r.label)?.[1] ?? "";
              const head = r.centerline[0];
              return (
                <g key={r.runKey} data-testid={`xa3dbif-preview-run-${r.runKey}`}>
                  <polyline
                    points={r.centerline.map((pt: readonly number[]) => `${px(pt[0])},${py(pt[1])}`).join(" ")}
                    fill="none"
                    stroke={color}
                    strokeWidth={a ? 3 : 1.5}
                  />
                  {head && (
                    <text x={px(head[0]) + 3} y={py(head[1]) - 3} fontSize={11} fontWeight={a ? 700 : 400} fill={color}>
                      #{num}
                      {a ? ` ${t(`xa3dbif.role.${a.role}`)}` : ""}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>
        );
      })}
    </div>
  );
}
