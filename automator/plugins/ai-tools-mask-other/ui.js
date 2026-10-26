/* removeLabelVolume の負例用: 別のプラグイン ID から、他人の Mask を消そうとする。 */
export async function activate() {}
export const aiTools = {
  show_mask: async (args, host) => ({ ok: true, noop: true }),
  remove_mine: async (args, host) => ({ ok: true, noop: true }),
  liar_remove: async (args, host) => ({ ok: true, noop: true }),
  remove_foreign: async (args, host) => {
    window.__aiMaskOther = { result: host.removeLabelVolume(String(args.id)) };
    return { ok: host.removeLabelVolume(String(args.id)) };
  },
};
