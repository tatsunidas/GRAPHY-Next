/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * メッシュ修復・検証ダイアログ（`fw/3d-viewer-design.md` §8.4, §15 #7）。旧 GRAPHY
 * `MeshRepairer`/`MeshValidator` の UI。選択メッシュ（or ROI 表面メッシュ）のトポロジを検証し、
 * 修復（頂点溶接・退化/重複三角形除去・非参照頂点圧縮）した結果を**新規メッシュオブジェクト**として
 * シーンに追加する（既存 `addMeshObject` を再利用＝`scene3d.ts` は編集しない）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n/i18n";
import { getSceneObject } from "./scene3dStore";
import { addMeshObject, getObjectPolyData } from "./scene3d";
import { validateMesh, repairMesh, type MeshValidation } from "../viewer/meshRepair";

export function MeshRepairDialog({
  objectId,
  onClose,
}: {
  objectId: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const obj = getSceneObject(objectId);
  const [report, setReport] = useState<MeshValidation | null>(null);
  const [tol, setTol] = useState<number | null>(null); // null = 自動
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const ran = useRef(false);

  const runValidate = useCallback(() => {
    const pd = getObjectPolyData(objectId);
    if (!pd) {
      setStatus(t("meshRepair.noMesh"));
      setReport(null);
      return;
    }
    setBusy(true);
    setTimeout(() => {
      try {
        setReport(validateMesh(pd, tol ?? undefined));
        setStatus("");
      } catch (e) {
        setStatus(`${t("meshRepair.error")}: ${String(e)}`);
      } finally {
        setBusy(false);
      }
    }, 16);
  }, [objectId, tol, t]);

  // 初回に検証。
  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    runValidate();
  }, [runValidate]);

  const onRepair = useCallback(() => {
    const pd = getObjectPolyData(objectId);
    if (!pd) {
      setStatus(t("meshRepair.noMesh"));
      return;
    }
    setBusy(true);
    setStatus("");
    setTimeout(() => {
      try {
        const res = repairMesh(pd, { weldToleranceMm: tol ?? undefined });
        const id = addMeshObject(res.polydata, { name: `${obj?.name ?? "Mesh"} · repaired` });
        if (!id) {
          setStatus(t("meshRepair.repairFailed"));
          return;
        }
        setReport(res.after);
        setStatus(
          t("meshRepair.repaired", {
            v: String(res.removedVertices),
            tri: String(res.removedTriangles),
          }),
        );
      } catch (e) {
        setStatus(`${t("meshRepair.error")}: ${String(e)}`);
      } finally {
        setBusy(false);
      }
    }, 16);
  }, [objectId, tol, obj?.name, t]);

  const yn = (b: boolean) => (b ? t("meshRepair.yes") : t("meshRepair.no"));

  return (
    <div style={overlay}>
      <div style={dialog}>
        <div style={header}>
          <span style={hTitle}>{t("meshRepair.title")}</span>
          <span style={hSub}>{obj?.name ?? objectId}</span>
          <div style={{ flex: 1 }} />
          <button style={closeBtn} onClick={onClose}>
            ✕
          </button>
        </div>

        <div style={body}>
          {report ? (
            <table style={table}>
              <tbody>
                <Row label={t("meshRepair.points")} value={String(report.numPoints)} />
                <Row label={t("meshRepair.triangles")} value={String(report.numTriangles)} />
                <Row label={t("meshRepair.weldable")} value={String(report.weldableVertices)} warn={report.weldableVertices > 0} />
                <Row label={t("meshRepair.dupVerts")} value={String(report.duplicateVertexGroups)} warn={report.duplicateVertexGroups > 0} />
                <Row label={t("meshRepair.degenerate")} value={String(report.degenerateTriangles)} warn={report.degenerateTriangles > 0} />
                <Row label={t("meshRepair.dupTris")} value={String(report.duplicateTriangles)} warn={report.duplicateTriangles > 0} />
                <Row label={t("meshRepair.boundary")} value={String(report.boundaryEdges)} warn={report.boundaryEdges > 0} />
                <Row label={t("meshRepair.nonManifold")} value={String(report.nonManifoldEdges)} warn={report.nonManifoldEdges > 0} />
                <Row label={t("meshRepair.unref")} value={String(report.unreferencedVertices)} warn={report.unreferencedVertices > 0} />
                <Row label={t("meshRepair.closed")} value={yn(report.isClosed)} warn={!report.isClosed} />
                <Row label={t("meshRepair.manifold")} value={yn(report.isManifold)} warn={!report.isManifold} />
              </tbody>
            </table>
          ) : (
            <div style={emptyBox}>{busy ? t("meshRepair.working") : status || t("meshRepair.noMesh")}</div>
          )}

          <div style={row}>
            <label style={fieldWrap}>
              <span style={fieldLabel}>{t("meshRepair.tolerance")}</span>
              <input
                type="number"
                style={input}
                placeholder="auto"
                step={0.01}
                min={0}
                value={tol ?? ""}
                onChange={(e) => {
                  const v = parseFloat(e.target.value);
                  setTol(Number.isFinite(v) && v > 0 ? v : null);
                }}
              />
              <span style={fieldUnit}>mm</span>
            </label>
            <button style={busy ? btnDisabled : miniBtn} disabled={busy} onClick={runValidate}>
              {t("meshRepair.validate")}
            </button>
            <div style={{ flex: 1 }} />
            <button style={busy || !report ? btnDisabled : primaryBtn} disabled={busy || !report} onClick={onRepair}>
              {busy ? t("meshRepair.working") : t("meshRepair.repair")}
            </button>
          </div>

          {status && report && <div style={statusLine}>{status}</div>}
        </div>
      </div>
    </div>
  );
}

