# 12. 2D Viewerメニュー・ツールバー機能

**ソース**: fw/viewer-2d-menu-toolbar.md, fw/viewer2d-image-menu-progress.md

このファイルは automator の検証チェックリストの一部です。ステータス列は
「未着手 / 自動PASS / 要人間確認 / FAIL」のいずれかを runner が更新します
（`<!-- AUTOMATOR:BEGIN id -->`〜`<!-- AUTOMATOR:END id -->` の区間のみ機械的に書き換え、
それ以外の記述は保持されます）。

## 状態サマリ

| # | 小項目 | 状態 | 最終実行 |
|---|---|---|---|
| 1 | Layoutサブメニュー（プリセット＋任意行×列） | 自動PASS | 2026-07-17 |
| 2 | Sort（InstanceNumber/IPP昇降順、動画IODはブロック） | 未着手 | |
| 3 | W/Lプリセット（脳/肺/縦隔/骨/腹部等）の適用・編集/追加/削除・永続化 | 自動PASS | 2026-07-17 |
| 4 | Histogram（Slice/Stack切替、ビン指定、ビンクリックでボクセルハイライト） | 未着手 | |
| 5 | コントラスト調整（W/L）ダイアログ（プロット・スライダー・Auto/Reset） | 未着手 | |
| 6 | ImageJブリッジ（HyperStack表示、カーソル輝度値・HU値が正しい） | 未着手 | |

## 小項目詳細

### 1. Layoutサブメニュー（プリセット＋任意行×列）

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 12-viewer2d-menu-toolbar.item-01 -->
#### 2026-07-17 (run 20260717-132917-5x50jv)
1. MainScreen の初期マウントを確認
2. 無条件検索でスタディ一覧を取得
3. 先頭のスタディ行をクリック
4. 先頭のシリーズ行をクリック
5. series-viewer-root の表示を確認
6. ツールバーの2Dボタンから別ウィンドウを開く
7. 2D Viewerウィンドウにシリーズがロードされたことを確認
8. View > Layout > 2 × 2 を選択
9. viewer2d-tile-grid の data-grid-rows/cols を確認 `{"rows":"2","cols":"2"}`
Result: PASS — 2×2レイアウトを適用
<!-- AUTOMATOR:END 12-viewer2d-menu-toolbar.item-01 -->

### 2. Sort（InstanceNumber/IPP昇降順、動画IODはブロック）

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 12-viewer2d-menu-toolbar.item-02 -->
（未実装 — automator run で自動記録される手順ログがここに入る）
<!-- AUTOMATOR:END 12-viewer2d-menu-toolbar.item-02 -->

### 3. W/Lプリセット（脳/肺/縦隔/骨/腹部等）の適用・編集/追加/削除・永続化

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 12-viewer2d-menu-toolbar.item-03 -->
#### 2026-07-17 (run 20260717-114045-4lyhvw)
1. MainScreen の初期マウントを確認
2. 無条件検索でスタディ一覧を取得
3. 先頭のスタディ行をクリック
4. 先頭のシリーズ行をクリック
5. series-viewer-root の表示を確認
6. ツールバーの2Dボタンから別ウィンドウを開く
7. 2D Viewerウィンドウにシリーズがロードされたことを確認
8. Image > W/Lプリセット > 肺 を選択（center=-600, width=1500）
9. window.__graphyDebug.getViewportProperties() を評価 `{"props":[{"viewportId":"graphy-vp-0","colormapName":null,"windowLevel":{"center":-600,"width":1500}}]}`
Result: PASS — W/Lプリセット「肺」を適用
<!-- AUTOMATOR:END 12-viewer2d-menu-toolbar.item-03 -->

### 4. Histogram（Slice/Stack切替、ビン指定、ビンクリックでボクセルハイライト）

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 12-viewer2d-menu-toolbar.item-04 -->
（未実装 — automator run で自動記録される手順ログがここに入る）
<!-- AUTOMATOR:END 12-viewer2d-menu-toolbar.item-04 -->

### 5. コントラスト調整（W/L）ダイアログ（プロット・スライダー・Auto/Reset）

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 12-viewer2d-menu-toolbar.item-05 -->
（未実装 — automator run で自動記録される手順ログがここに入る）
<!-- AUTOMATOR:END 12-viewer2d-menu-toolbar.item-05 -->

### 6. ImageJブリッジ（HyperStack表示、カーソル輝度値・HU値が正しい）

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 12-viewer2d-menu-toolbar.item-06 -->
（未実装 — automator run で自動記録される手順ログがここに入る）
<!-- AUTOMATOR:END 12-viewer2d-menu-toolbar.item-06 -->

