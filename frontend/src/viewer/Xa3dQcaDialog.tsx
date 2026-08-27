/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 3D QCA（2 方向から 3D 中心線を作る・A6a）のダイアログ。
 * `fw/angio-design.md` §10.1 / §10.2。計算は `xaRecon3d.ts`（純関数）にあり、ここは UI だけ。
 *
 * <h3>使い方の前提</h3>
 * **各方向で先に 2D QCA を走らせる。** その結果が `xaRecon3dStore` に溜まり、ここで 2 つ選ぶ。
 * 2 方向を同時に画面へ出す UI を作るより、既存の導線（中心線抽出・手修正・校正）をそのまま
 * 使えるほうが良い、という判断（§10.2 の実装メモ）。
 *
 * <h3>🚨 「アンカー」を任意項目のように見せないこと</h3>
 * 端点 2 つだけでは**角度補正が退化して掛けられない**（§10.2.2）。補正が掛からないと
 * 装置の機械誤差（2〜3°）がそのまま形の歪みになるのに、**再投影誤差は閾値を通る**。
 * だからステップ・レールでは端点だけの状態を `done` ではなく **`skipped`** にしてある。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { createQca3dSr } from "../api";
import { desktop } from "../desktopBridge";
import { publishAnalysisResult } from "../report/analysisResultStore";
import { qca3dRecord } from "../report/xaAnalysisRecords";
import { writeGeometry3dContext } from "../viewer3d/geometry3dContext";
import { useI18n } from "../i18n/i18n";
import { publishXa3dSnapshot } from "./debugApi";
import { formatViewAngles, type Vec3, viewSeparationDeg } from "./xaGeometry";
import {
  type CrossSectionProfile,
  type ReconAnchor,
  type Recon3DResult,
  type Stenosis3DResult,
  type WorkingAngleSuggestion,
  type XaCenterline2D,
  fuseDiameterProfile,
  reconstructWithRefinement,
  stenosis3d,
  suggestWorkingAngles,
  type GeometryRefinement,
} from "./xaRecon3d";
import { type XaQcaRun, useQcaRuns } from "./xaRecon3dStore";
import { TaskStepRail } from "./TaskStepRail";
import { deriveQca3dSteps } from "./xaTasks";

const MIN_SEPARATION_DEG = 30;

/** 中心線の点番号で持つアンカー（画素は再構成時に引く）。 */
interface AnchorPick {
  ia: number;
  ib: number;
}

