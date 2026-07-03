; GRAPHY-Next — NSIS カスタムスクリプト（electron-builder の nsis.include から読み込まれる）
;
; 目的: アンインストール時に「ユーザーデータ（DICOM 保管庫・H2 データベース・plugins）も
;       一緒に削除しますか?」と確認し、選ばれた場合のみユーザーデータを削除する。
;
; 背景:
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
