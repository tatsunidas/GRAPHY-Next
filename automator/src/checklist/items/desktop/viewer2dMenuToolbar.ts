import type { ChecklistItem, RunContext } from "../../types.js";
import { openFirstSeriesInViewer } from "../shared/helpers.js";
import type { Page } from "@playwright/test";

interface ViewportProperties {
  viewportId: string;
  colormapName: string | null;
  windowLevel: { center: number; width: number } | null;
}
interface GraphyDebugWindow {
  __graphyDebug?: { getViewportProperties(): ViewportProperties[] };
}

/**
 * MainScreen で先頭シリーズを選択した状態から、別ウィンドウの2D Viewer画面（Viewer2DScreen）を開く。
 * `handleOpenViewer("2d")` は selectedStudy/selectedSeries を localStorage 経由で新ウィンドウへ渡すため、
 * 事前に study-row/series-row のクリックで選択状態を作っておく必要がある（openFirstSeriesInViewer が兼ねる）。
 */
async function openViewer2DScreen(ctx: RunContext): Promise<Page> {
  const { driver, recorder } = ctx;
  const mainPage = driver.page;
  await openFirstSeriesInViewer(mainPage, recorder);

  const viewerPage = await driver.waitForNewPage(
    () => mainPage.getByTestId("viewer2d-toolbar-button").click(),
    (url) => url.includes("2dviewer"),
  );
  recorder.step("ツールバーの2Dボタンから別ウィンドウを開く");

  await viewerPage.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 15_000 });
  await viewerPage.waitForTimeout(1500);
  recorder.step("2D Viewerウィンドウにシリーズがロードされたことを確認");
  return viewerPage;
}

export const viewer2dMenuToolbarItems: ChecklistItem[] = [
  {
    id: "12-viewer2d-menu-toolbar.item-01",
    title: "Layoutサブメニュー（プリセット＋任意行×列）",
    category: "12-viewer2d-menu-toolbar",
    // 別ウィンドウ(Electron BrowserWindow)を開くdesktop固有の導線(d.openViewer IPC)に依存するためdesktopのみ。
    modes: ["desktop"],
    requiresHuman: false,
    dependsOnFixtures: ["ct-basic"],
    async run(ctx) {
      const { recorder } = ctx;
      const viewerPage = await openViewer2DScreen(ctx);

      await viewerPage.getByTestId("viewer2d-menu-view").click();
      await viewerPage.getByTestId("viewer2d-menu-layout").hover();
      await viewerPage.getByTestId("layout-preset-2x2").waitFor({ state: "visible", timeout: 10_000 });
      await viewerPage.getByTestId("layout-preset-2x2").click();
      recorder.step("View > Layout > 2 × 2 を選択");

      const grid = viewerPage.getByTestId("viewer2d-tile-grid");
      const rows = await grid.getAttribute("data-grid-rows");
      const cols = await grid.getAttribute("data-grid-cols");
      recorder.step("viewer2d-tile-grid の data-grid-rows/cols を確認", { rows, cols });

      await viewerPage.close().catch(() => {});

      if (rows !== "2" || cols !== "2") {
        return { status: "fail" as const, error: `レイアウト適用後の行×列が期待値と一致しません: rows=${rows}, cols=${cols}` };
      }
      return { status: "pass" as const, notes: "2×2レイアウトを適用" };
    },
  },
  {
    id: "12-viewer2d-menu-toolbar.item-03",
    title: "W/Lプリセット（脳/肺/縦隔/骨/腹部等）の適用・編集/追加/削除・永続化",
    category: "12-viewer2d-menu-toolbar",
    modes: ["desktop"],
    requiresHuman: false,
    dependsOnFixtures: ["ct-basic"],
    async run(ctx) {
      const { recorder } = ctx;
      const viewerPage = await openViewer2DScreen(ctx);

      await viewerPage.getByTestId("viewer2d-menu-image").click();
      await viewerPage.getByTestId("viewer2d-menu-wl-preset").hover();
      await viewerPage.getByTestId("wl-preset-lung").waitFor({ state: "visible", timeout: 10_000 });
      await viewerPage.getByTestId("wl-preset-lung").click();
      recorder.step("Image > W/Lプリセット > 肺 を選択（center=-600, width=1500）");

      await viewerPage.waitForTimeout(500);
      const props = await viewerPage.evaluate(
        () => (window as unknown as GraphyDebugWindow).__graphyDebug?.getViewportProperties() ?? [],
      );
      recorder.step("window.__graphyDebug.getViewportProperties() を評価", { props });

      await viewerPage.close().catch(() => {});

      const applied = props.some((p) => p.windowLevel?.center === -600 && p.windowLevel?.width === 1500);
      if (!applied) {
        return { status: "fail" as const, error: `適用後のW/Lが期待値と一致しません: ${JSON.stringify(props)}` };
      }
      return { status: "pass" as const, notes: "W/Lプリセット「肺」を適用" };
    },
  },
];
