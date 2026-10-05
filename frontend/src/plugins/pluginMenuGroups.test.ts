import { describe, expect, it } from "vitest";
import { groupViewerPluginItems } from "./pluginMenuGroups";
import type { PluginMenuItem } from "./pluginRegistry";

const item = (id: string, category?: "ai"): PluginMenuItem => ({ id, label: id, onClick: () => {}, category });

describe("groupViewerPluginItems", () => {
  it("moves AI items from both surfaces into one AI group", () => {
    const g = groupViewerPluginItems(
      [item("hello"), item("gemini", "ai")],
      [item("subtraction"), item("monai", "ai")],
    );
    expect(g.plugins.map((p) => p.id)).toEqual(["hello"]);
    expect(g.analysis.map((p) => p.id)).toEqual(["subtraction"]);
    expect(g.ai.map((p) => p.id)).toEqual(["monai", "gemini"]);
  });

  it("lists a plugin that declares both surfaces only once", () => {
    const g = groupViewerPluginItems([item("monai", "ai")], [item("monai", "ai")]);
    expect(g.ai.map((p) => p.id)).toEqual(["monai"]);
    expect(g.plugins).toEqual([]);
    expect(g.analysis).toEqual([]);
  });

  it("keeps everything flat when no plugin is AI", () => {
    const g = groupViewerPluginItems([item("a")], [item("b")]);
    expect(g.ai).toEqual([]);
    expect(g.plugins.map((p) => p.id)).toEqual(["a"]);
    expect(g.analysis.map((p) => p.id)).toEqual(["b"]);
  });
});
