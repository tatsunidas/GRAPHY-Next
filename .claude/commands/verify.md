---
description: 変更範囲を判定して frontend / backend の検証を実行する（単一ゲート）
argument-hint: "[frontend|backend|all]  省略時は変更範囲から自動判定"
allowed-tools: Bash, Read, Grep, Glob
---

このリポジトリの「緑/赤」を判定する唯一のゲート。エージェントは検証手段を推測せず、常にこれを使う。

## 1. 対象範囲を決める

`$ARGUMENTS` が `frontend` / `backend` / `all` なら、それに従う。省略時は変更範囲から自動判定する:

```bash
git status --short
git diff --name-only HEAD
```

- 変更が未コミットで存在しない場合は、直近コミットの変更範囲を使う: `git diff --name-only HEAD~1 HEAD`
- `frontend/src/**` `frontend/*.ts` `frontend/package.json` → **frontend**
- `frontend/portable/**` → **frontend (portable)** も追加
- `backend/**` → **backend**
- `desktop/**` は自動テスト対象外。実行せず「目視確認が必要」と報告する

## 2. 実行する

**frontend**（`frontend/` で実行）:

```bash
npm run typecheck
npm test
```

**frontend (portable)** が対象に含まれる場合は追加で:

```bash
npm run typecheck:portable
```

**backend**（`backend/` で実行）:

```bash
mvn -q -Dfrontend.skip=true test
```

守ること:

- `-Dfrontend.skip=true` を必ず付ける（付けないと frontend-maven-plugin が走り数分無駄になる）
- **リポジトリルートで `npm run build` を実行しない**（Maven が走る）
- `npm run build`（vite build）は重いので、このゲートでは既定で実行しない。バンドル生成に
  関わる変更（`vite.config.ts` / 依存追加 / `index.html`）があるときだけ追加で実行する

## 3. 報告する

**緑のとき** — 実行した内容を明示して 1 行で報告する:

```
verify: green — frontend typecheck + vitest (N tests), backend mvn test (M tests)
```

**赤のとき** — 推測で直さず、次を提示する:

1. 失敗したコマンドと、失敗したファイル・行
2. 原因の説明（1〜2 文）
3. 最小の修正案

そのうえで修正を適用し、**再度このゲートを最初から通す**。緑になるまで完了と報告しない。

## 注意

- frontend のテストは純ロジック（`src/**/*.test.ts`）のみで、**UI の振る舞いは自動テストで
  守られていない**。typecheck と vitest が緑でも、画面の動作確認が必要な変更はその旨を報告する。
- Electron 実機の確認が要る変更（packaging / `main.js` / `preload.js` / ネイティブダイアログ）は、
  このゲートの対象外であることを明示する。
