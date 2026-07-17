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
| 3 | メニュー(File/Function/Image/System/Help)とツールバーの各ボタンが対応機能を起動する | 自動PASS | 2026-07-17 |
| 4 | 環境設定・DB管理ボタンからダイアログが開く | 自動PASS | 2026-07-17 |
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
- **保留（2026-07-17）**: `ct-basic` は単一スタディのみで、ページング(`PAGE_SIZE`超過時のみ表示)の
  閾値を跨げない。件数表示自体（`study.list.total`）は item-01 の検索結果で暗黙に検証されている。
  51件以上の異なるStudyInstanceUIDを持つfixture（合成データ生成 or 実データ）が必要。

<!-- AUTOMATOR:BEGIN 02-mainscreen.item-02 -->
（未実装 — automator run で自動記録される手順ログがここに入る）
<!-- AUTOMATOR:END 02-mainscreen.item-02 -->

### 3. メニュー(File/Function/Image/System/Help)とツールバーの各ボタンが対応機能を起動する

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 02-mainscreen.item-03 -->
#### 2026-07-17 (run 20260717-121155-bmskow)
1. MainScreen の初期マウントを確認
2. 無条件検索でスタディ一覧を取得
3. 先頭のスタディ行をクリック
4. メニュー[file]を開いて項目数を確認 `{"itemCount":5}`
5. メニュー[function]を開いて項目数を確認 `{"itemCount":6}`
6. メニュー[image]を開いて項目数を確認 `{"itemCount":4}`
7. メニュー[system]を開いて項目数を確認 `{"itemCount":4}`
8. メニュー[help]を開いて項目数を確認 `{"itemCount":5}`
9. File > Send メニューから send-dialog が開くことを確認
Result: PASS — 5メニューの起動とFile>Sendの起動を確認
<!-- AUTOMATOR:END 02-mainscreen.item-03 -->

### 4. 環境設定・DB管理ボタンからダイアログが開く

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 02-mainscreen.item-04 -->
#### 2026-07-17 (run 20260717-132419-8lg7n1)
1. MainScreen の初期マウントを確認
2. System > 環境設定 から settings-dialog が開くことを確認
3. System > DB管理 から dbadmin-dialog が開くことを確認
Result: PASS — 環境設定・DB管理ダイアログの起動を確認
<!-- AUTOMATOR:END 02-mainscreen.item-04 -->

### 5. 自局AE設定変更時に再起動促進バナーが出て「今すぐ再起動」で反映される（standalone）

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)
- **保留（2026-07-17）**: 「今すぐ再起動」は automator が自前spawnしたbackend/Electronプロセスを
  driverの管理外で再起動させる可能性があり、driverの状態(ports/proc handle)と不整合を起こすリスク
  がある。安全な検証方法（driver側にrestart検知フックを足す等）を設計してから着手する。

<!-- AUTOMATOR:BEGIN 02-mainscreen.item-05 -->
（未実装 — automator run で自動記録される手順ログがここに入る）
<!-- AUTOMATOR:END 02-mainscreen.item-05 -->

