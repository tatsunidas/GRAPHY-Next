import type { Page } from "@playwright/test";

export type Mode = "desktop" | "web";

export interface DriverPorts {
  http: number;
  scp: number;
  /** frontend dev server (Vite) のポート。desktop/web どちらも automator が自前起動する。 */
  vite: number;
}

export const DEFAULT_PORTS: DriverPorts = {
  http: 18090,
  scp: 18091,
  vite: 18093,
};

export interface Driver {
  readonly mode: Mode;
  readonly ports: DriverPorts;
  /** メイン画面(MainScreen)の Page。start() 完了後に利用可能。 */
  readonly page: Page;

  start(): Promise<void>;
  stop(): Promise<void>;

  /**
   * trigger() の実行によって新しく開く Page/BrowserWindow を待つ（2D Viewer 等の別ウィンドウ）。
   * desktop は Electron の新規 BrowserWindow イベント、web はブラウザの新規タブ/ウィンドウを待つ。
   */
  waitForNewPage(trigger: () => Promise<void>, urlPredicate: (url: string) => boolean, timeoutMs?: number): Promise<Page>;

  /**
   * ネイティブのファイル/フォルダ選択ダイアログ（Electron `dialog.showOpenDialog`）を、実際には
   * 表示せず指定パスを選択したことにして返すようモックする（SeriesExtractor の出力先選択等）。
   * Playwright は OS ネイティブダイアログを操作できないための回避策。desktop専用（Electron
   * メインプロセスを持つ）。web driver は未実装（呼び出し側は desktop 専用 item でのみ使うこと）。
   */
  mockNativeDirectoryPicker?(path: string): Promise<void>;
}
