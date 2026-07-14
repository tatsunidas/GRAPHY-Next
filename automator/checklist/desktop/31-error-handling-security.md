# 31. エラーハンドリング・ログ／セキュリティ横断

**ソース**: fw/error-handling-logging.md, fw/security.md

このファイルは automator の検証チェックリストの一部です。ステータス列は
「未着手 / 自動PASS / 要人間確認 / FAIL」のいずれかを runner が更新します
（`<!-- AUTOMATOR:BEGIN id -->`〜`<!-- AUTOMATOR:END id -->` の区間のみ機械的に書き換え、
それ以外の記述は保持されます）。

## 状態サマリ

| # | 小項目 | 状態 | 最終実行 |
|---|---|---|---|
| 1 | 共通例外ハンドラのJSONレスポンス形式・ステータスコードが妥当 | 未着手 | |
| 2 | Electronレンダラのハードニング設定（contextIsolation等）が固定されている | 未着手 | |

## 小項目詳細

### 1. 共通例外ハンドラのJSONレスポンス形式・ステータスコードが妥当

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 31-error-handling-security.item-01 -->
（未実装 — automator run で自動記録される手順ログがここに入る）
<!-- AUTOMATOR:END 31-error-handling-security.item-01 -->

### 2. Electronレンダラのハードニング設定（contextIsolation等）が固定されている

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 31-error-handling-security.item-02 -->
（未実装 — automator run で自動記録される手順ログがここに入る）
<!-- AUTOMATOR:END 31-error-handling-security.item-02 -->

