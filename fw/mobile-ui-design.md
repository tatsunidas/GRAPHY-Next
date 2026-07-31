# モバイル UI（スマホ / タブレット向け単画面ビューア）設計

> 作成日: 2026-07-30
> 対象: **web モードのみ**（ブラウザ経由・外部 PACS via DICOMweb/BFF）。standalone(Electron) は対象外。
> 位置づけ: 既存のデスクトップ UI を残したまま、**狭幅・タッチ端末向けの別シェルを追加**する。
> 前提: [`volume-memory-guard.md`](volume-memory-guard.md)（3D/MPR を安全に開くための必須前提）
> 参照: [`ui-architecture.md`](ui-architecture.md)、[`viewer-2d-architecture.md`](viewer-2d-architecture.md)、
>       [`report-design.md`](report-design.md)、[`fusion-overlay-design.md`](fusion-overlay-design.md)
> ⚠️ 3D / MPR に触るなら [`cornerstone-3d-geometry-caveat.md`](cornerstone-3d-geometry-caveat.md) を先に読む。

## 1. 目的と方針

スマホ・タブレットからアクセスしたとき、**自動でモバイル向け単画面 UI に切り替える**。用途は
**参照**（カンファレンス／患者説明／出先での確認）であり、読影ワークステーションの置き換えではない。

方針は「**既存 UI をレスポンシブ化する**」ではなく「**モバイル専用シェルを追加する**」。理由:

- `frontend/src` に `.css` ファイルが 1 つも無く、スタイルは inline style オブジェクト **726 箇所**。
  `@media` クエリは **0 件**。**共有スタイルの上書きでモバイル化する余地がない**。
- デスクトップ UI は「1 画面 = 1 ウィンドウ」前提（§3.2）で、狭幅への縮退では成立しない。
- 既存 UI を触らないので、デスクトップの挙動を壊すリスクがない。

**画像描画のコア（`viewer/Viewer2D.tsx`・`viewer/mpr.ts`・`viewer/vtkVolumeView.ts`）と
API 層（`api.ts` / `http.ts`）は再利用する。** 新規に書くのはシェル（ナビゲーション・パネル配置・
ツールバー）と、モバイル向けに作り替える一部ダイアログのみ。

> 📌 **`frontend/portable/` は土台にしない。** vanilla TS で軽量という利点はあるが、
> ビルド時 CSP に `connect-src` が無く（`vite.portable.config.ts:26-47`）**サーバへ接続しない
> 設計**なので、PACS からデータを取る用途に使えない。UI の簡潔さは参考にするが、コードは流用しない。

## 2. 対応範囲

| 機能 | 対応 | 備考 |
|---|---|---|
| 2D Viewer（参照） | ✅ | web モード実装済み |
| 3D Viewer（参照） | ✅ | メモリガード必須（`volume-memory-guard.md`） |
| MPR（参照） | ✅ | **計測は載せない**（§2.2） |
| W/L・Zoom・Pan・Rotation・リセット | ✅ | 既にボタン化済み（§3.4） |
| ROI の簡単な計測 | ✅ | **2D と 3D のみ**。2D は `MEASURE_TOOLS`（`viewer/Viewer2D.tsx:106-113`）の 6 種 = 長さ / 二方向 / 角度 / 楕円 ROI / 矩形 ROI / Probe |
| Fusion 表示 | ✅ | **2D のみ**（§4.3） |
| レポート | ✅ | 専用エディタ＋STOW-RS 書き戻しが前提（§5） |
| Slicer | ❌ 非対応 | |
| 新規シリーズ作成 | ❌ 行わない | |
| マスク作成（セグメンテーション） | ❌ 行わない | |
| Analysis（ヒストグラム / Texture / ImageJ） | ❌ 不要 | |
| プラグイン | ❌ 不要 | |

### 2.1 除外が成立する根拠（依存関係の確認済み事実）

| 除外対象 | 切り離しやすさ | 根拠 |
|---|---|---|
| Slicer | ◎ | `viewer/slicer.ts` の import 元は `slicer/SlicerScreen.tsx:34` と `viewer3d/CenterlineDialog.tsx:56` の 2 つだけ。**2D / 3D / MPR 本体は依存していない** |
| 新規シリーズ作成 | ◎ | `POST /api/series/derived` の呼び出し元 5 箇所を持ち込まないだけ。API 自体は残す |
| マスク作成 | ◎ | ツール定義が既に分離（`viewer/Viewer2D.tsx:106` が `MEASURE_TOOLS`、`:115` の `PRIMARY_TOOLS` 内にマスク系 Brush/Wand/LevelSet が同居）。**labelmap は遅延生成**で、`ensureStackSegmentation` は `if (isBrush \|\| isEraser \|\| isWand \|\| isLevelSet)` のときだけ呼ばれる（`:1555-1557`）＝計測ツールのみなら**セグメンテーションのメモリ消費は 0** |
| Analysis | ◎ | すべて葉コンポーネント。⚠️ ただし `viewer/histogram.ts` は **W/L 調整ダイアログ（`viewer2d/WwWlAdjustDialog.tsx:16`）も使うのでモジュール自体は残す** |
| プラグイン | ◎ | 機構は `frontend/src/plugins/` の 4 ファイルに閉じ、注入点は `mainscreen/MenuBar.tsx:51-58` と `viewer2d/Viewer2DMenuBar.tsx:224-232` の 2 箇所のみ。**しかも起動時ロードではなく遅延**（`usePluginMenu` の副作用）なので、モバイル用メニューを別に書けば `/api/plugins` へのリクエストすら発生しない |

