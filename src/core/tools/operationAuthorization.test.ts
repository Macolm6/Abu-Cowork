import { afterEach, describe, expect, it } from 'vitest';
import {
  beginToolOperationAuthorization,
  freezeToolInput,
  setToolAuthorizationProvider,
  type ToolOperationRequest,
} from './operationAuthorization';

afterEach(() => { setToolAuthorizationProvider(null); });

describe('tool operation authorization extension', () => {
  it('captures the complete request and prevents later caller edits from changing it', () => {
    let received: ToolOperationRequest | undefined;
    setToolAuthorizationProvider({ begin(request) {
      received = request;
      return {
        inspect: () => ({ decision: 'allow' }),
        authorize: async () => ({ decision: 'allow' }),
        authorizeFile: async () => ({ decision: 'allow' }),
        validate: () => ({ decision: 'allow' }),
      };
    } });
    const input = { padding: 'x'.repeat(500), nested: { values: ['original'] } };
    const operation = beginToolOperationAuthorization('extension-probe', input, { workspacePath: '/work' });
    input.nested.values[0] = 'changed';
    expect(received?.input).toEqual({ padding: 'x'.repeat(500), nested: { values: ['original'] } });
    expect(operation?.input).toBe(received?.input);
    expect(received?.workspacePath).toBe('/work');
    expect(Object.isFrozen(received?.input)).toBe(true);
    expect(Object.isFrozen(received?.input.nested)).toBe(true);
    expect(Object.isFrozen((received?.input.nested as { values: string[] }).values)).toBe(true);
  });

  it('preserves a nested request when preparing an execution input', () => {
    const input = { path: '/work/input', options: { values: ['one', 'two'] } };
    const execution = freezeToolInput({ ...input, path: '/work/canonical' });
    input.options.values.push('three');
    expect(execution).toEqual({ path: '/work/canonical', options: { values: ['one', 'two'] } });
  });

  it('has no participant when the host has no registered provider', () => {
    expect(beginToolOperationAuthorization('extension-probe', {})).toBeNull();
  });
});
