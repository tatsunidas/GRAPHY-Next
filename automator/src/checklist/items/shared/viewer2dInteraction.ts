import type { ChecklistItem } from "../../types.js";
import { openFirstSeriesInViewer } from "./helpers.js";
import { dragOnCanvasHost, moveOnCanvasHost } from "../../../common/pointerDrag.js";

interface ViewportGeometry {
  viewportId: string;
  imageId: string | null;
  camera: { parallelScale: number | null; position: number[] | null; focalPoint: number[] | null };
}
interface ViewportProperties {
  viewportId: string;
  colormapName: string | null;
  windowLevel: { center: number; width: number } | null;
}
interface GraphyDebugWindow {
  __graphyDebug?: {
    getViewportGeometry(): ViewportGeometry[];
    getViewportProperties(): ViewportProperties[];
  };
}

async function readGeometry(page: import("@playwright/test").Page) {
  return page.evaluate(() => (window as unknown as GraphyDebugWindow).__graphyDebug?.getViewportGeometry() ?? []);
}
async function readProperties(page: import("@playwright/test").Page) {
  return page.evaluate(() => (window as unknown as GraphyDebugWindow).__graphyDebug?.getViewportProperties() ?? []);
}

export const viewer2dInteractionItems: ChecklistItem[] = [
  {
    id: "10-viewer2d-core.item-01",
    title: "W/L（左ドラッグ）・Pan（中）・Zoom（右/ホイールはスライス送り）",
    category: "10-viewer2d-core",
    modes: ["desktop", "web"],
    requiresHuman: false,
    dependsOnFixtures: ["ct-basic"],
    async run(ctx) {
      const { driver, recorder } = ctx;
      const page = driver.page;
      await openFirstSeriesInViewer(page, recorder);

      // W/L: 左ドラッグ（button=0）
      // 注: Playwrightのpage.mouse.down/move/upはCDP経由でmouseイベントのみ合成し、対応する
      // pointerイベントが発火しないため、pointerdown/pointermoveを購読するCornerstone3D-tools
      // のツールが反応しない（実機で確認）。dragOnCanvasHostで生のPointerEventを直接dispatchする。
      const propsBefore = await readProperties(page);
      await dragOnCanvasHost(page, "viewer2d-canvas-host", 100, -100, 0);
      await page.waitForTimeout(300);
      const propsAfter = await readProperties(page);
      recorder.step("左ドラッグでW/Lを確認", { before: propsBefore[0]?.windowLevel, after: propsAfter[0]?.windowLevel });
      const wlChanged =
        propsBefore[0]?.windowLevel?.center !== propsAfter[0]?.windowLevel?.center ||
        propsBefore[0]?.windowLevel?.width !== propsAfter[0]?.windowLevel?.width;
      if (!wlChanged) {
        return { status: "fail" as const, error: "左ドラッグ後もW/Lが変化しませんでした" };
      }

      // Pan: 中ボタンドラッグ（button=1）
      const geoBeforePan = await readGeometry(page);
      await dragOnCanvasHost(page, "viewer2d-canvas-host", 60, 40, 1);
      await page.waitForTimeout(300);
      const geoAfterPan = await readGeometry(page);
      recorder.step("中ボタンドラッグでPanを確認", {
        before: geoBeforePan[0]?.camera.position,
        after: geoAfterPan[0]?.camera.position,
      });
      const panChanged = JSON.stringify(geoBeforePan[0]?.camera.position) !== JSON.stringify(geoAfterPan[0]?.camera.position);
      if (!panChanged) {
        return { status: "fail" as const, error: "中ボタンドラッグ後もカメラ位置(Pan)が変化しませんでした" };
      }

      // Zoom: 右ボタンドラッグ（button=2）
      const geoBeforeZoom = await readGeometry(page);
      await dragOnCanvasHost(page, "viewer2d-canvas-host", 0, -80, 2);
      await page.waitForTimeout(300);
      const geoAfterZoom = await readGeometry(page);
      recorder.step("右ボタンドラッグでZoomを確認", {
        before: geoBeforeZoom[0]?.camera.parallelScale,
        after: geoAfterZoom[0]?.camera.parallelScale,
      });
      const zoomChanged = geoBeforeZoom[0]?.camera.parallelScale !== geoAfterZoom[0]?.camera.parallelScale;
      if (!zoomChanged) {
        return { status: "fail" as const, error: "右ボタンドラッグ後もカメラのparallelScale(Zoom)が変化しませんでした" };
      }

      return { status: "pass" as const, notes: "左ドラッグ=W/L、中ドラッグ=Pan、右ドラッグ=Zoomをすべて確認" };
    },
  },
  {
    id: "10-viewer2d-core.item-02",
    title: "スライス送り（スライダー/矢印キー/Home-End/ホイール）・シネ再生",
    category: "10-viewer2d-core",
    modes: ["desktop", "web"],
    requiresHuman: false,
    dependsOnFixtures: ["ct-basic"],
    async run(ctx) {
      const { driver, recorder } = ctx;
      const page = driver.page;
      await openFirstSeriesInViewer(page, recorder);

      const imageIdOf = async () => (await readGeometry(page))[0]?.imageId;

      // スライダー
      const before1 = await imageIdOf();
      const slider = page.getByTestId("dim-slider-z");
      const max = await slider.getAttribute("max");
      await slider.fill(String(Math.max(1, Math.floor(Number(max ?? "0") / 2))));
      await page.waitForTimeout(300);
      const afterSlider = await imageIdOf();
      recorder.step("スライダー操作でスライスが変化することを確認", { before: before1, after: afterSlider });
      if (before1 === afterSlider) {
        return { status: "fail" as const, error: "スライダー操作後もスライスが変化しませんでした" };
      }

      // 矢印キー（root要素にフォーカスしてから）
      const root = page.getByTestId("series-viewer-root");
      await root.focus();
      const beforeArrow = await imageIdOf();
      await page.keyboard.press("ArrowDown");
      await page.waitForTimeout(300);
      const afterArrow = await imageIdOf();
      recorder.step("矢印キー(ArrowDown)でスライスが変化することを確認", { before: beforeArrow, after: afterArrow });
      if (beforeArrow === afterArrow) {
        return { status: "fail" as const, error: "ArrowDown後もスライスが変化しませんでした" };
      }

      // Home/End
      await page.keyboard.press("Home");
      await page.waitForTimeout(300);
      const atHome = await imageIdOf();
      await page.keyboard.press("End");
      await page.waitForTimeout(300);
      const atEnd = await imageIdOf();
      recorder.step("Home/Endで先頭/末尾スライスへ移動することを確認", { atHome, atEnd });
      if (atHome === atEnd) {
        return { status: "fail" as const, error: "Home/End操作後もスライスが同一です" };
      }

      // ホイール
      await page.keyboard.press("Home");
      await page.waitForTimeout(300);
      const beforeWheel = await imageIdOf();
      const canvas = page.getByTestId("viewer2d-canvas-host").locator("canvas");
      const box = await canvas.boundingBox();
      if (box) {
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.wheel(0, 120);
        await page.waitForTimeout(300);
      }
      const afterWheel = await imageIdOf();
      recorder.step("ホイール操作でスライスが変化することを確認", { before: beforeWheel, after: afterWheel });
      if (beforeWheel === afterWheel) {
        return { status: "fail" as const, error: "ホイール操作後もスライスが変化しませんでした" };
      }

      // シネ再生
      const cineBtn = page.getByTestId("cine-play-z");
      const beforeCine = await imageIdOf();
      await cineBtn.click();
      await page.waitForTimeout(1000);
      await cineBtn.click(); // 停止
      const afterCine = await imageIdOf();
      recorder.step("シネ再生でスライスが自動送りされることを確認", { before: beforeCine, after: afterCine });
      if (beforeCine === afterCine) {
        return { status: "fail" as const, error: "シネ再生後もスライスが変化しませんでした" };
      }

      return { status: "pass" as const, notes: "スライダー/矢印キー/Home-End/ホイール/シネ再生すべてでスライス変化を確認" };
    },
  },
  {
    id: "10-viewer2d-core.item-03",
    title: "Undo/Redo（表示状態、Mod+Z/Mod+Shift+Z）",
    category: "10-viewer2d-core",
    modes: ["desktop", "web"],
    requiresHuman: false,
    dependsOnFixtures: ["ct-basic"],
    async run(ctx) {
      const { driver, recorder } = ctx;
      const page = driver.page;
      await openFirstSeriesInViewer(page, recorder);

      const scaleOf = async () => (await readGeometry(page))[0]?.camera.parallelScale;

      const original = await scaleOf();
      await page.getByTestId("viewer-zoom-in-btn").click();
      // カメラ変更のキャプチャは350msデバウンス（Viewer2D.tsx scheduleCapture）。
      await page.waitForTimeout(600);
      const zoomed = await scaleOf();
      recorder.step("ズームボタンでカメラ状態を変化させる", { original, zoomed });
      if (original === zoomed) {
        return { status: "fail" as const, error: "ズームボタン後もparallelScaleが変化しませんでした" };
      }

      await page.keyboard.press("Control+z");
      await page.waitForTimeout(300);
      const afterUndo = await scaleOf();
      recorder.step("Ctrl+Zでズーム前に戻ることを確認", { afterUndo });
      if (afterUndo !== original) {
        return { status: "fail" as const, error: `Undo後のparallelScaleが元の値と一致しません: ${afterUndo} !== ${original}` };
      }

      await page.keyboard.press("Control+Shift+z");
      await page.waitForTimeout(300);
      const afterRedo = await scaleOf();
      recorder.step("Ctrl+Shift+Zでズーム後に戻ることを確認", { afterRedo });
      if (afterRedo !== zoomed) {
        return { status: "fail" as const, error: `Redo後のparallelScaleがズーム時の値と一致しません: ${afterRedo} !== ${zoomed}` };
      }

      return { status: "pass" as const, notes: "Ctrl+ZでUndo、Ctrl+Shift+ZでRedoが正しく機能することを確認" };
    },
  },
  {
    id: "10-viewer2d-core.item-04",
    title: "カーソル位置のHU/輝度値・Zoom%・W/L・座標のオーバーレイ表示",
    category: "10-viewer2d-core",
    modes: ["desktop", "web"],
    requiresHuman: false,
    dependsOnFixtures: ["ct-basic"],
    async run(ctx) {
      const { driver, recorder } = ctx;
      const page = driver.page;
      await openFirstSeriesInViewer(page, recorder);

      const canvas = page.getByTestId("viewer2d-canvas-host").locator("canvas");
      const box = await canvas.boundingBox();
      if (!box) {
        return { status: "fail" as const, error: "canvasのbounding boxが取得できません" };
      }

      const zoomText = await page.getByTestId("status-zoom").textContent();
      const wlText = await page.getByTestId("status-wl").textContent();
      recorder.step("Zoom%・W/Lのステータス表示を確認", { zoomText, wlText });
      if (!zoomText?.includes("%")) {
        return { status: "fail" as const, error: `Zoom%表示が不正です: ${zoomText}` };
      }
      if (!wlText?.includes("/")) {
        return { status: "fail" as const, error: `W/L表示が不正です: ${wlText}` };
      }

      await moveOnCanvasHost(page, "viewer2d-canvas-host", 0.3, 0.3);
      await page.waitForTimeout(200);
      const valueA = await page.getByTestId("status-value").textContent();
      const xyA = await page.getByTestId("status-xy").textContent();

      await moveOnCanvasHost(page, "viewer2d-canvas-host", 0.7, 0.7);
      await page.waitForTimeout(200);
      const valueB = await page.getByTestId("status-value").textContent();
      const xyB = await page.getByTestId("status-xy").textContent();

      recorder.step("カーソル移動でHU/輝度値・座標表示が変化することを確認", { valueA, xyA, valueB, xyB });
      if (xyA === xyB) {
        return { status: "fail" as const, error: `カーソル座標表示が2点間で変化しませんでした: ${xyA}` };
      }

      return { status: "pass" as const, notes: `Zoom=${zoomText}, W/L=${wlText}, 座標がカーソル移動で変化することを確認` };
    },
  },
  {
    id: "10-viewer2d-core.item-05",
    title: "DICOMテキスト四隅オーバーレイ・患者向きマーカー・スケールバー",
    category: "10-viewer2d-core",
    modes: ["desktop", "web"],
    requiresHuman: false,
    dependsOnFixtures: ["ct-basic"],
    async run(ctx) {
      const { driver, recorder } = ctx;
      const page = driver.page;
      await openFirstSeriesInViewer(page, recorder);

      const cornerTexts = page.locator('[data-testid^="corner-text-"]');
      const cornerCountBefore = await cornerTexts.count();
      const scaleBarVisible = await page.getByTestId("scale-bar").isVisible().catch(() => false);
      const orientationVisible = await page.getByTestId("orientation-marker-top").isVisible().catch(() => false);
      recorder.step("既定表示（DICOMテキスト四隅・スケールバー・向きマーカー）を確認", {
        cornerCountBefore,
        scaleBarVisible,
        orientationVisible,
      });
      if (cornerCountBefore < 1) {
        return { status: "fail" as const, error: "DICOMテキスト四隅オーバーレイが1件も表示されていません" };
      }
      if (!scaleBarVisible) {
        return { status: "fail" as const, error: "スケールバーが表示されていません" };
      }
      if (!orientationVisible) {
        return { status: "fail" as const, error: "患者向きマーカーが表示されていません" };
      }

      // テキストオーバーレイをOFFにすると消えることを確認（トグルが機能している証跡）。
      await page.getByTestId("overlay-check-text").uncheck();
      await page.waitForTimeout(200);
      const cornerCountAfter = await cornerTexts.count();
      recorder.step("テキストオーバーレイOFFで四隅表示が消えることを確認", { cornerCountAfter });
      if (cornerCountAfter !== 0) {
        return { status: "fail" as const, error: `テキストオーバーレイOFF後も${cornerCountAfter}件表示されています` };
      }

      return { status: "pass" as const, notes: "DICOMテキスト四隅・スケールバー・向きマーカーの表示とトグルを確認" };
    },
  },
  {
    id: "10-viewer2d-core.item-06",
    title: "GridView（列数指定の格子表示、マルチチャンネル/動画/単一枚は無効）",
    category: "10-viewer2d-core",
    modes: ["desktop", "web"],
    requiresHuman: false,
    dependsOnFixtures: ["ct-basic"],
    async run(ctx) {
      const { driver, recorder } = ctx;
      const page = driver.page;
      await openFirstSeriesInViewer(page, recorder);

      const select = page.getByTestId("grid-columns-select");
      await select.selectOption("2");
      await page.waitForTimeout(500);

      const cellCount = await page.locator('[data-testid="grid-cell"]').count();
      recorder.step("列数2を選択し、グリッドセル数を確認", { cellCount });
      if (cellCount < 2) {
        return { status: "fail" as const, error: `GridView選択後のセル数が不足しています: ${cellCount}` };
      }
      const canvasHostInGrid = await page.getByTestId("viewer2d-canvas-host").count();
      if (canvasHostInGrid < 2) {
        return { status: "fail" as const, error: `GridView中のcanvasホスト数が不足しています: ${canvasHostInGrid}` };
      }

      // Sliderへ戻す。
      await select.selectOption("0");
      await page.waitForTimeout(500);
      const cellCountAfterReset = await page.locator('[data-testid="grid-cell"]').count();
      const canvasHostAfterReset = await page.getByTestId("viewer2d-canvas-host").count();
      recorder.step("列数0(Slider)へ戻し、Slider表示に復帰することを確認", { cellCountAfterReset, canvasHostAfterReset });
      if (cellCountAfterReset !== 0 || canvasHostAfterReset !== 1) {
        return {
          status: "fail" as const,
          error: `SliderViewへの復帰が不完全です: cellCount=${cellCountAfterReset}, canvasHost=${canvasHostAfterReset}`,
        };
      }

      return { status: "pass" as const, notes: `GridView(2列, ${cellCount}セル)→SliderView復帰を確認` };
    },
  },
];
