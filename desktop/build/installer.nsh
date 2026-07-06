; GRAPHY-Next — NSIS カスタムスクリプト（electron-builder の nsis.include から読み込まれる）
;
; 目的（2 つ）:
;   (A) アップデート／アンインストール時に、同梱 JRE で動くバックエンド java.exe を確実に止める。
;   (B) アンインストール時に「ユーザーデータ（DICOM 保管庫・H2・plugins）も消しますか?」を確認する。
;
; -------------------------------------------------------------------------
; (A) 旧バージョン削除失敗（"Can't rename $INSTDIR ..." → 「旧バージョンの削除に失敗」）の対策
; -------------------------------------------------------------------------
;   electron-builder の CHECK_APP_RUNNING は GRAPHY-Next.exe（Electron 本体）しか kill しない。
;   しかし main.js は同梱 JRE の java.exe を子プロセスとして spawn し
;   （resources\jre\bin\java.exe -jar resources\backend\graphy-next-backend.jar ...）、
;   Electron 本体をハードキルすると before-quit→stopBackend を経ず java が孤児化して生き残る。
;   その java が $INSTDIR\resources\jre\... と backend jar をロックしたままなので、
;   更新時に旧アンインストーラの un.atomicRMDir（$INSTDIR のリネーム）が失敗し、更新自体が失敗する。
;   → ここでバックエンド java（と念のため同梱 ffmpeg）を、この install に属するものだけ確実に止める。
;
;   識別条件（無関係な Java を巻き込まないため両方で絞る）:
;     ・CommandLine に "graphy-next-backend.jar" を含む（インストール先に依存せず一意。config.json の jarName と一致）
;     ・または ExecutablePath が $INSTDIR 配下（同梱 java.exe / ffmpeg.exe）
;   ⚠ "graphy-next-backend.jar" は desktop/config.json の backend.jarName と一致させること。
;
;   ⚠ 順序が重要: 旧版は「先に java だけ kill → 後で electron-builder 標準の CHECK_APP_RUNNING が
;   GRAPHY-Next.exe を kill」という順序だったため、Electron 本体がまだ生きている間に java だけ死に、
;   直後に Electron 本体が（生きている間の再接続・再起動ロジック等で）新しい java を再スポーンし得た。
;   その新しい java は誰にも kill されないまま、後続の uninstallOldVersion が呼ぶ「旧バージョンの
;   アンインストーラ（この kill ロジックを持たない旧ビルド）」の邪魔をしてファイル削除に失敗する
;   （"古いアプリケーションファイルのアンインストールに失敗しました...: 2"）。
;   → 先に GRAPHY-Next.exe（Electron 本体。メイン/レンダラ/GPU 等の全子プロセスが同じ実行ファイル名）
;   を kill し、その直後（再スポーンの余地がない状態）で孤児 java/ffmpeg を掃除する。
;   これにより後段の CHECK_APP_RUNNING は対象プロセスが既に無い状態で通過し、
;   「GRAPHY Next が終了できません」の警告自体も出なくなる。

!macro killGraphyBackend
  DetailPrint "Stopping GRAPHY-Next (app + bundled backend Java) before update/uninstall..."
  ; PowerShell は Win10/11 標準。失敗しても従来動作（electron-builder 標準の CHECK_APP_RUNNING 等）に
  ; フォールバックするだけなので無害。
  nsExec::Exec 'powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$app = @(Get-CimInstance Win32_Process | Where-Object { $$_.Name -eq $\'${APP_EXECUTABLE_FILENAME}$\' }); if ($$app) { $$app | Invoke-CimMethod -MethodName Terminate | Out-Null; Start-Sleep -Milliseconds 500 }; $$procs = @(Get-CimInstance Win32_Process | Where-Object { ($$_.Name -eq $\'java.exe$\' -or $$_.Name -eq $\'ffmpeg.exe$\') -and ( ($$_.CommandLine -and $$_.CommandLine -like $\'*graphy-next-backend.jar*$\') -or ($$_.ExecutablePath -and $$_.ExecutablePath -like $\'$INSTDIR\*$\') ) }); if ($$procs) { $$procs | Invoke-CimMethod -MethodName Terminate | Out-Null; Start-Sleep -Milliseconds 800 }"'
  Pop $0
  ; ロック解放を待つための小休止（ハンドルクローズ猶予）。
  Sleep 500
!macroend

