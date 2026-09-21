import { describe, expect, it } from "vitest";
import {
  averageFrames,
  backgroundRms,
  blurSeparable,
  contrastDropSignal,
  contrastSignal,
  estimateShift,
  needsLogTransform,
  parseFrameNumbers,
  pickMaskFrames,
  shiftBilinear,
  subtractFrames,
  warpRigid,
} from "./dsa";

/** w×h の画像を作る（f(x,y) で値を決める）。 */
function img(w: number, h: number, f: (x: number, y: number) => number): Float32Array {
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[y * w + x] = f(x, y);
  return out;
}

describe("needsLogTransform — PixelIntensityRelationship", () => {
  it("LIN のときだけ対数変換が要る", () => {
    expect(needsLogTransform("LIN")).toBe(true);
    expect(needsLogTransform("lin")).toBe(true);
    expect(needsLogTransform("LOG")).toBe(false);
  });

  it("記載が無ければ LOG とみなす（XA の慣行）", () => {
    expect(needsLogTransform(null)).toBe(false);
    expect(needsLogTransform(undefined)).toBe(false);
    expect(needsLogTransform("")).toBe(false);
  });
});

describe("averageFrames", () => {
  it("画素ごとの平均", () => {
    const a = Float32Array.from([0, 10, 20]);
    const b = Float32Array.from([10, 20, 30]);
    expect(Array.from(averageFrames([a, b])!)).toEqual([5, 15, 25]);
  });

  it("サイズが違えば null（黙って壊れた画像を作らない）", () => {
    expect(averageFrames([Float32Array.from([1]), Float32Array.from([1, 2])])).toBeNull();
    expect(averageFrames([])).toBeNull();
  });
});

describe("shiftBilinear — サブピクセル平行移動", () => {
  it("整数シフトは値をそのまま移す", () => {
    const src = img(4, 1, (x) => x);          // [0,1,2,3]
    const out = shiftBilinear(src, 4, 1, 1, 0); // 右へ 1
    expect(Array.from(out)).toEqual([0, 0, 1, 2]); // 左端は clamp
  });

  it("0.5px シフトは中間値になる（最近傍で妥協しない）", () => {
    const src = img(4, 1, (x) => x * 10);       // [0,10,20,30]
    const out = shiftBilinear(src, 4, 1, 0.5, 0);
    expect(out[2]).toBeCloseTo(15, 5);
    expect(out[3]).toBeCloseTo(25, 5);
  });

  it("範囲外は端の値で埋める（黒縁を作らない）", () => {
    const src = img(3, 1, () => 7);
    const out = shiftBilinear(src, 3, 1, 2, 0);
    expect(Array.from(out)).toEqual([7, 7, 7]);
  });

  it("シフト 0 は恒等", () => {
    const src = img(3, 3, (x, y) => x * y);
    expect(Array.from(shiftBilinear(src, 3, 3, 0, 0))).toEqual(Array.from(src));
  });

  it("縦方向も同じ規約（dy 正で下へ）", () => {
    const src = img(1, 3, (_x, y) => y);
    expect(Array.from(shiftBilinear(src, 1, 3, 0, 1))).toEqual([0, 0, 1]);
  });
});

