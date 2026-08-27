/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * ビューポート右下に出す ROI 統計の一覧（`fw/roi-stats-design.md` §5.2）。
 *
 * <p>ROI が増えると脇表示は重なって読めなくなる。そこで隅に表を出すモードを用意する。
 * **表と ROI の対応が付かないと表の意味が無い**ので、ROI 側には `#n` のバッジだけを描く。
 * 番号は**そのスライス上の作成順**（Cornerstone の annotation state の並び）。
 */
import { annotation as csAnnotation } from "@cornerstonejs/tools";
import type { TFn } from "../i18n/i18n";
import { getRoiMaskMeta } from "./roiMaskStore";
import { getRoiStats } from "./roiStatsStore";
import { roiStatsSummary } from "./roiStatsText";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

export interface RoiStatsCornerRow {
  uid: string;
  /** 表示番号（1 始まり）。ROI 脇のバッジと突き合わせる鍵。 */
  index: number;
  /** ラベル（属性編集で付けた名前）。無ければ空。 */
  label: string;
  /** `12.4 mm²  43.2 ± 11.8 HU`。統計がまだ無ければ空。 */
  summary: string;
  /** バッジ位置（canvas CSS px）。画面外・変換不能なら null。 */
  cx: number | null;
  cy: number | null;
  selected: boolean;
}

/** ROI 中心の world 座標（頂点の平均）。幾何が無いシリーズでも world はあるので変換不要。 */
function centerWorld(ann: Any): number[] | null {
  const pts = (ann?.data?.contour?.polyline ?? ann?.data?.handles?.points ?? []) as number[][];
  if (!pts.length) return null;
  const out = [0, 0, 0];
  let n = 0;
  for (const p of pts) {
    if (!Number.isFinite(p?.[0]) || !Number.isFinite(p?.[1]) || !Number.isFinite(p?.[2])) continue;
    out[0] += p[0];
    out[1] += p[1];
    out[2] += p[2];
    n++;
  }
  if (!n) return null;
  return [out[0] / n, out[1] / n, out[2] / n];
}

/**
 * 表示中の imageId に乗っている ROI の一覧行を組み立てる。
 *
 * <p>統計がまだ計算されていない ROI も**行としては出す**（番号と対応が先に見えている方が良い）。
 * 値は次の掃除で埋まる。
 */
export function buildRoiStatsCornerRows(
  viewport: { worldToCanvas: (w: number[]) => number[] } | null,
  imageId: string | null,
  t: TFn,
): RoiStatsCornerRow[] {
  if (!imageId) return [];
  let all: Any[] = [];
  try {
    all = ((csAnnotation.state as Any).getAllAnnotations?.() ?? []) as Any[];
  } catch {
    return [];
  }
  let selected: Set<string>;
  try {
    selected = new Set(((csAnnotation.selection as Any).getAnnotationsSelected?.() ?? []) as string[]);
  } catch {
    selected = new Set();
  }

  const rows: RoiStatsCornerRow[] = [];
  for (const ann of all) {
    const uid = ann?.annotationUID as string | undefined;
    if (!uid || ann?.metadata?.referencedImageId !== imageId) continue;
    let visible = true;
    try {
      visible = (csAnnotation.visibility as Any).isAnnotationVisible?.(uid) ?? true;
    } catch {
      /* 既定 true */
    }
    if (!visible) continue;

    let cx: number | null = null;
    let cy: number | null = null;
    const w = centerWorld(ann);
    if (w && viewport) {
      try {
        const c = viewport.worldToCanvas(w);
        if (Number.isFinite(c?.[0]) && Number.isFinite(c?.[1])) {
          cx = c[0];
          cy = c[1];
        }
      } catch {
        /* 変換できなければバッジを出さない（行は出す） */
      }
    }
    rows.push({
      uid,
      index: rows.length + 1,
      label: getRoiMaskMeta(uid)?.label ?? "",
      summary: roiStatsSummary(getRoiStats(uid), t),
      cx,
      cy,
      selected: selected.has(uid),
    });
  }
  return rows;
}

/** 2 つの行配列が実質同じか（React の無駄な再レンダを避ける）。純関数。 */
export function sameCornerRows(a: RoiStatsCornerRow[], b: RoiStatsCornerRow[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (
      x.uid !== y.uid ||
      x.index !== y.index ||
      x.label !== y.label ||
      x.summary !== y.summary ||
      x.selected !== y.selected ||
      !nearlySame(x.cx, y.cx) ||
      !nearlySame(x.cy, y.cy)
    ) {
      return false;
    }
  }
  return true;
}

function nearlySame(a: number | null, b: number | null): boolean {
  if (a === null || b === null) return a === b;
  return Math.abs(a - b) < 0.5; // 0.5px 未満の揺れで再レンダしない
}
