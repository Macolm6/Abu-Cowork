import type { ToolApprovalDecision } from './registry';
import type { OperationAuthorizationDecision, ToolOperationAuthorization } from './operationAuthorization';

interface ApprovalOperation {
  authorization: ToolOperationAuthorization;
  input: Readonly<Record<string, unknown>>;
  recordDenial: (decision: Exclude<OperationAuthorizationDecision, { decision: 'allow' }>) => void;
  reportConsent: () => void;
  checkPermissions?: () => ToolApprovalDecision | null | Promise<ToolApprovalDecision | null>;
}

const operations = new WeakMap<ToolApprovalDecision, ApprovalOperation>();

export function rememberToolApproval(decision: ToolApprovalDecision, operation: ApprovalOperation): void {
  operations.set(decision, operation);
}

/** A synchronous allow has passed every check immediately before consumption. */
export function finalizeToolApproval(decision: ToolApprovalDecision): ToolApprovalDecision | Promise<ToolApprovalDecision> {
  const operation = operations.get(decision);
  if (!operation || decision.decision === 'deny') return decision;
  const checked = operation.authorization.validate(operation.input);
  if (checked.decision === 'reauthorize') {
    return operation.authorization.authorize(operation.input).then(result => {
      if (result.decision === 'allow') return decision;
      operation.recordDenial(result);
      return { decision: 'deny', reason: result.reason };
    });
  }
  if (checked.decision === 'deny') {
    operation.recordDenial(checked);
    return { decision: 'deny', reason: checked.reason };
  }
  const permissions = operation.checkPermissions?.();
  if (permissions instanceof Promise) return permissions.then(result => result ?? decision);
  if (permissions) return permissions;
  operation.reportConsent();
  return decision;
}
