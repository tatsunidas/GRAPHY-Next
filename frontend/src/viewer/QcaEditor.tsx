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
import { brushEdges, type BrushedEdge, smoothEdges, detectEdgeOutliers } from "./qcaBrush";
import {
  buildStraightened,
  pointAtFractionalIndex,
  straightenHalfWidth,
  straightenedToImageData,
} from "./qcaStraighten";

/** 編集モード。 */
/**
 * `smooth` は「ならす」ブラシ（§8.8.1）。**押すブラシでは外れ点を直せない**
 * ——半径内へ同じ移動量を配るので、外れ点を押せば近傍まで外れ、近傍を押せば外れ点は残る。
 */
export type QcaEditMode = "none" | "waypoint" | "edge" | "brush" | "smooth";

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
  /** ブラシ半径（`result.positions` と同じ単位＝校正済みなら mm）。 */
  brushRadius: number;
  /** ハイライトする計測点（径プロファイル上の選択と連動）。 */
  highlightIndex?: number | null;
  /**
   * エッジ（左右の輪郭線とその上の印）を描くか。
   *
   * <p>🔴 **消しているあいだはエッジを掴めない。** 見えないものを掴ませると、
   * どこを動かしたのか分からないまま手修正が入る（`provenance.editedEdges` だけが増える）。
   */
  showEdges?: boolean;
  /** 囲っている内腔を半透明で塗るか（線より「面」のほうが当たり外れを掴みやすい）。 */
  showMask?: boolean;
  /**
   * 中心線に沿って**まっすぐ引き延ばした像**（ストレート像）も出すか（§8.9）。
   *
   * <p>曲がった血管を曲がったまま見ると、エッジのずれが「曲がりのせい」に見えて
   * 判別しにくい。帯にすると、径の変化と外れが**上下のがたつき**としてそのまま出る。
   * 帯の上でも中心線（中間点）とエッジを直せて、本画面と**同じ結果**を書き換える。
   */
  showStraight?: boolean;
  onWaypointsChange: (next: [number, number][]) => void;
  onEdgeEdit: (pathIndex: number, side: "left" | "right", offset: number) => void;
  /** ブラシ 1 回ぶん（複数点）。`qcaBrush.brushEdges` の結果をそのまま渡す。 */
  onEdgeEditMany: (edits: readonly BrushedEdge[]) => void;
}

