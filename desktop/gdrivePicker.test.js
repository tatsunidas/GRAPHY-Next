// `node --test`。Picker の loopback 受け口。守りたいのは、
//   1. nonce の無い経路・自分のものでない Host・別 Origin からの POST は受け付けない（トークンを渡さない・結果を差し込ませない）
//   2. 結果の id は形を検査する（不正なら選択なし）
//   3. 同時に 1 つだけ・時間切れで閉じる
// 🔴 electron を import しない。

const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const { pick, busy } = require("./gdrivePicker");

function req(url, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const r = http.request({ host: u.hostname, port: u.port, path: u.pathname, method, headers }, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => resolve({ status: res.statusCode, body: b, headers: res.headers }));
    });
    r.on("error", reject);
    if (body) r.write(body);
    r.end();
  });
}

/** pick を起動し、openExternal に渡された URL を返す。 */
function start(extra = {}) {
  let urlResolve;
  const urlP = new Promise((r) => (urlResolve = r));
  const result = pick({ token: "TOKEN-123", apiKey: "KEY", projectNumber: "99", locale: "ja", openExternal: urlResolve, ...extra });
  return { urlP, result };
}

const GOOD_ID = "1ZZzSqsb-tbQJf0x720J";

test("正例: ページ・スクリプト・初期値が返り、自分の Origin からの POST で結果が決まる", async () => {
  const { urlP, result } = start();
  const url = await urlP;
  const origin = new URL(url).origin;
  const page = await req(url);
  assert.equal(page.status, 200);
  assert.match(page.headers["content-security-policy"], /frame-src https:\/\/\*\.google\.com/);
  assert.equal((await req(`${url}view.js`)).status, 200);
  const init = JSON.parse((await req(`${url}init`)).body);
  assert.equal(init.token, "TOKEN-123");
  assert.equal(init.strings.myDrive, "マイドライブ");
  const post = await req(`${url}done`, { method: "POST", headers: { Origin: origin }, body: JSON.stringify({ ok: true, id: GOOD_ID, name: "Team" }) });
  assert.equal(post.status, 200);
  assert.deepEqual(await result, { ok: true, id: GOOD_ID, name: "Team" });
  assert.equal(busy(), false);
});

test("負例: nonce の無い経路・別の Host・Origin の無い／別の POST は 404。トークンは渡さず、結果も決まらない", async () => {
  const { urlP, result } = start();
  const url = await urlP;
  const u = new URL(url);
  const origin = u.origin;
  assert.equal((await req(`${origin}/init`)).status, 404);
  assert.equal((await req(`${origin}/wrongnonce/init`)).status, 404);
  const rebinding = await req(`${url}init`, { headers: { Host: "evil.example:80" } });
  assert.equal(rebinding.status, 404);
  assert.ok(!rebinding.body.includes("TOKEN-123"));
  const body = JSON.stringify({ ok: true, id: GOOD_ID, name: "x" });
  assert.equal((await req(`${url}done`, { method: "POST", body })).status, 404);
  assert.equal((await req(`${url}done`, { method: "POST", headers: { Origin: "http://evil.example" }, body })).status, 404);
  assert.equal(busy(), true, "偽の POST では終わらない");
  await req(`${url}done`, { method: "POST", headers: { Origin: origin }, body: JSON.stringify({ ok: false, error: "cancelled" }) });
  assert.deepEqual(await result, { ok: false, error: "cancelled" });
});

test("負例: 不正な id・壊れた本文は選択なし（既存の保存先は作られない）", async () => {
  for (const bad of [{ ok: true, id: "../etc/passwd" }, { ok: true, id: "short" }, { ok: true, id: 123 }, "not json"]) {
    const { urlP, result } = start();
    const url = await urlP;
    await req(`${url}done`, {
      method: "POST",
      headers: { Origin: new URL(url).origin },
      body: typeof bad === "string" ? bad : JSON.stringify(bad),
    });
    const r = await result;
    assert.equal(r.ok, false, JSON.stringify(bad));
  }
});

test("同時に 1 つだけ・時間切れで閉じる", async () => {
  const first = start({ timeoutMs: 150 });
  await first.urlP;
  assert.deepEqual(await pick({ token: "t", apiKey: "k", projectNumber: "1", openExternal() {} }), { ok: false, error: "busy" });
  assert.deepEqual(await first.result, { ok: false, error: "timeout" });
  assert.equal(busy(), false);
});

test("ブラウザを開けなければ失敗で終わる", async () => {
  const r = await pick({ token: "t", apiKey: "k", projectNumber: "1", openExternal() { throw new Error("no browser"); } });
  assert.equal(r.ok, false);
  assert.match(r.error, /open: no browser/);
  assert.equal(busy(), false);
});
