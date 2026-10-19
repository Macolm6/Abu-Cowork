import type { BackgroundCommandRef } from '@/types';

/** A `backgroundCommand` value from another process or from disk; undefined when it is not one. */
export function parseBackgroundCommandRef(value: unknown): BackgroundCommandRef | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const command = (value as Record<string, unknown>).command;
  return typeof command === 'string' && command !== '' ? { command } : undefined;
}
