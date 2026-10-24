export async function activate() {}
export const aiTools = {
  t: async () => {
    window.__aiToolsNoperm = (window.__aiToolsNoperm || 0) + 1;
    return { ran: true };
  },
};
