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
  rescaleRoiToSpacing,
  selectRestorable,
  toSavedRoi,
  tombstonesFor,
  type AnnotationLike,
  type ParsedRoiFile,
  type RoiSaveContext,
  type SavedRoi,
  type SavedSphere,
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
    const empty: ParsedRoiFile = { rois: [], deleted: [], analyses: [], spheres: [] };
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
    expect(parseSaveFile(json)).toEqual({ rois: [], deleted: [], analyses: [], spheres: [] });
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
    spheres: [],
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
    expect(mergeSaveFiles(file([]), file([]))).toEqual({ rois: [], deleted: [], analyses: [], spheres: [] });
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

describe("球 ROI の保存（spheres）", () => {
  const sph = (uid: string, over: Partial<SavedSphere> = {}): SavedSphere => ({
    uid, studyUid: "1.2.3", seriesUid: "1.2.4", refSopInstanceUid: SOP,
    center: [1, 2, 3], radiusMm: 5.5, c: "all", t: 0, label: "Sphere", color: "#00e5ff", visible: true, ...over,
  });
  const parsedOf = (spheres: SavedSphere[], deleted: string[] = []): ParsedRoiFile => ({
    rois: [], deleted: deleted.map((roiUid) => ({ roiUid, at: "2026-10-26T00:00:00Z" })), analyses: [], spheres,
  });

  it("build → parse で往復する（グループも保つ）", () => {
    const a = sph("s1", { groupId: "g1", groupName: "グループ 1" });
    const file = buildSaveFile([], [], "t", [], [a, sph("s2", { visible: false })]);
    const back = parseSaveFile(JSON.stringify(file)).spheres;
    expect(back).toEqual([a, sph("s2", { visible: false })]);
    expect(file.schema).toBe(ROI_SCHEMA_VERSION);
  });

  it("球が無いときはキーを出さない・旧ファイルは空配列", () => {
    const file = buildSaveFile([], [], "t");
    expect("spheres" in file).toBe(false);
    expect(parseSaveFile(JSON.stringify(file)).spheres).toEqual([]);
  });

  it("壊れた球だけを個別に落とす（必須項目・数値・重複）", () => {
    const good = sph("ok");
    const raw = { schema: 1, rois: [], spheres: [
      good,
      sph("dup"), sph("dup"),
      { ...sph("nouid"), uid: "" },
      sph("noseries", { seriesUid: "" }),
      sph("nosop", { refSopInstanceUid: "" }),
      sph("zero", { radiusMm: 0 }),
      sph("nan", { radiusMm: NaN }),
      { ...sph("c2"), center: [1, 2] },
      { ...sph("c3"), center: [1, "x", 3] },
      null, "x",
    ] };
    expect(parseSaveFile(JSON.stringify(raw)).spheres.map((s) => s.uid)).toEqual(["ok", "dup"]);
  });

  it("墓標に載った球は読まない・保存しない", () => {
    const raw = { schema: 1, rois: [], deleted: [{ roiUid: "gone", at: "x" }], spheres: [sph("gone"), sph("keep")] };
    expect(parseSaveFile(JSON.stringify(raw)).spheres.map((s) => s.uid)).toEqual(["keep"]);
    const built = buildSaveFile([], [{ roiUid: "gone", at: "x" }], "t", [], [sph("gone"), sph("keep")]);
    expect(built.spheres?.map((s) => s.uid)).toEqual(["keep"]);
  });

  it("マージ: 和集合・同じ uid はローカル・墓標の球は除く", () => {
    const m = mergeSaveFiles(
      parsedOf([sph("a"), sph("b", { label: "remote" }), sph("dead")]),
      parsedOf([sph("b", { label: "local" }), sph("c")], ["dead"]),
    );
    expect(m.spheres.map((s) => [s.uid, s.label])).toEqual([["a", "Sphere"], ["b", "local"], ["c", "Sphere"]]);
  });
});

