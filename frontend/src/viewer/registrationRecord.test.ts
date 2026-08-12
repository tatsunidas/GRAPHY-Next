/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */

/**
 * 位置合わせ結果の保存形式と指紋照合のテスト。
 *
 * <p>守りたいのは 1 点: **入力が変わっていたら、黙って変換を当てない**こと。
 * 同じ SeriesInstanceUID でも中身が入れ替わることがあり（取り込み直し・匿名化・
 * 別 PACS からの再取得）、気付かずに当てると「もっともらしいが間違った重ね合わせ」が
 * 復元される。画面上は完成して見えるので、最も気付きにくい。
 */
import { describe, it, expect } from "vitest";
import {
  seriesFingerprint, findRecord, upsertRecord, removeRecord, acceptRecordForCurrentInput,
  encodeFloat32, decodeFloat32, REGISTRATION_RECORD_VERSION,
  type RegistrationRecord, type SeriesFingerprintInput, type SeriesRef,
} from "./registrationRecord";
import { ZERO_ADJUST } from "./regTransform";

const BASE: SeriesFingerprintInput = {
  seriesInstanceUid: "1.2.3.4",
  sliceCount: 176,
  imageWidth: 256,
  imageHeight: 256,
  pixelSpacingCol: 1,
  pixelSpacingRow: 1,
  iop: [1, 0, 0, 0, 1, 0],
  firstIpp: [-127.5, -127.5, -87.5],
  lastIpp: [-127.5, -127.5, 87.5],
};

function ref(uid: string, fingerprint: string, c = 0, t = 0): SeriesRef {
  return { studyInstanceUid: "1.2.3", seriesInstanceUid: uid, c, t, fingerprint };
}

function record(fixed: SeriesRef, moving: SeriesRef, savedAt = "2026-08-09T00:00:00Z"): RegistrationRecord {
  return {
    version: REGISTRATION_RECORD_VERSION,
    savedAt,
    fixed,
    moving,
    registration: null,
    adjust: { ...ZERO_ADJUST, tx: 3 },
  };
}

describe("seriesFingerprint", () => {
  it("同じ入力なら同じ指紋", () => {
    expect(seriesFingerprint(BASE)).toBe(seriesFingerprint({ ...BASE }));
  });

  it("★枚数・画素寸法・IOP・端の IPP が変われば指紋も変わる", () => {
    const base = seriesFingerprint(BASE);
    expect(seriesFingerprint({ ...BASE, sliceCount: 175 })).not.toBe(base);
    expect(seriesFingerprint({ ...BASE, imageWidth: 512 })).not.toBe(base);
    expect(seriesFingerprint({ ...BASE, pixelSpacingCol: 0.98 })).not.toBe(base);
    expect(seriesFingerprint({ ...BASE, iop: [0, 1, 0, 0, 0, 1] })).not.toBe(base);
    expect(seriesFingerprint({ ...BASE, firstIpp: [-127.5, -127.5, -87.6] })).not.toBe(base);
    expect(seriesFingerprint({ ...BASE, lastIpp: null })).not.toBe(base);
  });

  it("UID が違えば指紋も違う", () => {
    expect(seriesFingerprint({ ...BASE, seriesInstanceUid: "9.9.9" })).not.toBe(seriesFingerprint(BASE));
  });

  it("最下位ビットの揺れでは変わらない（丸めてから混ぜている）", () => {
    // 同じ幾何を別経路で計算すると末尾が揺れることがある。それで復元が拒否されては困る。
    expect(seriesFingerprint({ ...BASE, pixelSpacingCol: 1 + 1e-9 })).toBe(seriesFingerprint(BASE));
  });
});

describe("findRecord", () => {
  const f = ref("F", "fa"), m = ref("M", "ma");

  it("記録が無ければ none", () => {
    expect(findRecord({ version: 1, records: [] }, f, m).status).toBe("none");
    expect(findRecord(null, f, m).status).toBe("none");
  });

  it("指紋が一致すれば ok", () => {
    const doc = { version: 1, records: [record(f, m)] };
    const r = findRecord(doc, f, m);
    expect(r.status).toBe("ok");
  });

  it("★指紋が違えば stale（適用してはいけない）", () => {
    const doc = { version: 1, records: [record(f, m)] };
    const r = findRecord(doc, ref("F", "別の指紋"), m);
    expect(r.status).toBe("stale");
    if (r.status === "stale") expect(r.changed).toEqual(["fixed"]);
  });

  it("両方変わっていれば両方を報告する", () => {
    const doc = { version: 1, records: [record(f, m)] };
    const r = findRecord(doc, ref("F", "x"), ref("M", "y"));
    if (r.status === "stale") expect(r.changed).toEqual(["fixed", "moving"]);
    else throw new Error("stale であるべき");
  });

  it("C/T が違う記録は別物として扱う", () => {
    const doc = { version: 1, records: [record(ref("F", "fa", 0, 0), ref("M", "ma", 0, 0))] };
    expect(findRecord(doc, ref("F", "fa", 1, 0), ref("M", "ma", 0, 0)).status).toBe("none");
  });

  it("同じ組が複数あれば最も新しいものを採る", () => {
    const doc = {
      version: 1,
      records: [
        record(f, m, "2026-08-01T00:00:00Z"),
        record(f, m, "2026-08-09T12:00:00Z"),
      ],
    };
    const r = findRecord(doc, f, m);
    if (r.status === "ok") expect(r.record.savedAt).toBe("2026-08-09T12:00:00Z");
    else throw new Error("ok であるべき");
  });
});

