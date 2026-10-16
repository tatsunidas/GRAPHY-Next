import { describe, it, expect } from "vitest";
import {
  floodRegion,
  offsets2D,
  offsets3D,
  acceptTolerance,
  acceptGe,
  acceptLe,
  acceptRange,
  inRange,
  makeValueReader,
} from "./wandFlood";

// ---- 旧実装（wandTool.ts の runWand 内ループ）の写し。floodRegion との一致確認用。 ----
function legacy2D(px: ArrayLike<number>, cols: number, rows: number, sx: number, sy: number, seedValue: number, th: number, conn: number, max: number): Set<number> {
  const out = new Set<number>();
  const offs = offsets2D(conn);
  const visited = new Uint8Array(cols * rows);
  const stack: number[] = [sy * cols + sx];
  visited[stack[0]] = 1;
  let count = 0;
  while (stack.length && count < max) {
    const i = stack.pop() as number;
    if (!(Math.abs(px[i] - seedValue) <= th)) continue;
    out.add(i);
    count++;
    const y = Math.floor(i / cols);
    const x = i - y * cols;
    for (const [dx, dy] of offs) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
      const ni = ny * cols + nx;
      if (!visited[ni]) { visited[ni] = 1; stack.push(ni); }
    }
  }
  return out;
}
function legacy3D(slices: ArrayLike<number>[], cols: number, rows: number, sx: number, sy: number, sz: number, seedValue: number, th: number, conn: number, max: number): Set<number> {
  const out = new Set<number>();
  const sliceLen = cols * rows;
  const depth = slices.length;
  const offs = offsets3D(conn);
  const visited = new Set<number>();
  const startG = sz * sliceLen + (sy * cols + sx);
  const stack: number[] = [startG];
  visited.add(startG);
  let count = 0;
  while (stack.length && count < max) {
    const g = stack.pop() as number;
    const z = Math.floor(g / sliceLen);
    const rem = g - z * sliceLen;
    const y = Math.floor(rem / cols);
    const x = rem - y * cols;
    if (!(Math.abs(slices[z][rem] - seedValue) <= th)) continue;
    out.add(g);
    count++;
    for (const [dx, dy, dz] of offs) {
      const nx = x + dx, ny = y + dy, nz = z + dz;
      if (nx < 0 || ny < 0 || nx >= cols || ny >= rows || nz < 0 || nz >= depth) continue;
      const ng = nz * sliceLen + (ny * cols + nx);
      if (!visited.has(ng)) { visited.add(ng); stack.push(ng); }
    }
  }
  return out;
}

