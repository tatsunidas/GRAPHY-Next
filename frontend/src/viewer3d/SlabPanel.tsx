/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 3D Viewer 右パネルの SLAB（Slab MIP）設定。投影方式・厚み（全幅 mm）・深さ・回転中心・自動回転シネ。
 * スラブ中心 ≡ 回転中心。深さ・回転中心は Shift+ホイール／ダブルクリック／Pan でも動くので、
 * view の状態変化を購読して表示を追従させる。fw/slab-mip-design.md §A。
 */
import { useEffect, useState } from "react";
import { useI18n } from "../i18n/i18n";
import type { VtkVolumeView } from "../viewer/vtkVolumeView";
import type { SpinOptions } from "../viewer/slabGeometry";
import {
  SLAB_PROJECTIONS,
  SLAB_THICKNESS_PRESETS_MM,
  clampSlabThickness,
  defaultSlabThickness,
  type SlabProjection,
} from "../viewer/slabPresets";

export function SlabPanel({
  view,
  styles,
}: {
  view: VtkVolumeView | null;
  styles: {
    section: React.CSSProperties;
    label: React.CSSProperties;
    row: React.CSSProperties;
    btn: React.CSSProperties;
    btnActive: React.CSSProperties;
    select: React.CSSProperties;
  };
}) {
  const { t } = useI18n();
  const [projection, setProjection] = useState<SlabProjection>("MIP");
  const [thickness, setThickness] = useState<number>(defaultSlabThickness("MIP"));
  const [depth, setDepth] = useState(0);
  const [maxDepth, setMaxDepth] = useState(0);
  const [center, setCenter] = useState<[number, number, number]>([0, 0, 0]);
  const [spinning, setSpinning] = useState(false);
  const [spinAxis, setSpinAxis] = useState<SpinOptions["axis"]>("horizontal");
  const [spinRange, setSpinRange] = useState<string>("360");
  const [spinSpeed, setSpinSpeed] = useState<number>(30);

  // view の現在値で初期化し、Shift+ホイールによる depth 変化へ追従。
  useEffect(() => {
    if (!view) return;
    const sync = () => {
      const s = view.getSlab();
      setProjection(s.projection);
      setThickness(s.thicknessMm);
      setDepth(s.depthMm);
      setMaxDepth(s.maxDepthMm);
      setCenter(s.center);
      setSpinning(view.isSpinning());
    };
    sync();
    return view.onStateChanged(sync);
  }, [view]);

  const onProjection = (p: SlabProjection) => {
    // 既定厚のままなら投影方式の既定へ寄せる（MinIP=3mm）。利用者が変えた厚みは保つ。
    const keep = thickness !== defaultSlabThickness(projection);
    const nextTh = keep ? thickness : defaultSlabThickness(p);
    setProjection(p);
    setThickness(nextTh);
    view?.setSlab({ projection: p, thicknessMm: nextTh });
  };
  const onThickness = (mm: number) => {
    const v = clampSlabThickness(mm);
    setThickness(v);
    view?.setSlab({ thicknessMm: v });
  };
  const onDepth = (mm: number) => {
    setDepth(mm);
    view?.setSlabDepth(mm);
  };
  const spinOpts = (over: Partial<{ axis: SpinOptions["axis"]; range: string; speed: number }> = {}): SpinOptions => {
    const range = over.range ?? spinRange;
    return {
      axis: over.axis ?? spinAxis,
      degPerSec: over.speed ?? spinSpeed,
      rangeDeg: range === "360" ? null : Number(range),
    };
  };
  const toggleSpin = () => {
    if (!view) return;
    if (view.isSpinning()) view.stopSpin();
    else view.startSpin(spinOpts());
  };
  // 回転中に設定を変えたら、その設定で回し直す。
  const onSpinSetting = (over: Partial<{ axis: SpinOptions["axis"]; range: string; speed: number }>) => {
    if (over.axis) setSpinAxis(over.axis);
    if (over.range) setSpinRange(over.range);
    if (over.speed) setSpinSpeed(over.speed);
    if (view?.isSpinning()) view.startSpin(spinOpts(over));
  };

  const isPreset = (SLAB_THICKNESS_PRESETS_MM as readonly number[]).includes(thickness);

  return (
    <div style={styles.section} data-testid="viewer3d-slab-panel">
      <div style={styles.label}>{t("viewer3d.slab.projection")}</div>
      <div style={styles.row}>
        {SLAB_PROJECTIONS.map((p) => (
          <button
            key={p}
            style={projection === p ? styles.btnActive : styles.btn}
            onClick={() => onProjection(p)}
            data-testid={`viewer3d-slab-${p.toLowerCase()}`}
          >
            {t(`series.thickSlab.proj.${p.toLowerCase()}`)}
          </button>
        ))}
      </div>
      <div style={styles.label}>{t("viewer3d.slab.thickness")}</div>
      <div style={styles.row}>
        <select
          style={{ ...styles.select, flex: 1 }}
          value={isPreset ? String(thickness) : "custom"}
          onChange={(e) => {
            if (e.target.value !== "custom") onThickness(Number(e.target.value));
          }}
          data-testid="viewer3d-slab-thickness"
        >
          {SLAB_THICKNESS_PRESETS_MM.map((mm) => (
            <option key={mm} value={mm}>
              {mm} mm
            </option>
          ))}
          {!isPreset && <option value="custom">{t("viewer3d.slab.custom")}</option>}
        </select>
        <input
          type="number"
          min={0.5}
          max={200}
          step={0.5}
          value={thickness}
          onChange={(e) => onThickness(Number(e.target.value))}
          style={{ ...styles.select, width: 64 }}
          aria-label={t("viewer3d.slab.thickness")}
          data-testid="viewer3d-slab-thickness-input"
        />
      </div>
      <div style={styles.label}>
        {t("viewer3d.slab.depth")} {depth >= 0 ? "+" : ""}
        {depth.toFixed(1)} mm
      </div>
      <div style={styles.row}>
        <input
          type="range"
          min={-maxDepth}
          max={maxDepth}
          step={0.5}
          value={depth}
          onChange={(e) => onDepth(Number(e.target.value))}
          style={{ flex: 1, minWidth: 0 }}
          data-testid="viewer3d-slab-depth"
        />
      </div>
      <div style={styles.label}>{t("viewer3d.slab.rotCenter")}</div>
      <div style={{ ...styles.row, justifyContent: "space-between" }}>
        <span
          style={{ font: "12px ui-monospace, monospace", color: "#c7d0d8", fontVariantNumeric: "tabular-nums" }}
          data-testid="viewer3d-slab-rotcenter"
        >
          {center.map((v) => v.toFixed(1)).join(", ")}
        </span>
        <button
          style={{ ...styles.btn, flex: "0 0 auto" }}
          onClick={() => view?.centerRotation()}
          data-testid="viewer3d-slab-center"
        >
          {t("viewer3d.slab.toVolumeCenter")}
        </button>
      </div>
      <div style={styles.label}>{t("viewer3d.slab.spin")}</div>
      <div style={styles.row}>
        <button
          style={{ ...(spinning ? styles.btnActive : styles.btn), flex: "0 0 auto", minWidth: 36 }}
          onClick={toggleSpin}
          aria-label={spinning ? t("viewer3d.slab.spinStop") : t("viewer3d.slab.spinStart")}
          title={spinning ? t("viewer3d.slab.spinStop") : t("viewer3d.slab.spinStart")}
          data-testid="viewer3d-slab-spin"
        >
          {spinning ? "■" : "▶"}
        </button>
        <select
          style={{ ...styles.select, flex: 1, minWidth: 0 }}
          value={spinAxis}
          onChange={(e) => onSpinSetting({ axis: e.target.value as SpinOptions["axis"] })}
          data-testid="viewer3d-slab-spin-axis"
        >
          <option value="horizontal">{t("viewer3d.slab.spinAxis.horizontal")}</option>
          <option value="vertical">{t("viewer3d.slab.spinAxis.vertical")}</option>
        </select>
      </div>
      <div style={styles.row}>
        <select
          style={{ ...styles.select, flex: 1, minWidth: 0 }}
          value={spinRange}
          onChange={(e) => onSpinSetting({ range: e.target.value })}
          data-testid="viewer3d-slab-spin-range"
        >
          <option value="360">{t("viewer3d.slab.spinRange.full")}</option>
          <option value="30">±30°</option>
          <option value="60">±60°</option>
        </select>
        <select
          style={{ ...styles.select, flex: 1, minWidth: 0 }}
          value={spinSpeed}
          onChange={(e) => onSpinSetting({ speed: Number(e.target.value) })}
          data-testid="viewer3d-slab-spin-speed"
        >
          {[15, 30, 60].map((v) => (
            <option key={v} value={v}>
              {v}°/s
            </option>
          ))}
        </select>
      </div>
      <div style={{ fontSize: 11, color: "#7f8b96" }}>{t("viewer3d.slab.hint")}</div>
    </div>
  );
}
