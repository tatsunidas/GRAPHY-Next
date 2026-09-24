/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * XA の自動追尾ダイアログ（`fw/angio-design.md` §6.7・A16 Phase 1）。
 *
 * <p>ROI を 1 つ置いて全フレームを追尾し、**軌跡・運動信号・心周期**を出す。ここではまだ
 * DSA には繋がない（同位相マスクの適用は Phase 2）。目的は「追尾が効いているかを人が目で
 * 確かめられるようにする」こと。
 *
 * <h3>🔴 モードレスにする</h3>
 * `FourierDialog` と同じ。暗幕で覆うと**裏のビューアでフレームを送れなくなる**。追尾の結果を
 * 見ながらそのフレームへ飛ぶのがこの画面の使い方なので、覆ってはいけない。画像が隠れるぶんは
 * ヘッダを掴んで動かせるようにする。
 *
 * <h3>🔴 読むのは「素のフレーム」であって DSA の差分ではない</h3>
 * 追尾するのは骨・横隔膜・カテーテルといった**造影で変わらない構造**である。DSA は
 * まさにそれを消すので、差分画像を追尾しても何も残っていない。呼び出し側は
 * `zStack`（ネイティブ）を渡すこと。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useI18n } from "../i18n/i18n";
import { needsLogTransform } from "./dsa";
import { readXaDsaTags } from "./dsaLoader";
import type { PixelRect } from "./edgeFilters";
import { readModalitySlice } from "./pixelCalibration";
import { viewerOverlayProps } from "./viewerOverlay";
import type { AutoPhaseResult } from "./xaAutoPhaseMask";
import {
  BAND_KINDS,
  bandLegendColor,
  MASK_ORIGINS,
  originColor,
  originCounts,
  pairingSeries,
  phaseBands,
  washoutBands,
  ZNCC_DOMAIN,
  type PlotBand,
} from "./xaDsaPlot";
import { frameStartTimesMs, type XaCineSource } from "./xaCine";
import type { DsaFramePlanEntry } from "./dsaLoader";
import { OCTAVE_TOLERANCE, type PeriodEstimate, type RoiCandidate } from "./xaTracking";
import { phaseMaskGates } from "./xaPhaseMaskGates";
import { ProgressBar } from "./ProgressBar";
import { SliceCanvas } from "./SliceCanvas";
import { dsaFramePair, type DsaFramePair } from "./dsaLoader";
import type {
  TrackingAnalyzeResponse,
  TrackingMatchResponse,
  XaTrackingWorkerRequest,
  XaTrackingWorkerResponse,
} from "./xaTrackingProtocol";

/** ROI プレビューの最大表示サイズ [px]。 */
const PREVIEW = 360;
/** 候補出しに使うフレーム数の上限（タイルの採点に全フレームは要らない）。 */
const SUGGEST_MAX_FRAMES = 16;
/** 探索半径の選択肢 [px]。 */
const SEARCH_RADII = [16, 32, 48] as const;
/** 画面の端に残す量（ドラッグでヘッダを掴めなくなるところまで出さない）。 */
const EDGE = 80;

type WithoutId<T> = T extends unknown ? Omit<T, "requestId"> : never;

interface Slice {
  values: Float32Array;
  width: number;
  height: number;
}

type Busy = null | "loading" | "suggest" | "analyze" | "match";

/** マスクに使うランの選択。`"self"` は同じラン内（造影到達より前）。 */
export type MaskSource = "self" | number;

/** マスクに使えるランの候補。 */
export interface MaskRun {
  /** そのシリーズ内のラン番号（Z）。 */
  index: number;
  label: string;
  imageIds: readonly string[];
}

