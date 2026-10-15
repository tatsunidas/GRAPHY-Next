/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * TLS 設定の保存で、パスワードをどこへ送るかを決める。
 *
 * <p>backend はパスワードを返さない（null で返し、設定済みかどうかだけを返す）。画面では
 * 入力したときだけ変える: null は「変えない」、空文字は「消す」。
 * デスクトップは OS のキーチェーン（main の tlsPasswordSet）へ、web は従来どおり REST で送る。
 */
import type { TlsConfig } from "../api";

export type TlsPasswordWhich = "keyStore" | "trustStore";
export type PendingPasswords = Record<TlsPasswordWhich, string | null>;

export const NO_CHANGE: PendingPasswords = { keyStore: null, trustStore: null };

export function tlsSavePlan(cfg: TlsConfig, pending: PendingPasswords, desktop: boolean): {
  config: TlsConfig;
  keychain: [TlsPasswordWhich, string][];
} {
  if (desktop) {
    const keychain = (Object.keys(pending) as TlsPasswordWhich[])
      .filter((w) => pending[w] !== null)
      .map((w) => [w, pending[w] as string] as [TlsPasswordWhich, string]);
    return { config: { ...cfg, keyStorePassword: null, trustStorePassword: null }, keychain };
  }
  return {
    config: { ...cfg, keyStorePassword: pending.keyStore, trustStorePassword: pending.trustStore },
    keychain: [],
  };
}

/** 欄の横に出す状態の文言キー。 */
export function passwordStateKey(isSet: boolean, pending: string | null): string {
  if (pending === "") return "settings.tls.pw.willClear";
  if (pending !== null) return "settings.tls.pw.willChange";
  return isSet ? "settings.tls.pw.set" : "settings.tls.pw.unset";
}
