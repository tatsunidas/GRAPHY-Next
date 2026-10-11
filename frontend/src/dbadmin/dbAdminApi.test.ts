import { describe, expect, it } from "vitest";
import { recordsNotice } from "./dbAdminApi";
import { ja } from "../i18n/ja";
import { en } from "../i18n/en";

describe("recordsNotice", () => {
  const t = (k: string, v?: Record<string, string | number>) => `${k}:${JSON.stringify(v ?? {})}`;
  const base = { roisMoved: 2, roiOverlaps: 0, registrationsMoved: 1, pluginDocsMoved: 1, pluginDocsKept: 0, reportsUpdated: 1 };
  it("残したもの・重なりが無ければ知らせない", () => {
    expect(recordsNotice({ updatedInstances: 3, records: base }, t)).toBeNull();
    expect(recordsNotice({ updatedInstances: 3 }, t)).toBeNull();
  });
  it("残したプラグインの記録・重なった ROI があれば件数を知らせる。文言は ja と en にある", () => {
    expect(recordsNotice({ updatedInstances: 3, records: { ...base, pluginDocsKept: 1, roiOverlaps: 2 } }, t))
      .toBe('dbadmin.edit.recordsKept:{"plugins":1,"overlaps":2}');
    expect(ja["dbadmin.edit.recordsKept"]).toContain("{{plugins}}");
    expect(en["dbadmin.edit.recordsKept"]).toContain("{{overlaps}}");
  });
});

import { deleteRelatedNote } from "./dbAdminApi";

describe("deleteRelatedNote", () => {
  const t = (k: string) => `<${k}>`;
  it("ファイルも消す設定のときだけ、付随データの扱いを添える", () => {
    expect(deleteRelatedNote("消しますか？", true, t)).toBe("消しますか？\n\n<dbadmin.delete.relatedNote>");
    expect(deleteRelatedNote("消しますか？", false, t)).toBe("消しますか？");
    expect(ja["dbadmin.delete.relatedNote"]).toContain("レポートは消えずに残ります");
    expect(en["dbadmin.delete.relatedNote"]).toContain("Reports are kept");
  });
});
