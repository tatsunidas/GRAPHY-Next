# 14. Level Sets セグメンテーション

**ソース**: fw/level-sets-design.md

このファイルは automator の検証チェックリストの一部です。ステータス列は
「未着手 / 自動PASS / 要人間確認 / FAIL」のいずれかを runner が更新します
（`<!-- AUTOMATOR:BEGIN id -->`〜`<!-- AUTOMATOR:END id -->` の区間のみ機械的に書き換え、
それ以外の記述は保持されます）。

## 状態サマリ

| # | 小項目 | 状態 | 最終実行 |
|---|---|---|---|
| 1 | Fast Marching（点シード、輝度差閾値で拡張停止） | 未着手 | |
| 2 | Active Contours / Geodesic Active Contours（領域選択初期化、反復収束） | 未着手 | |
| 3 | 2D/3Dモード切替、Worker上での非同期実行・進捗プレビュー・キャンセル | 未着手 | |

## 小項目詳細

### 1. Fast Marching（点シード、輝度差閾値で拡張停止）

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 14-level-sets.item-01 -->
（未実装 — automator run で自動記録される手順ログがここに入る）
<!-- AUTOMATOR:END 14-level-sets.item-01 -->

### 2. Active Contours / Geodesic Active Contours（領域選択初期化、反復収束）

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 14-level-sets.item-02 -->
（未実装 — automator run で自動記録される手順ログがここに入る）
<!-- AUTOMATOR:END 14-level-sets.item-02 -->

### 3. 2D/3Dモード切替、Worker上での非同期実行・進捗プレビュー・キャンセル

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 14-level-sets.item-03 -->
（未実装 — automator run で自動記録される手順ログがここに入る）
<!-- AUTOMATOR:END 14-level-sets.item-03 -->