function Row({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <tr>
      <td style={tdLabel}>{label}</td>
      <td style={{ ...tdValue, color: warn ? "#ffb26b" : "#8fe0b0" }}>{value}</td>
    </tr>
  );
}

// ── styles ────────────────────────────────────────────────────
const overlay: React.CSSProperties = { position: "fixed", inset: 0, background: "rgba(0,0,0,0.35)", display: "flex", alignItems: "flex-start", justifyContent: "center", zIndex: 60, paddingTop: 50 };
const dialog: React.CSSProperties = { width: 380, maxWidth: "92vw", maxHeight: "86vh", display: "flex", flexDirection: "column", background: "#14181c", color: "#e6eaee", border: "1px solid #2c343b", borderRadius: 10, boxShadow: "0 8px 32px rgba(0,0,0,0.5)", fontFamily: "system-ui, sans-serif", fontSize: 12 };
const header: React.CSSProperties = { display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", borderBottom: "1px solid #23292f" };
const hTitle: React.CSSProperties = { fontWeight: 600, fontSize: 13 };
const hSub: React.CSSProperties = { color: "#9aa6b2", fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 180 };
const closeBtn: React.CSSProperties = { background: "transparent", color: "#9aa6b2", border: "none", fontSize: 15, cursor: "pointer" };
const body: React.CSSProperties = { padding: "10px 12px 12px", overflowY: "auto" };
const table: React.CSSProperties = { width: "100%", borderCollapse: "collapse", fontVariantNumeric: "tabular-nums" };
const tdLabel: React.CSSProperties = { padding: "3px 6px", color: "#9aa6b2", borderBottom: "1px solid #1e242a" };
const tdValue: React.CSSProperties = { padding: "3px 6px", textAlign: "right", borderBottom: "1px solid #1e242a", fontWeight: 600 };
const emptyBox: React.CSSProperties = { padding: "18px 8px", textAlign: "center", color: "#9aa6b2" };
const row: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8, marginTop: 10, flexWrap: "wrap" };
const fieldWrap: React.CSSProperties = { display: "flex", alignItems: "center", gap: 4 };
const fieldLabel: React.CSSProperties = { color: "#9aa6b2" };
const fieldUnit: React.CSSProperties = { color: "#7f8b96" };
const input: React.CSSProperties = { width: 72, background: "#1b2126", color: "#e6eaee", border: "1px solid #2c343b", borderRadius: 5, fontSize: 12, padding: "2px 6px" };
const primaryBtn: React.CSSProperties = { background: "#0b5cad", color: "#fff", border: "none", borderRadius: 5, fontSize: 12, padding: "4px 12px", cursor: "pointer" };
const miniBtn: React.CSSProperties = { background: "#26303a", color: "#e6eaee", border: "1px solid #33404b", borderRadius: 5, fontSize: 12, padding: "3px 10px", cursor: "pointer" };
const btnDisabled: React.CSSProperties = { background: "#2c343b", color: "#7f8b96", border: "1px solid #2c343b", borderRadius: 5, fontSize: 12, padding: "4px 12px", cursor: "not-allowed" };
const statusLine: React.CSSProperties = { color: "#8fe08f", fontSize: 11, marginTop: 8 };
