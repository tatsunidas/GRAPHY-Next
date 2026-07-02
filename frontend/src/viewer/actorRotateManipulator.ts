/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * カスタム「Trackball Actor（カメラ固定回転）」マニピュレータ。
 *
 * vtk.js には `InteractorStyleTrackballActor` もアクター回転マニピュレータも無いため、標準の
 * `MouseCameraTrackballRotateManipulator` を雛形に、**カメラを固定したまま renderer 内の全 Prop3D
 * （ボリューム・Ortho スライス・mesh/ROI）をボリューム中心まわりに回転**するマニピュレータを実装する。
 * これによりライトが世界固定のまま被写体が回る、彫刻的（cinematic 向き）な回転になる。
 */
import macro from "@kitware/vtk.js/macros";
import vtkCompositeMouseManipulator from "@kitware/vtk.js/Interaction/Manipulators/CompositeMouseManipulator";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

function cross(a: number[], b: number[]): number[] {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function normalize(v: number[]): number[] {
  const n = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / n, v[1] / n, v[2] / n];
}

function vtkActorRotateManipulator(publicAPI: Any, model: Any): void {
  model.classHierarchy.push("vtkActorRotateManipulator");

  publicAPI.onButtonDown = (_interactor: Any, _renderer: Any, position: Any) => {
    model.previousPosition = position;
  };

  publicAPI.onMouseMove = (interactor: Any, renderer: Any, position: Any) => {
    if (!position || !model.previousPosition) return;
    const camera = renderer.getActiveCamera();
    const dx = position.x - model.previousPosition.x;
    const dy = position.y - model.previousPosition.y;
    const size = interactor.getView().getViewportSize(renderer);
    const rf = model.rotationFactor ?? 1;
    const azimuth = ((360.0 * dx) / size[0]) * rf; // deg（左右ドラッグ）
    const elevation = ((360.0 * dy) / size[1]) * rf; // deg（上下ドラッグ）

    const up = camera.getViewUp();
    const dir = camera.getDirectionOfProjection();
    const right = normalize(cross(dir, up));
    const c = model.center as number[];

    const props: Any[] = [...renderer.getActors(), ...renderer.getVolumes()];
    props.forEach((p) => {
      if (!p.rotateWXYZ || !p.getVisibility?.()) return;
      // ボリューム中心を回転中心にして、世界の up/right 軸まわりに回す（カメラは固定）。
      p.setOrigin(c[0], c[1], c[2]);
      p.rotateWXYZ(azimuth, up[0], up[1], up[2]);
      p.rotateWXYZ(-elevation, right[0], right[1], right[2]);
    });

    renderer.resetCameraClippingRange();
    interactor.render();
    model.previousPosition = position;
  };
}

const DEFAULT_VALUES = {
  center: [0, 0, 0],
  rotationFactor: 1,
};

function extend(publicAPI: Any, model: Any, initialValues: Any = {}): void {
  Object.assign(model, DEFAULT_VALUES, initialValues);
  macro.obj(publicAPI, model);
  vtkCompositeMouseManipulator.extend(publicAPI, model, initialValues);
  macro.setGetArray(publicAPI, model, ["center"], 3);
  macro.setGet(publicAPI, model, ["rotationFactor"]);
  vtkActorRotateManipulator(publicAPI, model);
}

export const newInstance = macro.newInstance(extend, "vtkActorRotateManipulator");

export default { newInstance, extend };
