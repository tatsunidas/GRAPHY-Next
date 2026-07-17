# 03. DB管理（DbAdmin）

**ソース**: fw/db-admin.md

このファイルは automator の検証チェックリストの一部です。ステータス列は
「未着手 / 自動PASS / 要人間確認 / FAIL」のいずれかを runner が更新します
（`<!-- AUTOMATOR:BEGIN id -->`〜`<!-- AUTOMATOR:END id -->` の区間のみ機械的に書き換え、
それ以外の記述は保持されます）。

## 状態サマリ

| # | 小項目 | 状態 | 最終実行 |
|---|---|---|---|
| 1 | Patient→Study→Seriesドリルダウン木でシリーズ削除ができる | 未着手 | |
| 2 | スタディ指定で患者情報を編集（PatientID変更で別患者へ移動）できる | 未着手 | |
| 3 | シリーズ統合（N→1、InstanceNumber再採番）ができる | 未着手 | |
| 4 | シリーズ分割（1→N、手動群分け）ができる | 未着手 | |
| 5 | 編集中に別ウィンドウ（2D Viewer）でポップアップ通知が出る | 未着手 | |
| 6 | DBを初期化して空の状態にできる（automator用reset） | 自動PASS | 2026-07-17 |

## 小項目詳細

### 1. Patient→Study→Seriesドリルダウン木でシリーズ削除ができる

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 03-db-admin.item-01 -->
（未実装 — automator run で自動記録される手順ログがここに入る）
<!-- AUTOMATOR:END 03-db-admin.item-01 -->

### 2. スタディ指定で患者情報を編集（PatientID変更で別患者へ移動）できる

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 03-db-admin.item-02 -->
（未実装 — automator run で自動記録される手順ログがここに入る）
<!-- AUTOMATOR:END 03-db-admin.item-02 -->

### 3. シリーズ統合（N→1、InstanceNumber再採番）ができる

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 03-db-admin.item-03 -->
（未実装 — automator run で自動記録される手順ログがここに入る）
<!-- AUTOMATOR:END 03-db-admin.item-03 -->

### 4. シリーズ分割（1→N、手動群分け）ができる

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 03-db-admin.item-04 -->
（未実装 — automator run で自動記録される手順ログがここに入る）
<!-- AUTOMATOR:END 03-db-admin.item-04 -->

### 5. 編集中に別ウィンドウ（2D Viewer）でポップアップ通知が出る

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 03-db-admin.item-05 -->
（未実装 — automator run で自動記録される手順ログがここに入る）
<!-- AUTOMATOR:END 03-db-admin.item-05 -->

### 6. DBを初期化して空の状態にできる（automator用reset）

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 03-db-admin.item-06 -->
#### 2026-07-17 (run 20260717-101824-27rewh)
1. MainScreen の初期マウントを確認
2. POST /api/automator/reset `{"before":{"deletedInstances":110,"deletedReports":0}}`
3. MainScreen をリロードし、再マウントを確認
4. study-row-* の件数を確認 `{"count":0}`
Result: PASS — reset結果: {"deletedInstances":110,"deletedReports":0}
<!-- AUTOMATOR:END 03-db-admin.item-06 -->
