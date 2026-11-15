/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// 保管庫の変更の通し番号を一定周期で問い合わせ、メイン一覧の自動更新（待機中）か通知（操作中）を決める。
// 判定は storeRefreshView.ts の純関数。web モードでは取り込みが無く、番号は動かない（何も起きない）。
import { useCallback, useEffect, useRef, useState } from "react";
import { httpGet } from "../http";
import { INITIAL_STATE, acknowledge as ack, step, type StoreRefreshState, type StoreVersionSnapshot } from "./storeRefreshView";

const POLL_MS = 3000;

export const fetchStoreVersion = () => httpGet<StoreVersionSnapshot>("/api/studies/version");

export function useStoreVersion(args: {
  active: boolean;
  /** 待機中か（検査を選んでいない・1 ページ目・チェックなし）。 */
  idle: boolean;
  /** 待機中に新しい検査が届いて落ち着いたとき、一覧を読み込み直す。 */
  onAutoReload: () => void;
}): { notify: boolean; acknowledge: () => void } {
  const { active, idle, onAutoReload } = args;
  const state = useRef<StoreRefreshState>(INITIAL_STATE);
  const idleRef = useRef(idle);
  idleRef.current = idle;
  const reloadRef = useRef(onAutoReload);
  reloadRef.current = onAutoReload;
  const [notify, setNotify] = useState(false);

  useEffect(() => {
    if (!active) return;
    let alive = true;
    const poll = async () => {
      try {
        const s = await fetchStoreVersion();
        if (!alive) return;
        const r = step(state.current, s.version, idleRef.current);
        state.current = r.state;
        if (r.action === "auto") {
          state.current = ack(state.current);
          setNotify(false);
          reloadRef.current();
        } else {
          setNotify(r.action === "notify");
        }
      } catch {
        // backend に届かない間は何もしない（次の周期で再開）
      }
    };
    void poll();
    const id = setInterval(() => void poll(), POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [active]);

  /** 一覧を読み込み直した（手動の更新・検索条件の変更）ので、いまの番号を基準にして通知を消す。 */
  const acknowledge = useCallback(() => {
    state.current = ack(state.current);
    setNotify(false);
  }, []);

  return { notify, acknowledge };
}