> `viewer/reslice.ts` は Curved MPR / 中心線 / 内視鏡が共有する基盤なので**落とせない**。
> `viewer/orthoMpr.ts` は import 元が `slicer/SlicerScreen.tsx:50` のみで Slicer と一緒に落とせる。

### 2.2 MPR に計測を載せない理由

`viewer/mpr.ts:299-313` は **Crosshairs / WindowLevel / Pan / StackScroll のみ**で、計測ツールが
1 つも登録されていない。MPR 計測はデスクトップ側にも存在しない機能であり、モバイル対応の
スコープで新規実装するのは筋が悪い。**MPR は参照専用**とする（2026-07-30 決定）。

一方 3D の計測は cornerstone ではなく自前オーバーレイ（`viewer3d/Viewer3DMeasureOverlay.tsx`）で、
既に `touchAction: "none"` ＋ Pointer Events 実装（`:233-234,286`）なので**指でそのまま動く見込み**。

## 3. 現状の障壁と対処

### 3.1 デバイス判定軸の新設

**既存の `standalone` / `web` は流用できない。** これは Spring プロファイル由来（`StatusController.java:39`）
の「**データ源**」を表す軸であり、デバイスを表さない。

新規に `useDeviceClass()` フックを作る。判定は幅とポインタ精度の両方を見る:

```
matchMedia("(max-width: 768px)")     → phone
matchMedia("(max-width: 1024px)")    → tablet
matchMedia("(pointer: coarse)")      → タッチ主体
```

- 現状 `matchMedia` の使用は `settings/MonitorQcPanel.tsx:164`（モニタ診断用）の 1 箇所のみ。
  レイアウト分岐の先例は無いので新設になる。
- **手動切り替えを必ず用意する**（自動判定を上書きして「デスクトップ UI で開く」／逆も）。
  判定ミスや、タブレットで通常 UI を使いたいケースがある。選択は localStorage に保存。
- **端末クラスで機能を出し分けはしない。** 3D/MPR の可否はメモリガード（`volume-memory-guard.md`）が
  必要量から判断する。端末で線引きすると、高性能タブレットで無用に制限され、低性能端末では
  結局落ちる。

**実装（2026-07-31 / M1）** — `frontend/src/mobile/useDeviceClass.ts`

| 端末クラス | 幅 | 自動判定 | 理由 |
|---|---|---|---|
| phone | ≤768px | **常にモバイル** | この幅にデスクトップ UI は入らない |
| tablet | ≤1024px | **`pointer: coarse` のときだけ**モバイル | 1024px 以下に縮めただけのデスクトップブラウザを巻き込まない |
| desktop | >1024px | 常にデスクトップ | **タッチ対応ノート PC を巻き込まない**（`coarsePointer` だけで判定すると誤爆する） |

- 純関数（`classifyDevice` / `autoUiMode` / `resolveUiMode` / `normalizeOverride`）と React フックを
  同じファイルに分けて置き、純関数側だけを vitest で固定した（`useDeviceClass.test.ts`）。
- 手動切替の保存キーは `graphy.ui.modeOverride`（`auto` は保存せず削除）。
  `storage` イベントも購読しているので、別タブでの切替が反映される。
- `matchMedia` の購読は `addEventListener` と `addListener` の両対応
  （Safari 13 以前は後者のみ。iOS を対象にするため）。
- ⚠️ **フックは `status.mode` を見ない。** モバイルシェルを出してよいのは web モードだけだが、
  それは呼び出し側（`App.tsx`）の判断。フックの責務はあくまで端末クラス。

### 3.2 マルチウィンドウ → 同一タブ hash 遷移

現状すべてのビューアは別ウィンドウで開く。web モードでは
`window.open(pathname + "#2dviewer", "graphy-2dviewer")` になり、**モバイルブラウザでは新規タブ扱い＋
ポップアップブロック対象**で、iOS Safari では名前付き target の再利用も不安定。

**対処は構造的に軽い**:

- ルータは既に hash ベースの単純分岐（`App.tsx:37-44,127-152`）。**画面を 1 つ足すのは容易**。
- ディスパッチは `mainscreen/MainScreen.tsx:87-157` の `handleOpenViewer` **1 関数に集約済み**。
  モバイルでは `window.open` の代わりに `window.location.hash = "..."` にする。
- **コンテキスト受け渡しの `localStorage`（`graphy-viewer-ctx` 等 4 系統）は同一タブでもそのまま
  機能する**ので、この仕組みは変更不要。
- 併せて「戻る」導線が必要。ブラウザの戻るで自然に効くよう、hash 遷移は `history.pushState` 相当に
  なる形（`location.hash` 代入）を使う。
- マスクのウィンドウ間共有 `BroadcastChannel`（`viewer/maskBridge.ts:5-18`）は単画面では不要。
  マスク非対応方針と整合する。

**画面遷移**（単画面ナビゲーションスタック）:

```
検索 → スタディ一覧 → シリーズ一覧 → ビューア（2D / 3D / MPR をタブ切替）
                                        └→ レポート（全画面）
```

**実装（2026-07-31 / M1）** — `frontend/src/mobile/mobileRoute.ts` ＋ `MobileScreen.tsx`

- ルートは `#mobile` / `#mobile/series` / `#mobile/viewer` / `#mobile/report`。
  `App.tsx` の既存 hash ルータ（`#2dviewer` 等）と同じ名前空間に、`mobile` を親にして置いた。
  `isMobileRoute` は `#mobilex` のような紛らわしい名前を弾く（前方一致だけにしない）。
