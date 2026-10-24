/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// 受信時の匿名化の状態を、メイン画面の状態バー用に一定周期で問い合わせる（standalone のみ）。
import { useEffect, useState } from "react";
import { fetchReceiveAnon } from "../settings/receiveAnonApi";
import { barView, type ReceiveAnonBar, type ReceiveAnonView } from "../settings/receiveAnonView";

const POLL_MS = 5000;

export function useReceiveAnonStatus(active: boolean): ReceiveAnonBar {
  const [view, setView] = useState<ReceiveAnonView | null>(null);
  useEffect(() => {
    if (!active) return;
    let alive = true;
    const poll = async () => {
      try {
        const v = await fetchReceiveAnon();
        if (alive) setView(v);
      } catch {
        if (alive) setView(null); // web モード（404）・backend に届かない間は出さない
      }
    };
    void poll();
    const id = setInterval(() => void poll(), POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [active]);
  return barView(view);
}
