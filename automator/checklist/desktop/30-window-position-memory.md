# 30. ウィンドウ位置記憶

**ソース**: fw/window-position-memory.md

このファイルは automator の検証チェックリストの一部です。ステータス列は
「未着手 / 自動PASS / 要人間確認 / FAIL」のいずれかを runner が更新します
（`<!-- AUTOMATOR:BEGIN id -->`〜`<!-- AUTOMATOR:END id -->` の区間のみ機械的に書き換え、
それ以外の記述は保持されます）。

## 状態サマリ

| # | 小項目 | 状態 | 最終実行 |
|---|---|---|---|
| 1 | 各ビューア別ウィンドウがシングルトンで、前回位置/最大化状態を復元する | 未着手 | |
| 2 | モニタ構成変更（外部モニタ抜去等）で画面外に迷子にならない | 未着手 | |

## 小項目詳細

### 1. 各ビューア別ウィンドウがシングルトンで、前回位置/最大化状態を復元する

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 30-window-position-memory.item-01 -->
（未実装 — automator run で自動記録される手順ログがここに入る）
<!-- AUTOMATOR:END 30-window-position-memory.item-01 -->

### 2. モニタ構成変更（外部モニタ抜去等）で画面外に迷子にならない

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 30-window-position-memory.item-02 -->
（未実装 — automator run で自動記録される手順ログがここに入る）
<!-- AUTOMATOR:END 30-window-position-memory.item-02 -->

