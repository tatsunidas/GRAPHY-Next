import { beforeEach, describe, expect, it } from "vitest";
import { forgetLabelVolume, isLabelVolumeOf, markLabelVolume } from "./labelVolumeOrigin";

describe("labelVolumeOrigin", () => {
  beforeEach(() => forgetLabelVolume("seg-1"));

  it("出した本人だけが一致する", () => {
    markLabelVolume("seg-1", "plugin-a");
    expect(isLabelVolumeOf("seg-1", "plugin-a")).toBe(true);
    expect(isLabelVolumeOf("seg-1", "plugin-b")).toBe(false);
  });

  it("記録の無い Mask（本体・利用者が作ったもの）は誰にも一致しない", () => {
    expect(isLabelVolumeOf("never-marked", "plugin-a")).toBe(false);
    expect(isLabelVolumeOf("seg-1", "")).toBe(false);
  });

  it("忘れたあとは一致しない", () => {
    markLabelVolume("seg-1", "plugin-a");
    forgetLabelVolume("seg-1");
    expect(isLabelVolumeOf("seg-1", "plugin-a")).toBe(false);
  });
});
