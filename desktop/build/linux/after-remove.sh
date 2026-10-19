#!/bin/bash

# Delete the link to the binary
if type update-alternatives >/dev/null 2>&1; then
    update-alternatives --remove '${executable}' '/usr/bin/${executable}'
else
    rm -f '/usr/bin/${executable}'
fi

# ── GRAPHY-Next で足した部分 ── after-install.sh で入れた AppArmor プロファイルを外す
APPARMOR_PROFILE_DEST='/etc/apparmor.d/${executable}'
if [ -f "$APPARMOR_PROFILE_DEST" ]; then
    apparmor_parser --remove "$APPARMOR_PROFILE_DEST" 2>/dev/null || true
    rm -f "$APPARMOR_PROFILE_DEST"
fi
