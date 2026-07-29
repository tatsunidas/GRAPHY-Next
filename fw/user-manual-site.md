# ユーザーマニュアル（mkdocs / GitHub Pages）

> 対象: `mkdocs.yml` / `docs/**` / `requirements-docs.txt` / `.github/workflows/docs.yml`
> 公開先: <https://tatsunidas.github.io/GRAPHY-Next/>

## 1. 何をどこに置くか（方針）

GRAPHY-Next のリポジトリには**製品本体（DICOM ワークステーション）だけ**を置く。
製品サイト（`graphy.vis-ionary.com` — トップ / ダウンロード / Lab / 法務）は別リポジトリ
`tatsunidas/vis-ionary-web` の `graphy-site/`（Astro）にある。

**ユーザーマニュアルだけは例外**として、このリポジトリ内に置く。理由:

- 本文が機能実装と同じ変更で古くなる。同じリポジトリなら 1 つの PR で本体とマニュアルを
  揃えられる。
- classic（`tatsunidas/GRAPHY`）が同じ構成（リポジトリ内 `docs/` ＋ GitHub Pages）で、
  <https://tatsunidas.github.io/GRAPHY/> を公開している。揃えたほうが読み手にも分かりやすい。

したがってリンクの向きはこうなる:

```
graphy.vis-ionary.com/lab  ──(How-to)──▶  tatsunidas.github.io/GRAPHY-Next   ← ここ（このリポジトリ）
                           ──(How-to)──▶  tatsunidas.github.io/GRAPHY        ← classic
```

## 2. 構成

classic の mkdocs 構成に合わせてある。**違いは PDF 出力（`mkdocs-with-pdf`）を入れていない
こと**だけ。classic は WeasyPrint 一式を CI に入れて PDF を作っているが、本文が揃うまでは
不要なので省いた（必要になったら classic の `docs.yml` から移植する）。

| ファイル | 役割 |
|---|---|
| `mkdocs.yml` | サイト設定と `nav`（章の並び）。テーマは material、`language: ja` |
| `docs/*.md` | 本文。`docs/images/` は README と共用（`icon.png` / `splash.png`） |
| `requirements-docs.txt` | ビルド依存。**MkDocs 2.0 は非互換なので `<2.0` に固定** |
| `.github/workflows/docs.yml` | PR ではビルド検証のみ、`main` push で Pages へ公開 |

`site/`（ビルド成果物）は `.gitignore` 済み。

### 章立て

| ページ | 状態 |
|---|---|
| `index.md` はじめに | 🟢 概要・2 モード・機能一覧・動作環境まで記載 |
| `install.md` インストールと起動 | 🟢 デスクトップ版 / Web 版（dcm4chee 連携）の手順を記載 |
| `main-screen.md` データベースウィンドウ | ⬜ 見出しのみ |
| `viewer2d.md` 2D ビューア | ⬜ 見出しのみ |
| `reformat.md` MPR / Slicer / Curved MPR | ⬜ 見出しのみ |
| `viewer3d.md` 3D ビューア | ⬜ 見出しのみ |
| `analysis.md` ROI・マスク・解析 | ⬜ 見出しのみ |
| `dicom-network.md` DICOM 通信 | ⬜ 見出しのみ |
| `plugins.md` プラグイン | ⬜ 見出しのみ |
| `settings.md` 環境設定 | ⬜ 見出しのみ |

⬜ のページには「このページは作成中です」の admonition と、予定している内容の箇条書きだけが
入っている。書き上げたら admonition を消す。

## 3. ローカルでの確認

```bash
python -m venv .venv-docs
.venv-docs/Scripts/python -m pip install -r requirements-docs.txt   # Windows
python -m mkdocs serve          # http://127.0.0.1:8000 で自動リロード
python -m mkdocs build --strict  # CI と同じ。リンク切れ / nav 漏れはエラーになる
```

`--strict` を通すこと。`nav` に無い `docs/*.md` を作ると警告→エラーになるので、
ページを増やしたら `mkdocs.yml` の `nav` にも足す。

## 4. 公開の手順（初回だけ必要な設定）

ワークフローは `actions/deploy-pages` を使う（`build_type: workflow`）。
**リポジトリ設定 ＞ Pages ＞ Source を「GitHub Actions」にしておかないと deploy ジョブが失敗する。**
これは Web UI からの操作が要るので、マージ後に一度だけ実施する。

以降は `docs/**` か `mkdocs.yml` を含む変更が `main` に入るたび自動で公開される。

## 5. 製品サイト側との連動

`vis-ionary-web` の `graphy-site/src/data/site.ts` にある `lab.sections` の
「GRAPHY-Next How-to」が、この Pages を指す。マニュアルが公開されるまでは「作成中」
バッジを出している。両者は別リポジトリなので、**章を書き足しても Lab 側の変更は不要**
（リンク先が同じため）。

## 6. TODO

- [ ] Pages を有効化（設定 ＞ Pages ＞ Source = GitHub Actions）
- [ ] ⬜ の章を埋める。スクリーンショットは `docs/images/` に置く
- [ ] 英語版（classic も未対応。`i18n` プラグイン導入の要否から検討）
- [ ] PDF 出力を入れるか判断（classic は `mkdocs-with-pdf`）
