# NonDicomImporter 動画トランスコード用 ffmpeg 同梱

> 作成日: 2026-06-30
> ステータス: **実装済（同梱前提の設定整備＋取得自動化）**。
> 関連: `fw/mainscreen-tools.md`（NonDicomImporter / 動画 DICOM 化）。

## 0. 背景
動画(AVI / 非 H.264 MP4)を DICOM(Video Photographic) 化するには **H.264 High profile への変換**が要る。
JCodec 等の純 Java 実装は Baseline profile しか出せず dcm4che `MP4Parser`（profile_idc=100 のみ受理）に
弾かれるため使えない。よって **ffmpeg バイナリを同梱**し、CLI で「MP4(H.264 High)へ変換 → DICOM に encapsulate」する。
（H.264 High profile の MP4 をそのまま渡す場合は ffmpeg 不要＝`MP4Parser` 直読み。）

## 1. 配置規約
```
desktop/resources/ffmpeg/<os-arch>/ffmpeg[.exe]
  例) desktop/resources/ffmpeg/linux-x64/ffmpeg
      desktop/resources/ffmpeg/win-x64/ffmpeg.exe
      desktop/resources/ffmpeg/mac-arm64/ffmpeg
```
- `<os-arch>` = `linux-x64 | linux-arm64 | win-x64 | mac-x64 | mac-arm64`（`FfmpegLocator.osArch()` と一致）。
- electron-builder の `extraResources`（`{from:"resources/ffmpeg", to:"ffmpeg"}`）で
  パッケージの `Resources/ffmpeg/<os-arch>/...` に同梱される。
- `desktop/resources/ffmpeg/` は **.gitignore 済み**（バイナリはコミットせずリリース時に取得）。

## 2. backend 側の解決（`com.vis.graphynext.nondicom.FfmpegLocator`）
解決順:
1. 設定 `nondicom.ffmpeg`（実行ファイルの明示パス）
2. 環境変数 `GRAPHY_FFMPEG`
3. 同梱探索（各ディレクトリで `<bin>` フラット / `<os-arch>/<bin>` ツリーの順に探す）:
   - 設定 `nondicom.ffmpeg-dir` / 環境変数 `GRAPHY_FFMPEG_DIR`
   - **jar 隣接の `ffmpeg/`・`../ffmpeg/`** … Electron では backend jar が `Resources/backend/` にあるため
     `../ffmpeg` = `Resources/ffmpeg`（＝同梱先）を自動発見。**main.js の変更不要**。
   - カレントの `ffmpeg`・`resources/ffmpeg`・`desktop/resources/ffmpeg`（dev 起動位置の差を吸収）
4. 見つからなければ PATH 上の `ffmpeg`（`ffmpeg.exe`）

実行可否は `VideoConverter.ffmpegAvailable()`（`ffmpeg -version` 実行）で確認。不在なら動画は skip
（結果メッセージに ffmpeg を含む）。設定は `application-standalone.yml` の `nondicom:` に雛形あり。

## 3. リリース同梱の自動化
- **取得スクリプト**: `scripts/fetch-ffmpeg.sh`
  - 取得元: `eugeneware/ffmpeg-static` の GitHub Releases（各プラットフォーム単一バイナリの gzip）。
  - `scripts/fetch-ffmpeg.sh`（全ターゲット）/ `scripts/fetch-ffmpeg.sh linux-x64 win-x64`（指定）。
  - `FFMPEG_STATIC_TAG`（既定 `b6.0`）でバージョン固定、`FFMPEG_OUT_DIR` で出力先変更可。
  - 取得後、自ホスト向けは `-version` で検証。サイズ下限チェックあり。
- **Makefile**: `make ffmpeg`（全 OS）/ `make ffmpeg FFMPEG_TARGETS=linux-x64`（その OS の installer 用）。
- **推奨フロー（CI/リリース）**: 各 OS のランナーで
  1. `make build`（frontend/backend/JRE 同梱）
  2. `make ffmpeg FFMPEG_TARGETS=<その OS>`（必要ターゲットのみ取得 → installer サイズ最小化）
  3. `cd desktop && npm run dist`（electron-builder が `Resources/ffmpeg/<os-arch>/` を同梱）

## 4. ライセンス注意（重要）
- 同梱する ffmpeg は **GPL ビルド**（x264 等を含む）。製品同梱時は **GPL の義務（対応ソースの提供等）** を満たすこと。
  ffmpeg は**別実行ファイルとして CLI 起動**（コードへリンクしない）するため linking の論点は避けられるが、
  GPL バイナリ配布の義務は残る。
- **H.264 は MPEG-LA の特許**対象。エンコーダ実装に依らず、配布形態によってライセンスが要る場合がある。
- 商用方針として「ユーザーに H.264 High profile MP4 を渡してもらう（ffmpeg 非同梱）」運用も選択肢
  （その場合 `MP4Parser` 直読みのみで動作し、AVI/非 H.264 は skip）。

## 5. 開発時の使い方
- ffmpeg を PATH に入れておけば `FfmpegLocator` がフォールバックで拾う（手動配置不要）。
- もしくは `scripts/fetch-ffmpeg.sh <host-target>` で `desktop/resources/ffmpeg/<host-target>/` に置けば
  dev 起動（repo ルート/`desktop` から）でも自動発見される。