// 決定的な擬似乱数（テストの再現性）。
function lcg(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

describe("floodRegion: 旧実装との一致（許容差）", () => {
  const cols = 14, rows = 12, depth = 7;
  const rnd = lcg(12345);
  const slices: Float32Array[] = [];
  for (let z = 0; z < depth; z++) {
    const a = new Float32Array(cols * rows);
    for (let i = 0; i < a.length; i++) a[i] = Math.floor(rnd() * 10); // 0..9 の雑音（斜め接触が多数できる）
    slices.push(a);
  }
  const seed = { x: 6, y: 5, z: 3 };
  const seedVal = slices[3][5 * cols + 6];

  for (const conn of [4, 8]) {
    for (const th of [0, 2, 4]) {
      it(`2D 連結 ${conn} 許容差 ${th}`, () => {
        const px = slices[3];
        const exp = legacy2D(px, cols, rows, seed.x, seed.y, seedVal, th, conn, 4_000_000);
        const r = floodRegion((_z, i) => px[i], { cols, rows, depth: 1 }, { x: seed.x, y: seed.y, z: 0 }, acceptTolerance(seedVal, th), offsets2D(conn), 4_000_000);
        expect(new Set(r.indices)).toEqual(exp);
        expect(r.indices.length).toBe(exp.size);
        expect(r.truncated).toBe(false);
      });
    }
  }
  for (const conn of [6, 8, 12, 26]) {
    for (const th of [1, 3]) {
      it(`3D 連結 ${conn} 許容差 ${th}`, () => {
        const exp = legacy3D(slices, cols, rows, seed.x, seed.y, seed.z, seedVal, th, conn, 4_000_000);
        const r = floodRegion((z, i) => slices[z][i], { cols, rows, depth }, seed, acceptTolerance(seedVal, th), offsets3D(conn), 4_000_000);
        expect(new Set(r.indices)).toEqual(exp);
        expect(r.indices.length).toBe(exp.size);
      });
    }
  }
  it("上限で止まるときも旧実装と同じ集合（走査順が同じ）", () => {
    const exp = legacy3D(slices, cols, rows, seed.x, seed.y, seed.z, seedVal, 9, 6, 50);
    const r = floodRegion((z, i) => slices[z][i], { cols, rows, depth }, seed, acceptTolerance(seedVal, 9), offsets3D(6), 50);
    expect(new Set(r.indices)).toEqual(exp);
    expect(r.truncated).toBe(true);
  });

  it("斜めにだけ触れるボクセルは連結 4 では入らず 8 では入る（連結の差が出る）", () => {
    // 3x3: 中央と右上だけ 1
    const px = [0, 0, 1, 0, 1, 0, 0, 0, 0];
    const run = (conn: number) =>
      floodRegion((_z, i) => px[i], { cols: 3, rows: 3, depth: 1 }, { x: 1, y: 1, z: 0 }, acceptTolerance(1, 0), offsets2D(conn), 100).indices.length;
    expect(run(4)).toBe(1);
    expect(run(8)).toBe(2);
  });
});

describe("floodRegion: 校正値での判定（以上／以下／範囲）", () => {
  // Slope 2 / Intercept -1024 の生値 = (HU+1024)/2。
  const cols = 20, rows = 10, depth = 6;
  const sliceLen = cols * rows;
  const raw = (hu: number) => (hu + 1024) / 2;
  const make = () => {
    const vols: Float32Array[] = [];
    for (let z = 0; z < depth; z++) vols.push(new Float32Array(sliceLen).fill(raw(0)));
    return vols;
  };
  const box = (vols: Float32Array[], x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, hu: number) => {
    for (let z = z0; z <= z1; z++)
      for (let y = y0; y <= y1; y++)
        for (let x = x0; x <= x1; x++) vols[z][y * cols + x] = raw(hu);
  };
  const vols = make();
  box(vols, 1, 3, 2, 4, 1, 3, 200); // A: 3x3x3 = 27
  box(vols, 4, 8, 3, 3, 2, 2, 200); // 橋: 5x1x1 = 5（A の x=3 と接する）
  box(vols, 9, 11, 2, 4, 1, 3, 200); // B: 27
  box(vols, 15, 17, 5, 7, 1, 2, 200); // C（離れている）: 3x3x2 = 18
  const scale = 2, offset = -1024;
  const readCal = (z: number, i: number) => vols[z][i] * scale + offset;
  const readRaw = (z: number, i: number) => vols[z][i];
  const dims = { cols, rows, depth };
  const seedA = { x: 2, y: 3, z: 2 };

  it("以上 100 HU: A+橋+B だけが入り、数は寸法から出した 59 と一致、C は入らない", () => {
    const r = floodRegion(readCal, dims, seedA, acceptGe(100), offsets3D(6), 4_000_000);
    expect(r.indices.length).toBe(27 + 5 + 27);
    expect(r.seedRejected).toBe(false);
    expect(r.truncated).toBe(false);
    const cIdx = 1 * sliceLen + 6 * cols + 16;
    expect(r.indices).not.toContain(cIdx);
  });
  it("負例: 校正せず生値で範囲 100〜300 を判定すると 1 ボクセルも塗れない（生値 612 は範囲外）", () => {
    const r = floodRegion(readRaw, dims, seedA, acceptRange(100, 300), offsets3D(6), 4_000_000);
    expect(r.indices.length).toBe(0);
    expect(r.seedRejected).toBe(true);
  });
  it("負例: 校正せず生値で「以上 100」を判定すると背景（生値 512）まで全域に広がり、校正値の結果と一致しない", () => {
    const r = floodRegion(readRaw, dims, seedA, acceptGe(100), offsets3D(6), 4_000_000);
    expect(r.indices.length).not.toBe(27 + 5 + 27);
    expect(r.indices.length).toBe(depth * sliceLen);
  });
  it("背景（0 HU）をシードに「以下 -100 HU」を押すと条件外", () => {
    const bg = { x: 0, y: 0, z: 0 };
    const r = floodRegion(readCal, dims, bg, acceptLe(-100), offsets3D(6), 4_000_000);
    expect(r.seedRejected).toBe(true);
    expect(r.indices.length).toBe(0);
  });
  it("以下 50 HU: 背景シードから A・橋・B・C 以外（背景）が入る", () => {
    const r = floodRegion(readCal, dims, { x: 0, y: 0, z: 0 }, acceptLe(50), offsets3D(6), 4_000_000);
    expect(r.indices.length).toBe(depth * sliceLen - (27 + 5 + 27 + 18));
  });
  it("範囲 100〜300 HU は「以上 100」と同じ領域（200 HU が範囲内）", () => {
    const r = floodRegion(readCal, dims, seedA, acceptRange(100, 300), offsets3D(6), 4_000_000);
    expect(r.indices.length).toBe(59);
    const r2 = floodRegion(readCal, dims, seedA, acceptRange(250, 300), offsets3D(6), 4_000_000);
    expect(r2.seedRejected).toBe(true);
  });
  it("2D: シードスライスだけで A の断面 9 + 橋 5 + B の断面 9 = 23（連結 4）", () => {
    const z = 2;
    const r = floodRegion((_z, i) => readCal(z, i), { cols, rows, depth: 1 }, { x: 2, y: 3, z: 0 }, acceptGe(100), offsets2D(4), 4_000_000);
    expect(r.indices.length).toBe(9 + 5 + 9);
  });
});

describe("floodRegion: スライスごとに係数が違う（PET 相当）", () => {
  it("校正値の判定と生値の判定で結果が分かれる", () => {
    const cols = 4, rows = 1, depth = 3;
    // 全スライスの校正値は 10。生値は slope 1,2,5 に合わせ 10,5,2。
    const slopes = [1, 2, 5];
    const rawV = [10, 5, 2];
    const slices = rawV.map((v) => new Float32Array(cols * rows).fill(v));
    const dims = { cols, rows, depth };
    const seed = { x: 0, y: 0, z: 0 };
    const cal = floodRegion((z, i) => slices[z][i] * slopes[z], dims, seed, acceptRange(10, 10), offsets3D(6), 1000);
    expect(cal.indices.length).toBe(cols * rows * depth);
    const raw = floodRegion((z, i) => slices[z][i], dims, seed, acceptRange(10, 10), offsets3D(6), 1000);
    expect(raw.indices.length).toBe(cols * rows); // シードスライスだけ
  });
});

describe("floodRegion: シード条件外・打ち切り・範囲の端", () => {
  const dims = { cols: 5, rows: 5, depth: 1 };
  it("シードが条件外なら何も塗らず seedRejected", () => {
    const r = floodRegion(() => 0, dims, { x: 2, y: 2, z: 0 }, acceptGe(100), offsets2D(8), 100);
    expect(r).toEqual({ indices: [], truncated: false, seedRejected: true });
  });
  it("read が null（スライス無し）のシードも条件外", () => {
    const r = floodRegion(() => null, dims, { x: 2, y: 2, z: 0 }, acceptGe(0), offsets2D(8), 100);
    expect(r.seedRejected).toBe(true);
  });
  it("上限を小さくすると truncated で、途中までの結果は残る", () => {
    const r = floodRegion(() => 1, dims, { x: 2, y: 2, z: 0 }, acceptGe(1), offsets2D(4), 10);
    expect(r.truncated).toBe(true);
    expect(r.indices.length).toBe(10);
  });
  it("負例: ちょうど上限で領域が尽きるときは truncated にしない", () => {
    const r = floodRegion(() => 1, dims, { x: 2, y: 2, z: 0 }, acceptGe(1), offsets2D(4), 25);
    expect(r.indices.length).toBe(25);
    expect(r.truncated).toBe(false);
  });
  it("負例: 上限に達しても残りの候補が全て条件外なら truncated にしない", () => {
    // 3 ボクセルの帯（x=1..3 の行）が値 1、他は 0。上限 3 で尽きる。
    const read = (_z: number, i: number) => (Math.floor(i / 5) === 2 && i % 5 >= 1 && i % 5 <= 3 ? 1 : 0);
    const r = floodRegion(read, dims, { x: 2, y: 2, z: 0 }, acceptGe(1), offsets2D(4), 3);
    expect(r.indices.length).toBe(3);
    expect(r.truncated).toBe(false);
  });
  it("範囲の両端は含み、端の外側（±ε）は含まない", () => {
    const eps = 1e-6;
    expect(inRange(100, 100, 200)).toBe(true);
    expect(inRange(200, 100, 200)).toBe(true);
    expect(inRange(100 - eps, 100, 200)).toBe(false);
    expect(inRange(200 + eps, 100, 200)).toBe(false);
    const vals = [100 - eps, 100, 150, 200, 200 + eps];
    const r = floodRegion((_z, i) => vals[i], { cols: 5, rows: 1, depth: 1 }, { x: 2, y: 0, z: 0 }, acceptRange(100, 200), offsets2D(4), 100);
    expect(r.indices.sort()).toEqual([1, 2, 3]);
  });
});

describe("makeValueReader（判定値）", () => {
  it("1 チャネル: Rescale ありは px*slope+intercept", () => {
    const r = makeValueReader(Int16Array.from([0, 1000, 2048]), 1, 1, -1024);
    expect([r(0), r(1), r(2)]).toEqual([-1024, -24, 1024]);
  });
  it("1 チャネル: Rescale のタグなし（{1,0}）は保存値そのもの", () => {
    const r = makeValueReader(Uint8Array.from([0, 37, 255]), 1, 1, 0);
    expect([r(0), r(1), r(2)]).toEqual([0, 37, 255]);
  });
  it("1 チャネル: slope≠1（PET の SUV 合成など）も係数どおり", () => {
    const r = makeValueReader(Uint16Array.from([100, 200]), 1, 0.01, 0);
    expect(r(0)).toBeCloseTo(1);
    expect(r(1)).toBeCloseTo(2);
  });
  it("カラー（RGB）は画素ごとの輝度（BT.601）で、校正は掛けない", () => {
    // 画素0=純赤、画素1=純緑、画素2=白
    const px = Uint8Array.from([255, 0, 0, 0, 255, 0, 255, 255, 255]);
    const r = makeValueReader(px, 3, 2, 100);
    expect(r(0)).toBeCloseTo(0.299 * 255);
    expect(r(1)).toBeCloseTo(0.587 * 255);
    expect(r(2)).toBeCloseTo(255);
    // 負例: RGB を 1 チャネルとして読む（旧実装の px[i]）と画素1は G でなく R/G/B の並びの 2 番目＝0 になる
    expect(px[1]).not.toBeCloseTo(r(1));
  });
  it("RGBA（4 チャネル）も輝度", () => {
    const r = makeValueReader(Uint8Array.from([0, 0, 0, 255, 0, 0, 255, 255]), 4, 1, 0);
    expect(r(0)).toBe(0);
    expect(r(1)).toBeCloseTo(0.114 * 255);
  });
});
