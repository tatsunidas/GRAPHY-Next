# 測定環境（GNBP: GRAPHY-Next Benchmark Phantom ベンチマーク）

`results/` の測定値を取得したハードウェア・ソフトウェア構成。**測定値はこの構成に固有**であり、
別のハードウェアでは異なる値になる。だからこそ生成器と計測スクリプトを揃えて置き、
各自の環境で追試できる形にしている。

`measure.mjs` は実行のたびにこの情報を結果 JSON の `environment` に自動で埋め込むため、
結果ファイルと環境の記述が乖離しない。

## ハードウェア

| 項目 | 値 |
| :- | :- |
| 機種 | ノート PC（CLEVO/KAPOK 製ベアボーン） |
| CPU | Intel Core i7-8550U @ 1.80 GHz（最大 4.00 GHz）、4 物理コア / 8 論理コア、L3 8 MiB |
| メモリ | 32 GB（`free` 表示 31 GiB） |
| GPU | **Intel UHD Graphics 620（CPU 統合、専用 GPU なし）** |
| ストレージ | Samsung SSD 970 EVO 1TB（NVMe）ほか SATA SSD 2 台 |
| ディスプレイ | HDMI-2: 2560×1440 @ 59.95 Hz（主）／ eDP-1: 1600×900 @ 59.70 Hz |

**GPU が統合グラフィックスである点は結果の解釈に重要**。専用 GPU を積まない、
教育・研究現場でごく普通に使われる機材で成立するかを示すのが本測定の趣旨であり、
ハイエンド機での値ではない。

## ソフトウェア

| 項目 | 値 |
| :- | :- |
| OS | Pop!_OS 22.04 LTS |
| カーネル | 7.0.11-76070011-generic |
| セッション | X11（`DISPLAY=:1`） |
| Java | OpenJDK 21.0.11 |
| GRAPHY-Next | v0.1.9（本番ビルド／UI 同梱 jar、`--spring.profiles.active=standalone`）<br>**コミット `8c56485`（origin/main）を固定**。`bench/.build/gn` の専用ワークツリーでビルドする |
| ブラウザ | Playwright 同梱 Chromium（結果 JSON の `browser` に版を記録） |
| WebGL | `ANGLE (Intel, Mesa Intel(R) UHD Graphics 620 (KBL GT2), OpenGL 4.6)` |

## 測定に使うバイナリは専用ワークツリーでビルドする（必須）

`~/graphy-workspace/GRAPHY-Next` は**複数のセッションが共有する作業コピー**であり、
別セッションがいつでもブランチを切り替え、`backend/target/*.jar` を再ビルドする。

2026-07-31 06:25 に実際に事故った: 測定中に別セッションが jar を差し替えたため、
稼働中の JVM が `NoClassDefFoundError: ch/qos/logback/classic/spi/ThrowableProxy` を出して
ページを返さなくなった（Spring Boot の fat jar は起動後もクラスを遅延読み込みするため、
実行中に差し替えると壊れる）。`/api/status` だけは既読込クラスで応答し続けるので、
**ヘルスチェックが通っていても壊れている**ことがある。

さらに悪いのは、仮に壊れなかった場合で、**どのコードを測ったのか分からない数値**が出てしまう。
測定値として使えない。

手順:

以下は `bench/` を作業ディレクトリとして実行する（`.build/` `.run/` は `.gitignore` 済み）。

```bash
# 1) 測定用ワークツリーを固定コミットで作る（共有作業コピーとは独立）
#    <commit> には測定対象のコミットを指定する（例: 8c56485）
git -C ~/graphy-workspace/GRAPHY-Next worktree add --detach "$PWD/.build/gn" <commit>

# 2) UI 同梱 jar をビルド（-Dfrontend.skip は付けない）
(cd .build/gn/backend && mvn -q clean package -DskipTests)

# 3) このワークツリーの jar だけを使って起動する
mkdir -p .run/sa && (cd .run/sa && GRAPHY_AUTOMATOR=1 java -jar \
  ../../.build/gn/backend/target/graphy-next-backend.jar \
  --spring.profiles.active=standalone --server.port=8099 --graphy.dicom.scp.port=11122)
```

測定結果には**コミットハッシュと jar の MD5 を必ず記録する**。

## 測定時の注意（これを守らないと数値が無意味になる）

1. **必ず headed で実行する**（`DISPLAY=:1 node measure.mjs --headed`）。
   ヘッドレスは GPU を使わず WebGL が SwiftShader（ソフトウェア）になる。
   結果 JSON の `webgl_renderer` に `SwiftShader` / `llvmpipe` が出ていたらその測定は**無効**。
2. **フレームレートはディスプレイのリフレッシュレート（約 60 Hz）が上限**。
   60 fps 付近の値は「上限に張り付いた」という意味であり、能力の上限ではない。
   このためスクロール性能の主指標は fps ではなく**1 スライスあたりの描画レイテンシ**にしてある。
3. **他の負荷をかけない**。結果 JSON に開始時の空きメモリとロードアベレージを記録するので、
   測定後に確認すること。ビルドや別セッションの作業と並行して走らせない。
4. **GPU メモリは測っていない**。Chrome は CDP でページ単位の GPU メモリを公開しておらず、
   数値を出せば推測になる。測定項目として存在しないことを明示する。
