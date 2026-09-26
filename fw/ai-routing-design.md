# 外部 AI のルーティング（ハーモナイズ）設計

> 起点は `fw/security.md` の「外部 AI への送信（AI egress ゲートウェイ）」。
> セキュリティ上の判断はあちらが正本で、ここには**複数提供元を扱う構造**を書く。
>
> 記録開始 2026-09-26。**段 2（契約の提供元非依存化）まで完了。段 3 以降は未着手。**

## 1. なぜ要るのか

いま外部 AI は **Gemini 1 社に貼り付いている**。利用者の判断:

> 「claude, openai, gemini, grok, deepseek など、多くの生成 AI が利用できる中で、
> 何か一つだけしか使えないような状況は望ましくない」

🔑 **これは Art of Imaging プラグインの機能ではなく、本体側の機能。** 提供元の差を
プラグインに吸収させると、プラグインごとに実装が生え、鍵の持ち方も同意の出し方も
ばらばらになる。**外部送信の経路が把握できなくなる**のが最も困る。入口を本体に 1 つ持つ。

### 貼り付いている場所（2026-09-26 実測）

| 場所 | 貼り付き方 |
|---|---|
| `desktop/aiGateway.js` | `HOST` / `SECRET_KEY` が定数。body は `contents[].parts[]`＝Gemini の形 |
| プラグイン側 | **本体は生 JSON を返すだけ**。`plugin-art/src/core/parse.ts` が `candidates[].content.parts[]` を読む |
| `desktop/secretStore.js` | `ALLOWED_KEYS = {"ai.gemini.apiKey"}` の 1 本 |
| `graphy-plugin.d.ts` | `model` / `apiVersion` / `responseModalities`＝**Gemini の語彙をそのまま**公開契約にしている |

---

## 2. 🔴 いちばん重要な判断 — 「提供元」で束ねない

**全部の AI を等しく使える形にはできない。**

Art of Imaging が要るのは**画像生成**で、Claude と DeepSeek は（2026-05 時点の知識では）
画像を生成しない。提供元を平らに並べて利用者に選ばせると、**Claude を選んだ瞬間に
Art of Imaging が失敗し、プラグインのせいに見える。**

さらに各社の品揃えは変わる。**だから「何ができるか」をコードではなく設定データで持つ。**

→ 束ねる単位は提供元ではなく**用途（capability）**。v1 は 2 つだけ。

| 用途 | 意味 | 使う機能 |
|---|---|---|
| `image-to-image` | 画像＋指示 → 画像（＋任意のテキスト） | Art of Imaging の作品生成 |
| `image-to-text` | 画像＋指示 → テキスト | Art of Imaging の鑑賞文 |

チャット・ツール呼び出し・ストリームは**入れない**。いま製品が実際に使っているのはこの 2 つだけで、
提供元間の差が大きい領域まで抽象すると、抽象そのものが当たらなくなる。

---

## 3. 契約（プラグインから見た形）

### 3.1 要求 — 用途を頼む。宛先を名指ししない

`AiGenerationRequest` を**加算で**拡張する。🔴 既存プラグインを壊さないため、Gemini 語彙の
フィールドは受け付けたまま deprecated にする（1 リリース分は両方通す）。

```ts
capability?: "image-to-image" | "image-to-text";   // これが主
providerOptions?: Record<string, unknown>;          // 提供元固有の追い込み。**無くても動くこと**
/** @deprecated capability を使う */ model?: string; apiVersion?: string; responseModalities?: string[];
```

🔴 **プラグインに宛先を名乗らせない。** 用途を頼むだけにすることで、CSP・同意・監査・鍵が
本体の 1 か所に留まる。プラグインがホスト名を持てるようにした時点でこの性質が失われる。

### 3.2 応答 — 正規化を本体へ移す（**この 1 点が本質**）

いまプラグインが `candidates[].content.parts[]` を読んでいる。これを本体のアダプタへ移す。

```ts
{ ok: true;
  image?: { bytes: Uint8Array; mimeType: string };
  text?: string;
  provenance: { providerId: string; kind: string; model: string; endpointHost: string };
  /** @deprecated 移行期間だけ残す生 JSON */ data?: unknown }
```

**これをやらないと、提供元が増えた瞬間にプラグインごとに解釈が生える。**
逆にここを本体に寄せれば、**プラグインは 1 行も直さずに提供元が切り替わる**——
それが機能全体の合格条件（§7）。

---

## 4. 提供元の設定

### 4.1 置き場所は Electron main（backend の設定に置かない）

AI は元から desktop 専用（`host.ai` は web で `desktop-only` を返す）。
`secrets.enc.json` の隣へ `ai-providers.json` を置く。

