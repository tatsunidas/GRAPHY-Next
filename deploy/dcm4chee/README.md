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

## GRAPHY-Next を外部ビューア（IHE IID）として登録

dcm4chee UI2 の Study 一覧に「Viewer」ボタン（IHE Invoke Image Display）を表示させ、クリックすると
GRAPHY-Next(web) が該当 Study を直接開くようにする設定。Weasis の `weasis-pacs-connector` と違い、
GRAPHY-Next 自体がブラウザで完結する Web アプリなので、マニフェスト生成やクライアント側のプロトコル
ハンドラ登録・アプリインストールは一切不要（Zero-install のまま）。

設定の実体は、AE `DCM4CHEE` に対応する `dcmWebApp` エントリ（`dicomAETitle=DCM4CHEE` の Web
Application。DIMSE の Network AE `DCM4CHEE` とは別オブジェクトなので注意）が持つ `dcmProperty`
（`KEY=VALUE` 形式の配列）に `IID_STUDY_URL` を追加すること。

### 確実な方法（LDAP を直接編集）

UI2 の GUI（後述）は権限チェックの非同期処理の影響か、フィールドの表示が不安定なことがある。
確実に反映させたい場合は `ldapmodify` を直接使う。

```bash
cat <<'EOF' > add_iid.ldif
dn: dcmWebAppName=DCM4CHEE,dicomDeviceName=dcm4chee-arc,cn=Devices,cn=DICOM Configuration,dc=dcm4che,dc=org
changetype: modify
add: dcmProperty
dcmProperty: IID_STUDY_URL=http://localhost:8090/?requestType=STUDY&studyUID={{studyUID}}
dcmProperty: IID_URL_TARGET=_blank
EOF

docker cp add_iid.ldif <ldapコンテナ名>:/tmp/add_iid.ldif
docker exec <ldapコンテナ名> ldapmodify -x -H ldap://localhost:389 \
  -D "cn=admin,dc=dcm4che,dc=org" -w secret -f /tmp/add_iid.ldif

# 設定を反映させる（devceの再読み込み）
curl -X POST http://localhost:8080/dcm4chee-arc/ctrl/reload
```

- `IID_STUDY_URL` の `{{studyUID}}` は UI2 が実際の StudyInstanceUID に置換する（IHE IID の
  `requestType=STUDY&studyUID=...` に相当）。GRAPHY-Next(web) はこのクエリを
  `frontend/src/iid.ts` の `parseIidLaunch()` で解釈し、検索を介さず該当 Study を 2D ビューアで開く。
- `IID_URL_TARGET=_blank` は新しいタブで開く設定（`_self` なら現在のタブを置き換え）。
- `localhost:8090` は dcm4chee と GRAPHY-Next(web) が同一PC上にある前提の値。別ホストで動かす
  場合は、GRAPHY-Next(web) の実際のホスト名/ポートに書き換えること（クライアント側の対応は不要、
  この1箇所を直すだけでよい）。
- 削除する場合は `changetype: modify` / `delete: dcmProperty` で該当行のみ、または属性ごと削除する。

### 参考: UI2 の GUI から設定する場合

「Configuration → Web Applications」の一覧画面から `DCM4CHEE`（`dicomAETitle=DCM4CHEE` の
Web Application エントリ）を開き、Attributes 内の **Web Application Property**（`dcmProperty`）に
上記と同じ `KEY=VALUE` を追加する。

⚠ 同名の「DCM4CHEE」が複数存在し紛らわしい：
- Devices → dcm4chee-arc → Child Objects → **Network AEs** → `DCM4CHEE` … DIMSE 用 AE。
  Web Application Property は無い。
- Configuration → **Web Applications** → `DCM4CHEE` … こちらが対象（`dcmWebApp` エントリ）。

⚠ 環境によっては Property 欄がブラウザ再読み込みや操作タイミングによって表示されたり
されなかったりする不具合が確認されている。GUI で見当たらない場合は上記の LDAP 手順を使うこと。

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