- 未知のサブパスは root に倒す（壊れた URL で白画面にしない）。
- 前進は `location.hash` 代入（履歴に積まれる）、戻るは `history.back()` を優先。
  直接 URL で深い画面に入った場合だけ親へ `location.replace`。
- 🚧 **`MOBILE_SHELL_READY = false` の間は自動振り分けを行わない。**
  手動切替（System メニューの「モバイル UI に切り替え」。web モードのみ表示）は `false` でも動く。
  **残るゲートは実機確認（M9）だけ**（M1〜M4 は 2026-07-31 に実装済み）。
  自動振り分けを有効にすると**公開デモを含む web モードの全スマホ利用者が対象**になり、
  最初の実機テストが本番の利用者になってしまう。iOS Safari / Android Chrome / iPad で一度
  確認してからこの 1 行を `true` にする。
  （当初は「M3 完了時に true」→「M4 完了後」と書いていたが、いずれも実機確認前なので上記に改めた。）
- 自動振り分けの条件は「web モード ＋ メインウィンドウ ＋ IID 起動でない」。
  IID 起動は `#2dviewer` へ遷移するので、取り合いになるのを避ける。
  遷移は `location.replace` で行い履歴を汚さない（「戻る」でデスクトップ UI に戻れてしまうのを防ぐ）。
- シェルの高さは `100vh` でも `100dvh` でもなく **`position: fixed; inset: 0`**。
  `100vh` は iOS Safari のアドレスバー伸縮で下端が隠れ、`100dvh` は Safari 15.4 未満で効かない。
  ヘッダ/フッタは `env(safe-area-inset-*)` を見る。タップターゲットは 44px 以上。

**M2 の追加（2026-07-31）**

- 選択状態（検索条件・スタディ・シリーズ）は `MobileScreen` が持つ。hash 遷移ではアンマウント
  されないので state は生き残るが、**スマホはタブが裏に回ると破棄されて復帰＝リロードになる**ため
  `graphy-mobile-ctx` にも書き出す。デスクトップのビューア起動コンテキスト（`graphy-viewer-ctx` 等）
  とは別キー — あちらは「別ウィンドウへ渡す」、こちらは「自分の続きから開く」ためのもの。
- 直接 URL / リロードで選択が無いまま深い画面にいる場合は、`location.replace` で親へ戻す
  （履歴に「行けない画面」を残さない）。
- 一覧はデスクトップの表（6〜7 列）ではなく **1 件 = 1 カード**の縦リスト。
- 検索は入力 1 本＋期間プリセットのチップ。**数字だけなら患者 ID、それ以外は氏名**として送る
  （狭幅ゆえの割り切り。backend はどちらも部分一致）。
- ⚠️ **iOS Safari は 16px 未満の入力欄でフォーカス時に自動ズームする。** 検索欄は `fontSize: 16` を維持。
- ⚠️ 期間プリセットで **`setMonth` / `setFullYear` の暦計算は使わない。** 7/31 の 1 か月前は
  存在しない「6/31」なので JS が 7/1 へ**繰り上げ**、期間が狭まって 6 月末の検査を取りこぼす。
  日数で引く（月 = 31 日、年 = 366 日）＝広めに外す。回帰防止テストあり。

### 3.3 タッチバインドの追加

**`numTouchPoints` の使用が frontend 全体で 0 件。** バインドはすべて `MouseBindings` のみ
（`viewer/Viewer2D.tsx:1401-1409`、`viewer/mpr.ts:310-313` ほか）。

Cornerstone3D 3.33.5 は 1 本指タッチをアクティブツール（`MouseBindings.Primary`）へ暗黙
フォールバックするが、**右クリック（Zoom）・中クリック（Pan）・ホイール（StackScroll）に相当する
タッチ操作が存在しない**。加えてメインの 2D 描画要素に `touch-action: none` が無い
（`viewer/Viewer2D.tsx:1572` の `pixelLayer`）ため、ドラッグがページスクロールと競合する。

対処:

1. `setToolActive` の bindings に `{ numTouchPoints: n }` を併記する。割り当て案:
   - 1 本指 = アクティブツール（既定は W/L、ツールバーで切替）
   - 2 本指 = Pan ＋ ピンチ Zoom
   - 3 本指 = StackScroll
2. `pixelLayer`（`viewer/Viewer2D.tsx:1572`）と MPR / 3D の viewport 要素に `touchAction: "none"` を
   付与。既存で指定済みなのは Pointer Events を使う 6 箇所のみ
   （`slicer/SlicerScreen.tsx:1007`、`curvedmpr/CurvedMprScreen.tsx:898`、
   `viewer3d/Viewer3DCutOverlay.tsx:172`、`viewer3d/Viewer3DMeasureOverlay.tsx:286`、
   `viewer3d/Viewer3DEndoPathOverlay.tsx:260`、`viewer3d/OpacityCurveDialog.tsx:285`）。
3. **ROI 計測のハンドル操作は実機検証が必須**。タップターゲットが小さいため、ハンドル半径の
   拡大が必要になる可能性が高い。
4. 3D は vtk.js の interactor がタッチを処理するので回転/ピンチは動く見込み（要検証）。

**実装（2026-07-31 / M4）**

- **1 本指のバインドは書かない。** Cornerstone の `getActiveToolForTouchEvent` が
  「1 タッチ かつ Primary バインド」を自動で拾うので、明示すると二重定義になるだけ。
- **2 本指は `PanTool` ではなく `ZoomTool` に割り当てる。** ZoomTool は既定で
  `pinchToZoom: true` かつ `pan: true` で、`_pinchCallback` が**ピンチ拡大縮小と平行移動を同時に**
  処理する。PanTool を割り当てると平行移動しかできない。バインドは `Viewer2D` の 2 箇所
  （初期配線と `setActiveTool`）に `TOUCH_ZOOM_BINDING` として入れた。
