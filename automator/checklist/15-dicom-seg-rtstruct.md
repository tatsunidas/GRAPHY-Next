# 15. DICOM SEG / RTSTRUCT 永続化

**ソース**: fw/dicom-seg-rtstruct-design.md

このファイルは automator の検証チェックリストの一部です。ステータス列は
「未着手 / 自動PASS / 要人間確認 / FAIL」のいずれかを runner が更新します
（`<!-- AUTOMATOR:BEGIN id -->`〜`<!-- AUTOMATOR:END id -->` の区間のみ機械的に書き換え、
それ以外の記述は保持されます）。

## 状態サマリ

| # | 小項目 | 状態 | 最終実行 |
|---|---|---|---|
| 1 | マスク→DICOM SEG書出（dense、Fusion整合）→再読込で復元 | 未着手 | |
| 2 | ROI→RTSTRUCT書出→再読込でROI復元（往復） | 未着手 | |
| 3 | エクスポート後に検索ツリーが自動更新される | 未着手 | |

## 小項目詳細

### 1. マスク→DICOM SEG書出（dense、Fusion整合）→再読込で復元

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 15-dicom-seg-rtstruct.item-01 -->
（未実装 — automator run で自動記録される手順ログがここに入る）
<!-- AUTOMATOR:END 15-dicom-seg-rtstruct.item-01 -->

### 2. ROI→RTSTRUCT書出→再読込でROI復元（往復）

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 15-dicom-seg-rtstruct.item-02 -->
（未実装 — automator run で自動記録される手順ログがここに入る）
<!-- AUTOMATOR:END 15-dicom-seg-rtstruct.item-02 -->

### 3. エクスポート後に検索ツリーが自動更新される

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 15-dicom-seg-rtstruct.item-03 -->
（未実装 — automator run で自動記録される手順ログがここに入る）
<!-- AUTOMATOR:END 15-dicom-seg-rtstruct.item-03 -->

