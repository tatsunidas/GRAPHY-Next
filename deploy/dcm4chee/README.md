# dcm4chee（実 PACS）でのテスト

GRAPHY-Next の **web モード（BFF）** を実 PACS で検証するための、dcm4chee-arc-light ローカル環境。
この環境（CI/サンドボックス）は Docker 非対応のため、**Docker のある自分のマシン**で起動する。

## 起動

```bash
docker compose -f deploy/dcm4chee/docker-compose.yml up -d
# 初回は WildFly の初期化に数分かかる
docker compose -f deploy/dcm4chee/docker-compose.yml logs -f arc   # 起動完了待ち
```

- Web UI: http://localhost:8080/dcm4chee-arc/ui2/
- DICOMweb base: `http://localhost:8080/dcm4chee-arc/aets/DCM4CHEE/rs`
- DIMSE: AE=`DCM4CHEE` host=`localhost` port=`11112`

## テストデータ投入

手元の dcm4che ツールで C-STORE 投入（または UI からアップロード）:

```bash
~/dcm4che-*/bin/storescu -c DCM4CHEE@localhost:11112 <DICOMファイル...>
```

DICOMweb（STOW-RS）で投入も可:

```bash
~/dcm4che-*/bin/stowrs --url http://localhost:8080/dcm4chee-arc/aets/DCM4CHEE/rs/studies <DICOMファイル...>
```

## GRAPHY-Next web モードを接続

`application-web.yml`（または起動引数）で接続先を指定:

```yaml
graphy:
  dicom:
    dicomweb:
      base-url: http://localhost:8080/dcm4chee-arc/aets/DCM4CHEE/rs
```

起動:

```bash
java -jar backend/target/graphy-next-backend.jar --spring.profiles.active=web
```

`WebDicomDataService.searchStudies(...)` が dcm4chee の QIDO-RS を叩いて Study を返す。

## 停止 / クリーンアップ

```bash
docker compose -f deploy/dcm4chee/docker-compose.yml down
# データも消す場合
rm -rf deploy/dcm4chee/data
```

## 備考
- イメージタグは執筆時点（dcm4chee-arc 5.33.x）。最新は Docker Hub `dcm4che/*` と
  https://github.com/dcm4che-dockerfiles を参照して合わせる。
- 軽量に DICOMweb だけ試すなら Orthanc + DICOMweb プラグインでも可（将来 compose 追加候補）。
