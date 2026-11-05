/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * ROI の復元先の解決（`roiRestore.resolveImageId`）。
 *
 * <p>🚨 守りたいのは 1 点: **マルチフレームは「1 SOP = 1 画像」ではない。**
 * XA の 1 ランは数十〜数百フレームが同じ SOP Instance UID を持つ。SOP だけで解くと
 * **必ず 1 フレーム目**に戻り、実際に描いたフレームには何も出ない
 * （実機で「解析したフレームには無く、1 フレーム目に出る」として報告された）。
 */
import { metaData } from "@cornerstonejs/core";
import { describe, expect, it } from "vitest";
import { createValueStack, registerPluginVolumeLoader, releaseValueStack } from "../plugins/pluginVolumeScheme";
import { resolveImageId, sopOfImageId } from "./roiRestore";

const xa = (frame: number) => `wadouri:http://localhost:1/instances/1.2.3/file&frame=${frame + 1}`;

/** XA 1 ラン（同じ SOP の 5 フレーム）。 */
const MULTI = new Map<string, string[]>([["1.2.3", [xa(0), xa(1), xa(2), xa(3), xa(4)]]]);

/** 単一フレームのシリーズ（SOP ごとに 1 枚）。 */
const SINGLE = new Map<string, string[]>([
  ["sop-a", ["wadouri:http://localhost:1/instances/sop-a/file"]],
  ["sop-b", ["wadouri:http://localhost:1/instances/sop-b/file"]],
]);

describe("resolveImageId", () => {
  it("🔴 マルチフレームは保存されたフレームへ戻る（1 フレーム目に落ちない）", () => {
    expect(resolveImageId(MULTI, "1.2.3", 3)).toBe(xa(3));
    expect(resolveImageId(MULTI, "1.2.3", 0)).toBe(xa(0));
  });

  it("配列の添字ではなく imageId 自身の frame= と突き合わせる", () => {
    // 並びが逆でも、フレーム 1 は frame=2 の imageId に解決する。
    const reversed = new Map<string, string[]>([["1.2.3", [xa(4), xa(3), xa(2), xa(1), xa(0)]]]);
    expect(resolveImageId(reversed, "1.2.3", 1)).toBe(xa(1));
  });

  it("スタックに無い SOP は null（別シリーズの ROI を載せない）", () => {
    expect(resolveImageId(MULTI, "9.9.9", 0)).toBeNull();
    expect(resolveImageId(new Map(), "1.2.3", 0)).toBeNull();
  });

  it("単一フレームはフレーム番号を見ない（古い保存も新しい保存も同じに戻る）", () => {
    expect(resolveImageId(SINGLE, "sop-a")).toBe(SINGLE.get("sop-a")![0]);
    expect(resolveImageId(SINGLE, "sop-a", 7)).toBe(SINGLE.get("sop-a")![0]);
  });

  it("フレームを記録していなかった頃の保存は先頭へ（黙って捨てない）", () => {
    // 情報が無いので正しい復元は原理的に不可能。捨てるより 1 枚目に出すほうが、
    // 利用者が「違う所にある」と気付いて描き直せる。
    expect(resolveImageId(MULTI, "1.2.3")).toBe(xa(0));
  });

  it("保存されたフレームがスタックに無ければ先頭へ（ラン数が減った等）", () => {
    expect(resolveImageId(MULTI, "1.2.3", 99)).toBe(xa(0));
  });
});

describe("sopOfImageId: プラグインが計算した値の画像（一時シリーズ）は SOP を持たない", () => {
  // 元の DWI のスライスを模したメタデータ（SOP を返す）。
  const NATIVE = ["native:roi0", "native:roi1"];
  metaData.addProvider(
    (type: string, imageId: string) =>
      NATIVE.includes(imageId) && type === "sopCommonModule" ? { sopInstanceUID: `1.2.DWI.${imageId}` } : undefined,
    5,
  );
  registerPluginVolumeLoader();

  it("通常の画像は従来どおりメタデータから SOP を引く（正例）", () => {
    expect(sopOfImageId("native:roi0")).toBe("1.2.DWI.native:roi0");
  });

  it("🔴 プラグインの値の画像は null。元の DWI の SOP を名乗って保存されるのを防ぐ（負例）", () => {
    const stack = createValueStack({
      pluginId: "p", data: new Float32Array(2 * 2 * 2), dims: [2, 2, 2], nativeIds: NATIVE,
      window: { center: 1, width: 2 }, transient: { seriesUid: "2.25.9", description: "x", c: 0 },
    });
    // 委譲されたままなら、メタデータは元の DWI の SOP を返してしまう（これが事故の経路）。
    expect(sopOfImageId(stack.imageIds[0])).toBeNull();
    // mountViewport 用（委譲するセッション）でも同じ。こちらは annotation を持たないが、念のため塞ぐ。
    const plain = createValueStack({ pluginId: "p", data: new Float32Array(2 * 2 * 2), dims: [2, 2, 2], nativeIds: NATIVE });
    expect(sopOfImageId(plain.imageIds[1])).toBeNull();
    releaseValueStack(stack.token);
    releaseValueStack(plain.token);
  });
});
