import { synchronizers, SynchronizerManager } from "@cornerstonejs/tools";

/**
 * GridView リンク用の同期。camera（pan/zoom/rotate/flip）と VOI（W/L）を、
 * 同一グループに add した全ビューポート間で同期する。重複生成は getSynchronizer で回避。
 */
export function getOrCreateCameraSync(id: string) {
  return SynchronizerManager.getSynchronizer(id) ?? synchronizers.createCameraPositionSynchronizer(id);
}

export function getOrCreateVoiSync(id: string) {
  return (
    SynchronizerManager.getSynchronizer(id) ??
    synchronizers.createVOISynchronizer(id, { syncInvertState: true, syncColormap: false })
  );
}
