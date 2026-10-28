/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// 「回帰評価」の節（要求の記録パネルの中）。固定の質問セットを流し、呼んだツールが期待どおりかを数える。前回との差分を出す。
// 🔴 ツールは実行しない（合成の状態を返すスタブ）。送るのは合成の質問とツール定義だけ。外部宛てなら実行前に画面内で確認する。
import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { compareRuns, type StoredEvalRun } from "./eval/compareRuns";
import { EVAL_CASES, EVAL_SUITE_VERSION } from "./eval/cases";
import type { EvalRun } from "./eval/runEval";
import { secondsText, shortText } from "./requestLogView";

type T = (k: string, v?: Record<string, string | number>) => string;

export interface EvalApi {
  list: () => Promise<{ ok: boolean; runs?: StoredEvalRun[] } | undefined>;
  append: (run: EvalRun) => Promise<{ ok: boolean } | undefined>;
  run: (onProgress: (done: number, total: number) => void) => Promise<EvalRun>;
  /** 外部へ出る宛先ならそのホスト名。ローカルは null。使えない（ツール呼び出し不可など）ときは undefined。 */
  destination: { host: string } | null | undefined;
}

/** 実行ボタンの動き。外部へ出る宛先は先に確認（ask）、ローカルはそのまま実行（run）、使えない提供元は無効（unavailable）。 */
export function evalStartMode(destination: EvalApi["destination"]): "ask" | "run" | "unavailable" {
  if (destination === undefined) return "unavailable";
  return destination === null ? "run" : "ask";
}

export function EvalSection({ api, busy, t, onRan }: { api: EvalApi; busy: boolean; t: T; onRan?: () => void }) {
  const [runs, setRuns] = useState<StoredEvalRun[]>([]);
  const [last, setLast] = useState<EvalRun | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await api.list();
    setRuns(r?.ok && r.runs ? r.runs : []);
  }, [api]);
  useEffect(() => {
    void load();
  }, [load]);

  const start = async () => {
    setAsking(false);
    setError(null);
    setLast(null);
    setProgress({ done: 0, total: EVAL_CASES.length });
    try {
      const run = await api.run((done, total) => setProgress({ done, total }));
      setLast(run);
      if (run.total === EVAL_CASES.length) {
        const saved = await api.append(run);
        if (!saved?.ok) setError("save-failed");
      }
    } catch {
      setError("run-failed");
    }
    setProgress(null);
    await load();
    onRan?.(); // 評価の要求は通常の記録にも残るので、上の件数を読み直す
  };

  const mode = evalStartMode(api.destination);
  const unavailable = mode === "unavailable";
  const latest = runs[0];
  const prev = latest ? runs.slice(1).find((r) => r.suiteVersion === latest.suiteVersion) : undefined;
  const cmp = latest && prev ? compareRuns(prev, latest) : null;
  const failed = last ? last.cases.filter((c) => !c.pass) : [];
  return (
    <div style={S.box} data-testid="assistant-eval">
      <div style={S.title}>{t("assistant.eval.title")}</div>
      <div style={S.dim}>{t("assistant.eval.note", { n: EVAL_CASES.length })}</div>
      {unavailable && <div style={S.dim} data-testid="assistant-eval-unavailable">{t("assistant.eval.unavailable")}</div>}
      <div style={S.row}>
        {!asking ? (
          <button
            style={S.btn}
            disabled={busy || progress !== null || unavailable}
            onClick={() => (mode === "ask" ? setAsking(true) : void start())}
            data-testid="assistant-eval-run"
          >
            {t("assistant.eval.run")}
          </button>
        ) : (
          <>
            <span data-testid="assistant-eval-ask">{t("assistant.eval.ask", { n: EVAL_CASES.length, host: api.destination?.host ?? "?" })}</span>
            <button style={S.btn} onClick={() => void start()} data-testid="assistant-eval-ask-yes">{t("assistant.eval.askYes")}</button>
            <button style={S.btn} onClick={() => setAsking(false)} data-testid="assistant-eval-ask-no">{t("assistant.eval.askNo")}</button>
          </>
        )}
        {progress && <span data-testid="assistant-eval-progress">{t("assistant.eval.progress", { done: progress.done, total: progress.total })}</span>}
      </div>
      {error && <div style={S.err} data-testid="assistant-eval-error">{t("assistant.eval.error", { code: shortText(error, 30) })}</div>}
      {latest && (
        <div data-testid="assistant-eval-result">
          <div data-testid="assistant-eval-score">
            {t("assistant.eval.score", { passed: latest.passed, total: latest.total })}{" "}
            <span style={S.dim}>
              {latest.modelVersion ?? latest.modelId ?? t("assistant.requestlog.unknown")} · {latest.ts.replace("T", " ").slice(0, 19)}
            </span>
          </div>
          <div style={S.dim} data-testid="assistant-eval-total-latency">
            {t("assistant.eval.totalLatency", { v: typeof latest.totalLatencyMs === "number" ? secondsText(latest.totalLatencyMs) : t("assistant.requestlog.notObtained") })}
          </div>
          {last && failed.length > 0 && (
            <div data-testid="assistant-eval-failed">
              {failed.map((c) => (
                <div key={c.id} style={S.fail} data-testid="assistant-eval-failed-row">
                  {c.id}: {c.error ? t("assistant.eval.chatFailed", { code: shortText(c.error, 30) }) : shortText(c.reason, 90)}
                </div>
              ))}
            </div>
          )}
          {cmp && !cmp.comparable && <div style={S.dim}>{t("assistant.eval.notComparable")}</div>}
          {cmp?.comparable && (
            <div data-testid="assistant-eval-diff">
              {cmp.modelChanged && <div data-testid="assistant-eval-model-changed">{t("assistant.eval.modelChanged", { from: prev?.modelVersion ?? prev?.modelId ?? "?", to: latest.modelVersion ?? latest.modelId ?? "?" })}</div>}
              {cmp.regressed.length === 0 && cmp.fixed.length === 0 ? (
                <div style={S.dim}>{t("assistant.eval.noDiff")}</div>
              ) : (
                <>
                  {cmp.regressed.length > 0 && <div style={S.fail} data-testid="assistant-eval-regressed">{t("assistant.eval.regressed", { ids: cmp.regressed.join(", ") })}</div>}
                  {cmp.fixed.length > 0 && <div data-testid="assistant-eval-fixed">{t("assistant.eval.fixed", { ids: cmp.fixed.join(", ") })}</div>}
                </>
              )}
            </div>
          )}
        </div>
      )}
      {runs.length === 0 && !progress && <div style={S.dim} data-testid="assistant-eval-none">{t("assistant.eval.none")}</div>}
      <div style={S.dim}>{t("assistant.eval.suite", { v: EVAL_SUITE_VERSION })}</div>
    </div>
  );
}

const S: Record<string, CSSProperties> = {
  box: { display: "flex", flexDirection: "column", gap: 4, borderTop: "1px solid #3a3b3f", paddingTop: 6 },
  title: { fontWeight: 700 },
  dim: { color: "#9aa0a6" },
  err: { color: "#f28b82" },
  fail: { color: "#fdd663", overflowWrap: "anywhere" },
  row: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" },
  btn: { fontSize: 12, padding: "2px 8px", cursor: "pointer" },
};
