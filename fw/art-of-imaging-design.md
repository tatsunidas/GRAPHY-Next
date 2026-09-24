# Art of Imaging 設計

放射線医学的な創造作品（AI 生成作品）を作るための機能。*Radiology Advances* 誌の "Art of Imaging" のように、画像科学と美学を結びつけることが目的。

**GRAPHY-Next 側の責務は生成だけ。** 展示・投稿は後段で作る VIS の Web サービスが担う。

実体は 2 つに分かれる。

| | 置き場 | ライセンス |
|---|---|---|
| 汎用のホスト API（秘密情報・外部送信・保存） | 本体 | AGPL-3.0-or-later |
| Art of Imaging そのもの（画家・プロンプト・署名・メタデータ） | `graphy-next-plugin-art`（別リポジトリ） | MIT |

---

## 1. なぜこの分け方なのか

プラグインの `ui.js` は単体では**ネットワークにもファイル保存にも到達できない**。

製品ビルドの CSP（`frontend/vite.config.ts` の `cspPlugin`）が
`connect-src 'self' http://localhost:* http://127.0.0.1:*` を注入するため、
`generativelanguage.googleapis.com` はレンダラから叩けない。
**しかも dev では CSP を注入しない**ので、レンダラ直叩きは「開発では動くが配布ビルドだけ壊れる」
という最悪の壊れ方をする（v0.2.1〜v0.2.3 の実例）。
既存の `graphy-next-plugin-gemini-findings` が JAR を持つのはこの理由。

そこで、外部送信と保存を**本体のホスト API** として出す。`fw/plugin-explainer.md` §7 が
「将来の host API 拡張の候補」として自ら挙げていた箇所であり、Art 専用の逃げ道ではない。

この結果、**Art プラグインは JAR を持たずに済む**。JAR を持てば OS 別配布・署名・
アプリと同格の権限がついて回るので、これは実利のある副産物である。

---

## 2. 秘密情報（API キー）

**置き場は Electron main の `safeStorage`。** `desktop/secretStore.js`。

backend の設定（`SettingsService`）に置かない理由は単純で、設定は H2 の平文行になり
`GET /api/settings` が全件を丸ごと返すため。そこへ API キーを入れると、レンダラ・
プラグイン・DB バックアップ・ログの全経路から平文で読めてしまう。
OS のキーチェーン（Windows=DPAPI / macOS=Keychain / Linux=libsecret|kwallet）に
触れられるのは main プロセスだけなので、置き場は必然的にそこになる。

約束事:

- **復号値をレンダラへ返す IPC を作らない。** 平文が main の外へ出る経路を存在させない。
  レンダラが知れるのは `statusOf` が返す「入っているか」「永続化できたか」「暗号化が使えるか」だけ。
- **暗号化が使えない環境で平文保存に落ちない。** `safeStorage.isEncryptionAvailable()` が false
  （libsecret/kwallet 不在の Linux 等）なら永続化を断り、セッション内のメモリ保持だけにして、
  その事実を UI へ返す。黙って弱い保存に落ちるほうが、使えないことより危険。
- **保存できるキー名は allowlist で固定。** 任意の名前で書けると素朴な平文 KVS として濫用される。

ファイルは `<dataDir>/secrets.enc.json`（0600）。dataDir は backend の CWD と同じ
（H2・DICOM 保管庫と同じ場所にユーザーデータを集める）。

設定 UI は `frontend/src/settings/AiPanel.tsx`。registry のフィールドにしないのは上と同じ理由で、
`password` 型を足しても値は平文で H2 に載るため。モデル ID と API バージョンは平文で構わないので
通常の設定に置く。

---

## 3. 外部送信のゲート（`ai-egress`）

`frontend/src/plugins/pluginAiApi.tsx` が唯一の入口。順に 4 つを通す。

1. **`ai-egress` 権限**の確認。`plugin.json` の `permissions` に宣言が無ければ拒否。
2. **API キーの有無**の確認（無いまま同意だけ取らせない）。
3. **同意**。`AiEgressConsentDialog` が、**これから送る画像そのもの**・**プロンプト全文**・
   宛先ホスト・プラグイン ID・無料枠の注意を出す。確認チェックを入れるまで送信ボタンは押せない。
4. **監査ログ**。いつ・どのプラグインが・どこへ・何バイト・何文字の指示で出したかを残す。
   **画像そのものは残さない**（ログに患者画素を溜めない）。

`ai-egress` は**本プロジェクトで初めて実際に強制される権限**である。
これまで `permissions` は宣言のみで、インストール時の一覧表示（`PluginConsentDialog`）に
しか使われていなかった。i18n の `pluginmgr.consent.permissions` の文言もそれに合わせて改めた。

