import type { ToolExecutionContext } from '@/types';
import { beginToolOperationAuthorization, captureFilePlanningGuard } from './operationAuthorization';
import { hasToolFileTargets, planToolFiles } from './fileToolTargets';
import { FileOperationDenied, type ToolFileAccess } from './fileOperation';

/** Internal readers keep the operation owner and existing local scope. */
export async function openAuthorizedFileOperation(
  toolName: string,
  input: Record<string, unknown>,
  context: ToolExecutionContext,
): Promise<ToolFileAccess | null> {
  const operation = beginToolOperationAuthorization(toolName, input, context);
  if (!operation) return null;
  const planning = hasToolFileTargets(toolName) ? captureFilePlanningGuard() : undefined;
  let files: ToolFileAccess | undefined;
  let prepared = false;
  try {
    const plan = await planToolFiles(toolName, operation.input, context);
    planning?.assertCurrent();
    if (!plan || !operation.authorization.createFiles) return null;
    files = operation.authorization.createFiles(plan, {
      toolContext: context, getScopeId: () => context.authorizationScopeId,
    });
    await files.prepare();
    const decision = await operation.authorization.authorize(files.executionInput);
    if (decision.decision === 'deny') throw new FileOperationDenied(decision.reason);
    await files.assertCurrent();
    planning?.assertCurrent();
    prepared = true;
    return files;
  } finally {
    planning?.dispose();
    if (!prepared) await files?.dispose();
  }
}
