/** Recognize the error envelopes produced by tool implementations, the registry and run_command. */
export function isToolResultError(result: string): boolean {
  return result.startsWith('Error:')
    || /^Error executing tool "[^"]+":/.test(result)
    || result.startsWith('Error executing command:');
}
