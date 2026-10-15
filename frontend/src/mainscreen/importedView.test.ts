import { describe, expect, it } from "vitest";
import { importedStudiesView, MAX_IMPORTED_STUDIES } from "./importedView";

describe("importedStudiesView", () => {
  it("returns null when nothing was imported", () => {
    expect(importedStudiesView([])).toBeNull();
    expect(importedStudiesView(undefined)).toBeNull();
  });

  it("filters by the imported study UIDs, de-duplicated", () => {
    const v = importedStudiesView(["1.2.a", "1.2.b", "1.2.a"]);
    expect(v).toEqual({ filters: { studyInstanceUid: "1.2.a,1.2.b" }, shown: 2, total: 2 });
  });

  it("caps the number of studies put in the query", () => {
    const uids = Array.from({ length: MAX_IMPORTED_STUDIES + 5 }, (_, i) => `1.2.${i}`);
    const v = importedStudiesView(uids)!;
    expect(v.shown).toBe(MAX_IMPORTED_STUDIES);
    expect(v.total).toBe(MAX_IMPORTED_STUDIES + 5);
    expect(v.filters.studyInstanceUid!.split(",")).toHaveLength(MAX_IMPORTED_STUDIES);
  });
});
