# MainScreen ツールバー機能（計画）

> 作成日: 2026-06-29
> ステータス: ツールバーにボタン設置済み。各機能の実装は本ドキュメントの計画に沿って順次。

ツールバーは「データ I/O・ユーティリティ」群と「ビューア」群、右端に Help/Settings。
ビューア起動（2D/3D/MPR/Slicer）と起動形態は `fw/viewer-2d-screen.md` 参照。

## データ I/O・ユーティリティ
| ボタン | 状態 | 計画 |
|---|---|---|
| **Import** | 実装済(standalone) | DICOM ファイル/フォルダ取込（ネイティブダイアログ→ /api/import/paths）。 |
| **Export** | 未実装 | 選択スタディ/シリーズを DICOM 一式で書き出し。**Burn CD/DVD オプション**（DICOMDIR 生成＋
|  |  | 標準ビューア同梱の媒体イメージ作成 or OS の書込みへ受け渡し）。出力先・構造（PatientID/StudyDate 等）選択。 |
| **NonDicomImporter** | 未実装 | 非 DICOM（**動画/PDF/画像[png,jpeg,tif,bmp 等]**）を DICOM 化して取り込む。
|  |  | 対応 SOP: 動画=Video Photographic/Endoscopic、PDF=Encapsulated PDF(1.2.840.10008.5.1.4.1.1.104.1)、
|  |  | 画像=Secondary Capture/VL Photographic。患者/スタディ紐付け UI。dcm4che で生成。 |
| **Anonymizer** | 未実装 | 患者識別情報の匿名化（DICOM PS3.15 Confidentiality Profile 準拠のプロファイル/オプション選択）。
|  |  | ピクセル内焼き込み除去（バーンイン）連携も検討。バッチ対応。 |
| **TagExtractor** | 未実装 | 指定タグ群を CSV/JSON で一括抽出（スタディ/シリーズ/インスタンス単位）。dcm4che ヘッダ読取。 |
| **SeriesExtractor** | 未実装 | 条件（モダリティ/記述/タグ）でシリーズを抽出・分割・コピー/エクスポート。 |
| Refresh / DB | 実装済 | 一覧更新 / DB テーブル管理。 |

## ビューア
| ボタン | 状態 |
|---|---|
| **2D Viewer** | Phase 1 実装済（別ウィンドウ・タイル）。`fw/viewer-2d-screen.md`。 |
| **3D Viewer / MPR Viewer / Slicer** | 未実装（ボタンのみ。近日対応）。 |

## 右端
| ボタン | 状態 |
|---|---|
| Help（ショートカット一覧） | 実装済 |
| **Settings** | 実装済（環境設定ダイアログ起動のみ）。 |

## 実装メモ
- 現状、未実装ボタンは押下で「近日対応予定」バナーを表示（MainScreen `handleOpenTool`/`handleOpenViewer`）。
- これらは standalone（Electron）前提の機能が多い（ネイティブ I/O・媒体書込）。web モードでの可否は機能ごとに判断。
- 多くは backend(dcm4che) と新規エンドポイント＋フロント UI（ダイアログ）で構成予定。
