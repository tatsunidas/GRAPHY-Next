/*
 * v0.3.5 操作ガイド: Slab MIP を HCC_001 で見せる。
 *
 * 2D は #3 C-A-P（造影 CT）。MPR・3D は #2 PRE LIVER を使う: #3 は 2 回の撮影（Acquisition 1 / 2）が
 * 同じ範囲に重なって入っており、MPR・3D は両方を 1 つのボリュームに混ぜるため縞が出る（2D は時相を分けて扱う）。
 * 本文は docs/release-guides/v0.3.5/guide.html。番号の順はそちらの説明の順と合わせる。
 */
import type { Scenario } from "../run.js";

const scenario: Scenario = async ({ selectSeries, openViewer, shot }) => {
  await selectSeries("HCC_001", "C-A-P");

  // 2D: 表示 → Slab MIP → MIP、ThickSlab を 15 mm に
  const v2d = await openViewer("2D Viewer", "2dviewer");
  await v2d.getByTestId("series-viewer-root").waitFor({ timeout: 60_000 });
  await v2d.waitForTimeout(2_500);
  await v2d.getByTestId("viewer2d-menu-view").click();
  await v2d.getByTestId("menu-slab-mip").first().hover();
  await v2d.getByTestId("menu-slab-mip").last().click();
  await v2d.getByTestId("thickslab-thickness").selectOption("15");
  await v2d.waitForTimeout(2_500);
  await shot(v2d, "2d", [
    v2d.getByTestId("viewer2d-menu-view"),
    v2d.getByTestId("thickslab-thickness"),
    v2d.getByTestId("thickslab-projection"),
  ]);

  // MPR: ヘッダの「スラブ」を MIP・15 mm に（3 面すべてに効く）
  await selectSeries("HCC_001", "PRE LIVER");
  const mpr = await openViewer("MPR Viewer", "mpr");
  await mpr.getByTestId("mpr-slab-projection").waitFor({ timeout: 60_000 });
  await mpr.waitForTimeout(6_000);
  // W/L はシリーズ既定だと白飛びするので腹部（40/350）に。ヘッダ先頭の select（testid 無し）。
  await mpr.locator("select").first().selectOption("abdomen");
  await mpr.getByTestId("mpr-slab-projection").selectOption("MIP");
  await mpr.getByTestId("mpr-slab-thickness").selectOption("15");
  await mpr.waitForTimeout(3_000);
  await shot(mpr, "mpr", [mpr.getByTestId("mpr-slab-projection"), mpr.getByTestId("mpr-slab-thickness")]);

  // 3D: モード Slab・MIP・20 mm・Coronal（前から）
  const v3d = await openViewer("3D Viewer", "viewer3d");
  await v3d.locator('[data-testid="viewer3d-mode-slab"]').waitFor({ timeout: 60_000 });
  await v3d.waitForTimeout(8_000);
  await v3d.locator('[data-testid="viewer3d-mode-slab"]').click();
  await v3d.getByTestId("viewer3d-slab-mip").click();
  await v3d.getByTestId("viewer3d-slab-thickness").selectOption("20");
  await v3d.getByTestId("viewer3d-snap-cor").click();
  await v3d.waitForTimeout(5_000);
  await shot(
    v3d,
    "3d",
    // 横に並ぶボタン（モード・向き）は上に、縦に詰まった部品は左に番号を出す。
    [
      { at: v3d.locator('[data-testid="viewer3d-mode-slab"]'), side: "top" },
      { at: v3d.getByTestId("viewer3d-slab-mip"), side: "left" },
      { at: v3d.getByTestId("viewer3d-slab-thickness"), side: "left" },
      { at: v3d.getByTestId("viewer3d-snap-cor"), side: "top" },
      { at: v3d.getByTestId("viewer3d-slab-spin"), side: "left" },
    ],
  );
};

export default scenario;