describe("warpRigid — 回転つきの剛体ワープ", () => {
  it("★ 回転 0 は shiftBilinear と 1 ビットも変わらない（既存の数値を動かさない）", () => {
    const w = 24, h = 24;
    const src = img(w, h, (x, y) => Math.sin(x / 3) * 40 + Math.cos(y / 5) * 25);
    for (const [dx, dy] of [[0, 0], [2, -3], [1.4, -0.6]] as Array<[number, number]>) {
      expect(Array.from(warpRigid(src, w, h, dx, dy, 0))).toEqual(
        Array.from(shiftBilinear(src, w, h, dx, dy)),
      );
    }
  });

  it("360 度回しても元に戻る", () => {
    const w = 16, h = 16;
    const src = img(w, h, (x, y) => x * 3 + y);
    const out = warpRigid(src, w, h, 0, 0, 360);
    for (let i = 0; i < src.length; i++) expect(out[i]).toBeCloseTo(src[i], 3);
  });

  it("中心まわりに回す（中心の画素は動かない）", () => {
    const w = 33, h = 33;
    // 中心だけ明るい点。回しても中心に残る。
    const src = img(w, h, (x, y) => (x === 16 && y === 16 ? 100 : 0));
    const out = warpRigid(src, w, h, 0, 0, 30);
    expect(out[16 * w + 16]).toBeCloseTo(100, 3);
  });

  it("90 度回すと (x,y) が (y,x) 相当へ移る（順方向の定義の確認）", () => {
    const w = 9, h = 9;
    const src = img(w, h, () => 0);
    src[2 * w + 6] = 100; // 中心 (4,4) から見て (+2, -2)
    const out = warpRigid(src, w, h, 0, 0, 90);
    // 反時計回り／時計回りの規約ごと固定する: (+2,-2) → (+2,+2)
    expect(out[6 * w + 6]).toBeCloseTo(100, 3);
  });

  it("回転と平行移動は「回転 → 平行移動」の順", () => {
    const w = 21, h = 21;
    const src = img(w, h, () => 0);
    src[10 * w + 10] = 100; // ちょうど中心
    const out = warpRigid(src, w, h, 3, -2, 45);
    // 中心の点は回転で動かないので、平行移動ぶんだけ動く。
    expect(out[(10 - 2) * w + (10 + 3)]).toBeCloseTo(100, 3);
  });
});

describe("subtractFrames — 差分の数式", () => {
  it("LOG（線形差分）: 血管（暗い＝値が小さい）は正になる", () => {
    const mask = img(2, 1, () => 100);
    const live = img(2, 1, (x) => (x === 0 ? 40 : 100)); // x=0 に造影
    const d = subtractFrames(mask, live, 2, 1, { dx: 0, dy: 0, logarithmic: false })!;
    expect(d[0]).toBe(60);
    expect(d[1]).toBe(0);
  });

  it("LIN: 対数を取ってから引く", () => {
    const mask = img(1, 1, () => 100);
    const live = img(1, 1, () => 10);
    const d = subtractFrames(mask, live, 1, 1, { dx: 0, dy: 0, logarithmic: true })!;
    expect(d[0]).toBeCloseTo(Math.log(100.001) - Math.log(10.001), 5);
  });

  it("0 でも対数が発散しない", () => {
    const d = subtractFrames(img(1, 1, () => 0), img(1, 1, () => 0), 1, 1, {
      dx: 0,
      dy: 0,
      logarithmic: true,
    })!;
    expect(Number.isFinite(d[0])).toBe(true);
    expect(d[0]).toBe(0);
  });

  it("マスク側だけをシフトする（体動補正）", () => {
    const mask = img(4, 1, (x) => (x === 1 ? 100 : 0));
    const live = img(4, 1, (x) => (x === 2 ? 100 : 0));
    // マスクを右に 1 ずらせば構造が重なり、差分は 0 になる。
    const d = subtractFrames(mask, live, 4, 1, { dx: 1, dy: 0, logarithmic: false })!;
    expect(d[2]).toBe(0);
  });

  it("サイズ不一致は null", () => {
    expect(subtractFrames(img(2, 1, () => 0), img(3, 1, () => 0), 2, 1, { dx: 0, dy: 0, logarithmic: false })).toBeNull();
  });
});