export function XaDsaDialog({
  imageIds,
  seriesLabel,
  cine,
  currentFrame,
  runs,
  currentRun,
  dsaActive,
  dsaOnset,
  planLabel,
  autoPhase,
  dsaPlan,
  dsaToken,
  dsaVersion,
  residuals,
  residualProgress,
  onClose,
  onGoToFrame,
  onApplyPlan,
  onClearPlan,
}: {
  /** **ネイティブの**フレーム列（DSA 合成ではない）。 */
  imageIds: readonly string[];
  seriesLabel: string;
  cine: XaCineSource | null;
  currentFrame: number;
  /** 同じシリーズのほかのラン（マスクに使える候補）。 */
  runs: readonly MaskRun[];
  currentRun: number;
  /** DSA セッションが立っているか。同位相マスクは DSA へ入れるものなので、無いと作れない。 */
  dsaActive: boolean;
  /** DSA が判定した造影到達フレーム（同一ラン内で「造影前」を決めるのに要る）。 */
  dsaOnset: number | null;
  /** いま DSA に入っている計画の出自（入っていなければ null）。 */
  planLabel: string | null;
  /** 自動同位相の結果と**診断**。失敗していても中身は入っている。 */
  autoPhase: AutoPhaseResult | null;
  /** いま DSA に効いている計画（フレームごとに何を引いているか）。 */
  dsaPlan: readonly (DsaFramePlanEntry | null)[] | null;
  /** DSA セッションのトークン（3 枚の絵を読むのに要る）。 */
  dsaToken: string | null;
  /**
   * DSA を触るたびに増える版数。**3 枚の絵を読み直す合図**にする（§6.18）。
   * 🔑 これが無いと、2D Viewer でずらしても診断の絵が古いままになる。
   */
  dsaVersion: number;
  /** フレームごとのロバスト残差（測り終わるまで null）。 */
  residuals: readonly number[] | null;
  /** 残差の測定中の進捗（終わったら null）。 */
  residualProgress: { done: number; total: number } | null;
  onClose: () => void;
  onGoToFrame?: (index: number) => void;
  onApplyPlan?: (plan: (DsaFramePlanEntry | null)[], label: string) => void;
  onClearPlan?: () => void;
}) {
  const { t } = useI18n();
  const frameCount = imageIds.length;

  // ── DSA 診断の材料（描画に要る形へ・計算は `xaDsaPlot.ts` の純関数） ──
  const diag = autoPhase?.diagnostics ?? null;
  const bands = useMemo(
    () => (
      // 🚨 washout をマスクにするランは**造影が先で薄いのが後ろ**。`phaseBands` は逆順を
      //    前提にしているので、そのまま使うと帯の意味が反転する（§6.20・実機で踏んだ）。
      diag?.maskSource?.kind === "washout" && diag.maskSource.frames.length
        ? washoutBands(diag.maskSource.frames[0], frameCount)
        : phaseBands(diag?.stableFrom ?? 0, autoPhase?.contrastStart ?? frameCount, frameCount)
    ),
    [diag?.stableFrom, diag?.maskSource, autoPhase?.contrastStart, frameCount],
  );
  const pairing = useMemo(
    () => pairingSeries(diag?.entries ?? null, dsaPlan ?? null, frameCount),
    [diag?.entries, dsaPlan, frameCount],
  );
  const originTally = useMemo(() => originCounts(pairing.origins), [pairing.origins]);

  /**
   * 周期推定の裏付けを 1 行で出す（§6.15）。
   *
   * <p>🚨 **45 bpm は真値 90.2 の半分（オクターブ誤り）**で、`confidence` では原理的に
   * 弾けない（`r(2T) ≈ r(T)` ＝両方高いときに起きるため）。補正が「効いたのか、
   * 敷居にどれだけ届かなかったのか」を数値で出さないと、原因を追えない。
   */
  const periodEvidence = useCallback(
    (p: PeriodEstimate) => t("xatrack.period.evidence", {
      peak: p.peakCorrelation.toFixed(3),
      // 🔴 null は「比べていない」。0 と混ぜない（負の相関は正当な測定結果である）。
      half: p.halfLagCorrelation != null ? p.halfLagCorrelation.toFixed(3) : "—",
      limit: (OCTAVE_TOLERANCE * p.peakCorrelation).toFixed(3),
      halved: p.octaveHalved,
      verdict: t(
        p.octaveHalved > 0
          ? "xatrack.period.evidence.halved"
          : p.halfLagCorrelation == null
            ? "xatrack.period.evidence.na"
            : p.halfLagCorrelation <= 0
              ? "xatrack.period.evidence.negative"
              : "xatrack.period.evidence.kept",
        { halved: p.octaveHalved },
      ),
    }),
    [t],
  );

  /** 追尾が落ちた理由の内訳（多い順）。 */
  const trackReasonTally = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of diag?.trackReason ?? []) if (r) counts.set(r, (counts.get(r) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [diag?.trackReason]);

  const [reference, setReference] = useState(() => Math.max(0, Math.min(frameCount - 1, currentFrame)));
  const [slice, setSlice] = useState<Slice | null>(null);
  /**
   * 🔴 **自動同位相が採用した ROI を初期値にする（§6.15）。**
   *
   * <p>この画面は「DSA が何をしたか」を見るための画面なのに、ROI 欄が空で始まるため
   * Track ボタンが `disabled` のままで、しかも無効に見えなかった——**最初に「押しても
   * 何も起こらない」と言われたのがこれ**。`autoPhase.roi` は
   * 「画面に出して差し替えられるようにするため」に返されているのに、ここまで届いていなかった。
   */
  const [roi, setRoi] = useState<PixelRect | null>(() => autoPhase?.roi ?? null);
  const [candidates, setCandidates] = useState<RoiCandidate[] | null>(null);
  const [result, setResult] = useState<TrackingAnalyzeResponse | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [searchRadius, setSearchRadius] = useState<number>(32);
  const [maskSource, setMaskSource] = useState<MaskSource>("self");
  /** いまのフレームで「実際に引かれているもの」3 枚（§6.18）。 */
  const [pair, setPair] = useState<DsaFramePair | null>(null);
  const [match, setMatch] = useState<TrackingMatchResponse | null>(null);

  /**
   * 対数変換の要否は **DSA と同じ規則**で決める（`PixelIntensityRelationship`）。
   * ここで別の判定を作ると「同じランなのに DSA と追尾で前提が違う」が起きる。
   */
  const logarithmic = useMemo(
    () => (imageIds.length ? needsLogTransform(readXaDsaTags(imageIds[0])?.pixelIntensityRelationship ?? null) : false),
    [imageIds],
  );

  const times = useMemo(
    () => frameStartTimesMs(cine ?? { numberOfFrames: frameCount }),
    [cine, frameCount],
  );

  // ── Worker ──────────────────────────────────────────────────────
  const workerRef = useRef<Worker | null>(null);
  const seqRef = useRef(0);
  const pendingRef = useRef<number>(-1);

  useEffect(() => {
    const w = new Worker(new URL("./xaTrackingWorker.ts", import.meta.url), { type: "module" });
    workerRef.current = w;
    w.onmessage = (ev: MessageEvent<XaTrackingWorkerResponse>) => {
      const res = ev.data;
      // 古い応答は捨てる（ROI を変えて投げ直したときに前の結果で上書きしない）。
      if (res.requestId !== pendingRef.current) return;
      // 🔴 **途中経過で終わったことにしない。** `busy` を型判定の前に消す作りなので、
      //    ここで弾かないと進捗が届くたびに「進捗が消えて何も起きない」状態になる（§6.15 A12）。
      if (res.type === "progress") return;
      pendingRef.current = -1;
      setBusy(null);
      setProgress(null);
      if (res.type === "error") {
        setError(res.message);
        return;
      }
      setError(null);
      if (res.type === "suggestDone") setCandidates(res.candidates);
      else if (res.type === "matchDone") setMatch(res);
      else if (res.type === "analyzeDone") setResult(res);
      // `alignPlanDone` はこのダイアログからは出さない（自動同位相の経路が使う）。
    };
    return () => {
      w.terminate();
      workerRef.current = null;
    };
  }, []);

  const post = useCallback((req: WithoutId<XaTrackingWorkerRequest>, transfer: Transferable[] = []) => {
    const w = workerRef.current;
    if (!w) return;
    const requestId = ++seqRef.current;
    pendingRef.current = requestId;
    w.postMessage({ ...req, requestId } as XaTrackingWorkerRequest, transfer);
  }, []);

  // ── いまのフレームで実際に引かれているもの（§6.18）──────────────────
  // 🔑 **新しい計算をしない。** `dsaFramePair` が `maskAt` / `optsAt` / `subtractFrames` を
  //    そのまま通すので、ここに出る絵は**実際に引かれたものと定義上同じ**である。
  // 🔴 `dsaVersion` が依存に入っているので、2D Viewer 側でずらし・計画・トグルを触ると
  //    ここも即座に追従する。
  useEffect(() => {
    if (!dsaToken) { setPair(null); return; }
    let cancelled = false;
    void (async () => {
      const r = await dsaFramePair(dsaToken, currentFrame);
      // 連打（Alt+矢印）で古い結果が後から来ても上書きしない。
      if (!cancelled) setPair(r);
    })();
    return () => { cancelled = true; };
  }, [dsaToken, dsaVersion, currentFrame]);

  // ── 参照フレームの読み出し ────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const s = await readModalitySlice(imageIds[reference] ?? "");
      if (cancelled) return;
      if (!s) {
        setError(t("xatrack.error.read"));
        return;
      }
      setSlice({ values: s.values, width: s.width, height: s.height });
    })();
    return () => {
      cancelled = true;
    };
  }, [imageIds, reference, t]);

  /** 指定のフレームを読んで、矩形で切り出しながら 1 本に詰める。 */
  const packFrames = useCallback(
    async (indices: readonly number[], crop: PixelRect | null, label: string, ids: readonly string[] = imageIds) => {
      const first = await readModalitySlice(ids[indices[0]] ?? "");
      if (!first) return null;
      const x0 = crop ? crop.x0 : 0;
      const y0 = crop ? crop.y0 : 0;
      const w = crop ? crop.x1 - crop.x0 + 1 : first.width;
      const h = crop ? crop.y1 - crop.y0 + 1 : first.height;
      const values = new Float32Array(w * h * indices.length);
      for (let k = 0; k < indices.length; k++) {
        setProgress(`${label} ${k + 1}/${indices.length}`);
        const s = k === 0 ? first : await readModalitySlice(ids[indices[k]] ?? "");
        if (!s) return null;
        const base = k * w * h;
        if (!crop) {
          values.set(s.values, base);
        } else {
          for (let y = 0; y < h; y++) {
            const src = (y0 + y) * s.width + x0;
            values.set(s.values.subarray(src, src + w), base + y * w);
          }
        }
      }
      return { values, frameCount: indices.length, width: w, height: h };
    },
    [imageIds],
  );

  const runSuggest = useCallback(() => {
    if (!slice || busy) return;
    setBusy("suggest");
    setError(null);
    void (async () => {
      // 🔴 時間方向に間引く。タイルの採点に全フレームは要らないし、全画面 × 全フレームを
      //    Worker へ送ると 1024²・150 枚で 600MB を超える。
      const step = Math.max(1, Math.ceil(frameCount / SUGGEST_MAX_FRAMES));
      const indices: number[] = [];
      for (let i = 0; i < frameCount; i += step) indices.push(i);
      const refIndex = Math.max(0, indices.findIndex((i) => i >= reference));
      const packed = await packFrames(indices, null, t("xatrack.progress.read"));
      if (!packed) {
        setBusy(null);
        setProgress(null);
        setError(t("xatrack.error.read"));
        return;
      }
      const tile = Math.max(32, Math.min(96, Math.round(Math.min(packed.width, packed.height) / 8)));
      post(
        {
          type: "suggest",
          frames: packed,
          referenceIndex: refIndex,
          logarithmic,
          tileSize: tile,
          maxCandidates: 5,
        },
        [packed.values.buffer],
      );
    })();
  }, [slice, busy, frameCount, reference, packFrames, post, logarithmic, t]);

  /** ROI の周り（探索半径＋余白）を切り出す矩形。全画面 × 全フレームは送れないため。 */
  const cropRect = useCallback((): PixelRect | null => {
    if (!slice || !roi) return null;
    const margin = searchRadius + 8;
    return {
      x0: Math.max(0, Math.floor(Math.min(roi.x0, roi.x1)) - margin),
      y0: Math.max(0, Math.floor(Math.min(roi.y0, roi.y1)) - margin),
      x1: Math.min(slice.width - 1, Math.ceil(Math.max(roi.x0, roi.x1)) + margin),
      y1: Math.min(slice.height - 1, Math.ceil(Math.max(roi.y0, roi.y1)) + margin),
    };
  }, [slice, roi, searchRadius]);

  /** 切り出し座標系へ移した ROI。 */
  const roiInCrop = useCallback((crop: PixelRect): PixelRect => ({
    x0: Math.floor(Math.min(roi!.x0, roi!.x1)) - crop.x0,
    y0: Math.floor(Math.min(roi!.y0, roi!.y1)) - crop.y0,
    x1: Math.ceil(Math.max(roi!.x0, roi!.x1)) - crop.x0,
    y1: Math.ceil(Math.max(roi!.y0, roi!.y1)) - crop.y0,
  }), [roi]);

  const runAnalyze = useCallback(() => {
    if (!slice || !roi || busy) return;
    setBusy("analyze");
    setError(null);
    void (async () => {
      // 🔴 ROI の周り（探索半径＋余白）だけを切り出して送る。全画面を全フレームぶん送ると
      //    メモリが持たない。切り出し後の座標系へ ROI を移して渡す。
      const crop = cropRect();
      if (!crop) {
        setBusy(null);
        return;
      }
      const indices = Array.from({ length: frameCount }, (_, i) => i);
      const packed = await packFrames(indices, crop, t("xatrack.progress.read"));
      if (!packed) {
        setBusy(null);
        setProgress(null);
        setError(t("xatrack.error.read"));
        return;
      }
      post(
        {
          type: "analyze",
          frames: packed,
          originX: crop.x0,
          originY: crop.y0,
          roi: roiInCrop(crop),
          referenceFrame: reference,
          logarithmic,
          searchRadius,
          frameStartTimesMs: [...times],
        },
        [packed.values.buffer],
      );
    })();
  }, [slice, roi, busy, frameCount, reference, packFrames, post, logarithmic, times, t, cropRect, roiInCrop]);

  /** マスクに使うランの imageId 列（`"self"` なら同じラン）。 */
  const maskRun = useMemo(
    () => (maskSource === "self" ? null : runs.find((r) => r.index === maskSource) ?? null),
    [maskSource, runs],
  );

  /**
   * マスクに使ってよいフレーム。
   *
   * 🔴 **同一ラン内では「造影到達より前」しか使えない。** 造影の入ったフレームをマスクに
   * すると、その血管が自分自身で引き算されて薄くなる（§6.3 の警告と同じ罠）。到達が
   * 判定できていなければ**作らない**（適当な枚数で代用しない）。
   */
  const usableMaskFrames = useMemo(() => {
    if (maskRun) return Array.from({ length: maskRun.imageIds.length }, (_, i) => i);
    if (dsaOnset == null || dsaOnset <= 0) return [];
    return Array.from({ length: Math.min(dsaOnset, frameCount) }, (_, i) => i);
  }, [maskRun, dsaOnset, frameCount]);

  const runMatch = useCallback(() => {
    if (!slice || !roi || busy) return;
    const crop = cropRect();
    if (!crop || !usableMaskFrames.length) return;
    setBusy("match");
    setError(null);
    void (async () => {
      const liveIdx = Array.from({ length: frameCount }, (_, i) => i);
      const live = await packFrames(liveIdx, crop, t("xatrack.progress.readLive"));
      if (!live) {
        setBusy(null);
        setProgress(null);
        setError(t("xatrack.error.read"));
        return;
      }
      let maskPacked: typeof live | null = null;
      if (maskRun) {
        const maskIdx = Array.from({ length: maskRun.imageIds.length }, (_, i) => i);
        maskPacked = await packFrames(maskIdx, crop, t("xatrack.progress.readMask"), maskRun.imageIds);
        if (!maskPacked) {
          setBusy(null);
          setProgress(null);
          setError(t("xatrack.error.read"));
          return;
        }
      }
      const maskTimes = maskRun
        ? frameStartTimesMs({ numberOfFrames: maskRun.imageIds.length, frameTimeMs: times[1] - times[0] })
        : times;
      const transfer: Transferable[] = [live.values.buffer];
      if (maskPacked) transfer.push(maskPacked.values.buffer);
      post(
        {
          type: "match",
          live,
          mask: maskPacked,
          roi: roiInCrop(crop),
          liveReference: reference,
          maskReference: maskRun ? Math.floor(maskRun.imageIds.length / 2) : reference,
          logarithmic,
          searchRadius,
          liveTimesMs: [...times],
          maskTimesMs: [...maskTimes],
          usableMaskFrames,
          k: 3,
        },
        transfer,
      );
    })();
  }, [slice, roi, busy, cropRect, roiInCrop, usableMaskFrames, frameCount, packFrames, maskRun, times, post, reference, logarithmic, searchRadius, t]);

  const applyPlan = useCallback(() => {
    if (!match || !onApplyPlan) return;
    const ids = maskRun ? maskRun.imageIds : imageIds;
    const plan: (DsaFramePlanEntry | null)[] = match.entries.map((e) =>
      e.maskFrame == null || !ids[e.maskFrame]
        ? null
        : { maskImageIds: [ids[e.maskFrame]], maskFrames: [e.maskFrame], dx: e.dx, dy: e.dy },
    );
    onApplyPlan(plan, maskRun ? maskRun.label : t("xatrack.mask.self"));
  }, [match, onApplyPlan, maskRun, imageIds, t]);

  // ROI を変えたら前の結果は捨てる（古い曲線を新しい ROI のものと読み違えないように）。
  const changeRoi = useCallback((r: PixelRect) => {
    setRoi(r);
    setResult(null);
    setMatch(null);
  }, []);

  // ── 位置（ドラッグで動かす） ───────────────────────────────────────
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);

  const onDragStart = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest("button")) return;
    const el = panelRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    dragRef.current = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    setPos({ x: r.left, y: r.top });
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
  }, []);
  const onDragMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    const el = panelRef.current;
    if (!d || !el) return;
    setPos({
      x: Math.min(Math.max(e.clientX - d.dx, EDGE - el.offsetWidth), window.innerWidth - EDGE),
      y: Math.min(Math.max(e.clientY - d.dy, 0), window.innerHeight - EDGE),
    });
  }, []);
  const onDragEnd = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    dragRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // ── 表示用の要約 ─────────────────────────────────────────────────
  const summary = useMemo(() => {
    if (!result) return null;
    const ok = result.frames.filter((f) => f.reliable).length;
    const p = result.period;
    const hr = p.confidence !== "none" && p.periodMs > 0 ? 60000 / p.periodMs : null;
    const amp = result.s.length ? Math.max(...result.s) - Math.min(...result.s) : 0;
    return { ok, total: result.frames.length, hr, amplitude: amp };
  }, [result]);

  const warnings = useMemo(() => {
    if (!result) return [];
    const out: string[] = [];
    if (!result.trackReliable && result.trackReason) out.push(t(`xatrack.reason.${result.trackReason}`));
    if (result.period.confidence === "none") {
      out.push(t(`xatrack.period.${result.period.reason ?? "noPeak"}`));
    } else if (result.period.confidence === "weak") {
      out.push(t("xatrack.period.weak"));
    }
    if (!result.phaseReliable && result.period.confidence !== "none") out.push(t("xatrack.phase.unreliable"));
    return out;
  }, [result, t]);

  /**
   * 🚨 **自動経路と同じ門を、手動経路でも通す（§6.15）。**
   *
   * <p>以前ここには `outOfRange` / `unreliable` / `directionRelaxed` / `phaseDisagreements` の
   * 4 つしか無く、**振幅がノイズでも／周期が心拍でなくても／追尾が半数外れていても
   * 警告なしで「同位相マスク」として適用できた**。判断材料は Worker が返していたのに、
   * 読んでいたのが自動経路だけだった。
   */
  const gates = useMemo(
    () => (match
      ? phaseMaskGates({
          liveTracked: match.liveTracked,
          totalFrames: match.liveFrameCount,
          maskAmplitudeSpan: match.maskAmplitudeSpan,
          periodConfidence: match.maskPeriod.confidence,
        })
      : []),
    [match],
  );

  const matchWarnings = useMemo(() => {
    if (!match) return [];
    const out: string[] = [];
    // 🔴 **重い門を先に出す。** 追尾が壊れていれば振幅も周期も信用できない。
    for (const g of gates) {
      out.push(t(`xadsa.gate.${g}`, {
        tracked: match.liveTracked,
        total: match.liveFrameCount,
        span: match.maskAmplitudeSpan.toFixed(2),
      }));
    }
    // 🔴 造影前が 1 心拍に満たないと、位相の合うマスクがそもそも存在しない。
    if (match.maskPeriod.confidence !== "none" && usableMaskFrames.length < match.maskPeriod.periodFrames) {
      out.push(t("xatrack.match.shortMask", {
        n: usableMaskFrames.length,
        period: match.maskPeriod.periodFrames.toFixed(1),
      }));
    }
    if (match.summary.outOfRange > 0) out.push(t("xatrack.match.outOfRange", { n: match.summary.outOfRange }));
    if (match.summary.unreliable > 0) out.push(t("xatrack.match.unreliable", { n: match.summary.unreliable }));
    if (match.summary.directionRelaxed > 0) out.push(t("xatrack.match.relaxed", { n: match.summary.directionRelaxed }));
    if (match.summary.phaseDisagreements > 0) {
      out.push(t("xatrack.match.phaseDisagree", { n: match.summary.phaseDisagreements }));
    }
    return out;
  }, [match, gates, usableMaskFrames.length, t]);

  return (
    <div style={shell} data-xadsa>
      {/*
        🚨 **無効なボタンが有効に見えていた（§6.15）。**
        `chip` / `btnPrimary` は素の CSSProperties で `cursor: "pointer"` 決め打ちのため、
        `disabled` でも色もカーソルも変わらず、利用者には「押しても何も起こらない」としか
        見えなかった（最初に指摘されたのが Track ボタンのこれ）。
        個別に直すと将来足すボタンで再発するので、**このダイアログの button すべて**に
        一度だけ効かせる。
      */}
      <style>{DISABLED_CSS}</style>
      <div
        ref={panelRef}
        style={pos ? { ...panel, position: "fixed", left: pos.x, top: pos.y, margin: 0 } : panel}
        data-testid="xadsa-dialog"
        {...viewerOverlayProps}
      >
        <div
          style={header}
          onPointerDown={onDragStart}
          onPointerMove={onDragMove}
          onPointerUp={onDragEnd}
          onPointerCancel={onDragEnd}
          data-testid="xadsa-header"
        >
          <span>{t("xadsa.title")}</span>
          <span style={{ flex: 1 }} />
          <span style={{ fontSize: 11, color: "#8a98a6", fontWeight: 400 }}>
            {seriesLabel} — {t("xatrack.frames", { n: frameCount })}
            {logarithmic && ` — ${t("xatrack.logNote")}`}
          </span>
          <button style={{ ...chip, marginLeft: 10 }} onClick={onClose} data-testid="xadsa-close">
            {t("common.close")}
          </button>
        </div>

        {/* ══ DSA の診断（主役）════════════════════════════════════════
            🔑 追尾は**前処理**なので下の <details> に畳む。ここに出すのは
            「このフレームは何を引いているか」と「どれだけ合っているか」だけ。 */}
        {!autoPhase ? (
          <div style={{ ...hint, color: "#e0b050" }} data-testid="xadsa-empty">{t("xadsa.empty")}</div>
        ) : (
          <>
            <div style={{ fontFamily: "monospace", lineHeight: 1.7 }} data-testid="xadsa-summary">
              <div>
                {t("xadsa.summary.origins", {
                  self: originTally.self,
                  phase: originTally.phase,
                  clamped: originTally.clamped,
                  filled: originTally.filled,
                  def: originTally.default,
                })}
              </div>
              <div>
                {/* 🔴 bpm と振幅は**追尾経路の量**。背景の突き合わせでは測っていないので、
                    「0.0px」と出して「動いていない」と読まれないよう出し分ける（§6.16）。 */}
                {/* 🚨 washout 経路の `contrastStart` は**層の先頭**であって造影の開始ではない。
                    「Contrast from 69」と出して 69 を造影開始と読ませない（§6.20・実機で踏んだ）。 */}
                {diag?.maskSource?.kind === "washout"
                  ? t("xadsa.summary.run.washout", {
                      from: (diag.maskSource.frames[0] ?? 0) + 1,
                      to: (diag.maskSource.frames[diag.maskSource.frames.length - 1] ?? 0) + 1,
                    })
                  : autoPhase.method === "background"
                  ? t("xadsa.summary.run.background", { start: (autoPhase.contrastStart ?? 0) + 1 })
                  : t("xadsa.summary.run", {
                      start: (autoPhase.contrastStart ?? 0) + 1,
                      bpm: autoPhase.bpm != null ? autoPhase.bpm.toFixed(0) : "—",
                      span: (autoPhase.amplitudeSpanPx ?? 0).toFixed(1),
                    })}
              </div>
              {/* 🔑 **どちらの経路で位相を決めたか**（§6.16）。造影後に追尾が死ぬランは
                  「背景の突き合わせ」に落ちる——それは失敗ではなく、第 2 の経路である。 */}
              {/* 🔑 **マスク源の判別結果と根拠**（§6.19）。造影前があるのか、
                  造影後しか無いのか。外したときに追えるよう、判断した数値ごと出す。 */}
              {diag?.maskSource && (
                <div data-testid="xadsa-mask-source">
                  {t(`xadsa.maskSource.${diag.maskSource.kind}`, {
                    n: diag.maskSource.frames.length,
                    from: (diag.maskSource.frames[0] ?? 0) + 1,
                    to: (diag.maskSource.frames[diag.maskSource.frames.length - 1] ?? 0) + 1,
                  })}
                  {" — "}
                  {t("xadsa.maskSource.evidence", {
                    lead: (diag.maskSource.evidence.leadingLevel * 100).toFixed(2),
                    peak: (diag.maskSource.evidence.peakLevel * 100).toFixed(2),
                    peakAt: diag.maskSource.evidence.peakFrame + 1,
                    trail: (diag.maskSource.evidence.trailingLevel * 100).toFixed(2),
                  })}
                </div>
              )}
              {autoPhase.method && (
                <div data-testid="xadsa-method">
                  {t("dsa.autoPhase.background", {
                    method: t(`dsa.autoPhase.method.${autoPhase.method}`),
                    score: autoPhase.backgroundScore != null ? autoPhase.backgroundScore.toFixed(3) : "—",
                    frac: autoPhase.contrastFraction != null
                      ? (autoPhase.contrastFraction * 100).toFixed(1)
                      : "—",
                  })}
                  {" / "}
                  {t("xadsa.align", {
                    aligned: autoPhase.alignedFrames ?? 0,
                    rot: autoPhase.alignRotationDeg != null ? autoPhase.alignRotationDeg.toFixed(2) : "—",
                  })}
                </div>
              )}
              {diag?.maskPeriod && diag.maskPeriod.peakCorrelation > 0 && (
                <div style={{ color: "#8a98a6" }} data-testid="xadsa-period-evidence">
                  {periodEvidence(diag.maskPeriod)}
                </div>
              )}
              {!autoPhase.ok && (
                <div style={{ color: "#e0b050" }} data-testid="xadsa-failed">
                  {t(`dsa.autoPhase.failed.${autoPhase.reason ?? "trackFailed"}`, {
                    span: (autoPhase.amplitudeSpanPx ?? 0).toFixed(1),
                  })}
                </div>
              )}
            </div>

            {/* ① 何を引いているか */}
            <div style={colTitle}>{t("xadsa.chart.mask")}</div>
            <SignalChart
              series={[{ label: "mask", color: "#4a5c6e", values: pairing.values }]}
              pointColors={pairing.colors}
              bands={bands}
              current={currentFrame}
              onPick={onGoToFrame}
              testId="xadsa-chart-mask"
              unit="#"
            />
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", margin: "2px 0 0" }} data-testid="xadsa-legend">
              {MASK_ORIGINS.map((o) => (
                <span key={o} style={{ fontSize: 11, color: originColor(o) }}>
                  ■ {t(`xadsa.origin.${o}`)} {originTally[o]}
                </span>
              ))}
            </div>
            {/* 🚨 **帯の凡例。** `PlotBand.kind` は「凡例に出す種別」と書かれていたのに
                凡例が無く、全グラフの背景の赤・緑・青が何なのか画面のどこにも
                書かれていなかった（§6.15）。上の凡例は**点の色**で、別物。 */}
            {bands.length > 0 && (
              <div
                style={{ display: "flex", gap: 10, flexWrap: "wrap", margin: "2px 0 0" }}
                data-testid="xadsa-band-legend"
              >
                {BAND_KINDS.filter((k) => bands.some((b) => b.kind === k)).map((k) => (
                  <span key={k} style={{ fontSize: 11, color: "#8a98a6" }}>
                    <span style={{ color: bandLegendColor(k) }}>▬</span> {t(`xadsa.band.${k}`)}
                  </span>
                ))}
              </div>
            )}
            <div style={hint}>{t("xadsa.chart.mask.hint")}</div>

            {/* ══ 実際に引かれているもの（§6.18）═══════════════════════════
                🔑 ②の残差は差分に血管そのものを含む（造影画素 15%）ので、数値だけでは
                   「縁取りが減ったか」を判断できない。**絵を見るしかない。** */}
            {pair && (
              <>
                <div style={colTitle}>{t("xadsa.pair.title", { frame: currentFrame + 1 })}</div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", flexShrink: 0 }} data-testid="xadsa-pair">
                  <PairPanel
                    label={t("xadsa.pair.mask")}
                    note={t("xadsa.pair.mask.note", {
                      frames: pair.maskFrames.map((f) => f + 1).join(", ") || "—",
                      dx: pair.dx.toFixed(2),
                      dy: pair.dy.toFixed(2),
                      rot: pair.rotationDeg.toFixed(2),
                    })}
                    slice={{ values: pair.mask, width: pair.width, height: pair.height }}
                    testId="xadsa-pair-mask"
                  />
                  <PairPanel
                    label={t("xadsa.pair.live")}
                    note={t("xadsa.pair.live.note", { frame: currentFrame + 1 })}
                    slice={{ values: pair.live, width: pair.width, height: pair.height }}
                    testId="xadsa-pair-live"
                  />
                  <PairPanel
                    label={t("xadsa.pair.diff")}
                    note={t("xadsa.pair.diff.note", {
                      resid: residuals?.[currentFrame] != null && Number.isFinite(residuals[currentFrame])
                        ? residuals[currentFrame].toFixed(3)
                        : "—",
                    })}
                    slice={{ values: pair.diff, width: pair.width, height: pair.height }}
                    // 🔴 差分だけは**セッションの窓**で描く。フレームごとに自動調整すると
                    //    明るさが変わって見比べられない（§6.18）。
                    voi={pair.voi}
                    testId="xadsa-pair-diff"
                  />
                </div>
                <div style={hint}>{t("xadsa.pair.hint")}</div>
              </>
            )}

            {/* ② どれだけ合っているか — これが「うまくいっているか」の答え */}
            <div style={colTitle}>{t("xadsa.chart.residual")}</div>
            {residuals ? (
              <SignalChart
                series={[{ label: "resid", color: "#e0a050", values: [...residuals] }]}
                // 🔑 **位相と振幅が食い違ったフレームを赤い目盛りで出す（§6.15）。**
                //    `xaPhaseMask.ts` は「食い違うフレームを出す（どちらが正しいかは決めない。
                //    人に見せる）」と書いているのに、これまで出ていたのは**件数だけ**で、
                //    どのフレームを見に行けばよいか分からなかった。
                unreliable={diag?.phaseDisagree ?? undefined}
                bands={bands}
                current={currentFrame}
                onPick={onGoToFrame}
                testId="xadsa-chart-residual"
                unit=""
              />
            ) : (
              <div style={{ ...hint, color: "#e0b050" }} data-testid="xadsa-residual-busy">
                <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                  {t("xadsa.residual.measuring")}
                  <ProgressBar
                    done={residualProgress?.done}
                    total={residualProgress?.total}
                    testId="xadsa-residual-bar"
                  />
                </span>
              </div>
            )}
            <div style={hint}>{t("xadsa.chart.residual.hint")}</div>

            {/* ③ ZNCC */}
            {(diag?.trackScore || diag?.entries) && (
              <>
                <div style={colTitle}>{t("xadsa.chart.zncc")}</div>
                <SignalChart
                  series={[
                    { label: "track", color: "#7fb2ec", values: diag?.trackScore ?? [] },
                    {
                      label: "pair",
                      color: "#c9a0dc",
                      values: (diag?.entries ?? []).map((e) => e.similarity ?? Number.NaN),
                    },
                  ].filter((x) => x.values.length > 0)}
                  domain={ZNCC_DOMAIN}
                  bands={bands}
                  unreliable={diag?.reliable ? diag.reliable.map((r) => !r) : undefined}
                  current={currentFrame}
                  onPick={onGoToFrame}
                  testId="xadsa-chart-zncc"
                  unit=""
                />
                <div style={hint}>{t("xadsa.chart.zncc.hint")}</div>
              </>
            )}
          </>
        )}

        {/* ══ 前処理の内訳（追尾）— 既定は畳む ══════════════════════════ */}
        <details data-testid="xadsa-details" style={{ marginTop: 10 }}>
          <summary style={{ ...colTitle, cursor: "pointer" }}>{t("xadsa.details")}</summary>

        {diag && diag.candidates.length > 0 && (
          <div style={box} data-testid="xadsa-candidates">
            <div style={colTitle}>{t("xadsa.candidates")}</div>
            <div style={{ fontFamily: "monospace", fontSize: 11, lineHeight: 1.6 }}>
              {diag.candidates.map((c, i) => (
                <button
                  key={`${c.rect.x0},${c.rect.y0},${c.tileSize}`}
                  data-testid={`xadsa-candidate-${i}`}
                  type="button"
                  title={t("xadsa.candidate.pick")}
                  onClick={() => changeRoi(c.rect)}
                  style={{
                    color: c.adopted ? "#69c98a" : "#a9b4bf",
                    background: "none",
                    border: "none",
                    borderRadius: 4,
                    padding: "1px 4px",
                    textAlign: "left",
                    font: "inherit",
                    cursor: "pointer",
                    ...(roi && c.rect.x0 === roi.x0 && c.rect.y0 === roi.y0 && c.rect.x1 === roi.x1
                      ? { background: "#1d2a38" }
                      : {}),
                  }}
                >
                  {c.adopted ? "▶ " : "  "}
                  {t("xadsa.candidate.row", {
                    rect: `${c.rect.x0},${c.rect.y0}/${c.tileSize}`,
                    score: c.score.toFixed(3),
                    motion: c.motionPx.toFixed(2),
                    bpm: c.bpm != null ? c.bpm.toFixed(0) : "—",
                    tracked: `${c.trackedFrames}/${c.totalFrames}`,
                    post: c.postFraction != null ? `${(c.postFraction * 100).toFixed(0)}%` : "—",
                  })}
                </button>
              ))}
            </div>
            <div style={hint}>{t("xadsa.candidates.hint")}</div>
            {/* 🔑 **bpm 列が「—」である理由を画面に出す（§6.15）。** 心拍の判定には
                3 周期ぶん（4.5 秒）要るので、1 秒強の造影前窓では原理的に出ない。
                窓の長さはデトレンドの方式も決める（3 秒未満なら線形）。 */}
            {diag.surveyFrames > 0 && (
              <div style={hint} data-testid="xadsa-survey">
                {t("xadsa.survey", {
                  n: diag.surveyFrames,
                  sec: (diag.surveySpanMs / 1000).toFixed(2),
                  detrend: t(`xadsa.detrend.${diag.surveySpanMs >= 3000 ? "movingAverage" : "linear"}`),
                })}
                {diag.surveySpanMs < 4500 && ` ${t("xadsa.survey.noBpm")}`}
              </div>
            )}
          </div>
        )}

        {/* 🔑 **なぜ追えなかったかの内訳（§6.15）。** `lowScore` の連発（造影でテンプレートが
            別物）と `atSearchEdge` の連発（探索半径が足りない）は対処が正反対なのに、
            これまでは「追えなかった」としか出ていなかった。 */}
        {trackReasonTally.length > 0 && (
          <div style={box} data-testid="xadsa-track-reasons">
            <div style={colTitle}>{t("xadsa.trackReasons")}</div>
            <div style={{ fontFamily: "monospace", fontSize: 11, lineHeight: 1.6 }}>
              {trackReasonTally.map(([reason, count]) => (
                <div key={reason}>{t(`xatrack.frameReason.${reason}`)}: {count}</div>
              ))}
            </div>
            <div style={hint}>{t("xadsa.trackReasons.hint")}</div>
          </div>
        )}

        {diag?.signal && (
          <>
            <div style={colTitle}>{t("xadsa.chart.motion")}</div>
            <SignalChart
              series={[{ label: "s", color: "#69c98a", values: diag.signal }]}
              bands={bands}
              unreliable={diag.reliable ? diag.reliable.map((r) => !r) : undefined}
              current={currentFrame}
              onPick={onGoToFrame}
              testId="xadsa-chart-motion"
              unit="px"
            />
            <div style={hint}>{t("xadsa.chart.motion.hint")}</div>
          </>
        )}

        <div style={hint}>{t("xatrack.scope")}</div>

        <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
          {/* 左: ROI を引く */}
          <div style={column}>
            <div style={colTitle}>{t("xatrack.roi.title")}</div>
            {slice ? (
              <RoiCanvas
                slice={slice}
                roi={roi}
                // 🔴 手で「候補を出す」を押していなくても、**自動が採点した候補を出す**。
                //    座標が文字で出るだけでは「なぜこの ROI か」を目で確かめられない（§6.15）。
                candidates={candidates ?? diag?.candidates ?? null}
                onChange={changeRoi}
              />
            ) : (
              <div style={{ ...box, width: PREVIEW, height: PREVIEW, justifyContent: "center" }}>
                {t("xatrack.loading")}
              </div>
            )}
            <div style={hint}>{t("xatrack.roi.hint")}</div>
            {/* 🔴 **座標を出す。** これが無いと、実機で見た ROI を記録することも
                同じ場所を引き直すこともできない（利用者の指摘）。 */}
            <div style={{ ...hint, fontFamily: "monospace" }} data-testid="xatrack-roi-coords">
              {roi
                ? t("xatrack.roi.coords", {
                    x0: roi.x0, y0: roi.y0, x1: roi.x1, y1: roi.y1,
                    w: roi.x1 - roi.x0 + 1, h: roi.y1 - roi.y0 + 1,
                  })
                : t("xatrack.roi.none")}
            </div>
            <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
              <span style={{ color: "#8a98a6" }}>{t("xatrack.reference")}</span>
              <span style={{ fontFamily: "monospace" }} data-testid="xatrack-reference">
                {reference + 1}
              </span>
              <button
                style={chip}
                data-testid="xatrack-set-reference"
                disabled={!!busy || reference === currentFrame}
                onClick={() => {
                  setReference(currentFrame);
                  setResult(null);
                }}
              >
                {t("xatrack.setReference")}
              </button>
            </div>
          </div>

          {/* 右: 操作と結果 */}
          <div style={{ ...column, minWidth: 320 }}>
            <div style={box}>
              <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                <button style={chip} data-testid="xatrack-suggest" disabled={!!busy || !slice} onClick={runSuggest}>
                  {t("xatrack.suggest")}
                </button>
                <span style={{ color: "#8a98a6" }}>{t("xatrack.searchRadius")}</span>
                {SEARCH_RADII.map((r) => (
                  <button
                    key={r}
                    style={r === searchRadius ? chipOn : chip}
                    data-testid={`xatrack-radius-${r}`}
                    disabled={!!busy}
                    onClick={() => {
                      setSearchRadius(r);
                      setResult(null);
                    }}
                  >
                    {r}
                  </button>
                ))}
              </div>
              <div style={hint}>{t("xatrack.suggest.hint")}</div>
              {candidates && (
                <div style={{ display: "flex", flexDirection: "column", gap: 3 }} data-testid="xatrack-candidates">
                  {candidates.length === 0 && <div style={hint}>{t("xatrack.suggest.none")}</div>}
                  {candidates.map((c, i) => (
                    <button
                      key={`${c.rect.x0},${c.rect.y0}`}
                      style={{ ...chip, textAlign: "left", fontFamily: "monospace" }}
                      data-testid={`xatrack-candidate-${i}`}
                      onClick={() => changeRoi(c.rect)}
                    >
                      {`#${i + 1} (${c.rect.x0},${c.rect.y0})–(${c.rect.x1},${c.rect.y1})`}
                      {`  λ2/λ1 ${c.anisotropy.toFixed(2)}  ${t("xatrack.cand.motion")} ${c.motionPx.toFixed(1)}px`}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div style={box}>
              <button
                style={btnPrimary}
                data-testid="xatrack-run"
                disabled={!!busy || !roi}
                onClick={runAnalyze}
              >
                {t("xatrack.run")}
              </button>
              {!roi && !busy && (
                <div style={hint} data-testid="xatrack-need-roi">{t("xatrack.needRoi")}</div>
              )}
              {busy && <div style={{ ...hint, color: "#e0b050" }} data-testid="xatrack-busy">{progress ?? t("xatrack.working")}</div>}
              {error && <div style={{ ...hint, color: "#e06060" }} data-testid="xatrack-error">{error}</div>}
              {result && summary && (
                <div style={{ fontFamily: "monospace", lineHeight: 1.7 }} data-testid="xatrack-summary">
                  <div>
                    {t("xatrack.result.tracked", { ok: summary.ok, total: summary.total })}
                    {` — λ2/λ1 ${result.tensor.anisotropy.toFixed(3)}`}
                  </div>
                  <div>
                    {summary.hr != null
                      ? t("xatrack.result.rate", {
                          hr: summary.hr.toFixed(0),
                          frames: result.period.periodFrames.toFixed(1),
                          ms: result.period.periodMs.toFixed(0),
                        })
                      : t("xatrack.result.noRate")}
                  </div>
                  <div>{t("xatrack.result.amplitude", { px: summary.amplitude.toFixed(2) })}</div>
                  {result.period.peakCorrelation > 0 && (
                    <div style={{ color: "#8a98a6" }} data-testid="xatrack-period-evidence">
                      {periodEvidence(result.period)}
                    </div>
                  )}
                </div>
              )}
              {warnings.map((w) => (
                <div key={w} style={{ ...hint, color: "#e0b050" }} data-testid="xatrack-warning">
                  {w}
                </div>
              ))}
            </div>

            {/* 同位相マスク（Phase 2）。造影前のどのフレームを当てるかを決めて DSA へ入れる。 */}
            <div style={box} data-testid="xatrack-phasemask">
              <div style={colTitle}>{t("xatrack.mask.title")}</div>
              {!dsaActive ? (
                <div style={{ ...hint, color: "#e0b050" }} data-testid="xatrack-mask-needsdsa">
                  {t("xatrack.mask.needsDsa")}
                </div>
              ) : (
                <>
                  <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                    <span style={{ color: "#8a98a6" }}>{t("xatrack.mask.source")}</span>
                    <button
                      style={maskSource === "self" ? chipOn : chip}
                      data-testid="xatrack-mask-self"
                      disabled={!!busy}
                      onClick={() => { setMaskSource("self"); setMatch(null); }}
                    >
                      {t("xatrack.mask.self")}
                    </button>
                    {runs.filter((r) => r.index !== currentRun).map((r) => (
                      <button
                        key={r.index}
                        style={maskSource === r.index ? chipOn : chip}
                        data-testid={`xatrack-mask-run-${r.index}`}
                        disabled={!!busy}
                        onClick={() => { setMaskSource(r.index); setMatch(null); }}
                      >
                        {r.label}
                      </button>
                    ))}
                  </div>
                  {maskSource === "self" && (
                    <div style={hint} data-testid="xatrack-mask-usable">
                      {dsaOnset == null || dsaOnset <= 0
                        ? t("xatrack.mask.noOnset")
                        : t("xatrack.mask.usable", { n: usableMaskFrames.length, onset: dsaOnset + 1 })}
                    </div>
                  )}
                  <button
                    style={btnPrimary}
                    data-testid="xatrack-match"
                    disabled={!!busy || !roi || !usableMaskFrames.length}
                    onClick={runMatch}
                  >
                    {t("xatrack.match.run")}
                  </button>
                  {match && (
                    <div style={{ fontFamily: "monospace", lineHeight: 1.7 }} data-testid="xatrack-match-summary">
                      <div>
                        {t("xatrack.match.counts", {
                          ok: match.summary.ok,
                          total: match.entries.length,
                        })}
                      </div>
                      <div>
                        {t("xatrack.match.diff", { px: match.summary.medianAmplitudeDiff.toFixed(2) })}
                      </div>
                      {maskRun && (
                        <div>
                          {t("xatrack.match.runOffset", {
                            dx: match.runOffset.dx.toFixed(2),
                            dy: match.runOffset.dy.toFixed(2),
                          })}
                        </div>
                      )}
                      {match.maskPeriod.peakCorrelation > 0 && (
                        <div style={{ color: "#8a98a6" }} data-testid="xatrack-match-period-evidence">
                          {periodEvidence(match.maskPeriod)}
                        </div>
                      )}
                      <div>
                        {t("xatrack.match.tracked", {
                          live: match.liveTracked,
                          liveTotal: match.liveFrameCount,
                          mask: match.maskTracked,
                          maskTotal: match.maskFrameCount,
                        })}
                      </div>
                      {/* 🔑 マスクに別ランを使うなら、**2 ランの心拍が違えば同位相は成立しない**。
                          両方の周期が届いているのに、これまで片方しか見ていなかった（§6.15）。 */}
                      {maskRun && (
                        <div style={
                          match.livePeriod.confidence !== "none" && match.maskPeriod.confidence !== "none"
                            && Math.abs(match.livePeriod.periodFrames - match.maskPeriod.periodFrames)
                               > 0.2 * match.maskPeriod.periodFrames
                            ? { color: "#e0b050" }
                            : undefined
                        }>
                          {t("xatrack.match.periods", {
                            mask: match.maskPeriod.confidence !== "none"
                              ? (60000 / match.maskPeriod.periodMs).toFixed(0) : "—",
                            live: match.livePeriod.confidence !== "none"
                              ? (60000 / match.livePeriod.periodMs).toFixed(0) : "—",
                          })}
                        </div>
                      )}
                    </div>
                  )}
                  {/* 🔑 **自動経路と同じグラフを手動でも出す（§6.15）。** Worker は
                      「診断用。捨てずに返すだけ」と明記して `liveSignal` / `liveFrames` を
                      返しているのに、これまで描いていたのは自動経路だけで、手動で見るには
                      Track を回し直す（＝同じ追尾を 2 回計算する）必要があった。 */}
                  {match && (
                    <>
                      <div style={colTitle}>{t("xadsa.chart.motion")}</div>
                      <SignalChart
                        series={[{ label: "s", color: "#69c98a", values: [...match.liveSignal] }]}
                        unreliable={match.liveFrames.map((f) => !f.reliable)}
                        current={currentFrame}
                        onPick={onGoToFrame}
                        testId="xatrack-match-chart-motion"
                        unit="px"
                      />
                      <div style={colTitle}>{t("xadsa.chart.zncc")}</div>
                      <SignalChart
                        series={[
                          { label: "track", color: "#7fb2ec", values: match.liveFrames.map((f) => f.score) },
                          {
                            label: "pair",
                            color: "#c9a0dc",
                            values: match.entries.map((e) => e.similarity ?? Number.NaN),
                          },
                        ]}
                        domain={ZNCC_DOMAIN}
                        unreliable={match.liveFrames.map((f) => !f.reliable)}
                        current={currentFrame}
                        onPick={onGoToFrame}
                        testId="xatrack-match-chart-zncc"
                        unit=""
                      />
                    </>
                  )}
                  {matchWarnings.map((w) => (
                    <div key={w} style={{ ...hint, color: "#e0b050" }} data-testid="xatrack-match-warning">
                      {w}
                    </div>
                  ))}
                  <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                    <button
                      style={btnPrimary}
                      data-testid="xatrack-apply"
                      disabled={!!busy || !match || !match.summary.ok || gates.length > 0 || !onApplyPlan}
                      title={gates.length ? t(`xadsa.gate.${gates[0]}`, {
                        tracked: match?.liveTracked ?? 0,
                        total: match?.liveFrameCount ?? 0,
                        span: (match?.maskAmplitudeSpan ?? 0).toFixed(2),
                      }) : undefined}
                      onClick={applyPlan}
                    >
                      {t("xatrack.mask.apply")}
                    </button>
                    <button
                      style={chip}
                      data-testid="xatrack-clear-plan"
                      disabled={!!busy || !planLabel || !onClearPlan}
                      onClick={() => onClearPlan?.()}
                    >
                      {t("xatrack.mask.clear")}
                    </button>
                    {planLabel && (
                      <span style={{ color: "#69c98a" }} data-testid="xatrack-plan-label">
                        {t("xatrack.mask.applied", { label: planLabel })}
                      </span>
                    )}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>

        {result && (
          <>
            <div style={colTitle}>{t("xatrack.chart.trajectory")}</div>
            <SignalChart
              series={[
                { label: "dx", color: "#7fb2ec", values: result.frames.map((f) => f.dx) },
                { label: "dy", color: "#e0a050", values: result.frames.map((f) => f.dy) },
              ]}
              unreliable={result.frames.map((f) => !f.reliable)}
              current={currentFrame}
              onPick={onGoToFrame}
              testId="xatrack-chart-trajectory"
              unit="px"
            />
            <div style={colTitle}>{t("xatrack.chart.signal")}</div>
            <SignalChart
              series={[{ label: "s", color: "#69c98a", values: Array.from(result.s) }]}
              marks={result.peaks}
              unreliable={result.frames.map((f) => !f.reliable)}
              current={currentFrame}
              onPick={onGoToFrame}
              testId="xatrack-chart-signal"
              unit="px"
            />
            <div style={hint}>{t("xatrack.chart.hint")}</div>
          </>
        )}

        {match && (
          <>
            <div style={colTitle}>{t("xatrack.chart.assignment")}</div>
            <SignalChart
              series={[
                {
                  label: "mask",
                  color: "#c9a0dc",
                  values: match.entries.map((e) => e.maskFrame ?? Number.NaN),
                },
              ]}
              unreliable={match.entries.map((e) => e.maskFrame == null)}
              current={currentFrame}
              onPick={onGoToFrame}
              testId="xatrack-chart-assignment"
              unit="#"
            />
            <div style={hint}>{t("xatrack.chart.assignment.hint")}</div>
          </>
        )}
        </details>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

/**
 * 参照フレームを描いて矩形をドラッグで引かせる。候補は破線で重ねる。
 *
 * <p>🔑 `XaTimiDialog` と同じく**ビューアの上ではなくダイアログの中で引く**。
 * そのためフレーム送りを止める必要が無い。矩形は画像座標なので、どのフレームを見ながら
 * 引いたかに依らず全フレームへ同じ位置で当たる。
 */
/** 3 枚並べる 1 枚ぶん（見出し＋注記＋絵）。 */
function PairPanel({
  label,
  note,
  slice,
  voi,
  testId,
}: {
  label: string;
  note: string;
  slice: { values: Float32Array; width: number; height: number };
  voi?: { windowCenter: number; windowWidth: number } | null;
  testId: string;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2, flexShrink: 0 }}>
      <div style={{ color: "#9fb0c0", fontSize: 11 }}>{label}</div>
      <SliceCanvas slice={slice} size={PAIR_PREVIEW} voi={voi ?? null} testId={testId} />
      <div style={{ ...hint, fontFamily: "monospace", maxWidth: PAIR_PREVIEW }}>{note}</div>
    </div>
  );
}

function RoiCanvas({
  slice,
  roi,
  candidates,
  onChange,
}: {
  slice: Slice;
  roi: PixelRect | null;
  /** 🔴 出自は問わない（手動の `suggest` でも、自動同位相の診断でも同じように描く）。 */
  candidates: readonly { rect: PixelRect }[] | null;
  onChange: (r: PixelRect) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [drag, setDrag] = useState<PixelRect | null>(null);

  const view = useMemo(() => {
    const scale = Math.min(PREVIEW / slice.width, PREVIEW / slice.height);
    return { scale, dw: Math.round(slice.width * scale), dh: Math.round(slice.height * scale) };
  }, [slice.width, slice.height]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    // 画素値の範囲で正規化して描く（VOI を持ってこない＝見えればよい）。
    let min = Infinity;
    let max = -Infinity;
    for (const v of slice.values) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
    const span = max - min || 1;
    const img = ctx.createImageData(slice.width, slice.height);
    for (let i = 0; i < slice.values.length; i++) {
      const g = Math.round(((slice.values[i] - min) / span) * 255);
      img.data[i * 4] = g;
      img.data[i * 4 + 1] = g;
      img.data[i * 4 + 2] = g;
      img.data[i * 4 + 3] = 255;
    }
    const off = document.createElement("canvas");
    off.width = slice.width;
    off.height = slice.height;
    off.getContext("2d")?.putImageData(img, 0, 0);
    canvas.width = view.dw;
    canvas.height = view.dh;
    ctx.clearRect(0, 0, view.dw, view.dh);
    ctx.drawImage(off, 0, 0, view.dw, view.dh);

    const stroke = (r: PixelRect, color: string, dashed: boolean) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.setLineDash(dashed ? [4, 3] : []);
      ctx.strokeRect(
        Math.min(r.x0, r.x1) * view.scale,
        Math.min(r.y0, r.y1) * view.scale,
        Math.abs(r.x1 - r.x0) * view.scale,
        Math.abs(r.y1 - r.y0) * view.scale,
      );
      ctx.setLineDash([]);
    };
    for (const c of candidates ?? []) stroke(c.rect, "#69c98a", true);
    const box = drag ?? roi;
    if (box) stroke(box, "#e07a5f", false);
  }, [slice, view, roi, drag, candidates]);

  const toImage = (ev: React.MouseEvent): { x: number; y: number } | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((ev.clientX - rect.left) / rect.width) * slice.width,
      y: ((ev.clientY - rect.top) / rect.height) * slice.height,
    };
  };

  return (
    <canvas
      ref={canvasRef}
      data-testid="xatrack-roi-canvas"
      style={{ border: "1px solid #2c3742", cursor: "crosshair", display: "block" }}
      onMouseDown={(e) => {
        const p = toImage(e);
        if (p) setDrag({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
      }}
      onMouseMove={(e) => {
        if (!drag) return;
        const p = toImage(e);
        if (p) setDrag({ ...drag, x1: p.x, y1: p.y });
      }}
      onMouseUp={() => {
        if (!drag) return;
        // 小さすぎる矩形はテンプレートにならない（相関が立たない）。
        if (Math.abs(drag.x1 - drag.x0) >= 16 && Math.abs(drag.y1 - drag.y0) >= 16) {
          onChange({
            x0: Math.round(Math.min(drag.x0, drag.x1)),
            y0: Math.round(Math.min(drag.y0, drag.y1)),
            x1: Math.round(Math.max(drag.x0, drag.x1)),
            y1: Math.round(Math.max(drag.y0, drag.y1)),
          });
        }
        setDrag(null);
      }}
    />
  );
}

/**
 * 依存ライブラリ無しの軽量 SVG チャート。
 *
 * <p>🔴 **追尾できなかったフレームを下端の赤い目盛りで必ず出す。** 曲線だけを見せると、
 * 外れた点も「そういう動きをした」ように読めてしまう（数値と絵は別物・§6.4.1 の教訓）。
 */
/** 有限値の連なりごとに添字をまとめる（NaN を挟んだら段を切る）。 */
function splitFinite(values: readonly number[]): number[][] {
  const out: number[][] = [];
  let cur: number[] = [];
  for (let i = 0; i < values.length; i++) {
    if (Number.isFinite(values[i])) cur.push(i);
    else if (cur.length) { out.push(cur); cur = []; }
  }
  if (cur.length) out.push(cur);
  return out;
}

function SignalChart({
  series,
  marks,
  unreliable,
  current,
  onPick,
  testId,
  unit,
  domain,
  bands,
  pointColors,
  width = 760,
  height = 150,
}: {
  series: { label: string; color: string; values: number[] }[];
  marks?: number[];
  unreliable?: boolean[];
  current?: number;
  onPick?: (index: number) => void;
  testId: string;
  unit: string;
  /** y 域を固定する（ZNCC の 0..1）。省略すると今までどおり自動スケール。 */
  domain?: { lo: number; hi: number };
  /** 背景に敷く帯（造影前／造影後の区切り）。**区切り専用のグラフを作らずに済む**。 */
  bands?: PlotBand[];
  /** 点ごとの色（マスクの出自で塗り分ける）。 */
  pointColors?: (string | null)[];
  width?: number;
  height?: number;
}) {
  const pad = { l: 46, r: 10, t: 8, b: 18 };
  const iw = Math.max(1, width - pad.l - pad.r);
  const ih = Math.max(1, height - pad.t - pad.b);
  const n = Math.max(1, series[0]?.values.length ?? 1);

  const { lo, hi } = useMemo(() => {
    if (domain) return domain;
    let a = Infinity;
    let b = -Infinity;
    for (const s of series) for (const v of s.values) {
      if (Number.isFinite(v)) { a = Math.min(a, v); b = Math.max(b, v); }
    }
    if (!Number.isFinite(a)) { a = 0; b = 1; }
    const m = (b - a) * 0.1 || 1;
    return { lo: a - m, hi: b + m };
  }, [series, domain]);

  const xOf = (i: number): number => pad.l + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw);
  const yOf = (v: number): number => pad.t + ih - ((v - lo) / (hi - lo || 1)) * ih;

  return (
    <svg
      width={width}
      height={height}
      data-testid={testId}
      style={{
        background: "#10161d",
        border: "1px solid #26313d",
        borderRadius: 6,
        cursor: onPick ? "pointer" : "default",
        // 🚨 **パネルは flex 列なので、これが無いとグラフが潰れる。** 中身が増えて
        //    `maxHeight: 94vh` に当たった瞬間、flex アイテムである SVG が縮んで
        //    高さ 2px になった（実機で踏んだ。線も点も描かれているのに何も見えない）。
        flexShrink: 0,
      }}
      onClick={(e) => {
        if (!onPick) return;
        const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
        const i = Math.round(((e.clientX - r.left - pad.l) / iw) * (n - 1));
        if (i >= 0 && i < n) onPick(i);
      }}
    >
      {/* 🔑 帯は最背面に。造影前／造影後がどこかを、どのグラフでも同じ位置で読めるようにする。 */}
      {(bands ?? []).map((b) => (
        <rect
          key={`b${b.kind}${b.from}`}
          x={xOf(b.from)}
          y={pad.t}
          width={Math.max(1, xOf(Math.max(b.from, b.to - 1)) - xOf(b.from))}
          height={ih}
          fill={b.color}
        />
      ))}
      <line x1={pad.l} y1={yOf(0)} x2={width - pad.r} y2={yOf(0)} stroke="#2c3742" />
      <text x={4} y={pad.t + 9} fill="#7a8896" fontSize={10}>{`${hi.toFixed(1)} ${unit}`}</text>
      <text x={4} y={pad.t + ih} fill="#7a8896" fontSize={10}>{`${lo.toFixed(1)} ${unit}`}</text>
      {(marks ?? []).map((m) => (
        <line key={`m${m}`} x1={xOf(m)} y1={pad.t} x2={xOf(m)} y2={pad.t + ih} stroke="#3f5f7f" strokeDasharray="3 3" />
      ))}
      {/* 🚨 NaN で線を切る。繋ぐと「穴の無いなめらかな対応付け」に見えてしまう。 */}
      {series.map((s) =>
        splitFinite(s.values).map((seg, k) => (
          <polyline
            key={`${s.label}-${k}`}
            fill="none"
            stroke={s.color}
            strokeWidth={1.5}
            points={seg.map((i) => `${xOf(i)},${yOf(s.values[i])}`).join(" ")}
          />
        )),
      )}
      {/* 点ごとの色（マスクの出自）。線は繋がりを、点は出自を示す。 */}
      {pointColors && series[0]
        ? series[0].values.map((v, i) =>
            Number.isFinite(v) && pointColors[i]
              ? <circle key={`p${i}`} cx={xOf(i)} cy={yOf(v)} r={2} fill={pointColors[i] as string} />
              : null,
          )
        : null}
      {(unreliable ?? []).map((bad, i) =>
        bad ? <line key={`u${i}`} x1={xOf(i)} y1={height - pad.b + 2} x2={xOf(i)} y2={height - 4} stroke="#e06060" strokeWidth={2} /> : null,
      )}
      {current != null && current >= 0 && current < n && (
        <line x1={xOf(current)} y1={pad.t} x2={xOf(current)} y2={pad.t + ih} stroke="#dbe3ea" strokeWidth={1} />
      )}
      {series.map((s, i) => (
        <text key={`l${s.label}`} x={pad.l + 6 + i * 34} y={height - 5} fill={s.color} fontSize={10}>
          {s.label}
        </text>
      ))}
    </svg>
  );
}

/* ------------------------------------------------------------------ */

/** 無効なボタンを無効に見せる（`data-xadsa` の内側すべて）。 */
const DISABLED_CSS = `
[data-xadsa] button:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
`;

const PAIR_PREVIEW = 200;

const shell: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 200,
  pointerEvents: "none",
};
const panel: React.CSSProperties = {
  pointerEvents: "auto",
  background: "#1a2129",
  border: "1px solid #2c3742",
  borderRadius: 10,
  boxShadow: "0 12px 40px rgba(0,0,0,0.5)",
  padding: 14,
  color: "#dbe3ea",
  fontSize: 12,
  display: "flex",
  flexDirection: "column",
  gap: 8,
  maxWidth: "96vw",
  maxHeight: "94vh",
  overflow: "auto",
};
const header: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  fontWeight: 600,
  fontSize: 14,
  color: "#7fb2ec",
  cursor: "move",
  touchAction: "none",
  userSelect: "none",
};
const column: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 6 };
const colTitle: React.CSSProperties = { color: "#9fb0c0", fontWeight: 600 };
const hint: React.CSSProperties = { fontSize: 11, color: "#7a8896", maxWidth: 760 };
const box: React.CSSProperties = {
  background: "#10161d",
  border: "1px solid #26313d",
  borderRadius: 6,
  padding: "8px 10px",
  display: "flex",
  flexDirection: "column",
  gap: 8,
};
const chip: React.CSSProperties = {
  border: "1px solid #3a4650",
  borderRadius: 5,
  background: "#232c35",
  color: "#c3ccd5",
  cursor: "pointer",
  fontSize: 11,
  padding: "3px 9px",
};
const chipOn: React.CSSProperties = { ...chip, background: "#2b8aef", color: "#fff", border: "1px solid #2b8aef" };
const btnPrimary: React.CSSProperties = {
  border: "1px solid #2b8aef",
  borderRadius: 6,
  background: "#2b8aef",
  color: "#fff",
  cursor: "pointer",
  fontSize: 12,
  padding: "5px 12px",
  alignSelf: "flex-start",
};
