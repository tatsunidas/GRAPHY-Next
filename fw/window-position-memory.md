# ウィンドウ表示位置の記憶（Window Position Memory）— 設計

> 対象: MainScreen / 2D Viewer / 3D Viewer / MPR / Slicer（＋Curved MPR）の各ウィンドウ。
> 前回表示していたスクリーン座標を記憶し、再オープン時に同じ位置へ復元する。
> **迷子防止**（画面構成変化・OutOfRange）を最優先。別ウィンドウでも使えるようインターフェース化する。
> 実装対象は standalone(Electron) のみ。web モードは対象外（ブラウザがタブ位置を管理する）。

関連: [`viewer-2d-architecture.md`](viewer-2d-architecture.md) / [`3d-viewer-design.md`](3d-viewer-design.md) / [`slicer-design.md`](slicer-design.md)

## 1. 前提（現状のウィンドウ構成）

すべて Electron の**別 BrowserWindow**で、ジオメトリはメインプロセスが所有する。
したがって本機能は **`desktop/main.js` 側＝メインプロセス完結**で実装でき、レンダラ/preload/IPC の追加は不要。

| 論理画面 | ハッシュキー | 生成関数 |
|---|---|---|
| MainScreen | （なし） | `createWindow()` |
| 2D Viewer | `2dviewer` | `createViewerWindow` |
| 3D Viewer | `viewer3d` | `createViewerWindow` |
| MPR | `mpr` | `createViewerWindow` |
| Slicer | `slicer` | `createViewerWindow` |
| Curved MPR | `curvedmpr` | `createViewerWindow` |
| QR | `qr` | `createViewerWindow`（対象外・従来どおり） |

## 2. 確定した設計判断

- **A. 対象ビューアはシングルトン化**: `2dviewer`（既存）に加え `viewer3d`/`mpr`/`slicer`/`curvedmpr` も
  「1画面キー=1ウィンドウ」に統一する。`graphy:open-viewer` の `else` 枝（毎回新規生成）を
  **画面キー別シングルトン Map** に置換。これで「キーごとに前回位置を1つ」記憶が一意に定まる。
- **B. 保存場所**: packaged = `<appData>/GRAPHY-Next/window-state.json`（アンインストーラが掃除する既存データ領域）。
  dev = `app.getPath('userData')/window-state.dev.json`（repo を汚さない）。
- **C. 最大化/フルスクリーン状態も記憶・復元する**。

## 3. インターフェース（`desktop/windowState.js`）

ウィンドウ非依存の **keeper ファクトリ**。任意の将来ウィンドウが key＋既定サイズを渡すだけで再利用できる。

```js
/**
 * @typedef WindowDefaults
 * @property {number}  width
 * @property {number}  height
 * @property {number}  [minVisible=48]        画面内に最低限見えているべき px（タイトルバーをつかめる量）
 * @property {boolean} [rememberMaximize=true]
 */

/**
 * @typedef WindowStateKeeper
 * @property {{x?:number,y?:number,width:number,height:number}} initialBounds  // new BrowserWindow に渡す（検証済み）
 * @property {boolean} isMaximized
 * @property {boolean} isFullScreen
 * @property {(win: import('electron').BrowserWindow) => void} track    // 追従開始（move/resize/close + display 変化）
 * @property {() => void} untrack
 */

/** @param {string} key @param {WindowDefaults} defaults @returns {WindowStateKeeper} */
function createWindowStateKeeper(key, defaults) { /* ... */ }

module.exports = { createWindowStateKeeper };
```

**利用パターン（どのウィンドウでも共通の数行）:**

```js
const keeper = createWindowStateKeeper("mpr", { width: 1400, height: 900 });
const win = new BrowserWindow({ ...keeper.initialBounds, show: false, webPreferences });
keeper.track(win);
win.once("ready-to-show", () => {
  if (keeper.isMaximized) win.maximize();
  if (keeper.isFullScreen) win.setFullScreen(true);
  win.show();
});
```

`initialBounds` をコンストラクタに渡すので初回描画から正しい位置に出る
（既存の `show:false` ＋ `ready-to-show` 表示パターンと整合）。

## 4. 永続化

- **アトミック書き込み**（tmp へ書いて `renameSync`）で破損を防ぐ。読み込み失敗/型不正時は握りつぶして既定へ。
- **書き込み契機**: `move`/`resize` を **debounce（~400ms）**＋`close` 時に確定。
  最大化/フルスクリーン中は `getNormalBounds()` で通常サイズを保存し、状態は `isMaximized`/`isFullScreen` フラグで別持ち。
- **形式**:

```json
{
  "version": 1,
  "windows": {
    "main":     { "x":100, "y":80, "width":1280, "height":800, "isMaximized":false, "isFullScreen":false, "displayId":2779098405 },
    "2dviewer": { "x":1450, "y":80, "width":1400, "height":900, "isMaximized":true,  "isFullScreen":false, "displayId":2528732444 }
  }
}
```

`displayId` は「保存時に載っていたディスプレイ」。復元時に同一 ID が生存していれば座標をそのまま尊重し、
消えている/変わっている場合のみ再クランプする判断材料に使う。

## 5. 迷子防止：検証ロジック（本機能の核）

### 5.1 復元時 `sanitize(saved, defaults)`

1. `saved` 無し/数値異常/NaN → **既定サイズのみ返し x,y は省略** → Electron がプライマリ中央に配置。
2. `screen.getDisplayMatching(rect)` で **最も重なるディスプレイ** `d` を選ぶ（全画面外なら最近傍/プライマリを返す）。
3. **サイズ上限**: `width/height` を `d.workArea`（タスクバー除外）に収まるよう縮小。
4. **全体可視チェック**: `rect` が全ディスプレイ `workArea` の**和集合に完全に収まっているか**を見る。
   1px でもはみ出していれば → `d.workArea` の内側へ **クランプ**（3 でサイズを縮めた後なので必ず収まる）。
   完全に収まっていれば座標を維持する（**2 画面に跨がった配置はそのまま**）。