そのために `PluginManifest` へ**トップレベルの `permissions`** を足した。従来は
`Backend.permissions` にしか載らず、`entrypoint`（JAR）を持たない UI 完結プラグインでは
値がフロントへ届かなかった——外部送信を要求するのはまさに UI 完結プラグインなので、
それでは強制のしようが無い。

同意の記憶は**セッション内・同一 `scopeKey`（シリーズ UID）**に限る。
全面的な無効化は用意しない。一度押したきり誰も中身を見なくなるため。

`ai` / `file` は各画面の `makeHost` に作らせず、`launchPlugin` が一箇所で注入する
（`PluginHostSeed`）。呼び出し側に組み立てさせると、マニフェストの渡し忘れがそのまま
権限チェックの素通りになる。

同意ダイアログは本体のツリー内に置いた `AiEgressConsentHost` が `createPortal` で出す。
`createRoot` で独立したルートを立てると `useI18n must be used within I18nProvider` で落ちる
（`pluginSeriesPanelApi.tsx` に同じ轍がある）。2D ビューアとメイン画面は別ウィンドウ＝
別ルートなので、**両方に置く**。

---

## 4. 画素の扱いと PHI

送信画像は**画素から自前でレンダする**。表示中のキャンバスを `toDataURL` で掴む方法は採らない。

- `preserveDrawingBuffer=false` のとき空になり得る
- **オーバーレイ（患者名・スケールバー）は DOM の別要素**なので、掴めるかどうかが実装の都合で変わる

画素から描けば、患者情報が入り込む経路が構造的に消える。W/L は視覚モデルに渡すので意図的に適用する
（`xaFrameExport.ts#applyWindow` と同じ式）。

プロンプトに載る DICOM 由来の情報は **Modality と BodyPartExamined の 2 つだけ**。
「PatientName を除く」式の拒否リストは採らない——除き忘れた 1 つが即座に漏洩になり、
タグが増えるたびに穴が空く。

さらに**値も既定用語の allowlist で照合する**。文字種フィルタだけでは足りない:
`CT^YAMADA TARO` は「英数字と空白だけ残す」を通すと `CT YAMADA TARO` になり、氏名が生き残る。
これは実装時にテストが実際に捕まえた穴である（`test/prompt.test.ts`）。
既定用語に一致しない値は捨てる。部位名が 1 つ落ちることより、氏名が 1 つ載るほうが重い。

BodyPartExamined はホスト API から読めない（タグ読み出しの API が無い）ので、
UI では既定用語の一覧からの任意選択にした。**一覧そのものが allowlist** なので穴が開かない。

---

## 5. 保存と識別

保存は `dialog.showSaveDialog`（`graphy:save-file`）。
本体にはこれまで Save-As が無く、書き出しは全部タイムスタンプ名の自動ダウンロードだった。
**「同名なら上書き確認」は OS のダイアログが標準で出す**ので、自前実装しない。

生成情報は PNG の `iTXt`（キーワード `graphy-art`）へ JSON で埋める。

**ハッシュの対象はファイルではなく生画素。** ファイル全体のハッシュを撮ると、
メタデータを埋め込んだ瞬間に値が変わり、メタデータ内に書いた自分自身のハッシュと食い違う。

### 識別の強度について、正直に

メタデータは再エンコード・スクリーンショット・SNS へのアップロードで簡単に消える。
だから Web 側は三層で見る。

| 層 | 用途 | 剥がされたとき |
|---|---|---|
| `graphy-art` メタデータ | GRAPHY 製である一次判定 | 消える |
| `pHash`（**サーバ側で再計算**して突合、距離 ≤ 5） | 重複登録の検知 | 効く |
| `imageSha256`（生 RGBA の SHA-256） | 完全同一の検知 | 効く |

埋め込まれた値をそのまま信用して比較しないこと（書き換えるだけで回避できる）。
**いずれも改ざん耐性は無い。** 真の来歴保証が要るなら将来 C2PA を検討する。

pHash の縮小は**ボックス平均**で行う。最近傍で間引くと 1 画素ごとのノイズがそのまま残り、
JPEG 再圧縮やリサイズへの耐性を失う（実測で同一画像の劣化版とのハミング距離が 0〜26 まで暴れた）。

---

## 6. 画家カタログ

**パブリックドメインの画家のみ。** 判定は単純な「没後 70 年」ではなく、日本の**戦時加算**
（連合国民が 1941/12/7 以前に取得した著作権に最大約 10 年 5 か月）を織り込んだ
**没年 1944 年以前**。単純に「今年 − 70」で切ると、マティス（1954 没）のように
「死後 70 年は過ぎたが日本ではまだ保護期間内」の画家を取り込む。

画風・様式それ自体は著作権の保護対象ではない。実際のリスクは
(a) 特定の保護作品の再現 (b) 存命作家の人格権・パブリシティ (c) モデル側のポリシー拒否
の 3 つで、PD の画家に限れば実務上ほぼ回避できる。プロンプトでも
「特定作品の複製ではなく様式の翻案」であることを明示する。

