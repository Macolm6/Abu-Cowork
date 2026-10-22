/**
 * Rejection memory — which request capabilities each model has rejected in
 * this process.
 *
 * Keyed by `providerId/modelId`, held in memory only (never persisted): a
 * restart starts clean, and a rejection is learned again at the cost of one
 * failed request. The agent loop writes to it when a provider answers 400 with
 * a known capability-rejection text; both adapters and the loop read it when
 * they resolve the model profile, so the switch stays off for the rest of the
 * session. The loop also carries the set inside `ChatOptions.capabilityOverrides`
 * so an adapter running in another process sees the same classes.
 */
import type { CapabilityRejectionClass } from './capabilityRejection';

const memory = new Map<string, Set<CapabilityRejectionClass>>();

const EMPTY: ReadonlySet<CapabilityRejectionClass> = new Set();

export function rejectionMemoryKey(providerId: string | undefined, modelId: string): string {
  return `${providerId ?? 'unknown'}/${modelId}`;
}

/**
 * Record one rejected class. Returns `true` when the class was new for this
 * model — the caller may retry once; `false` when the same class was already
 * recorded, which means the retry already happened and the error is final.
 */
export function recordCapabilityRejection(
  providerId: string | undefined,
  modelId: string,
  rejected: CapabilityRejectionClass,
): boolean {
  const key = rejectionMemoryKey(providerId, modelId);
  let classes = memory.get(key);
  if (!classes) {
    classes = new Set();
    memory.set(key, classes);
  }
  if (classes.has(rejected)) return false;
  classes.add(rejected);
  return true;
}

export function rejectedCapabilities(
  providerId: string | undefined,
  modelId: string,
): ReadonlySet<CapabilityRejectionClass> {
  return memory.get(rejectionMemoryKey(providerId, modelId)) ?? EMPTY;
}

/** Tests only: forget every recorded rejection. */
export function resetRejectionMemory(): void {
  memory.clear();
}