- 🔑 **3 本指のスライス送りに `StackScrollTool` は使わない。** 表示スライスは
  `SeriesViewer` の React state（z）が唯一の出所で、ツールが viewport の `imageIdIndex` を
  直接動かすと次の再描画で巻き戻る。`SeriesViewer` に touch リスナを足し、既存のホイール送りと
  同じ `step()` を呼ぶ。ジェスチャの解釈は `viewer/touchScroll.ts`（純関数・単体テスト付き）。
  - 端数は `Math.trunc`（`Math.floor` だと上方向の微動で −1 が出て、指を止めても動く）
  - 起点は送った分だけ進めて**端数を残す**（毎回現在位置へ丸めると連続送りが引っかかる）
- ✅ **ROI ハンドルのタップターゲットは対処不要だった。** cornerstone の
  `store/filterToolsWithMoveableHandles.js` が `interactionType === 'touch' ? 36 : 6` と、
  **タッチ時は既に 36px** を使っている。設計時の「拡大が必要になる可能性が高い」は杞憂。
  ただし**見た目のハンドル半径は変わらない**ので、掴めるが小さく見える。M9 で実機確認する。
- `touchAction: "none"` は `Viewer2D.pixelLayer` / `MprScreen.vpEl` / `Viewer3DScreen.vpEl` の 3 箇所。
  Slicer / Curved MPR は Pointer Events 実装で既に指定済み。

### 3.4 追い風 — 画像操作は既にボタン化されている

モバイル対応で最も手間がかかりそうな部分が、**すでにデスクトップ側で実装済み**。

| 操作 | 実装 |
|---|---|
| W/L・Pan・Zoom のツール切替 | `viewer2d/Viewer2DToolbar.tsx:153-155` の**ラジオ式ボタン** |
| Rotation(90°) / Flip H/V | `viewer2d/Viewer2DToolbar.tsx:199-201` |
| Fit / Reset | `:205-206` |
| ズーム ±（離散・×1.2） | `viewer/Viewer2D.tsx:1747-1748` ＝**ピンチ不要でも操作可能** |
| スライス送り | `viewer/SeriesViewer.tsx:711` の `<input type="range">` ＋ シネ再生 |
| W/L プリセット | `viewer2d/wlPresets.ts:25-32`（brain / soft / lung / bone / abdomen / liver、編集可） |

タイル内操作バーは `viewer/Viewer2D.tsx:1738` のコメントどおり **canvas の外に置かれており
ツール入力と競合しない**設計になっている。

> ⚠️ **`reset()` は camera（zoom/pan/rotation/flip）のみで W/L は戻らない**
> （`viewer/Viewer2D.tsx:1099-1103`）。VOI リセットは別コマンド `resetWindow()`（`:1133-1139`）。
> モバイルの「リセット」は**両方呼ぶ複合アクションを新設**する（既存コマンドは変更しない）。

### 3.5 データ取得フックの抽出

現状、取得ロジックが**コンポーネント内に直書き**でカスタムフックが 1 つもない。

- `StudyList.tsx:52-103`（studies ＋ reportCounts）、`:229-236`（series）、`:290-296`（instances）
  がそれぞれ `useState` ＋ `useEffect` ＋ `fetch` ＋ `cancelled` フラグ。
- 3 階層の入れ子コンポーネント（`StudyList` → `SeriesNavigator` → `InstanceList`）なので、
  単画面ナビゲーションにそのまま流用できない。

**`useStudies()` / `useSeries()` / `useInstances()` に抽出する**（各 20 行程度、合計 100 行未満）。
既存 `StudyList.tsx` も同じフックに置き換えて重複を防ぐ。

**実装（2026-07-31 / M2）**

- 3 つとも `useState` ＋ `useEffect` ＋ `fetch` ＋ `cancelled` フラグという**同じ形**だったので、
  設計に無かった `hooks/useAsyncData.ts` を 1 枚挟んだ。**取り違えると壊れる `cancelled` の扱いを
  1 箇所に閉じる**のが目的で、3 つのフックはその薄いラッパになっている。
- `data === null` が「未取得」、`loading` が「いま飛んでいる」。**「検索していないので空」と
  「検索したが 0 件」を出し分ける**ために両方要る（既存 `StudyList` の `filters == null` 分岐と同じ意味）。
- `useStudies` はレポート件数（●/○ 表示）を `withReportCounts` でオプトインにした。
  モバイル側は M8 まで不要なので既定 OFF。取得失敗は握り潰す（補助情報）。
- `StudyList.tsx` の 3 箇所（studies / series / instances）を置き換え済み。
  選択・ページのリセットはコンポーネントに残し、**取得だけ**を移した。

> HTTP 層（`api.ts` / `http.ts` / `apiBase.ts`）は既に完全分離されており、**web / standalone の差は
> backend が吸収している**（`StudyController.java:38`）。フロントは同じ `/api/studies` を叩くだけなので、
> 差分の再実装は不要。

### 3.6 ディープリンク

IHE IID 起動（`App.tsx:52-95`、`:57` で web モード限定）が既に
「URL の `?studyUID=` を読んで検索を飛ばし直接 2D ビューアを開く」経路を持っている。
**モバイルのディープリンクはこのパターンを流用する。**

## 4. ビューア別の設計

### 4.1 2D

`viewer/Viewer2D.tsx` / `viewer/SeriesViewer.tsx` をそのまま使い、シェルとツールバーだけ差し替える。
タイルは **1×1 固定**（マルチタイルは狭幅で成立しない）。左ツリー（`width: 280` 固定）と
右 ROI パネル（`width: 260` 固定）はドロワー化する。