describe("旧版の解析状態（analyses）— 中身を読まずに素通しする", () => {
  // 2D QCA は本体から外れたが、古い保存ファイルを上書き保存しても解析状態は失わない。
  // 形は問わない（旧版が書いた形も、壊れた形も、そのまま残す）。
  const legacy: unknown[] = [
    { pickUid: "p1", imageId: "img", result: { mld: 1.23, nested: [1, 2, { a: "b" }] } },
    { pickUid: "gone-roi", note: "墓標に載った ROI に紐づく解析" },
    "string-element",
    42,
    null,
  ];
  const roi: SavedRoi = { roiUid: "r1", tool: "Length", sopInstanceUid: SOP, points: [[0, 0, 0], [1, 1, 1]] };

  it("読み込み → 保存 → 再読込で、要素も順序もそのまま残る", () => {
    const first = parseSaveFile(JSON.stringify({ schema: ROI_SCHEMA_VERSION, rois: [roi], analyses: legacy }));
    expect(first.analyses).toEqual(legacy);
    const saved = buildSaveFile(first.rois, first.deleted, "graphy-next", first.analyses, first.spheres);
    expect(parseSaveFile(JSON.stringify(saved)).analyses).toEqual(legacy);
  });

  it("墓標に載った ROI に紐づくものも落とさない（中身を読まないので突き合わせない）", () => {
    const saved = buildSaveFile([], [{ roiUid: "gone-roi", at: "2026-10-27T00:00:00Z" }], "graphy-next", legacy);
    expect(saved.analyses).toEqual(legacy);
  });

  it("analyses が無い・配列でないファイルは空配列", () => {
    expect(parseSaveFile(JSON.stringify({ schema: ROI_SCHEMA_VERSION, rois: [roi] })).analyses).toEqual([]);
    expect(parseSaveFile(JSON.stringify({ schema: ROI_SCHEMA_VERSION, rois: [roi], analyses: { a: 1 } })).analyses).toEqual([]);
  });

  it("mergeSaveFiles: 保存済み（remote）を正とし、空のときだけローカルの持ち越しを使う", () => {
    const base = { rois: [], deleted: [], spheres: [] };
    expect(mergeSaveFiles({ ...base, analyses: [{ id: "remote" }] }, { ...base, analyses: [{ id: "local" }] }).analyses).toEqual([{ id: "remote" }]);
    expect(mergeSaveFiles({ ...base, analyses: [] }, { ...base, analyses: [{ id: "local" }] }).analyses).toEqual([{ id: "local" }]);
  });
});

describe("worldSpacing — IPP の無い画像の world の基準（校正で変わる）", () => {
  const ann: AnnotationLike = {
    annotationUID: "r1",
    metadata: { toolName: "Length", referencedImageId: IMAGE_ID },
    data: { handles: { points: [[10, 20, 0], [40, 20, 0]] } },
  };

  it("保存: worldSpacingOf が値を返すと記録し、null・省略では記録しない", () => {
    expect(toSavedRoi(ann, ctx({ worldSpacingOf: () => [0.214, 0.2] }))?.worldSpacing).toEqual([0.214, 0.2]);
    expect(toSavedRoi(ann, ctx({ worldSpacingOf: () => null }))?.worldSpacing).toBeUndefined();
    expect(toSavedRoi(ann, ctx())?.worldSpacing).toBeUndefined();
  });

  it("読み込み: 正の有限数 2 つだけ通し、壊れた値は捨てる（ROI 自体は残す）", () => {
    const mk = (ws: unknown) => parseSaveFile(JSON.stringify({ schema: ROI_SCHEMA_VERSION, rois: [{ roiUid: "r", tool: "Length", sopInstanceUid: SOP, points: [[0, 0, 0]], worldSpacing: ws }] })).rois;
    expect(mk([0.214, 0.214])[0].worldSpacing).toEqual([0.214, 0.214]);
    for (const bad of [[0, 1], [-1, 1], [1], [1, "a"], "x", null]) {
      const r = mk(bad);
      expect(r).toHaveLength(1);
      expect(r[0].worldSpacing).toBeUndefined();
    }
  });

  it("換算: 保存時 0.214・今 0.0371 の基準なら、画素位置を保つよう x・y を 0.0371/0.214 倍にし z は変えない", () => {
    const roi: SavedRoi = { roiUid: "r", tool: "Length", sopInstanceUid: SOP, worldSpacing: [0.214, 0.214], points: [[10, 20, 3], [40, 20, 3]], polyline: [[1, 2, 3]] };
    const out = rescaleRoiToSpacing(roi, [0.0371, 0.0371]);
    const k = 0.0371 / 0.214;
    expect(out.points[1][0]).toBeCloseTo(40 * k, 9);
    expect(out.points[1][1]).toBeCloseTo(20 * k, 9);
    expect(out.points[1][2]).toBe(3);
    expect(out.polyline?.[0][0]).toBeCloseTo(k, 9);
    expect(out.worldSpacing).toEqual([0.0371, 0.0371]);
    expect(roi.points[1][0]).toBe(40); // 元は変えない
  });

  it("換算: 行と列の間隔が違えば軸ごとに換算する（x は列、y は行）", () => {
    const roi: SavedRoi = { roiUid: "r", tool: "Length", sopInstanceUid: SOP, worldSpacing: [0.2, 0.1], points: [[10, 10, 0]] };
    const out = rescaleRoiToSpacing(roi, [0.1, 0.4]);
    // x: 10 ÷ 0.1(列)=100 画素 → ×0.4 = 40。y: 10 ÷ 0.2(行)=50 画素 → ×0.1 = 5。
    expect(out.points[0]).toEqual([40, 5, 0]);
  });

  it("換算しない: 基準を持たない旧保存・今の基準が不明・同じ基準は元のまま（同一オブジェクト）", () => {
    const old: SavedRoi = { roiUid: "r", tool: "Length", sopInstanceUid: SOP, points: [[10, 20, 0]] };
    expect(rescaleRoiToSpacing(old, [0.1, 0.1])).toBe(old);
    const withWs: SavedRoi = { ...old, worldSpacing: [0.214, 0.214] };
    expect(rescaleRoiToSpacing(withWs, null)).toBe(withWs);
    expect(rescaleRoiToSpacing(withWs, [0.214, 0.214])).toBe(withWs);
  });
});