describe("upsert / remove", () => {
  const f = ref("F", "fa"), m = ref("M", "ma");

  it("同じ組は置き換える（積み上がらない）", () => {
    let doc = upsertRecord(null, record(f, m, "2026-08-01T00:00:00Z"));
    doc = upsertRecord(doc, record(f, m, "2026-08-09T00:00:00Z"));
    expect(doc.records.length).toBe(1);
    expect(doc.records[0].savedAt).toBe("2026-08-09T00:00:00Z");
  });

  it("違う組は並存する", () => {
    let doc = upsertRecord(null, record(f, m));
    doc = upsertRecord(doc, record(ref("F2", "fb"), m));
    expect(doc.records.length).toBe(2);
  });

  it("削除できる", () => {
    let doc = upsertRecord(null, record(f, m));
    doc = removeRecord(doc, f, m);
    expect(doc.records.length).toBe(0);
  });
});

describe("変位場の直列化", () => {
  it("往復して同じ値になる", () => {
    const a = new Float32Array([1.5, -2.25, 0, 1e-7, 12345.75]);
    const back = decodeFloat32(encodeFloat32(a));
    expect(Array.from(back)).toEqual(Array.from(a));
  });

  it("大きい配列でも往復できる（分割して符号化している）", () => {
    const a = new Float32Array(200000);
    for (let i = 0; i < a.length; i++) a[i] = (i % 97) * 0.25;
    const back = decodeFloat32(encodeFloat32(a));
    expect(back.length).toBe(a.length);
    expect(back[123456]).toBe(a[123456]);
  });
});

describe("acceptRecordForCurrentInput — 指紋不一致のまま承認したとき", () => {
  const oldFixed = ref("F", "fp-fixed-old");
  const oldMoving = ref("M", "fp-moving-old");
  const newFixed = ref("F", "fp-fixed-new");
  const newMoving = ref("M", "fp-moving-new");
  const NOW = "2026-08-09T12:00:00Z";

  it("現在の入力に結び付け直すので、次に開いても stale にならない", () => {
    // ★ これが目的。表示だけ戻して保存しないと、開き直すたびに同じ判断を求められる。
    const accepted = acceptRecordForCurrentInput(
      record(oldFixed, oldMoving), newFixed, newMoving, ["moving"], NOW,
    );
    const doc = upsertRecord(null, accepted);
    expect(findRecord(doc, newFixed, newMoving).status).toBe("ok");
  });

  it("承認前の指紋を残す（変換がどの入力で計算されたかを追えるように）", () => {
    // ★ 印を付けずに指紋だけ書き換えると、記録は「最初から合っていた」ようにしか
    //    見えなくなる。変換が別の入力に対して計算された事実は、ここにしか残らない。
    const accepted = acceptRecordForCurrentInput(
      record(oldFixed, oldMoving), newFixed, newMoving, ["moving"], NOW,
    );
    expect(accepted.acceptedDespiteMismatch).toEqual({
      at: NOW,
      changed: ["moving"],
      computedFor: { fixed: "fp-fixed-old", moving: "fp-moving-old" },
    });
  });

  it("変換と手動調整は変えない（承認は結び付け先を変えるだけ）", () => {
    const original = record(oldFixed, oldMoving);
    const accepted = acceptRecordForCurrentInput(
      original, newFixed, newMoving, ["fixed", "moving"], NOW,
    );
    expect(accepted.registration).toBe(original.registration);
    expect(accepted.adjust).toEqual(original.adjust);
  });

  it("両方が変わっていたら両方を記録する", () => {
    const accepted = acceptRecordForCurrentInput(
      record(oldFixed, oldMoving), newFixed, newMoving, ["fixed", "moving"], NOW,
    );
    expect(accepted.acceptedDespiteMismatch?.changed).toEqual(["fixed", "moving"]);
  });
});
