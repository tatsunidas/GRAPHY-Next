/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// 「確認済みの失敗」の印。台帳（backend）は持たないので、この PC のブラウザ側に持つ。
// 窓（#computejobs）と状態バーは同じオリジンなので localStorage を共有する。別の PC には共有されない。
// localStorage が使えないときは空として扱う＝全部の失敗を数える側に倒す。
const KEY = "graphy.computeJobs.seenFailed";
const MAX = 500;

export function loadSeen(): Set<string> {
  try {
    const raw = localStorage.getItem(KEY);
    const arr: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

/** id を確認済みに足す。台帳に無い id の掃除は pruneSeen。 */
export function markSeen(id: string): Set<string> {
  const s = loadSeen();
  s.add(id);
  saveSeen(s);
  return s;
}

export function saveSeen(s: Set<string>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify([...s].slice(-MAX)));
  } catch {
    /* 保存できないときは確認済みにならない（失敗の数が減らないだけ） */
  }
}

/** 台帳に残っている id だけを残す（消した行の印が溜まり続けないように）。 */
export function pruneSeen(seen: ReadonlySet<string>, liveIds: Iterable<string>): Set<string> {
  const live = new Set(liveIds);
  return new Set([...seen].filter((id) => live.has(id)));
}
