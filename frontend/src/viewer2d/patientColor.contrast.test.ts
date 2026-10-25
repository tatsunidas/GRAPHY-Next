import { describe, expect, it } from "vitest";
import { PATIENT_PALETTE } from "./patientColor";

/** WCAG 2.x の相対輝度とコントラスト比。 */
function lum(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const TEXT = "#1a2530"; // ヘッダ・凡例の患者名（patientNameText）の色

describe("患者色のコントラスト（10〜12px の文字を読めること）", () => {
  it.each(PATIENT_PALETTE.map((c, i) => [i, c] as const))("色 %i: バッジ（solid 上の onSolid）が 4.5:1 以上", (_i, c) => {
    expect(contrast(c.onSolid, c.solid)).toBeGreaterThanOrEqual(4.5);
  });
  it.each(PATIENT_PALETTE.map((c, i) => [i, c] as const))("色 %i: 淡い背景（tint）上の患者名が 4.5:1 以上", (_i, c) => {
    expect(contrast(TEXT, c.tint)).toBeGreaterThanOrEqual(4.5);
  });
  it("検査器が負例で落ちる: 白地に薄い灰色は 4.5:1 に届かない", () => {
    expect(contrast("#ffffff", "#aaaaaa")).toBeLessThan(4.5);
  });
});
