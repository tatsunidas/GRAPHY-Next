/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, expect, it } from "vitest";
import {
  MAX_TOMBSTONES,
  ROI_SCHEMA_VERSION,
  buildAnnotationData,
  buildRestoredMeta,
  buildSaveFile,
  mergeSaveFiles,
  parseSaveFile,
  selectRestorable,
  toSavedRoi,
  tombstonesFor,
  type AnnotationLike,
  type ParsedRoiFile,
  type RoiSaveContext,
  type SavedRoi,
} from "./roiPersistence";

const SOP = "1.2.840.113619.2.340.3.1.2.3";
const IMAGE_ID = "wadouri:http://localhost:41234/api/instances/x/file";

function ctx(overrides: Partial<RoiSaveContext> = {}): RoiSaveContext {
  return {
    sopOf: (id) => (id === IMAGE_ID ? SOP : null),
    metaOf: () => undefined,
    ct: { c: 0, t: 0, studyUid: "1.2.3", seriesUid: "1.2.4" },
    ...overrides,
  };
}

const bidirectional: AnnotationLike = {
  annotationUID: "uid-1",
  metadata: { toolName: "Bidirectional", referencedImageId: IMAGE_ID },
  data: {
    handles: {
      points: [
        [10, 20, 30],
        [50, 20, 30],
        [30, 10, 30],
        [30, 30, 30],
      ],
    },
  },
};

describe("toSavedRoi", () => {
  it("annotationUID を保持する（プラグインが鍵に使うため）", () => {
    const s = toSavedRoi(bidirectional, ctx())!;
    expect(s.roiUid).toBe("uid-1");
    expect(s.tool).toBe("Bidirectional");
  });

  it("imageId ではなく SOP Instance UID を保存する", () => {
    const s = toSavedRoi(bidirectional, ctx())!;
    expect(s.sopInstanceUid).toBe(SOP);
    // imageId は backend のポートを含むので保存してはいけない。
    expect(JSON.stringify(s)).not.toContain("localhost");
  });

  it("ハンドルは患者座標のまま保存する（画素へ落として丸めない）", () => {
    const s = toSavedRoi(bidirectional, ctx())!;
    expect(s.points).toEqual([
      [10, 20, 30],
      [50, 20, 30],
      [30, 10, 30],
      [30, 30, 30],
    ]);
  });

  it("輪郭系は polyline と開閉も保存する", () => {
    const freehand: AnnotationLike = {
      annotationUID: "uid-2",
      metadata: { toolName: "PlanarFreehandROI", referencedImageId: IMAGE_ID },
      data: {
        handles: { points: [[0, 0, 5], [3, 3, 5]] },
        contour: { polyline: [[0, 0, 5], [3, 0, 5], [3, 3, 5]], closed: false },
      },
    };
    const s = toSavedRoi(freehand, ctx())!;
    expect(s.polyline).toHaveLength(3);
    expect(s.isOpenContour).toBe(true);
  });

  it("ROI マネージャのメタ（ラベル・scope・プラグイン属性）を持ち越す", () => {
    const s = toSavedRoi(
      bidirectional,
      ctx({
        metaOf: () => ({
          label: "肝 S4",
          scope: { studyUid: "1.2.3", seriesUid: "1.2.4", z: 12, c: 0, t: 0 },
          custom: { "plugin.lesion-evanesco.trackingId": "1" },
        }),
      }),
    )!;
    expect(s.label).toBe("肝 S4");
    expect(s.scope?.z).toBe(12);
    expect(s.custom).toEqual({ "plugin.lesion-evanesco.trackingId": "1" });
  });

  it("SOP を解決できない ROI は保存しない（復元先が決まらないため）", () => {
    const orphan: AnnotationLike = {
      ...bidirectional,
      metadata: { toolName: "Bidirectional", referencedImageId: "wadouri:unknown" },
    };
    expect(toSavedRoi(orphan, ctx())).toBeNull();
  });

  it("UID・ツール名・参照 imageId が欠けていれば保存しない", () => {
    expect(toSavedRoi({ ...bidirectional, annotationUID: undefined }, ctx())).toBeNull();
    expect(toSavedRoi({ ...bidirectional, metadata: { referencedImageId: IMAGE_ID } }, ctx())).toBeNull();
    expect(toSavedRoi({ ...bidirectional, metadata: { toolName: "Length" } }, ctx())).toBeNull();
  });

  it("座標が無い ROI は保存しない", () => {
    expect(toSavedRoi({ ...bidirectional, data: { handles: { points: [] } } }, ctx())).toBeNull();
  });

  it("非有限・次元不足の座標は落とす", () => {
    const broken: AnnotationLike = {
      annotationUID: "uid-3",
      metadata: { toolName: "Length", referencedImageId: IMAGE_ID },
      data: { handles: { points: [[0, 0, 0], [NaN, 1, 2] as number[], [1, 2] as number[], [4, 5, 6]] } },
    };
    expect(toSavedRoi(broken, ctx())!.points).toEqual([[0, 0, 0], [4, 5, 6]]);
  });

  it("非表示・ロックは保存し、既定値は書かない（保存を膨らませない）", () => {
    const plain = toSavedRoi(bidirectional, ctx())!;
    expect(plain.isVisible).toBeUndefined();
    expect(plain.isLocked).toBeUndefined();
    const hidden = toSavedRoi({ ...bidirectional, isVisible: false, isLocked: true }, ctx())!;
    expect(hidden.isVisible).toBe(false);
    expect(hidden.isLocked).toBe(true);
  });
});

