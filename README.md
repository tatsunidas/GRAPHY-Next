# GRAPHY-Next

GRAPHY の Web 化（リファクタリング版）。Spring Boot バックエンド ＋ React フロントエンドを、
**Web アプリ** と **Electron デスクトップアプリ** の 2 モードで動かす最小構成。

> 開発 Phase 計画は [`fw/development-phases.md`](fw/development-phases.md) を参照。

## 構成

```
backend/    Spring Boot (Java 21)  — profile: web / standalone
frontend/   React + TypeScript + Vite — /api/status を表示する最小 UI
desktop/    Electron — standalone backend を spawn して UI をラップ
scripts/    開発起動スクリプト
Makefile    ビルド/起動オーケストレーション
```

モードの意味付け:

| モード | 構成 | backend profile |
|---|---|---|
| Web アプリ | ブラウザ + backend | `web` |
| デスクトップ | Electron + backend | `standalone` |

`GET /api/status` がアクティブな profile を返し、UI に「起動モード」として表示される。

## 必要環境

- JDK 21 / Maven 3.6.3+
- Node.js 20+ / npm

## クイックスタート

```bash
make install        # frontend / desktop の依存をインストール

# Web モード開発（ブラウザ http://localhost:5173、mode: web 表示）
make dev-web

# デスクトップモード開発（Electron ウィンドウ、mode: standalone 表示）
make dev-desktop

# 本番 web jar 単体起動（UI 同梱、http://localhost:8080）
make run-web

# 全配布物ビルド（web jar + Electron 同梱準備）
make build
```

## リリース

- `push`/`PR` → CI（`.github/workflows/ci.yml`）が backend ビルド＆テスト、frontend ビルド。
- タグ `v*` を push → `release.yml` が **UI 同梱 web jar** と **各 OS の Electron インストーラ**を
  GitHub Release に自動添付。

```bash
git tag v0.1.0 && git push origin v0.1.0
```