export function Xa3dQcaDialog({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const runs = useQcaRuns();
  const [keyA, setKeyA] = useState<string>("");
  const [keyB, setKeyB] = useState<string>("");
  const [anchors, setAnchors] = useState<AnchorPick[]>([]);
  /** アンカーを打つ途中（A を選んだが B がまだ）。 */
  const [pendingA, setPendingA] = useState<number | null>(null);
  const [result, setResult] = useState<Recon3DResult | null>(null);
  const [refinement, setRefinement] = useState<GeometryRefinement | null>(null);
  const [profile, setProfile] = useState<CrossSectionProfile | null>(null);
  const [suggestions, setSuggestions] = useState<WorkingAngleSuggestion[]>([]);
  const [stenosis, setStenosis] = useState<Stenosis3DResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);

  // 🚨 鍵は runKey（同じフレームでも解析区間が違えば別の登録・§21.4 の分岐部で必要になった）。
  const runA = runs.find((r) => r.runKey === keyA) ?? null;
  const runB = runs.find((r) => r.runKey === keyB) ?? null;

  /**
   * 合成に使った 2 方向の径を**何で測ったか**（§16.5）。
   * 🚨 片方が半値法・片方が密度計測なら断面積は**どちらの意味でもない**ので `"mixed"`。
   * 画面の注記・SR・DEV スナップショットで**同じ値**を使う（別々に導出すると食い違う）。
   */
  const diameterMethod = useMemo<"half-max" | "densitometric" | "mixed" | null>(
    () =>
      runA && runB
        ? runA.diameterMethod === runB.diameterMethod
          ? runA.diameterMethod
          : "mixed"
        : ((runA ?? runB)?.diameterMethod ?? null),
    [runA, runB],
  );

  const separationDeg = useMemo(
    () => (runA && runB ? viewSeparationDeg(runA.geometry, runB.geometry) : null),
    [runA, runB],
  );

  /** 端点は常にアンカー（＝同じ場所から同じ場所まで辿ることを要求している）。 */
  const anchorList = useMemo((): ReconAnchor[] => {
    if (!runA || !runB) return [];
    const ends: ReconAnchor[] = [
      { pixelA: runA.centerline[0], pixelB: runB.centerline[0] },
      {
        pixelA: runA.centerline[runA.centerline.length - 1],
        pixelB: runB.centerline[runB.centerline.length - 1],
      },
    ];
    const picked = anchors
      .filter((a) => runA.centerline[a.ia] && runB.centerline[a.ib])
      .map((a) => ({ pixelA: runA.centerline[a.ia], pixelB: runB.centerline[a.ib] }));
    return [...ends, ...picked];
  }, [runA, runB, anchors]);

  const reset = () => {
    setResult(null);
    setRefinement(null);
    setProfile(null);
    setSuggestions([]);
    setStenosis(null);
    setSaved(null);
    setError(null);
  };

  const pickView = (side: "a" | "b", key: string) => {
    // 方向を選び直すとアンカーは別の画素座標を指すので捨てる（QCA3D_STEPS の `clears` と同じ）。
    if (side === "a") setKeyA(key);
    else setKeyB(key);
    setAnchors([]);
    setPendingA(null);
    reset();
  };

  const run = () => {
    if (!runA || !runB) return;
    const a: XaCenterline2D = { geometry: runA.geometry, points: runA.centerline };
    const b: XaCenterline2D = { geometry: runB.geometry, points: runB.centerline };
    const { result: r, refinement: ref } = reconstructWithRefinement(a, b, {
      anchors: anchorList,
      minSeparationDeg: MIN_SEPARATION_DEG,
    });
    if (!r) {
      reset();
      setError(t("xa3d.failed"));
      return;
    }
    setError(null);
    setResult(r);
    setRefinement(ref);
    // 断面の合成（§10.2.5）。未校正なら `unavailable` が立って何も出さない。
    const geomB = ref?.geometryB ?? runB.geometry;
    const sections = fuseDiameterProfile(
        r.points,
        {
          geometry: runA.geometry,
          profile: {
            diameters: runA.diameters,
            pathIndices: runA.diameterPathIndices,
            pointCount: runA.centerline.length,
            unit: runA.unit,
          },
        },
        {
          geometry: geomB,
          profile: {
            diameters: runB.diameters,
            pathIndices: runB.diameterPathIndices,
            pointCount: runB.centerline.length,
            unit: runB.unit,
          },
        },
        r.match,
      );
    setProfile(sections);
    // 3D の狭窄率。断面が出せていなければ null（無理に出さない）。
    const st = sections.unavailable ? null : stenosis3d(r.points, sections);
    setStenosis(st);
    // 「次はどの角度で撮ると短縮が少ないか」。3D が一度取れて初めて言えること。
    setSuggestions(suggestWorkingAngles(r.points, runA.geometry, { stepDeg: 5, count: 3 }));

    // レポートへ差し込めるように登録する（A14）。品質基準を満たした結果だけ。
    if (r.acceptable && runA.sopInstanceUid && runB.sopInstanceUid) {
      publishAnalysisResult(
        qca3dRecord(
          {
            studyUid: runA.studyUid,
            seriesUid: runA.seriesUid,
            viewASopInstanceUid: runA.sopInstanceUid,
            viewBSopInstanceUid: runB.sopInstanceUid,
            viewALabel: runA.label,
            viewBLabel: runB.label,
            separationDeg: r.separationDeg,
            anchorCount: r.anchorCount,
            anchorReprojectionPx: r.anchorReprojectionPx,
            angleCorrected: ref != null,
            lengthMm: r.lengthMm,
            minEquivalentDiameterMm: sections.unavailable ? null : (sections.minEquivalentDiameterMm ?? null),
            percentDiameterStenosis: st?.percentDiameterStenosis ?? null,
            visibleFractionA: r.foreshortening.a?.visibleFraction ?? null,
            visibleFractionB: r.foreshortening.b?.visibleFraction ?? null,
          },
          t,
        ),
      );
    }
  };

  /** 保存できるのは、2 方向とも元インスタンスが分かっていて、結果が品質基準を満たすとき。 */
  const canSave = !!(runA?.sopInstanceUid && runB?.sopInstanceUid && result?.acceptable);

  const save = () => {
    if (!runA?.sopInstanceUid || !runB?.sopInstanceUid || !result) return;
    setSaving(true);
    setError(null);
    createQca3dSr({
      studyInstanceUid: runA.studyUid,
      seriesInstanceUid: runA.seriesUid,
      viewASopInstanceUid: runA.sopInstanceUid,
      // DICOM のフレーム番号は 1 origin。
      viewAFrameNumber: runA.frameIndex + 1,
      viewBSopInstanceUid: runB.sopInstanceUid,
      viewBFrameNumber: runB.frameIndex + 1,
      separationDeg: result.separationDeg,
      anchorCount: result.anchorCount,
      anchorReprojectionPx: result.anchorReprojectionPx,
      angleCorrected: refinement != null,
      lengthMm: result.lengthMm,
      // 🚨 未校正なら断面は送らない（px の径から作った mm² を保存しない）。
      minAreaMm2: profile?.unavailable ? null : (profile?.minAreaMm2 ?? null),
      minEquivalentDiameterMm: profile?.unavailable ? null : (profile?.minEquivalentDiameterMm ?? null),
      visibleFractionA: result.foreshortening.a?.visibleFraction ?? null,
      visibleFractionB: result.foreshortening.b?.visibleFraction ?? null,
      calibration: profile?.unavailable ? null : `${runA.label} / ${runB.label}`,
      // 🚨 測り方を落とさない。SR の注記（系統誤差の書き方）がこれで変わる（§16.5）。
      diameterMethod,
      percentDiameterStenosis: stenosis?.percentDiameterStenosis ?? null,
      percentAreaStenosis: stenosis?.percentAreaStenosis ?? null,
      mldMm: stenosis?.mldMm ?? null,
      rvdMm: stenosis?.rvdMm ?? null,
      lesionLengthMm: stenosis?.lesionLengthMm ?? null,
    })
      .then((r) => setSaved(t("xa3d.saved", { uid: shortUid(r.sopInstanceUid) })))
      .catch(() => setError(t("xa3d.saveFailed")))
      .finally(() => setSaving(false));
  };

  const steps = deriveQca3dSteps({
    viewCount: (runA ? 1 : 0) + (runB ? 1 : 0),
    separationDeg,
    minSeparationDeg: MIN_SEPARATION_DEG,
    anchorCount: anchorList.length,
    hasResult: result != null,
    acceptable: result?.acceptable ?? false,
    blockingWarning: result?.warnings.find((w) => w.blocking)?.code ?? null,
    refined: refinement != null,
    canSave,
    saved: saved != null,
  });

  // 実機検証（automator）が数値で突き合わせられるように公開する。DEV 以外では何もしない。
  // ⚠️ 描画中に副作用を起こさない（React の規約）。依存配列を付けないのは、
  //    どの状態が変わっても最新を publish したいため（DEV 限定の軽い処理）。
  useEffect(() => {
    publishXa3dSnapshot({
      viewCount: (runA ? 1 : 0) + (runB ? 1 : 0),
      anglesA: runA ? { primary: runA.geometry.primaryAngleDeg, secondary: runA.geometry.secondaryAngleDeg } : null,
      anglesB: runB ? { primary: runB.geometry.primaryAngleDeg, secondary: runB.geometry.secondaryAngleDeg } : null,
      separationDeg,
      // 🚨 2 方向の測り方が違うまま合成したら、その事実を出す（"mixed"）。
      //    片方が半値法・片方が密度計測だと、断面積は**どちらの意味でもない**。
      diameterMethod,
      pointsA: runA?.centerline.length ?? 0,
      pointsB: runB?.centerline.length ?? 0,
      anchorCount: anchorList.length,
      result: result
        ? {
            acceptable: result.acceptable,
            lengthMm: result.lengthMm,
            anchorReprojectionPx: result.anchorReprojectionPx,
            matchReprojectionPx: result.matchReprojectionPx,
            separationDeg: result.separationDeg,
            points: result.points.length,
            warnings: result.warnings.map((w) => ({ ...w })),
            firstPoint: [...result.points[0]] as [number, number, number],
            lastPoint: [...result.points[result.points.length - 1]] as [number, number, number],
            visibleFractionA: result.foreshortening.a?.visibleFraction ?? null,
            visibleFractionB: result.foreshortening.b?.visibleFraction ?? null,
          }
        : null,
      section: profile
        ? {
            unavailable: profile.unavailable,
            minAreaMm2: profile.minAreaMm2,
            minEquivalentDiameterMm: profile.minEquivalentDiameterMm,
            medianMeasurementAngleDeg: profile.medianMeasurementAngleDeg,
          }
        : null,
        stenosis: stenosis
        ? {
            percentDiameterStenosis: stenosis.percentDiameterStenosis,
            percentAreaStenosis: stenosis.percentAreaStenosis,
            mldMm: stenosis.mldMm,
            rvdMm: stenosis.rvdMm,
            lesionLengthMm: stenosis.lesionLengthMm,
            profileNoiseMm: stenosis.profileNoiseMm,
          }
        : null,
      workingAngles: suggestions.map((x) => ({
        primary: x.primaryAngleDeg,
        secondary: x.secondaryAngleDeg,
        visibleFraction: x.visibleFraction,
      })),
      refinement: refinement
        ? {
            beforePx: refinement.beforePx,
            afterPx: refinement.afterPx,
            primary: refinement.offsetDeg.primary,
            secondary: refinement.offsetDeg.secondary,
          }
        : null,
      steps: Object.fromEntries(steps.map((s) => [s.id, s.state])),
    });
  });

  const goToStep = (id: string) => {
    document.querySelector(`[data-step~="${id}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  };
  const redoFrom = (id: string) => {
    if (id === "views") {
      setKeyA("");
      setKeyB("");
    }
    setAnchors([]);
    setPendingA(null);
    reset();
  };

  return (
    <div style={backdrop} onMouseDown={onClose}>
      <div style={panel} onMouseDown={(e) => e.stopPropagation()} data-testid="xa3d-dialog">
        <div style={title}>{t("xa3d.title")}</div>
        <div style={body}>
          <div style={content}>
            {/* ── 方向の選択 ───────────────────────────────── */}
            <div style={section} data-step="views">
              <div style={sectionTitle}>{t("xa3d.views")}</div>
              {runs.length < 2 ? (
                <div style={hint} data-testid="xa3d-need-runs">
                  {t("xa3d.needRuns")}
                </div>
              ) : null}
              <div style={row}>
                <label style={label}>
                  {t("xa3d.viewA")}
                  <select
                    style={select}
                    value={keyA}
                    data-testid="xa3d-view-a"
                    onChange={(e) => pickView("a", e.target.value)}
                  >
                    <option value="">—</option>
                    {runs.map((r) => (
                      <option key={r.runKey} value={r.runKey}>
                        {r.label}
                        {r.edited ? " *" : ""}
                      </option>
                    ))}
                  </select>
                </label>
                <label style={label}>
                  {t("xa3d.viewB")}
                  <select
                    style={select}
                    value={keyB}
                    data-testid="xa3d-view-b"
                    onChange={(e) => pickView("b", e.target.value)}
                  >
                    <option value="">—</option>
                    {runs
                      .filter((r) => r.imageId !== keyA)
                      .map((r) => (
                        <option key={r.runKey} value={r.runKey}>
                          {r.label}
                          {r.edited ? " *" : ""}
                        </option>
                      ))}
                  </select>
                </label>
              </div>
              {separationDeg != null ? (
                <div style={row}>
                  <span style={metric} data-testid="xa3d-separation">
                    {t("xa3d.separation")}: <b>{separationDeg.toFixed(1)}°</b>
                  </span>
                  {separationDeg < MIN_SEPARATION_DEG ? (
                    <span style={bad}>{t("xa3d.warn.insufficientSeparation", { min: String(MIN_SEPARATION_DEG) })}</span>
                  ) : null}
                </div>
              ) : null}
            </div>

            {/* ── アンカー ─────────────────────────────────── */}
            <div style={section} data-step="anchors">
              <div style={sectionTitle}>{t("xa3d.anchors")}</div>
              <div style={hint}>{t("xa3d.anchorHelp")}</div>
              {runA && runB ? (
                <>
                  <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
                    <CenterlineCanvas
                      run={runA}
                      testId="xa3d-curve-a"
                      highlighted={pendingA}
                      anchors={anchors.map((a) => a.ia)}
                      onPick={(i) => setPendingA(i)}
                    />
                    <CenterlineCanvas
                      run={runB}
                      testId="xa3d-curve-b"
                      highlighted={null}
                      anchors={anchors.map((a) => a.ib)}
                      onPick={(i) => {
                        if (pendingA == null) return;
                        setAnchors((prev) => [...prev, { ia: pendingA, ib: i }]);
                        setPendingA(null);
                        reset();
                      }}
                    />
                  </div>
                  <div style={row}>
                    <span style={metric} data-testid="xa3d-anchor-count">
                      {t("xa3d.anchorCount", { n: String(anchorList.length) })}
                    </span>
                    {anchorList.length < 3 ? <span style={warn}>{t("xa3d.warn.tooFewAnchors")}</span> : null}
                    <button
                      style={btn}
                      data-testid="xa3d-anchor-clear"
                      disabled={anchors.length === 0}
                      onClick={() => {
                        setAnchors([]);
                        setPendingA(null);
                        reset();
                      }}
                    >
                      {t("xa3d.clearAnchors")}
                    </button>
                  </div>
                </>
              ) : null}
            </div>

            {/* ── 再構成 ───────────────────────────────────── */}
            <div style={section} data-step="recon">
              <div style={sectionTitle}>{t("xa3d.recon")}</div>
              <div style={row}>
                <button style={primaryBtn} disabled={!runA || !runB} data-testid="xa3d-run" onClick={run}>
                  {t("xa3d.run")}
                </button>
                {error ? <span style={bad}>{error}</span> : null}
              </div>
              {result ? (
                <ResultPanel
                  result={result}
                  refinement={refinement}
                  profile={profile}
                  suggestions={suggestions}
                  stenosis={stenosis}
                  diameterMethod={diameterMethod}
                />
              ) : null}
            </div>

            {/* ── 保存 ─────────────────────────────────────── */}
            {result ? (
              <div style={section} data-step="save">
                <div style={sectionTitle}>{t("xa3d.save")}</div>
                <div style={row}>
                  <button style={btn} data-testid="xa3d-save" disabled={!canSave || saving} onClick={save}>
                    {saving ? t("xa3d.saving") : t("xa3d.saveSr")}
                  </button>
                  {saved ? (
                    <span style={metric} data-testid="xa3d-saved">
                      {saved}
                    </span>
                  ) : null}
                </div>
                <div style={hint}>{t("xa3d.saveHint")}</div>
              </div>
            ) : null}

            {/* ── 3D 表示 ──────────────────────────────────── */}
            {result?.acceptable ? (
              <div style={section} data-step="recon">
                <div style={sectionTitle}>{t("xa3d.preview")}</div>
                <Preview3D points={result.points} />
                <div style={row}>
                  <button
                    style={btn}
                    data-testid="xa3d-open-3d"
                    onClick={() => {
                      writeGeometry3dContext({
                        kind: "xa-qca3d",
                        name: `3D QCA — ${runA?.label ?? ""} / ${runB?.label ?? ""}`,
                        centerlineLps: result.points.map((p) => [p[0], p[1], p[2]]),
                        info: {
                          lengthMm: result.lengthMm,
                          percentDiameterStenosis: stenosis?.percentDiameterStenosis,
                          minEquivalentDiameterMm: profile?.unavailable
                            ? undefined
                            : (profile?.minEquivalentDiameterMm ?? undefined),
                          angleCorrected: refinement != null,
                          visibleFractionA: result.foreshortening.a?.visibleFraction,
                          visibleFractionB: result.foreshortening.b?.visibleFraction,
                        },
                      });
                      // desktop は専用ウィンドウ（位置記憶つき）、web は named target のタブ。
                      const d = desktop();
                      if (d?.openViewer) void d.openViewer("geometry3d");
                      else window.open(`${window.location.pathname}#geometry3d`, "graphy-geometry3d");
                    }}
                  >
                    {t("xa3d.open3d")}
                  </button>
                  <span style={faint}>{t("xa3d.open3dHint")}</span>
                </div>
              </div>
            ) : null}
          </div>
          <TaskStepRail steps={steps} onGo={goToStep} onRedo={redoFrom} />
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 8 }}>
          <button style={btn} onClick={onClose}>
            {t("common.close")}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 結果                                                                */
