# web モード結合検証手順（実 dcm4chee）— 一括取得(prefetch) & 保存(STOW-RS)

> 対象: web モードの ①2D 表示 ②MPR/3D/Slicer/CurvedMPR の一括取得高速化(#2) ③派生シリーズ/SEG/RTSTRUCT の
> STOW-RS 書き戻し(#3) ④IHE IID 起動。ユニットテストで multipart/STOW の framing は検証済み（`WebDicomTransferTest`）。
> ここでは実 dcm4chee との疎通を確認する。**Docker が必要**（CI/サンドボックスは非対応）。
>
> ✅ **2026-07-10: 実 dcm4chee での結合検証 完了**（①②③の派生シリーズ／SEG・RTSTRUCT のエクスポート表示・
> ④IID起動を確認）。**未確認のまま残っている項目**: SEG/RTSTRUCT の **per-frame 参照・幾何整合の目視確認**
> （下記 ⚠ 参照）。この1点は引き続き要検証。

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
