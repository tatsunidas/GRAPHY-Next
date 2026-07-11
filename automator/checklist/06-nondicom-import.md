# 06. NonDICOM Import

**ソース**: fw/mainscreen-tools.md, fw/nondicom-ffmpeg.md

このファイルは automator の検証チェックリストの一部です。ステータス列は
「未着手 / 自動PASS / 要人間確認 / FAIL」のいずれかを runner が更新します
（`<!-- AUTOMATOR:BEGIN id -->`〜`<!-- AUTOMATOR:END id -->` の区間のみ機械的に書き換え、
それ以外の記述は保持されます）。

## 状態サマリ

| # | 小項目 | 状態 | 最終実行 |
|---|---|---|---|
| 1 | PDF→Encapsulated PDF化して取込、ビューアから開く/ダウンロードできる | 未着手 | |
| 2 | 画像(png/jpg/bmp/gif/tif)→Secondary Captureとして取込 | 未着手 | |
| 3 | 動画(MP4 H.264)→Video Photographic化して取込 | 未着手 | |
| 4 | 動画(AVI/非H.264)→ffmpeg変換経由で取込 | 未着手 | |
| 5 | ffmpeg不在時は動画がskipされエラーメッセージが出る | 未着手 | |

## 小項目詳細

### 1. PDF→Encapsulated PDF化して取込、ビューアから開く/ダウンロードできる

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 06-nondicom-import.item-01 -->
（未実装 — automator run で自動記録される手順ログがここに入る）
<!-- AUTOMATOR:END 06-nondicom-import.item-01 -->

### 2. 画像(png/jpg/bmp/gif/tif)→Secondary Captureとして取込

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 06-nondicom-import.item-02 -->
（未実装 — automator run で自動記録される手順ログがここに入る）
<!-- AUTOMATOR:END 06-nondicom-import.item-02 -->

### 3. 動画(MP4 H.264)→Video Photographic化して取込

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 06-nondicom-import.item-03 -->
（未実装 — automator run で自動記録される手順ログがここに入る）
<!-- AUTOMATOR:END 06-nondicom-import.item-03 -->

### 4. 動画(AVI/非H.264)→ffmpeg変換経由で取込

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 06-nondicom-import.item-04 -->
（未実装 — automator run で自動記録される手順ログがここに入る）
<!-- AUTOMATOR:END 06-nondicom-import.item-04 -->

### 5. ffmpeg不在時は動画がskipされエラーメッセージが出る

- 対応 fixture: (未定義)
- requiresHuman: (未定義。実装時に判定方式を決める)

<!-- AUTOMATOR:BEGIN 06-nondicom-import.item-05 -->
（未実装 — automator run で自動記録される手順ログがここに入る）
<!-- AUTOMATOR:END 06-nondicom-import.item-05 -->

