# 外部 AI のルーティング（ハーモナイズ）設計

> 起点は `fw/security.md` の「外部 AI への送信（AI egress ゲートウェイ）」。
> セキュリティ上の判断はあちらが正本で、ここには**複数提供元を扱う構造**を書く。
>
> 記録開始 2026-09-26。**段 5（設定で差を吸収・登録 UI・接続テスト）まで完了。**
> ✅ **合格条件は実機で満たした（§13）**——設定で既定を切り替えると、プラグインを直さずに宛先が変わる。
> 🔑 **規則: OpenAI 互換の口を持つ AI は設定だけで足せる。持たない AI はアダプタが要る**（§14）。
> 🚨 **各社の電文は実機未確認**（§12）。だから**接続テスト**を入れて利用者が確かめられるようにした（§14.2）。
> 🚨 **段 5c/5d のボタンは実機で押していない**（§14.5 の手順）。

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
| 3 | 提供元レジストリ＋設定 UI（一覧・用途ごとの既定・提供元ごとの鍵・**できること表**）。同意鍵に `providerId` | ✅ 2026-09-26（§11） |
| 4 | 2 本目のアダプタ（OpenAI 互換＝Azure も同時に入る）。以降は必要に応じて | ✅ 2026-09-26（§12） |

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


---

## 11. 段 3 でやったこと（2026-09-26）

### 入れたもの

| ファイル | 役割 |
|---|---|
| `desktop/aiProviders.js` | `ai-providers.json` の読み書きと**検査**。用途 → 提供元の解決 |
| `desktop/aiProviders.test.js` | 18 件。id の形・https 強制・既定の決め方・保存の往復 |
| `desktop/aiGateway.js` | レジストリ経由で宛先・モデル・鍵を解決。`resolveCapability()` を追加 |
| `desktop/aiGateway.test.js` | 10 件。**合格条件（既定の切り替えで宛先が変わる）を含む** |
| `desktop/secretStore.js` | allowlist を**形**で許す（`ai.provider.<id>.apiKey`） |
| `frontend/src/settings/AiPanel.tsx` | 用途ごとの既定・提供元一覧・できること表・提供元ごとの鍵 |
| `frontend/src/plugins/pluginAiApi.tsx` | 宛先の解決を main に委譲。同意鍵と表示を**解決後の提供元**に |

### 🔑 合格条件は検査で固定した

`aiGateway.test.js` の「合格条件: 既定を切り替えると宛先が変わる」——
設定画面がやることと同じ（既定だけ差し替えて保存）をして、解決結果が別の提供元・別の
エンドポイント・別のモデルになることを確かめている。**プラグインは 1 行も出てこない。**

### 判断したこと

- **解決の権限は main に 1 つだけ。** レンダラ側に同じ計算を持つと、同意画面に出す宛先と
  実際の宛先がずれる余地ができる。`graphy:ai-resolve` で問い合わせる形にした
- **宛先を確定してから鍵と同意を見る。** 宛先が分からないまま同意を取らせない
- **扱えない用途は選択肢に出さない。** 選べてしまうと、選んだあとで失敗する
  ——「選んだのに動かない」がいちばん分かりにくい
- **壊れた設定は捨てて残りで動かし、捨てた理由を画面に出す。**
  「設定が壊れていたので何もしない」は利用者から見て原因不明の沈黙になる
- **既定が壊れていたら、その用途を扱える最初の提供元へ落とす。**
  送れなくするより、使えるものを使うほうが利用者の意図に近い
- 🔑 **出荷時の Gemini は旧名の鍵（`ai.gemini.apiKey`）も見る。**
  版を上げた利用者が鍵を入れ直さずに済む。他の提供元に旧名は使わせない（鍵を共用しない）

### 段 4 へ持ち越すもの

- 2 本目のアダプタ（OpenAI 互換。Azure OpenAI も同じ `kind` で入る）
- 設定 UI からの**提供元の追加・編集**。いまは `ai-providers.json` を直接編集する
  （アダプタが 1 種類しか無いあいだ、CRUD 画面を作る価値が小さい）
- `graphy-art` メタデータの `provenance`（いまは既存の `model` 欄に本体が使ったモデルを入れている）


---

## 12. 段 4 でやったこと（2026-09-26）

### 入れたもの

| ファイル | 役割 |
|---|---|
| `desktop/aiAdapters/openai.js` | `openai` と `azure-openai` の 2 つの kind。文章は Chat Completions（JSON）、画像は Images Edits（multipart） |
| `desktop/aiAdapters/openai.test.js` | 15 件。パス・認証・multipart の組み立て・応答の解釈 |
| `desktop/aiGateway.js` | 送出部を一般化（**認証ヘッダと本文の形はアダプタが決める**）。kind → アダプタの表 |

