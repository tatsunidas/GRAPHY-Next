# 21. ThickSlab（デジタルスライス厚）

**ソース**: fw/thickslab-design.md

このファイルは automator の検証チェックリストの一部です。ステータス列は
「未着手 / 自動PASS / 要人間確認 / FAIL」のいずれかを runner が更新します
（`<!-- AUTOMATOR:BEGIN id -->`〜`<!-- AUTOMATOR:END id -->` の区間のみ機械的に書き換え、
それ以外の記述は保持されます）。

## 状態サマリ

| # | 小項目 | 状態 | 最終実行 |
|---|---|---|---|
| 1 | On/Off・厚み選択（0.1〜5.0mm）、実間隔一致でOriginal表示 | 未着手 | |
| 2 | W/L・カーソルHU・参照線・同期が既存2D経路と一致 | 未着手 | |
| 3 | ON時はROI/計測/ブラシ作成をブロック（Zoom/Pan/Rotateは有効のまま） | 未着手 | |
| 4 | 動画/単一スライス/カラーで無効化 | 未着手 | |

## 小項目詳細

### 1. On/Off・厚み選択（0.1〜5.0mm）、実間隔一致でOriginal表示

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 21-thickslab.item-01 -->
（未実装 — automator run で自動記録される手順ログがここに入る）
<!-- AUTOMATOR:END 21-thickslab.item-01 -->

### 2. W/L・カーソルHU・参照線・同期が既存2D経路と一致

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 21-thickslab.item-02 -->
（未実装 — automator run で自動記録される手順ログがここに入る）
<!-- AUTOMATOR:END 21-thickslab.item-02 -->

### 3. ON時はROI/計測/ブラシ作成をブロック（Zoom/Pan/Rotateは有効のまま）

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 21-thickslab.item-03 -->
（未実装 — automator run で自動記録される手順ログがここに入る）
<!-- AUTOMATOR:END 21-thickslab.item-03 -->

### 4. 動画/単一スライス/カラーで無効化

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 21-thickslab.item-04 -->
（未実装 — automator run で自動記録される手順ログがここに入る）
<!-- AUTOMATOR:END 21-thickslab.item-04 -->

