// Google へのログイン（Colab API 用）。設計: fw/remote-compute-design.md §15
//
// 方式は OAuth 2.0 の Authorization Code ＋ PKCE（S256）を loopback（http://127.0.0.1:<空きポート>）で受ける。
// Google の「デスクトップ アプリ」型クライアントの正規の使い方（Colab の VS Code 拡張と同じ）。
//
// 守っていること:
//   - refresh token は secretStore（OS のキーチェーン）にだけ置く。アクセストークンはメモリだけ。
//     どちらもレンダラへ返さない（返すのはログイン中か・メールアドレスだけ）
//   - ログインは利用者のブラウザで行う（アプリの窓にパスワードを入れさせない）
//   - state を照合する。loopback の受け口はログイン 1 回ぶんだけ開き、5 分で閉じる
//
// クライアントの設定（client_id / client_secret）は Google からダウンロードした JSON（"installed"）。
// デスクトップ型のシークレットは Google の扱いでは機密ではないが、公開リポジトリには入れない（.gitignore）。

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const SCOPES = ["openid", "email", "profile", "https://www.googleapis.com/auth/colaboratory"];
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";
/** refresh token を預けるキー（secretStore の allowlist にある）。 */
const REFRESH_KEY = "compute.colab.refreshToken";
const CLIENT_FILE = "colab-oauth-client.json";
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

const b64url = (b) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/**
 * @param deps.dirs          クライアント設定を探すフォルダ（先に見つかったもの）
 * @param deps.secrets       { getSecret, setSecret, clearSecret }（secretStore）
 * @param deps.openExternal  (url) => void（electron の shell.openExternal）
 * @param deps.fetch         テスト用（既定は global fetch）
 */