5. 最大化復元は「検証済み通常 bounds を `setBounds` → `maximize()`」の順。

> **4 は当初「`minVisible`(48px) 以上見えていれば合格」だった。これが 2026-08-13 の
> 「画面外を復元する」不具合の原因**（下記）。つかめる量ではなく**全体**を見る。
> 判定は Electron 非依存の純関数 `desktop/windowGeometry.js` に切り出してあり、
> `desktop/windowGeometry.test.js`（`cd desktop && npm test` ／ CI の Desktop ジョブ）で守っている。

### 5.2 動作中の構成変更に追従

`screen` の `display-removed` / `display-added` / `display-metrics-changed` を購読し、
追従中の各ウィンドウの現在 bounds を再 `sanitize` → ずれていれば `setBounds` で**可視域へ引き戻す**。
実行中に外部モニタを抜いてもウィンドウが迷子にならない（ユーザー指摘の OutOfRange 対策）。

### 5.3 エッジケース対応表

| ケース | 挙動 |
|---|---|
| 初回起動（保存なし） | 既定サイズ・中央 |
| 保存先ディスプレイが消えた | 最近傍/プライマリの workArea 内へクランプ |
| 解像度が小さくなった | workArea に収まるよう縮小＋クランプ（**はみ出しが 1px でもあれば移動**） |
| 2 画面に跨がって置いてある | 和集合に収まっているので**そのまま維持** |
| 左モニタ由来の負座標が残存 | 可視域へシフト |
| JSON 破損/型不正 | 無視して既定 |
| ウィンドウが全モニタより大きい | workArea へ縮小（余白付き） |
| DPI 変更 | workArea は DIP 基準、`metrics-changed` で再クランプ |
| 動作中にモニタ抜去 | 生ウィンドウを即再クランプ |

## 6. 統合ポイント（`desktop/main.js`）

- `createWindow()`（main）… key=`"main"`、既定は既存 `cfg.window`。
- `createViewerWindow(screen)` … keeper 引数を受け取り、`initialBounds` をマージ＋`track`。
- `graphy:open-viewer` … `2dviewer`/`qr` の個別シングルトンを **画面キー→BrowserWindow の Map** に一般化
  （`viewer3d`/`mpr`/`slicer`/`curvedmpr` もシングルトン化。`closed` で Map から除去）。
- `screen` は app 準備完了後にのみ参照（`require('electron').screen`）。

## 7. スコープ外 / 注意

- **web モードは対象外**（ブラウザがタブ位置を管理）。desktopBridge は web で no-op のまま。
- QR は常駐前提の別運用のため今回は対象外（必要なら同 keeper で後追い可能）。
- 位置ファイルはユーザー領域のみ。プラグイン/DICOM データとは無関係で、削除されても既定に戻るだけ。

## 🟢 画面が小さくなったときに画面外を復元する（2026-08-13 実機で遭遇 → 修正済み）

**症状**: `make dev-desktop` 相当で起動しても、**ウィンドウがどこにも見えない**。プロセスは動いており
X 上にも存在するが、位置が画面の外。

**そのときの状態**:

| 保存されていた位置 | 当時の画面 |
|---|---|
| `main`: x=43, **y=682**, 1083×699 | **1600×900** |
| `2dviewer`: x=134, y=240, **1869×1090** | 〃 |
| `viewer3d`: x=336, y=295, 1379×920 | 〃 |
| `slicer`: x=580, y=270, 1400×900 | 〃 |

`main` は y=682 に高さ 699 なので下端が 1381。**保存済み 4 件すべてが画面に収まっていなかった**。
`~/.config/graphy-next-desktop/window-state.dev.json` を消して起動すると中央に出た。

**再現条件**: 大きなモニタで使った後、小さい画面（ノート単体・解像度変更・リモート接続）で
起動する。ウィンドウが見えないため、利用者からは**アプリが起動しないように見える**。

**原因**（当時の推測＝「`displayId` が同じままだと再クランプが効かない」は**外れ**）。
`sanitizeBounds` は `displayId` を一切見ておらず、毎回 workArea と突き合わせていた。
効いていなかったのは**合格の基準**のほう:

```js
// 旧: どこか 1 つの workArea と 48px 以上重なっていれば「見えている」として座標を維持
if (visW < minVisible || visH < minVisible) { /* ここで初めてクランプ */ }
```

`main` の x=43 / y=682 / 1083×699 は、1600×860 の workArea と **1083×178 重なっている**。
48px を大きく超えるので「十分見えている」と判定され、下端 521px のはみ出しは放置された。
`minVisible` は「タイトルバーをつかめるか」を見る基準で、**画面に収まっているかを見る基準ではなかった**。
`2dviewer` の 1869×1090 はサイズ縮小だけが効き、位置は同じ理由でそのまま。

**修正**: 判定を「**矩形全体が workArea の和集合に収まっているか**」に変えた（§5.1-4）。
はみ出していれば基準ディスプレイの workArea 内へ移動する。サイズ縮小は先に済ませてあるので必ず収まる。
2 画面に跨がった配置は和集合に収まるため、従来どおり維持される。

- 幾何判定を `desktop/windowGeometry.js`（electron 非依存の純関数）へ切り出し、`minVisible` は廃止。
- `desktop/windowGeometry.test.js` で 12 ケース（上記の実測値そのものを含む）。CI に Desktop ジョブを追加。
- `windowGeometry.js` は electron-builder の `files` にも追加した（**配布物での require 漏れは定番の事故**）。
