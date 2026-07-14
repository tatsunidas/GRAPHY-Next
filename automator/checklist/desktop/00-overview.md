# 00. automator 検証チェックリスト — 概要

GRAPHY-Next の全機能領域（fw/*.md 由来、31大項目）を横断する検証チェックリストの索引。
各大項目の詳細・小項目・実行記録は個別ファイルを参照。

進め方は `automator/README.md`、設計方針は元プランを参照。実装（ランナーコード）は
「DB初期化 → Import → MainScreen検索 → 2D Viewer表示」という最も基礎的な縦串から
段階的に追加し、他の大項目は当面スケルトン（小項目一覧のみ）の状態。

## 大項目一覧

| # | 大項目 | 状態 |
|---|---|---|
| 01 | [起動・共通基盤](./01-startup-common.md) | 未着手 |
| 02 | [MainScreen（メイン画面）](./02-mainscreen.md) | 未着手 |
| 03 | [DB管理（DbAdmin）](./03-db-admin.md) | 未着手 |
| 04 | [Import / Export](./04-import-export.md) | 未着手 |
| 05 | [DICOM通信（Send / Query-Retrieve / DIMSE）](./05-dicom-communication.md) | 未着手 |
| 06 | [NonDICOM Import](./06-nondicom-import.md) | 未着手 |
| 07 | [Anonymizer](./07-anonymizer.md) | 未着手 |
| 08 | [TagExtractor / TagViewer / SeriesExtractor](./08-tag-extractor-viewer-series-extractor.md) | 未着手 |
| 09 | [2D Viewer 画面（マルチタイル）](./09-viewer2d-screen.md) | 未着手 |
| 10 | [2D Viewer コア表示](./10-viewer2d-core.md) | 未着手 |
| 11 | [LUT（カラーマップ）](./11-lut.md) | 未着手 |
| 12 | [2D Viewerメニュー・ツールバー機能](./12-viewer2d-menu-toolbar.md) | 未着手 |
| 13 | [ROI / セグメンテーション（マスク）](./13-roi-segmentation.md) | 未着手 |
| 14 | [Level Sets セグメンテーション](./14-level-sets.md) | 未着手 |
| 15 | [DICOM SEG / RTSTRUCT 永続化](./15-dicom-seg-rtstruct.md) | 未着手 |
| 16 | [Fusion（画像重畳）](./16-fusion.md) | 未着手 |
| 17 | [MPR Viewer](./17-mpr-viewer.md) | 未着手 |
| 18 | [3D Viewer](./18-3d-viewer.md) | 未着手 |
| 19 | [Slicer（任意断面リスライス）](./19-slicer.md) | 未着手 |
| 20 | [Curved MPR / CPR](./20-curved-mpr.md) | 未着手 |
| 21 | [ThickSlab（デジタルスライス厚）](./21-thickslab.md) | 未着手 |
| 22 | [SUV校正（PET）](./22-suv-calibration.md) | 未着手 |
| 23 | [Texture（Radiomicsマップ）](./23-texture-radiomics.md) | 未着手 |
| 24 | [レポート機能](./24-report.md) | 未着手 |
| 25 | [プラグインシステム](./25-plugin-system.md) | 未着手 |
| 26 | [モニター診断（Monitor QC）](./26-monitor-qc.md) | 未着手 |
| 27 | [環境設定（Settings）全般](./27-settings.md) | 未着手 |
| 28 | [System / Help メニュー](./28-system-help-menu.md) | 未着手 |
| 29 | [キーボードショートカット](./29-keyboard-shortcuts.md) | 未着手 |
| 30 | [ウィンドウ位置記憶](./30-window-position-memory.md) | 未着手 |
| 31 | [エラーハンドリング・ログ／セキュリティ横断](./31-error-handling-security.md) | 未着手 |

## ステータス凡例

- **未着手**: ランナーコード未実装（スケルトンのみ）
- **自動PASS**: DOM/状態ベースのアサーションで自動的に成功判定された
- **要人間確認**: 視覚的な良し悪しが絡むため、証跡スクリーンショット付きで人間の確認待ち（`automator confirm`）
- **FAIL**: 直近の実行で失敗（エラー内容は該当ファイルの手順ログ参照）
