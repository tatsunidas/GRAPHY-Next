// 自動スタブの実体（portable-app/stubPlugin.ts が生成するモジュールから使う）。
type AnyFn = (...a: unknown[]) => unknown;

/** 何もしない関数。プロパティ参照・呼び出しの結果も同じ関数（チェーン呼び出しで落ちない）。 */
export function stubFn(_name: string): AnyFn {
  const f: AnyFn = new Proxy(function () {} as AnyFn, {
    get: (_t, p) => (p === Symbol.toPrimitive ? () => "" : p === "then" ? undefined : f),
    apply: () => undefined,
  });
  return f;
}

/** ポータブル版では使えない非同期 API。呼び出し側の .catch に落とす。 */
export function stubAsync(name: string): AnyFn {
  return () => Promise.reject(new Error(`portable: ${name} is not available`));
}