**実装（2026-07-31 / M3）** — `mobile/MobileViewer.tsx` ＋ `mobile/MobileToolbar.tsx`

- `SeriesViewer` は**無改変**。`fillHeight` ＋ `commandKey="mobile-tile"` で使い、操作は既存の
  `viewerCommands` レジストリ経由で送る。`key={seriesInstanceUid}` を付けてシリーズ切替時に
  内部状態（Z/C/T・ソート）を持ち越さない。
- **`showControls` は `true` のまま**にした。設計文の「ツールバーを差し替える」に対して、
  スライス送りスライダー／シネ／ThickSlab／オーバーレイ行が**すべてこのパネルにある**（§3.4）ためで、
  `false` にすると**スライス送りの手段が無くなる**。`SeriesViewer` にスライス設定コマンドは無く、
  追加すると 808 行の共有コンポーネントに手を入れることになるので、M3 では見送った。
  → モバイルツールバーは**このパネルに無いもの**だけを担当する:
  ツール切替（W/L / Pan / Zoom）・Fit・**複合リセット**・90°回転・W/L プリセット・シリーズドロワー。
- **複合リセット**: `reset()` は camera（zoom/pan/rotation/flip）だけで W/L は戻らないので、
  `reset()` ＋ `resetWindow()` を続けて呼ぶ 1 ボタンにした（既存コマンドは変更していない）。
- ツールバーは折り返さず**横スクロール**（`overflow-x: auto` / `touch-action: pan-x`）。
  折り返すと縦に伸びて画像が潰れるため。タップターゲットは 44px 以上。
- 左ツリー相当は**下からせり上がるシート**のドロワー。ビューアを離れずシリーズを切り替えられる。
- ⚠️ **既知の見た目の問題（M9 で扱う）**: `SeriesViewer` の操作パネルは明るいテーマ（`#f7f9fb`）で、
  モバイルシェルの暗い背景の中に白いカードとして出る。機能はするが統一感が無い。
- ⚠️ **M4（タッチバインド）が入るまで実用にならない。** `pixelLayer` に `touch-action: none` が
  無いので、画像上のドラッグがページスクロールと競合する。`MOBILE_SHELL_READY` を true にするのは
  **M4 完了後**（当初は「M3 完了時」と書いていたが、この理由で先送りした）。

### 4.2 3D / MPR

- **`volume-memory-guard.md` の V1・V2 が入っていることが前提。** 入っていない状態でモバイルに
  出すと、無警告のタブ kill が起きる。
- MPR の 3 面同時（`mpr/MprScreen.tsx:392-399` の `flex: 1` × 3 セル横並び）は縦画面で成立しない。
  **1 面表示＋面切替タブ**にする。
- 3D の右パネル（`viewer3d/Viewer3DScreen.tsx:742-752` の `width: 240` 固定）はドロワー化。
- **Cinematic / パストレーサは出さない。** どちらも既定 OFF の opt-in
  （`viewer/vtkVolumeView.ts:545-546`、`viewer3d/Viewer3DScreen.tsx:139`）で、
  `viewer/cinematicPathTracer.ts:19` に「standalone(Electron) 前提」と明記されている。
- WebGL コンテキストロス時の Retry は既存実装（`viewer3d/Viewer3DScreen.tsx:340-365`）が効く。

**実装（2026-07-31 / M5）**

- 🔑 **モバイル用の 3D/MPR 画面は新規に作らず、既存画面を狭幅で作り分ける。**
  `MprScreen` / `Viewer3DScreen` は元々 `position: fixed; inset: 0` の全画面コンポーネントで、
  これは**モバイルの単画面シェルにとって望ましい形そのもの**。モバイルシェルからは
  `mobile/launchViewer.ts` が既存のコンテキスト（`graphy-mpr-ctx` / `graphy-viewer3d-ctx`）を書いて
  **同一タブの hash 遷移**（`#mpr` / `#viewer3d`）で開く。ブラウザの「戻る」でシェルへ戻る。
  → §1 の「既存 UI をレスポンシブ化しない」方針とは矛盾しない。あれは inline style 726 箇所の
  メイン/2D 画面の話で、§4.2 は元々「MPR を 1 面にする / 3D の右パネルをドロワー化する」＝
  これらの画面自体を作り分けよと指示している。
- 判定は両画面が `useDeviceClass()` を直接呼ぶ（プロップの引き回し無し）。**手動でデスクトップ UI を
  選んでいれば従来どおり**（3 面同時・常設パネル）。
- ⚠️ **MPR の 1 面表示でも 3 つのビューポートは必ずマウントしたままにする。**
  Crosshairs は 3 面が揃って初めて連動し、要素を外す/寸法 0 にすると cornerstone のリサイズが壊れる。
  3 面を `position: absolute; inset: 0` で重ね、非表示は **`visibility` だけ**で行う（寸法は全面のまま）。
- 3D の右パネル（`width: 240` 固定）は狭幅で右からのドロワー＋スクリムに。中身は共通で器だけ差し替え。
- Cinematic / パストレーサの起動ボタンは狭幅で非表示。
- MPR / 3D の両ヘッダに狭幅時だけ「戻る」（`history.back()`）を出す。デスクトップは別ウィンドウで
  開くため戻る導線は不要（＝`narrow` でガードしている）。

### 4.3 Fusion — 2D のみ

**Fusion は 2 ボリューム同時ロードではなく 2D canvas のオーバレイ**なので、MPR/3D より桁違いに軽く、
モバイルに最も向いている。

