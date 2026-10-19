/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * つなぎ合わせダイアログ（第 1 段: 同じ座標系・同じ向きの部分シリーズを、重なりは平均で 1 本の派生シリーズにする）。
 * 設計: `fw/volume-regrid-design.md`「結合」。
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { metaData } from "@cornerstonejs/core";
import { useI18n } from "../i18n/i18n";
import type { Study, Series, Instance } from "../api";
import type { ViewerMode } from "../viewer/imageId";
import { loadRegVolume, type LoadedRegVolume } from "../viewer/regVolumeLoader";
import { estimateGridBytes } from "../viewer/gridResample";
import { saveDerivedVolume } from "../viewer/derivedVolumeSave";
import { runRigidInWorker } from "../viewer/regWorkerClient";
import {
  IDENTITY_PLACEMENT,
  defaultOutputSpacing,
  describePlacement,
  iopAngleDeg,
  placeInput,
  placementError,
  placementFromRigid,
  volumeCenter,
  type Placement,
} from "../viewer/stitchAlign";
import {
  accepted,
  buildAlignRequest,
  moveFromRegistration,
  overlapCrops,
  overlapNcc,
  pairOverlay,
  type AlignScope,
  type PairOverlay,
} from "../viewer/stitchAutoAlign";
import { suvForImageId } from "../viewer/suvStore";
import { extractSuvParams } from "../viewer/suv";
import { getAppliedVolumeMaxMb } from "../viewer/volumeMemory";
import {
  MipAccumulator,
  checkStitchInputs,
  coordinatesCoincide,
  estimateGains,
  matchEnds,
  normalOfIop,
  placeAlongNormal,
  previewSpacing,
  shiftInput,
  stitchSlices,
  unionGrid,
  type BlendOptions,
  type EndMatch,
  type MipImages,
  type StitchGrid,
  type StitchInput,
  type StitchViolation,
} from "../viewer/volumeStitch";
import {
  concatSlices,
  divideInput,
  petInfoFromSuvParams,
  stitchBackground,
  stitchDerivation,
  toStitchInput,
} from "../viewer/stitchInputs";
import { StitchMip } from "./StitchMip";
import { StitchAlignPanel, type AlignRow, type AutoLine } from "./StitchAlignPanel";

export interface StitchCandidate {
  id: string;
  study: Study;
  series: Series;
  instances: Instance[];
  c: number;
  t: number;
}

type Entry =
  | { state: "loading"; done: number; total: number }
  | { state: "ready"; loaded: LoadedRegVolume; input: StitchInput; suvScale: number | null }
  | { state: "unsupported" }
  | { state: "failed"; error: string };

const VIOLATIONS: StitchViolation[] = ["tooFew", "patient", "orientation", "modality", "petReference"];
const tick = () => new Promise<void>((r) => setTimeout(r, 0));
const MB = 1024 * 1024;

function parsePositive(s: string): number | null {
  const v = Number(s.trim());
  return s.trim() !== "" && Number.isFinite(v) && v > 0 ? v : null;
}

