/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * Ortho モード用の 3 直交スライス（pure VTK.js）。旧 GRAPHY の Ortho（3 面を 3D シーンに表示）に相当。
 *
 * 並行 P3 作業とのコンフリクトを避けるため、Ortho の中核をこの独立モジュールに隔離する。`vtkVolumeView` の
 * `getSceneParts()`（renderer / imageData / render）を受け取り、I/J/K の `vtkImageSlice` アクターを renderer に
 * 追加して位置・W/L を制御する。Trackball で 3 面を 3D 回転できる（cornerstone を介さず実空間で整合）。
 */
import vtkImageSlice from "@kitware/vtk.js/Rendering/Core/ImageSlice";
import vtkImageMapper from "@kitware/vtk.js/Rendering/Core/ImageMapper";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

export interface OrthoSlices {
  /** 3 スライスの表示/非表示。 */
  setVisible(on: boolean): void;
  /** 各軸のスライス位置（0..1 の割合）。 */
  setPositions(fx: number, fy: number, fz: number): void;
  /** グレースケール W/L（colorWindow/colorLevel）。 */
  setWindowLevel(center: number, width: number): void;
  destroy(): void;
}

const clampIdx = (v: number, n: number): number => Math.max(0, Math.min(n - 1, Math.round(v)));

/** renderer + imageData に 3 直交スライスアクターを用意する（初期は非表示）。 */
export function createOrthoSlices(
  renderer: Any,
  imageData: Any,
  render: () => void,
  opts: { center: number; width: number },
): OrthoSlices {
  const dims = imageData.getDimensions() as number[];
  const mappers: Any[] = [];
  const actors: Any[] = [];

  (["I", "J", "K"] as const).forEach((axis, idx) => {
    const m = vtkImageMapper.newInstance();
    m.setInputData(imageData);
    const mid = Math.max(0, Math.floor((dims[idx] - 1) / 2));
    if (axis === "I") m.setISlice(mid);
    else if (axis === "J") m.setJSlice(mid);
    else m.setKSlice(mid);
    const a = vtkImageSlice.newInstance();
    a.setMapper(m);
    a.getProperty().setColorWindow(opts.width);
    a.getProperty().setColorLevel(opts.center);
    a.setVisibility(false);
    renderer.addActor(a);
    mappers.push(m);
    actors.push(a);
  });

  return {
    setVisible(on) {
      actors.forEach((a) => a.setVisibility(on));
      render();
    },
    setPositions(fx, fy, fz) {
      const d = imageData.getDimensions() as number[];
      mappers[0].setISlice(clampIdx(fx * (d[0] - 1), d[0]));
      mappers[1].setJSlice(clampIdx(fy * (d[1] - 1), d[1]));
      mappers[2].setKSlice(clampIdx(fz * (d[2] - 1), d[2]));
      render();
    },
    setWindowLevel(center, width) {
      actors.forEach((a) => {
        a.getProperty().setColorWindow(width);
        a.getProperty().setColorLevel(center);
      });
      render();
    },
    destroy() {
      actors.forEach((a) => {
        try {
          renderer.removeActor(a);
        } catch {
          /* ignore */
        }
      });
    },
  };
}
