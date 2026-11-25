import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { EyeIcon } from "./EyeIcon";

describe("EyeIcon（可視・不可視のアイコン）", () => {
  it("可視は開いた目、不可視は斜線の入った閉じた目（禁止マークの絵文字を使わない）", () => {
    const open = renderToStaticMarkup(<EyeIcon open />);
    const closed = renderToStaticMarkup(<EyeIcon open={false} />);
    expect(open).toContain('data-eye="open"');
    expect(open).toContain("<circle"); // 瞳
    expect(open).not.toContain("<line"); // 斜線なし
    expect(closed).toContain('data-eye="closed"');
    expect(closed).toContain("<line"); // 斜線
    expect(open).not.toContain("🚫");
    expect(closed).not.toContain("🚫");
    expect(open).not.toBe(closed);
  });
});
