import type { ToolExecutionContext } from '@/types';
import { createPortSlot } from '@/core/agent/ports/portSlot';

export type OperationAuthorizationDecision =
  | { decision: 'allow' }
  | {
    decision: 'deny';
    reason: string;
    denialKind: 'policy-denied' | 'user-cancelled' | 'context-changed';
  };

export interface FileAuthorizationTarget {
  inputPath: string;
  lexicalPath: string;
  canonicalPath: string;
  capability: 'read' | 'write';
  followFinalSymlink: boolean;
}

export interface ToolOperationOwner {
  isCurrent(): boolean;
  onInvalidated?: (listener: () => void) => () => void;
}

export interface ToolOperationRequest {
  toolName: string;
  input: Readonly<Record<string, unknown>>;
  workspacePath: string | null;
  interactionMode: 'foreground' | 'background';
  abortSignal?: AbortSignal;
  owner?: ToolOperationOwner;
}

export interface ToolOperationAuthorization {
  inspect(): OperationAuthorizationDecision;
  authorize(executionInput: Readonly<Record<string, unknown>>): Promise<OperationAuthorizationDecision>;
  authorizeFile(target: FileAuthorizationTarget): Promise<OperationAuthorizationDecision>;
  /** Runs synchronously immediately before consuming an approval. */
  validate(executionInput: Readonly<Record<string, unknown>>): OperationAuthorizationDecision | { decision: 'reauthorize' };
}

export interface ToolAuthorizationProvider {
  begin(request: ToolOperationRequest): ToolOperationAuthorization;
  captureOwner?: () => ToolOperationOwner;
}

const provider = createPortSlot<ToolAuthorizationProvider | null>(() => null);
export const setToolAuthorizationProvider = provider.set;

export function hasToolAuthorizationProvider(): boolean {
  return provider.get() !== null;
}

export function captureToolOperationOwner(): ToolOperationOwner | undefined {
  return provider.get()?.captureOwner?.();
}

function freezeValue(value: unknown): void {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return;
  for (const child of Object.values(value)) freezeValue(child);
  Object.freeze(value);
}

/** Capture the complete request before any approval can wait. */
export function freezeToolInput(input: Record<string, unknown>): Readonly<Record<string, unknown>> {
  const copy: Record<string, unknown> = structuredClone(input);
  freezeValue(copy);
  return copy;
}

export function beginToolOperationAuthorization(
  toolName: string,
  input: Record<string, unknown>,
  context?: ToolExecutionContext,
): { input: Readonly<Record<string, unknown>>; authorization: ToolOperationAuthorization } | null {
  const current = provider.get();
  if (!current) return null;
  const captured = freezeToolInput(input);
  return {
    input: captured,
    authorization: current.begin({
      toolName, input: captured,
      workspacePath: context?.workspacePath ?? null,
      interactionMode: context?.interactionMode ?? 'foreground',
      ...(context?.abortSignal ? { abortSignal: context.abortSignal } : {}),
      ...(context?.operationOwner ? { owner: context.operationOwner } : {}),
    }),
  };
}
