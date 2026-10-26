import { useCallback, useLayoutEffect, useRef, type ReactNode } from 'react';
import { RowMountContext } from './rowMount';

/** Wraps one message-list row: tells its content whether the row had mounted before it (see rowMount.ts). */
export default function RowMountProvider({ children }: { children: ReactNode }) {
  const mountedRef = useRef(false);
  useLayoutEffect(() => {
    mountedRef.current = true;
  }, []);
  const rowMounted = useCallback(() => mountedRef.current, []);
  return <RowMountContext.Provider value={rowMounted}>{children}</RowMountContext.Provider>;
}
