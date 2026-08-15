/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * QCA の中心線・エッジを**手で直す**ための拡大表示（`fw/angio-design.md` §8.6）。
 *
 * <h3>なぜこれが要るのか</h3>
 * 中心線はコスト最小経路なので、**血管から外れていても「それらしい」経路を必ず引く**。
 * 結果は必ず出るし、内部整合もする（実機検証 §8.5 で %DS 94.2% という臨床的に無意味な値が
 * 内部整合したまま出た）。臨床 QCA が「自動＋手修正」を前提にしているのはこのためで、
 * ここが無い QCA を「使える」と言ってはいけない。
 *
 * <h3>なぜ Cornerstone のツールではなく自前の canvas なのか</h3>
 * 設計 §8.2 は `QcaTool` を想定していたが、解析の導線がモーダルダイアログである以上、
 * ビューポート上のツールにすると「ダイアログを閉じて直してまた開く」ことになる。
 * 拡大した解析区間だけを見せる専用パネルのほうが、細い血管のエッジを 1px 単位で
 * 動かす作業には適している（市販の QCA も専用パネル方式が多い）。
 * ビューポート側は GSPS 保存時の描画で見える。
 *
 * <h3>座標系</h3>
 * すべて**画像ピクセル座標**で持つ。表示は crop（解析区間の外接矩形＋余白）を等倍整数倍で
 * 拡大するだけ。world 座標は一切使わない（world はローダの spacing 次第で意味が変わる — A3-3）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../i18n/i18n";
import { publishQcaSnapshot } from "./debugApi";
import type { QcaResult } from "./qca";

/** 編集モード。 */
export type QcaEditMode = "none" | "waypoint" | "edge";

export interface QcaEditorProps {
  /** 解析に使った画素（モダリティ値）。 */
  pixels: Float32Array;
  width: number;
  height: number;
  /** 表示の窓（ビューポートと同じ見え方にするため）。null なら自動で min/max。 */
  voi: { center: number; width: number } | null;
  result: QcaResult;
  mode: QcaEditMode;
  waypoints: readonly (readonly [number, number])[];
  /** 中心線（path）インデックス → 法線方向の符号付きオフセット。 */
  edgeEdits: Readonly<Record<number, { left?: number; right?: number }>>;
  /** ハイライトする計測点（径プロファイル上の選択と連動）。 */
  highlightIndex?: number | null;
  onWaypointsChange: (next: [number, number][]) => void;
  onEdgeEdit: (pathIndex: number, side: "left" | "right", offset: number) => void;
}

/** 表示パネルの最大寸法 [px]。 */
const MAX_W = 460;
const MAX_H = 300;
/** 掴んだと判定する距離 [画面 px]。 */
const GRAB_PX = 8;