/* ------------------------------------------------------------------ */

function ResultPanel({
  result,
  refinement,
  profile,
  suggestions,
  stenosis,
  diameterMethod,
}: {
  result: Recon3DResult;
  refinement: GeometryRefinement | null;
  profile: CrossSectionProfile | null;
  suggestions: readonly WorkingAngleSuggestion[];
  stenosis: Stenosis3DResult | null;
  /** 合成した 2 方向の径の測り方。注記がこれで変わる（§16.5）。 */
  diameterMethod: "half-max" | "densitometric" | "mixed" | null;
}) {
  const { t } = useI18n();
  return (
    <div style={{ marginTop: 8 }} data-testid="xa3d-result" data-acceptable={result.acceptable ? "1" : "0"}>
      <div style={row}>
        <span style={metric} data-testid="xa3d-length">
          {t("xa3d.length")}: <b>{result.lengthMm.toFixed(1)} mm</b>
        </span>
        <span style={metric} data-testid="xa3d-anchor-reproj">
          {t("xa3d.anchorReprojection")}: <b>{fmt(result.anchorReprojectionPx)} px</b>
        </span>
      </div>
      {refinement ? (
        <div style={row}>
          <span style={metric} data-testid="xa3d-refinement">
            {t("xa3d.refined", {
              before: fmt(refinement.beforePx),
              after: fmt(refinement.afterPx),
              dp: refinement.offsetDeg.primary.toFixed(2),
              ds: refinement.offsetDeg.secondary.toFixed(2),
            })}
          </span>
        </div>
      ) : (
        <div style={row}>
          <span style={warn} data-testid="xa3d-not-refined">
            {t("xa3d.notRefined")}
          </span>
        </div>
      )}
      {/* 🚨 参考値であることを書く。ここを品質の根拠だと読まれるのが一番まずい（§10.2.2）。 */}
      <div style={row}>
        <span style={faint} data-testid="xa3d-match-reproj">
          {t("xa3d.matchReprojection", { px: fmt(result.matchReprojectionPx) })}
        </span>
      </div>
      {result.warnings.map((w) => (
        <div key={w.code} style={row}>
          <span
            style={w.blocking ? bad : warn}
            data-testid={`xa3d-warn-${w.code}`}
            data-blocking={w.blocking ? "1" : "0"}
          >
            {t(`xa3d.warn.${w.code}`, { value: fmt(w.value), threshold: fmt(w.threshold) })}
          </span>
        </div>
      ))}
      {/* ── 短縮（精度を一番左右する。§10.3.1）───────────────── */}
      <div style={row}>
        <span style={metric} data-testid="xa3d-foreshortening">
          {t("xa3d.foreshortening")}: A <b>{pct(result.foreshortening.a?.visibleFraction)}</b> / B{" "}
          <b>{pct(result.foreshortening.b?.visibleFraction)}</b>
        </span>
      </div>
      {suggestions.length > 0 ? (
        <div style={row}>
          <span style={faint} data-testid="xa3d-working-angles">
            {t("xa3d.workingAngles", {
              list: suggestions
                .map((s) => `${formatViewAngles(s.primaryAngleDeg, s.secondaryAngleDeg)} (${pct(s.visibleFraction)})`)
                .join(" / "),
            })}
          </span>
        </div>
      ) : null}

      {/* ── 断面（§10.2.6）と狭窄率 ─────────────────────────── */}
      {profile ? <CrossSectionPanel profile={profile} diameterMethod={diameterMethod} /> : null}
      {stenosis ? (
        <>
          <div style={row}>
            <span style={metric} data-testid="xa3d-percent-ds">
              {t("xa3d.percentDiameterStenosis")}: <b>{stenosis.percentDiameterStenosis.toFixed(1)} %</b>
            </span>
            <span style={metric} data-testid="xa3d-percent-as">
              {t("xa3d.percentAreaStenosis")}: <b>{stenosis.percentAreaStenosis.toFixed(1)} %</b>
            </span>
          </div>
          <div style={row}>
            <span style={metric} data-testid="xa3d-mld">
              MLD <b>{fmt(stenosis.mldMm)} mm</b> / RVD <b>{fmt(stenosis.rvdMm)} mm</b> /{" "}
              {t("xa3d.lesionLength")} <b>{fmt(stenosis.lesionLengthMm)} mm</b>
            </span>
          </div>
          <div style={row}>
            <span style={faint}>{t("xa3d.stenosisNote")}</span>
          </div>
        </>
      ) : null}

      {/* 姿勢は復元できないことを結果画面に必ず出す（§10.3）。 */}
      <div style={row}>
        <span style={faint}>{t("xa3d.poseCaveat")}</span>
      </div>
    </div>
  );
}

