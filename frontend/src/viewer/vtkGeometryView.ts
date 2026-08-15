/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * **ボリュームを持たない** 3D シーン用の最小のレンダーウィンドウ。
 *
 * <h3>なぜ要るのか</h3>
 * 既存の 3D ビューア（`viewer3d/Viewer3DScreen.tsx`）は**ボリューム起点**で、
 * {@link ../viewer/vtkVolumeView.createVtkVolumeView} が `vtkImageData` を受け取って初めて
 * レンダーウィンドウを作る。ところが **XA（アンギオ）にボリュームは存在しない** ——
 * 3D QCA が作るのは中心線という幾何だけ。そのままでは既存の 3D ビューアに載せられない。
 *
 * <p>そこで「幾何だけを描くための器」をここに切り出す。**既存のボリューム経路には一切触らない**
 * （あちらは検証済みの機能が多く、初期化を作り替える価値がない）。
 * シーンへの物体の登録は `viewer3d/scene3d.ts` を**そのまま共有する**ので、
 * メッシュ・ROI・計測といった既存の仕組みは後から同じ器の上に載せられる。
 *
 * <p>持たないもの: ボリューム、クロップ、W/L、プリセット、ORTHO。**無いものを操作させない**ため、
 * 画面側もそれらの UI を出さない。
 */
import vtkGenericRenderWindow from "@kitware/vtk.js/Rendering/Misc/GenericRenderWindow";
import vtkInteractorStyleTrackballCamera from "@kitware/vtk.js/Interaction/Style/InteractorStyleTrackballCamera";
import { WebGLContextUnavailableError, isWebGLContextUnavailable } from "./vtkVolumeView";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

export interface VtkGeometryView {
  /** `scene3d.attachSceneRenderer` へ渡す部品。 */
  getSceneParts(): { renderer: Any; render: () => void };
  /** 中身が入れ替わったあとに呼ぶ（全体が入るようカメラを引き直す）。 */
  resetCamera(): void;
  /**
   * いま描かれている画素の統計。**「本当に何か描かれているか」を機械で確かめるため**にある。
   *
   * <p>🚨 DOM だけを見る検査は**黒い画面を通す**。実際、canvas の存在・WebGL コンテキスト・
   * シーンの物体数・表示中の数値がすべて合格したまま、**3D は真っ黒**だったことがある
   * （カメラの退化。上記 `resetCamera` の注意書き）。
   */
  readPixelStats(): { total: number; nonBackground: number; fraction: number } | null;
  resize(): void;
  destroy(): void;
}

/**
 * 幾何だけのビューを作る。
 *
 * @throws WebGLContextUnavailableError WebGL コンテキストを取れないとき
 *   （生の vtk.js のエラーは利用者に対処のしようが無いので、判別できる型にして投げ直す）
 */
export function createVtkGeometryView(container: HTMLDivElement): VtkGeometryView {
  const grw = vtkGenericRenderWindow.newInstance({ background: [0.06, 0.09, 0.11] });
  try {
    grw.setContainer(container);
  } catch (e) {
    try {
      grw.delete();
    } catch {
      /* ignore */
    }
    if (isWebGLContextUnavailable(e)) throw new WebGLContextUnavailableError(e);
    throw e;
  }
  const renderer = grw.getRenderer();
  const renderWindow = grw.getRenderWindow();
  const interactor = renderWindow.getInteractor();
  interactor.setInteractorStyle(vtkInteractorStyleTrackballCamera.newInstance());

  let destroyed = false;
  const render = (): void => {
    if (destroyed) return;
    try {
      renderWindow.render();
    } catch {
      /* コンテキスト消失後の描画要求は無視する */
    }
  };

  return {
    getSceneParts() {
      return { renderer, render };
    },
    resetCamera() {
      if (destroyed) return;
      try {
        // 🚨 **視線と view-up を平行にしない。** `resetCamera()` の既定カメラは +Z から見ており、
        //    そこへ view-up = Z（頭側）を与えると**両者が平行になって view 行列が退化し、
        //    何も描かれない**（黒い画面になる。実機のスクリーンショットで発覚した）。
        //    先に向きを決めてから `resetCamera()` で収める（あちらは向きを保つ）。
        const cam = renderer.getActiveCamera();
        cam.setFocalPoint(0, 0, 0);
        // 患者 LPS で前方（anterior）は −Y。正面像と同じ向きから見る。
        cam.setPosition(0, -1, 0);
        // 頭側（+Z）を上に。
        cam.setViewUp(0, 0, 1);
        renderer.resetCamera();
        renderer.resetCameraClippingRange();
        render();
      } catch {
        /* ignore */
      }
    },
    readPixelStats() {
      if (destroyed) return null;
      try {
        // 直前に描き直してから読む（合成後はバッファが失われるため、同じ実行単位で読む）。
        render();
        const canvas = container.querySelector("canvas") as HTMLCanvasElement | null;
        const gl = (canvas?.getContext("webgl2") ?? canvas?.getContext("webgl")) as WebGLRenderingContext | null;
        if (!canvas || !gl) return null;
        const w = canvas.width;
        const h = canvas.height;
        if (!(w > 0 && h > 0)) return null;
        const buf = new Uint8Array(w * h * 4);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
        // 背景は暗い単色。そこから十分離れた画素を「描かれている」と数える。
        let nonBackground = 0;
        for (let i = 0; i < buf.length; i += 4) {
          if (buf[i] > 60 || buf[i + 1] > 60 || buf[i + 2] > 60) nonBackground++;
        }
        const total = w * h;
        return { total, nonBackground, fraction: nonBackground / total };
      } catch {
        return null;
      }
    },
    resize() {
      if (destroyed) return;
      try {
        grw.resize();
        render();
      } catch {
        /* ignore */
      }
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      // ⚠️ 順番が要る: interactor のイベント解除 → GL 資源の解放 → インスタンス破棄。
      //    先に delete すると、まだ生きている DOM イベントが破棄済みオブジェクトを触る。
      try {
        interactor.unbindEvents?.();
      } catch {
        /* ignore */
      }
      try {
        const openGLRw: Any = (grw as Any).getApiSpecificRenderWindow?.();
        openGLRw?.delete?.();
      } catch {
        /* ignore */
      }
      try {
        grw.delete();
      } catch {
        /* ignore */
      }
    },
  };
}
