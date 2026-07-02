<p align="center">
  <img src="docs/images/splash.png" alt="GRAPHY-Next" width="560" />
</p>

<h1 align="center">
  <img src="docs/images/icon.png" alt="" width="28" height="28" align="absmiddle" />
  GRAPHY-Next
</h1>

Java Swing の DICOM ワークステーション **GRAPHY** の Web 化（リファクタリング版）。
Spring Boot バックエンド ＋ React フロントエンドを、**Web アプリ** と
**Electron デスクトップアプリ** の 2 モードで動かす。

> 詳細設計は [`fw/`](fw/) を参照（`fw/HANDOFF.md` が起点）。開発計画は
> [`fw/development-phases.md`](fw/development-phases.md)。

## 主な機能

**画像ビューア**
- **2D ビューア** — スタック表示、W/L プリセット、シネ、輝度校正（HU / SUV を一元管理）。
- **MPR** — 直交 3 断面のリスライス。ガントリチルト対応。
- **Slicer** — 任意角オブリークのリスライス → セカンダリシリーズとして保存。
- **Curved MPR** — 芯線に沿った 3 種の CPR（ストレッチ / ストレートン / 回転アンフォールド）。
- **3D ビューア（VTK.js）** — ボリューム/サーフェスレンダリング、シネマティックレンダリング
  （WebGL2 散乱 ＋ パストレーサ）、3D 計測・3D カット・Undo、芯線解析、
  内視鏡パス編集、ROI ↔ メッシュ変換、メッシュ修復、方向ギズモ。

**解析・定量**
- **ROI / マスク** — 2D ROI 描画・管理、マスク塗り。
- **SUV 校正** — PET の SUV 換算（body weight ほか）。
- **Fusion オーバーレイ** — PET/CT 等のフュージョン（LUT 継承・オーバーレイ W/L 上書き）。
- **テクスチャ解析（Radiomics）** — バックエンド RadiomicsJ 連携（設定 UI）。

**データ管理・通信**
- DICOM 保管庫（H2 ＋ ファイルシステム）、DIMSE（C-STORE SCP 等）、DICOMweb、REST。
- **Query / Retrieve**、リモート AE 送信、非 DICOM（動画等）取り込み。
- プラグイン機構、環境設定 / システム / ヘルプメニュー、日英 i18n。

> 座標・計測の実装方針は
> [`fw/cornerstone-3d-geometry-caveat.md`](fw/cornerstone-3d-geometry-caveat.md) を必読
> （3D ジオメトリは自前の患者 LPS mm 幾何で計算、cornerstone は表示のみ）。

## 構成

```
backend/    Spring Boot (Java 21)  — profile: web / standalone
frontend/   React + TypeScript + Vite — UI 全体
desktop/    Electron — standalone backend を spawn して UI をラップ
fw/         設計ドキュメント（ソース・オブ・トゥルース）
scripts/    開発起動・バージョン更新スクリプト
```

| モード | 構成 | backend profile |
|---|---|---|
| Web アプリ | ブラウザ + backend（外部 PACS via DICOMweb/BFF） | `web` |
| デスクトップ | Electron + backend（ローカル H2/FS） | `standalone` |

`GET /api/status` がアクティブな profile とバージョンを返し、UI（ステータスバー /
環境設定＞情報）に表示される。新機能は原則 standalone 前提、web 対応は機能ごとに後追い。

## 必要環境

- JDK 21 / Maven 3.6.3+
- Node.js 20+ / npm

## クイックスタート

```bash
make install        # frontend / desktop の依存をインストール

# デスクトップモード開発（Electron ウィンドウ、mode: standalone）— 主な検証方法
make dev-desktop        # または: bash scripts/dev-desktop.sh / npm run dev-desktop

# Web モード開発（ブラウザ http://localhost:5173、mode: web）
make dev-web            # または: bash scripts/dev-web.sh

# 本番 web jar 単体起動（UI 同梱、http://localhost:8080）
make run-web
```

> ルートで `npm run build` は禁止（Maven が走る）。フロントの型/ビルド確認は
> `cd frontend && npx tsc --noEmit` / `npx vite build`。

## バージョン変更

唯一のソースは `backend/pom.xml` の `<version>`。1 コマンドで全体（pom /
各 `package.json`）を同期する。`application.yml` の `@project.version@` フィルタで
表示バージョンは pom に自動追従する。

```bash
npm run set-version 1.2.3     # pom / frontend / desktop / root を一括更新
```

## リリース（GitHub Actions 自動）

- `push` / `PR` → CI（[`.github/workflows/ci.yml`](.github/workflows/ci.yml)）が
  backend ビルド＆テスト、frontend ビルド。
- タグ `v*` を push → [`release.yml`](.github/workflows/release.yml) が
  **UI 同梱 web jar** と **各 OS の Electron インストーラ**（AppImage / exe / dmg）を
  GitHub Release に自動添付。

```bash
npm run set-version 0.1.0 && git commit -am "release 0.1.0"
git tag v0.1.0 && git push && git push origin v0.1.0
```
