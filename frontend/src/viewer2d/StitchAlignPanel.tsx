/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * つなぎ合わせの位置合わせ欄（シリーズごとの平行移動・回転・拡大・反転、自動、ずれの確認）。
 * 状態と計算は StitchDialog が持ち、ここは表示と入力だけ。
 */
import { useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n/i18n";
import { IDENTITY_PLACEMENT, isIdentityPlacement, type Placement } from "../viewer/stitchAlign";
import type { AlignScope, PairOverlay } from "../viewer/stitchAutoAlign";

export interface AlignRow {
  id: string;
  name: string;
  isRef: boolean;
  placement: Placement;
  /** 基準との向きの角度 [度]。 */
  angleDeg: number;
}

export interface AutoLine {
  key: string;
  kind: "applied" | "rejected" | "noOverlap" | "failed" | "forDiff";
  a: string;
  b: string;
  before?: number;
  after?: number;
  err?: string;
}

/** 数値入力。入力途中（"-"・"1."）を許し、有効な数だけ親へ渡す。フォーカス中は親からの値で上書きしない。 */
function NumField({ value, onChange, testid, width = 62 }: {
  value: number; onChange: (v: number) => void; testid: string; width?: number;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const fmt = (v: number) => String(Math.round(v * 1000) / 1000);
  const [text, setText] = useState(fmt(value));
  useEffect(() => {
    if (document.activeElement !== ref.current) setText(fmt(value));
  }, [value]);
  const bad = text.trim() === "" || !Number.isFinite(Number(text));
  return (
    <input
      ref={ref}
      value={text}
      style={{ ...num, width, borderColor: bad ? "#e8a0a0" : "#2c3742" }}
      onChange={(e) => {
        setText(e.target.value);
        const n = Number(e.target.value);
        if (e.target.value.trim() !== "" && Number.isFinite(n)) onChange(n);
      }}
      onBlur={() => setText(fmt(value))}
      data-testid={testid}
    />
  );
}

function Stepper({ value, step, onChange, testid, tip }: {
  value: number; step: number; onChange: (v: number) => void; testid: string; tip: string;
}) {
  const r = (v: number) => Math.round(v * 1e6) / 1e6;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 2 }} title={tip}>
      <button type="button" style={mini} onClick={() => onChange(r(value - step))} data-testid={`${testid}-minus`}>−</button>
      <NumField value={value} onChange={onChange} testid={testid} />
      <button type="button" style={mini} onClick={() => onChange(r(value + step))} data-testid={`${testid}-plus`}>＋</button>
    </span>
  );
}

const AXES = ["X", "Y", "Z"] as const;
const TR_STEPS = [0.1, 1, 5];
const ROT_STEPS = [0.1, 0.5, 1, 5];

