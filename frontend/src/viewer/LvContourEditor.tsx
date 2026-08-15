/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 左室輪郭を引くための拡大パネル（`fw/angio-design.md` §9.2 / A5b）。
 *
 * <h3>点の並びに意味がある</h3>
 * **大動脈弁輪の一端 → 心尖 → 他端** の順にクリックする。この規約から弁面（最初と最後を
 * 結ぶ弦）と長軸（弁面の中点 → 最遠点）が決まるので、**長軸を別に引かせない**。
 * 順序が意味を持つ以上、途中に点を「挿入」できることが要る（末尾追加だけでは直せない）。
 *
 * <h3>なぜ自前 canvas なのか</h3>
 * `QcaEditor` と同じ理由（§8.6）。解析の導線がモーダルなので、ビューポート上のツールにすると
 * 「閉じて直してまた開く」になる。座標はすべて**画像ピクセル**で持つ（world は使わない — A3-3）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../i18n/i18n";
import { publishQlvSnapshot } from "./debugApi";
import { lvMetrics, smoothContour, type Point } from "./qlv";

export interface LvContourEditorProps {
  pixels: Float32Array;
  width: number;
  height: number;
  /** ビューポートと同じ窓。null なら crop の min/max。 */
  voi: { center: number; width: number } | null;
  points: readonly Point[];
  onChange: (next: Point[]) => void;
  /** 比較用に薄く重ねる輪郭（ES を引くときに ED を出す）。 */
  ghost?: readonly Point[] | null;
  /** 実機検証用に座標変換を publish するか（ED/ES で 2 枚出るので、編集中の 1 枚だけ true）。 */
  publishView?: boolean;
  testId?: string;
}

const MAX_W = 470;
const MAX_H = 430;
/** 掴んだと判定する距離 [画面 px]。 */
const GRAB_PX = 9;

