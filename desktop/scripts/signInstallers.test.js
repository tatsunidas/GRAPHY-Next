// 署名スクリプト（sign-installers.sh）。実際の minisign で、使い捨ての鍵を使って確かめる。
// minisign か bash が無い環境（CI の desktop ジョブなど）では、理由を出して skip する（黙って合格にしない）。
// 署名の仕組みそのものは、リリースの予行演習（release.yml の sign ジョブ）で実際に回して確かめる。
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { verifyFile } = require("../minisign");

const script = path.join(__dirname, "sign-installers.sh");
const have = (cmd) => spawnSync(cmd, ["-v"], { encoding: "utf8" }).status !== null && !spawnSync(cmd, ["-v"], { encoding: "utf8" }).error;
const hasMinisign = have("minisign");
const hasBash = !spawnSync("bash", ["-c", "true"]).error;
const skip = !hasMinisign ? "minisign が無い" : !hasBash ? "bash が無い" : false;
const VER = "0.9.0";
const EXE = `GRAPHY-Next.Setup.${VER}.exe`;
const APP = `GRAPHY-Next-${VER}.AppImage`;

function work() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "sign-inst-"));
  fs.mkdirSync(path.join(d, "dist"));
  fs.writeFileSync(path.join(d, "dist", EXE), Buffer.from("fake installer exe ".repeat(2000)));
  fs.writeFileSync(path.join(d, "dist", APP), Buffer.from("fake appimage ".repeat(3000)));
  return d;
}
function run(d, mode, env = {}, ver = VER) {
  return spawnSync("bash", [script, path.join(d, "dist"), ver, mode], { encoding: "utf8", env: { ...process.env, MINISIGN_SECRET_KEY: "", MINISIGN_PASSWORD: "", ...env } });
}
/** 使い捨ての鍵（パスワード付きにもできる）。公開鍵の base64 行と、秘密鍵ファイルの中身を返す。 */
function newKey(d, name, password) {
  const pub = path.join(d, `${name}.pub`), key = path.join(d, `${name}.key`);
  const args = password ? ["-G", "-f", "-p", pub, "-s", key] : ["-G", "-f", "-W", "-p", pub, "-s", key];
  const r = spawnSync("minisign", args, { input: password ? `${password}\n${password}\n` : undefined, encoding: "utf8" });
  assert.strictEqual(r.status, 0, r.stderr);
  return { pubLine: fs.readFileSync(pub, "utf8").trim().split("\n").pop(), secret: fs.readFileSync(key, "utf8") };
}
const keysFile = (d, pubLine) => { const f = path.join(d, "keys.json"); fs.writeFileSync(f, JSON.stringify({ keys: [pubLine] })); return f; }

test("予行演習: 使い捨ての鍵で .exe と .AppImage に署名し、検証まで通る（公式の署名ではないと明示）", { skip }, () => {
  const d = work();
  try {
    const r = run(d, "rehearsal");
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /公式の署名ではありません/);
    for (const n of [EXE, APP]) assert.ok(fs.existsSync(path.join(d, "dist", `${n}.minisig`)), `${n}.minisig`);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test("official 負例: MINISIGN_SECRET_KEY が無ければ失敗する（署名なしで黙って出さない）", { skip }, () => {
  const d = work();
  try {
    const r = run(d, "official");
    assert.strictEqual(r.status, 1);
    assert.match(r.stdout + r.stderr, /MINISIGN_SECRET_KEY が未設定/);
    assert.strictEqual(fs.existsSync(path.join(d, "dist", `${EXE}.minisig`)), false);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test("official 負例: secrets の鍵が公式の公開鍵と食い違えば、検証で失敗する（別の鍵を入れた事故を公開前に止める）", { skip }, () => {
  const d = work();
  try {
    const wrong = newKey(d, "wrong", "pw1");
    const official = newKey(d, "official", "pw2"); // 「公式の公開鍵」として keys.json に置く側
    const r = run(d, "official", { MINISIGN_SECRET_KEY: wrong.secret, MINISIGN_PASSWORD: "pw1", TRUSTED_KEYS_FILE: keysFile(d, official.pubLine) });
    assert.strictEqual(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout + r.stderr, /署名の検証に失敗/);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test("official 正例: 公式の公開鍵に対応する鍵（パスワード付き）で署名でき、アプリの検証（minisign.js）も通る。trusted comment は版とファイル名", { skip }, async () => {
  const d = work();
  try {
    const k = newKey(d, "official", "correct horse");
    const r = run(d, "official", { MINISIGN_SECRET_KEY: k.secret, MINISIGN_PASSWORD: "correct horse", TRUSTED_KEYS_FILE: keysFile(d, k.pubLine) });
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    for (const n of [EXE, APP]) {
      const sig = fs.readFileSync(path.join(d, "dist", `${n}.minisig`), "utf8");
      // アプリが実際に使う検証（BLAKE2b は Worker）。trusted comment が期待どおりでなければ通らない
      const ok = await verifyFile(path.join(d, "dist", n), sig, [k.pubLine], { expectTrusted: `graphy-next v${VER} ${n}` });
      assert.strictEqual(ok.ok, true, `${n}: ${JSON.stringify(ok)}`);
      // 別のファイル名・別の版の期待では拒否される（ダウングレード対策）
      const bad = await verifyFile(path.join(d, "dist", n), sig, [k.pubLine], { expectTrusted: `graphy-next v0.8.0 ${n}` });
      assert.strictEqual(bad.reason, "trusted-comment-mismatch");
    }
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test("official 正例: パスワードの無い鍵でも署名できる", { skip }, () => {
  const d = work();
  try {
    const k = newKey(d, "official", null);
    const r = run(d, "official", { MINISIGN_SECRET_KEY: k.secret, TRUSTED_KEYS_FILE: keysFile(d, k.pubLine) });
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test("負例: 版に合うインストーラが無い・mode が不正なら失敗する", { skip }, () => {
  const d = work();
  try {
    const r1 = run(d, "rehearsal", {}, "9.9.9");
    assert.strictEqual(r1.status, 1);
    assert.match(r1.stdout + r1.stderr, /もありません/);
    const r2 = run(d, "bogus");
    assert.strictEqual(r2.status, 2);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});
