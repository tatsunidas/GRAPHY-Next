# 25. プラグインシステム

**ソース**: fw/plugin-architecture.md, fw/plugin-authoring-guide.md

このファイルは automator の検証チェックリストの一部です。ステータス列は
「未着手 / 自動PASS / 要人間確認 / FAIL」のいずれかを runner が更新します
（`<!-- AUTOMATOR:BEGIN id -->`〜`<!-- AUTOMATOR:END id -->` の区間のみ機械的に書き換え、
それ以外の記述は保持されます）。

## 状態サマリ

| # | 小項目 | 状態 | 最終実行 |
|---|---|---|---|
| 1 | 2D Viewer「Plug-ins」メニュー、MainScreen「Plug-Ins」メニューにマニフェストが表示される | 未着手 | |
| 2 | UIのみプラグイン（standalone/web両方）が動作する | 未着手 | |
| 3 | バックエンドJARプラグイン実行（standalone専用、webは501） | 未着手 | |

## 小項目詳細

### 1. 2D Viewer「Plug-ins」メニュー、MainScreen「Plug-Ins」メニューにマニフェストが表示される

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 25-plugin-system.item-01 -->
（未実装 — automator run で自動記録される手順ログがここに入る）
<!-- AUTOMATOR:END 25-plugin-system.item-01 -->

### 2. UIのみプラグイン（standalone/web両方）が動作する

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 25-plugin-system.item-02 -->
（未実装 — automator run で自動記録される手順ログがここに入る）
<!-- AUTOMATOR:END 25-plugin-system.item-02 -->

### 3. バックエンドJARプラグイン実行（standalone専用、webは501）

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 25-plugin-system.item-03 -->
（未実装 — automator run で自動記録される手順ログがここに入る）
<!-- AUTOMATOR:END 25-plugin-system.item-03 -->