扱える組み合わせ:

| kind | 画像→画像 | 画像→文章 | 認証 | 備考 |
|---|---|---|---|---|
| `gemini` | ✅ | ✅ | `x-goog-api-key` | 出荷時の既定 |
| `openai` | ✅ multipart | ✅ JSON | `Authorization: Bearer` | |
| `azure-openai` | ✅ multipart | ✅ JSON | `api-key` ＋ `?api-version=` | モデルはデプロイ名でパスに入る |

### 🚨 いちばん重要な但し書き — **実機未確認**

**この電文の形は実物の API に対して 1 度も送っていない。** 単体テストが固定しているのは
「組み立てと解釈が意図どおりか」だけで、「相手がそれを受け付けるか」は別の話。
各社の API は版が変わるので、**使い始めるときに 1 回だけ実際に送って確かめる必要がある。**

だから **出荷時の構成には入れていない**（`BUILT_IN` は Gemini のみ）。
利用者が `ai-providers.json` に書くまで一切使われないので、既存の利用者への影響はゼロ。

### 判断したこと

- **認証ヘッダはアダプタが持つ。** ゲートウェイで `x-goog-api-key` を決め打ちにしていたのを外した
  ——提供元ごとに載せ方が違うので、決め打ちのままだと足すたびに送出部を触ることになる
- **`openai` と `azure-openai` を別の kind にした。** 実装は同じだが**パスと認証が別**。
  同じ kind に混ぜると分岐が body の中まで漏れる。`endpoint` を自院のものにすれば、
  Azure でも自前ホストの OpenAI 互換サーバでも同じ形で扱える
- 🔴 **用途を指定しない呼び出し（0.3.0 のプラグイン）を Gemini 以外へ流さない。**
  あの形は `responseModalities` で応答の種類を言う Gemini の語彙で、他社の電文には
  対応する概念が無い。**勝手に画像生成へ読み替えると、文章が欲しかった呼び出しで
  画像を作って課金する。** `acceptsLegacyRequest` を Gemini だけ true にした
- 🔴 **`providerOptions` で画像と指示を上書きさせない。** JSON では `messages`、
  multipart では `image` / `prompt` を弾く。**送るものが変わってはならない**
- API バージョンの検査を緩めた（未指定を許し、Azure の `2024-10-21` 形も通す）。
  OpenAI の公開 API はパスに版を持たない

### 残っているもの

- 🚨 **実機確認**（§12 の但し書き）。OpenAI か Azure の鍵で 1 回ずつ送る
- 設定 UI からの**提供元の追加・編集**。いまは `ai-providers.json` を直接編集する
- `graphy-art` メタデータの `provenance`
- Claude / DeepSeek / Grok: 画像生成を持たない提供元は `image-to-text` だけの
  `models` を書けば扱える（アダプタは別途必要。Anthropic は電文が別）

---

## 13. 実機確認（2026-09-26）

✅ **合格条件（§7）は実機で満たした。** 利用者が Linux 機の `make dev-desktop` で、
段 3 の設定画面と段 2 の振り分けを一通り操作して確認済み。

### 確かめたこと

| 見たもの | 期待 | 結果 |
|---|---|---|
| 設定＞AI の「用途ごとの送信先」 | 用途ごとに既定を選べる | ✅ |
| **画像から文章の選択肢に、画像生成しか扱えない提供元が出ない** | 出ない | ✅ |
| Google Gemini の鍵の状態 | 旧名 `ai.gemini.apiKey` を引き継いで「設定済み」 | ✅ |
| **既定を別提供元へ切り替え → 鍵が無いので送信前に止まる** | `no-api-key` で同意より前に止まる | ✅ |
| **同じ画像・同じプラグインでも、提供元が変わると同意を出し直す** | 出し直す | ✅ |

🔑 **「別会社の鍵」は要らなかった。** 同じ Gemini を **id の違う 2 つの提供元**として置き
（2 つ目は `models` に `image-to-image` だけ書いて画像生成専用にする）、既定を切り替える。
確かめたいのは「**設定を変えると宛先が変わるか**」なので、これで足りる——課金も増えない。

🔑 **鍵の中身は要らなかった。** 実装は `hasApiKey`（有無）しか見ておらず、同意は送信の前段に在る。
だから **でたらめな文字列**を入れれば「同意が出し直されるか」まで確かめられ、送信は API 側で失敗する。
**検証のために本物の鍵を取り回さない。**
（🔴 `secretStore` には**復号して返す経路が無い**。読み出し口を作らないこと——有無だけ問い合わせる。）