🔴 **backend の Settings（H2）に置かない。** `GET /api/settings` が平文で全件返すため、
レンダラ・プラグイン・DB バックアップ・ログの全経路から読める
（`fw/security.md`「API キーは backend の設定に置かない」と同じ理由）。
鍵でない項目（接続先・モデル名）も、どこへ送る設定かは監査の対象なので同じ場所に置く。

### 4.2 形 — 「名前」ではなく「種類＋接続先＋認証」

```jsonc
{ "providers": [
    { "id": "gemini-public", "kind": "gemini",
      "endpoint": "https://generativelanguage.googleapis.com", "auth": "api-key",
      "models": { "image-to-image": "gemini-3.1-flash-image", "image-to-text": "gemini-2.5-flash" } },
    { "id": "azure-hosp", "kind": "openai", "endpoint": "https://xxx.openai.azure.com",
      "auth": "api-key", "models": { "image-to-image": "gpt-image-1" } } ],
  "defaults": { "image-to-image": "gemini-public", "image-to-text": "gemini-public" } }
```

- `kind` がアダプタ（電文の形）を決め、`endpoint` が**企業・院内向け**を吸収する
  （Azure OpenAI / Vertex AI / Bedrock / 自院ホスト）。医療では「自院テナント経由のみ許可」が
  現実的な要件になりやすいので、**最初から名前と接続先を分ける**
- 🔑 **`models` に無い用途は「その提供元では使えない」。** できることが**データ**なので、
  各社の品揃えが変わっても本体を直さない。設定画面はこれを表で見せ、
  **使えない組み合わせを選ぶ前に分かる**ようにする
- 用途ごとの既定は 1 つ（`defaults`）。全プラグインがそれに従う

### 4.3 鍵

`secretStore` のまま。allowlist を接頭辞 `ai.provider.<id>.apiKey` へ広げる。

🔴 **`<id>` は `^[a-z0-9-]{1,32}$` で検査する。** allowlist は
「レンダラから任意の名前で書ける素朴な平文 KVS にしない」ために在る。接頭辞にするときに
検査を入れ忘れると、その目的が消える（`../` や長大な名前でファイルを作られる）。

暗号化が使えない環境で**平文保存に落ちない**方針は変えない。

---

## 5. 🔴 同意に宛先を含める（安全上の必須）

いま同意を覚える鍵は `pluginId::scopeKey`（`frontend/src/plugins/pluginAiApi.tsx`）で、
**宛先が入っていない。** 提供元が増えると **Google への同意が xAI への送信を黙って許す。**
同じ画像でも送り先が違えば別の外部送信である。

- 鍵を **`pluginId::providerId::scopeKey`** にする
- 同意ダイアログの「送信先」は定数 `AI_HOST` ではなく**解決後のエンドポイント**を出す
- 監査ログ（`[ai] egress ...`）に `providerId` を足す。**画像そのものは残さない**方針は変えない

---

## 6. やらないこと（意図的に）

- **CSP を広げない。** 提供元が増えても Electron main を通す。`connect-src` に宛先を足すと
  レンダラ上のあらゆるコードがそこへ到達でき、**同意も監査も通らない送信経路が常時開く**。
  加えて dev は CSP を注入しないので「開発では動くが配布だけ壊れる」形になる（v0.2.1〜0.2.3 の実例）
- 復号した鍵を IPC で返さない
- プラグインに宛先を名乗らせない
- 本体は**電文の形だけ**を正規化する。医用的な意味の解釈はしない

---

## 7. 段取り（この順序が重要）

| 段 | 内容 | 状態 |
|---|---|---|
| 1 | 設計の確定（この文書）。`graphy-plugin.d.ts` の Gemini 語彙に deprecated を書く | ✅ 2026-09-26 |
| 2 | `capability` ＋ 正規化応答。**アダプタは Gemini 1 本のみ。** Art of Imaging を移す。利用者から見た挙動は変えない | ✅ 2026-09-26（§10） |
| 3 | 提供元レジストリ＋設定 UI（一覧・用途ごとの既定・提供元ごとの鍵・**できること表**）。同意鍵に `providerId` | 未着手 |
| 4 | 2 本目のアダプタ（OpenAI 互換＝Azure も同時に入る）。以降は必要に応じて | 未着手 |

🔑 **段 2 を段 3 より先にやる。** 提供元が 1 つのうちに契約を提供元非依存へ変えておけば、
何も壊れない。逆順にすると「契約の変更」と「提供元の増加」が同時に起きて、
**どちらが壊したのか分からなくなる。**

### 合格条件（機能全体）

**設定で `image-to-image` の既定を別の提供元へ切り替えたとき、
Art of Imaging を 1 行も直さずにそちらへ送られること。**

---

## 8. 触るファイル

