# CLAUDE.md — GRAPHY-Next

> このリポジトリで作業する Claude / 開発者が**最初に読む**ファイル。
> 詳細な引き継ぎは `fw/HANDOFF.md`、全体計画は `fw/development-phases.md`、各機能設計は `fw/*.md`。

## 🚨 最重要・最初に必ず読む

3D / MPR / リスライス / Curved MPR / 3D ROI / メッシュ / 計測 / 座標変換に関わるなら、**着手前に必ず**:

**→ [`fw/cornerstone-3d-geometry-caveat.md`](fw/cornerstone-3d-geometry-caveat.md)**

要点: **Cornerstone3D の 3D ジオメトリ計算（カメラ / `canvasToWorld` / `voxelManager` の値レイアウト /
`VolumeViewport3D` の blend・clip）にはバグがあり、そのまま使うと実空間座標がずれる。**
確定的な座標・サンプリング・計測は**患者 LPS mm の「自前・単一幾何」**で完結させ、cornerstone は**表示だけ**に使う。
表示幾何と計算幾何を混ぜると座標がずれる（「クロス幾何」バグ）。Slicer / Curved MPR / 3D Viewer で実証済み。

## 概要

**GRAPHY**（Java Swing の DICOM ワークステーション。別リポジトリ `../GRAPHY`）の Web 化版。
- **2 モード**: standalone（Electron + ローカル H2/FS）と web（ブラウザ + 外部 PACS via DICOMweb/BFF）。
- スタック: Spring Boot 3.3.5 / Java 21 / Maven ＋ React 18 / TypeScript / Vite 5 ＋ Electron 31。
- 画像表示: Cornerstone3D 3.33.x ＋ 同梱 `@kitware/vtk.js`。
- 新機能は原則 **standalone(Electron) 前提**。web 対応は機能ごとに後追い。

```
GRAPHY-Next/
  backend/   Spring Boot（DICOM 保管庫=H2+FS、DIMSE、DICOMweb、REST）
  frontend/  React/TS/Vite（UI 全部）
  desktop/   Electron（main.js / preload.js / config.json）
  fw/        設計ドキュメント（ソース・オブ・トゥルース）
  scripts/   dev-desktop.sh など
```

## エントリポイント（fw/）

- `HANDOFF.md` … 引き継ぎ（現状把握の起点）
- `development-phases.md` … 全体フェーズ計画
- `viewer-2d-architecture.md` … 2D ビューア中核設計（最重要）＋輝度校正の二重適用注意
- `slicer-design.md` / `mpr-viewer-design.md` / `3d-viewer-design.md`（＋作業記録 `3d-viewer-worklog.md`）
- `roi-mask-progress.md` … ROI 系の進行状況

## ビルド / 実行の注意

- **ルートで `npm run build` 禁止**（Maven が走る）。フロントの型/ビルドは `frontend/` で `npx tsc --noEmit` / `npx vite build`。
- 検証環境は standalone（backend :8080 ＋ Vite :5173）。
- 輝度（HU/SUV）読取は `frontend/src/viewer/pixelCalibration.ts` に一元化（Rescale 二重適用禁止）。