### まだ確かめていないこと

- 🚨 **OpenAI / Azure の電文**（§12 の但し書き）。**ここは何も変わっていない。**
  上で確かめたのは「用途で振り分ける仕組み」で、**他社の電文が受け付けられるか**は別問題
- ⚠ **段 2 のプラグイン側**（`readGeneration` ＝ 正規化応答の読み出し）を通した**生成の成功**。
  今回の操作は「鍵が無い／でたらめ」で止まる経路なので、**正規化応答を実際に読む行に到達していない**。
  既定のまま 1 回生成すれば済む（gemini-public の鍵は在る）
- ⚠ 設定 UI からの提供元の追加・編集（未実装。`ai-providers.json` を直接編集する）

---

## 14. 段 5「どの AI が来ても足せる」（2026-09-27）

利用者の要求は 2 つ。**「OpenAI などはどこから登録できるのか」**（＝登録 UI が無い）と
**「より一般化できませんか。どの AI が来ても良いように。」**

### 🔑 抽象の形は正しかったが、下の層の決め打ちで「実際には足せなかった」

§4 の形（capability で束ね、できることを `models` というデータで持つ）は変えていない。
**足せなかったのは、その下の 6 か所が決め打ちだったから。** 設定項目をいくら増やしても、
これが残ると一般化にならない——**実測して見つけた**:

| 決め打ち | 何が登録できなかったか |
|---|---|
| `hostOf()` が host だけ返し、`endpoint` の**パスが黙って捨てられる** | OpenRouter（`/api/v1/…`）、Gemini の OpenAI 互換口 |
| **ポートが効かない**（`post()` の `host` にポート込みで渡していた。Node は解釈しない） | 自院ホスト全般（`:8443` / `:11434`） |
| **http を一切許さない** | 院内の Ollama / vLLM / LM Studio |
| `validModel` が**スラッシュを弾く** | OpenRouter 形式の `openai/gpt-4o` |
| **`auth` が no-op**（`p.auth === "api-key" ? "api-key" : "api-key"`） | 認証ヘッダ名が違う互換サーバ |
| `apiVersion` が**プラグイン経由でしか渡らない** | Azure の版指定（組み込み固定だった） |

🔑 **ポートと `auth` は「設計に書いてあるのに実装が無かった」**。§4.2 は `auth` を形の一部として
書いており、自院ホストを主目的に挙げていたが、どちらも動いていなかった。
**設計文書に書いてあることは、動いていることの証拠にならない。**

### 決めたこと

| 論点 | 決定 |
|---|---|
| 一般化の段 | **設定で差を吸収するところまで。** OpenAI 互換を共通語と決め、`auth`／`paths`／`pathStyle`／`apiVersion` を provider の設定にした。**応答の形を自動判別する層は作らない。電文を記述する言語も作らない** |
| 安全側の担保 | **接続テストを入れた**（§14.2） |
| 用途 | **2 つのまま**（`text-to-text` は足さない。本体に「文章だけ送る」機能が無く、使い道がない） |
| 平文 http | **院内アドレスだけ許す**（loopback・RFC1918・単一ラベル名・`.local`/`.internal`/`.lan`）。許した提供元には `plaintext: true` を付け、**一覧・疎通結果・同意ダイアログに印を出す** |

**規則はこう言える**: **OpenAI 互換の口を持つ AI は、設定だけで足せる。持たない AI はアダプタが要る。**
実際には Gemini も Anthropic も OpenAI 互換の口を公開しているので、実用上はほぼ「どの AI でも」になる
（🚨 ただし**各社の互換口は実機未確認**。§14.2 のボタンで利用者が確かめる）。

### 14.1 断ったこと（後から必ず要望が来るので理由を残す）

🔴 **追加ヘッダ（`headers`）を UI に出さない。** 自由記入欄を出すと利用者は**必ず
`x-api-key: sk-…` を貼る**。すると鍵が `ai-providers.json` に**平文**で入り、
`ai-providers-get` でレンダラ（＝プラグイン）へ返る——`secretStore` の
「復号値を main の外へ出さない」を**設定データが迂回する**。JSON を手で書く人のために受理と検査だけ
実装し、欄は Anthropic アダプタを入れるときに出す。**いま実際に要るヘッダも無い。**

🔴 **`Host` を書かせない。** 差し替えると、同意ダイアログが出す送信先（解決後の `endpoint`）と
**実際に届く先が乖離する**。§5 の「同意に宛先を含める」が設定で壊れる。
`Content-*` / 認証ヘッダ / `proxy-*` も同様に拒否し、**値が鍵に見えたら拒否**する。

