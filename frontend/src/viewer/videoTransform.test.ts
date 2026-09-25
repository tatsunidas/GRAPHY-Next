import { describe as group, expect, it } from "vitest";
import {
  IDENTITY,
  cameraCenteredOn,
  canvasToWorld,
  centerWorld,
  describe,
  drawMatrix,
  fitCamera,
  flipH,
  flipV,
  rotate90,
  videoColorFilter,
  VIDEO_DEFAULT_VOI,
  worldToCanvas,
  type Orient,
} from "./videoTransform";

const canvas = { width: 800, height: 500 };
const VW = 640;
const VH = 480;

/** 取りうる向き 8 通り（回転 4 × 反転の有無）。 */
function allOrients(): Orient[] {
  const out: Orient[] = [];
  let m: Orient = IDENTITY;
  for (let i = 0; i < 4; i++) {
    out.push(m, flipH(m));
    m = rotate90(m);
  }
  return out;
}

const close = (a: readonly number[], b: readonly number[]) => {
  expect(a[0]).toBeCloseTo(b[0], 9);
  expect(a[1]).toBeCloseTo(b[1], 9);
};

group("videoTransform（動画の回転・反転・ズーム・パン）", () => {
  it("8 通りの向きは互いに異なり、回転 4 回・反転 2 回で元に戻る", () => {
    const keys = new Set(allOrients().map((m) => m.join(",")));
    expect(keys.size).toBe(8);
    let m: Orient = IDENTITY;
    for (let i = 0; i < 4; i++) m = rotate90(m);
    expect(m).toEqual(IDENTITY);
    expect(flipH(flipH(IDENTITY))).toEqual(IDENTITY);
    expect(flipV(flipV(IDENTITY))).toEqual(IDENTITY);
    // 上下反転 = 左右反転して 180° 回す
    expect(flipV(IDENTITY)).toEqual(rotate90(rotate90(flipH(IDENTITY))));
  });

  it("describe: 回転角と反転", () => {
    expect(describe(IDENTITY)).toEqual({ rotation: 0, flipped: false });
    expect(describe(rotate90(IDENTITY))).toEqual({ rotation: 90, flipped: false });
    expect(describe(rotate90(rotate90(rotate90(IDENTITY))))).toEqual({ rotation: 270, flipped: false });
    expect(describe(flipH(IDENTITY))).toEqual({ rotation: 0, flipped: true });
    expect(describe(flipV(IDENTITY)).flipped).toBe(true);
  });

  for (const m of allOrients()) {
    it(`向き [${m.join(",")}]: canvas → world → canvas が往復し、描画行列と注釈の写像が一致する`, () => {
      const cam = { parallelScale: 1.37, panWorld: [12.5, -40] as [number, number] };
      for (const w of [
        [0, 0],
        [VW, 0],
        [0, VH],
        [VW, VH],
        [123.4, 56.7],
      ]) {
        const p = worldToCanvas(w, cam, canvas, m);
        close(canvasToWorld(p, cam, canvas, m), w);
        // 描画（getTransform・dpr=2）で world を写すと、注釈の写像 × dpr と同じ点に来る
        const t = drawMatrix(cam, canvas, m, 2);
        close([t[0] * w[0] + t[2] * w[1] + t[4], t[1] * w[0] + t[3] * w[1] + t[5]], [p[0] * 2, p[1] * 2]);
      }
    });

    it(`向き [${m.join(",")}]: Fit で動画全体が canvas に収まり、中心が canvas の中心に来る`, () => {
      const cam = fitCamera(VW, VH, canvas, m);
      const corners = [
        [0, 0],
        [VW, 0],
        [0, VH],
        [VW, VH],
      ].map((w) => worldToCanvas(w, cam, canvas, m));
      for (const [x, y] of corners) {
        expect(x).toBeGreaterThanOrEqual(-1e-9);
        expect(x).toBeLessThanOrEqual(canvas.width + 1e-9);
        expect(y).toBeGreaterThanOrEqual(-1e-9);
        expect(y).toBeLessThanOrEqual(canvas.height + 1e-9);
      }
      // どちらかの辺はぴったり（余白は片方の軸だけ）
      const xs = corners.map((c) => c[0]);
      const ys = corners.map((c) => c[1]);
      const spanX = Math.max(...xs) - Math.min(...xs);
      const spanY = Math.max(...ys) - Math.min(...ys);
      expect(Math.max(spanX / canvas.width, spanY / canvas.height)).toBeCloseTo(1, 9);
      close(worldToCanvas([VW / 2, VH / 2], cam, canvas, m), [canvas.width / 2, canvas.height / 2]);
    });
  }

  it("回転すると動画の角が画面上で時計回りに移る（左上 → 右上）", () => {
    const m = rotate90(IDENTITY);
    const cam = fitCamera(VW, VH, canvas, m);
    const [x, y] = worldToCanvas([0, 0], cam, canvas, m);
    expect(x).toBeGreaterThan(canvas.width / 2);
    expect(y).toBeLessThan(canvas.height / 2);
  });

  it("左右反転すると左上の角が右上へ移る", () => {
    const m = flipH(IDENTITY);
    const cam = fitCamera(VW, VH, canvas, m);
    const [x, y] = worldToCanvas([0, 0], cam, canvas, m);
    expect(x).toBeGreaterThan(canvas.width / 2);
    expect(y).toBeLessThan(canvas.height / 2);
  });

  it("ズームは中心の world 点を保つ（回転していても）", () => {
    const m = rotate90(flipH(IDENTITY));
    const cam = fitCamera(VW, VH, canvas, m);
    const f = centerWorld(cam, canvas);
    const zoomed = cameraCenteredOn(f, cam.parallelScale * 2, canvas);
    close(centerWorld(zoomed, canvas), f);
    close(worldToCanvas(f, zoomed, canvas, m), [canvas.width / 2, canvas.height / 2]);
  });

  it("パン: 画面上で右へずらすと、回転していても絵が右へ動く（PanTool と同じ手順）", () => {
    for (const m of allOrients()) {
      const cam = fitCamera(VW, VH, canvas, m);
      const probe = [100, 50];
      const before = worldToCanvas(probe, cam, canvas, m);
      // PanTool: 画面上のずれを world に直し、焦点をその分だけ逆へ動かす
      const w0 = canvasToWorld([400, 250], cam, canvas, m);
      const w1 = canvasToWorld([430, 250], cam, canvas, m);
      const focal = centerWorld(cam, canvas);
      const moved = cameraCenteredOn([focal[0] - (w1[0] - w0[0]), focal[1] - (w1[1] - w0[1])], cam.parallelScale, canvas);
      const after = worldToCanvas(probe, moved, canvas, m);
      close([after[0] - before[0], after[1] - before[1]], [30, 0]);
    }
  });
});

