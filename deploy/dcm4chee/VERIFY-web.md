# web モード結合検証手順（実 dcm4chee）— 一括取得(prefetch) & 保存(STOW-RS)

> 対象: web モードの ①2D 表示 ②MPR/3D/Slicer/CurvedMPR の一括取得高速化(#2) ③派生シリーズ/SEG/RTSTRUCT の
> STOW-RS 書き戻し(#3) ④IHE IID 起動。ユニットテストで multipart/STOW の framing は検証済み（`WebDicomTransferTest`）。
> ここでは実 dcm4chee との疎通を確認する。**Docker が必要**（CI/サンドボックスは非対応）。
>
> ✅ **2026-07-10: 実 dcm4chee での結合検証 完了**（①②③の派生シリーズ／SEG・RTSTRUCT のエクスポート表示・
> ④IID起動を確認）。**未確認のまま残っている項目**: SEG/RTSTRUCT の **per-frame 参照・幾何整合の目視確認**
> （下記 ⚠ 参照）。この1点は引き続き要検証。

## 実施環境の記録

**どのマシンで実施したかを必ず残す。** 2026-07-10 の検証はこれが無かったため、2026-07-30 に
「以前 docker で動かした記録はないか」を調べ直す手間が発生した（結論: 別マシンだった）。

| 日付 | 実施環境 | dcm4chee | 結果・備考 |
|---|---|---|---|
| 2026-07-10 | **不明**（記録なし。おそらく別 PC） | 起動できた | ①②③④ 合格。SEG/RTSTRUCT の per-frame 幾何整合のみ未確認 |
| 2026-07-30 | Pop!_OS（`pop-os`・開発機） | ✅ 起動・検証完了 | **③-2（H4b の web）を実施し 18 項目すべて合格**（`automator/src/spike/h4bWebStowCheck.ts`）。この機は初回セットアップが必要だった: `docker compose` 未導入（apt に `docker-compose-plugin` が無いのでバイナリ v5.3.1 を `/usr/libexec/docker/cli-plugins/` へ直置き）、`dcm4che/*` 3 イメージを pull、`docker` グループ未参加（**`sudo docker` が必要**）、`:8080`/`:11112` を standalone backend が占有していたので停止してから起動 |

> このマシンで実施するには: ①compose を導入（`sudo apt install -y docker-compose-plugin`）
> ②`:8080` を空ける（standalone backend を停止。dcm4chee も 8080 を使う）
> ③`docker compose ... up -d`（初回は 3 イメージの pull）。
> `deploy/dcm4chee/data/` が出来ていれば「このマシンで起動した」証拠になる（全サービスがバインドマウント）。

## 0. 前提
- JDK 21 / Docker / dcm4che CLI ツール（`storescu` 等、任意）。
- web UI 同梱の jar が必要 → `make build`（frontend+backend）または `cd frontend && npx vite build` 後に
  `mvn -o -f backend/pom.xml package`。検証だけなら UI 同梱 jar（`backend/target/graphy-next-backend.jar`）。

## 1. dcm4chee を起動してテストデータ投入
```bash
docker compose -f deploy/dcm4chee/docker-compose.yml up -d
# UI: http://localhost:8080/dcm4chee-arc/ui2/   RS: http://localhost:8080/dcm4chee-arc/aets/DCM4CHEE/rs
# CT/MR の複数スライスシリーズを投入（MPR/3D/Slicer 検証のため 3 枚以上・できれば連続スライス）
~/dcm4che-*/bin/storescu -c DCM4CHEE@localhost:11112 <DICOM...>
```

## 2. GRAPHY-Next(web) を起動（別ポート 8090、接続先=dcm4chee RS）
```bash
java -jar backend/target/graphy-next-backend.jar \
  --spring.profiles.active=web \
  --server.port=8090 \
  --graphy.dicom.dicomweb.base-url=http://localhost:8080/dcm4chee-arc/aets/DCM4CHEE/rs
# 開く: http://localhost:8090/
```

## 3. 検証項目とチェックポイント

### ① 2D 表示（BFF 経由 WADO-RS instance retrieve）
- [x] 検索→スタディ→シリーズを開くと画像が表示される（スライダー送り可）。
- 経路: `wadouri:/api/studies/{s}/series/{se}/instances/{sop}/file` → BFF が WADO-RS で取得。

### ② 一括取得・高速化（#2 prefetch）
- [x] MPR / 3D / Slicer / Curved MPR を開く。
- [x] **backend ログに** `WADO-RS series prefetch: /studies/.../series/... -> N instances cached (bulk retrieve)` が出る。
- [x] ブラウザ DevTools Network で、ボリューム表示前に **`POST .../prefetch` が 1 回**。以降のスライスは
      個別 WADO-RS 往復なしで表示される（prefetch 無効時の N 回逐次取得と比べ体感高速）。

### ③ 保存＝STOW-RS 書き戻し（#3・★必須）
- **派生シリーズ（Slicer）**:
  - [x] Slicer でリスライス→保存（派生シリーズ生成）を実行。
  - [x] backend ログに `derived series created: <UID> (<n> instances) from <src> [STOW-RS]`。
  - [x] **dcm4chee UI2 を再読込 → 当該スタディに新シリーズ（リスライス）が現れる**（＝PACS へ STOW 済み）。
- **DICOM SEG / RTSTRUCT（ROI エクスポート）**:
  - [x] ROI から SEG / RTSTRUCT エクスポートを実行 → dcm4chee UI2 に新シリーズ（SEG/RTSTRUCT）が出る。
  - ⚠ **未確認のまま残っている項目**: per-frame 参照・幾何整合の目視確認（テンプレートは WADO-RS
    `/metadata` 先頭から引き継ぎ）。エクスポートされたシリーズが PACS に現れることは確認済みだが、
    フレームごとの参照・幾何整合そのものはまだ目視確認していない。

### ③-2 プラグインの派生シリーズ保存（H4b・web モード）— ✅ **2026-07-30 完了（18 項目合格）**

`fw/plugin-architecture.md` §7 の H4b（`host.saveDerivedSeries()`）の web 分岐
（`DerivedSeriesService` がテンプレートを WADO-RS `/metadata` から取り、`storeDatasets` で STOW）を
実 dcm4chee で確認した。

**自動化済み**: `cd automator && npx tsx src/spike/h4bWebStowCheck.ts`
（ブラウザで web UI を操作し、**判定は dcm4chee へ直接 QIDO / WADO-RS を投げて**行う。
UI の「保存しました」表示ではなく PACS の実体を見るのが要点）。
接続先は環境変数 `GRAPHY_WEB_URL` / `GRAPHY_PACS_RS` で差し替え可。

確認できたこと（18 項目）: web で 2D 表示（BFF 経由 WADO-RS）／**確認ダイアログの保存先が
「接続中の PACS（STOW-RS で書き戻し）」**（standalone は「この PC の保管庫」＝分岐が効いている）／
**拒否したとき PACS にシリーズが増えない**／承諾すると **PACS に新シリーズが出現**／
`SeriesDescription` に `[Plugin] ` 接頭辞／`ImageType=DERIVED\SECONDARY`（RESLICE なし）／
`DerivationDescription` にプラグイン id・版／`ContributingEquipmentSequence` あり／
Rescale 恒等・`RescaleType=HU`／**`PixelPaddingValue=-1000`**（背景の明示指定が web でも効く）／
Modality は元のまま／**元シリーズは無変更**／コンソールに `pixel data is missing` が出ない。

以下は手で行う場合の手順（自動化スクリプトが無い環境向け）。

準備（プラグインを 1 本置く。web は導入 UI が使えないため**手置き**する）:

```bash
# backend の CWD 直下 plugins/ に置く（web 起動時の作業ディレクトリを確認して合わせる）
mkdir -p plugins/hostapi-save
cp <GRAPHY-Next>/automator/plugins/hostapi-save/{plugin.json,ui.js} plugins/hostapi-save/
# 置いたあと backend を再起動（起動時に /api/plugins が走査する）
```

- [ ] 2D ビューアでシリーズを開き、Plug-ins ＞ **Host API Save** を実行。
- [ ] **確認ダイアログの「保存先」が「接続中の PACS（STOW-RS で書き戻し）」**になっている
      （standalone なら「この PC の保管庫」。ここが web/standalone の分岐の目視ポイント）。
- [ ] 承諾すると backend ログに
      `derived series created: <UID> (1 instances) from <src> [STOW-RS]`。
- [ ] **dcm4chee UI2 を再読込 → 当該スタディに `[Plugin] Bone mask` のシリーズが現れる**。
- [ ] そのインスタンスの属性（UI2 のタグ表示 or `dcmdump`）で出所が残っていること:
      `ImageType=DERIVED\SECONDARY` / `DerivationDescription` に `hostapi-save` /
      `ContributingEquipmentSequence` あり / `RescaleSlope=1`・`RescaleIntercept=0`（整数マスクなので恒等）/
      `RescaleType=HU`。
- [ ] 拒否（キャンセル）したときは PACS にシリーズが増えないこと。
- [ ] 元シリーズが変更されていないこと。

> standalone 側の同等確認は `automator/src/spike/hostApiCheck.ts` が自動で行う
> （backend の一覧・タグダンプを直接読む）。web は driver が未対応なので当面この手動手順で行う。

### ④ IHE IID 起動
- [x] `http://localhost:8090/?requestType=STUDY&studyUID=<StudyInstanceUID>` を開くと、検索を介さず
      2D ビューアが当該スタディで直接開く。
- [x] dcm4chee UI2 の「外部ビューア」に上記 URL テンプレート（`studyUID={{studyUID}}`）を登録して起動しても同様。

## 4. トラブルシュート
- 画像が出ない/500: backend ログの WADO-RS リクエスト行と `graphy.dicom.dicomweb.base-url` を確認。
  RS ベース URL は AE 込み（`.../aets/DCM4CHEE/rs`）。
- STOW 失敗: dcm4chee 側が STOW-RS を許可しているか（既定は可）。Content-Type は
  `multipart/related; type="application/dicom"; boundary=...`（`buildMultipartRelated`）。
- prefetch が効かない: シリーズ一括 GET（`/studies/{s}/series/{se}`）の応答が multipart/related か確認。
- CORS: フロントは同一オリジン（8090）で BFF を叩くため不要。ブラウザ→dcm4chee 直叩きはしない設計。

## 5. 後片付け
```bash
docker compose -f deploy/dcm4chee/docker-compose.yml down
```