- 背景スライス位置の**近傍数枚だけを遅延ロード**して trilinear 再構成する
  （`viewer/FusionOverlayViewer.tsx:297-330`。`threshold = max(sliceSpacing*2, 10)mm`）。
- 前景ジオメトリは `/layout` DTO から骨組みだけ作り、**全スライスの画素を読まない**（`:45-67`）。
- web モードでも動く（`mode` を `imageIdForInstance` に渡すだけ。`:135,158-160`）。

**MPR/3D 上の Fusion は対象外。** `frontend/src/mpr/` `viewer3d/` に Fusion コードは grep 0 件で、
VolumeViewport では canvas overlay 方式が使えず、2 ボリューム同時ロード（メモリ 2 倍）への
設計変更になる。

現状 Fusion の設定はセンタードロップ（`viewer2d/Viewer2DScreen.tsx:122,662-673`）で行うため、
**タッチでは別の導線（シリーズ一覧から「重ねる」選択）が必要**。

**実装（2026-07-31 / M6）** — `mobile/MobileViewer.tsx`

- 導線は**シリーズドロワーの各行に「重ねる」ボタン**。行そのもののタップは従来どおり
  「そのシリーズを開く」で、重ねるは別ボタンに分けた（タップ 1 つに 2 つの意味を持たせない）。
  表示中のシリーズには出さない（自分自身に重ねても意味が無い）。
- 描画は既存の `FusionImageViewer` を `SeriesViewer` の `renderFusionOverlay` へ渡すだけ。
  デスクトップと**同じ経路**で、web / standalone の差は `mode` を渡すだけで吸収される。
- ⚠️ `renderFusionOverlay` は **`useMemo` で安定化が必須**。毎レンダ別関数だと `Viewer2D` 側の
  rect 初期計算 effect がループする（`Viewer2DScreen` の同等箇所にも同じ注意書きがある）。
- 不透明度は画像下のバーにスライダー 1 本。初期値はデスクトップのセンタードロップと同じ 0.5。
- base シリーズを切り替えたら Fusion は解除する（重ね合わせの意味が変わるため）。
- **LUT と Fusion の W/L はモバイルでは出さない**（デスクトップの `FusionControls` 相当）。
  参照用途では不透明度で足り、狭幅に載せると操作が細かくなりすぎるため。必要になったら M9 以降。
- C/T は常に 0。モバイルシェルはマルチ C/T の切替 UI を持たない。

## 5. レポート

### 5.1 web モードでは現状 2 つの問題がある

| 問題 | 原因 |
|---|---|
| **キー画像ありの確定が 409 で失敗** | `report/ReportService.java:189-194` がキー画像の SOPClassUID を**ローカル H2 索引**（`dicomInstanceRepo`）から引く。web では外部 PACS 由来のインスタンスが索引に無い（`report-design.md:256` に既知事項として記載） |
| **SR/KO が PACS に届かない** | `ReportService` は web でも `storage.ingest()` 固定で STOW-RS を使わない。生成された SR は web の検査一覧（QIDO）に現れない「見えない SR」になる |

> 🚨 **STOW-RS を足すだけでは 409 は解消しない。上記は独立した 2 つの変更。**

### 5.2 対処（2026-07-30 決定 = 両方実装する）

1. **キー画像メタデータの解決経路を追加** — web では QIDO/WADO 経由で SOPClassUID を解決する。
   識別情報の継承で既に QIDO/WADO を使っている箇所（`ReportService.java:241-253`）と同じ経路。
2. **STOW-RS 書き戻しを追加** — web モードでは `storage.ingest()` の代わりに PACS へ STOW する。
   **既存実装をそのまま流用できる**: `dicom/derived/DerivedSeriesService.java:92-110` が
   web モードで STOW している（`SegExportService.java:216` / `RtStructExportService.java:173` も同型）。

順序は 1 → 2。両方入って初めて「web でキー画像付きレポートを確定して PACS に返す」が成立する。

**実装（2026-07-31 / M7）** — `report/ReportService.java`

- 1.（409 の解消）`resolveKeyImageSopClassUids()` を新設。standalone はローカル索引、
  web は QIDO-RS。**シリーズが分かっていればシリーズ配下で絞る**（`KeyImageRef.seriesInstanceUid`）。
  分からない場合だけスタディ配下を横断する（そのために
  `WebDicomDataService.searchStudyInstances()` を追加した）。
  `includefield=00080016` を明示するのは、既定の返却属性が PACS 実装で異なるため。
- 応答の選択は純関数 `pickSopClassUid()` に分けて単体テストを付けた。
  ⚠️ **UID 一致が無くても 1 件だけなら採用する**（QIDO 応答に SOPInstanceUID を含めない PACS があり、
  絞り込み条件が効いている前提でのフォールバック）。**2 件以上あって一致が無ければ null**＝409 にする。
  推測して誤った SOP Class を SR に書くより止める方が安全。
- 2.（見えない SR の解消）`store(List<Attributes>)` を新設。web は `storeDatasets()` で STOW-RS、
  standalone は従来どおり `ingest()`。**SR と KO をまとめてから 1 リクエストで送る**
  （`dicom/derived/DerivedSeriesService` と同型）。
- PACS 未到達・タイムアウトは「見つからない」として扱い 409 にする（例外をそのまま 500 にしない）。
- ⚠️ **実 PACS での検証は未実施。** 単体テストは QIDO 応答の選択部分と standalone の確定経路まで。
  STOW-RS 送信自体はテストしていない（DICOMweb 層の他の機能と同じ扱い）。

### 5.3 モバイル用エディタは新規に書く