describe("pickMaskFrames — マスクの自動選択", () => {
  it("造影到達の手前をマスクにする", () => {
    // 0..5 は基線（100 付近）、6 から造影で暗くなる。
    const mean = [100, 100, 101, 99, 100, 100, 70, 50, 45, 60];
    const p = pickMaskFrames(mean);
    expect(p.onset).toBe(6);
    expect(p.frames).toEqual([1, 2, 3, 4, 5]);
  });

  it("マスク枚数の上限を守る", () => {
    const mean = [100, 100, 100, 100, 100, 100, 100, 100, 20];
    const p = pickMaskFrames(mean, 3);
    expect(p.frames).toHaveLength(3);
    expect(p.frames[p.frames.length - 1]).toBe(p.onset! - 1);
  });

  it("造影が見つからなければ**先頭**を使う（onset は null）", () => {
    // 末尾を既定にすると、外したときに「造影が乗ったフレームをマスクにする」事故になる。
    const mean = [100, 100, 100, 100, 100, 100];
    const p = pickMaskFrames(mean);
    expect(p.onset).toBeNull();
    expect(p.frames).toEqual([0, 1, 2, 3, 4]);
  });

  it("基線が完全に平坦でも量子化ノイズで誤検出しない", () => {
    // 全フレーム同値 + 1 だけ 0.1% の揺らぎ。閾値の下限（平均の 0.5%）で弾く。
    const mean = [1000, 1000, 1000, 1000, 1000, 1001, 1000, 1000];
    expect(pickMaskFrames(mean).onset).toBeNull();
  });

  it("空・1 フレームでも壊れない", () => {
    expect(pickMaskFrames([]).frames).toEqual([]);
    expect(pickMaskFrames([5]).frames).toEqual([0]);
  });
});

describe("contrastSignal — 造影到達の検出信号", () => {
  it("低パーセンタイルを返す（暗部のテール）", () => {
    const v = Float32Array.from([100, 90, 80, 70, 60, 50, 40, 30, 20, 10]);
    expect(contrastSignal(v, 0.02, 1)).toBe(10);
    expect(contrastSignal(v, 0.5, 1)).toBe(60);
  });

  it("★造影が画面の一部にしか無くても反応する（全体平均は反応しない）", () => {
    const n = 10_000;
    const before = new Float32Array(n).fill(200);
    const after = Float32Array.from(before);
    // 画面の 3% だけが造影で暗くなる（冠動脈造影の実際に近い割合）。
    for (let i = 0; i < n * 0.03; i++) after[i] = 40;
    let sb = 0, sa = 0;
    for (let i = 0; i < n; i++) { sb += before[i]; sa += after[i]; }
    // 全体平均は 3% 未満しか動かない（基線のばらつきに埋もれる）。
    expect(Math.abs(sa - sb) / sb).toBeLessThan(0.03);
    // 低パーセンタイルははっきり動く。
    expect(contrastSignal(before, 0.02, 1)).toBe(200);
    expect(contrastSignal(after, 0.02, 1)).toBe(40);
  });

  it("★コリメータの黒縁（値 0）に支配されない", () => {
    // 実データでは画面の 20% が正確に 0（コリメータ外）。除外しないと低パーセンタイルが
    // 全フレームで 0 になり、造影の到達をまったく検出できなくなる。
    const n = 1000;
    const v = new Float32Array(n);
    for (let i = 0; i < n; i++) v[i] = i < n * 0.2 ? 0 : 100; // 20% が黒縁
    expect(contrastSignal(v, 0.02, 1)).toBe(100);
  });

  it("全部 0 でも壊れない", () => {
    expect(contrastSignal(new Float32Array(100), 0.02, 1)).toBe(0);
  });

  it("空でも壊れない", () => {
    expect(contrastSignal(new Float32Array(0))).toBe(0);
  });
});

