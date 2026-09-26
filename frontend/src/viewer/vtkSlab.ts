/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 3D Viewer の SLAB モード（Slab MIP / MinIP / AvgIP・pure VTK.js）。fw/slab-mip-design.md §A。
 *
 * `vtkImageResliceMapper` のスラブ機能（GPU シェーダで面法線 ±厚/2 を最小ボクセル間隔の半分刻みで
 * サンプルし MAX/MIN/MEAN）を使い、スラブ面を<b>カメラに固定</b>する（{@link slabPlaneFromCamera}）。
 * 回転すれば任意斜めスラブになり、Ziosoft 記事の「関心点を中心に置き、回転して多方向から見る」
 * 操作をそのまま行える。幾何は `vtkImageDataFromVolume` の患者 LPS をそのまま使う（単一幾何）。
 *
 * `vtkOrthoSlices` と同じく独立モジュールに隔離し、`vtkVolumeView` からは表示切替と
 * パラメータ設定だけを呼ぶ。色は volume と同じ色 TF（W/L・LUT 反映済み）を共有する。
 */
import "@kitware/vtk.js/Rendering/OpenGL/ImageResliceMapper";
import vtkImageSlice from "@kitware/vtk.js/Rendering/Core/ImageSlice";
import vtkImageResliceMapper from "@kitware/vtk.js/Rendering/Core/ImageResliceMapper";
import { SlabTypes } from "@kitware/vtk.js/Rendering/Core/ImageResliceMapper/Constants";
import vtkPlane from "@kitware/vtk.js/Common/DataModel/Plane";
import type { SlabProjection } from "./slabPresets";
import { clampSlabDepth, maxSlabDepthMm, slabPlaneFromCamera } from "./slabGeometry";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

export interface SlabView {
  setVisible(on: boolean): void;
  setThickness(mm: number): void;
  setProjection(p: SlabProjection): void;
  /** 焦点からの視線方向オフセット(mm)。±{@link getMaxDepth} に丸める。 */
  setDepth(mm: number): void;
  getDepth(): number;
  getMaxDepth(): number;
  destroy(): void;
}

export function slabTypeFor(p: SlabProjection): number {
  return p === "MIP" ? SlabTypes.MAX : p === "MINIP" ? SlabTypes.MIN : SlabTypes.MEAN;
}

/** renderer + imageData にスラブ用の ImageSlice を用意する（初期は非表示）。 */
export function createSlabView(
  renderer: Any,
  imageData: Any,
  ctf: Any,
  render: () => void,
  opts: { thicknessMm: number; projection: SlabProjection },
): SlabView {
  const plane: Any = vtkPlane.newInstance();
  const mapper: Any = vtkImageResliceMapper.newInstance();
  mapper.setInputData(imageData);
  mapper.setSlicePlane(plane);
  mapper.setSlabThickness(opts.thicknessMm);
  mapper.setSlabType(slabTypeFor(opts.projection));

  const actor: Any = vtkImageSlice.newInstance();
  actor.setMapper(mapper);
  const prop = actor.getProperty();
  // volume と同じ色 TF（W/L・LUT を焼き込み済み）を共有し、TF の値域で写像する。
  prop.setRGBTransferFunction(0, ctf);
  prop.setUseLookupTableScalarRange(true);
  prop.setInterpolationTypeToLinear();
  actor.setVisibility(false);
  renderer.addActor(actor);

  const maxDepth = maxSlabDepthMm((imageData.getBounds?.() as number[]) ?? []);
  let depth = 0;
  let visible = false;

  const updatePlane = () => {
    const cam = renderer.getActiveCamera();
    const { origin, normal } = slabPlaneFromCamera(cam.getFocalPoint(), cam.getDirectionOfProjection(), depth);
    plane.setOrigin(origin);
    plane.setNormal(normal);
  };

  // カメラ変化（回転・Pan）に面を追従。非表示中は計算しない。
  let camSub: { unsubscribe?: () => void } | null = null;
  try {
    camSub = renderer.getActiveCamera().onModified(() => {
      if (visible) updatePlane();
    });
  } catch {
    camSub = null;
  }

  return {
    setVisible(on) {
      visible = on;
      if (on) updatePlane();
      actor.setVisibility(on);
      render();
    },
    setThickness(mm) {
      mapper.setSlabThickness(Math.max(0, mm));
      render();
    },
    setProjection(p) {
      mapper.setSlabType(slabTypeFor(p));
      render();
    },
    setDepth(mm) {
      depth = clampSlabDepth(mm, maxDepth);
      if (visible) updatePlane();
      render();
    },
    getDepth: () => depth,
    getMaxDepth: () => maxDepth,
    destroy() {
      try {
        camSub?.unsubscribe?.();
      } catch {
        /* ignore */
      }
      try {
        renderer.removeActor(actor);
        actor.delete?.();
        mapper.delete?.();
      } catch {
        /* ignore */
      }
    },
  };
}
