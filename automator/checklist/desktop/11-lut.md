# 11. LUT（カラーマップ）

**ソース**: fw/HANDOFF.md

このファイルは automator の検証チェックリストの一部です。ステータス列は
「未着手 / 自動PASS / 要人間確認 / FAIL」のいずれかを runner が更新します
（`<!-- AUTOMATOR:BEGIN id -->`〜`<!-- AUTOMATOR:END id -->` の区間のみ機械的に書き換え、
それ以外の記述は保持されます）。

## 状態サマリ

| # | 小項目 | 状態 | 最終実行 |
|---|---|---|---|
| 1 | LUTダイアログから106種のLUTを選択・即時適用できる | 自動PASS | 2026-07-17 |
| 2 | グレースケールへのリセットができる | 自動PASS | 2026-07-17 |

## 小項目詳細

### 1. LUTダイアログから106種のLUTを選択・即時適用できる

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 11-lut.item-01 -->
#### 2026-07-17 (run 20260717-174550-2p7obo)
1. MainScreen の初期マウントを確認
2. 無条件検索でスタディ一覧を取得
3. 先頭のスタディ行をクリック
4. 先頭のシリーズ行をクリック
5. series-viewer-root の表示を確認
6. LUTダイアログを表示
7. LUT行を選択: 10_Percent
8. Applyでダイアログを閉じ、LUTを適用
9. window.__graphyDebug.getViewportProperties() を評価 `{"props":[{"viewportId":"graphy-vp-0","colormapName":"graphy-lut-10_Percent","windowLevel":{"center":40,"width":100}}]}`
Result: PASS — 適用LUT=10_Percent
<!-- AUTOMATOR:END 11-lut.item-01 -->

### 2. グレースケールへのリセットができる

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 11-lut.item-02 -->
#### 2026-07-17 (run 20260717-114302-m8rzze)
1. MainScreen の初期マウントを確認
2. 無条件検索でスタディ一覧を取得
3. 先頭のスタディ行をクリック
4. 先頭のシリーズ行をクリック
5. series-viewer-root の表示を確認
6. 事前準備: 非グレースケールLUTを適用
7. グレースケール（リセット）行を選択
8. Applyでダイアログを閉じ、グレースケールへリセット
9. window.__graphyDebug.getViewportProperties() を評価 `{"props":[{"viewportId":"graphy-vp-0","colormapName":"graphy-gray","windowLevel":{"center":40,"width":100}}]}`
Result: PASS
<!-- AUTOMATOR:END 11-lut.item-02 -->