describe("backgroundRms / estimateShift — ピクセルシフトの評価と自動推定", () => {
  it("完全に一致していれば背景 RMS は 0", () => {
    expect(backgroundRms(new Float32Array(100))).toBe(0);
  });

  it("血管（大きな値の少数画素）は RMS から除外される", () => {
    // 背景 0 に、10% だけ大きな値（血管相当）。
    const d = new Float32Array(100);
    for (let i = 0; i < 10; i++) d[i] = 1000;
    expect(backgroundRms(d, 0.1)).toBeCloseTo(0, 6);
  });

  it("★既知のズレを取り戻せる（整数シフト）", () => {
    const w = 24;
    const h = 24;
    // 背景に構造（骨相当）を置き、live はそれが (2,-1) ずれたもの。
    const pattern = (x: number, y: number) => Math.sin(x * 0.7) * 40 + Math.cos(y * 0.5) * 30 + 100;
    const mask = img(w, h, pattern);
    const live = img(w, h, (x, y) => pattern(x - 2, y + 1));
    const best = estimateShift(mask, live, w, h, false, 4);
    expect(best.dx).toBeCloseTo(2, 1);
    expect(best.dy).toBeCloseTo(-1, 1);
  });

  it("★サブピクセルのズレも 0.2px 以内で当てる", () => {
    const w = 24;
    const h = 24;
    // 横方向だけの縞（サブピクセルの当て込みを x に絞って評価する）。
    const pattern = (x: number) => Math.sin(x * 0.6) * 50 + 120;
    const mask = img(w, h, pattern);
    const live = img(w, h, (x) => pattern(x - 1.5));
    const best = estimateShift(mask, live, w, h, false, 3);
    expect(Math.abs(best.dx - 1.5)).toBeLessThan(0.2);
  });

  // 🔴 GNBP-XA-2 で実測した壊れ方。双線形補間はノイズを平滑化するので、**端数のシフトほど
  //    残差が下がる**。整数の体動では真値が平滑化されないぶん、ずれた端数の位置が勝ってしまう
  //    （実測 0.361px ずれ）。探索の前に両方をぼかすことで消える。
  it("★ノイズがあっても整数の体動を端数へ引き込まれずに当てる", () => {
    const w = 64;
    const h = 64;
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5) * 60;
    const pattern = (x: number, y: number) =>
      Math.sin(x * 0.5) * 60 + Math.cos(y * 0.4) * 50 + Math.sin((x + y) * 0.2) * 40 + 600;
    const mask = img(w, h, (x, y) => pattern(x, y) + rnd());
    const live = img(w, h, (x, y) => pattern(x - 2, y + 3) + rnd());
    const best = estimateShift(mask, live, w, h, false, 5);
    expect(Math.hypot(best.dx - 2, best.dy + 3)).toBeLessThan(0.2);
  });

  it("★4px を超える体動も取れる（既定の探索半径は 8px）", () => {
    const w = 64;
    const h = 64;
    const pattern = (x: number, y: number) => Math.sin(x * 0.35) * 60 + Math.cos(y * 0.3) * 50 + 500;
    const mask = img(w, h, pattern);
    const live = img(w, h, (x, y) => pattern(x + 6, y - 5));
    const best = estimateShift(mask, live, w, h, false);
    expect(Math.hypot(best.dx + 6, best.dy - 5)).toBeLessThan(0.2);
  });

  it("ズレが無ければ 0 を返す", () => {
    const w = 16;
    const h = 16;
    const same = img(w, h, (x, y) => x + y);
    const best = estimateShift(same, same, w, h, false, 2);
    expect(best.dx).toBe(0);
    expect(best.dy).toBe(0);
    expect(best.rms).toBeCloseTo(0, 6);
  });
});

