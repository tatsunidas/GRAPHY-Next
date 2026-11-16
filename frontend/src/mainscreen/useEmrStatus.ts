/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// 電子カルテ連携の状態を、メイン画面の状態バーと［開く］ボタン用に一定周期で問い合わせる（standalone のみ）。
import { useEffect, useState } from "react";
import { fetchEmrStatus } from "../settings/emrApi";
import { barView, type EmrBar, type EmrStatus } from "../settings/emrView";

const POLL_MS = 1500;

export function useEmrStatus(active: boolean): { status: EmrStatus | null; bar: EmrBar } {
  const [status, setStatus] = useState<EmrStatus | null>(null);

  useEffect(() => {
    if (!active) return;
    let alive = true;
    const poll = async () => {
      try {
        const s = await fetchEmrStatus();
        if (alive) setStatus(s);
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

  return { status, bar: barView(status) };
}
