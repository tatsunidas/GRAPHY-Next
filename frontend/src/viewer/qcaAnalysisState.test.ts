/*
 * QCA 解析状態の保存形（§14.5）。
 *
 * 🔴 守りたいのは「保存できる」ことではなく、**復元しても同じ解析になる**こと。
 * 壊れた値を黙って直して復元すると、**前と違う数値が「復元しました」の顔で出る**。
 */
import { describe, expect, it } from "vitest";

import {
  analysisId,
  dropAnalysesFor,
  findAnalysis,
  mergeAnalyses,
  sanitizeAnalysis,
  upsertAnalysis,
  type SavedQcaAnalysis,
} from "./qcaAnalysisState";

const base: SavedQcaAnalysis = {
  id: "sop#3#roi-1#qca",
  mode: "qca",
  studyUid: "1.2.3",
  seriesUid: "1.2.3.4",
  sopInstanceUid: "sop",
  frame: 3,
  pickUid: "roi-1",
  edgeToken: "261-abc",
  waypoints: [[10, 20]],
  edgeEdits: { 5: { left: -3, right: 4 } },
  trim: { from: 2, to: 90 },
  reference: { kind: "segments", ranges: [[0, 10]] },
  sr: { seriesInstanceUid: "sr-series", sopInstanceUid: "sr-sop" },
  savedAt: "2026-08-29T00:00:00.000Z",
};

describe("analysisId", () => {
  it("フレームまで含める（別フレームは別の解析）", () => {
    const a = analysisId({ sopInstanceUid: "s", frame: 0, pickUid: "p", mode: "qca" });
    const b = analysisId({ sopInstanceUid: "s", frame: 1, pickUid: "p", mode: "qca" });
    expect(a).not.toBe(b);
  });

  it("QCA と QVA は別（同じ計測でも参照径の既定が違う）", () => {
    const a = analysisId({ sopInstanceUid: "s", frame: 0, pickUid: "p", mode: "qca" });
    const b = analysisId({ sopInstanceUid: "s", frame: 0, pickUid: "p", mode: "qva" });
    expect(a).not.toBe(b);
  });
});

describe("sanitizeAnalysis", () => {
  it("往復して同じになる", () => {
    const back = sanitizeAnalysis(JSON.parse(JSON.stringify(base)));
    expect(back).toEqual(base);
  });

  it("鍵が欠けていれば読まない", () => {
    expect(sanitizeAnalysis(null)).toBeNull();
    expect(sanitizeAnalysis({ ...base, sopInstanceUid: "" })).toBeNull();
    expect(sanitizeAnalysis({ ...base, pickUid: undefined })).toBeNull();
    expect(sanitizeAnalysis({ ...base, frame: Number.NaN })).toBeNull();
  });

  it("🔴 符号の約束を破るエッジ手修正は入れない（left<0<right）", () => {
    const a = sanitizeAnalysis({ ...base, edgeEdits: { 5: { left: 3, right: -4 }, 6: { left: -1 } } })!;
    expect(a.edgeEdits[5]).toBeUndefined();
    expect(a.edgeEdits[6]).toEqual({ left: -1 });
  });

  it("非有限の中間点は落とす", () => {
    const a = sanitizeAnalysis({ ...base, waypoints: [[1, 2], [Number.NaN, 3], [4, 5]] })!;
    expect(a.waypoints).toEqual([
      [1, 2],
      [4, 5],
    ]);
  });

  it("🔴 健常部の区間が 1 つも読めなければ auto へ落とす（黙って別の参照径にしない）", () => {
    const a = sanitizeAnalysis({ ...base, reference: { kind: "segments", ranges: [["x", 1]] } })!;
    expect(a.reference).toEqual({ kind: "auto" });
  });

  it("未知の参照径の種類は auto", () => {
    const a = sanitizeAnalysis({ ...base, reference: { kind: "nope" } })!;
    expect(a.reference).toEqual({ kind: "auto" });
  });

  it("SR の参照は両方揃っていなければ null（片方だけでは上書き先を指せない）", () => {
    expect(sanitizeAnalysis({ ...base, sr: { seriesInstanceUid: "s" } })!.sr).toBeNull();
    expect(sanitizeAnalysis({ ...base, sr: null })!.sr).toBeNull();
  });
});

describe("upsertAnalysis / findAnalysis", () => {
  it("同じ計測の解析は 1 件だけ（差し替え）", () => {
    const older = { ...base, savedAt: "2026-01-01T00:00:00.000Z" };
    const list = upsertAnalysis(upsertAnalysis([], older), base);
    expect(list).toHaveLength(1);
    expect(list[0].savedAt).toBe(base.savedAt);
  });

  it("鍵で引ける", () => {
    const list = upsertAnalysis([], base);
    expect(findAnalysis(list, { sopInstanceUid: "sop", frame: 3, pickUid: "roi-1", mode: "qca" })).toEqual(base);
    expect(findAnalysis(list, { sopInstanceUid: "sop", frame: 4, pickUid: "roi-1", mode: "qca" })).toBeNull();
  });
});

describe("mergeAnalyses", () => {
  it("🔴 同じ id は新しい方を採る（ROI と違い和集合ではない）", () => {
    const remote = [{ ...base, savedAt: "2026-08-29T10:00:00.000Z", edgeToken: "remote" }];
    const local = [{ ...base, savedAt: "2026-08-29T09:00:00.000Z", edgeToken: "local" }];
    expect(mergeAnalyses(remote, local)[0].edgeToken).toBe("remote");
    expect(mergeAnalyses(local, remote)[0].edgeToken).toBe("remote");
  });

  it("別の id は両方残る", () => {
    const other = { ...base, id: "other", pickUid: "roi-2" };
    expect(mergeAnalyses([base], [other])).toHaveLength(2);
  });
});

describe("dropAnalysesFor", () => {
  it("元の計測が消えた解析は落とす", () => {
    expect(dropAnalysesFor([base], ["roi-1"])).toEqual([]);
    expect(dropAnalysesFor([base], ["roi-9"])).toEqual([base]);
    expect(dropAnalysesFor([base], [])).toEqual([base]);
  });
});
