/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 塗る前のラベル値を、スライス単位のスナップショットで控える（Cornerstone に依存しない）。
 * ボクセルごとの Map は約 2^24 件で RangeError になるため使わない。
 * 保持量は「触ったスライス数 × sliceLen × 2 B」で、選択ボクセル数には依存しない。
 */
export class PriorSnapshots {
  private readonly bySlice = new Map<number, Uint16Array>();

  /** スライス z を初めて触るときに、全画素の現在値を控える（2 回目以降は何もしない）。 */
  record(z: number, readAt: (idx: number) => number, sliceLen: number): void {
    if (this.bySlice.has(z)) return;
    const snap = new Uint16Array(sliceLen);
    for (let i = 0; i < sliceLen; i++) snap[i] = readAt(i);
    this.bySlice.set(z, snap);
  }

  /**
   * 控えた値へ戻す。現在値が違う画素だけ書く。書き戻し先が無い（スライスが消えた）ものは飛ばす。
   * 戻したスライス番号を返し、控えは空になる。
   */
  restoreInto(
    access: (z: number) => { read: (idx: number) => number; write: (idx: number, v: number) => void } | undefined,
  ): Set<number> {
    const touched = new Set<number>();
    for (const [z, snap] of this.bySlice) {
      const a = access(z);
      if (!a) continue;
      for (let i = 0; i < snap.length; i++) {
        if (a.read(i) !== snap[i]) a.write(i, snap[i]);
      }
      touched.add(z);
    }
    this.bySlice.clear();
    return touched;
  }

  get size(): number {
    return this.bySlice.size;
  }
}