UI の一次軸は**様式**、その下で**画家を 1 名だけ**選ぶ。

---

## 7. 鑑賞説明

画像と説明は 1 回の呼び出しで受け取る（`responseModalities: ["TEXT","IMAGE"]`）。

**モダリティはローカルの DICOM 値を正とし、モデルの出力で上書きしない。**
モデルに事実を捏造させないため。

説明には必ず注意書きを添える（`report/analysisResults.ts` の `caveats` 規範に合わせ、
**末尾ではなく内容の直後**に置く）。最低限「AI が生成した鑑賞用の記述であり、
診断・所見ではない」を常に出す。

---

## 8. 関連ファイル

**本体**
`desktop/secretStore.js` / `desktop/aiGateway.js` / `desktop/main.js`（IPC 3 種）/ `desktop/preload.js` /
`frontend/src/desktopBridge.ts` / `frontend/src/plugins/pluginAiApi.tsx` /
`frontend/src/plugins/AiEgressConsentDialog.tsx` / `frontend/src/plugins/pluginFileApi.ts` /
`frontend/src/plugins/pluginTypes.ts` / `frontend/src/plugins/pluginRegistry.ts` /
`frontend/src/settings/AiPanel.tsx` / `frontend/src/settings/registry.ts` /
`backend/.../plugin/PluginManifest.java` / `FileSystemPluginRegistry.java`

**プラグイン**（`graphy-next-plugin-art`）
`src/core/{painters,styles,prompt,render,signature,pngMeta,phash,parse,metadata}.ts` /
`src/ui/ArtDialog.ts`

---

## 9. 検証の要点

実機（`make dev-desktop`）で必ず確認する。緑のテストは実機確認の代わりにならない。

1. キーを保存 → 再起動 → 設定済みが残る。`<dataDir>/secrets.enc.json` が**平文でない**
2. `GET /api/settings` のレスポンスに**キーが含まれない**
3. 同意ダイアログに**実際に送る画像とプロンプト全文**が出る。チェックを入れるまで送信不可
4. 権限を外した `plugin.json` で起動すると `permission-denied` で送信されない
5. 保存 → 同名ファイルを指定して**上書き確認が出る**
6. 保存した PNG に `graphy-art` が読め、**患者識別子が含まれない**
7. **配布ビルドで確認**（`cd desktop && npm run dist`）。CSP は dev では注入されない

## 「拡大・パンが Image to be sent に引き継がれない」件（2026-09-24・利用者報告）

**切り出しは壊れていなかった。ダイアログが画像を覆っていて、掴めていなかった。**

### 何が起きていたか

パネルは `left:50%` で画面中央に出していた。ビューアの画像も中央に描かれるので、
**620px のパネルが画像をほぼ覆う**。この機能は「画面で構図を決めて、それを送る」ものなので、
覆われると**構図を決める操作そのものができない**——拡大しようとドラッグしても
パネルを掴むだけで、ビューアは 1 ミリも動かない。動いていないのだから、
送信画像が変わらないのは正しい挙動だった。

🔴 **調査した本人（自動検査）も同じ罠に落ちた。** 最初に書いたスパイクは画像中央を
ドラッグしており、`zoom` が 1.000 のまま変わらないのに「追従しない不具合」と読みかけた。
**前提条件（操作が実際に効いたか）を検査に入れていなければ、そのまま誤診していた。**

### 直したこと

- パネルの既定位置を**右端**へ（`right:16px`）。ヘッダでドラッグして動かせるのは従来どおり
- `automator/plugins/viewstate-check` ＋ `automator/src/spike/viewStateFramingCheck.ts` を新設
- `demo-context`（H1/H2/H3 の配線確認用デモ）に `visibleRegion` の要約を出す。
  同じ疑いが出たとき、メニューを押すだけで切り分けられる

### 実測（CT / XA とも 10/10）

```
              zoom   覆っている画素   プレビュー実寸
Fit           1.00   512 x 512        512 x 512
拡大後        3.30   303 x 170        303 x 170     ← 開いたまま拡大して追従
パン後        3.30   279 x 170        （中心が移動）
```

```bash
cd automator && npx tsx src/spike/viewStateFramingCheck.ts                 # CT
cd automator && FIXTURE=xa-angio npx tsx src/spike/viewStateFramingCheck.ts # XA
```

### 教訓

- **「操作が効いたか」を前提条件として検査に書く。** 結果だけを見ると、操作が届いて
  いないのか結果が間違っているのか区別がつかない
- **画像の上に出すパネルは、画像を覆わない位置に置く。** 特に「画面の見え方」を入力に
  する機能では、覆うこと自体が機能を殺す
- `artCheck.ts` は AI ゲートしか見ておらず、**表示状態が送信画像に載るかを 1 度も
  確認していなかった**。だから壊れて（正確には使えなくなって）いても気付けなかった
