# 01. 起動・共通基盤

**ソース**: fw/HANDOFF.md, fw/development-phases.md

このファイルは automator の検証チェックリストの一部です。ステータス列は
「未着手 / 自動PASS / 要人間確認 / FAIL」のいずれかを runner が更新します
（`<!-- AUTOMATOR:BEGIN id -->`〜`<!-- AUTOMATOR:END id -->` の区間のみ機械的に書き換え、
それ以外の記述は保持されます）。

## 状態サマリ

| # | 小項目 | 状態 | 最終実行 |
|---|---|---|---|
| 1 | standalone(Electron)モードで起動できる（スプラッシュ→バックエンド起動→メイン画面表示） | 未着手 | |
| 2 | webモードで起動できる（ブラウザでVite/ビルド済みfrontendを開く） | 未着手 | |
| 3 | スプラッシュ画面の進捗表示（DB初期化/プラグイン読込/SCP起動）が正しく進行する | 未着手 | |
| 4 | バックエンド起動失敗時にスプラッシュへエラーメッセージが表示される | 未着手 | |

## 小項目詳細

### 1. standalone(Electron)モードで起動できる（スプラッシュ→バックエンド起動→メイン画面表示）

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 01-startup-common.item-01 -->
（未実装 — automator run で自動記録される手順ログがここに入る）
<!-- AUTOMATOR:END 01-startup-common.item-01 -->

### 2. webモードで起動できる（ブラウザでVite/ビルド済みfrontendを開く）

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 01-startup-common.item-02 -->
（未実装 — automator run で自動記録される手順ログがここに入る）
<!-- AUTOMATOR:END 01-startup-common.item-02 -->

### 3. スプラッシュ画面の進捗表示（DB初期化/プラグイン読込/SCP起動）が正しく進行する

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 01-startup-common.item-03 -->
（未実装 — automator run で自動記録される手順ログがここに入る）
<!-- AUTOMATOR:END 01-startup-common.item-03 -->

### 4. バックエンド起動失敗時にスプラッシュへエラーメッセージが表示される

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 01-startup-common.item-04 -->
（未実装 — automator run で自動記録される手順ログがここに入る）
<!-- AUTOMATOR:END 01-startup-common.item-04 -->