describe("保存 → 読み込みの往復", () => {
  it("往復しても座標と UID が変わらない", () => {
    const saved = toSavedRoi(bidirectional, ctx({ metaOf: () => ({ label: "L" }) }))!;
    const json = JSON.stringify(buildSaveFile([saved], [], "test"));
    const back = parseSaveFile(json).rois;
    expect(back).toHaveLength(1);
    expect(back[0].roiUid).toBe("uid-1");
    expect(back[0].points).toEqual(saved.points);
    expect(back[0].label).toBe("L");
    expect(back[0].sopInstanceUid).toBe(SOP);
  });

  it("スプライン Fit の状態が往復する（落とすと再読み込みで直線に戻る）", () => {
    const spline = {
      annotationUID: "uid-spline",
      metadata: { toolName: "GraphyPolygonROI", referencedImageId: IMAGE_ID },
      data: {
        handles: { points: [[0, 0, 0], [1, 0, 0], [1, 1, 0]] },
        contour: { polyline: [[0, 0, 0], [1, 0, 0], [1, 1, 0]], closed: true },
        spline: { type: "CATMULLROM" },
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const saved = toSavedRoi(spline as any, ctx())!;
    expect(saved.splineType).toBe("CATMULLROM");
    const back = parseSaveFile(JSON.stringify(buildSaveFile([saved], [], "test"))).rois;
    expect(back[0].splineType).toBe("CATMULLROM");
  });

  it("保存ファイルは schema 版を持つ", () => {
    expect(buildSaveFile([]).schema).toBe(ROI_SCHEMA_VERSION);
  });
});

describe("parseSaveFile — 壊れた入力で全部を失わない", () => {
  it("壊れた要素だけ落として残りを活かす", () => {
    const json = JSON.stringify({
      schema: 1,
      rois: [
        { roiUid: "ok-1", tool: "Length", sopInstanceUid: SOP, points: [[0, 0, 0], [1, 1, 1]] },
        { tool: "Length", sopInstanceUid: SOP, points: [[0, 0, 0]] },
        { roiUid: "no-sop", tool: "Length", points: [[0, 0, 0]] },
        { roiUid: "no-points", tool: "Length", sopInstanceUid: SOP, points: [] },
        { roiUid: "ok-2", tool: "EllipticalROI", sopInstanceUid: SOP, points: [[2, 2, 2], [3, 3, 3]] },
      ],
    });
    expect(parseSaveFile(json).rois.map((r) => r.roiUid)).toEqual(["ok-1", "ok-2"]);
  });

  it("JSON として壊れていれば空配列（例外にしない）", () => {
    const empty: ParsedRoiFile = { rois: [], deleted: [], analyses: [] };
    expect(parseSaveFile("{not json")).toEqual(empty);
    expect(parseSaveFile("")).toEqual(empty);
    expect(parseSaveFile(null)).toEqual(empty);
    expect(parseSaveFile(undefined)).toEqual(empty);
    expect(parseSaveFile("[]")).toEqual(empty);
    expect(parseSaveFile('{"schema":1}')).toEqual(empty);
  });

  it("未来の schema は読まない（誤解釈して座標を壊すより取りこぼす）", () => {
    const json = JSON.stringify({
      schema: ROI_SCHEMA_VERSION + 1,
      rois: [{ roiUid: "x", tool: "Length", sopInstanceUid: SOP, points: [[0, 0, 0], [1, 1, 1]] }],
    });
    expect(parseSaveFile(json)).toEqual({ rois: [], deleted: [], analyses: [] });
  });

  it("scope の z/c/t は数値か \"all\" だけ通す", () => {
    const json = JSON.stringify({
      schema: 1,
      rois: [
        {
          roiUid: "s",
          tool: "Length",
          sopInstanceUid: SOP,
          points: [[0, 0, 0], [1, 1, 1]],
          scope: { studyUid: "1.2", z: "all", c: 0, t: "bogus" },
        },
      ],
    });
    const s = parseSaveFile(json).rois[0];
    expect(s.scope).toEqual({ studyUid: "1.2", z: "all", c: 0 });
  });

  it("custom は文字列化して通す（数値/真偽値も落とさない）", () => {
    const json = JSON.stringify({
      schema: 1,
      rois: [
        {
          roiUid: "c",
          tool: "Length",
          sopInstanceUid: SOP,
          points: [[0, 0, 0], [1, 1, 1]],
          custom: { a: "1", n: 2, b: true, obj: { x: 1 } },
        },
      ],
    });
    expect(parseSaveFile(json).rois[0].custom).toEqual({ a: "1", n: "2", b: "true" });
  });
});

describe("selectRestorable", () => {
  const rois: SavedRoi[] = [
    { roiUid: "a", tool: "Length", sopInstanceUid: "sop-a", points: [[0, 0, 0], [1, 1, 1]] },
    { roiUid: "b", tool: "Length", sopInstanceUid: "sop-b", points: [[0, 0, 0], [1, 1, 1]] },
    { roiUid: "c", tool: "Length", sopInstanceUid: "sop-c", points: [[0, 0, 0], [1, 1, 1]] },
  ];

  it("現在のスタックに無い SOP の ROI は復元しない（別シリーズへ載せない）", () => {
    const got = selectRestorable(rois, (sop) => (sop === "sop-b" ? "img-b" : null), () => false);
    expect(got.map((g) => g.roi.roiUid)).toEqual(["b"]);
    expect(got[0].imageId).toBe("img-b");
  });

  it("既にある UID は二重復元しない", () => {
    const got = selectRestorable(rois, () => "img", (uid) => uid === "a");
    expect(got.map((g) => g.roi.roiUid)).toEqual(["b", "c"]);
  });

  it("該当が無ければ空配列", () => {
    expect(selectRestorable(rois, () => null, () => false)).toEqual([]);
    expect(selectRestorable([], () => "img", () => false)).toEqual([]);
  });
});

describe("buildAnnotationData", () => {
  it("ハンドルを復元し、統計は空にする（描画時に再計算させる）", () => {
    const data = buildAnnotationData({
      roiUid: "x",
      tool: "Bidirectional",
      sopInstanceUid: SOP,
      points: [[1, 2, 3], [4, 5, 6]],
    });
    expect((data.handles as { points: number[][] }).points).toEqual([[1, 2, 3], [4, 5, 6]]);
    expect(data.cachedStats).toEqual({});
  });

  it("輪郭系は contour/polyline と開閉を復元する", () => {
    const poly = [[0, 0, 0], [1, 0, 0], [1, 1, 0]];
    const closed = buildAnnotationData({
      roiUid: "x", tool: "PlanarFreehandROI", sopInstanceUid: SOP, points: [], polyline: poly,
    });
    expect((closed.contour as { closed: boolean }).closed).toBe(true);
    expect(closed.isOpenContour).toBe(false);

    const open = buildAnnotationData({
      roiUid: "y", tool: "PlanarFreehandROI", sopInstanceUid: SOP, points: [], polyline: poly, isOpenContour: true,
    });
    expect((open.contour as { closed: boolean }).closed).toBe(false);
    expect(open.isOpenContour).toBe(true);
  });

  it("ハンドルが無い輪郭は polyline の両端をハンドルにする", () => {
    const poly = [[0, 0, 0], [5, 0, 0], [9, 9, 0]];
    const data = buildAnnotationData({
      roiUid: "x", tool: "PlanarFreehandROI", sopInstanceUid: SOP, points: [], polyline: poly,
    });
    expect((data.handles as { points: number[][] }).points).toEqual([[0, 0, 0], [9, 9, 0]]);
  });
});

describe("buildRestoredMeta", () => {
  it("患者キーとラベル・scope・プラグイン属性を戻す", () => {
    const meta = buildRestoredMeta(
      {
        roiUid: "x", tool: "Length", sopInstanceUid: SOP, points: [[0, 0, 0], [1, 1, 1]],
        label: "肝", scope: { z: 3 }, custom: { "plugin.p.k": "v" },
      },
      "PAT-1",
      "3: AXIAL CT",
    );
    expect(meta.patientKey).toBe("PAT-1");
    expect(meta.seriesLabel).toBe("3: AXIAL CT");
    expect(meta.label).toBe("肝");
    expect(meta.custom).toEqual({ "plugin.p.k": "v" });
  });

  it("origin が無ければ scope を origin として復元する", () => {
    const meta = buildRestoredMeta(
      { roiUid: "x", tool: "Length", sopInstanceUid: SOP, points: [[0, 0, 0], [1, 1, 1]], scope: { z: 7 } },
      "PAT-1",
    );
    expect(meta.origin).toEqual({ z: 7 });
  });
});

describe("mergeSaveFiles — 別ウィンドウの計測を失わず、削除は伝播する", () => {
  const roi = (uid: string, label?: string): SavedRoi => ({
    roiUid: uid, tool: "Length", sopInstanceUid: SOP, points: [[0, 0, 0], [1, 1, 1]], label,
  });
  const file = (rois: SavedRoi[], deleted: string[] = [], at = "2026-07-30T00:00:00Z"): ParsedRoiFile => ({
    rois,
    deleted: deleted.map((roiUid) => ({ roiUid, at })),
    analyses: [],
  });

  it("双方の ROI が残る（和を取る）", () => {
    const m = mergeSaveFiles(file([roi("a"), roi("b")]), file([roi("c")]));
    expect(m.rois.map((r) => r.roiUid)).toEqual(["a", "b", "c"]);
  });

  it("同じ UID はローカル（保存しようとしている側）を採る", () => {
    const m = mergeSaveFiles(file([roi("a", "remote")]), file([roi("a", "local")]));
    expect(m.rois).toHaveLength(1);
    expect(m.rois[0].label).toBe("local");
  });

  it("ローカルで削除した ROI は、リモートに残っていても復活しない", () => {
    const m = mergeSaveFiles(file([roi("a"), roi("b")]), file([roi("b")], ["a"]));
    expect(m.rois.map((r) => r.roiUid)).toEqual(["b"]);
    expect(m.deleted.map((t) => t.roiUid)).toEqual(["a"]);
  });

  it("リモートで削除された ROI は、ローカルに残っていても復活しない", () => {
    // 別ウィンドウが先に削除して保存した後、こちらがまだ持っている状況。
    const m = mergeSaveFiles(file([], ["a"]), file([roi("a"), roi("b")]));
    expect(m.rois.map((r) => r.roiUid)).toEqual(["b"]);
    expect(m.deleted.map((t) => t.roiUid)).toEqual(["a"]);
  });

  it("墓標は双方の和を取る（片方だけ見て消し漏らさない）", () => {
    const m = mergeSaveFiles(file([roi("c")], ["a"]), file([roi("c")], ["b"]));
    expect(m.deleted.map((t) => t.roiUid)).toEqual(["a", "b"]);
    expect(m.rois.map((r) => r.roiUid)).toEqual(["c"]);
  });

  it("同じ UID の墓標はローカルの時刻を残す（監査で直近の削除が見える）", () => {
    const m = mergeSaveFiles(
      file([], ["a"], "2026-01-01T00:00:00Z"),
      file([], ["a"], "2026-07-30T00:00:00Z"),
    );
    expect(m.deleted).toEqual([{ roiUid: "a", at: "2026-07-30T00:00:00Z" }]);
  });

  it("順序は UID で決定的（呼び出し順で保存内容が変わらない）", () => {
    const m1 = mergeSaveFiles(file([roi("z"), roi("a")]), file([roi("m")]));
    const m2 = mergeSaveFiles(file([roi("a"), roi("z")]), file([roi("m")]));
    expect(m1.rois.map((r) => r.roiUid)).toEqual(["a", "m", "z"]);
    expect(m2.rois.map((r) => r.roiUid)).toEqual(m1.rois.map((r) => r.roiUid));
  });

  it("片方が空でも成立する", () => {
    expect(mergeSaveFiles(file([]), file([roi("a")])).rois.map((r) => r.roiUid)).toEqual(["a"]);
    expect(mergeSaveFiles(file([roi("a")]), file([])).rois.map((r) => r.roiUid)).toEqual(["a"]);
    expect(mergeSaveFiles(file([]), file([]))).toEqual({ rois: [], deleted: [], analyses: [] });
  });
});

describe("tombstonesFor", () => {
  it("消えた UID だけ墓標にする", () => {
    const t = tombstonesFor(["a", "b", "c"], new Set(["b"]), "2026-07-30T12:00:00Z");
    expect(t).toEqual([
      { roiUid: "a", at: "2026-07-30T12:00:00Z" },
      { roiUid: "c", at: "2026-07-30T12:00:00Z" },
    ]);
  });

  it("何も消えていなければ空", () => {
    expect(tombstonesFor(["a"], new Set(["a"]), "t")).toEqual([]);
    expect(tombstonesFor([], new Set(["a"]), "t")).toEqual([]);
  });
});

describe("buildSaveFile — 墓標", () => {
  it("墓標を保存に含める", () => {
    const f = buildSaveFile([], [{ roiUid: "a", at: "2026-07-30T00:00:00Z" }]);
    expect(f.deleted).toEqual([{ roiUid: "a", at: "2026-07-30T00:00:00Z" }]);
  });

  it("上限を超えたら新しい順に切る（保存が無限に膨らまない）", () => {
    const many = Array.from({ length: MAX_TOMBSTONES + 5 }, (_, i) => ({
      roiUid: `uid-${i}`,
      // i が大きいほど新しい。
      at: new Date(Date.UTC(2020, 0, 1) + i * 1000).toISOString(),
    }));
    const f = buildSaveFile([], many);
    expect(f.deleted).toHaveLength(MAX_TOMBSTONES);
    // 最も新しいものが残り、最も古いものが落ちる。
    expect(f.deleted!.some((t) => t.roiUid === `uid-${MAX_TOMBSTONES + 4}`)).toBe(true);
    expect(f.deleted!.some((t) => t.roiUid === "uid-0")).toBe(false);
  });
});

describe("parseSaveFile — 墓標", () => {
  it("墓標を読み、墓標に載った ROI は復元候補に出さない（多重防御）", () => {
    const json = JSON.stringify({
      schema: 1,
      rois: [
        { roiUid: "alive", tool: "Length", sopInstanceUid: SOP, points: [[0, 0, 0], [1, 1, 1]] },
        { roiUid: "dead", tool: "Length", sopInstanceUid: SOP, points: [[0, 0, 0], [1, 1, 1]] },
      ],
      deleted: [{ roiUid: "dead", at: "2026-07-30T00:00:00Z" }],
    });
    const parsed = parseSaveFile(json);
    expect(parsed.rois.map((r) => r.roiUid)).toEqual(["alive"]);
    expect(parsed.deleted.map((t) => t.roiUid)).toEqual(["dead"]);
  });

  it("壊れた墓標要素は落とす", () => {
    const json = JSON.stringify({
      schema: 1,
      rois: [],
      deleted: [{ roiUid: "ok", at: "2026-07-30T00:00:00Z" }, { at: "x" }, null, { roiUid: "" }],
    });
    expect(parseSaveFile(json).deleted.map((t) => t.roiUid)).toEqual(["ok"]);
  });

  it("deleted が無い保存（旧形式）でも読める", () => {
    const json = JSON.stringify({
      schema: 1,
      rois: [{ roiUid: "a", tool: "Length", sopInstanceUid: SOP, points: [[0, 0, 0], [1, 1, 1]] }],
    });
    const parsed = parseSaveFile(json);
    expect(parsed.rois).toHaveLength(1);
    expect(parsed.deleted).toEqual([]);
  });
});

describe("マルチフレームのフレーム記録（2026-08-28）", () => {
  const xa = (frame: number) => `wadouri:http://x/instances/1.2.3/file&frame=${frame + 1}`;
  const ann = (uid: string, refId: string) => ({
    annotationUID: uid,
    metadata: { toolName: "Length", referencedImageId: refId },
    data: { handles: { points: [[0, 0, 0], [1, 1, 1]] } },
  });
  const ctx = {
    sopOf: () => "1.2.3",
    frameOf: (id: string) => {
      const m = /frame=(\d+)/.exec(id);
      return m ? Number(m[1]) - 1 : null;
    },
    metaOf: () => undefined,
  };

  it("🔴 ROI ごとに自分のフレームが入る（表示中の値を配らない）", () => {
    const a = toSavedRoi(ann("a", xa(0)), ctx)!;
    const b = toSavedRoi(ann("b", xa(7)), ctx)!;
    expect(a.frame).toBe(0);
    expect(b.frame).toBe(7);
    // 同じインスタンスなので SOP は同じ。**SOP だけでは区別できない**のがこの不具合の核心。
    expect(a.sopInstanceUid).toBe(b.sopInstanceUid);
  });

  it("単一フレーム（frame= 無し）では frame を持たない", () => {
    const r = toSavedRoi(ann("c", "wadouri:http://x/instances/1.2.3/file"), ctx)!;
    expect(r.frame).toBeUndefined();
  });

  it("frameOf を渡さなければ記録しない（従来の呼び出しを壊さない）", () => {
    const r = toSavedRoi(ann("d", xa(3)), { sopOf: () => "1.2.3", metaOf: () => undefined })!;
    expect(r.frame).toBeUndefined();
  });

  it("保存 → 読み込みで frame が往復する", () => {
    const file = buildSaveFile([toSavedRoi(ann("a", xa(4)), ctx)!]);
    const back = parseSaveFile(JSON.stringify(file));
    expect(back.rois[0].frame).toBe(4);
  });

  it("壊れた frame は取り込まない（負・非数）", () => {
    const file = buildSaveFile([toSavedRoi(ann("a", xa(4)), ctx)!]);
    const raw = JSON.parse(JSON.stringify(file));
    raw.rois[0].frame = -1;
    expect(parseSaveFile(JSON.stringify(raw)).rois[0].frame).toBeUndefined();
    raw.rois[0].frame = "3";
    expect(parseSaveFile(JSON.stringify(raw)).rois[0].frame).toBeUndefined();
  });

  it("selectRestorable はフレームを解決関数へ渡す", () => {
    const rois = [
      { roiUid: "a", tool: "Length", sopInstanceUid: "1.2.3", frame: 2, points: [] },
      { roiUid: "b", tool: "Length", sopInstanceUid: "1.2.3", points: [] },
    ];
    const seen: (number | undefined)[] = [];
    selectRestorable(rois, (_sop, frame) => {
      seen.push(frame);
      return "img";
    }, () => false);
    expect(seen).toEqual([2, undefined]);
  });
});
