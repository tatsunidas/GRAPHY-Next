/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * XA シリーズの「ショット」（H42 の対象インスタンス）の並びと選択。純関数。
 *
 * <p>2D ビューアの「ショット」は、XA のシネ 1 インスタンスが 1 ショット。並びは
 * `XaFrameExpander`（InstanceNumber の昇順、同じなら SOPInstanceUID の昇順。番号が無いものは 0）に合わせる。
 * ビューアの「ショット k」とプラグインの `shots[k-1]` が同じ画像を指すようにするため。
 */
export interface ShotInstance {
  sopInstanceUid: string;
  instanceNumber: number | null;
}

/** ビューアと同じ並び（InstanceNumber → SOPInstanceUID）。入力は変えない。 */
export function orderShots<T extends ShotInstance>(instances: readonly T[]): T[] {
  return [...instances].sort((a, b) => {
    const d = (a.instanceNumber ?? 0) - (b.instanceNumber ?? 0);
    if (d !== 0) return d;
    return a.sopInstanceUid < b.sopInstanceUid ? -1 : a.sopInstanceUid > b.sopInstanceUid ? 1 : 0;
  });
}

/**
 * 読むインスタンス。`sop` 省略なら先頭のショット。指定した SOP がシリーズに無ければ null
 * （黙って先頭に替えない）。
 */
export function chooseInstance<T extends ShotInstance>(shots: readonly T[], sop?: string): T | null {
  if (sop === undefined) return shots[0] ?? null;
  return shots.find((s) => s.sopInstanceUid === sop) ?? null;
}