export function LvContourEditor({
  pixels,
  width,
  height,
  voi,
  points,
  onChange,
  ghost,
  publishView,
  testId,
}: LvContourEditorProps) {
  const { t } = useI18n();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);

  // 画像全体を収める（QCA と違って、どこに心室があるか事前に分からない）。
  const view = useMemo(() => {
    const scale = Math.min(MAX_W / width, MAX_H / height);
    return {
      cx0: 0,
      cy0: 0,
      cw: width,
      ch: height,
      scale,
      dw: Math.round(width * scale),
      dh: Math.round(height * scale),
    };
  }, [width, height]);

  useEffect(() => {
    if (publishView) publishQlvSnapshot({ view: { ...view } });
  }, [view, publishView]);

  const toImage = useCallback(
    (ev: { clientX: number; clientY: number }): Point | null => {
      const canvas = canvasRef.current;
      if (!canvas) return null;
      const rect = canvas.getBoundingClientRect();
      return [
        view.cx0 + ((ev.clientX - rect.left) / rect.width) * view.cw,
        view.cy0 + ((ev.clientY - rect.top) / rect.height) * view.ch,
      ];
    },
    [view],
  );

  /** 背景（グレースケール）。画素・窓が変わったときだけ作り直す。 */
  const backdrop = useMemo(() => {
    const off = document.createElement("canvas");
    off.width = width;
    off.height = height;
    const octx = off.getContext("2d");
    if (!octx) return null;
    let lo: number;
    let hi: number;
    if (voi && voi.width > 0) {
      lo = voi.center - voi.width / 2;
      hi = voi.center + voi.width / 2;
    } else {
      lo = Infinity;
      hi = -Infinity;
      for (let i = 0; i < pixels.length; i++) {
        const v = pixels[i];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      if (!(hi > lo)) hi = lo + 1;
    }
    const img = octx.createImageData(width, height);
    for (let i = 0; i < width * height; i++) {
      const g = Math.max(0, Math.min(255, Math.round(((pixels[i] - lo) / (hi - lo)) * 255)));
      const k = i * 4;
      img.data[k] = g;
      img.data[k + 1] = g;
      img.data[k + 2] = g;
      img.data[k + 3] = 255;
    }
    octx.putImageData(img, 0, 0);
    return off;
  }, [pixels, width, height, voi]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !backdrop) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const { scale, dw, dh } = view;
    canvas.width = dw;
    canvas.height = dh;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, dw, dh);
    ctx.drawImage(backdrop, 0, 0, dw, dh);

    const sx = (x: number) => x * scale;
    const sy = (y: number) => y * scale;
    const path = (pts: readonly Point[], color: string, w: number, dash?: number[]) => {
      if (pts.length < 2) return;
      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = w;
      if (dash) ctx.setLineDash(dash);
      ctx.beginPath();
      ctx.moveTo(sx(pts[0][0]), sy(pts[0][1]));
      for (let i = 1; i < pts.length; i++) ctx.lineTo(sx(pts[i][0]), sy(pts[i][1]));
      ctx.stroke();
      ctx.restore();
    };

    if (ghost && ghost.length >= 2) {
      const g = smoothContour(ghost);
      path(g, "rgba(127,209,185,0.45)", 1.2);
      path([g[0], g[g.length - 1]], "rgba(127,209,185,0.45)", 1.2, [4, 3]);
    }

    if (points.length >= 2) {
      const curve = smoothContour(points);
      path(curve, "#ffd166", 1.8);
      // 弁面（最初と最後を結ぶ弦）。ここで閉じることを見せないと、点の順序の意味が伝わらない。
      path([points[0], points[points.length - 1]], "#ffd166", 1.5, [5, 4]);
    }

    // 長軸（弁面の中点 → 心尖）。輪郭が成立している間だけ。
    const m = points.length >= 4 ? lvMetrics(smoothContour(points), { mmPerPxRow: null, mmPerPxCol: null }) : null;
    if (m) {
      const curve = smoothContour(points);
      const apex = curve[m.apexIndex];
      ctx.strokeStyle = "#e07a5f";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(sx(m.valveMid[0]), sy(m.valveMid[1]));
      ctx.lineTo(sx(apex[0]), sy(apex[1]));
      ctx.stroke();
    }

    // クリックした点。最初と最後（＝弁輪の両端）は色を変える。
    points.forEach((p, i) => {
      const edge = i === 0 || i === points.length - 1;
      ctx.fillStyle = edge ? "#4fc3f7" : "#ffd166";
      ctx.beginPath();
      ctx.arc(sx(p[0]), sy(p[1]), edge ? 4 : 3, 0, Math.PI * 2);
      ctx.fill();
    });
  }, [backdrop, view, points, ghost]);

  /** 掴んだ点の添字。 */
  const hit = (img: Point): number | null => {
    let best = -1;
    let bestD = Infinity;
    points.forEach((p, i) => {
      const d = Math.hypot(p[0] - img[0], p[1] - img[1]) * view.scale;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    return bestD <= GRAB_PX ? best : null;
  };

  /**
   * 追加位置を決める。
   *
   * <p>末尾に足すだけだと、途中を直したいときに全部引き直しになる。既存の**線分のうち
   * 最も近いもの**の間へ入れる。ただし端（弁輪）より外側をクリックしたときは端に足す
   * ——さもないと**弁面を勝手に動かしてしまう**。
   */
  const insertAt = (img: Point): number => {
    if (points.length < 2) return points.length;
    let bestSeg = 0;
    let bestT = 0;
    let bestD = Infinity;
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i];
      const b = points[i + 1];
      const vx = b[0] - a[0];
      const vy = b[1] - a[1];
      const len2 = vx * vx + vy * vy;
      const tRaw = len2 > 0 ? ((img[0] - a[0]) * vx + (img[1] - a[1]) * vy) / len2 : 0;
      const tt = Math.max(0, Math.min(1, tRaw));
      const d = Math.hypot(a[0] + vx * tt - img[0], a[1] + vy * tt - img[1]);
      if (d < bestD) {
        bestD = d;
        bestSeg = i;
        bestT = tRaw;
      }
    }
    // 🚨 端の外側なら端へ伸ばす。**距離の比較で決めない**。
    //    「最後の点のすぐ先」をクリックすると、最終線分への距離と最終点への距離が
    //    **完全に一致する**（最近点が端点そのものなので）。`<` で比べていると
    //    その同値で「間に挿入」に落ち、点の順序が壊れる —— 順序に意味がある輪郭では致命的。
    //    投影パラメータが区間の外に出ているか、で判定する。
    if (bestSeg === 0 && bestT <= 0) return 0;
    if (bestSeg === points.length - 2 && bestT >= 1) return points.length;
    return bestSeg + 1;
  };

  return (
    <div>
      <canvas
        ref={canvasRef}
        data-testid={testId ?? "lv-contour-canvas"}
        style={{
          width: view.dw,
          height: view.dh,
          border: "1px solid #c3ced9",
          borderRadius: 3,
          cursor: "crosshair",
          touchAction: "none",
        }}
        onContextMenu={(e) => {
          // 右クリックは削除（メニューは出さない）。
          e.preventDefault();
          const img = toImage(e);
          if (!img) return;
          const i = hit(img);
          if (i != null) onChange(points.filter((_, k) => k !== i));
        }}
        onPointerDown={(e) => {
          const img = toImage(e);
          if (!img) return;
          const i = hit(img);
          if (e.altKey) {
            if (i != null) onChange(points.filter((_, k) => k !== i));
            return;
          }
          if (i != null) {
            setDragIndex(i);
            e.currentTarget.setPointerCapture(e.pointerId);
            return;
          }
          const at = insertAt(img);
          const next = [...points];
          next.splice(at, 0, img);
          onChange(next);
        }}
        onPointerMove={(e) => {
          if (dragIndex == null) return;
          const img = toImage(e);
          if (!img) return;
          const next = [...points];
          next[dragIndex] = img;
          onChange(next);
        }}
        onPointerUp={(e) => {
          if (dragIndex != null) {
            e.currentTarget.releasePointerCapture(e.pointerId);
            setDragIndex(null);
          }
        }}
      />
      <div style={hint}>{t("qlv.editor.hint")}</div>
    </div>
  );
}

const hint: React.CSSProperties = { fontSize: 11, color: "#66788a", marginTop: 4, maxWidth: MAX_W };
