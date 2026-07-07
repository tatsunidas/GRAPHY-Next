# icons/ — アイコン単一ソース（web / standalone 共通）

このフォルダは GRAPHY-Next の**全アイコンの単一ソース**。
`frontend/public/` 配下なので Vite ビルドで `dist/` ルートへコピーされ、
**web モード（backend/BFF が配信）・standalone モード（Electron が `file://` で読込）の両方から同一パスで参照できる**。

## なぜここか

- `frontend/` は web・standalone で**同じビルド成果物**を使う。→ フロントの UI/ツールアイコンはここ 1 箇所に置けば両モードから使える。
- `vite.config.ts` は `base: "./"`。参照は必ず **相対パス** で書けば `file://`（Electron）でも解決できる。
- CSP は `img-src 'self' data: blob:`。同一オリジンのアイコンは許可済み。

## 構成

```
frontend/public/icons/
  app/     ブランド/アプリアイコン（web の favicon、デスクトップアプリアイコンのマスター）
  tools/   UI ツールバー等のツールアイコン
```

## 参照方法（コードから）

ツールアイコンは**レジストリ経由**で参照する。実体ファイルの直書きはしない:

```tsx
import { ToolIcon } from "../icons/ToolIcon";
import { TOOL_IDS } from "../viewer/toolIds";

<ToolIcon id={TOOL_IDS.length} size={18} />        // 登録済みツール ID から
<ToolIcon file="slicer.png" size={18} />           // レジストリ外は直接ファイル名で
```

レジストリを介さず素の URL が要る場合のみ相対パスで（絶対 "/icons/..." は file:// で壊れる）:

```tsx
<img src="./icons/tools/measure.png" alt="計測" />
```

### 新しいツールを追加するときの手順（重要）

1. アイコン PNG を `tools/` に置く。
2. `frontend/src/icons/toolIcons.ts` の `TOOL_ICON_FILES` に `ツールID → ファイル名` を 1 行追加。
3. 登録漏れは **dev 起動時に `verifyToolIcons()` が console に警告**する（`main.tsx` から呼ばれる）。

`import` してバンドルさせたい共有外アイコンは `frontend/src/assets/` 側でも可だが、
**web/standalone 両方から使う共有アイコンは原則この public/icons/ に集約する**こと。

## アプリアイコン（app_icon.png）の登録 — 実装済み

単一マスター = `app/app_icon.png`。以下の 3 経路に登録済み:

- **web の favicon**: `frontend/index.html` の `<link rel="icon" href="./icons/app/app_icon.png">`。
- **standalone の実行中ウィンドウ**（Linux/Windows のタスクバー/枠。macOS は無視し .icns を使う）:
  `desktop/main.js` の `APP_ICON` 定数 → 各 `BrowserWindow({ icon: APP_ICON })`。
  dev は `frontend/public/...` から、packaged は同梱された `renderer/icons/app/app_icon.png` から読む。
- **standalone のアプリ本体/インストーラ**: electron-builder が `desktop/build/icon.png`(1024×1024) から
  各 OS 用（.ico/.icns/.png）を自動生成する（`build/` は buildResources 既定なので自動検出）。

`app_icon.png` を差し替えたら `desktop/build/icon.png` を再生成する:

```
python3 scripts/gen-app-icon.py    # 依存: Pillow
```

## 命名規約

- 画像形式は **PNG / JPEG に統一**（SVG は使わない）。透過が要るもの・UI 系は PNG、写真系は JPEG。
- 小文字ケバブケース: `measure.png`, `zoom-in.png`
- ツールアイコンは高 DPI 対応のため実寸の 2〜3 倍解像度（例: 表示 24px なら 48〜72px）で用意し、`width`/`height` で縮小表示する。
- ブランドマスターは `app/icon-1024.png`（1024×1024 PNG）を推奨（デスクトップ用 ico/icns/png の変換元）。
