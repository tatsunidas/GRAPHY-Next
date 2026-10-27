import { describe, expect, it } from "vitest";
import { PriorSnapshots } from "./priorSnapshots";

function slices(n: number, len: number, fill = 0) {
  return Array.from({ length: n }, () => new Uint8Array(len).fill(fill));
}
const access = (vols: Uint8Array[]) => (z: number) =>
  vols[z] ? { read: (i: number) => vols[z][i], write: (i: number, v: number) => void (vols[z][i] = v) } : undefined;

describe("PriorSnapshots", () => {
  it("記録→書き換え→復元で元のラベルに戻り、戻したスライスを返す", () => {
    const vols = slices(3, 4);
    vols[1].set([0, 2, 0, 3]);
    const p = new PriorSnapshots();
    p.record(1, (i) => vols[1][i], 4);
    vols[1].fill(1);
    expect([...p.restoreInto(access(vols))]).toEqual([1]);
    expect([...vols[1]]).toEqual([0, 2, 0, 3]);
    expect(p.size).toBe(0);
  });

  it("同じスライスを 2 回記録しても最初の元値が残る（書いた後の値で上書きしない）", () => {
    const vols = slices(1, 3);
    const p = new PriorSnapshots();
    p.record(0, (i) => vols[0][i], 3);
    vols[0].fill(5);
    p.record(0, (i) => vols[0][i], 3);
    p.restoreInto(access(vols));
    expect([...vols[0]]).toEqual([0, 0, 0]);
  });

  it("触っていないスライスは変えない", () => {
    const vols = slices(2, 2, 7);
    const p = new PriorSnapshots();
    p.record(0, (i) => vols[0][i], 2);
    vols[0].fill(1);
    p.restoreInto(access(vols));
    expect([...vols[1]]).toEqual([7, 7]);
  });

  it("300 スライス × 512×512（約 7,860 万ボクセル > 2^24）を全部書き換えても落ちず、全て元に戻る", () => {
    const n = 300;
    const len = 512 * 512;
    const vols = slices(n, len);
    vols[150][12345] = 4;
    const p = new PriorSnapshots();
    for (let z = 0; z < n; z++) {
      p.record(z, (i) => vols[z][i], len);
      vols[z].fill(1);
    }
    expect(n * len).toBeGreaterThan(2 ** 24);
    p.restoreInto(access(vols));
    let bad = 0;
    for (let z = 0; z < n; z++) for (let i = 0; i < len; i++) if (vols[z][i] !== (z === 150 && i === 12345 ? 4 : 0)) bad++;
    expect(bad).toBe(0);
  }, 60000);
});
