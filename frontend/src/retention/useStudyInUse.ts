/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// 検査を開いている間、そのスタディを backend に「使用中」と知らせる（自動削除から守るため。standalone のみ）。
// backend は記録をメモリにしか持たないので、一定間隔で出し直す（backend の再起動・登録の失敗から回復する）。
// ウィンドウが落ちて解放できなかった分は backend の再起動まで守られたまま残る（安全側）。
import { useEffect, useRef, useState } from "react";
import { HttpError } from "../http";
import { registerStudiesInUse, releaseStudiesBeacon, releaseStudiesInUse } from "../settings/retentionApi";

const HEARTBEAT_MS = 60_000;

/** web モード（404）では以後呼ばない。 */
let unsupported = false;

async function call(fn: (uids: string[]) => Promise<unknown>, uids: string[]): Promise<boolean> {
  if (unsupported || uids.length === 0) return false;
  try {
    await fn(uids);
    return true;
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) unsupported = true;
    return false; // 登録できなくても表示は続ける。次の出し直しで再試行する
  }
}

/** タイル（連結して開いたものは全部分）が属するスタディの UID。 */
export function studyUidsOfTiles(
  tiles: readonly { study: { studyInstanceUid: string }; concat?: { parts: { study: { studyInstanceUid: string } }[] } }[],
): string[] {
  const out = new Set<string>();
  for (const tl of tiles) {
    out.add(tl.study.studyInstanceUid);
    for (const part of tl.concat?.parts ?? []) out.add(part.study.studyInstanceUid);
  }
  return [...out];
}

/** 追加と削除の差分（純関数）。 */
export function diffUids(held: ReadonlySet<string>, next: ReadonlySet<string>): { add: string[]; remove: string[] } {
  return {
    add: [...next].filter((u) => !held.has(u)),
    remove: [...held].filter((u) => !next.has(u)),
  };
}

export function useStudyInUse(studyUids: readonly string[]): void {
  const wanted = useRef<Set<string>>(new Set());
  const sent = useRef<Set<string>>(new Set());
  const key = [...new Set(studyUids.filter(Boolean))].sort().join("\n");

  useEffect(() => {
    const next = new Set(key ? key.split("\n") : []);
    wanted.current = next;
    const { add, remove } = diffUids(sent.current, next);
    void (async () => {
      if (await call(registerStudiesInUse, add)) add.forEach((u) => sent.current.add(u));
      if (await call(releaseStudiesInUse, remove)) remove.forEach((u) => sent.current.delete(u));
    })();
  }, [key]);

  useEffect(() => {
    const beat = setInterval(() => {
      const all = [...wanted.current];
      void call(registerStudiesInUse, all);
    }, HEARTBEAT_MS);
    const releaseAll = () => {
      const all = [...new Set([...sent.current, ...wanted.current])];
      if (all.length > 0 && !unsupported) releaseStudiesBeacon(all);
      sent.current.clear();
    };
    window.addEventListener("pagehide", releaseAll);
    return () => {
      clearInterval(beat);
      window.removeEventListener("pagehide", releaseAll);
      releaseAll();
    };
  }, []);
}

/** 起動コンテキスト（localStorage）から検査を読んで開く別ウィンドウ。2D ビューアはタイルから直接登録する。 */
export const CTX_WINDOWS = ["mpr", "viewer3d", "slicer", "curvedmpr", "geometry3d"] as const;

/** 起動コンテキストの JSON から、スタディ UID を取り出す（連結して開いたものは全部分）。不正なら空。 */
export function studyUidsOfCtx(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const ctx = JSON.parse(raw) as {
      study?: { studyInstanceUid?: string };
      concat?: { parts?: { study?: { studyInstanceUid?: string } }[] };
    };
    const out = new Set<string>();
    if (ctx.study?.studyInstanceUid) out.add(ctx.study.studyInstanceUid);
    for (const p of ctx.concat?.parts ?? []) if (p.study?.studyInstanceUid) out.add(p.study.studyInstanceUid);
    return [...out];
  } catch {
    return [];
  }
}

/** ルート（#mpr など）の窓が、起動コンテキストの検査を開いている間、使用中と知らせる。 */
export function useCtxWindowInUse(screen: string): void {
  const target = (CTX_WINDOWS as readonly string[]).includes(screen);
  const ctxKey = `graphy-${screen}-ctx`;
  const read = () => {
    try {
      return target ? studyUidsOfCtx(localStorage.getItem(ctxKey)) : [];
    } catch {
      return [];
    }
  };
  const [uids, setUids] = useState<string[]>(read);
  useEffect(() => {
    if (!target) return;
    const on = (e: StorageEvent) => {
      if (e.key === ctxKey || e.key === null) setUids(read());
    };
    window.addEventListener("storage", on);
    setUids(read());
    return () => window.removeEventListener("storage", on);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctxKey, target]);
  useStudyInUse(uids);
}
