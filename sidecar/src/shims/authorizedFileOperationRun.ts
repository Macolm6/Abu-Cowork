import type { openAuthorizedFileOperation as hostOpenAuthorizedFileOperation } from '@/core/tools/authorizedFileOperation';
import type { ShimThrowKind } from './shimThrowKind';

// Controlled file access executes in the host that owns its authorization
// provider and native handles. Sidecar output readers only use manifest data;
// local personal-mode captures do not request an authorized file operation.
export const SHIM_THROW_KIND: ShimThrowKind = 'wiring-guard';

export async function openAuthorizedFileOperation(
  ..._args: Parameters<typeof hostOpenAuthorizedFileOperation>
): Promise<never> {
  throw new Error('[sidecar] Authorized file operations require host execution');
}