function fmt(v: number): string {
  return Number.isFinite(v) ? v.toFixed(2) : "—";
}

function shortUid(uid: string): string {
  return uid.length > 12 ? `…${uid.slice(-12)}` : uid;
}

function pct(v: number | undefined): string {
  return v == null || !Number.isFinite(v) ? "—" : `${(v * 100).toFixed(0)}%`;
}

/** 3D 断面。**出せない条件を黙って埋めない**（§10.2.5）。 */
function CrossSectionPanel({
  profile,
  diameterMethod,
}: {
  profile: CrossSectionProfile;
  /** null（測り方が分からない）は**安全側**に半値法として扱う。 */
  diameterMethod: "half-max" | "densitometric" | "mixed" | null;
}) {
  const { t } = useI18n();
  if (profile.unavailable) {
    return (
      <div style={row}>
        <span style={warn} data-testid={`xa3d-section-unavailable-${profile.unavailable}`}>
          {t(`xa3d.section.unavailable.${profile.unavailable}`)}
        </span>
      </div>
    );
  }
  const angle = profile.medianMeasurementAngleDeg;
  return (
    <>
      <div style={row}>
        <span style={metric} data-testid="xa3d-min-area">
          {t("xa3d.minArea")}: <b>{fmt(profile.minAreaMm2 ?? NaN)} mm²</b>
        </span>
        <span style={metric} data-testid="xa3d-min-diameter">
          {t("xa3d.minEquivalentDiameter")}: <b>{fmt(profile.minEquivalentDiameterMm ?? NaN)} mm</b>
        </span>
      </div>
      <div style={row}>
        <span style={faint}>{t("xa3d.section.assumption", { deg: angle != null ? angle.toFixed(0) : "—" })}</span>
      </div>
      {angle != null && Math.abs(angle - 90) > 20 ? (
        <div style={row}>
          <span style={warn} data-testid="xa3d-section-oblique">
            {t("xa3d.section.oblique", { deg: angle.toFixed(0) })}
          </span>
        </div>
      ) : null}
      {/* 🔴 系統誤差を結果と同じ画面に出す。別ページの注記では読まれない。
          🚨 **測り方で内容が変わる**。密度計測（A4c）なら半値法の係数は乗らない（§16.5.1）。 */}
      <div style={row}>
        <span style={bad} data-testid="xa3d-section-bias">
          {t(
            diameterMethod === "densitometric"
              ? "xa3d.section.bias.densitometric"
              : diameterMethod === "mixed"
                ? "xa3d.section.bias.mixed"
                : "xa3d.section.bias",
          )}
        </span>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* 中心線のプレビュー（アンカー指定）                                   */
/* ------------------------------------------------------------------ */

const CURVE_W = 210;
const CURVE_H = 210;

/** 中心線を画素座標のまま等方に収めて描く（縦横比を変えない＝形が嘘にならない）。 */
function CenterlineCanvas({
  run,
  testId,
  highlighted,
  anchors,
  onPick,
}: {
  run: XaQcaRun;
  testId: string;
  highlighted: number | null;
  anchors: number[];
  onPick: (index: number) => void;
}) {
  const pts = run.centerline;
  const box = useMemo(() => {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const p of pts) {
      x0 = Math.min(x0, p[0]);
      x1 = Math.max(x1, p[0]);
      y0 = Math.min(y0, p[1]);
      y1 = Math.max(y1, p[1]);
    }
    const pad = 8;
    const scale = Math.min((CURVE_W - 2 * pad) / Math.max(1e-6, x1 - x0), (CURVE_H - 2 * pad) / Math.max(1e-6, y1 - y0));
    return { x0, y0, scale, pad };
  }, [pts]);

  const toScreen = (p: readonly [number, number]): [number, number] => [
    box.pad + (p[0] - box.x0) * box.scale,
    box.pad + (p[1] - box.y0) * box.scale,
  ];

  const click = (e: React.MouseEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const sx = e.clientX - r.left;
    const sy = e.clientY - r.top;
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < pts.length; i++) {
      const s = toScreen(pts[i]);
      const d = (s[0] - sx) ** 2 + (s[1] - sy) ** 2;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    onPick(best);
  };

  return (
    <svg
      width={CURVE_W}
      height={CURVE_H}
      data-testid={testId}
      style={{ background: "#e9eef3", border: "1px solid #d5dde4", borderRadius: 3, cursor: "crosshair" }}
      onClick={click}
    >
      <polyline points={pts.map((p) => toScreen(p).join(",")).join(" ")} fill="none" stroke="#2f6f9f" strokeWidth={1.6} />
      {/* 端点は常にアンカー。丸で明示する（「勝手に使われている」状態にしない）。 */}
      {[0, pts.length - 1].map((i) => {
        const s = toScreen(pts[i]);
        return <circle key={`end-${i}`} cx={s[0]} cy={s[1]} r={4} fill="none" stroke="#3f8f6f" strokeWidth={1.6} />;
      })}
      {anchors.map((i, k) => {
        const s = toScreen(pts[i] ?? pts[0]);
        return (
          <g key={`a-${k}`}>
            <circle cx={s[0]} cy={s[1]} r={4} fill="#a5642a" />
            <text x={s[0] + 6} y={s[1] - 4} fontSize={10} fill="#a5642a">
              {k + 1}
            </text>
          </g>
        );
      })}
      {highlighted != null && pts[highlighted] ? (
        <circle
          cx={toScreen(pts[highlighted])[0]}
          cy={toScreen(pts[highlighted])[1]}
          r={6}
          fill="none"
          stroke="#b3452f"
          strokeWidth={2}
        />
      ) : null}
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* 3D プレビュー                                                       */
/* ------------------------------------------------------------------ */

const PREVIEW = 260;

/**
 * 3D 中心線の簡易プレビュー（ドラッグで回転）。
 *
 * <p>ここで `viewer3d/`（VTK.js）を使っていないのは、あちらが**別ウィンドウ**（`#viewer3d`）で、
 * ボリュームを起点にシーンを組む作りになっているため。中心線だけを別ウィンドウへ渡す経路は
 * まだ無い（残件）。まずは結果を確認できることを優先した。
 *
 * <p>投影は正射影。**遠近感を付けない**のは、長さの見た目が歪まないようにするため。
 */
function Preview3D({ points }: { points: readonly Vec3[] }) {
  const [rot, setRot] = useState({ yaw: 0.6, pitch: -0.4 });
  const drag = useRef<{ x: number; y: number } | null>(null);

  const { center, scale } = useMemo(() => {
    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (const p of points) {
      cx += p[0];
      cy += p[1];
      cz += p[2];
    }
    const n = Math.max(1, points.length);
    const c: Vec3 = [cx / n, cy / n, cz / n];
    let r = 1e-6;
    for (const p of points) r = Math.max(r, Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2]));
    return { center: c, scale: (PREVIEW / 2 - 14) / r };
  }, [points]);

  const project = (p: Vec3): [number, number] => {
    const x = p[0] - center[0];
    const y = p[1] - center[1];
    const z = p[2] - center[2];
    const cy = Math.cos(rot.yaw);
    const sy = Math.sin(rot.yaw);
    const cp = Math.cos(rot.pitch);
    const sp = Math.sin(rot.pitch);
    const x1 = x * cy + y * sy;
    const y1 = -x * sy + y * cy;
    const y2 = y1 * cp + z * sp;
    // 画面: 右が +x1、下が +y2（患者 LPS の Z は頭側なので、上下は反転して見える）。
    return [PREVIEW / 2 + x1 * scale, PREVIEW / 2 + y2 * scale];
  };

  return (
    <svg
      width={PREVIEW}
      height={PREVIEW}
      data-testid="xa3d-preview"
      style={{ background: "#12181d", borderRadius: 3, cursor: "grab", touchAction: "none" }}
      onMouseDown={(e) => {
        drag.current = { x: e.clientX, y: e.clientY };
      }}
      onMouseMove={(e) => {
        const d = drag.current;
        if (!d) return;
        setRot((r) => ({ yaw: r.yaw + (e.clientX - d.x) * 0.01, pitch: r.pitch + (e.clientY - d.y) * 0.01 }));
        drag.current = { x: e.clientX, y: e.clientY };
      }}
      onMouseUp={() => {
        drag.current = null;
      }}
      onMouseLeave={() => {
        drag.current = null;
      }}
    >
      <polyline
        points={points.map((p) => project(p).join(",")).join(" ")}
        fill="none"
        stroke="#7fd1b9"
        strokeWidth={2}
      />
      <circle cx={project(points[0])[0]} cy={project(points[0])[1]} r={3} fill="#f0c674" />
    </svg>
  );
}

/* ------------------------------------------------------------------ */

const backdrop: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.5)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 1000,
};
const panel: React.CSSProperties = {
  background: "#f4f6f8",
  color: "#22303c",
  borderRadius: 6,
  padding: 16,
  minWidth: 620,
  maxHeight: "88vh",
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
  boxShadow: "0 8px 32px rgba(0,0,0,0.4)",
};
const body: React.CSSProperties = { display: "flex", gap: 10, minHeight: 0, flex: 1 };
const content: React.CSSProperties = { flex: 1, minWidth: 0, overflowY: "auto", paddingRight: 2 };
const title: React.CSSProperties = { fontWeight: 600, fontSize: 15, marginBottom: 10 };
const section: React.CSSProperties = { border: "1px solid #d5dde4", borderRadius: 4, padding: 10, marginBottom: 10 };
const sectionTitle: React.CSSProperties = { fontSize: 12, fontWeight: 600, marginBottom: 6, color: "#44586a" };
const row: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8, marginTop: 6, flexWrap: "wrap" };
const label: React.CSSProperties = { display: "flex", alignItems: "center", gap: 4, fontSize: 12 };
const select: React.CSSProperties = { padding: "2px 4px", border: "1px solid #c3ced9", borderRadius: 3, maxWidth: 220 };
const btn: React.CSSProperties = {
  padding: "3px 10px",
  borderWidth: "1px",
  borderStyle: "solid",
  borderColor: "#c3ced9",
  borderRadius: 3,
  background: "#fff",
  cursor: "pointer",
  fontSize: 12,
};
const primaryBtn: React.CSSProperties = { ...btn, background: "#2f6f9f", color: "#fff", borderColor: "#2f6f9f" };
const metric: React.CSSProperties = { fontSize: 12 };
const faint: React.CSSProperties = { fontSize: 11, color: "#6b7c8c" };
const hint: React.CSSProperties = { fontSize: 11, color: "#6b7c8c", lineHeight: 1.5 };
const warn: React.CSSProperties = { fontSize: 11, color: "#a5642a" };
const bad: React.CSSProperties = { fontSize: 11, color: "#b3452f", fontWeight: 600 };
