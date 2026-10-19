#!/bin/bash

if type update-alternatives 2>/dev/null >&1; then
    # Remove previous link if it doesn't use update-alternatives
    if [ -L '/usr/bin/${executable}' -a -e '/usr/bin/${executable}' -a "`readlink '/usr/bin/${executable}'`" != '/etc/alternatives/${executable}' ]; then
        rm -f '/usr/bin/${executable}'
    fi
    update-alternatives --install '/usr/bin/${executable}' '${executable}' '/opt/${sanitizedProductName}/${executable}' 100 || ln -sf '/opt/${sanitizedProductName}/${executable}' '/usr/bin/${executable}'
else
    ln -sf '/opt/${sanitizedProductName}/${executable}' '/usr/bin/${executable}'
fi

# Check if user namespaces are supported by the kernel and working with a quick test:
if ! { [[ -L /proc/self/ns/user ]] && unshare --user true; }; then
    # Use SUID chrome-sandbox only on systems without user namespaces:
    chmod 4755 '/opt/${sanitizedProductName}/chrome-sandbox' || true
else
    chmod 0755 '/opt/${sanitizedProductName}/chrome-sandbox' || true
fi

if hash update-mime-database 2>/dev/null; then
    update-mime-database /usr/share/mime || true
fi

if hash update-desktop-database 2>/dev/null; then
    update-desktop-database /usr/share/applications || true
fi

# ── GRAPHY-Next で足した部分 ──
# Ubuntu 23.10 以降は AppArmor が「権限のないプロセスの user namespace」を制限する
# (kernel.apparmor_restrict_unprivileged_userns=1)。上の判定は unshare が通るので SUID を外すが、
# Chromium の sandbox は namespace を使えず、起動直後に異常終了する（2026-10-16 に Ubuntu 24.04 で確認）。
# Chrome・VS Code と同じく、この実行ファイルにだけ userns を許す AppArmor プロファイルを置く。
APPARMOR_PROFILE_SOURCE='/opt/${sanitizedProductName}/resources/apparmor-profile'
APPARMOR_PROFILE_TARGET='/etc/apparmor.d/${executable}'
if [ -d /etc/apparmor.d ] && apparmor_status --enabled 2>/dev/null; then
    if apparmor_parser --skip-kernel-load --debug "$APPARMOR_PROFILE_SOURCE" >/dev/null 2>&1; then
        cp -f "$APPARMOR_PROFILE_SOURCE" "$APPARMOR_PROFILE_TARGET"
        apparmor_parser --replace --write-cache --skip-read-cache "$APPARMOR_PROFILE_TARGET" || true
    else
        echo "この AppArmor では userns の指定を読めないので、プロファイルは入れません。"
    fi
fi