| ファイル | 変更 |
|---|---|
| `desktop/aiGateway.js` | 中継のみに戻し、用途→提供元の解決とアダプタ呼び出しへ |
| `desktop/aiAdapters/gemini.js`（新規） | body 組み立てと応答の正規化 |
| `desktop/aiProviders.js`（新規） | `ai-providers.json` の読み書きと検査 |
| `desktop/secretStore.js` | allowlist を接頭辞へ（id の形を検査） |
| `desktop/preload.js` / `frontend/src/desktopBridge.ts` | 提供元一覧・既定の取得と保存の IPC |
| `frontend/src/settings/AiPanel.tsx` | 1 鍵の画面 → 提供元一覧。複数エントリ UI は `RemoteAePanel.tsx` が手本 |
| `frontend/src/plugins/pluginAiApi.tsx` | 同意鍵に `providerId`、宛先表示を解決後のものへ |
| `examples/plugin-template/graphy-plugin.d.ts` | `capability` / 正規化応答を加算 |

🔴 **アダプタは `electron` を import しないこと。** `desktop/` のテストは
`node --test` で **`npm install` 無し**に走る（CI の Desktop ジョブ）。
electron に触ると **`Cannot find module 'electron'` でファイルごと落ちる**
——2026-09-24 に実際に CI を赤くした。

**下流**: `graphy-art` メタデータは `model` しか持たない。提供元が増えると
「どこで作られたか」が辿れないので `provenance` を足す必要がある
（プラグイン側＋投稿ギャラリーの表示）。v1 の範囲外だが、**作品の再現性に関わるので段 3 までに決める。**

---

## 9. 検証

```bash
cd desktop  && node --test                                   # アダプタの正規化
cd frontend && npx vitest run src/plugins src/settings && npm run typecheck
cd backend  && mvn -q -Dfrontend.skip=true test
```

- **アダプタ**: 提供元の応答固定データ → 画像とテキストが正しく取れる。壊れた JSON で落ちない
- **secretStore**: 接頭辞の検査（`../`・大文字・長すぎる id を弾く）
- 🔴 **同意**: 提供元 A で「記憶する」に印を付けても、**提供元 B への送信では同意を出し直す**
- **実機**: §7 の合格条件。`automator/plugins/` に用途を頼むだけの検証プラグインを置く


---

## 10. 段 2 でやったこと（2026-09-26）

**利用者から見た挙動は変えていない。** 変えたのは契約と、差の吸収場所。

### 入れたもの

| ファイル | 役割 |
|---|---|
| `desktop/aiAdapters/gemini.js` | 用途 → 要求 body、応答 → **提供元非依存の形**。electron を import しない純関数 |
| `desktop/aiAdapters/gemini.test.js` | 11 件。応答の固定データで正規化を縛る |
| `desktop/aiGateway.js` | アダプタ経由に。`image` / `text` / `blockReason` / `provenance` を返す |
| `frontend/src/plugins/pluginAiApi.tsx` | `capability` を受け、用途 → モデルを解決。同意鍵に提供元を含める |
| `examples/plugin-template/graphy-plugin.d.ts` | `AiCapability` / 正規化応答 / `AiProvenance` を加算 |

プラグイン側（別リポジトリ）は `capability` を頼むだけになり、**モデル名を持たなくなった**。
新旧どちらの本体でも読めるよう `readGeneration()` を 1 か所に置いてある。

### 🔴 途中で見つけた既存の不具合 — 設定のモデルが効いていなかった

`AI_MODEL_KEY`（`ai.gemini.model`）は**設定画面が書き込むだけで、誰も読んでいなかった。**
プラグインが自前の定数（`MODEL_FALLBACK`）を使っていたため、**利用者が環境設定でモデルを
変えても何も起きなかった。** 用途 → モデルの解決を本体に置いたことで、設定が初めて効くようになった。

⚠ 画像用とテキスト用は別のモデルなので、**1 つの設定では両方を賄えない**。
`image-to-text` 側は `ai.gemini.textModel` を読むが、**設定 UI はまだ無い**（段 3）。
いまは既定 `gemini-2.5-flash` が使われる。

### 同意の単位に提供元を入れた

`pluginId::scopeKey` → **`pluginId::AI_PROVIDER_ID::scopeKey`**。
提供元が 1 つのうちに入れておくのが狙い——増えてから入れると、それまでに覚えた同意が
新しい提供元にも効いてしまう移行期間が生まれる。

### 段 3 へ持ち越すもの

- `ai-providers.json`（提供元レジストリ）。いまは `aiGateway.js` の `PROVIDER` 定数
- `secretStore` の allowlist を接頭辞へ（いまは `ai.gemini.apiKey` の 1 本）
- 設定 UI（提供元一覧・用途ごとの既定・**できること表**・`image-to-text` のモデル欄）
- `graphy-art` メタデータの `provenance`。いまは既存の `model` 欄に
  **本体が実際に使ったモデル**を入れている（それまではプラグインの定数だった）
