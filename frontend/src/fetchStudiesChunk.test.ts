import { beforeEach, describe, expect, it, vi } from "vitest";

const httpGet = vi.hoisted(() => vi.fn());
vi.mock("./http", async () => {
  const actual = await vi.importActual<typeof import("./http")>("./http");
  return { ...actual, httpGet: (...a: unknown[]) => httpGet(...a) };
});

import { fetchStudies, splitStudyUidFilter } from "./api";

const uid = (i: number) => `1.2.826.0.1.3680043.10.1338.${String(i).padStart(6, "0")}`;
const study = (u: string) => ({ studyInstanceUid: u });

describe("splitStudyUidFilter", () => {
  it("載る長さなら 1 件のまま（条件も変えない）", () => {
    const f = { studyInstanceUid: [uid(1), uid(2)].join(",") };
    expect(splitStudyUidFilter(f)).toEqual([f]);
    expect(splitStudyUidFilter({ patientId: "P" })).toEqual([{ patientId: "P" }]);
  });

  it("長いときはエンコード後の長さで分け、全部の UID が 1 回ずつ入る", () => {
    const all = Array.from({ length: 300 }, (_, i) => uid(i));
    const parts = splitStudyUidFilter({ studyInstanceUid: all.join(",") });
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(encodeURIComponent(p.studyInstanceUid!).length).toBeLessThanOrEqual(3000);
    expect(parts.flatMap((p) => p.studyInstanceUid!.split(","))).toEqual(all);
  });
});

describe("fetchStudies", () => {
  // 注意: 矢印関数の戻り値（モック）は、vitest が後始末の関数として呼んでしまうので、ブロックで返さない
  beforeEach(() => {
    httpGet.mockReset();
  });

  it("長い UID 指定は分割して取得し、結果を連結する（全件・重複なし）", async () => {
    const all = Array.from({ length: 300 }, (_, i) => uid(i));
    httpGet.mockImplementation(async (path: string) => {
      const q = new URL(path, "http://x").searchParams.get("studyInstanceUid") ?? "";
      expect(path.length).toBeLessThan(4000); // 1 リクエストの URL が Tomcat の上限（8KB）に収まる
      return q.split(",").map(study);
    });
    const got = await fetchStudies({ studyInstanceUid: all.join(",") });
    expect(httpGet.mock.calls.length).toBeGreaterThan(1);
    expect(got.map((s) => s.studyInstanceUid).sort()).toEqual([...all].sort());
  });

  it("短い指定は 1 回の取得のまま", async () => {
    httpGet.mockResolvedValue([study(uid(1))]);
    await fetchStudies({ studyInstanceUid: uid(1) });
    expect(httpGet).toHaveBeenCalledTimes(1);
  });

  it("条件なしの取得は従来どおり", async () => {
    httpGet.mockResolvedValue([]);
    await fetchStudies();
    expect(httpGet).toHaveBeenCalledWith("/api/studies");
  });
});
