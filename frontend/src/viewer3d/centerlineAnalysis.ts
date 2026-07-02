/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 中心線グラフの 3D オーバーレイ（`fw/3d-viewer-design.md` §15-#4）。旧 GRAPHY `CenterlineGraphRenderer` に対応。
 *
 * 抽出した {@link CenterlineGraph}（全ブランチ＋ノード）を pure vtk.js の renderer に重畳表示する。
 * - ブランチ = 細いチューブ（暗いシアン）。
 * - ノード = 球グリフ（端点=緑 / 分岐=橙）。
 * - ハイライト = 選択ブランチ or 最短路の点列を明るいチューブ（黄）で重ねる。
 * 全て患者 LPS mm。中心線解析ダイアログ（`CenterlineDialog`）のライフサイクルで生成/破棄する。
 */
import vtkPolyData from "@kitware/vtk.js/Common/DataModel/PolyData";
import vtkTubeFilter from "@kitware/vtk.js/Filters/General/TubeFilter";
import vtkSphereSource from "@kitware/vtk.js/Filters/Sources/SphereSource";
import vtkMapper from "@kitware/vtk.js/Rendering/Core/Mapper";
import vtkActor from "@kitware/vtk.js/Rendering/Core/Actor";
import type { CenterlineGraph } from "../viewer/centerlineGraph";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
type V3 = [number, number, number];

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

/** 点列 → チューブ polydata。2 点未満なら null。 */
function buildTube(points: V3[], radius: number, sides = 8): Any | null {
  if (points.length < 2) return null;
  const flat = new Float32Array(points.length * 3);
  for (let i = 0; i < points.length; i++) {
    flat[i * 3] = points[i][0];
    flat[i * 3 + 1] = points[i][1];
    flat[i * 3 + 2] = points[i][2];
  }
  const lines = new Uint32Array(points.length + 1);
  lines[0] = points.length;
  for (let i = 0; i < points.length; i++) lines[i + 1] = i;
  const pd: Any = vtkPolyData.newInstance();
  pd.getPoints().setData(flat, 3);
  pd.getLines().setData(lines);
  const tube: Any = vtkTubeFilter.newInstance();
  tube.setInputData(pd);
  tube.setRadius(radius);
  tube.setNumberOfSides(sides);
  tube.setCapping(true);
  const out = tube.getOutputData();
  return out && out.getNumberOfPoints?.() > 0 ? out : pd;
}

function makeActor(pd: Any, color: V3, opacity = 1): Any {
  const mapper = vtkMapper.newInstance();
  mapper.setInputData(pd);
  mapper.setScalarVisibility(false);
  const actor = vtkActor.newInstance();
  actor.setMapper(mapper);
  const prop = actor.getProperty();
  prop.setColor(color[0], color[1], color[2]);
  prop.setOpacity(opacity);
  return actor;
}

export interface GraphOverlay {
  /** 選択ブランチ/最短路の点列を明るく重ねる（null で解除）。 */
  setHighlight(points: V3[] | null): void;
  destroy(): void;
}

export function createGraphOverlay(
  deps: { renderer: Any; render: () => void },
  graph: CenterlineGraph,
): GraphOverlay {
  const { renderer, render } = deps;
  const total = graph.totalLengthMm();
  const tubeR = clamp(total / 500, 0.25, 1.2);
  const nodeR = tubeR * 2.2;

  const actors: Any[] = [];
  const addActor = (a: Any | null) => {
    if (!a) return;
    actors.push(a);
    try {
      renderer.addActor(a);
    } catch {
      /* ignore */
    }
  };

  // ブランチ（暗いシアン）。
  for (const b of graph.branches.values()) {
    addActor(makeActor(buildTube(b.points as V3[], tubeR), [0.2, 0.55, 0.7], 0.9));
  }
  // ノード（端点=緑 / 分岐=橙 / その他=灰）。
  for (const n of graph.nodes.values()) {
    const deg = n.branchIds.length;
    const color: V3 = deg === 1 ? [0.3, 0.9, 0.4] : deg >= 3 ? [1, 0.55, 0.2] : [0.6, 0.6, 0.65];
    const sph: Any = vtkSphereSource.newInstance();
    sph.setCenter(n.pos[0], n.pos[1], n.pos[2]);
    sph.setRadius(nodeR);
    sph.setThetaResolution(12);
    sph.setPhiResolution(12);
    addActor(makeActor(sph.getOutputData(), color, 1));
  }

  let highlightActor: Any = null;
  const clearHighlight = () => {
    if (!highlightActor) return;
    try {
      renderer.removeActor(highlightActor);
      highlightActor.delete?.();
    } catch {
      /* ignore */
    }
    highlightActor = null;
  };

  render();

  return {
    setHighlight(points) {
      clearHighlight();
      if (points && points.length >= 2) {
        const pd = buildTube(points, tubeR * 1.8, 10);
        if (pd) {
          highlightActor = makeActor(pd, [1, 0.85, 0.2], 1);
          try {
            renderer.addActor(highlightActor);
          } catch {
            /* ignore */
          }
        }
      }
      render();
    },
    destroy() {
      clearHighlight();
      for (const a of actors) {
        try {
          renderer.removeActor(a);
          a.delete?.();
        } catch {
          /* ignore */
        }
      }
      actors.length = 0;
      render();
    },
  };
}
