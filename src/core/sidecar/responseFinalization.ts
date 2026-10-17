type Finalizer = () => unknown | Promise<unknown>;
const finalizers = new WeakMap<object, Finalizer>();

/** Keep final validation local; only the finalized value enters the wire. */
export function withResponseFinalizer<T extends object>(value: T, finalize: Finalizer): T {
  finalizers.set(value, finalize);
  return value;
}

export function finalizeResponse(value: unknown): unknown | Promise<unknown> {
  if (!value || typeof value !== 'object') return value;
  const finalize = finalizers.get(value);
  return finalize ? finalize() : value;
}
