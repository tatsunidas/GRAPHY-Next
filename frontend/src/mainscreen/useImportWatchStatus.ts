/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// 監視フォルダの自動取り込みの状態を、メイン画面の状態バー用に一定周期で問い合わせる（standalone のみ）。
import { useCallback, useEffect, useRef, useState } from "react";
import { fetchImportWatchStatus } from "../settings/importWatchApi";
import { barView, nextBaseline, type ImportWatchStatus, type WatchBarView } from "../settings/importWatchView";

const POLL_MS = 3000;

export function useImportWatchStatus(active: boolean): { view: WatchBarView; acknowledge: () => void } {
  const [status, setStatus] = useState<ImportWatchStatus | null>(null);
  const [baseline, setBaseline] = useState<number | null>(null);
  const latest = useRef<ImportWatchStatus | null>(null);

  useEffect(() => {
    if (!active) return;
    let alive = true;
    const poll = async () => {
      try {
        const s = await fetchImportWatchStatus();
        if (!alive) return;
        latest.current = s;
        setStatus(s);
        setBaseline((b) => nextBaseline(s, b));
      } catch {
        if (alive) setStatus(null); // web モード（404）・backend に届かない間は出さない
      }
    };
    void poll();
    const id = setInterval(() => void poll(), POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [active]);

  /** 一覧を読み込み直したので、いまの取込件数を基準にする。 */
  const acknowledge = useCallback(() => {
    if (latest.current) setBaseline(latest.current.imported);
  }, []);

  return { view: barView(status, baseline), acknowledge };
}