describe("★contrastDropSignal — 骨が濃くても造影の到達が見える", () => {
  /** 骨（暗い塊）＋ 途中から血管（別の場所が少し暗くなる）。 */
  function run(vesselFrom: number): { drop: number[]; plain: number[] } {
    const w = 40;
    const h = 40;
    const frames: Float32Array[] = [];
    for (let t = 0; t < 10; t++) {
      frames.push(
        img(w, h, (x, y) => {
          // 骨: 左半分が真っ暗（低パーセンタイルはここで占められる）。
          let v = x < 20 ? 100 : 1000;
          // 血管: 右半分の 1 行だけが少し暗くなる。全体から見ればごく一部。
          if (t >= vesselFrom && x >= 20 && y === 20) v -= 300;
          return v;
        }),
      );
    }
    return { drop: contrastDropSignal(frames, 0.02, 1), plain: frames.map((f) => contrastSignal(f, 0.02, 1)) };
  }

  it("フレーム単独の暗部テールは骨に埋もれて動かない（＝これだけでは検出できない）", () => {
    const { plain } = run(4);
    // 骨が最も暗いので、造影が入っても 2% 分位は 100 のまま。
    expect(new Set(plain).size).toBe(1);
  });

  it("★先頭との差で見れば到達フレームで明確に動く", () => {
    const { drop } = run(6);
    for (let t = 0; t < 6; t++) expect(drop[t]).toBe(0);
    for (let t = 6; t < 10; t++) expect(drop[t]).toBe(-300);
    expect(pickMaskFrames(drop).onset).toBe(6);
    // マスクは到達の手前だけ。
    expect(pickMaskFrames(drop).frames).toEqual([1, 2, 3, 4, 5]);
  });

  // 🔴 **既知の限界**（直していない）。{@link pickMaskFrames} は先頭 5 フレームを基線にし、
  //    走査もその後ろから始めるので、**造影が 5 フレーム以内に到達すると検出できない**。
  //    そのときマスクは先頭 5 フレーム＝造影入りになる。GNBP-XA-2 は到達が 6 フレーム目
  //    （＝基線の直後）なので通っているだけで、余裕は 1 フレームしか無い。
  it("🔴 造影が基線（先頭 5 フレーム）の中で到達すると検出できない", () => {
    const { drop } = run(4);
    expect(pickMaskFrames(drop).onset).toBeNull();
    // 見つからないときはランの先頭＝造影入りのフレームを含んでしまう。
    expect(pickMaskFrames(drop).frames).toEqual([0, 1, 2, 3, 4]);
  });

  it("先頭フレームは自分自身との差なので 2 番目の値で埋める（基線を壊さない）", () => {
    const { drop } = run(4);
    expect(drop[0]).toBe(drop[1]);
  });

  it("空・長さ違いでも壊れない", () => {
    expect(contrastDropSignal([])).toEqual([]);
    const a = new Float32Array(9);
    expect(contrastDropSignal([a, new Float32Array(4)])).toEqual([0, 0]);
  });
});

describe("★blurSeparable — 探索の前処理", () => {
  it("全体が一定なら値は変わらない（端の複製が効いている）", () => {
    const v = blurSeparable(img(8, 8, () => 5), 8, 8, 1.0);
    for (const x of v) expect(x).toBeCloseTo(5, 5);
  });

  it("総和を保つ（インパルスを広げても失わない）", () => {
    const src = new Float32Array(81);
    src[40] = 100;
    const out = blurSeparable(src, 9, 9, 1.0);
    expect(out.reduce((a, b) => a + b, 0)).toBeCloseTo(100, 3);
    expect(out[40]).toBeLessThan(100);
  });

  it("σ<=0 は素通し", () => {
    const src = img(4, 4, (x, y) => x * y);
    expect(Array.from(blurSeparable(src, 4, 4, 0))).toEqual(Array.from(src));
  });
});

describe("parseFrameNumbers — DICOM の 1 origin を 0 origin へ", () => {
  it("バックスラッシュ区切りを変換する", () => {
    expect(parseFrameNumbers("1\\2\\3")).toEqual([0, 1, 2]);
  });

  it("空・不正は null", () => {
    expect(parseFrameNumbers(null)).toBeNull();
    expect(parseFrameNumbers("")).toBeNull();
    expect(parseFrameNumbers("abc")).toBeNull();
  });

  it("0 以下は捨てる（1 origin なので 0 は不正）", () => {
    expect(parseFrameNumbers("0\\1\\2")).toEqual([0, 1]);
  });
});


