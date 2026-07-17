# 08. TagExtractor / TagViewer / SeriesExtractor

**ソース**: fw/mainscreen-tools.md

このファイルは automator の検証チェックリストの一部です。ステータス列は
「未着手 / 自動PASS / 要人間確認 / FAIL」のいずれかを runner が更新します
（`<!-- AUTOMATOR:BEGIN id -->`〜`<!-- AUTOMATOR:END id -->` の区間のみ機械的に書き換え、
それ以外の記述は保持されます）。

## 状態サマリ

| # | 小項目 | 状態 | 最終実行 |
|---|---|---|---|
| 1 | TagExtractor: タグ/シーケンス(パス)/Privateを指定して検索リスト全体をCSV/テーブル抽出 | 自動PASS | 2026-07-17 |
| 2 | TagViewer: 現在画像のDICOM属性ダンプ表示（SQネスト・検索ハイライト） | 自動PASS | 2026-07-17 |
| 3 | SeriesExtractor: 条件（Include/Exclude・平面）で一致シリーズをフォルダコピー/ZIP抽出 | 自動PASS | 2026-07-17 |

## 小項目詳細

### 1. TagExtractor: タグ/シーケンス(パス)/Privateを指定して検索リスト全体をCSV/テーブル抽出

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 08-tag-extractor-viewer-series-extractor.item-01 -->
#### 2026-07-17 (run 20260717-134453-875wpu)
1. MainScreen の初期マウントを確認
2. 無条件検索でスタディ一覧を取得
3. 先頭のスタディ行をクリック
4. TagExtractorダイアログを開く
5. PatientIDタグをプリセットから追加
6. 抽出結果テーブルの行数を確認 `{"rowCount":3}`
Result: PASS — PatientIDタグで抽出、3行取得
<!-- AUTOMATOR:END 08-tag-extractor-viewer-series-extractor.item-01 -->

### 2. TagViewer: 現在画像のDICOM属性ダンプ表示（SQネスト・検索ハイライト）

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 08-tag-extractor-viewer-series-extractor.item-02 -->
#### 2026-07-17 (run 20260717-135152-mic7wa)
1. MainScreen の初期マウントを確認
2. 無条件検索でスタディ一覧を取得
3. 先頭のスタディ行をクリック
4. 先頭のシリーズ行をクリック
5. series-viewer-root の表示を確認
6. TagViewerダイアログを開き、DICOM属性ダンプの行数を確認 `{"totalRows":107}`
7. PatientIDで検索しハイライト件数を確認 `{"highlighted":2}`
Result: PASS — 全107行、PatientID検索で2件ハイライト
<!-- AUTOMATOR:END 08-tag-extractor-viewer-series-extractor.item-02 -->

### 3. SeriesExtractor: 条件（Include/Exclude・平面）で一致シリーズをフォルダコピー/ZIP抽出

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 08-tag-extractor-viewer-series-extractor.item-03 -->
#### 2026-07-17 (run 20260717-135918-lwpf6w)
1. MainScreen の初期マウントを確認
2. 無条件検索でスタディ一覧を取得
3. 先頭のスタディ行をクリック
4. ネイティブフォルダ選択ダイアログをモック `{"destDir":"C:\\Users\\t_kob\\graphy-workspace\\GRAPHY-Next\\.claude\\worktrees\\automator-lut-checklist\\automator\\.results\\series-extract-out-1784264358611"}`
5. SeriesExtractorダイアログを開く
6. 条件なしでVerifyし、一致シリーズ数を確認 `{"matchedCount":3}`
7. モックしたフォルダを出力先として選択
8. コピー実行（standalone: 親フォルダへコピー）
9. 出力先フォルダにファイルが現れるのを確認 `{"filesAppeared":true,"destDir":"C:\\Users\\t_kob\\graphy-workspace\\GRAPHY-Next\\.claude\\worktrees\\automator-lut-checklist\\automator\\.results\\series-extract-out-1784264358611"}`
Result: PASS — 3シリーズを C:\Users\t_kob\graphy-workspace\GRAPHY-Next\.claude\worktrees\automator-lut-checklist\automator\.results\series-extract-out-1784264358611 へコピー
<!-- AUTOMATOR:END 08-tag-extractor-viewer-series-extractor.item-03 -->

