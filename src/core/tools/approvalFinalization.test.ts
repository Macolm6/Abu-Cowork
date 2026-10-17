import { describe, expect, it } from 'vitest';
import { finalizeToolApproval, rememberToolApproval, releaseToolApproval } from './approvalFinalization';
import type { ToolApprovalDecision } from './registry';

describe('approval receipt lifetime', () => {
  it('releases a recorded receipt once and prevents further validation of it', async () => {
    const decision: ToolApprovalDecision = { decision: 'allow' };
    let releases = 0;
    rememberToolApproval(decision, {
      input: {}, recordDenial: () => { throw new Error('Unexpected refusal'); },
      reportConsent: () => { throw new Error('Released receipt must not report consent'); },
      release: () => { releases += 1; },
    });
    await releaseToolApproval(decision);
    await releaseToolApproval(decision);
    expect(releases).toBe(1);
    expect(finalizeToolApproval(decision)).toBe(decision);
  });

  it('returns an asynchronous local permission refusal before reporting consent', async () => {
    const decision: ToolApprovalDecision = { decision: 'allow' };
    const refusal: ToolApprovalDecision = { decision: 'deny', reason: 'local scope expired' };
    rememberToolApproval(decision, {
      input: {}, recordDenial: () => { throw new Error('Unexpected provider refusal'); },
      reportConsent: () => { throw new Error('Refused receipt must not report consent'); },
      checkPermissions: async () => refusal,
    });
    await expect(finalizeToolApproval(decision)).resolves.toBe(refusal);
    await releaseToolApproval(decision);
  });
});
