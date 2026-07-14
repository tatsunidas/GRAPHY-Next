# 08. TagExtractor / TagViewer / SeriesExtractor

**ソース**: fw/mainscreen-tools.md

このファイルは automator の検証チェックリストの一部です。ステータス列は
「未着手 / 自動PASS / 要人間確認 / FAIL」のいずれかを runner が更新します
（`<!-- AUTOMATOR:BEGIN id -->`〜`<!-- AUTOMATOR:END id -->` の区間のみ機械的に書き換え、
それ以外の記述は保持されます）。

## 状態サマリ

| # | 小項目 | 状態 | 最終実行 |
|---|---|---|---|
| 1 | TagExtractor: タグ/シーケンス(パス)/Privateを指定して検索リスト全体をCSV/テーブル抽出 | 未着手 | |
| 2 | TagViewer: 現在画像のDICOM属性ダンプ表示（SQネスト・検索ハイライト） | 未着手 | |
| 3 | SeriesExtractor: 条件（Include/Exclude・平面）で一致シリーズをフォルダコピー/ZIP抽出 | 未着手 | |

## 小項目詳細

### 1. TagExtractor: タグ/シーケンス(パス)/Privateを指定して検索リスト全体をCSV/テーブル抽出

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 08-tag-extractor-viewer-series-extractor.item-01 -->
（未実装 — automator run で自動記録される手順ログがここに入る）
<!-- AUTOMATOR:END 08-tag-extractor-viewer-series-extractor.item-01 -->

### 2. TagViewer: 現在画像のDICOM属性ダンプ表示（SQネスト・検索ハイライト）

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 08-tag-extractor-viewer-series-extractor.item-02 -->
（未実装 — automator run で自動記録される手順ログがここに入る）
<!-- AUTOMATOR:END 08-tag-extractor-viewer-series-extractor.item-02 -->

### 3. SeriesExtractor: 条件（Include/Exclude・平面）で一致シリーズをフォルダコピー/ZIP抽出

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 08-tag-extractor-viewer-series-extractor.item-03 -->
（未実装 — automator run で自動記録される手順ログがここに入る）
<!-- AUTOMATOR:END 08-tag-extractor-viewer-series-extractor.item-03 -->