/** 表示パネルの最大寸法 [px]。 */
const MAX_W = 460;
const MAX_H = 300;
/** ストレート像の最大の高さ [px]（横は MAX_W に合わせる）。 */
const MAX_STRIP_H = 190;
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
  brushRadius,
  showEdges = true,
  showMask = false,
  showStraight = true,
  highlightIndex,
  onWaypointsChange,
  onEdgeEdit,
  onEdgeEditMany,
}: QcaEditorProps) {
  const { t } = useI18n();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stripRef = useRef<HTMLCanvasElement | null>(null);
  /**
   * ストレート像の上のドラッグ。
   *
   * <p>🔴 本画面と**別に持つ**。同じ状態を共有すると、片方で掴んだまま
   * もう片方へポインタが入ったときに座標系が入れ替わり、掴んだ点が飛ぶ。
   */
  const [stripDrag, setStripDrag] = useState<
    | { kind: "waypoint"; index: number }
    | { kind: "edge" | "brush" | "smooth"; pathIndex: number; side: "left" | "right"; centerIndex: number }
    | null
  >(null);
  const [drag, setDrag] = useState<
    | { kind: "waypoint"; index: number }
    | { kind: "edge"; pathIndex: number; side: "left" | "right" }
    | { kind: "brush"; pathIndex: number; side: "left" | "right" }
    | { kind: "smooth"; pathIndex: number; side: "left" | "right" }
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
  /**
   * 画素 → 8bit の窓。
   *
   * <p>🔴 **本画面とストレート像で同じ窓を使う。** 片方だけ自動窓にすると、同じ血管が
   * 隣同士で違う明るさに出て「別の画像」に見える（見比べる道具なので致命的）。
   */
  const grayWindow = useMemo(() => {
    if (!view) return null;
    if (voi && voi.width > 0) {
      return { lo: voi.center - voi.width / 2, hi: voi.center + voi.width / 2 };
    }
    const { cx0, cy0, cw, ch } = view;
    let lo = Infinity;
    let hi = -Infinity;
    for (let y = cy0; y < cy0 + ch; y++) {
      for (let x = cx0; x < cx0 + cw; x++) {
        const v = pixels[y * width + x];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    if (!(hi > lo)) hi = lo + 1;
    return { lo, hi };
  }, [pixels, width, view, voi]);

  const backdropCanvas = useMemo(() => {
    if (!view || !grayWindow) return null;
    const { cx0, cy0, cw, ch } = view;
    const off = document.createElement("canvas");
    off.width = cw;
    off.height = ch;
    const octx = off.getContext("2d");
    if (!octx) return null;
    const { lo, hi } = grayWindow;
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
  }, [pixels, width, view, grayWindow]);

  /**
   * ストレート像（§8.9）。中心線・法線・窓が変われば作り直す。
   *
   * <p>計算量は 列 × 行（実測 240 × 33 ≒ 8 千サンプル）で、手修正のたびに走っても軽い。
   * **中心線が変われば像も変わる**——これが「連動している」ことの実体で、
   * 別々に持つと片方だけ古い絵が残る。
   */
  const straight = useMemo(() => {
    if (!showStraight || !grayWindow) return null;
    return buildStraightened({
      centerline: result.centerline,
      normals: result.normals,
      pixels,
      width,
      height,
      halfWidthPx: straightenHalfWidth(result.edgeOffsets),
      lo: grayWindow.lo,
      hi: grayWindow.hi,
    });
  }, [showStraight, grayWindow, result, pixels, width, height]);

  /** 帯の表示寸法（等方。縦だけ伸ばすと径が太って見えるのでやらない）。 */
  const stripView = useMemo(() => {
    if (!straight) return null;
    const scale = Math.max(1, Math.min(MAX_W / straight.cols, MAX_STRIP_H / straight.rows));
    return {
      scale,
      dw: Math.round(straight.cols * scale),
      dh: Math.round(straight.rows * scale),
    };
  }, [straight]);

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

    // 内腔の半透明マスク。**線より先に敷く**（面を上に乗せると輪郭が沈んで見えなくなる）。
    // 面は「左エッジを近位→遠位、右エッジを遠位→近位」でひと筆に閉じる＝解析が内腔と
    // みなしている領域そのもの。線とは別の見え方をするので、外れている所が掴みやすい。
    if (showMask && result.edges.length >= 2) {
      ctx.fillStyle = "rgba(79, 195, 247, 0.28)";
      ctx.beginPath();
      ctx.moveTo(sx(result.edges[0].left[0]), sy(result.edges[0].left[1]));
      for (let i = 1; i < result.edges.length; i++) {
        ctx.lineTo(sx(result.edges[i].left[0]), sy(result.edges[i].left[1]));
      }
      for (let i = result.edges.length - 1; i >= 0; i--) {
        ctx.lineTo(sx(result.edges[i].right[0]), sy(result.edges[i].right[1]));
      }
      ctx.closePath();
      ctx.fill();
    }

    if (showEdges) {
      stroke(result.edges.map((e) => e.left), "#4fc3f7");
      stroke(result.edges.map((e) => e.right), "#4fc3f7");
    }
    stroke(result.centerline, "#7fd1b9");

    // 🚨 **外れ点に印を付ける**（`smooth` モードのときだけ）。
    //    「ならす」は外れている所だけをなでる道具なので、**どこが外れているのかが
    //    見えないと使えない**——外れ点が扱いづらいという指摘の半分はここだった。
    //    印は検出（ロバスト・`detectEdgeOutliers`）そのままで、閾値は画面に持たせない。
    if (mode === "smooth" && showEdges) {
      ctx.strokeStyle = "#ff7b72";
      ctx.lineWidth = 1.5;
      for (const side of ["left", "right"] as const) {
        const values = result.edgeOffsets.map((o) => o[side]);
        for (const i of detectEdgeOutliers(result.positions, values, brushRadius)) {
          const e = result.edges[i];
          if (!e) continue;
          const pt = e[side];
          ctx.beginPath();
          ctx.arc(sx(pt[0]), sy(pt[1]), 4.5, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
    }

    // 手で直したエッジは色を変える（どこに手が入っているかが一目で分かるように）。
    // エッジを消しているときは一緒に消す——線が無いのに点だけ浮くと何の点か分からない。
    ctx.fillStyle = "#ffd166";
    for (const i of showEdges ? result.provenance.editedEdges : []) {
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
  // 🔴 `mode` と `brushRadius` を依存に入れる——外れ点の印は smooth のときだけ描き、
  //    半径で変わる。入れ忘れると「モードを切り替えても印が出ない / 消えない」になる。
  }, [backdropCanvas, result, waypoints, view, highlightIndex, mode, brushRadius, showEdges, showMask]);

  // 実機検証が帯の上の座標を計算できるよう、帯の座標系も公開する。
  useEffect(() => {
    publishQcaSnapshot({
      straight:
        straight && stripView
          ? {
              cols: straight.cols,
              rows: straight.rows,
              halfWidthPx: straight.halfWidthPx,
              lengthPx: straight.lengthPx,
              scale: stripView.scale,
              dw: stripView.dw,
              dh: stripView.dh,
            }
          : null,
    });
  }, [straight, stripView]);

  // ── ストレート像の描画 ───────────────────────────────────────────
  // 🔴 本画面と**同じ描き順**（面 → 線 → 印）。順序が違うと、同じ状態なのに
  //    片方だけ輪郭が沈んで見え、どちらが正しいのか分からなくなる。
  useEffect(() => {
    const canvas = stripRef.current;
    if (!canvas || !straight || !stripView) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    canvas.width = stripView.dw;
    canvas.height = stripView.dh;
    ctx.imageSmoothingEnabled = false;

    // 画像（等倍で焼いてから拡大）。
    const off = document.createElement("canvas");
    off.width = straight.cols;
    off.height = straight.rows;
    const octx = off.getContext("2d");
    if (!octx) return;
    octx.putImageData(straightenedToImageData(straight, octx), 0, 0);
    ctx.clearRect(0, 0, stripView.dw, stripView.dh);
    ctx.drawImage(off, 0, 0, stripView.dw, stripView.dh);

    const sxOf = (col: number) => col * stripView.scale;
    const syOf = (offset: number) => (offset + straight.halfWidthPx) * stripView.scale;
    const colOf = (i: number) => straight.indexToCol[i] ?? 0;

    // 内腔の面（本画面と同じく線より先に敷く）。
    if (showMask && result.edgeOffsets.length >= 2) {
      ctx.fillStyle = "rgba(79, 195, 247, 0.28)";
      ctx.beginPath();
      ctx.moveTo(sxOf(colOf(0)), syOf(result.edgeOffsets[0].left));
      for (let i = 1; i < result.edgeOffsets.length; i++) {
        ctx.lineTo(sxOf(colOf(i)), syOf(result.edgeOffsets[i].left));
      }
      for (let i = result.edgeOffsets.length - 1; i >= 0; i--) {
        ctx.lineTo(sxOf(colOf(i)), syOf(result.edgeOffsets[i].right));
      }
      ctx.closePath();
      ctx.fill();
    }

    const strokeOffsets = (side: "left" | "right", color: string) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (let i = 0; i < result.edgeOffsets.length; i++) {
        const x = sxOf(colOf(i));
        const y = syOf(result.edgeOffsets[i][side]);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    };
    if (showEdges) {
      strokeOffsets("left", "#4fc3f7");
      strokeOffsets("right", "#4fc3f7");
    }

    // 中心線は帯の真ん中の水平線（＝オフセット 0）。まっすぐなのが道具の要点。
    ctx.strokeStyle = "#7fd1b9";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(0, syOf(0));
    ctx.lineTo(stripView.dw, syOf(0));
    ctx.stroke();

    // 外れ点の印（本画面と同じ条件で出す）。
    if (mode === "smooth" && showEdges) {
      ctx.strokeStyle = "#ff7b72";
      ctx.lineWidth = 1.5;
      for (const side of ["left", "right"] as const) {
        const values = result.edgeOffsets.map((o) => o[side]);
        for (const i of detectEdgeOutliers(result.positions, values, brushRadius)) {
          if (!result.edgeOffsets[i]) continue;
          ctx.beginPath();
          ctx.arc(sxOf(colOf(i)), syOf(result.edgeOffsets[i][side]), 4.5, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
    }

    // 手で直したエッジ。
    // 🔴 `provenance.editedEdges` は **計測点の添字**（path 番号ではない）。
    //    `pathIndices` で引き直すと、印だけ**別の場所**に出る（本画面の描画と同じ規約）。
    ctx.fillStyle = "#ffd166";
    for (const i of showEdges ? result.provenance.editedEdges : []) {
      if (!result.edgeOffsets[i]) continue;
      for (const side of ["left", "right"] as const) {
        ctx.beginPath();
        ctx.arc(sxOf(colOf(i)), syOf(result.edgeOffsets[i][side]), 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // MLD。
    const mldOff = result.edgeOffsets[result.mldIndex];
    if (mldOff) {
      ctx.strokeStyle = "#e07a5f";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(sxOf(colOf(result.mldIndex)), syOf(mldOff.left));
      ctx.lineTo(sxOf(colOf(result.mldIndex)), syOf(mldOff.right));
      ctx.stroke();
    }

    // 径プロファイルで選択中の点。
    if (highlightIndex != null && result.edgeOffsets[highlightIndex]) {
      const o = result.edgeOffsets[highlightIndex];
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(sxOf(colOf(highlightIndex)), syOf(o.left));
      ctx.lineTo(sxOf(colOf(highlightIndex)), syOf(o.right));
      ctx.stroke();
    }

    // 中間点は「中心線の上に乗っている」ので、帯では縦線で位置だけ示す
    // （帯の縦は法線方向のオフセットなので、中間点は必ずオフセット 0 付近に来る）。
    if (waypoints.length) {
      ctx.fillStyle = "#ffd166";
      ctx.strokeStyle = "#1b2733";
      ctx.lineWidth = 1;
      for (const w of waypoints) {
        let best = -1;
        let bd = Infinity;
        for (let i = 0; i < result.centerline.length; i++) {
          const c = result.centerline[i];
          const d = (c[0] - w[0]) ** 2 + (c[1] - w[1]) ** 2;
          if (d < bd) {
            bd = d;
            best = i;
          }
        }
        if (best < 0) continue;
        const x = sxOf(colOf(best));
        ctx.beginPath();
        ctx.rect(x - 3, syOf(0) - 3, 6, 6);
        ctx.fill();
        ctx.stroke();
      }
    }
  }, [straight, stripView, result, waypoints, highlightIndex, mode, brushRadius, showEdges, showMask]);

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
    // 🔴 見えていないものは掴ませない。掴めてしまうと、どこを動かしたのか分からないまま
    //    手修正が入り、`provenance.editedEdges` だけが増える。
    if (!view || !showEdges) return null;
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
    if (e) setDrag({ kind: mode === "brush" ? "brush" : mode === "smooth" ? "smooth" : "edge", ...e });
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
    if (drag.kind === "smooth") {
      // 「ならす」——局所中央値へ寄せる。外れ点は大きく動き、合っている点はほとんど動かない。
      // 🔴 ここでポインタの位置は使わない。使うのは「どこをなでているか」だけ。
      const smoothed = smoothEdges({
        positions: result.positions,
        pathIndices: result.pathIndices,
        edgeOffsets: result.edgeOffsets,
        centerIndex: i,
        side: drag.side,
        radius: brushRadius,
      });
      if (smoothed.length) onEdgeEditMany(smoothed);
      return;
    }
    if (drag.kind === "brush") {
      // 掴んだ点の**移動量**を、中心線に沿って近い点へ重み付きで配る（`qcaBrush.ts`）。
      // ポインタ位置を各点へ当てはめないので、もとの輪郭の形は保たれる。
      const brushed = brushEdges({
        positions: result.positions,
        pathIndices: result.pathIndices,
        edgeOffsets: result.edgeOffsets,
        centerIndex: i,
        side: drag.side,
        targetOffset: offset,
        radius: brushRadius,
      });
      if (brushed.length) onEdgeEditMany(brushed);
      return;
    }
    // 符号は中心線をまたげない。0 に潰れると径が 0 になるので下限を置く。
    const clamped = drag.side === "left" ? Math.min(-0.25, offset) : Math.max(0.25, offset);
    onEdgeEdit(drag.pathIndex, drag.side, clamped);
  };

  const endDrag = (ev: React.PointerEvent<HTMLCanvasElement>) => {
    if (drag) ev.currentTarget.releasePointerCapture(ev.pointerId);
    setDrag(null);
  };

  /* ── ストレート像の上の操作 ─────────────────────────────────── */

  /**
   * 帯の上の位置 → 計測点と法線オフセット。
   *
   * <p>🔴 縦は `result.edgeOffsets` と**同じ量**（符号付き・画像 px）。だから
   * 掴んで動かすことがそのまま `onEdgeEdit(pathIndex, side, offset)` になる。
   */
  const toStrip = (
    ev: { clientX: number; clientY: number },
  ): { index: number; offset: number; col: number } | null => {
    const canvas = stripRef.current;
    if (!canvas || !straight) return null;
    const rect = canvas.getBoundingClientRect();
    if (!(rect.width > 0 && rect.height > 0)) return null;
    const col = Math.max(0, Math.min(straight.cols - 1, ((ev.clientX - rect.left) / rect.width) * straight.cols));
    const row = ((ev.clientY - rect.top) / rect.height) * straight.rows;
    const fi = straight.colToIndex[Math.round(col)] ?? 0;
    const index = Math.max(0, Math.min(result.edgeOffsets.length - 1, Math.round(fi)));
    return { index, offset: row - straight.halfWidthPx, col };
  };

  /** 帯で掴めるエッジ（画面 px で近さを見る。本画面と同じ {@link GRAB_PX}）。 */
  const hitStripEdge = (index: number, offset: number): "left" | "right" | null => {
    if (!showEdges || !straight || !stripView) return null; // 見えないものは掴ませない（§8.8.3）
    const o = result.edgeOffsets[index];
    if (!o) return null;
    const tol = GRAB_PX / stripView.scale;
    const dl = Math.abs(offset - o.left);
    const dr = Math.abs(offset - o.right);
    if (Math.min(dl, dr) > tol) return null;
    return dl <= dr ? "left" : "right";
  };

  /** 帯の位置 → 画像座標（中間点を置くのに使う）。 */
  const stripToImage = (col: number, offset: number): [number, number] | null => {
    if (!straight) return null;
    const fi = straight.colToIndex[Math.round(col)] ?? 0;
    const p = pointAtFractionalIndex(result.centerline, result.normals, fi);
    return [p.x + p.nx * offset, p.y + p.ny * offset];
  };

  /** 帯の上で中間点を掴めるか（横方向の近さだけで見る。縦は中心線上に居るため）。 */
  const nearestWaypointOnStrip = (col: number): number => {
    if (!straight || !stripView) return -1;
    const tol = GRAB_PX / stripView.scale;
    let best = -1;
    let bd = tol;
    for (let i = 0; i < waypoints.length; i++) {
      const w = waypoints[i];
      let ci = -1;
      let cd = Infinity;
      for (let k = 0; k < result.centerline.length; k++) {
        const c = result.centerline[k];
        const d = (c[0] - w[0]) ** 2 + (c[1] - w[1]) ** 2;
        if (d < cd) {
          cd = d;
          ci = k;
        }
      }
      if (ci < 0) continue;
      const d = Math.abs((straight.indexToCol[ci] ?? 0) - col);
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    return best;
  };

  const onStripPointerDown = (ev: React.PointerEvent<HTMLCanvasElement>) => {
    const hit = toStrip(ev);
    if (!hit || mode === "none") return;
    ev.currentTarget.setPointerCapture(ev.pointerId);
    if (mode === "waypoint") {
      // 帯で「上下に動かす」＝中心線をその場所で法線方向へ寄せる、という意味になる。
      const near = nearestWaypointOnStrip(hit.col);
      if (ev.button === 2 || ev.altKey) {
        if (near >= 0) onWaypointsChange(waypoints.filter((_, i) => i !== near).map((w) => [w[0], w[1]]));
        return;
      }
      if (near >= 0) {
        setStripDrag({ kind: "waypoint", index: near });
        return;
      }
      const p = stripToImage(hit.col, hit.offset);
      if (p) insertWaypoint(p);
      return;
    }
    const side = hitStripEdge(hit.index, hit.offset);
    if (!side) return;
    setStripDrag({
      kind: mode === "brush" ? "brush" : mode === "smooth" ? "smooth" : "edge",
      pathIndex: result.pathIndices[hit.index],
      side,
      centerIndex: hit.index,
    });
  };

  const onStripPointerMove = (ev: React.PointerEvent<HTMLCanvasElement>) => {
    if (!stripDrag) return;
    const hit = toStrip(ev);
    if (!hit) return;
    if (stripDrag.kind === "waypoint") {
      const p = stripToImage(hit.col, hit.offset);
      if (!p) return;
      onWaypointsChange(waypoints.map((w, i) => (i === stripDrag.index ? p : ([w[0], w[1]] as [number, number]))));
      return;
    }
    if (stripDrag.kind === "smooth") {
      const smoothed = smoothEdges({
        positions: result.positions,
        pathIndices: result.pathIndices,
        edgeOffsets: result.edgeOffsets,
        centerIndex: stripDrag.centerIndex,
        side: stripDrag.side,
        radius: brushRadius,
      });
      if (smoothed.length) onEdgeEditMany(smoothed);
      return;
    }
    if (stripDrag.kind === "brush") {
      const brushed = brushEdges({
        positions: result.positions,
        pathIndices: result.pathIndices,
        edgeOffsets: result.edgeOffsets,
        centerIndex: stripDrag.centerIndex,
        side: stripDrag.side,
        targetOffset: hit.offset,
        radius: brushRadius,
      });
      if (brushed.length) onEdgeEditMany(brushed);
      return;
    }
    // 符号は中心線をまたげない（本画面と同じ規約。0 に潰れると径が 0 になる）。
    const clamped = stripDrag.side === "left" ? Math.min(-0.25, hit.offset) : Math.max(0.25, hit.offset);
    onEdgeEdit(stripDrag.pathIndex, stripDrag.side, clamped);
  };

  const endStripDrag = (ev: React.PointerEvent<HTMLCanvasElement>) => {
    if (stripDrag) ev.currentTarget.releasePointerCapture(ev.pointerId);
    setStripDrag(null);
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
      {/* ストレート像（§8.9）。本画面と同じ `result` を描き、同じコールバックへ書くので、
          どちらで直しても**必ず両方に反映される**（別々の状態を持たない）。 */}
      {straight && stripView ? (
        <div style={{ marginTop: 6 }}>
          <div style={stripLabel}>
            {t("xa.qca.straightTitle")}
            <span style={{ color: "#66788a" }}>{t("xa.qca.straightAxis")}</span>
          </div>
          <canvas
            ref={stripRef}
            data-testid="qca-straight-canvas"
            style={{
              width: stripView.dw,
              height: stripView.dh,
              borderRadius: 4,
              background: "#000",
              cursor: mode === "none" ? "default" : stripDrag ? "grabbing" : "crosshair",
              touchAction: "none",
            }}
            onPointerDown={onStripPointerDown}
            onPointerMove={onStripPointerMove}
            onPointerUp={endStripDrag}
            onPointerCancel={endStripDrag}
            onContextMenu={(e) => e.preventDefault()}
          />
        </div>
      ) : null}
      <div style={legend}>
        <span style={{ color: "#7fd1b9" }}>━ {t("xa.qca.legendCenterline")}</span>
        <span style={{ color: "#4fc3f7" }}>━ {t("xa.qca.legendEdges")}</span>
        <span style={{ color: "#e07a5f" }}>━ MLD</span>
        <span style={{ color: "#c08a2a" }}>
          ■ {t("xa.qca.legendEdited", { waypoints: String(waypoints.length), edges: String(editedCount) })}
        </span>
      </div>
      {/* 🔴 掴めない理由を出す。出さないと「ブラシが壊れた」と読まれる。 */}
      {!showEdges && mode !== "none" && mode !== "waypoint" ? (
        <div style={warn} data-testid="xa-qca-edges-hidden">{t("xa.qca.edgesHidden")}</div>
      ) : null}
      <div style={hint}>
        {mode === "waypoint"
          ? t("xa.qca.hintWaypoint")
          : mode === "edge"
            ? t("xa.qca.hintEdge")
            : mode === "brush"
              ? t("xa.qca.hintBrush")
              : mode === "smooth"
                ? t("xa.qca.hintSmooth")
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
const stripLabel: React.CSSProperties = {
  display: "flex",
  gap: 8,
  fontSize: 10,
  color: "#44586a",
  marginBottom: 2,
};
const warn: React.CSSProperties = { fontSize: 11, color: "#a5642a", marginTop: 4 };