describe("subtractFrames — levelMatch（一様オフセットの除去・§6.9 5-F）", () => {
  const W = 40;
  const H = 40;
  /** 血管に見立てた濃い筋を 1 本だけ持つ背景（画面のごく一部）。 */
  const scene = (gain: number): Float32Array => {
    const f = new Float32Array(W * H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const bone = 60 + 20 * Math.sin((x * 2 * Math.PI) / 13) + 15 * Math.cos((y * 2 * Math.PI) / 9);
        const vessel = x >= 18 && x <= 21 ? -25 : 0; // 4/40 列 ＝ 画面の 10%
        f[y * W + x] = gain * (bone + vessel);
      }
    }
    return f;
  };

  const median = (a: Float32Array): number => {
    const v = Array.from(a).sort((x, y) => x - y);
    const h = v.length >> 1;
    return v.length % 2 ? v[h] : (v[h - 1] + v[h]) / 2;
  };

  it("🔴 ★ 既定（false）では一様オフセットがそのまま残る", () => {
    // 露出が 1.9 倍違う 2 枚（実機の先頭フレームは p10 103 対 プラトー 55）。
    const out = subtractFrames(scene(1.9), scene(1), W, H, { dx: 0, dy: 0, logarithmic: true })!;
    expect(median(out)).toBeCloseTo(Math.log(1.9), 2);
  });

  it("★ levelMatch を立てると中央値が 0 になる（絵の中身は変えない）", () => {
    const base = { dx: 0, dy: 0, logarithmic: true };
    const plain = subtractFrames(scene(1.9), scene(1), W, H, base)!;
    const matched = subtractFrames(scene(1.9), scene(1), W, H, { ...base, levelMatch: true })!;
    expect(Math.abs(median(matched))).toBeLessThan(0.01);
    // 🔑 引いたのは**定数だけ**。画素ごとの差（＝見たいもの）は 1 つも変わっていない。
    const offset = median(plain) - median(matched);
    for (let i = 0; i < plain.length; i++) expect(matched[i]).toBeCloseTo(plain[i] - offset, 5);
  });

  it("血管（画面の 10%）があっても中央値は動かない", () => {
    // 造影の有無で中央値がずれないこと＝レベル合わせが造影を消さないこと。
    const withVessel = subtractFrames(scene(1), scene(1), W, H, { dx: 0, dy: 0, logarithmic: true, levelMatch: true })!;
    for (let i = 0; i < withVessel.length; i++) expect(withVessel[i]).toBeCloseTo(0, 6);
  });

  it("🚨 コリメータ外（ちょうど 0）の画素は中央値に入れない", () => {
    const mask = scene(1.9);
    const live = scene(1);
    // 画面の 60% を 0 で埋める（実データのコリメータより極端に）。
    for (let i = 0; i < mask.length * 0.6; i++) { mask[i] = 0; live[i] = 0; }
    const out = subtractFrames(mask, live, W, H, { dx: 0, dy: 0, logarithmic: true, levelMatch: true })!;
    // 0 を除いた側（後ろの 40%）の中央値が 0 になっていること。
    const tail = out.slice(Math.floor(out.length * 0.6));
    expect(Math.abs(median(tail))).toBeLessThan(0.01);
  });
});


describe("subtractFrames — 自分自身を引くと厳密にゼロ（§6.10 Phase 6）", () => {
  const W = 33;
  const H = 21;
  const frame = (): Float32Array => {
    const f = new Float32Array(W * H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        f[y * W + x] = 40 + 30 * Math.sin((x * 2 * Math.PI) / 7) + 20 * Math.cos((y * 2 * Math.PI) / 5);
      }
    }
    return f;
  };

  it("🔴 ★ 非造影フレームにとって誤差ゼロのマスクは自分自身である", () => {
    const f = frame();
    for (const logarithmic of [true, false]) {
      const out = subtractFrames(f, f, W, H, { dx: 0, dy: 0, logarithmic })!;
      for (let i = 0; i < out.length; i++) expect(out[i]).toBe(0);
    }
  });

  it("levelMatch を立ててもゼロのまま（中央値が 0 なので何も引かれない）", () => {
    const f = frame();
    const out = subtractFrames(f, f, W, H, { dx: 0, dy: 0, logarithmic: true, levelMatch: true })!;
    for (let i = 0; i < out.length; i++) expect(out[i]).toBe(0);
  });

  it("🚨 シフトを入れるとゼロではなくなる（だから計画の dx/dy は 0 でなければならない）", () => {
    const f = frame();
    const out = subtractFrames(f, f, W, H, { dx: 0.4, dy: 0, logarithmic: true })!;
    expect(out.some((v) => Math.abs(v) > 1e-6)).toBe(true);
  });
});
