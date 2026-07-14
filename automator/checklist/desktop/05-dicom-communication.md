# 05. DICOM通信（Send / Query-Retrieve / DIMSE）

**ソース**: fw/qr-window.md, fw/mainscreen-tools.md, fw/dicom-data-layer.md

このファイルは automator の検証チェックリストの一部です。ステータス列は
「未着手 / 自動PASS / 要人間確認 / FAIL」のいずれかを runner が更新します
（`<!-- AUTOMATOR:BEGIN id -->`〜`<!-- AUTOMATOR:END id -->` の区間のみ機械的に書き換え、
それ以外の記述は保持されます）。

## 状態サマリ

| # | 小項目 | 状態 | 最終実行 |
|---|---|---|---|
| 1 | Send: スタディ/シリーズ選択→C-ECHO疎通確認→リモートAEへC-STORE送信 | 未着手 | |
| 2 | Query/Retrieveウィンドウ: 複数Destinationタブ・Today検索・AutoRefresh | 未着手 | |
| 3 | Retrieve（C-MOVE）: standalone=自局取込、web=dcm4chee宛、進捗バー・完了後「ビューアで開く」 | 未着手 | |
| 4 | DIMSE TLS通信（相互TLS）でC-ECHOが通る | 未着手 | |
| 5 | Windows実機でのmovescu（`=`区切り引数を含むクエリ）が失敗しない | 未着手 | |

## 小項目詳細

### 1. Send: スタディ/シリーズ選択→C-ECHO疎通確認→リモートAEへC-STORE送信

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 05-dicom-communication.item-01 -->
（未実装 — automator run で自動記録される手順ログがここに入る）
<!-- AUTOMATOR:END 05-dicom-communication.item-01 -->

### 2. Query/Retrieveウィンドウ: 複数Destinationタブ・Today検索・AutoRefresh

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 05-dicom-communication.item-02 -->
（未実装 — automator run で自動記録される手順ログがここに入る）
<!-- AUTOMATOR:END 05-dicom-communication.item-02 -->

### 3. Retrieve（C-MOVE）: standalone=自局取込、web=dcm4chee宛、進捗バー・完了後「ビューアで開く」

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 05-dicom-communication.item-03 -->
（未実装 — automator run で自動記録される手順ログがここに入る）
<!-- AUTOMATOR:END 05-dicom-communication.item-03 -->

### 4. DIMSE TLS通信（相互TLS）でC-ECHOが通る

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 05-dicom-communication.item-04 -->
（未実装 — automator run で自動記録される手順ログがここに入る）
<!-- AUTOMATOR:END 05-dicom-communication.item-04 -->

### 5. Windows実機でのmovescu（`=`区切り引数を含むクエリ）が失敗しない

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 05-dicom-communication.item-05 -->
（未実装 — automator run で自動記録される手順ログがここに入る）
<!-- AUTOMATOR:END 05-dicom-communication.item-05 -->

