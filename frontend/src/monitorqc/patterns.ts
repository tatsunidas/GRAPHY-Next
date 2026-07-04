/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// モニター診断（目視 QC）テストパターンの手続き生成。
// AAPM TG18 のビットマップは著作権があるため、ここでは同等の目的を持つ
// パターンを Canvas で自前生成する（"TG18-QC 相当" 等）。
//
// すべてデバイスピクセル座標（w,h はデバイスピクセル）で描画する。呼び出し側で
// canvas.width = cssW*dpr にしておくこと。1px ラインペアを実ピクセルで出すため。
//
// 絶対輝度や GSDF 適合の定量評価は行わない（フォトメータ必須）。あくまで目視補助。

export interface PatternDef {
  id: string;
  /** ラベルの i18n キー。 */
  labelKey: string;
  /** 明るさ調整（↑↓）を受け付けるか（一様性パターンなど）。 */
  adjustable?: boolean;
}

// パネルの表示順。
export const PATTERNS: PatternDef[] = [
  { id: "qc", labelKey: "mqc.pat.qc" },
  { id: "rampSteps", labelKey: "mqc.pat.rampSteps" },
  { id: "rampSmooth", labelKey: "mqc.pat.rampSmooth" },
  { id: "nearBlack", labelKey: "mqc.pat.nearBlack" },
  { id: "nearWhite", labelKey: "mqc.pat.nearWhite" },
  { id: "uniformity", labelKey: "mqc.pat.uniformity", adjustable: true },
  { id: "linePairs", labelKey: "mqc.pat.linePairs" },
  { id: "grid", labelKey: "mqc.pat.grid" },
  { id: "colorBars", labelKey: "mqc.pat.colorBars" },
];

// 一様性パターンで巡回する階調（8bit DDL）。
export const UNIFORMITY_LEVELS = [0, 26, 51, 128, 204, 255];

type Ctx = CanvasRenderingContext2D;

function gray(v: number): string {
  const c = Math.max(0, Math.min(255, Math.round(v)));
  return `rgb(${c},${c},${c})`;
}