既存 `report/ReportEditorDialog.tsx` をモバイルで使うのは不可:

- `:406-419` の dialog が `width: 1040, height: 780`（`maxWidth: 97vw` があるので画面外には出ないが
  中身が崩れる）。`fieldsRow`（`:460`）と `footer`（`:480`）は `flexWrap` なしで溢れる。
- `report/MarkdownEditor.tsx:204` の `panes` が **textarea とプレビューを左右 50/50 固定分割**。
  375px 幅では各 ~180px でどちらも使えない。→ **縦積み or タブ切替**にする。
- `height: 780 / maxHeight: 94vh` の固定高なので、iOS のソフトキーボードが出ると textarea が
  キーボード裏に隠れる。`visualViewport` への追随が必要。

一方で移植に有利な性質もある:

- **API が `api.ts:917-1036` に完全分離**されている（`listReportsByStudy` / `getReport` /
  `createReport` / `updateReport` / `deleteReport` / `lockReport` / `unlockReport` / `finalizeReport`）。
- エディタは **contentEditable ではなく素の `<textarea>`** ＋ `react-markdown` プレビュー
  （`MarkdownEditor.tsx:139-150`）。リッチテキストライブラリ非依存。
- モーダルは中央寄せで**ドラッグ移動を持たない**（`ReportEditorDialog.tsx:397-405`）。

> `MarkdownEditor.tsx:14` の `PREVIEW_DEBOUNCE_MS = 400` は「入力中にタブが応答なしになる」
> 過去バグへの対策。**低スペック端末では 400ms でも不足する可能性がある**ので実機で確認する。

### 5.4 キー画像の追加導線

現状は「MainScreen で選択中のシリーズのインスタンス一覧から選ぶ」方式のみで、
**表示中の画像から直接追加する導線がない**（`report/KeyImageGrid.tsx:12-13`、
`report-design.md` §9 で将来対応とされている）。単画面ビューアでは
「いま見ている画像を添付」が最も自然なので、**この導線を新規に実装する**。

### 5.5 作成者の記録は現状のまま（2026-07-30 決定）

`Report` エンティティに author / userId フィールドはなく、編集者名は localStorage の自己申告
（`report/ReportEditorDialog.tsx:30` の `graphy.report.editorName`）。デモの magic link セッションも
レポートに流れていない（`web/AuthFilter.java:57-60` は署名検証のみで identity を下流に渡さない）。

これは設計上の明示的判断（`report-design.md:14,181,185-186`「認証機構は導入しない」「将来ログイン
機能ができた場合 `ReportParticipant.staffId` のような任意 FK を後から追加できる設計」）であり、
**モバイル対応では変更しない**。

## 6. フェーズ

| Phase | 内容 | 依存 | 状態 |
|---|---|---|---|
| **M0** | `volume-memory-guard.md` の V1・V2 | — | ✅ 完了（2026-07-31。V1〜V4 すべて実装済み） |
| **M1** | デバイス判定 `useDeviceClass()` ＋ 手動切替 ＋ `#mobile` ルート追加 ＋ シェル骨格 | — | ✅ 完了（2026-07-31） |
| **M2** | データ取得フック抽出（`useStudies` / `useSeries` / `useInstances`）＋ 検索→スタディ→シリーズの単画面ナビゲーション | M1 | ✅ 完了（2026-07-31） |
| **M3** | 2D ビューア（1×1 固定・ドロワー・モバイルツールバー・複合リセット） | M2 | ✅ 完了（2026-07-31）／実機未確認 |
| **M4** | タッチバインド（`numTouchPoints` ＋ `touchAction: none`）＋ ROI 計測のタップターゲット調整 | M3 | ✅ 完了（2026-07-31）／実機未確認 |
| **M5** | 3D / MPR（1 面＋面切替・ドロワー・Cinematic 非表示） | M0, M3 | ✅ 完了（2026-07-31）／実機未確認 |
| **M6** | Fusion（タッチ用の重ね合わせ導線） | M3 | ✅ 完了（2026-07-31）／実機未確認 |
| **M7** | レポート backend（キー画像 QIDO 解決 → STOW-RS 書き戻し） | — | ✅ 完了（2026-07-31）／実 PACS 未検証 |
| **M8** | レポート モバイルエディタ（縦積み・visualViewport 追随・表示中画像の添付） | M7, M3 | 未着手 |
| **M9** | 実機検証（iOS Safari / Android Chrome / iPad）＋ automator への追加 | 全部 | 未着手 |

M7 は frontend に依存しないので M1〜M6 と並行できる。

## 7. 非目標

- **standalone(Electron) のモバイル対応**（デスクトップアプリなので対象外）。
- **既存デスクトップ UI のレスポンシブ化**（§1 の方針どおり、別シェルで対応する）。
- **読影用途**。参照用と位置づける。医用モニタ品質管理（`monitor-qc-design.md`）が前提の
  診断行為をモバイルで行うことは想定しない。
- **PWA / オフライン対応**。将来検討。
- **MPR 上の計測**（§2.2）、**MPR/3D 上の Fusion**（§4.3）。
- **マスク作成・新規シリーズ作成・Analysis・プラグイン**（§2）。

## 8. 既存ドキュメントの是正

コードが先行して doc が追随していない箇所がある。**本設計の着手時に併せて直す。**

