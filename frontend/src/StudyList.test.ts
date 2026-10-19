// 起動の待ち（backend にまだつながっていない）の間は検索せず、赤字の「取得に失敗しました」を出さない。
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const useStudies = vi.fn();
vi.mock("./hooks/useStudies", () => ({ useStudies: (...a: unknown[]) => useStudies(...a) }));
// 画像の表示部品（cornerstone）は node では読み込めないので外す。
vi.mock("./viewer/SeriesViewer", () => ({ SeriesViewer: () => null }));
vi.mock("./viewer/VideoViewer", () => ({ VideoViewer: () => null }));

import { I18nProvider } from "./i18n/i18n";
import { StudyList } from "./StudyList";

const filters = { studyDateFrom: "20261017", studyDateTo: "20261017" };

function render(connecting: boolean): string {
  return renderToStaticMarkup(
    createElement(I18nProvider, null, createElement(StudyList, { filters, connecting, mode: "standalone" })),
  );
}

describe("StudyList の接続待ち", () => {
  beforeEach(() => {
    useStudies.mockReset();
    // useAsyncData と同じく、条件が null なら取得せずエラーも空。条件があれば backend に届かず失敗する。
    useStudies.mockImplementation((f: unknown) => ({
      studies: null,
      reportCounts: {},
      error: f == null ? null : "Error: network error: TypeError: Failed to fetch",
    }));
  });

  it("接続待ちの間は検索せず、「接続中…」だけを出す", () => {
    const html = render(true);
    expect(useStudies.mock.calls[0][0]).toBeNull();
    expect(html).toContain("接続中…");
    expect(html).not.toContain("取得に失敗しました");
  });

  it("接続した後の失敗は赤字で知らせる", () => {
    const html = render(false);
    expect(useStudies.mock.calls[0][0]).toEqual(filters);
    expect(html).toContain("取得に失敗しました");
    expect(html).not.toContain("接続中…");
  });
});