🔴 **`paths` に差し込み（`{model}`）を入れない。** 入れた瞬間に「電文を記述する小さな言語」が
始まり、エンコードの問題が戻ってくる。**固定文字列の完全置換のみ。** クエリも拒否
（アダプタの `?api-version=` と合成すると壊れ、原因が設定かアダプタか分からなくなる）。

🔴 **`azure-openai` を `pathStyle` へ畳まない。** `save()` は正規化結果を書き戻すので、
**既定を 1 回変えただけで利用者のファイルが新形式になり、版を戻せなくなる**。
`effectiveStyle()` が kind と `pathStyle` の**どちらでも**Azure 扱いにするので、
既存のファイルとテスト 15 件はそのまま通る。

🔴 **リダイレクトを追わない**（302 で鍵と患者画素が同意していないホストへ行く）／
**`rejectUnauthorized:false` を入れない**（自院ホスト対応で必ず要望が来るが、証明書を
確かめずに患者画素を出す口は作らない）／**`timeoutMs` を設定にしない**（`inFlight` が 1 本なので
1 提供元で全機能を止められる）／**`providerOptions` を provider 設定に持たせない**
（送るものが設定で変わると同意画面と乖離する）。

### 14.2 接続テスト（疎通確認）

🔑 **存在理由**: 利用者が自分で提供元を足せる形にした以上、**私たちが全社を事前に検証することは
できない**。だから「登録したら押して確かめる」手段を本体が持つ。これが無いと**最初の 1 回が
必ず患者画像での試行**になり、失敗しても原因（鍵・パス・応答の形）が切り分けられない。

⚠ **プラグインからこの口を呼べなくすることは技術的に不可能**（プラグインは動的 `import()` で
レンダラと同じ realm に入るので、`contextBridge` の口は全部見える）。だから
**アクセス制御ではなく「悪用しても意味がない形」**にした:

- 渡せるのは **`providerId` と `capability` だけ**。指示（`"Reply with OK."`）と画像
  （**1×1 の白 PNG・69 バイト**）は main 内の定数。**患者画像は出ない**
- 本番送信と**同じ錠（`inFlight`）を共有**＋最短間隔 3 秒
- **画像生成の疎通は 1 枚生成＝課金**なので main の `showMessageBoxSync` で確認（迂回不能）
- 監査ログに 1 行（`[ai] connection-test provider=… host=…`）
- 🔴 返すのは **`verdict`（何を直せばよいかの分類）**と**ヘッダ名だけ**。認証ヘッダ名を設定で
  選べる以上、どのヘッダに鍵が載るかは固定できないので、**値を返す経路そのものを作らない**
- 🔑 **`generate()` と同じ `adapter.buildRequest` を通る。** 別経路で組むと設定の効き方を
  確かめられず、作る意味がなくなる

### 14.3 検証の限界

⚠ **UI コンポーネントのテスト環境がこのリポジトリに無い**（vitest は node 環境・jsdom も
testing-library も無い）。→ **押す操作は実機でしか守れない**（CLAUDE.md ルール 9）。
そのぶん、間違えると実害が出る変換（空欄＝未指定・`prefix:""` の扱い・往復・コードの訳し方）を
**純関数に切り出して固定**し、押すボタンには `data-testid` を付けた。

### 14.4 残っているもの

- 🚨 **実機確認**（段 5c・5d のボタン）。§14.5 の手順
- 🚨 **各社の互換口の電文**（§12 の但し書きは生きている）。接続テストで利用者が確かめる形にした
- `graphy-art` メタデータの `provenance`（`plaintext` は足した）
- Anthropic のネイティブ電文（互換口を使うならアダプタは要らない）
- 追加ヘッダの UI（Anthropic アダプタと同時）

### 14.5 実機で押すもの（ルール 9）

1. 設定＞AI で **既定の Gemini に「接続を確かめる」**（画像から文章）。`reachable` と
   リクエストラインが出ること。**ここで §12 の「実機未確認」が初めて閉じられる**
2. **提供元を追加**（例: Gemini の OpenAI 互換口 —— `kind: OpenAI 互換` ＋
   `endpoint: https://generativelanguage.googleapis.com` ＋
   `paths` の画像から文章に `/v1beta/openai/chat/completions`）。
   🔑 **同じ会社へ 2 つの電文で到達できる**ことが「どの AI が来ても」の実証になる
3. 保存時に **main の確認ダイアログ**が出ること（送信先が増えるため）
4. **接続テスト**で通ること（鍵は同じもの）
5. **既定を切り替え**（確認ダイアログは出ないこと）→ Art of Imaging が動くこと
6. **削除**（確認 → 鍵も消える → 既定が戻った旨が出る）→ **再起動して鍵が残っていないこと**
