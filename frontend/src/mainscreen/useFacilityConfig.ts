/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { useEffect, useRef, useState } from "react";
import { apiBase } from "../apiBase";
import type { FacilityResponse } from "../settings/facilityView";

const POLL_MS = 2000;

/**
 * 施設の資料の内容を、2 秒ごとに `ETag` で問い合わせる。未設定（204）・取れない間は null（節を出さない）。
 * 画面が非表示のあいだは止め、戻ったらすぐ取り直す。**ネットワークに出るのは本体の backend だけ**（同一オリジン／localhost）。
 */
export function useFacilityConfig(enabled = true): FacilityResponse | null {
  const [res, setRes] = useState<FacilityResponse | null>(null);
  const etag = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const refresh = async () => {
      try {
        const r = await fetch(`${apiBase()}/api/facility/config`, {
          headers: etag.current ? { "If-None-Match": etag.current } : undefined,
        });
        if (!alive) return;
        if (r.status === 304) return;
        if (r.status === 204) {
          etag.current = null;
          setRes(null);
          return;
        }
        if (!r.ok) return; // 取れない間は、いまの表示を保つ
        etag.current = r.headers.get("ETag");
        setRes((await r.json()) as FacilityResponse);
      } catch {
        /* backend に届かない間は、いまの表示を保つ */
      }
    };
    void refresh();
    const id = setInterval(() => {
      if (!document.hidden) void refresh();
    }, POLL_MS);
    const onVisible = () => {
      if (!document.hidden) void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive = false;
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [enabled]);

  return res;
}