export function QcaEditor({
  pixels,
  width,
  height,
  voi,
  result,
  mode,
  waypoints,
  edgeEdits,
  highlightIndex,
  onWaypointsChange,
  onEdgeEdit,
}: QcaEditorProps) {
  const { t } = useI18n();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [drag, setDrag] = useState<
    | { kind: "waypoint"; index: number }
    | { kind: "edge"; pathIndex: number; side: "left" | "right" }
    | null
  >(null);

  // ── crop と拡大率 ─────────────────────────────────────────────────
  const view = useMemo(() => {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    const push = (p: readonly [number, number]) => {
      if (p[0] < x0) x0 = p[0];
      if (p[0] > x1) x1 = p[0];
      if (p[1] < y0) y0 = p[1];
      if (p[1] > y1) y1 = p[1];
    };
    for (const c of result.centerline) push(c);
    for (const e of result.edges) {
      push(e.left);
      push(e.right);
    }
    for (const w of waypoints) push(w);
    if (!Number.isFinite(x0)) return null;
    // 余白は「エッジを外へ引っ張れる」だけ要る。
    const pad = 16;
    const cx0 = Math.max(0, Math.floor(x0 - pad));
    const cy0 = Math.max(0, Math.floor(y0 - pad));
    const cx1 = Math.min(width - 1, Math.ceil(x1 + pad));
    const cy1 = Math.min(height - 1, Math.ceil(y1 + pad));
    const cw = Math.max(1, cx1 - cx0 + 1);
    const ch = Math.max(1, cy1 - cy0 + 1);
    const scale = Math.max(1, Math.min(MAX_W / cw, MAX_H / ch));
    return { cx0, cy0, cw, ch, scale, dw: Math.round(cw * scale), dh: Math.round(ch * scale) };
  }, [result, waypoints, width, height]);

  // 実機検証が「掴めているか」を計算できるよう、座標変換を公開する（DEV 以外では何もしない）。
  useEffect(() => {
    publishQcaSnapshot({ view: view ? { ...view } : null });
  }, [view]);

  /** 画面座標 → 画像ピクセル座標。 */
  const toImage = useCallback(
    (ev: { clientX: number; clientY: number }): [number, number] | null => {
      const canvas = canvasRef.current;
      if (!canvas || !view) return null;
      const rect = canvas.getBoundingClientRect();
      return [
        view.cx0 + ((ev.clientX - rect.left) / rect.width) * view.cw,
        view.cy0 + ((ev.clientY - rect.top) / rect.height) * view.ch,
      ];
    },
    [view],
  );

  /**
   * crop のグレースケール画像（等倍）。
   *
   * <p>ハイライトの追従でマウス移動のたびに作り直すと、crop 全画素の走査が毎フレーム走る。
   * 画像そのものが変わる条件（画素・crop・窓）だけで作り直す。
   */
  const backdropCanvas = useMemo(() => {
    if (!view) return null;
    const { cx0, cy0, cw, ch } = view;
    const off = document.createElement("canvas");
    off.width = cw;
    off.height = ch;
    const octx = off.getContext("2d");
    if (!octx) return null;

    // 画素 → 8bit（ビューポートと同じ窓を使う。違う見え方だと「別の画像」に見える）。
    let lo: number;
    let hi: number;
    if (voi && voi.width > 0) {
      lo = voi.center - voi.width / 2;
      hi = voi.center + voi.width / 2;
    } else {
      lo = Infinity;
      hi = -Infinity;
      for (let y = cy0; y < cy0 + ch; y++) {
        for (let x = cx0; x < cx0 + cw; x++) {
          const v = pixels[y * width + x];
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
      }
      if (!(hi > lo)) hi = lo + 1;
    }
    const img = octx.createImageData(cw, ch);
    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < cw; x++) {
        const v = pixels[(y + cy0) * width + (x + cx0)];
        const g = Math.max(0, Math.min(255, Math.round(((v - lo) / (hi - lo)) * 255)));
        const i = (y * cw + x) * 4;
        img.data[i] = g;
        img.data[i + 1] = g;
        img.data[i + 2] = g;
        img.data[i + 3] = 255;
      }
    }
    octx.putImageData(img, 0, 0);
    return off;
  }, [pixels, width, view, voi]);

  // ── 描画 ─────────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !view || !backdropCanvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const { cx0, cy0, scale, dw, dh } = view;
    const off = backdropCanvas;
    canvas.width = dw;
    canvas.height = dh;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, dw, dh);
    ctx.drawImage(off, 0, 0, dw, dh);

    const sx = (x: number) => (x - cx0) * scale;
    const sy = (y: number) => (y - cy0) * scale;

    const stroke = (pts: readonly (readonly [number, number])[], color: string, w = 1.5) => {
      if (pts.length < 2) return;
      ctx.strokeStyle = color;
      ctx.lineWidth = w;
      ctx.beginPath();
      ctx.moveTo(sx(pts[0][0]), sy(pts[0][1]));
      for (let i = 1; i < pts.length; i++) ctx.lineTo(sx(pts[i][0]), sy(pts[i][1]));
      ctx.stroke();
    };

    stroke(result.edges.map((e) => e.left), "#4fc3f7");
    stroke(result.edges.map((e) => e.right), "#4fc3f7");
    stroke(result.centerline, "#7fd1b9");

    // 手で直したエッジは色を変える（どこに手が入っているかが一目で分かるように）。
    ctx.fillStyle = "#ffd166";
    for (const i of result.provenance.editedEdges) {
      const e = result.edges[i];
      if (!e) continue;
      ctx.beginPath();
      ctx.arc(sx(e.left[0]), sy(e.left[1]), 2.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(sx(e.right[0]), sy(e.right[1]), 2.5, 0, Math.PI * 2);
      ctx.fill();
    }

    // MLD の位置。
    const mldEdge = result.edges[result.mldIndex];
    if (mldEdge) {
      ctx.strokeStyle = "#e07a5f";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(sx(mldEdge.left[0]), sy(mldEdge.left[1]));
      ctx.lineTo(sx(mldEdge.right[0]), sy(mldEdge.right[1]));
      ctx.stroke();
    }

    // 径プロファイルで選択中の点。
    if (highlightIndex != null && result.edges[highlightIndex]) {
      const e = result.edges[highlightIndex];
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(sx(e.left[0]), sy(e.left[1]));
      ctx.lineTo(sx(e.right[0]), sy(e.right[1]));
      ctx.stroke();
    }

    // 中間点。
    ctx.fillStyle = "#ffd166";
    ctx.strokeStyle = "#1b2733";
    ctx.lineWidth = 1;
    for (const w of waypoints) {
      const r = 4;
      ctx.beginPath();
      ctx.rect(sx(w[0]) - r, sy(w[1]) - r, r * 2, r * 2);
      ctx.fill();
      ctx.stroke();
    }
  }, [backdropCanvas, result, waypoints, view, highlightIndex]);

  // ── 掴む対象を決める ─────────────────────────────────────────────
  const hitWaypoint = (p: [number, number]): number => {
    if (!view) return -1;
    const tol = GRAB_PX / view.scale;
    let best = -1;
    let bd = tol;
    for (let i = 0; i < waypoints.length; i++) {
      const d = Math.hypot(waypoints[i][0] - p[0], waypoints[i][1] - p[1]);
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    return best;
  };

  const hitEdge = (p: [number, number]): { pathIndex: number; side: "left" | "right" } | null => {
    if (!view) return null;
    const tol = GRAB_PX / view.scale;
    let best: { pathIndex: number; side: "left" | "right" } | null = null;
    let bd = tol;
    for (let i = 0; i < result.edges.length; i++) {
      for (const side of ["left", "right"] as const) {
        const e = result.edges[i][side];
        const d = Math.hypot(e[0] - p[0], e[1] - p[1]);
        if (d < bd) {
          bd = d;
          best = { pathIndex: result.pathIndices[i], side };
        }
      }
    }
    return best;
  };

  /** 中間点は**中心線に沿った順**に並べる（順序が崩れると経路が往復してしまう）。 */
  const insertWaypoint = (p: [number, number]): void => {
    const orderOf = (q: readonly [number, number]): number => {
      let best = 0;
      let bd = Infinity;
      for (let i = 0; i < result.centerline.length; i++) {
        const c = result.centerline[i];
        const d = (c[0] - q[0]) ** 2 + (c[1] - q[1]) ** 2;
        if (d < bd) {
          bd = d;
          best = i;
        }
      }
      return best;
    };
    const next = [...waypoints.map((w) => [w[0], w[1]] as [number, number]), p];
    next.sort((a, b) => orderOf(a) - orderOf(b));
    onWaypointsChange(next);
  };

  const onPointerDown = (ev: React.PointerEvent<HTMLCanvasElement>) => {
    const p = toImage(ev);
    if (!p || mode === "none") return;
    ev.currentTarget.setPointerCapture(ev.pointerId);
    if (mode === "waypoint") {
      const hit = hitWaypoint(p);
      // 右クリック / Alt クリックは削除。
      if (ev.button === 2 || ev.altKey) {
        if (hit >= 0) onWaypointsChange(waypoints.filter((_, i) => i !== hit).map((w) => [w[0], w[1]]));
        return;
      }
      if (hit >= 0) setDrag({ kind: "waypoint", index: hit });
      else insertWaypoint(p);
      return;
    }
    const e = hitEdge(p);
    if (e) setDrag({ kind: "edge", ...e });
  };

  const onPointerMove = (ev: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drag) return;
    const p = toImage(ev);
    if (!p) return;
    if (drag.kind === "waypoint") {
      const next = waypoints.map((w, i) => (i === drag.index ? p : ([w[0], w[1]] as [number, number])));
      onWaypointsChange(next);
      return;
    }
    // エッジは**法線上でしか動かせない**（血管の断面という意味を保つため）。
    const i = result.pathIndices.indexOf(drag.pathIndex);
    if (i < 0) return;
    const c = result.centerline[i];
    const n = result.normals[i];
    const offset = (p[0] - c[0]) * n[0] + (p[1] - c[1]) * n[1];
    // 符号は中心線をまたげない。0 に潰れると径が 0 になるので下限を置く。
    const clamped = drag.side === "left" ? Math.min(-0.25, offset) : Math.max(0.25, offset);
    onEdgeEdit(drag.pathIndex, drag.side, clamped);
  };

  const endDrag = (ev: React.PointerEvent<HTMLCanvasElement>) => {
    if (drag) ev.currentTarget.releasePointerCapture(ev.pointerId);
    setDrag(null);
  };

  if (!view) return null;
  const editedCount = result.provenance.editedEdges.length;

  return (
    <div>
      <canvas
        ref={canvasRef}
        data-testid="qca-editor-canvas"
        style={{
          width: view.dw,
          height: view.dh,
          borderRadius: 4,
          background: "#000",
          cursor: mode === "none" ? "default" : drag ? "grabbing" : "crosshair",
          touchAction: "none",
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onContextMenu={(e) => e.preventDefault()}
      />
      <div style={legend}>
        <span style={{ color: "#7fd1b9" }}>━ {t("xa.qca.legendCenterline")}</span>
        <span style={{ color: "#4fc3f7" }}>━ {t("xa.qca.legendEdges")}</span>
        <span style={{ color: "#e07a5f" }}>━ MLD</span>
        <span style={{ color: "#c08a2a" }}>
          ■ {t("xa.qca.legendEdited", { waypoints: String(waypoints.length), edges: String(editedCount) })}
        </span>
      </div>
      <div style={hint}>
        {mode === "waypoint"
          ? t("xa.qca.hintWaypoint")
          : mode === "edge"
            ? t("xa.qca.hintEdge")
            : t("xa.qca.hintNone")}
      </div>
      {Object.keys(edgeEdits).length > 0 && result.warnings.includes("edgeEditsDropped") && (
        <div style={warn}>{t("xa.qca.edgeEditsDropped")}</div>
      )}
    </div>
  );
}

const legend: React.CSSProperties = {
  display: "flex",
  gap: 12,
  fontSize: 10,
  marginTop: 4,
  flexWrap: "wrap",
};
const hint: React.CSSProperties = { fontSize: 11, color: "#66788a", marginTop: 4 };
const warn: React.CSSProperties = { fontSize: 11, color: "#a5642a", marginTop: 4 };
