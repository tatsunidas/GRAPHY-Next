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

// ── 足したタグ列 ──
const listColumnsState = vi.hoisted(() => ({ cols: [] as import("./mainscreen/listColumns").ListColumn[] }));
vi.mock("./mainscreen/listColumns", async () => {
  const actual = await vi.importActual<typeof import("./mainscreen/listColumns")>("./mainscreen/listColumns");
  return { ...actual, useListColumns: () => listColumnsState.cols };
});
const useStudyColumnCells = vi.hoisted(() => vi.fn());
vi.mock("./hooks/useListColumnCells", () => ({
  useStudyColumnCells: (...a: unknown[]) => useStudyColumnCells(...a) ?? { cells: null, error: null },
  useSeriesColumnCells: () => ({ cells: null, error: null }),
}));

describe("StudyList added tag columns", () => {
  const studies = [
    { studyInstanceUid: "ST1", patientId: "P1", patientName: "N1", studyDate: "20261001", studyDescription: "D1", modality: "CT", numberOfInstances: 10 },
    { studyInstanceUid: "ST2", patientId: "P2", patientName: "N2", studyDate: "20261002", studyDescription: "D2", modality: "MR", numberOfInstances: 5 },
    { studyInstanceUid: "ST3", patientId: "P3", patientName: "N3", studyDate: "20261003", studyDescription: "D3", modality: "CT", numberOfInstances: 7 },
  ];
  const columns = [
    { id: "col1", segments: [{ tag: "00181030" }], label: "ProtocolName", where: "both" as const },
    { id: "col2", segments: [{ tag: "00181030" }], label: "SeriesOnly", where: "series" as const },
  ];

  beforeEach(() => {
    useStudies.mockReset();
    useStudyColumnCells.mockReset();
    useStudies.mockImplementation(() => ({ studies, reportCounts: {}, error: null }));
  });

  function html(): string {
    return renderToStaticMarkup(
      createElement(I18nProvider, null, createElement(StudyList, { filters, mode: "standalone" })),
    );
  }

  it("adds no column and fetches nothing when no column is set", () => {
    listColumnsState.cols = [];
    useStudyColumnCells.mockReturnValue({ cells: null, error: null });
    const out = html();
    expect(out).not.toContain("list-col-head-");
    expect(useStudyColumnCells.mock.calls[0][1]).toEqual([]);
  });

  it("adds only the study-level columns (series-only ones are left out) and passes the studies on the page", () => {
    listColumnsState.cols = columns;
    useStudyColumnCells.mockReturnValue({ cells: null, error: null });
    const out = html();
    expect(out).toContain('data-testid="list-col-head-col1"');
    expect(out).not.toContain("list-col-head-col2");
    const [uids, cols] = useStudyColumnCells.mock.calls[0] as [string[], { id: string }[]];
    expect(uids).toEqual(["ST1", "ST2", "ST3"]);
    expect(cols.map((c) => c.id)).toEqual(["col1"]);
  });

  it("shows value / absent / loading per row", () => {
    listColumnsState.cols = columns;
    useStudyColumnCells.mockReturnValue({
      cells: {
        ST1: { col1: { values: ["Chest 1.0", "WB PET"], state: "OK", incomplete: false } },
        ST2: { col1: { values: [], state: "ABSENT", incomplete: false } },
        // ST3 has not arrived yet
      },
      error: null,
    });
    const out = html();
    const kinds = [...out.matchAll(/data-testid="list-col-col1" data-kind="([a-zA-Z]+)"/g)].map((m) => m[1]);
    expect(kinds).toEqual(["value", "absent", "loading"]);
    expect(out).toContain("Chest 1.0 / WB PET");
  });

  it("the heading of an added column has no sort handle and carries the reason as a tooltip", () => {
    listColumnsState.cols = columns;
    useStudyColumnCells.mockReturnValue({ cells: null, error: null });
    const out = html();
    const th = /<th[^>]*data-testid="list-col-head-col1"[^>]*>/.exec(out)![0];
    expect(th).toContain("title=");
    expect(th).toContain("並び替えできません");
    expect(th).not.toContain("cursor:pointer");
  });
});

// ── 複数選択（アルバムへの追加用のチェック列） ──
describe("StudyList のチェック列", () => {
  const studies = [
    { studyInstanceUid: "ST1", patientId: "P1", patientName: "N1", studyDate: "20261001", studyDescription: "D1", modality: "CT", numberOfInstances: 10 },
    { studyInstanceUid: "ST2", patientId: "P2", patientName: "N2", studyDate: "20261002", studyDescription: "D2", modality: "MR", numberOfInstances: 5 },
  ];
  beforeEach(() => {
    useStudies.mockReset();
    useStudies.mockImplementation(() => ({ studies, reportCounts: {}, error: null }));
    listColumnsState.cols = [];
  });
  const render2 = (props: Record<string, unknown>) =>
    renderToStaticMarkup(
      createElement(I18nProvider, null, createElement(StudyList, { filters: { studyDateFrom: "20261001" }, mode: "standalone", ...props })),
    );

  it("checked と onCheckedChange を渡したときだけ、チェック列を出す（従来の表は変えない）", () => {
    expect(render2({})).not.toContain("study-check-");
    const html = render2({ checked: new Set<string>(), onCheckedChange: () => {} });
    expect(html).toContain('data-testid="study-check-ST1"');
    expect(html).toContain('data-testid="study-check-ST2"');
    expect(html).toContain('data-testid="study-check-page"');
  });

  it("選択済みの行だけがチェックされる", () => {
    const html = render2({ checked: new Set(["ST2"]), onCheckedChange: () => {} });
    const row = (id: string) => html.match(new RegExp(`<input[^>]*data-testid="study-check-${id}"[^>]*>`))![0];
    expect(row("ST2")).toContain("checked");
    expect(row("ST1")).not.toContain("checked");
  });

  it("全部が選択済みなら、見出しのチェックも入る", () => {
    const all = render2({ checked: new Set(["ST1", "ST2"]), onCheckedChange: () => {} });
    expect(all.match(/<input[^>]*data-testid="study-check-page"[^>]*>/)![0]).toContain("checked");
    const part = render2({ checked: new Set(["ST1"]), onCheckedChange: () => {} });
    expect(part.match(/<input[^>]*data-testid="study-check-page"[^>]*>/)![0]).not.toContain("checked");
  });
});
