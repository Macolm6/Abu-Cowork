import { describe, expect, it } from 'vitest';
import { isMissingPathError } from './fsErrors';

function withCode(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

describe('isMissingPathError', () => {
  it('reads the code of a Node error', () => {
    expect(isMissingPathError(withCode('ENOENT: no such file or directory', 'ENOENT'))).toBe(true);
    expect(isMissingPathError(withCode('ENOTDIR: not a directory', 'ENOTDIR'))).toBe(true);
  });

  it('reads the message of an error that lost its code crossing IPC', () => {
    expect(isMissingPathError(new Error("Error invoking remote method 'tauri:invoke': no such file or directory"))).toBe(true);
    expect(isMissingPathError('The system cannot find the path specified.')).toBe(true);
  });

  it('does not take any other failure for a missing path', () => {
    expect(isMissingPathError(withCode('EACCES: permission denied', 'EACCES'))).toBe(false);
    expect(isMissingPathError(withCode('EPERM: operation not permitted', 'EPERM'))).toBe(false);
    expect(isMissingPathError(withCode('EIO: i/o error', 'EIO'))).toBe(false);
    expect(isMissingPathError(null)).toBe(false);
  });
});
