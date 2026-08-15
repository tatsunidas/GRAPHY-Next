/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 解析タスクのステップ・レール（`fw/angio-design.md` §21.2 / §21.6・A13-1）。
 *
 * <p>段の一覧を縦に並べ、状態（未実施 / 実施中 / 済 / **飛ばした** / 実施不可）を出す。
 * 段を押すと対応する節へスクロールし、「この段からやり直す」で手修正を段単位で戻せる。
 *
 * <h3>🚨 `skipped` を `done` と同じ見た目にしないこと</h3>
 * 参照製品のキャプチャは全段が緑チェックだが、**「やった」と「飛ばした」が同じ見た目**になると、
 * 未校正のまま出た px の数値が「承認済み」に見える。ここでは:
 * - `done` … 緑・✓
 * - `skipped` … 琥珀・**⤼（飛ばした）＋理由**
 * - `invalid` … 赤・**✕＋理由**
 * と、記号・色・文言の 3 つを揃えて分けている（色だけで区別しない＝色覚特性に依存しない）。
 */
import { useI18n } from "../i18n/i18n";
import type { TaskStep, TaskStepState } from "./xaTasks";

/** 状態ごとの見た目。記号は色が見えなくても区別が付くものにする。 */
const LOOK: Record<TaskStepState, { mark: string; color: string; weight: number }> = {
  todo: { mark: "○", color: "#98a7b5", weight: 400 },
  active: { mark: "▶", color: "#2f6f9f", weight: 600 },
  done: { mark: "✓", color: "#3f8f6f", weight: 500 },
  skipped: { mark: "⤼", color: "#a5642a", weight: 500 },
  invalid: { mark: "✕", color: "#b3452f", weight: 600 },
};

export function TaskStepRail({
  steps,
  onGo,
  onRedo,
}: {
  steps: readonly TaskStep[];
  /** 段を選んだ（＝その節へスクロールする）。 */
  onGo: (id: string) => void;
  /** その段からやり直す（＝`clearedBy(id)` の手修正を捨てて再解析）。 */
  onRedo: (id: string) => void;
}) {
  const { t } = useI18n();
  return (
    <div style={rail} data-testid="xa-step-rail">
      <div style={railTitle}>{t("xa.step.title")}</div>
      {steps.map((s, i) => {
        const look = LOOK[s.state];
        return (
          <div
            key={s.id}
            style={item}
            data-testid={`xa-step-${s.id}`}
            // 実機検証と、目視での状態確認の両方で使う。**色ではなくこの属性で判定する**。
            data-state={s.state}
          >
            <button style={itemBtn} onClick={() => onGo(s.id)} title={t("xa.step.go")}>
              <span style={{ ...mark, color: look.color }}>{look.mark}</span>
              <span style={{ ...labelText, fontWeight: look.weight, color: look.color }}>
                {i + 1}. {t(s.labelKey)}
              </span>
            </button>
            {s.note && (
              <div style={noteText} data-testid={`xa-step-note-${s.id}`}>
                {t(s.note.key, s.note.params)}
              </div>
            )}
            {s.reasonKey && (
              <div style={{ ...noteText, color: look.color }} data-testid={`xa-step-reason-${s.id}`}>
                {t(s.reasonKey)}
              </div>
            )}
            {s.clears.length > 0 && s.state === "done" && (
              <button
                style={redoBtn}
                data-testid={`xa-step-redo-${s.id}`}
                onClick={() => onRedo(s.id)}
                title={t("xa.step.redoTitle")}
              >
                {t("xa.step.redo")}
              </button>
            )}
          </div>
        );
      })}
      <div style={legend}>{t("xa.step.legend")}</div>
    </div>
  );
}

const rail: React.CSSProperties = {
  flex: "0 0 178px",
  alignSelf: "flex-start",
  position: "sticky",
  top: 0,
  border: "1px solid #d5dde4",
  borderRadius: 4,
  padding: "8px 8px 6px",
  background: "#fbfcfd",
};
const railTitle: React.CSSProperties = { fontSize: 11, fontWeight: 600, color: "#44586a", marginBottom: 6 };
const item: React.CSSProperties = { marginBottom: 6 };
const itemBtn: React.CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  gap: 6,
  width: "100%",
  padding: 0,
  background: "none",
  border: "none",
  cursor: "pointer",
  textAlign: "left",
};
const mark: React.CSSProperties = { fontSize: 12, width: 12, flex: "0 0 12px" };
const labelText: React.CSSProperties = { fontSize: 12, lineHeight: 1.3 };
const noteText: React.CSSProperties = { fontSize: 10, color: "#66788a", marginLeft: 18, lineHeight: 1.35 };
const redoBtn: React.CSSProperties = {
  marginLeft: 18,
  marginTop: 2,
  padding: "1px 6px",
  fontSize: 10,
  background: "#e6ecf1",
  border: "1px solid #c3ced9",
  borderRadius: 3,
  cursor: "pointer",
};
const legend: React.CSSProperties = {
  fontSize: 10,
  color: "#66788a",
  borderTop: "1px solid #e2e8ee",
  paddingTop: 5,
  marginTop: 2,
  lineHeight: 1.4,
};
