/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 保管庫の表示状態（GSPS）を選んで、いま開いている画像へ適用するダイアログ。
 * 設計 `fw/angio-design.md` §14.1（A10 の読み込み側）。
 *
 * <h3>🚨 「適用しました」だけを出さない</h3>
 * 他社の GSPS には、こちらが解釈しない項目（LUT で書かれた VOI・Display Shutter・
 * DISPLAY 単位の図形）が普通に入っている。**何を当てて・何を当てなかったか**を並べて出す。
 * 黙って落とすと、利用者は元と違う絵を**元どおりだと思って**読む。
 */
import { useEffect, useState } from "react";

import {
  fetchInstances,
  fetchSeries,
  fetchXaPresentationState,
  type XaPresentationState,
} from "../api";
import { useI18n } from "../i18n/i18n";
import { appliedItems, planPresentation, type PresentationPlan } from "./xaPresentationApply";
import { viewerOverlayProps } from "./viewerOverlay";

/** 一覧に出す 1 件。 */
interface Candidate {
  state: XaPresentationState;
  plan: PresentationPlan;
}

export function XaPresentationDialog({
  studyUid,
  sopInstanceUid,
  frameCount,
  onApply,
  onClose,
}: {
  studyUid: string;
  /** いま表示しているネイティブフレームの元インスタンス。 */
  sopInstanceUid: string | null;
  frameCount: number;
  onApply: (plan: PresentationPlan, state: XaPresentationState) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [items, setItems] = useState<Candidate[]>([]);
  const [applied, setApplied] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      const series = await fetchSeries(studyUid);
      // Modality PR ＝ 表示状態。SOP クラスが取れない経路（web の QIDO）もあるので Modality で拾う。
      const prSeries = series.filter((s) => s.modality === "PR");
      const found: Candidate[] = [];
      for (const s of prSeries) {
        const instances = await fetchInstances(studyUid, s.seriesInstanceUid);
        for (const inst of instances) {
          try {
            const state = await fetchXaPresentationState(inst.sopInstanceUid);
            found.push({ state, plan: planPresentation(state, sopInstanceUid ?? "", frameCount) });
          } catch {
            // 読めないもの（11.2/11.3 など解釈しない表示状態）は一覧から落とす。
            // 🚨 ただし「0 件」と「読めなかった」を同じ顔にしないため、件数は下に出す。
          }
        }
      }
      if (!cancelled) {
        setItems(found);
        setLoading(false);
      }
    })().catch(() => {
      if (!cancelled) {
        setError(t("xa.pr.loadFailed"));
        setLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [studyUid, sopInstanceUid, frameCount, t]);

  const apply = (c: Candidate) => {
    onApply(c.plan, c.state);
    setApplied(c.state.sopInstanceUid);
  };

  const matching = items.filter((c) => c.plan.matchesImage);
  const others = items.filter((c) => !c.plan.matchesImage);

  return (
    <div style={backdrop} role="dialog" aria-modal="true" data-testid="xa-pr-dialog" {...viewerOverlayProps}>
      <div style={panel}>
        <div style={header}>
          <b>{t("xa.pr.title")}</b>
          <button style={btn} data-testid="xa-pr-close" onClick={onClose}>
            {t("common.close")}
          </button>
        </div>

        {loading && <div style={hint}>{t("common.loading")}</div>}
        {error && <div style={errBox}>{error}</div>}

        {!loading && !error && matching.length === 0 && (
          <div style={hint} data-testid="xa-pr-empty">
            {t("xa.pr.noneForImage")}
            {others.length > 0 && ` ${t("xa.pr.othersExist", { count: others.length })}`}
          </div>
        )}

        {matching.map((c) => {
          const items2 = appliedItems(c.plan);
          return (
            <div key={c.state.sopInstanceUid} style={row} data-testid="xa-pr-item">
              <div style={{ flex: 1 }}>
                <div>
                  <b>{c.state.label || "(no label)"}</b>
                  {c.state.description ? ` — ${c.state.description}` : ""}
                </div>
                <div style={hint}>
                  {/* 何が当たるかを**押す前に**出す。押してから知るのでは遅い。 */}
                  {items2.length > 0
                    ? t("xa.pr.willApply", { items: items2.map((k) => t(`xa.pr.item.${k}`)).join(" / ") })
                    : t("xa.pr.willApplyNothing")}
                </div>
                {c.plan.unapplied.length > 0 && (
                  <div style={warn} data-testid="xa-pr-unapplied">
                    ⚠️{" "}
                    {t("xa.pr.notApplied", {
                      items: c.plan.unapplied.map((k) => t(`xa.pr.unapplied.${k}`)).join(" / "),
                    })}
                  </div>
                )}
              </div>
              <button
                style={btn}
                data-testid={`xa-pr-apply-${c.state.sopInstanceUid}`}
                onClick={() => apply(c)}
              >
                {applied === c.state.sopInstanceUid ? t("xa.pr.applied") : t("xa.pr.apply")}
              </button>
            </div>
          );
        })}

        {/* 参照先が違うものは**当てられない**。存在は見せるが押させない（別の画像の状態を
            当てると、見た目は変わるのに意味が無い絵になる）。 */}
        {others.length > 0 && (
          <div style={hint} data-testid="xa-pr-others">
            {t("xa.pr.othersExist", { count: others.length })}
          </div>
        )}
      </div>
    </div>
  );
}

const backdrop: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.35)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 60,
};
const panel: React.CSSProperties = {
  width: 620,
  maxHeight: "80vh",
  overflow: "auto",
  background: "#fff",
  borderRadius: 8,
  padding: 14,
  boxShadow: "0 6px 24px rgba(0,0,0,0.25)",
};
const header: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  marginBottom: 10,
};
const row: React.CSSProperties = {
  display: "flex",
  gap: 10,
  alignItems: "flex-start",
  padding: "8px 0",
  borderTop: "1px solid #e6ebf0",
};
const btn: React.CSSProperties = {
  padding: "4px 10px",
  border: "1px solid #cdd5de",
  borderRadius: 5,
  background: "#fff",
  cursor: "pointer",
};
const hint: React.CSSProperties = { fontSize: 12, color: "#5a6b7a", marginTop: 2 };
const warn: React.CSSProperties = { fontSize: 12, color: "#8a6d3b", marginTop: 2 };
const errBox: React.CSSProperties = {
  padding: 8,
  background: "#fff4f4",
  border: "1px solid #f0d0d0",
  borderRadius: 6,
  fontSize: 12,
  color: "#a11",
};