function createColabAuth(deps) {
  const doFetch = deps.fetch || fetch;
  let access = null; // { token, expiresAt }
  let email = null;
  let pendingLogin = null;

  function loadClient() {
    for (const d of deps.dirs) {
      const p = path.join(d, CLIENT_FILE);
      try {
        const j = JSON.parse(fs.readFileSync(p, "utf8"));
        const c = j.installed;
        if (c && c.client_id && c.client_secret) return c;
      } catch {
        // 次の候補へ
      }
    }
    return null;
  }

  function configured() {
    return loadClient() !== null;
  }

  function signedIn() {
    return !!deps.secrets.getSecret(REFRESH_KEY);
  }

  /** id_token のメールアドレス（表示用。署名は確かめない——使い道は画面に出すことだけ）。 */
  function emailFromIdToken(idToken) {
    try {
      const payload = JSON.parse(Buffer.from(idToken.split(".")[1], "base64url").toString("utf8"));
      return typeof payload.email === "string" ? payload.email : null;
    } catch {
      return null;
    }
  }

  function remember(t) {
    access = { token: t.access_token, expiresAt: Date.now() + (Number(t.expires_in) || 3600) * 1000 };
    if (t.id_token) email = emailFromIdToken(t.id_token) || email;
  }

  /** ブラウザでログインする。終わったら { ok, email } 。 */
  function signIn() {
    if (pendingLogin) return pendingLogin;
    const client = loadClient();
    if (!client) return Promise.resolve({ ok: false, error: "no-oauth-client" });
    pendingLogin = new Promise((resolve) => {
      const verifier = b64url(crypto.randomBytes(48));
      const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
      const state = b64url(crypto.randomBytes(16));
      const server = http.createServer();
      let timer = null;
      const finish = (r) => {
        clearTimeout(timer);
        server.close();
        pendingLogin = null;
        resolve(r);
      };
      server.on("error", (e) => finish({ ok: false, error: `loopback: ${e.message}` }));
      server.listen(0, "127.0.0.1", () => {
        const redirect = `http://127.0.0.1:${server.address().port}`;
        const url = `${AUTH_URL}?${new URLSearchParams({
          client_id: client.client_id,
          redirect_uri: redirect,
          response_type: "code",
          scope: SCOPES.join(" "),
          code_challenge: challenge,
          code_challenge_method: "S256",
          state,
          access_type: "offline",
          prompt: "consent",
        })}`;
        timer = setTimeout(() => finish({ ok: false, error: "login-timeout" }), LOGIN_TIMEOUT_MS);
        server.on("request", async (req, res) => {
          const q = new URL(req.url, redirect).searchParams;
          if (!q.get("code") && !q.get("error")) {
            res.statusCode = 404;
            res.end();
            return;
          }
          res.setHeader("Content-Type", "text/html; charset=utf-8");
          res.end("<p>GRAPHY-Next: ログインの結果を受け取りました。この画面は閉じてかまいません。</p>");
          if (q.get("error")) return finish({ ok: false, error: `oauth-${q.get("error")}` });
          if (q.get("state") !== state) return finish({ ok: false, error: "state-mismatch" });
          try {
            const r = await doFetch(TOKEN_URL, {
              method: "POST",
              headers: { "Content-Type": "application/x-www-form-urlencoded" },
              body: new URLSearchParams({
                code: q.get("code"),
                client_id: client.client_id,
                client_secret: client.client_secret,
                redirect_uri: redirect,
                grant_type: "authorization_code",
                code_verifier: verifier,
              }),
            });
            const t = await r.json();
            if (!r.ok || !t.access_token) return finish({ ok: false, error: `token-${t.error || r.status}` });
            if (!String(t.scope || "").includes("auth/colaboratory")) {
              return finish({ ok: false, error: "scope-not-granted" }); // 画面で Colab の権限を外された
            }
            if (t.refresh_token) {
              const s = deps.secrets.setSecret(REFRESH_KEY, t.refresh_token);
              if (!s.ok) return finish({ ok: false, error: `secret-${s.reason}` });
            }
            remember(t);
            finish({ ok: true, email });
          } catch (e) {
            finish({ ok: false, error: `token-exchange: ${e && e.message}` });
          }
        });
        deps.openExternal(url);
      });
    });
    return pendingLogin;
  }

  /** 有効なアクセストークン（期限の 1 分前に refresh token で取り直す）。ログインしていなければ null。 */
  async function accessToken() {
    if (access && access.expiresAt - 60_000 > Date.now()) return access.token;
    const refresh = deps.secrets.getSecret(REFRESH_KEY);
    const client = loadClient();
    if (!refresh || !client) return null;
    const r = await doFetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: client.client_id,
        client_secret: client.client_secret,
        refresh_token: refresh,
        grant_type: "refresh_token",
      }),
    });
    const t = await r.json().catch(() => ({}));
    if (!r.ok || !t.access_token) {
      // invalid_grant＝取り消された・テスト中のアプリで 7 日を過ぎた。ログインし直してもらう
      if (t.error === "invalid_grant") deps.secrets.clearSecret(REFRESH_KEY);
      access = null;
      return null;
    }
    remember(t);
    return access.token;
  }

  /** ログアウト（Google 側の許可も取り消す）。 */
  async function signOut() {
    const refresh = deps.secrets.getSecret(REFRESH_KEY);
    deps.secrets.clearSecret(REFRESH_KEY);
    access = null;
    email = null;
    if (refresh) {
      await doFetch(REVOKE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: refresh }),
      }).catch(() => undefined);
    }
    return { ok: true };
  }

  /**
   * 表示用のメールアドレス。保存したログインで起動し直したときは手元に無いので、
   * アクセストークンを取り直し（id_token が付けばそこから）、無ければ userinfo で引く。
   */
  async function ensureEmail() {
    if (email || !signedIn()) return email;
    const token = await accessToken();
    if (email || !token) return email;
    try {
      const r = await doFetch(USERINFO_URL, { headers: { Authorization: `Bearer ${token}` } });
      const u = await r.json();
      if (r.ok && typeof u.email === "string") email = u.email;
    } catch {
      // 表示できないだけ。使うことには差し支えない
    }
    return email;
  }

  return {
    configured,
    signedIn,
    signIn,
    signOut,
    accessToken,
    ensureEmail,
    email: () => email,
  };
}

module.exports = { createColabAuth, SCOPES, REFRESH_KEY, CLIENT_FILE };
