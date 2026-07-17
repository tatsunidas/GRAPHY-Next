# 03. DB管理（DbAdmin）

**ソース**: fw/db-admin.md

このファイルは automator の検証チェックリストの一部です。ステータス列は
「未着手 / 自動PASS / 要人間確認 / FAIL」のいずれかを runner が更新します
（`<!-- AUTOMATOR:BEGIN id -->`〜`<!-- AUTOMATOR:END id -->` の区間のみ機械的に書き換え、
それ以外の記述は保持されます）。

## 状態サマリ

| # | 小項目 | 状態 | 最終実行 |
|---|---|---|---|
| 1 | Patient→Study→Seriesドリルダウン木でシリーズ削除ができる | 自動PASS | 2026-07-17 |
| 2 | スタディ指定で患者情報を編集（PatientID変更で別患者へ移動）できる | 自動PASS | 2026-07-17 |
| 3 | シリーズ統合（N→1、InstanceNumber再採番）ができる | 自動PASS | 2026-07-17 |
| 4 | シリーズ分割（1→N、手動群分け）ができる | 自動PASS | 2026-07-17 |
| 5 | 編集中に別ウィンドウ（2D Viewer）でポップアップ通知が出る | 自動PASS | 2026-07-17 |
| 6 | DBを初期化して空の状態にできる（automator用reset） | 自動PASS | 2026-07-17 |

## 小項目詳細

### 1. Patient→Study→Seriesドリルダウン木でシリーズ削除ができる

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 03-db-admin.item-01 -->
#### 2026-07-17 (run 20260717-124222-te2j9w)
1. MainScreen の初期マウントを確認
2. DB管理ダイアログを開く
3. 患者ID HCC_001 で検索
4. 患者行を展開
5. 先頭のスタディ行を展開
6. 削除前のシリーズ行数を確認 `{"before":3}`
7. 先頭シリーズの削除ボタンをクリック（確認ダイアログを自動許可）
8. 患者一覧まで畳まれたのを確認してから再展開
9. 削除後、再展開してシリーズ行数を確認 `{"after":2}`
Result: PASS — シリーズ削除でbefore=3→after=2
<!-- AUTOMATOR:END 03-db-admin.item-01 -->

### 2. スタディ指定で患者情報を編集（PatientID変更で別患者へ移動）できる

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 03-db-admin.item-02 -->
#### 2026-07-17 (run 20260717-124619-xe9qzi)
1. MainScreen の初期マウントを確認
2. DB管理ダイアログを開く
3. 患者ID HCC_001 で検索
4. 患者行を展開
5. 先頭のスタディ行を展開
6. PatientID を HCC_001_MOVED へ変更して保存
7. 移動先PatientIDで検索し、患者行の出現を確認 `{"movedVisible":true}`
8. 元のPatientID HCC_001 へ戻す（後続項目のためのクリーンアップ）
Result: PASS — PatientID変更による患者移動を確認、元IDへ復元済み
<!-- AUTOMATOR:END 03-db-admin.item-02 -->

### 3. シリーズ統合（N→1、InstanceNumber再採番）ができる

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 03-db-admin.item-03 -->
#### 2026-07-17 (run 20260717-131625-28e1xr)
1. MainScreen の初期マウントを確認
2. DB管理ダイアログを開く
3. 患者ID HCC_001 で検索
4. 患者行を展開
5. 先頭のスタディ行を展開
6. 統合前のシリーズ行数を確認 `{"before":2}`
7. 先頭2シリーズを選択
8. 統合ダイアログでシリーズ統合を実行
9. 患者一覧まで畳まれたのを確認してから再展開
10. 統合後、再展開してシリーズ行数を確認 `{"after":1}`
Result: PASS — シリーズ統合でbefore=2→after=1
<!-- AUTOMATOR:END 03-db-admin.item-03 -->

### 4. シリーズ分割（1→N、手動群分け）ができる

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 03-db-admin.item-04 -->
#### 2026-07-17 (run 20260717-132257-q1j7b6)
1. MainScreen の初期マウントを確認
2. DB管理ダイアログを開く
3. 患者ID HCC_001 で検索
4. 患者行を展開
5. 先頭のスタディ行を展開
6. 分割前のシリーズ行数を確認 `{"before":1}`
7. 分割ダイアログを開く（既定 groupCount=2）
8. 先頭インスタンスを群1へ割当て
9. 分割を実行
10. 患者一覧まで畳まれたのを確認してから再展開
11. 分割後、再展開してシリーズ行数を確認 `{"after":2}`
Result: PASS — シリーズ分割でbefore=1→after=2
<!-- AUTOMATOR:END 03-db-admin.item-04 -->

### 5. 編集中に別ウィンドウ（2D Viewer）でポップアップ通知が出る

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 03-db-admin.item-05 -->
#### 2026-07-17 (run 20260717-132803-1slg8q)
1. MainScreen の初期マウントを確認
2. 無条件検索でスタディ一覧を取得
3. 先頭のスタディ行をクリック
4. 先頭のシリーズ行をクリック
5. series-viewer-root の表示を確認
6. 2D Viewerウィンドウを開き、シリーズのロードを確認
7. メインウィンドウのDB管理ダイアログで対象スタディのシリーズ一覧を表示
8. メインウィンドウでシリーズを削除（確認ダイアログを自動許可）
9. 2D Viewerウィンドウで db-change-notice の出現を確認 `{"noticeShown":true}`
Result: PASS — DB編集（シリーズ削除）で別ウィンドウにポップアップ通知が出ることを確認
<!-- AUTOMATOR:END 03-db-admin.item-05 -->

### 6. DBを初期化して空の状態にできる（automator用reset）

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 03-db-admin.item-06 -->
#### 2026-07-17 (run 20260717-124016-4qchjf)
1. MainScreen の初期マウントを確認
2. POST /api/automator/reset `{"before":{"deletedInstances":67,"deletedReports":0}}`
3. MainScreen をリロードし、再マウントを確認
4. study-row-* の件数を確認 `{"count":0}`
Result: PASS — reset結果: {"deletedInstances":67,"deletedReports":0}
<!-- AUTOMATOR:END 03-db-admin.item-06 -->
