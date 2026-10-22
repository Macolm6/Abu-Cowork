import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordCapabilityRejection,
  rejectedCapabilities,
  rejectionMemoryKey,
  resetRejectionMemory,
} from './rejectionMemory';

describe('rejectionMemory', () => {
  beforeEach(() => {
    resetRejectionMemory();
  });

  it('starts empty for every model', () => {
    expect(rejectedCapabilities('p1', 'm1').size).toBe(0);
  });

  it('records a class once: the first record is new, the second is not', () => {
    expect(recordCapabilityRejection('p1', 'm1', 'reasoning_effort')).toBe(true);
    expect(recordCapabilityRejection('p1', 'm1', 'reasoning_effort')).toBe(false);
    expect([...rejectedCapabilities('p1', 'm1')]).toEqual(['reasoning_effort']);
  });

  it('keeps classes per provider and model', () => {
    recordCapabilityRejection('p1', 'm1', 'thinking');
    recordCapabilityRejection('p1', 'm2', 'image_block');
    recordCapabilityRejection('p2', 'm1', 'max_tokens_field');
    expect([...rejectedCapabilities('p1', 'm1')]).toEqual(['thinking']);
    expect([...rejectedCapabilities('p1', 'm2')]).toEqual(['image_block']);
    expect([...rejectedCapabilities('p2', 'm1')]).toEqual(['max_tokens_field']);
  });

  it('a missing provider id is one shared bucket', () => {
    expect(rejectionMemoryKey(undefined, 'm1')).toBe('unknown/m1');
    recordCapabilityRejection(undefined, 'm1', 'thinking');
    expect(rejectedCapabilities(undefined, 'm1').has('thinking')).toBe(true);
    expect(rejectedCapabilities('p1', 'm1').has('thinking')).toBe(false);
  });

  it('reset forgets everything', () => {
    recordCapabilityRejection('p1', 'm1', 'thinking');
    resetRejectionMemory();
    expect(rejectedCapabilities('p1', 'm1').size).toBe(0);
    expect(recordCapabilityRejection('p1', 'm1', 'thinking')).toBe(true);
  });
});
