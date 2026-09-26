/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 3D Viewer 右パネルの SLAB（Slab MIP）設定。投影方式・厚み（全幅 mm）・深さ（視線方向の前後）。
 * 深さは Shift+ホイールでも動くので、view の状態変化を購読して表示を追従させる。
 * fw/slab-mip-design.md §A。
 */
import { useEffect, useState } from "react";
import { useI18n } from "../i18n/i18n";
import type { VtkVolumeView } from "../viewer/vtkVolumeView";
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

  // view の現在値で初期化し、Shift+ホイールによる depth 変化へ追従。
  useEffect(() => {
    if (!view) return;
    const sync = () => {
      const s = view.getSlab();
      setProjection(s.projection);
      setThickness(s.thicknessMm);
      setDepth(s.depthMm);
      setMaxDepth(s.maxDepthMm);
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
    view?.setSlab({ depthMm: mm });
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
        <button style={{ ...styles.btn, flex: "0 0 auto" }} onClick={() => onDepth(0)} data-testid="viewer3d-slab-center">
          {t("viewer3d.slab.center")}
        </button>
      </div>
      <div style={{ fontSize: 11, color: "#7f8b96" }}>{t("viewer3d.slab.hint")}</div>
    </div>
  );
}