; インストーラ起動直後（.onInit）。CHECK_APP_RUNNING → uninstallOldVersion より前に走るので、
; 旧バージョン削除（リネーム）の前にバックエンド java を止められる。更新失敗の本丸はここ。
!macro customInit
  !insertmacro killGraphyBackend
!macroend

; アンインストーラ起動直後（un.onInit）。ファイル削除（un.atomicRMDir / RMDir）の前に走る。
; 通常アンインストールや将来の更新でも、実行中バックエンドのロックを解放しておく。
!macro customUnInit
  !insertmacro killGraphyBackend
!macroend

; -------------------------------------------------------------------------
; (A') それでも終了できない場合のフォールバック（"GRAPHY Next が終了できません" 対策）
; -------------------------------------------------------------------------
;   環境によっては（原因未特定。管理者権限で実行しても再現する＝単純な権限不足ではない）
;   killGraphyBackend を実行してもプロセスが残り続けるケースがある。
;   electron-builder 標準の CHECK_APP_RUNNING は taskkill 失敗後に「手動で閉じて再試行」を
;   無限に繰り返すだけで、ユーザーが手詰まりになりやすい。
;   → customCheckAppRunning で置き換え、killGraphyBackend → 存在確認 を数回試し、
;   それでも残っていれば「先にアンインストールしてから、再度インストーラーを実行してください」
;   という具体的な行動を促すメッセージを出して素直に終了する（無限リトライさせない）。
!macro customCheckAppRunning
  StrCpy $R5 0
  checkAppRunningRetry:
    IntOp $R5 $R5 + 1
    !insertmacro killGraphyBackend
    !insertmacro FIND_PROCESS "${APP_EXECUTABLE_FILENAME}" $R0
    ${if} $R0 != 0
      ; 見つからない（＝終了できた）。通常フローへ進む。
      Goto checkAppRunningDone
    ${endIf}
    ${if} $R5 < 3
      DetailPrint "GRAPHY-Next is still running, retrying (attempt $R5)..."
      Sleep 1500
      Goto checkAppRunningRetry
    ${endIf}

    MessageBox MB_OK|MB_ICONEXCLAMATION \
      "GRAPHY Next を自動的に終了できませんでした。$\r$\n\
お手数ですが、いったんこのインストーラーを閉じたうえで、$\r$\n\
「設定」→「アプリ」（または「コントロールパネル」→「プログラムのアンインストール」）から$\r$\n\
GRAPHY-Next を先にアンインストールしてから、このインストーラーを再度実行してください。$\r$\n$\r$\n\
GRAPHY Next could not be closed automatically.$\r$\n\
Please close this installer, uninstall GRAPHY-Next first via Windows Settings > Apps$\r$\n\
(or Control Panel > Programs), then run this installer again."
    Quit
  checkAppRunningDone:
!macroend

; -------------------------------------------------------------------------
; (B) アンインストール時のユーザーデータ削除確認
; -------------------------------------------------------------------------
;   backend が作るデータはインストール先ではなく %APPDATA%\GRAPHY-Next に置かれる
;   （main.js resolveDataDir。フォルダ名は build.productName と同じ "GRAPHY-Next" で固定）。
;   既定のアンインストーラは $INSTDIR（プログラム本体）しか消さないため、ここで明示的に扱う。
;   → 既定は「保持」。ユーザーが Yes を選んだときだけ削除する（医用画像データの誤削除防止）。
;   ⚠ 下の "GRAPHY-Next" は main.js の APP_DATA_FOLDER と一致させること。

!macro customUnInstall
  ; 更新（再インストール）に伴う一時的なアンインストールでは、データを保持したいので何もしない。
  ${ifNot} ${isUpdated}
    ; Electron は常に「現在のユーザー」の APPDATA を使う。per-machine 導入でも current に固定して参照する。
    ${if} $installMode == "all"
      SetShellVarContext current
    ${endif}

    IfFileExists "$APPDATA\GRAPHY-Next\*.*" 0 skipUserData

    MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 \
      "保存された DICOM 画像・データベース・plugins も削除しますか?$\r$\n\
（$APPDATA\GRAPHY-Next）$\r$\n$\r$\n\
Also delete your stored DICOM images, database and plugins?$\r$\n\
This cannot be undone. Choose No to keep your data." \
      /SD IDNO IDNO skipUserData

    RMDir /r "$APPDATA\GRAPHY-Next"

    skipUserData:

    ${if} $installMode == "all"
      SetShellVarContext all
    ${endif}
  ${endIf}
!macroend
