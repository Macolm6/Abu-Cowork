import { describe, it, expect } from 'vitest';
import { isToolResultError } from './toolResultErrors';

describe('isToolResultError', () => {
  it.each([
    ['tool', 'Error: no such file'],
    ['registry', 'Error executing tool "x": boom'],
    ['command', 'Error executing command: command was aborted before it started'],
  ])('recognizes the %s envelope', (_name, result) => {
    expect(isToolResultError(result)).toBe(true);
  });

  it('takes a result that only mentions an error later as success', () => {
    expect(isToolResultError('stdout:\nError: in the log\n\nexit code: 0')).toBe(false);
    expect(isToolResultError('ok')).toBe(false);
  });
});
