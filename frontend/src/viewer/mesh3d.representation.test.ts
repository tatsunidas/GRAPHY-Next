// @vitest-environment jsdom
/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// 物体の描き方（面・線・点）: 実際の vtk アクターの property を読んで確かめる。
import vtkSphereSource from "@kitware/vtk.js/Filters/Sources/SphereSource";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeSurfaceActor, POINTS_SIZE_CSS_PX, updateActorAppearance, WIREFRAME_LINE_WIDTH_CSS_PX } from "./mesh3d";

const sphere = () => {
  const s = vtkSphereSource.newInstance({ radius: 10 });
  return s.getOutputData();
};
const make = () => makeSurfaceActor(sphere(), { color: [1, 0, 0], opacity: 0.7, visible: true });

afterEach(() => vi.unstubAllGlobals());

describe("updateActorAppearance の描き方", () => {
  it("既定は面（2）。線で 1・点で 0・面で 2 に戻る", () => {
    const ma = make();
    const p = ma.actor.getProperty();
    expect(p.getRepresentation()).toBe(2);
    updateActorAppearance(ma, { representation: "wireframe" });
    expect(p.getRepresentation()).toBe(1);
    updateActorAppearance(ma, { representation: "points" });
    expect(p.getRepresentation()).toBe(0);
    updateActorAppearance(ma, { representation: "surface" });
    expect(p.getRepresentation()).toBe(2);
  });

  it("線の太さ・点の大きさは CSS px × devicePixelRatio", () => {
    vi.stubGlobal("devicePixelRatio", 2);
    const ma = make();
    updateActorAppearance(ma, { representation: "wireframe" });
    expect(ma.actor.getProperty().getLineWidth()).toBe(WIREFRAME_LINE_WIDTH_CSS_PX * 2);
    updateActorAppearance(ma, { representation: "points" });
    expect(ma.actor.getProperty().getPointSize()).toBe(POINTS_SIZE_CSS_PX * 2);
  });

  it("負例: representation を渡さない更新では、描き方も線幅も変わらない（色・不透明度・可視だけ）", () => {
    const ma = make();
    updateActorAppearance(ma, { representation: "wireframe" });
    const p = ma.actor.getProperty();
    const lw = p.getLineWidth();
    updateActorAppearance(ma, { color: [0, 1, 0], opacity: 0.3, visible: false });
    expect(p.getRepresentation()).toBe(1);
    expect(p.getLineWidth()).toBe(lw);
    expect(p.getOpacity()).toBeCloseTo(0.3);
    expect(ma.actor.getVisibility()).toBe(false);
  });

  it("色・不透明度は描き方を変えても保たれる", () => {
    const ma = make();
    updateActorAppearance(ma, { representation: "wireframe" });
    expect(Array.from(ma.actor.getProperty().getColor())).toEqual([1, 0, 0]);
    expect(ma.actor.getProperty().getOpacity()).toBeCloseTo(0.7);
  });
});
