/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 「引数が変わったら取り直す・古い応答は捨てる」だけの最小の非同期フック。
 *
 * <p>`useStudies` / `useSeries` / `useInstances`（`fw/mobile-ui-design.md` §3.5）の共通部分。
 * 3 つとも `useState` ＋ `useEffect` ＋ `fetch` ＋ `cancelled` フラグという同じ形なので、
 * **取り違えると壊れる `cancelled` の扱いを 1 箇所に閉じる**ために切り出した。
 *
 * <p>状態は 3 つ: `data === null && !error` が「未取得（読み込み中 or 未起動）」、
 * `loading` が「いま飛んでいる」。区別が要るのは「検索していないので空」と
 * 「検索したが 0 件」を出し分けるため（既存 `StudyList` の `filters == null` 分岐と同じ意味）。
 */
import { useCallback, useEffect, useState } from "react";

export interface AsyncData<T> {
  /** 取得済みデータ。未取得・エラー時は null。 */
  data: T | null;
  /** 失敗時のメッセージ（`String(e)`）。既存画面の表示に合わせて文字列で持つ。 */
  error: string | null;
  loading: boolean;
  /** 同じ引数で取り直す（DB 変更通知などに使う）。 */
  reload: () => void;
}

/**
 * @param key    取得条件を表す文字列。**これが変わったら取り直す**。`null` なら取得しない。
 * @param fetcher `key` に対応する取得処理。`key` が同じ間は呼ばれない。
 */
export function useAsyncData<T>(key: string | null, fetcher: () => Promise<T>): AsyncData<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [nonce, setNonce] = useState(0);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    setData(null);
    setError(null);
    if (key === null) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    fetcher()
      .then((v) => {
        if (cancelled) return;
        setData(v);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(String(e));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // fetcher は毎レンダー新しい関数になるため依存に入れない。取り直しの契機は key と nonce のみ。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, nonce]);

  return { data, error, loading, reload };
}
