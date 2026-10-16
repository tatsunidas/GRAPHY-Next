// electron-builder の afterPack（dmg を作る前に走る）。Mac 版の app 全体を簡易署名（ad-hoc）で署名し直す。
//
// 🚨 2026-10-16: v0.4.0 の Mac 版は electron-builder が署名せず、Electron に元から付いている簡易署名だけだった
//    （app 全体の封なし）。macOS は「失効」「既知のマルウェア」と判定し、「マルウェアがブロックされました」で
//    開けなかった。app 全体を署名し直すと、普通の「確認できません」になる（fw/release-checklist.md）。
//    Apple の開発者証明書での署名・公証はしていない。公開前の判定は scripts/check-mac-gatekeeper.sh。
const { execFileSync } = require("node:child_process");
const path = require("node:path");

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  console.log(`[afterPack] codesign (ad-hoc): ${app}`);
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", app], { stdio: "inherit" });
  execFileSync("codesign", ["--verify", "--deep", "--strict", "--verbose=2", app], { stdio: "inherit" });
};
