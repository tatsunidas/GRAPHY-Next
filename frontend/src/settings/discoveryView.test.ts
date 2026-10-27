/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, expect, it, vi } from "vitest";
import type { DiscoveredDevice } from "../api";
import { addDiscovered, findSameAe, groupDiscovered, toRow, type AeRow } from "./discoveryView";

const dev = (over: Partial<DiscoveredDevice>): DiscoveredDevice => ({
  name: "WS1", aeTitle: "WS1", aeTitleFromName: false, host: "10.0.0.1", port: 11112, tls: false, tlsPort: 0, ...over,
});

describe("groupDiscovered", () => {
  it("同じ機器が複数の NIC で見えたら 1 台にまとめ、アドレスを並べる", () => {
    const items = groupDiscovered([dev({ host: "192.168.1.76" }), dev({ host: "192.168.1.145" }), dev({ host: "192.168.1.76" })]);
    expect(items).toHaveLength(1);
    expect(items[0].hosts).toEqual(["192.168.1.76", "192.168.1.145"]);
  });

  it("AE タイトル・ポート・TLS が違えば別の機器のまま", () => {
    const items = groupDiscovered([
      dev({}),
      dev({ aeTitle: "WS2", name: "WS2" }),
      dev({ port: 104 }),
      dev({ tls: true, tlsPort: 2762 }),
    ]);
    expect(items).toHaveLength(4);
  });

  it("空なら空", () => {
    expect(groupDiscovered([])).toEqual([]);
  });
});

describe("toRow", () => {
  it("平文の相手は、平文のポートで TLS なし", () => {
    const [item] = groupDiscovered([dev({})]);
    expect(toRow(item, "10.0.0.1")).toEqual({ aeTitle: "WS1", host: "10.0.0.1", port: "11112", tls: false });
  });

  it("TLS を受ける相手は、TLS のポートで TLS あり", () => {
    const [item] = groupDiscovered([dev({ tls: true, tlsPort: 2762 })]);
    expect(toRow(item, "10.0.0.1")).toEqual({ aeTitle: "WS1", host: "10.0.0.1", port: "2762", tls: true });
  });

  it("TLS と言いつつ TLS ポートが無いなら、平文として扱う", () => {
    const [item] = groupDiscovered([dev({ tls: true, tlsPort: 0 })]);
    expect(toRow(item, "10.0.0.1").tls).toBe(false);
  });
});

describe("addDiscovered", () => {
  const rows: AeRow[] = [{ aeTitle: "OLD", host: "1.1.1.1", port: "104", tls: false }];
  const [item] = groupDiscovered([dev({})]);

  it("同じ AE タイトルが無ければ確認なしで足す", () => {
    const confirm = vi.fn(() => true);
    const r = addDiscovered(rows, item, "10.0.0.1", confirm);
    expect(r.changed).toBe(true);
    expect(r.rows).toHaveLength(2);
    expect(confirm).not.toHaveBeenCalled();
    expect(rows).toHaveLength(1); // 元は変えない
  });

  it("同じ AE タイトルがあれば確認を出し、断られたら何も変えない", () => {
    const same: AeRow[] = [{ aeTitle: " WS1 ", host: "9.9.9.9", port: "104", tls: false }];
    const confirm = vi.fn(() => false);
    const r = addDiscovered(same, item, "10.0.0.1", confirm);
    expect(confirm).toHaveBeenCalledWith("WS1");
    expect(r.changed).toBe(false);
    expect(r.rows).toBe(same);
  });

  it("確認で承諾されたら、その行を置き換える（行は増えない）", () => {
    const same: AeRow[] = [{ aeTitle: "WS1", host: "9.9.9.9", port: "104", tls: false }, ...rows];
    const r = addDiscovered(same, item, "10.0.0.1", () => true);
    expect(r.changed).toBe(true);
    expect(r.rows).toHaveLength(2);
    expect(r.rows[0]).toEqual({ aeTitle: "WS1", host: "10.0.0.1", port: "11112", tls: false });
  });

  it("AE タイトルは大文字小文字を区別する", () => {
    expect(findSameAe([{ aeTitle: "ws1", host: "", port: "", tls: false }], "WS1")).toBe(-1);
  });
});
