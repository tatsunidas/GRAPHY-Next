/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// シーンの物体ごとの描き方: 選んだ物体だけが変わり、undo/redo で戻り、観測の口がアクターから読む。
import vtkSphereSource from "@kitware/vtk.js/Filters/Sources/SphereSource";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addMeshObject, readSceneActorStates, removeObject, setObjectOpacity, setObjectRepresentation } from "./scene3d";
import { clearSceneObjects, getSceneObject } from "./scene3dStore";
import { clearUndo, redo, undo } from "./undoStore";

const sphere = (r: number) => vtkSphereSource.newInstance({ radius: r }).getOutputData();
const actorRep = (id: string) => readSceneActorStates().find((s) => s.id === id)!.actorRepresentation;

beforeEach(() => {
  clearSceneObjects();
  clearUndo();
});
afterEach(() => {
  clearSceneObjects();
  clearUndo();
});

describe("setObjectRepresentation", () => {
  it("既定は面。線にするとアクターが 1 になり、選んでいない物体は 2 のまま・色も不透明度も不変", () => {
    const a = addMeshObject(sphere(10), { color: [1, 0, 0], opacity: 0.8 })!;
    const b = addMeshObject(sphere(5), { color: [0, 1, 0], opacity: 0.4 })!;
    expect(getSceneObject(a)!.representation).toBe("surface");
    expect(actorRep(a)).toBe(2);
    const before = readSceneActorStates().find((s) => s.id === b)!;
    setObjectRepresentation(a, "wireframe");
    expect(getSceneObject(a)!.representation).toBe("wireframe");
    expect(actorRep(a)).toBe(1);
    const after = readSceneActorStates().find((s) => s.id === b)!;
    expect(after).toEqual(before);
    expect(after.actorRepresentation).toBe(2);
    const sa = readSceneActorStates().find((s) => s.id === a)!;
    expect(sa.color).toEqual([1, 0, 0]);
    expect(sa.opacity).toBeCloseTo(0.8);
  });

  it("undo で面に戻り、redo で線に戻る。ラベルは「描き方: 線」。同じ値への設定は記録しない", () => {
    const a = addMeshObject(sphere(10))!;
    setObjectRepresentation(a, "points");
    expect(actorRep(a)).toBe(0);
    setObjectRepresentation(a, "points"); // 同値: 何も積まない
    undo();
    expect(actorRep(a)).toBe(2);
    expect(getSceneObject(a)!.representation).toBe("surface");
    redo();
    expect(actorRep(a)).toBe(0);
  });

  it("描き方を変えても、体積・表面積・主径・三角形数は変わらない。他の外観操作の後も保たれる", () => {
    const a = addMeshObject(sphere(10))!;
    const m0 = (({ volumeMm3, surfaceAreaMm2, diameters, numTriangles }) => ({ volumeMm3, surfaceAreaMm2, diameters, numTriangles }))(getSceneObject(a)!);
    setObjectRepresentation(a, "wireframe");
    setObjectOpacity(a, 0.5);
    const o = getSceneObject(a)!;
    expect({ volumeMm3: o.volumeMm3, surfaceAreaMm2: o.surfaceAreaMm2, diameters: o.diameters, numTriangles: o.numTriangles }).toEqual(m0);
    expect(actorRep(a)).toBe(1);
  });

  it("物体を消して undo で戻しても、選んでいた描き方が保たれる", () => {
    const a = addMeshObject(sphere(10))!;
    setObjectRepresentation(a, "wireframe");
    removeObject(a);
    undo();
    expect(actorRep(a)).toBe(1);
  });
});