export function StitchAlignPanel({
  rows, onChange, onMakeReference, oblique, onOblique, obliqueNeeded,
  autoScope, onAutoScope, autoBusy, autoProgress, onAuto, onStop, autoLines,
  check, checkNcc, checkPair, pairCount, onCheckPair, checkBusy, checkBox,
}: {
  rows: AlignRow[];
  onChange: (id: string, p: Placement) => void;
  onMakeReference: (id: string) => void;
  oblique: boolean;
  onOblique: (v: boolean) => void;
  obliqueNeeded: boolean;
  autoScope: AlignScope;
  onAutoScope: (s: AlignScope) => void;
  autoBusy: boolean;
  autoProgress: string;
  onAuto: () => void;
  onStop: () => void;
  autoLines: AutoLine[];
  check: PairOverlay | null;
  checkNcc: { ncc: number; count: number } | null;
  checkPair: number;
  pairCount: number;
  onCheckPair: (n: number) => void;
  checkBusy: boolean;
  checkBox: number;
}) {
  const { t } = useI18n();
  const [trStep, setTrStep] = useState(1);
  const [rotStep, setRotStep] = useState(0.5);
  const [lock, setLock] = useState<Record<string, boolean>>({});
  const locked = (id: string) => lock[id] !== false;
  const nameOf = (id: string) => rows.find((r) => r.id === id)?.name ?? id;
  const flips = rows.filter((r) => !r.isRef && (r.placement.flipX || r.placement.flipY || r.placement.flipZ));
  const anyPlaced = rows.some((r) => !r.isRef && !isIdentityPlacement(r.placement));

  return (
    <div style={box} data-testid="stitch-align">
      <div style={{ color: "#8a98a6" }}>{t("align.hint")}</div>
      <div style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap" }} title={t("align.tip.step")}>
        <span>
          {t("align.step")}:
          {TR_STEPS.map((s) => (
            <label key={s} style={{ marginLeft: 6 }}>
              <input type="radio" name="align-tr-step" checked={trStep === s} onChange={() => setTrStep(s)} data-testid={`align-tr-step-${s}`} /> {s} mm
            </label>
          ))}
        </span>
        <span>
          {ROT_STEPS.map((s) => (
            <label key={s} style={{ marginLeft: 6 }}>
              <input type="radio" name="align-rot-step" checked={rotStep === s} onChange={() => setRotStep(s)} data-testid={`align-rot-step-${s}`} /> {s}°
            </label>
          ))}
        </span>
        <button type="button" style={btn} disabled={!anyPlaced || autoBusy} onClick={() => rows.forEach((r) => onChange(r.id, { ...IDENTITY_PLACEMENT }))} title={t("align.tip.resetAll")} data-testid="align-reset-all">{t("align.resetAll")}</button>
      </div>

      {rows.map((r) => {
        const p = r.placement;
        const set = (patch: Partial<Placement>) => onChange(r.id, { ...p, ...patch });
        const setScale = (axis: 0 | 1 | 2, v: number) => {
          const f = v / 100;
          if (locked(r.id)) set({ sx: f, sy: f, sz: f });
          else set(axis === 0 ? { sx: f } : axis === 1 ? { sy: f } : { sz: f });
        };
        const sc = [p.sx, p.sy, p.sz];
        const tr = [p.tx, p.ty, p.tz];
        const ro = [p.rx, p.ry, p.rz];
        const fl = [p.flipX, p.flipY, p.flipZ];
        return (
          <div key={r.id} style={card} data-testid={`align-row-${r.id}`}>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <b>{r.name}</b>
              {r.isRef
                ? <span style={{ color: "#9fd0ff" }} title={t("align.tip.makeRef")} data-testid={`align-ref-${r.id}`}>{t("align.reference")}</span>
                : <button type="button" style={btn} disabled={autoBusy} onClick={() => onMakeReference(r.id)} title={t("align.tip.makeRef")} data-testid={`align-make-ref-${r.id}`}>{t("align.makeReference")}</button>}
              {r.angleDeg > 0.05 && <span style={{ color: "#e8c88a" }} title={t("align.tip.angle")} data-testid={`align-angle-${r.id}`}>{t("align.angle", { deg: r.angleDeg.toFixed(1) })}</span>}
            </div>
            {r.isRef ? (
              <div style={{ color: "#8a98a6" }}>{t("align.refNote")}</div>
            ) : (
              <div style={{ display: "grid", gridTemplateColumns: "92px repeat(3, auto)", gap: "4px 10px", alignItems: "center" }}>
                <span />
                {AXES.map((a) => <span key={a} style={{ color: "#8a98a6" }}>{t(`align.axis${a}`)}</span>)}
                <span title={t("align.tip.translate")}>{t("align.translate")}</span>
                {AXES.map((a, n) => (
                  <Stepper key={a} value={tr[n]} step={trStep} testid={`align-t${a.toLowerCase()}-${r.id}`} tip={t("align.tip.translate")}
                    onChange={(v) => set(n === 0 ? { tx: v } : n === 1 ? { ty: v } : { tz: v })} />
                ))}
                <span title={t("align.tip.rotate")}>{t("align.rotate")}</span>
                {AXES.map((a, n) => (
                  <Stepper key={a} value={ro[n]} step={rotStep} testid={`align-r${a.toLowerCase()}-${r.id}`} tip={t("align.tip.rotate")}
                    onChange={(v) => set(n === 0 ? { rx: v } : n === 1 ? { ry: v } : { rz: v })} />
                ))}
                <span title={t("align.tip.scale")}>{t("align.scale")}</span>
                {locked(r.id)
                  ? (
                    <span style={{ gridColumn: "2 / span 3", display: "inline-flex", alignItems: "center", gap: 10 }}>
                      <Stepper value={Math.round(sc[0] * 1e6) / 1e4} step={1} testid={`align-s-${r.id}`} tip={t("align.tip.scale")} onChange={(v) => setScale(0, v)} />
                      <label title={t("align.tip.lock")}><input type="checkbox" checked onChange={() => setLock((o) => ({ ...o, [r.id]: false }))} data-testid={`align-lock-${r.id}`} /> {t("align.scaleLock")}</label>
                    </span>
                  )
                  : (
                    <>
                      {AXES.map((a, n) => (
                        <Stepper key={a} value={Math.round(sc[n] * 1e6) / 1e4} step={1} testid={`align-s${a.toLowerCase()}-${r.id}`} tip={t("align.tip.scale")} onChange={(v) => setScale(n as 0 | 1 | 2, v)} />
                      ))}
                      <span />
                      <label style={{ gridColumn: "2 / span 3" }} title={t("align.tip.lock")}><input type="checkbox" checked={false} onChange={() => setLock((o) => ({ ...o, [r.id]: true }))} data-testid={`align-lock-${r.id}`} /> {t("align.scaleLock")}</label>
                    </>
                  )}
                <span title={t("align.tip.flip")}>{t("align.flip")}</span>
                {AXES.map((a, n) => (
                  <label key={a} title={t("align.tip.flip")}>
                    <input type="checkbox" checked={fl[n]} onChange={(e) => set(n === 0 ? { flipX: e.target.checked } : n === 1 ? { flipY: e.target.checked } : { flipZ: e.target.checked })} data-testid={`align-flip${a}-${r.id}`} /> {a}
                  </label>
                ))}
                <button type="button" style={btn} disabled={isIdentityPlacement(p) || autoBusy} onClick={() => onChange(r.id, { ...IDENTITY_PLACEMENT })} title={t("align.tip.resetRow")} data-testid={`align-reset-${r.id}`}>{t("align.reset")}</button>
              </div>
            )}
          </div>
        );
      })}

      {flips.map((r) => <div key={r.id} style={{ color: "#e8a0a0", fontWeight: 600 }} data-testid={`align-warn-flip-${r.id}`}>⚠ {t("align.warn.flip", { name: r.name })}</div>)}
      {rows.filter((r) => !r.isRef && Math.max(Math.abs(r.placement.sx - 1), Math.abs(r.placement.sy - 1), Math.abs(r.placement.sz - 1)) > 0.05).map((r) => (
        <div key={r.id} style={{ color: "#e8c88a" }} data-testid={`align-warn-scale-${r.id}`}>⚠ {t("align.warn.scale", { name: r.name, pct: String(Math.round(Math.max(r.placement.sx, r.placement.sy, r.placement.sz) * 1000) / 10) })}</div>
      ))}

      <label style={{ display: "flex", gap: 6, alignItems: "center" }} title={t("align.tip.oblique")}>
        <input type="checkbox" checked={oblique || obliqueNeeded} disabled={obliqueNeeded} onChange={(e) => onOblique(e.target.checked)} data-testid="align-oblique" /> {t("align.oblique")}
      </label>
      {(oblique || obliqueNeeded) && <div style={{ color: "#8a98a6" }}>{t("align.obliqueNote")}</div>}

      <div style={sep} />
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <b title={t("align.tip.autoScope")}>{t("align.auto.scope")}</b>
        <label title={t("align.tip.autoScope")}><input type="radio" name="align-auto-scope" checked={autoScope === "translation"} disabled={autoBusy} onChange={() => onAutoScope("translation")} data-testid="align-auto-translation" /> {t("align.auto.scope.translation")}</label>
        <label title={t("align.tip.autoScope")}><input type="radio" name="align-auto-scope" checked={autoScope === "rigid"} disabled={autoBusy} onChange={() => onAutoScope("rigid")} data-testid="align-auto-rigid" /> {t("align.auto.scope.rigid")}</label>
        <button type="button" style={btnPrimary} disabled={autoBusy || rows.length < 2} onClick={onAuto} title={t("align.tip.auto")} data-testid="align-auto-run">{t("align.auto.run")}</button>
        {autoBusy && <button type="button" style={btn} onClick={onStop} title={t("align.tip.stop")} data-testid="align-auto-stop">{t("align.auto.stop")}</button>}
        {autoBusy && <span style={{ color: "#9fd0ff" }} title={t("align.tip.auto")} data-testid="align-auto-progress">{autoProgress}</span>}
      </div>
      <div style={{ color: "#8a98a6" }} title={t("align.tip.auto")}>{t("align.auto.note")}</div>
      {autoLines.length > 0 && (
        <div title={t("align.tip.auto")} data-testid="align-auto-result">
          {autoLines.map((l) => (
            <div key={l.key} style={{ color: l.kind === "applied" ? "#a8e0b0" : "#e8c88a" }} data-kind={l.kind}>
              {t(`align.auto.${l.kind}`, {
                a: nameOf(l.a), b: nameOf(l.b),
                before: l.before !== undefined ? l.before.toFixed(3) : "", after: l.after !== undefined ? l.after.toFixed(3) : "", err: l.err ?? "",
              })}
            </div>
          ))}
        </div>
      )}

      {pairCount > 0 && (
        <>
          <div style={sep} />
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <b title={t("align.tip.check")}>{t("align.check")}</b>
            {pairCount > 1 && Array.from({ length: pairCount }, (_, n) => (
              <label key={n} title={t("align.tip.pair")}><input type="radio" name="align-check-pair" checked={checkPair === n} onChange={() => onCheckPair(n)} data-testid={`align-check-pair-${n}`} /> {n + 1}→{n + 2}</label>
            ))}
          </div>
          <div style={{ color: checkNcc ? "#c8d2dc" : "#8a98a6" }} title={t("align.tip.check")} data-testid="align-check-ncc" data-ncc={checkNcc ? checkNcc.ncc.toFixed(4) : ""}>
            {checkNcc ? t("align.check.ncc", { ncc: checkNcc.ncc.toFixed(3), n: String(checkNcc.count) }) : t("align.check.none")}
          </div>
          <div style={{ display: "flex", gap: 6, opacity: checkBusy ? 0.6 : 1 }} title={t("align.tip.check")} data-testid="align-check" data-busy={checkBusy}>
            {check
              ? (["cor", "sag"] as const).map((v) => <Overlay key={v} ov={check} view={v} box={checkBox} />)
              : null}
          </div>
        </>
      )}
    </div>
  );
}

