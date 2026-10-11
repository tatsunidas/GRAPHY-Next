import { describe, expect, it } from "vitest";
import { NO_CHANGE, passwordStateKey, tlsSavePlan } from "./tlsPasswordPlan";
import type { TlsConfig } from "../api";
import { ja } from "../i18n/ja";
import { en } from "../i18n/en";

const cfg: TlsConfig = {
  enabled: true, port: 2762, keyStore: "/k.p12", keyStorePassword: null, keyStoreType: "PKCS12",
  trustStore: "/t.p12", trustStorePassword: null, trustStoreType: "PKCS12", protocols: [], cipherSuites: [],
  needClientAuth: true, usable: true, keyStorePasswordSet: true, trustStorePasswordSet: false,
};

describe("tlsSavePlan", () => {
  it("デスクトップ: パスワードは REST に載せず、入力したものだけキーチェーンへ", () => {
    const p = tlsSavePlan(cfg, { keyStore: "new", trustStore: null }, true);
    expect(p.config.keyStorePassword).toBeNull();
    expect(p.config.trustStorePassword).toBeNull();
    expect(p.keychain).toEqual([["keyStore", "new"]]);
    expect(tlsSavePlan(cfg, { keyStore: null, trustStore: "" }, true).keychain).toEqual([["trustStore", ""]]);
  });

  it("web: 入力したときだけ REST で送る（null は変えない・空は消す）", () => {
    expect(tlsSavePlan(cfg, NO_CHANGE, false).config.keyStorePassword).toBeNull();
    const p = tlsSavePlan(cfg, { keyStore: "a", trustStore: "" }, false);
    expect([p.config.keyStorePassword, p.config.trustStorePassword]).toEqual(["a", ""]);
    expect(p.keychain).toEqual([]);
  });

  it("状態の文言（ja と en の両方にある）", () => {
    const keys = [passwordStateKey(true, null), passwordStateKey(false, null), passwordStateKey(true, "x"), passwordStateKey(true, "")];
    expect(keys).toEqual(["settings.tls.pw.set", "settings.tls.pw.unset", "settings.tls.pw.willChange", "settings.tls.pw.willClear"]);
    for (const k of [...keys, "settings.tls.pw.clear", "settings.tls.pw.placeholder", "settings.tls.pw.plaintextWarning", "settings.tls.pw.noKeychain"]) {
      expect(ja[k], `ja ${k}`).toBeTruthy();
      expect(en[k], `en ${k}`).toBeTruthy();
    }
  });
});
