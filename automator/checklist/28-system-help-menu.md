# 28. System / Help メニュー

**ソース**: fw/system-help-menu-design.md

このファイルは automator の検証チェックリストの一部です。ステータス列は
「未着手 / 自動PASS / 要人間確認 / FAIL」のいずれかを runner が更新します
（`<!-- AUTOMATOR:BEGIN id -->`〜`<!-- AUTOMATOR:END id -->` の区間のみ機械的に書き換え、
それ以外の記述は保持されます）。

## 状態サマリ

| # | 小項目 | 状態 | 最終実行 |
|---|---|---|---|
| 1 | Logビューア（フロント＋backendログの取り込み表示、フィルタ/検索/コピー） | 未着手 | |
| 2 | MemoryMonitor起動（OS標準ツール、standaloneのみ） | 未着手 | |
| 3 | Help: User's community外部リンク、開発者連絡ダイアログ（mailto/Issues/Sponsors） | 未着手 | |

## 小項目詳細

### 1. Logビューア（フロント＋backendログの取り込み表示、フィルタ/検索/コピー）

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 28-system-help-menu.item-01 -->
（未実装 — automator run で自動記録される手順ログがここに入る）
<!-- AUTOMATOR:END 28-system-help-menu.item-01 -->

### 2. MemoryMonitor起動（OS標準ツール、standaloneのみ）

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 28-system-help-menu.item-02 -->
（未実装 — automator run で自動記録される手順ログがここに入る）
<!-- AUTOMATOR:END 28-system-help-menu.item-02 -->

### 3. Help: User's community外部リンク、開発者連絡ダイアログ（mailto/Issues/Sponsors）

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 28-system-help-menu.item-03 -->
（未実装 — automator run で自動記録される手順ログがここに入る）
<!-- AUTOMATOR:END 28-system-help-menu.item-03 -->

