/**
 * Whether a file-system error says the path does not exist. Reads the error
 * code first; an error that crossed the renderer IPC boundary has lost its
 * code, so the message is read as well.
 */
export function isMissingPathError(error: unknown): boolean {
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code ?? '')
    : '';
  if (code === 'ENOENT' || code === 'ENOTDIR') return true;
  return /enoent|enotdir|not found|no such file|cannot find/i.test(String(error));
}
