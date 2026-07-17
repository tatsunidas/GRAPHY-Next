# 04. Import / Export

**ソース**: fw/export.md, fw/export-portable-viewer.md, fw/mainscreen-tools.md

このファイルは automator の検証チェックリストの一部です。ステータス列は
「未着手 / 自動PASS / 要人間確認 / FAIL」のいずれかを runner が更新します
（`<!-- AUTOMATOR:BEGIN id -->`〜`<!-- AUTOMATOR:END id -->` の区間のみ機械的に書き換え、
それ以外の記述は保持されます）。

## 状態サマリ

| # | 小項目 | 状態 | 最終実行 |
|---|---|---|---|
| 1 | ローカルDICOMファイル/フォルダのImportができる | 自動PASS | 2026-07-17 |
| 2 | Export: 患者→スタディ/シリーズ選択→ZIPダウンロード（DICOMDIR/README同梱オプション） | 未着手 | |
| 3 | Export ZIPがWindows安全なフォルダ名・DICOMDIR整合で生成される | 未着手 | |
| 4 | 2D Viewer Portable（媒体同梱ビューア）は未実装（トグルのみ存在）— 未実装であることの確認 | 未着手 | |

## 小項目詳細

### 1. ローカルDICOMファイル/フォルダのImportができる

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 04-import-export.item-01 -->
#### 2026-07-17 (run 20260717-113418-2qb328)
1. POST /api/import/paths で ct-basic フィクスチャを投入 `{"result":{"imported":110,"skipped":0,"failed":0,"errors":[]}}`
Result: PASS — imported=110
<!-- AUTOMATOR:END 04-import-export.item-01 -->

### 2. Export: 患者→スタディ/シリーズ選択→ZIPダウンロード（DICOMDIR/README同梱オプション）

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 04-import-export.item-02 -->
（未実装 — automator run で自動記録される手順ログがここに入る）
<!-- AUTOMATOR:END 04-import-export.item-02 -->

### 3. Export ZIPがWindows安全なフォルダ名・DICOMDIR整合で生成される

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 04-import-export.item-03 -->
（未実装 — automator run で自動記録される手順ログがここに入る）
<!-- AUTOMATOR:END 04-import-export.item-03 -->

### 4. 2D Viewer Portable（媒体同梱ビューア）は未実装（トグルのみ存在）— 未実装であることの確認

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 04-import-export.item-04 -->
（未実装 — automator run で自動記録される手順ログがここに入る）
<!-- AUTOMATOR:END 04-import-export.item-04 -->