| ファイル | 現状の記述 | 事実 |
|---|---|---|
| `mpr-viewer-design.md:166` | 「standalone のみ（web は wadors 未対応）」 | **web 対応済み**（`mpr/MprScreen.tsx:109-110` に「web も対応」コメント） |
| `3d-viewer-design.md:55,537` | 「初期スコープ standalone のみ」 | **web 対応済み**（`viewer3d/Viewer3DScreen.tsx:179-180,233-239`） |
| `HANDOFF.md` §4 項目 4 | 「web(wadors) 対応: 画像 imageId・layout 導出（現状 standalone のみ。`imageId.ts` は web で throw）」 | `viewer/imageId.ts:23-33` は web 分岐を実装済み。throw するのは `studyUid`/`seriesUid` が欠けた場合のみ |

併せて、各画面の `Phase` 型に残る未使用の `"unsupported"`
（`mpr/MprScreen.tsx:54`、`viewer3d/Viewer3DScreen.tsx:69`、`slicer/SlicerScreen.tsx:89`、
`curvedmpr/CurvedMprScreen.tsx:46`）と、どこからも参照されていない i18n キー
`mpr.webUnsupported` / `viewer3d.webUnsupported` / `slicer.webUnsupported` / `curvedMpr.webUnsupported`
（`i18n/ja.ts:137,148,401,430`）はデッドコードとして整理する。

## 9. 実装対象ファイル一覧（新規 / 変更）

**新規（モバイルシェル）**
- ✅ `frontend/src/mobile/useDeviceClass.ts` … デバイス判定 ＋ 手動切替の永続化（M1）
- ✅ `frontend/src/mobile/mobileRoute.ts` … hash ルート ＋ ナビゲーションスタックの親子関係
  ＋ `MOBILE_SHELL_READY` ゲート（M1。設計時には無かったファイル）
- ✅ `frontend/src/mobile/MobileScreen.tsx` … `#mobile` ルートのシェル（ナビゲーションスタック）（M1）
  ＋ 選択状態（検索条件・スタディ・シリーズ）の保持（M2）
- ✅ `frontend/src/mobile/mobileCtx.ts` … 選択状態の localStorage 永続化（M2。設計時には無かったファイル）
- ✅ `frontend/src/mobile/dateRange.ts` … 検索の期間プリセット（M2。同上）
- ✅ `frontend/src/mobile/useDeviceClass.test.ts` / `mobileRoute.test.ts` / `dateRange.test.ts` … 単体テスト
- ✅ `frontend/src/mobile/MobileStudyBrowser.tsx` … 検索 → スタディ → シリーズ（M2）
- ✅ `frontend/src/mobile/MobileViewer.tsx` … 2D（M3）／シリーズ切替ドロワー／3D・MPR 起動（M5）／
  Fusion の「重ねる」導線と不透明度バー（M6）
- ✅ `frontend/src/mobile/launchViewer.ts` … 3D / MPR を同一タブで開く（M5。設計時には無かったファイル）
- ✅ `frontend/src/mobile/MobileToolbar.tsx` … ツール切替・W/L プリセット・複合リセット（M3）
- `frontend/src/mobile/MobileReportEditor.tsx` … 縦積みエディタ
- ✅ `frontend/src/hooks/useStudies.ts` / `useSeries.ts` / `useInstances.ts` … 取得ロジック抽出（M2）
- ✅ `frontend/src/hooks/useAsyncData.ts` … 上記 3 つの共通部分（M2。設計時には無かったファイル）

**変更（frontend）**
- ✅ `App.tsx` … `#mobile` ルート追加 ＋ 初回アクセス時の自動振り分け（M1。ゲートは `MOBILE_SHELL_READY`）
- ✅ `mainscreen/MainScreen.tsx` / `mainscreen/MenuBar.tsx` … System メニューに手動切替を追加（M1。web のみ）
- `mainscreen/MainScreen.tsx:87-157` … `handleOpenViewer` にモバイル分岐（hash 遷移）（M2/M3）
- ✅ `StudyList.tsx` … 抽出したフックへ置き換え（重複解消）（M2）
- ✅ `viewer/Viewer2D.tsx` … 2 本指 = ZoomTool（ピンチ＋Pan）バインド ＋ `pixelLayer` に
  `touchAction: "none"`（M4）
- ✅ `viewer/SeriesViewer.tsx` … 3 本指の縦ドラッグでスライス送り（M4）
- ✅ `viewer/touchScroll.ts` / `touchScroll.test.ts` **（新規）** … 上記ジェスチャの純関数（M4）
- ✅ `mpr/MprScreen.tsx` … viewport に `touchAction: "none"`（M4）／狭幅で 1 面＋面切替タブ＋戻る（M5）
- ✅ `viewer3d/Viewer3DScreen.tsx` … viewport に `touchAction: "none"`（M4）／狭幅で右パネルをドロワー化・
  Cinematic 非表示・戻る（M5）
- `viewer/mpr.ts:310-313` … MPR のツールバインドは**変更していない**。MPR の 1 面表示は M5 の範囲で、
  そこで Crosshairs/WindowLevel/Pan のタッチ割り当てを決める
- `i18n/ja.ts` / `i18n/en.ts` … モバイル UI 文言（**両方必須**）

**変更（backend / レポート M7）**
- ✅ `report/ReportService.java` … `resolveKeyImageSopClassUids()`（QIDO 解決）＋
  `store()`（web は STOW-RS）＋ `pickSopClassUid()`（応答選択の純関数）
- ✅ `dicom/web/WebDicomDataService.java` … `searchStudyInstances()` を追加
- ✅ `src/test/.../ReportKeyImageSopClassTest.java` **（新規）** … 応答選択の単体テスト

**是正（§8）**
- `fw/mpr-viewer-design.md` / `fw/3d-viewer-design.md` / `fw/HANDOFF.md`
- 各画面の `Phase` 型と未使用 i18n キー