/** 重なり部分の MIP を、a=マゼンタ・b=緑で重ねる（各画像を自分の最大値で 0〜255 に正規化）。 */
function Overlay({ ov, view, box }: { ov: PairOverlay; view: "cor" | "sag"; box: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [nx, ny, nz] = ov.a.dims;
  const w = view === "cor" ? nx : ny;
  const sx = view === "cor" ? ov.spacing[0] : ov.spacing[1];
  const sy = ov.spacing[2];
  useEffect(() => {
    const c = ref.current;
    const ctx = c?.getContext("2d");
    if (!c || !ctx) return;
    const A = ov.a[view], B = ov.b[view];
    const top = (arr: Float32Array) => {
      let lo = Infinity, hi = -Infinity;
      for (const v of arr) if (Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
      return Number.isFinite(lo) && hi > lo ? [lo, 255 / (hi - lo)] : [0, 0];
    };
    const [la, ka] = top(A), [lb, kb] = top(B);
    const img = ctx.createImageData(w, nz);
    for (let r = 0; r < nz; r++) {
      const src = nz - 1 - r;
      for (let i = 0; i < w; i++) {
        const a = A[src * w + i], b = B[src * w + i];
        const ga = Number.isFinite(a) ? Math.max(0, Math.min(255, (a - la) * ka)) : 0;
        const gb = Number.isFinite(b) ? Math.max(0, Math.min(255, (b - lb) * kb)) : 0;
        const o = (r * w + i) * 4;
        img.data[o] = ga; img.data[o + 1] = gb; img.data[o + 2] = ga; img.data[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  }, [ov, view, w, nz]);
  void ny;
  const wmm = w * sx, hmm = nz * sy;
  const k = box / Math.max(wmm, hmm, 1e-6);
  return (
    <div style={{ width: box, height: box, background: "#000", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <canvas ref={ref} width={w} height={nz} style={{ width: wmm * k, height: hmm * k, imageRendering: "pixelated" }} data-testid={`align-check-${view}`} data-px={`${w}x${nz}`} />
    </div>
  );
}

const box: React.CSSProperties = {
  fontSize: 12, display: "flex", flexDirection: "column", gap: 6, padding: 8, border: "1px solid #2c3742", borderRadius: 6, background: "#141b22",
};
const card: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 6, padding: 6, border: "1px solid #26303a", borderRadius: 4 };
const sep: React.CSSProperties = { height: 1, background: "#26303a" };
const num: React.CSSProperties = {
  background: "#0f151b", color: "#e8edf2", border: "1px solid #2c3742", borderRadius: 4, padding: "2px 4px", textAlign: "right",
};
const mini: React.CSSProperties = {
  background: "#26303a", color: "#e8edf2", border: "1px solid #2c3742", borderRadius: 4, width: 22, height: 22, cursor: "pointer", padding: 0,
};
const btn: React.CSSProperties = {
  background: "#26303a", color: "#e8edf2", border: "1px solid #2c3742", borderRadius: 4, padding: "3px 10px", cursor: "pointer",
};
const btnPrimary: React.CSSProperties = { ...btn, background: "#2b8aef", border: "1px solid #2b8aef", color: "#fff" };
