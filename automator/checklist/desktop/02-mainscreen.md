# 02. MainScreen（メイン画面）

**ソース**: fw/HANDOFF.md, fw/mainscreen-tools.md, fw/mainscreen-progress.md

このファイルは automator の検証チェックリストの一部です。ステータス列は
「未着手 / 自動PASS / 要人間確認 / FAIL」のいずれかを runner が更新します
（`<!-- AUTOMATOR:BEGIN id -->`〜`<!-- AUTOMATOR:END id -->` の区間のみ機械的に書き換え、
それ以外の記述は保持されます）。

## 状態サマリ

| # | 小項目 | 状態 | 最終実行 |
|---|---|---|---|
| 1 | スタディ検索（日付範囲・Today/Yesterday/週・モダリティチェック）ができる | 自動PASS | 2026-07-17 |
| 2 | 検索結果が件数付きでページング表示される（50件ページング） | 未着手 | |
| 3 | メニュー(File/Function/Image/System/Help)とツールバーの各ボタンが対応機能を起動する | 未着手 | |
| 4 | 環境設定・DB管理ボタンからダイアログが開く | 未着手 | |
| 5 | 自局AE設定変更時に再起動促進バナーが出て「今すぐ再起動」で反映される（standalone） | 未着手 | |

## 小項目詳細

### 1. スタディ検索（日付範囲・Today/Yesterday/週・モダリティチェック）ができる

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 02-mainscreen.item-01 -->
#### 2026-07-17 (run 20260717-114514-4yqgua)
1. MainScreen の初期マウントを確認
2. 日付フィルタをクリア
3. 検索ボタンをクリック（無条件検索の確認ダイアログを自動許可）
4. study-row-* の件数を確認 `{"count":1}`
Result: PASS — 1件のスタディが見つかりました
<!-- AUTOMATOR:END 02-mainscreen.item-01 -->

### 2. 検索結果が件数付きでページング表示される（50件ページング）

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 02-mainscreen.item-02 -->
（未実装 — automator run で自動記録される手順ログがここに入る）
<!-- AUTOMATOR:END 02-mainscreen.item-02 -->

### 3. メニュー(File/Function/Image/System/Help)とツールバーの各ボタンが対応機能を起動する

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 02-mainscreen.item-03 -->
（未実装 — automator run で自動記録される手順ログがここに入る）
<!-- AUTOMATOR:END 02-mainscreen.item-03 -->

### 4. 環境設定・DB管理ボタンからダイアログが開く

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 02-mainscreen.item-04 -->
（未実装 — automator run で自動記録される手順ログがここに入る）
<!-- AUTOMATOR:END 02-mainscreen.item-04 -->

### 5. 自局AE設定変更時に再起動促進バナーが出て「今すぐ再起動」で反映される（standalone）

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 02-mainscreen.item-05 -->
（未実装 — automator run で自動記録される手順ログがここに入る）
<!-- AUTOMATOR:END 02-mainscreen.item-05 -->