/** 中央寄せのラベルを描く（背景に応じて視認できる色を選ぶ）。 */
function label(ctx: Ctx, text: string, x: number, y: number, px: number, bg: number) {
  ctx.font = `${px}px sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = bg < 128 ? "#808080" : "#404040";
  ctx.fillText(text, x, y);
}

/** パターンを描画する。dpr はラベル等の可読サイズ調整に使う。 */
export function drawPattern(
  ctx: Ctx,
  id: string,
  w: number,
  h: number,
  dpr: number,
  level: number,
): void {
  ctx.clearRect(0, 0, w, h);
  const f = 12 * dpr; // 基本フォント px

  switch (id) {
    case "uniformity": {
      ctx.fillStyle = gray(level);
      ctx.fillRect(0, 0, w, h);
      label(ctx, `${Math.round((level / 255) * 100)}%  (DDL ${level})`, w / 2, h - f * 1.5, f, level);
      break;
    }

    case "rampSteps": {
      // 横方向 18 段階のグレースケール階段（GSDF/バンディング目視）。
      const n = 18;
      for (let i = 0; i < n; i++) {
        const v = Math.round((i / (n - 1)) * 255);
        const x = Math.floor((i * w) / n);
        const x2 = Math.floor(((i + 1) * w) / n);
        ctx.fillStyle = gray(v);
        ctx.fillRect(x, 0, x2 - x, h);
        label(ctx, String(v), (x + x2) / 2, h - f * 1.5, f, v);
      }
      break;
    }

    case "rampSmooth": {
      // 連続グラデーション（バンディング/量子化の確認）。
      const ggrad = ctx.createLinearGradient(0, 0, w, 0);
      ggrad.addColorStop(0, "#000");
      ggrad.addColorStop(1, "#fff");
      ctx.fillStyle = ggrad;
      ctx.fillRect(0, 0, w, h);
      break;
    }

    case "nearBlack": {
      // 黒地に低 DDL の四角（暗部の識別限界）。見えた数を数える。
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, w, h);
      drawPatchRow(ctx, w, h, dpr, [2, 4, 6, 8, 10, 12, 14, 16], 0);
      break;
    }

    case "nearWhite": {
      // 白地に高 DDL の四角（明部の識別限界）。
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, w, h);
      drawPatchRow(ctx, w, h, dpr, [253, 251, 249, 247, 245, 243, 241, 239], 255);
      break;
    }

    case "linePairs": {
      // 1px 明暗の縦・横ライン（Nyquist）＋ 中心の 2px/3px 周波数ブロック。
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, w, h);
      const bandH = Math.floor(h / 4);
      drawLineField(ctx, 0, 0, w, bandH, 1, true); // 縦 1px
      drawLineField(ctx, 0, bandH, w, bandH, 1, false); // 横 1px
      drawLineField(ctx, 0, bandH * 2, w, bandH, 2, true); // 縦 2px
      drawLineField(ctx, 0, bandH * 3, w, h - bandH * 3, 2, false); // 横 2px
      label(ctx, "1px V", w / 2, bandH - f, f, 0);
      label(ctx, "1px H", w / 2, bandH * 2 - f, f, 0);
      break;
    }

    case "grid": {
      // 幾何グリッド＋外周枠＋四隅/中心の円（歪み・アスペクト・画面端欠けの確認）。
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = Math.max(1, dpr);
      const step = Math.round(50 * dpr);
      ctx.beginPath();
      for (let x = 0; x <= w; x += step) {
        ctx.moveTo(x + 0.5, 0);
        ctx.lineTo(x + 0.5, h);
      }
      for (let y = 0; y <= h; y += step) {
        ctx.moveTo(0, y + 0.5);
        ctx.lineTo(w, y + 0.5);
      }
      ctx.stroke();
      // 外周 2px 枠（端の欠けを確認）。
      ctx.lineWidth = Math.max(2, 2 * dpr);
      ctx.strokeRect(dpr, dpr, w - 2 * dpr, h - 2 * dpr);
      // 円（アスペクト比＝真円になるか）。
      const r = Math.min(w, h) * 0.12;
      for (const [cx, cy] of [
        [w / 2, h / 2],
        [r * 1.4, r * 1.4],
        [w - r * 1.4, r * 1.4],
        [r * 1.4, h - r * 1.4],
        [w - r * 1.4, h - r * 1.4],
      ]) {
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.stroke();
      }
      break;
    }

    case "colorBars": {
      const cols = ["#ffffff", "#ffff00", "#00ffff", "#00ff00", "#ff00ff", "#ff0000", "#0000ff", "#000000"];
      for (let i = 0; i < cols.length; i++) {
        const x = Math.floor((i * w) / cols.length);
        const x2 = Math.floor(((i + 1) * w) / cols.length);
        ctx.fillStyle = cols[i];
        ctx.fillRect(x, 0, x2 - x, h);
      }
      break;
    }

    case "qc":
    default: {
      drawQc(ctx, w, h, dpr);
      break;
    }
  }
}

// 低/高 DDL パッチを 1 行に並べ、下にラベルを付ける。
function drawPatchRow(ctx: Ctx, w: number, h: number, dpr: number, ddls: number[], bg: number) {
  const n = ddls.length;
  const size = Math.min(w / (n * 1.6), h * 0.35);
  const gap = size * 0.6;
  const totalW = n * size + (n - 1) * gap;
  const x0 = (w - totalW) / 2;
  const y0 = (h - size) / 2;
  const f = 12 * dpr;
  for (let i = 0; i < n; i++) {
    const x = x0 + i * (size + gap);
    ctx.fillStyle = gray(ddls[i]);
    ctx.fillRect(x, y0, size, size);
    label(ctx, String(ddls[i]), x + size / 2, y0 + size + f * 1.5, f, bg);
  }
}

// 1〜2px の明暗ラインで領域を塗る（縦 or 横）。
function drawLineField(ctx: Ctx, x: number, y: number, w: number, h: number, lw: number, vertical: boolean) {
  ctx.fillStyle = "#fff";
  if (vertical) {
    for (let i = x; i < x + w; i += lw * 2) ctx.fillRect(i, y, lw, h);
  } else {
    for (let j = y; j < y + h; j += lw * 2) ctx.fillRect(x, j, w, lw);
  }
}

// TG18-QC 相当の総合パターン（自前）: 外枠＋16 段階階調枠＋中央低コントラスト＋四隅ラインペア。
function drawQc(ctx: Ctx, w: number, h: number, dpr: number) {
  ctx.fillStyle = gray(50);
  ctx.fillRect(0, 0, w, h);

  // 中央の 16 段階グレースケール階段（上下 2 帯）。
  const n = 16;
  const bandH = Math.round(h * 0.12);
  const topY = Math.round(h * 0.16);
  const botY = Math.round(h * 0.72);
  for (let i = 0; i < n; i++) {
    const v = Math.round((i / (n - 1)) * 255);
    const x = Math.floor((i * w) / n);
    const x2 = Math.floor(((i + 1) * w) / n);
    ctx.fillStyle = gray(v);
    ctx.fillRect(x, topY, x2 - x, bandH);
    ctx.fillStyle = gray(255 - v);
    ctx.fillRect(x, botY, x2 - x, bandH);
  }

  // 中央の低コントラストターゲット（背景 50%、±数 DDL の四角）。
  const cx = w / 2;
  const cy = h / 2;
  const bg = 128;
  ctx.fillStyle = gray(bg);
  ctx.fillRect(cx - w * 0.18, cy - h * 0.09, w * 0.36, h * 0.18);
  const s = Math.min(w, h) * 0.035;
  const deltas = [-8, -4, -2, 2, 4, 8];
  for (let i = 0; i < deltas.length; i++) {
    const x = cx - (deltas.length / 2) * (s * 1.5) + i * (s * 1.5);
    ctx.fillStyle = gray(bg + deltas[i]);
    ctx.fillRect(x, cy - s / 2, s, s);
  }

  // 0/5/95/100% パッチ（隅の暗部・明部識別）。
  const p = Math.min(w, h) * 0.09;
  const corners: Array<[number, number, number]> = [
    [dpr, dpr, 0],
    [w - p - dpr, dpr, 13], // ~5%
    [dpr, h - p - dpr, 242], // ~95%
    [w - p - dpr, h - p - dpr, 255],
  ];
  for (const [x, y, v] of corners) {
    ctx.fillStyle = gray(v);
    ctx.fillRect(x, y, p, p);
    ctx.strokeStyle = gray(v < 128 ? 128 : 90);
    ctx.lineWidth = Math.max(1, dpr);
    ctx.strokeRect(x + 0.5, y + 0.5, p, p);
  }

  // 外周 2px 枠（端の欠け確認）。
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = Math.max(2, 2 * dpr);
  ctx.strokeRect(dpr, dpr, w - 2 * dpr, h - 2 * dpr);

  // 四隅にラインペア（解像度）。
  const lpw = Math.round(w * 0.12);
  const lph = Math.round(h * 0.08);
  drawLineField(ctx, w / 2 - lpw / 2, topY - lph - 4 * dpr, lpw, lph, 1, true);
}
