/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { useEffect, useRef } from "react";

/** indeterminate を扱える 3 状態チェックボックス（エクスポート・送信・シリーズ選択の窓で共通）。 */
export function TriCheckbox({
  state,
  onChange,
  testId,
}: {
  state: "all" | "some" | "none";
  onChange: () => void;
  testId?: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = state === "some";
  }, [state]);
  return <input ref={ref} type="checkbox" checked={state === "all"} onChange={onChange} data-testid={testId} />;
}