group("videoColorFilter（動画の WW/WL・階調反転）", () => {
  const matrixOf = (css: string) => {
    const svg = decodeURIComponent(css.slice('url("data:image/svg+xml,'.length, -'#f")'.length));
    return svg.match(/values="([^"]+)"/)![1].split(" ").map(Number);
  };
  /** 画素値 x（0..255）に行列を当てた結果（0..255、クリップ）。 */
  const out = (css: string, x: number) => {
    const m = matrixOf(css);
    return Math.min(255, Math.max(0, (m[0] * (x / 255) + m[4]) * 255));
  };

  it("素通し（既定の窓・反転なし）は空文字", () => {
    expect(videoColorFilter(null, false)).toBe("");
    expect(videoColorFilter(VIDEO_DEFAULT_VOI, false)).toBe("");
  });

  it("窓: lower → 黒、upper → 白、中央 → 中間", () => {
    const css = videoColorFilter({ lower: 64, upper: 192 }, false);
    expect(css).toContain("sRGB");
    expect(out(css, 64)).toBeCloseTo(0, 3);
    expect(out(css, 192)).toBeCloseTo(255, 3);
    expect(out(css, 128)).toBeCloseTo(127.5, 3);
    expect(out(css, 10)).toBe(0);
    expect(out(css, 250)).toBe(255);
  });

  it("階調反転: 既定の窓で 255 − x", () => {
    const css = videoColorFilter(null, true);
    for (const x of [0, 40, 128, 255]) expect(out(css, x)).toBeCloseTo(255 - x, 3);
  });

  it("窓 ＋ 階調反転", () => {
    const css = videoColorFilter({ lower: 64, upper: 192 }, true);
    expect(out(css, 64)).toBeCloseTo(255, 3);
    expect(out(css, 192)).toBeCloseTo(0, 3);
  });
});
