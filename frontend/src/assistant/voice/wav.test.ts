import { describe, expect, it } from "vitest";
import { SILENCE_PEAK, TARGET_RATE, encodeWav16, mixToMono, peakOf, prepareAudio, resample, toBase64 } from "./wav";

const sine = (hz: number, rate: number, sec: number, amp = 0.5) =>
  Float32Array.from({ length: Math.floor(rate * sec) }, (_, i) => amp * Math.sin((2 * Math.PI * hz * i) / rate));

/** ゼロ交差から周波数を推定する（簡易）。 */
const estimateHz = (x: Float32Array, rate: number) => {
  let zc = 0;
  for (let i = 1; i < x.length; i++) if (x[i - 1] < 0 && x[i] >= 0) zc++;
  return (zc * rate) / x.length;
};

describe("wav", () => {
  it("encodeWav16: ヘッダ・長さ・値（正例）", () => {
    const w = encodeWav16(Float32Array.from([0, 1, -1, 0.5]), 16000);
    const v = new DataView(w.buffer);
    expect(String.fromCharCode(...w.subarray(0, 4))).toBe("RIFF");
    expect(String.fromCharCode(...w.subarray(8, 16))).toBe("WAVEfmt ");
    expect(w.length).toBe(44 + 8);
    expect(v.getUint32(4, true)).toBe(36 + 8);
    expect(v.getUint16(22, true)).toBe(1); // mono
    expect(v.getUint32(24, true)).toBe(16000);
    expect(v.getUint16(34, true)).toBe(16);
    expect([44, 46, 48, 50].map((o) => v.getInt16(o, true))).toEqual([0, 32767, -32768, 16384]);
  });

  it("encodeWav16: 範囲外は丸める（負例: 溢れて反転しない）", () => {
    const v = new DataView(encodeWav16(Float32Array.from([5, -5]), 16000).buffer);
    expect(v.getInt16(44, true)).toBe(32767);
    expect(v.getInt16(46, true)).toBe(-32768);
  });

  it("resample: 48 kHz → 16 kHz で長さが 1/3・440 Hz が保たれる／同じレートはそのまま", () => {
    const x = sine(440, 48000, 1);
    const y = resample(x, 48000, TARGET_RATE);
    expect(y.length).toBe(16000);
    expect(estimateHz(y, TARGET_RATE)).toBeGreaterThan(435);
    expect(estimateHz(y, TARGET_RATE)).toBeLessThan(445);
    expect(resample(x, 48000, 48000)).toBe(x);
  });

  it("resample: 8 kHz → 16 kHz（アップ）でも周波数が保たれる／不正なレートは例外（負例）", () => {
    const y = resample(sine(200, 8000, 1), 8000, TARGET_RATE);
    expect(y.length).toBe(16000);
    expect(estimateHz(y, TARGET_RATE)).toBeGreaterThan(195);
    expect(estimateHz(y, TARGET_RATE)).toBeLessThan(205);
    expect(() => resample(new Float32Array(4), 0, 16000)).toThrow();
    expect(resample(new Float32Array(0), 48000, 16000).length).toBe(0);
  });

  it("resample: 高周波は折り返して低域に出ない（区間平均が効いている）", () => {
    // 48 kHz の 15 kHz は 16 kHz へ落とすとナイキスト(8 kHz)を超える。平均で大きく減衰する
    const y = resample(sine(15000, 48000, 0.5, 1), 48000, TARGET_RATE);
    expect(peakOf(y)).toBeLessThan(0.2);
  });

  it("mixToMono: 平均／1ch はそのまま／空は空", () => {
    expect(Array.from(mixToMono([Float32Array.from([1, 0]), Float32Array.from([0, 1])]))).toEqual([0.5, 0.5]);
    const one = Float32Array.from([0.1]);
    expect(mixToMono([one])).toBe(one);
    expect(mixToMono([]).length).toBe(0);
  });

  it("prepareAudio: 長さと peak。無音は peak が SILENCE_PEAK 以下（負例）、音ありは超える（正例）", () => {
    const loud = prepareAudio([sine(300, 48000, 2)], 48000);
    expect(loud.seconds).toBeCloseTo(2, 2);
    expect(loud.peak).toBeGreaterThan(SILENCE_PEAK * 100);
    const quiet = prepareAudio([new Float32Array(48000)], 48000);
    expect(quiet.peak).toBeLessThanOrEqual(SILENCE_PEAK);
    expect(atob(loud.base64).slice(0, 4)).toBe("RIFF");
    expect(atob(loud.base64).length).toBe(44 + 2 * 32000);
  });

  it("toBase64: 大きな配列でも落ちない（引数の溢れ）", () => {
    const big = new Uint8Array(3_000_000).fill(65);
    expect(atob(toBase64(big)).length).toBe(3_000_000);
  });
});
