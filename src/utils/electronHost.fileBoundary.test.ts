import { afterEach, describe, expect, it, vi } from 'vitest';
import { inspectElectronPathNameComparison, invokeElectronFileOperation } from './electronHost';

afterEach(() => { vi.unstubAllGlobals(); });

describe('controlled file preload boundary', () => {
  it('requires both capabilities when the shell bridge is absent', async () => {
    vi.stubGlobal('__ABU_SHELL__', undefined);
    await expect(inspectElectronPathNameComparison('/work/link')).rejects.toThrow('Filesystem name comparison is unavailable');
    await expect(invokeElectronFileOperation('read', {})).rejects.toThrow('Controlled file access is unavailable');
  });

  it('preserves the final-link choice and returns native comparison facts unchanged', async () => {
    const facts = { lexical: { path: '/work/link', root: '/', components: [] }, canonical: { path: '/work/target', root: '/', components: [] } };
    const inspect = vi.fn(async () => facts);
    vi.stubGlobal('__ABU_SHELL__', { inspectPathNameComparison: inspect });
    await expect(inspectElectronPathNameComparison('/work/link', false)).resolves.toBe(facts);
    expect(inspect).toHaveBeenCalledWith('/work/link', false);
    await inspectElectronPathNameComparison('/work/link');
    expect(inspect).toHaveBeenLastCalledWith('/work/link', true);
  });

  it('forwards the complete controlled request and propagates native refusal', async () => {
    const request = { session: 'session', reference: 'reference', text: 'x'.repeat(1000) };
    const result = { bytes: [1, 2, 3] };
    const invoke = vi.fn().mockResolvedValueOnce(result).mockRejectedValueOnce(new Error('reference expired'));
    vi.stubGlobal('__ABU_SHELL__', { fileOperation: invoke });
    await expect(invokeElectronFileOperation('read', request)).resolves.toBe(result);
    expect(invoke).toHaveBeenCalledWith('read', request);
    await expect(invokeElectronFileOperation('read', request)).rejects.toThrow('reference expired');
  });
});
