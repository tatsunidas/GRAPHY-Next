// @vitest-environment jsdom
/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// 「描き方」の DOM の煙テスト: 既定のまま開く → 物体を選ぶ → 線 → 面、2 物体で片方だけが変わる。
import vtkSphereSource from "@kitware/vtk.js/Filters/Sources/SphereSource";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { I18nProvider } from "../i18n/i18n";
import { SceneObjectPanel } from "./SceneObjectPanel";
import { addMeshObject, readSceneActorStates } from "./scene3d";
import { clearSceneObjects, getSceneObject } from "./scene3dStore";
import { clearUndo } from "./undoStore";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;
const q = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const sphere = (r: number) => vtkSphereSource.newInstance({ radius: r }).getOutputData();
const actorRep = (id: string) => readSceneActorStates().find((s) => s.id === id)!.actorRepresentation;

async function mount() {
  await act(async () => {
    root.render(createElement(I18nProvider, null, createElement(SceneObjectPanel, { geom: null })));
  });
}
const click = async (el: HTMLElement) => {
  await act(async () => {
    el.click();
  });
};

beforeEach(() => {
  localStorage.setItem("graphy.locale", "ja");
  clearSceneObjects();
  clearUndo();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  clearSceneObjects();
  clearUndo();
});

describe("SceneObjectPanel の描き方（煙テスト）", () => {
  it("物体を選ぶまでは出ない。既定のまま選ぶと［面］が押され、［線］→［面］で store とアクターが変わる", async () => {
    const a = addMeshObject(sphere(10))!;
    await mount();
    expect(q("scene3d-repr-wireframe")).toBeNull();
    await click(q(`scene3d-row-${a}`)!);
    const surface = q("scene3d-repr-surface")!;
    const wire = q("scene3d-repr-wireframe")!;
    expect(q("scene3d-repr-points")).not.toBeNull();
    expect(surface.textContent).toBe("面");
    expect(actorRep(a)).toBe(2);
    const activeBg = surface.style.background;
    expect(wire.style.background).not.toBe(activeBg); // 既定は［面］が押された見た目
    await click(wire);
    expect(getSceneObject(a)!.representation).toBe("wireframe");
    expect(actorRep(a)).toBe(1);
    expect(q("scene3d-repr-wireframe")!.style.background).toBe(activeBg);
    expect(q("scene3d-repr-surface")!.style.background).not.toBe(activeBg);
    await click(q("scene3d-repr-surface")!);
    expect(actorRep(a)).toBe(2);
  });

  it("2 物体: 1 つ目を線にしても 2 つ目は面のまま。2 つ目を選ぶと［面］が押された状態", async () => {
    const a = addMeshObject(sphere(10))!;
    const b = addMeshObject(sphere(5))!;
    await mount();
    await click(q(`scene3d-row-${a}`)!);
    await click(q("scene3d-repr-wireframe")!);
    await click(q(`scene3d-row-${b}`)!); // 選択が b に移る
    expect(actorRep(a)).toBe(1);
    expect(actorRep(b)).toBe(2);
    expect(q("scene3d-repr-surface")!.style.background).not.toBe(q("scene3d-repr-wireframe")!.style.background);
    expect(getSceneObject(b)!.representation).toBe("surface");
  });
});
