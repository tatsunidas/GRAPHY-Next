# バックエンド面（Java）— 任意

重い計算を Java 側で行いたいときだけ使う。**UI のみのプラグインならこのフォルダは不要**（削除可）。
バックエンド面つきプラグインは現状 **standalone のみ実行可**（web は共有 JVM のため 501。設計:
`fw/plugin-architecture.md` §3 / `fw/plugin-manager-design.md`）。

## 1. API jar を用意する

第三者は backend 全体ではなく、SPI だけの薄い **`graphy-plugin-api`** に対してコンパイルする。

1. 対象の GRAPHY-Next の **GitHub Release** から `graphy-plugin-api-<version>.jar` を入手する。
2. ローカル Maven リポジトリへ登録する（`<version>` は使う GRAPHY-Next に合わせる）:

   ```bash
   mvn install:install-file \
     -Dfile=graphy-plugin-api-0.1.7.jar \
     -DgroupId=com.vis.graphynext -DartifactId=graphy-plugin-api \
     -Dversion=0.1.7 -Dpackaging=jar
   ```

   `pom.xml` の `graphy.version` を同じ値にしておくこと。

## 2. ビルド

```bash
mvn -f backend-optional/pom.xml package
# → backend-optional/target/my-plugin.jar
```

## 3. プラグインに組み込む

- ビルドした `my-plugin.jar` を**プラグインのルート**（`plugin.json` と同じ階層）に置く。
- `plugin.json` に実装クラスの完全修飾名を指定する:

  ```json
  { "entrypoint": "com.example.graphyplugin.HelloBackendPlugin", "permissions": ["read-pixels"] }
  ```

- リリース時は `.github/workflows/release.yml` が `plugin.json` / `ui.js` と同じく
  ルートの `*.jar` を zip に同梱する（CI で jar をビルドしてルートへ置くステップを足すか、
  ビルド済み jar をコミットしておく）。

## SPI

プラグイン jar が実装するのはこの 1 インターフェースだけ（JDK 標準型のみ）:

```java
package com.vis.graphynext.plugin.spi;
public interface GraphyPlugin {
    Object run(Map<String, Object> args) throws Exception; // 戻り値は JSON 化されて UI に返る
}
```