export function StitchDialog({
  patientId,
  candidates,
  mode,
  onClose,
}: {
  patientId: string;
  candidates: StitchCandidate[];
  mode: ViewerMode;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [entries, setEntries] = useState<Record<string, Entry>>({});
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [spOver, setSpOver] = useState<[string, string, string] | null>(null);
  const [bgOver, setBgOver] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const alive = useRef(true);
  // 位置の指定（座標が位置関係を表さないデータ用）。null は自動（座標が全部同じなら「重なりを指定」）。
  const [modeOver, setModeOver] = useState<"coord" | "overlap" | null>(null);
  const [overlapText, setOverlapText] = useState("0");
  // 重なりの指定: 共通（全部の組で同じ値・既定）／組ごと（並べた順の隣り合う組に 1 つずつ）。
  const [perPair, setPerPair] = useState(false);
  const [pairTexts, setPairTexts] = useState<string[]>([]);
  const [reverse, setReverse] = useState(false);
  const [orderOver, setOrderOver] = useState<string[] | null>(null);
  // 位置合わせ（シリーズ ID ごと）。基準のシリーズは動かさない。
  const [placements, setPlacements] = useState<Record<string, Placement>>({});
  const [refId, setRefId] = useState<string | null>(null);
  const [oblique, setOblique] = useState(false);
  const [alignOpen, setAlignOpen] = useState(false);
  const [autoScope, setAutoScope] = useState<AlignScope>("rigid");
  const [autoBusy, setAutoBusy] = useState(false);
  const [autoProgress, setAutoProgress] = useState("");
  const [autoLines, setAutoLines] = useState<AutoLine[]>([]);
  const autoStop = useRef(false);
  const autoHandle = useRef<{ abort(): void } | null>(null);
  const [checkPair, setCheckPair] = useState(0);
  const [overlay, setOverlay] = useState<PairOverlay | null>(null);
  const [overlayBusy, setOverlayBusy] = useState(false);
  const overlayGen = useRef(0);
  const [mip, setMip] = useState<{ images: MipImages; spacing: [number, number, number] } | null>(null);
  const [mipBusy, setMipBusy] = useState(false);
  const mipGen = useRef(0);
  // 重なりの扱い（線形ブレンドの範囲 %、信号合わせ）。
  const [blendMode, setBlendMode] = useState<"mean" | "linear">("linear");
  const [rangeText, setRangeText] = useState("100");
  const [gainOn, setGainOn] = useState(false);
  // 端の一致度による並び順・重なりの自動判定。手で触った後は上書きしない。
  const [match, setMatch] = useState<{ res: EndMatch; ids: string[] } | null>(null);
  const [matchBusy, setMatchBusy] = useState(false);
  const matchGen = useRef(0);
  const touchedOrder = useRef(false);
  const touchedOverlap = useRef(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState(0);
  useLayoutEffect(() => {
    const w = wrapRef.current?.clientWidth ?? 0;
    setBox(Math.max(0, Math.floor((w - 12) / 3)));
  }, []);

  useEffect(() => {
    alive.current = true;
    (async () => {
      for (const cand of candidates) {
        const set = (e: Entry) => alive.current && setEntries((p) => ({ ...p, [cand.id]: e }));
        set({ state: "loading", done: 0, total: cand.instances.length });
        try {
          const v = await loadRegVolume(
            mode, cand.study.studyInstanceUid, cand.series.seriesInstanceUid, cand.instances, cand.c, cand.t,
            (n, all) => set({ state: "loading", done: n, total: all }),
          );
          if (!alive.current) return;
          if (!v) { set({ state: "unsupported" }); continue; }
          let pet;
          if ((v.modality === "PT" || v.modality === "NM") && v.firstImageId) {
            pet = petInfoFromSuvParams(extractSuvParams(v.firstImageId));
          }
          const suv = suvForImageId(v.firstImageId ?? undefined);
          set({
            state: "ready", loaded: v, input: toStitchInput(v, patientId, pet), suvScale: suv ? suv.scale : null,
          });
          setChecked((p) => ({ ...p, [cand.id]: true }));
        } catch (e) {
          set({ state: "failed", error: String(e) });
        }
        await tick();
      }
    })();
    return () => { alive.current = false; autoStop.current = true; autoHandle.current?.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const picked = useMemo(
    () => candidates.filter((c) => checked[c.id] && entries[c.id]?.state === "ready"),
    [candidates, checked, entries],
  );
  const pickedKey = picked.map((c) => c.id).join("|");
  // 並べる順（↑↓で変えたもの。無いものは候補の順のまま後ろ）。
  const selected = useMemo(() => {
    if (!orderOver) return picked;
    const rank = new Map(orderOver.map((id, n) => [id, n] as const));
    return [...picked].sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity));
  }, [picked, orderOver]);
  useEffect(() => { setSpOver(null); setBgOver(null); setPairTexts([]); }, [pickedKey]);

  // SUV の乗数がかかっている入力は、入力ごとの乗数でモダリティ値へ戻す（保存・プレビューとも同じ値で結合する）。
  const baseById = useMemo(
    () => new Map(picked.map((c) => {
      const e = entries[c.id] as Extract<Entry, { state: "ready" }>;
      return [c.id, e.suvScale != null ? divideInput(e.input, e.suvScale) : e.input] as const;
    })),
    [picked, entries],
  );
  const bases = useMemo(() => selected.map((c) => baseById.get(c.id) as StitchInput), [selected, baseById]);

  // 選択が変わったら、端の一致度で並び順と重なりを決め直す（読み込み直後に並べ替えなくて済むように）。
  useEffect(() => {
    const gen = ++matchGen.current;
    touchedOrder.current = false;
    touchedOverlap.current = false;
    if (picked.length < 2) { setMatch(null); setMatchBusy(false); return; }
    setMatchBusy(true);
    const ids = picked.map((c) => c.id);
    const ins = ids.map((id) => baseById.get(id) as StitchInput);
    (async () => {
      await tick();
      if (gen !== matchGen.current) return;
      const res = matchEnds(ins);
      if (gen !== matchGen.current) return;
      setMatch({ res, ids });
      setMatchBusy(false);
      if (!res.comparable) return;
      if (!touchedOrder.current) { setOrderOver(res.order.map((i) => ids[i])); setReverse(false); }
      if (!touchedOverlap.current && res.pairs.length > 0) {
        const mm = res.pairs.map((p) => p.overlapMm).sort((a, b) => a - b);
        const med = mm.length % 2 ? mm[(mm.length - 1) / 2] : (mm[mm.length / 2 - 1] + mm[mm.length / 2]) / 2;
        setOverlapText(String(Math.round(med * 10) / 10));
      }
    })().catch((e) => { if (gen === matchGen.current) { setMatch(null); setMatchBusy(false); setMsg(String(e)); } });
    return () => { matchGen.current++; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickedKey]);

  const coincide = useMemo(() => coordinatesCoincide(bases), [bases]);
  const placeMode = modeOver ?? (coincide ? "overlap" : "coord");
  const overlapVal = Number(overlapText.trim());
  const overlapValid = overlapText.trim() !== "" && Number.isFinite(overlapVal);
  // 組ごとの欄は、まだ触っていなければ共通の値を使う（切り替えた直後は結果が変わらない）。
  const pairCount = Math.max(0, bases.length - 1);
  const pairText = (i: number) => pairTexts[i] ?? overlapText;
  const pairVals = Array.from({ length: pairCount }, (_, i) => pairText(i).trim() === "" ? NaN : Number(pairText(i).trim()));
  const pairsValid = pairVals.every((v) => Number.isFinite(v));
  const overlapUsable = perPair ? pairsValid : overlapValid;
  const pairKey = pairVals.join("|");
  const refIdx = Math.max(0, selected.findIndex((c) => c.id === refId));
  // 基準を明示して選んだときだけ、出力の間隔と属性のテンプレートを基準から引き継ぐ（選ばない間は従来どおり）。
  const explicitRef = refId !== null && selected.some((c) => c.id === refId);
  const outSpacing = useMemo(
    () => (bases.length > 0 ? defaultOutputSpacing(bases, explicitRef ? refIdx : null) : undefined),
    [bases, explicitRef, refIdx],
  );
  const normal = useMemo(
    () => (bases.length > 0 ? normalOfIop(bases[Math.min(refIdx, bases.length - 1)].iop) : ([0, 0, 1] as [number, number, number])),
    [bases, refIdx],
  );
  const shifts = useMemo(
    () => (placeMode === "overlap" && overlapUsable && bases.length > 1
      ? placeAlongNormal(bases, perPair ? pairKey.split("|").map(Number) : overlapVal, reverse, refIdx)
      : bases.map(() => 0)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [placeMode, overlapUsable, perPair, pairKey, overlapVal, bases, reverse, refIdx],
  );
  const shifted = useMemo(() => bases.map((b, n) => shiftInput(b, shifts[n], normal)), [bases, shifts, normal]);
  const plOf = (id: string): Placement => placements[id] ?? IDENTITY_PLACEMENT;
  const alignErr = selected.some((c, n) => n !== refIdx && placementError(plOf(c.id)) !== null);
  const rotated = selected.some((c, n) => {
    const p = plOf(c.id);
    return n !== refIdx && (p.rx !== 0 || p.ry !== 0 || p.rz !== 0 || p.flipX || p.flipY || p.flipZ);
  });
  const placementsKey = selected.map((c) => JSON.stringify(plOf(c.id))).join("|");
  const inputs = useMemo(
    () => shifted.map((b, n) => (n === refIdx || alignErr ? b : placeInput(b, plOf(selected[n].id)))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [shifted, refIdx, alignErr, placementsKey],
  );

  const check = useMemo(
    () => checkStitchInputs(inputs, { orientation: oblique || rotated ? "resample" : "strict" }),
    [inputs, oblique, rotated],
  );

  const rangeVal = Number(rangeText.trim());
  const rangeValid = rangeText.trim() !== "" && Number.isFinite(rangeVal) && rangeVal > 0 && rangeVal <= 100;
  const gainInfo = useMemo(() => (gainOn && check.ok ? estimateGains(inputs) : null), [gainOn, check.ok, inputs]);
  const blend = useMemo<BlendOptions>(
    () => ({ mode: blendMode, fraction: rangeValid ? rangeVal / 100 : 1, gains: gainInfo?.gains }),
    [blendMode, rangeValid, rangeVal, gainInfo],
  );

  // 条件を満たすときだけ格子を作る（違反があれば何も計算しない）。
  const plan = useMemo((): { grid: StitchGrid | null; base: StitchGrid | null; reason: string } => {
    if (!check.ok) return { grid: null, base: null, reason: "" };
    if (alignErr) return { grid: null, base: null, reason: t("stitch.invalidAlign") };
    if (placeMode === "overlap" && !overlapUsable) return { grid: null, base: null, reason: t("stitch.invalidOverlap") };
    if (blendMode === "linear" && !rangeValid) return { grid: null, base: null, reason: t("stitch.invalidRange") };
    try {
      const base = unionGrid(inputs, outSpacing, refIdx);
      if (!spOver) return { grid: base, base, reason: "" };
      const sp = spOver.map(parsePositive);
      if (sp.some((v) => v === null)) return { grid: null, base, reason: t("stitch.invalidSpacing") };
      return { grid: unionGrid(inputs, sp as [number, number, number], refIdx), base, reason: "" };
    } catch (e) {
      return { grid: null, base: null, reason: String(e) };
    }
  }, [check, inputs, spOver, t, placeMode, overlapUsable, blendMode, rangeValid, refIdx, alignErr, outSpacing]);

  const defaultBg = useMemo(() => (check.ok ? stitchBackground(inputs) : 0), [check.ok, inputs]);
  const bgText = bgOver ?? String(defaultBg);
  const bgValue = Number(bgText.trim());
  const bgValid = bgText.trim() !== "" && Number.isFinite(bgValue);

  const grid = plan.grid;

  // MIP プレビュー: 表示する大きさに合わせた粗い格子で結合し、3 方向の最大を集計する。設定が変わるたびに計算し直す
  // （入力の途中で何度も走らないよう少し待ち、古い計算は世代番号で捨てる）。
  useEffect(() => {
    const gen = ++mipGen.current;
    if (!grid || !check.ok || box <= 0) { setMip(null); setMipBusy(false); return; }
    setMipBusy(true);
    (async () => {
      await new Promise((r) => setTimeout(r, 150));
      if (gen !== mipGen.current) return;
      const sp = previewSpacing(grid, Math.round(box * (window.devicePixelRatio || 1)));
      const pg = unionGrid(inputs, sp, refIdx);
      const acc = new MipAccumulator(pg.dims);
      let k = 0;
      for (const s of stitchSlices(inputs, pg, blend)) {
        acc.add(k++, s);
        if (k % 2 === 0) {
          await tick();
          if (gen !== mipGen.current) return;
        }
      }
      if (gen !== mipGen.current) return;
      setMip({ images: acc.result(), spacing: pg.spacing });
      setMipBusy(false);
    })().catch((e) => { if (gen === mipGen.current) { setMip(null); setMipBusy(false); setMsg(String(e)); } });
    return () => { mipGen.current++; };
  }, [grid, check.ok, inputs, box, blend, refIdx]);

  // ずれの確認: 隣り合う 2 本の重なり部分を別々に引いて色で重ねる。位置合わせ欄を開いているときだけ計算する。
  const pairIdx = Math.min(checkPair, Math.max(0, inputs.length - 2));
  const pairNcc = useMemo(
    () => (alignOpen && check.ok && inputs.length >= 2 ? overlapNcc(inputs[pairIdx], inputs[pairIdx + 1]) : null),
    [alignOpen, check.ok, inputs, pairIdx],
  );
  useEffect(() => {
    const gen = ++overlayGen.current;
    if (!alignOpen || !check.ok || inputs.length < 2 || box <= 0) { setOverlay(null); setOverlayBusy(false); return; }
    setOverlayBusy(true);
    (async () => {
      await new Promise((r) => setTimeout(r, 200));
      if (gen !== overlayGen.current) return;
      const ov = await pairOverlay(
        inputs[pairIdx], inputs[pairIdx + 1], Math.round(box * (window.devicePixelRatio || 1)),
        pairIdx + 1 === refIdx ? 1 : 0, () => gen === overlayGen.current, tick,
      );
      if (gen !== overlayGen.current) return;
      setOverlay(ov);
      setOverlayBusy(false);
    })().catch((e) => { if (gen === overlayGen.current) { setOverlay(null); setOverlayBusy(false); setMsg(String(e)); } });
    return () => { overlayGen.current++; };
  }, [alignOpen, check.ok, inputs, pairIdx, box, refIdx]);

  // 自動で合わせる: 基準から外へ、隣り合う組を順に（固定 = 合わせ済みの隣、移動 = 次）。重なり部分の相関が上がったときだけ採る。
  const runAuto = async () => {
    if (autoBusy || selected.length < 2 || !check.ok) return;
    setAutoBusy(true);
    setAutoLines([]);
    autoStop.current = false;
    const lines: AutoLine[] = [];
    const cur = inputs.slice();
    const next: Record<string, Placement> = { ...placements };
    const order: Array<[number, number]> = [];
    for (let m = refIdx + 1; m < selected.length; m++) order.push([m, m - 1]);
    for (let m = refIdx - 1; m >= 0; m--) order.push([m, m + 1]);
    const forOf = (id: string) => (entries[id] as Extract<Entry, { state: "ready" }>).loaded.frameOfReferenceUid;
    try {
      for (let s = 0; s < order.length && !autoStop.current; s++) {
        const [m, f] = order[s];
        const id = selected[m].id, fid = selected[f].id;
        const key = `${fid}>${id}`;
        setAutoProgress(t("align.auto.running", { name: nameOf(id), n: s + 1, total: order.length }));
        await tick();
        const cp = next[id] ?? IDENTITY_PLACEMENT;
        const keep = { ...IDENTITY_PLACEMENT, sx: cp.sx, sy: cp.sy, sz: cp.sz, flipX: cp.flipX, flipY: cp.flipY, flipZ: cp.flipZ };
        const mov = placeInput(shifted[m], keep);
        const fixed = cur[f];
        const crops = overlapCrops(fixed, mov);
        const base0 = overlapNcc(fixed, mov);
        if (!crops || !base0) { lines.push({ key, kind: "noOverlap", a: fid, b: id }); setAutoLines([...lines]); continue; }
        const sameFor = forOf(fid) === forOf(id);
        if (!sameFor) lines.push({ key: `${key}-for`, kind: "forDiff", a: fid, b: id });
        const handle = runRigidInWorker(
          buildAlignRequest(crops.a, crops.b, { scope: autoScope, sameFrameOfReference: sameFor }),
          (p) => setAutoProgress(`${t("align.auto.running", { name: nameOf(id), n: s + 1, total: order.length })} ${Math.round(p.fraction * 100)}%`),
        );
        autoHandle.current = handle;
        let done;
        try {
          done = await handle.promise;
        } catch (e) {
          if (autoStop.current) break;
          lines.push({ key, kind: "failed", a: fid, b: id, err: String(e) });
          setAutoLines([...lines]);
          continue;
        } finally {
          autoHandle.current = null;
        }
        const move = moveFromRegistration(done.matrix);
        if (!move || done.aborted) { lines.push({ key, kind: "failed", a: fid, b: id, err: "no result" }); setAutoLines([...lines]); continue; }
        const pl: Placement = { ...placementFromRigid(move, volumeCenter(shifted[m])), sx: cp.sx, sy: cp.sy, sz: cp.sz, flipX: cp.flipX, flipY: cp.flipY, flipZ: cp.flipZ };
        const placed = placeInput(shifted[m], pl);
        const after = overlapNcc(fixed, placed);
        const before = Math.max(base0.ncc, overlapNcc(fixed, cur[m])?.ncc ?? -Infinity);
        if (after && accepted(before, after.ncc, after.count)) {
          next[id] = pl;
          cur[m] = placed;
          setPlacements({ ...next });
          lines.push({ key, kind: "applied", a: fid, b: id, before, after: after.ncc });
        } else {
          lines.push({ key, kind: "rejected", a: fid, b: id, before, after: after?.ncc ?? NaN });
        }
        setAutoLines([...lines]);
      }
    } catch (e) {
      setMsg(String(e));
    } finally {
      autoHandle.current = null;
      if (alive.current) { setAutoBusy(false); setAutoProgress(""); setAutoLines([...lines]); }
    }
  };

  const alignRows: AlignRow[] = selected.map((c, n) => ({
    id: c.id,
    name: c.series.seriesDescription || c.series.seriesInstanceUid,
    isRef: n === refIdx,
    placement: plOf(c.id),
    angleDeg: iopAngleDeg(bases[refIdx].iop, bases[n].iop),
  }));

  const move = (n: number, d: -1 | 1) => {
    const ids = selected.map((c) => c.id);
    const m = n + d;
    if (m < 0 || m >= ids.length) return;
    [ids[n], ids[m]] = [ids[m], ids[n]];
    touchedOrder.current = true;
    setOrderOver(ids);
  };
  const dom = normal.map(Math.abs).indexOf(Math.max(...normal.map(Math.abs)));
  const sign = reverse ? -1 : 1;
  const dirLabel = dom === 2 ? (normal[2] * sign > 0 ? t("stitch.dir.head") : t("stitch.dir.foot")) : (sign > 0 ? t("stitch.dir.plus") : t("stitch.dir.minus"));
  const nameOf = (id: string) => {
    const c = candidates.find((x) => x.id === id);
    return c ? c.series.seriesDescription || c.series.seriesInstanceUid : id;
  };
  const hasPet = selected.some((c) => {
    const m = (entries[c.id] as Extract<Entry, { state: "ready" }>).loaded.modality;
    return m === "PT" || m === "NM";
  });
  const outMb = grid ? Math.round(estimateGridBytes(grid) / MB) : 0;
  const inMb = Math.round(inputs.reduce((s, x) => s + x.volume.data.byteLength, 0) / MB);

  const onSave = async () => {
    if (!grid || !check.ok || !bgValid || busy) return;
    const totalMb = outMb + inMb;
    const limitMb = getAppliedVolumeMaxMb();
    if (totalMb > limitMb && !window.confirm(t("stitch.confirmMemory", { mb: totalMb, limit: limitMb }))) return;
    const flipped = selected.some((c, n) => n !== refIdx && (plOf(c.id).flipX || plOf(c.id).flipY || plOf(c.id).flipZ));
    if (flipped && !window.confirm(t("align.confirmFlip"))) return;
    setBusy(true);
    setMsg(t("stitch.saving"));
    try {
      await tick();
      const data = concatSlices(stitchSlices(inputs, grid, blend), grid);
      // テンプレート（属性を引き継ぐ 1 本）は、基準を明示したときはその基準、そうでなければ法線方向で最も手前の入力。
      let front = 0;
      grid.intervals.forEach((iv, n) => { if (iv[0] < grid.intervals[front][0]) front = n; });
      const tpl = explicitRef ? selected[refIdx] : selected[front];
      const first = (entries[tpl.id] as Extract<Entry, { state: "ready" }>).loaded.firstImageId ?? undefined;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const plane = first ? (metaData.get("imagePlaneModule", first) as any) : null;
      const th = Number(plane?.sliceThickness);
      const res = await saveDerivedVolume({
        grid,
        data,
        studyUid: tpl.study.studyInstanceUid,
        seriesUid: tpl.series.seriesInstanceUid,
        seriesDescription: `${tpl.series.seriesDescription || "Series"} Stitched`,
        derivationDescription: stitchDerivation(
          selected.map((c) => c.series.seriesInstanceUid), grid, blend,
          selected.map((c, n) => (n === refIdx ? "" : describePlacement(plOf(c.id)))),
        ),
        sourceSliceThickness: Number.isFinite(th) && th > 0 ? th : null,
        suvScale: null,
        background: bgValue,
      });
      if (alive.current) setMsg(t("stitch.saved", { n: res.count }));
    } catch (e) {
      if (alive.current) setMsg(`${t("stitch.saveFailed")}: ${String(e)}`);
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const f1 = (v: number) => v.toFixed(1);
  const f2 = (v: number) => v.toFixed(2);
  const spText: [string, string, string] = spOver ?? (plan.base
    ? [String(Math.round(plan.base.spacing[0] * 100) / 100), String(Math.round(plan.base.spacing[1] * 100) / 100), String(Math.round(plan.base.spacing[2] * 100) / 100)]
    : ["", "", ""]);
  const setSp = (idx: number, v: string) => {
    const next: [string, string, string] = [...spText] as [string, string, string];
    next[idx] = v;
    setSpOver(next);
  };

  // 区間の並び（法線方向、mm）。plan.base があるときだけ。
  const rangeLines = plan.base
    ? selected.map((c, n) => `${c.series.seriesDescription || c.series.seriesInstanceUid}: ${f1(plan.base!.intervals[n][0])} 〜 ${f1(plan.base!.intervals[n][1])}`)
    : [];

  return (
    <div style={backdrop} data-testid="stitch-dialog">
      <div style={panel}>
        <div style={header}>{t("stitch.title")}</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }} data-testid="stitch-candidates">
          {candidates.map((c) => {
            const e = entries[c.id];
            const ready = e?.state === "ready";
            const v = ready ? e.loaded.volume : null;
            let info = "";
            if (!e || e.state === "loading") info = `${t("stitch.loading")} ${e?.state === "loading" ? `${e.done}/${e.total}` : ""}`;
            else if (e.state === "unsupported") info = t("stitch.unsupported");
            else if (e.state === "failed") info = `${t("stitch.loadFailed")}: ${e.error}`;
            else if (v) info = `${e.loaded.modality}  ${v.dims[0]}×${v.dims[1]}×${v.dims[2]}  ${f2(v.spacing[0])}×${f2(v.spacing[1])}×${f2(v.spacing[2])} mm`;
            return (
              <label key={c.id} style={row} data-testid={`stitch-candidate-${c.series.seriesInstanceUid}`}>
                <input
                  type="checkbox"
                  checked={!!checked[c.id]}
                  disabled={!ready || busy}
                  onChange={(ev) => setChecked((p) => ({ ...p, [c.id]: ev.target.checked }))}
                  data-testid={`stitch-check-${c.series.seriesInstanceUid}`}
                />
                <span>{c.series.seriesDescription || c.series.seriesInstanceUid}</span>
                <span style={{ color: "#8a98a6" }}>{info}</span>
              </label>
            );
          })}
        </div>

        <div style={{ fontSize: 12 }} data-testid="stitch-conditions">
          {VIOLATIONS.filter((k) => k !== "petReference" || hasPet).map((k) => {
            const bad = check.violations.includes(k);
            const noInput = selected.length === 0;
            const mark = noInput ? "–" : bad ? "✗" : "✓";
            return (
              <div key={k} style={{ color: bad ? "#e8a0a0" : "#c8d2dc" }} data-testid={`stitch-cond-${k}`} data-ok={!noInput && !bad}>
                {mark} {bad ? t(`stitch.reason.${k}`) : t(`stitch.ok.${k}`)}
              </div>
            );
          })}
        </div>

        {picked.length >= 2 && (
          <div style={{ fontSize: 12, display: "flex", flexDirection: "column", gap: 4 }} data-testid="stitch-place">
            <label style={row}>
              {t("stitch.place")}:
              <input type="radio" name="stitch-place" checked={placeMode === "coord"} onChange={() => setModeOver("coord")} data-testid="stitch-place-coord" /> {t("stitch.place.coord")}
              <input type="radio" name="stitch-place" checked={placeMode === "overlap"} onChange={() => setModeOver("overlap")} data-testid="stitch-place-overlap" /> {t("stitch.place.overlap")}
            </label>
            {placeMode === "overlap" && (
              <>
                {coincide && modeOver === null && <div style={{ color: "#9fd0ff" }} data-testid="stitch-place-note">{t("stitch.placeNote")}</div>}
                <label style={row}>
                  {t("stitch.overlapScope")}:
                  <input type="radio" name="stitch-overlap-scope" checked={!perPair} onChange={() => setPerPair(false)} data-testid="stitch-scope-common" /> {t("stitch.scope.common")}
                  <input type="radio" name="stitch-overlap-scope" checked={perPair} onChange={() => { setPairTexts(Array.from({ length: pairCount }, () => overlapText)); setPerPair(true); }} data-testid="stitch-scope-pair" /> {t("stitch.scope.pair")}
                </label>
                {!perPair && (
                  <label style={row}>
                    {t("stitch.overlapInput")}
                    <input style={num} value={overlapText} onChange={(e) => { touchedOverlap.current = true; setOverlapText(e.target.value); }} data-testid="stitch-overlap-input" />
                    {t("stitch.overlapHint")}
                  </label>
                )}
                {perPair && selected.slice(0, -1).map((_, i) => (
                  <label key={i} style={{ ...row, paddingLeft: 8 }}>
                    {t("stitch.pairLabel", { a: String(i + 1), b: String(i + 2) })}
                    <input style={num} value={pairText(i)} onChange={(e) => setPairTexts((old) => Array.from({ length: pairCount }, (_, k) => (k === i ? e.target.value : old[k] ?? overlapText)))} data-testid={`stitch-pair-input-${i}`} />
                    {t("stitch.overlapHint")}
                  </label>
                ))}
                <label style={row}>
                  {t("stitch.dir")}
                  <button type="button" style={btn} onClick={() => setReverse((r) => !r)} data-testid="stitch-reverse">{dirLabel}</button>
                </label>
                {matchBusy && <div style={{ color: "#8a98a6" }} data-testid="stitch-match-busy">{t("stitch.matchBusy")}</div>}
                {!matchBusy && match && !match.res.comparable && <div style={{ color: "#8a98a6" }} data-testid="stitch-match-none">{t("stitch.matchNone")}</div>}
                {!matchBusy && match && match.res.comparable && match.res.pairs.length > 0 && (
                  <div style={{ color: "#c8d2dc" }} data-testid="stitch-match">
                    {t("stitch.match")}
                    {match.res.pairs.map((p, n) => (
                      <div key={n} style={{ paddingLeft: 8 }} data-testid={`stitch-match-pair-${n}`} data-score={p.score.toFixed(3)} data-overlap={p.overlapMm}>
                        {nameOf(match.ids[p.from])} → {nameOf(match.ids[p.to])}: {t("stitch.matchLine", { score: p.score.toFixed(2), mm: String(Math.round(p.overlapMm * 10) / 10) })}
                      </div>
                    ))}
                    {match.res.margin !== null && <div style={{ paddingLeft: 8 }} data-testid="stitch-match-margin">{t("stitch.matchMargin", { margin: match.res.margin.toFixed(2) })}</div>}
                  </div>
                )}
                <div style={{ display: "flex", flexDirection: "column", gap: 2 }} data-testid="stitch-order">
                  {t("stitch.order")}
                  {selected.map((c, n) => (
                    <div key={c.id} style={{ ...row, paddingLeft: 8 }}>
                      <span>{n + 1}. {c.series.seriesDescription || c.series.seriesInstanceUid}</span>
                      <button type="button" style={btn} disabled={n === 0} onClick={() => move(n, -1)} title={t("stitch.up")} data-testid={`stitch-up-${n}`}>↑</button>
                      <button type="button" style={btn} disabled={n === selected.length - 1} onClick={() => move(n, 1)} title={t("stitch.down")} data-testid={`stitch-down-${n}`}>↓</button>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        {picked.length >= 2 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <button type="button" style={{ ...btn, alignSelf: "flex-start" }} onClick={() => setAlignOpen((v) => !v)} data-testid="stitch-align-toggle">
              {alignOpen ? "▾" : "▸"} {t("align.title")}
            </button>
            {check.violations.includes("orientation") && !oblique && !rotated && (
              <div style={{ fontSize: 12, color: "#e8c88a" }} data-testid="stitch-orientation-hint">{t("align.orientationHint")}</div>
            )}
            {alignOpen && (
              <StitchAlignPanel
                rows={alignRows}
                onChange={(id, p) => setPlacements((o) => ({ ...o, [id]: p }))}
                onMakeReference={(id) => { setRefId(id); setPlacements((o) => ({ ...o, [id]: { ...IDENTITY_PLACEMENT } })); }}
                oblique={oblique}
                onOblique={setOblique}
                obliqueNeeded={rotated}
                autoScope={autoScope}
                onAutoScope={setAutoScope}
                autoBusy={autoBusy}
                autoProgress={autoProgress}
                onAuto={runAuto}
                onStop={() => { autoStop.current = true; autoHandle.current?.abort(); }}
                autoLines={autoLines}
                check={overlay}
                checkNcc={pairNcc}
                checkPair={pairIdx}
                pairCount={Math.max(0, selected.length - 1)}
                onCheckPair={setCheckPair}
                checkBusy={overlayBusy}
                checkBox={box}
              />
            )}
          </div>
        )}

        {plan.base && (
          <div style={{ fontSize: 12, color: "#c8d2dc" }}>
            <div data-testid="stitch-ranges">
              {t("stitch.ranges")}
              {rangeLines.map((l, n) => <div key={n} style={{ paddingLeft: 8 }}>{l}</div>)}
            </div>
            <div data-testid="stitch-overlap">
              {t("stitch.overlapGap", { overlap: f1(plan.base.overlapMm), gap: f1(plan.base.gapMm) })}
            </div>
          </div>
        )}

        <div ref={wrapRef}>
          <StitchMip
            mip={mip ? mip.images : null}
            spacing={mip ? mip.spacing : null}
            box={box}
            labels={{ ax: t("stitch.mip.ax"), sag: t("stitch.mip.sag"), cor: t("stitch.mip.cor") }}
            busy={mipBusy}
          />
        </div>
        <label style={row}>
          {t("stitch.overlapMode")}:
          <input type="radio" name="stitch-blend" checked={blendMode === "linear"} onChange={() => setBlendMode("linear")} data-testid="stitch-blend-linear" /> {t("stitch.linear")}
          <input type="radio" name="stitch-blend" checked={blendMode === "mean"} onChange={() => setBlendMode("mean")} data-testid="stitch-blend-mean" /> {t("stitch.mean")}
          {blendMode === "linear" && (
            <>
              <span style={{ marginLeft: 12 }}>{t("stitch.range")}</span>
              <input style={num} value={rangeText} onChange={(e) => setRangeText(e.target.value)} data-testid="stitch-range" /> %
            </>
          )}
        </label>
        <label style={row} title={t("stitch.gainNote")}>
          <input type="checkbox" checked={gainOn} onChange={(e) => setGainOn(e.target.checked)} data-testid="stitch-gain" /> {t("stitch.gain")}
        </label>
        {gainOn && gainInfo && (
          <div style={{ fontSize: 12, color: "#c8d2dc" }} data-testid="stitch-gains">
            {selected.map((c, n) => (
              <div key={c.id} style={{ paddingLeft: 8 }} data-gain={gainInfo.gains[n].toFixed(4)} data-estimable={gainInfo.estimable[n]}>
                {c.series.seriesDescription || c.series.seriesInstanceUid}: {gainInfo.estimable[n] ? `×${gainInfo.gains[n].toFixed(3)}` : t("stitch.gainNone")}
              </div>
            ))}
          </div>
        )}
        <label style={row}>
          {t("stitch.spacing")}
          {t("stitch.col")}<input style={num} value={spText[0]} disabled={!plan.base} onChange={(e) => setSp(0, e.target.value)} data-testid="stitch-sp-col" />
          {t("stitch.row")}<input style={num} value={spText[1]} disabled={!plan.base} onChange={(e) => setSp(1, e.target.value)} data-testid="stitch-sp-row" />
          {t("stitch.slice")}<input style={num} value={spText[2]} disabled={!plan.base} onChange={(e) => setSp(2, e.target.value)} data-testid="stitch-sp-slice" /> mm
        </label>
        <label style={row}>
          {t("stitch.background")}
          <input style={num} value={bgText} disabled={!plan.base} onChange={(e) => setBgOver(e.target.value)} data-testid="stitch-background" />
        </label>

        <div style={{ fontSize: 12, color: grid && bgValid ? "#c8d2dc" : "#e8a0a0" }} data-testid="stitch-output">
          {grid
            ? bgValid
              ? t("stitch.output", { cols: grid.dims[0], rows: grid.dims[1], n: grid.dims[2], mb: outMb })
              : t("stitch.invalidBackground")
            : plan.reason}
        </div>
        {msg && <div style={{ fontSize: 12, color: "#9fd0ff" }} data-testid="stitch-message">{msg}</div>}
        <div style={footer}>
          <button type="button" onClick={onClose} style={btn} data-testid="stitch-close">{t("stitch.close")}</button>
          <button type="button" onClick={onSave} disabled={!grid || !check.ok || !bgValid || busy} style={btnPrimary} data-testid="stitch-save">
            {t("stitch.save")}
          </button>
        </div>
      </div>
    </div>
  );
}

const backdrop: React.CSSProperties = {
  position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)",
  display: "flex", alignItems: "center", justifyContent: "center", zIndex: 200,
};
const panel: React.CSSProperties = {
  background: "#1a2129", border: "1px solid #2c3742", borderRadius: 8, padding: 14,
  minWidth: 640, maxWidth: 760, maxHeight: "92vh", overflowY: "auto", display: "flex", flexDirection: "column", gap: 10, color: "#e8edf2",
};
const header: React.CSSProperties = { fontWeight: 600, fontSize: 14 };
const row: React.CSSProperties = { display: "flex", alignItems: "center", gap: 6, fontSize: 12 };
const num: React.CSSProperties = {
  width: 70, background: "#0f151b", color: "#e8edf2", border: "1px solid #2c3742", borderRadius: 4, padding: "2px 4px",
};
const footer: React.CSSProperties = {
  display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 2,
  position: "sticky", bottom: -14, background: "#1a2129", padding: "8px 0 0",
};
const btn: React.CSSProperties = {
  background: "#26303a", color: "#e8edf2", border: "1px solid #2c3742", borderRadius: 4, padding: "4px 12px", cursor: "pointer",
};
const btnPrimary: React.CSSProperties = { ...btn, background: "#2b8aef", border: "1px solid #2b8aef", color: "#fff" };
