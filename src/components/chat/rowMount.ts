import { createContext, useContext, useState } from 'react';

// Whether the message-list row around a component had already mounted when a
// piece of the component first appeared. Content that appears together with
// its row (switching to a conversation, a row scrolled back into view) is
// already there, so it shows in its final form; content that appears inside a
// mounted row (a step arriving mid-stream, a summary the user opens) plays its
// enter animation. RowMountProvider supplies the value for each row.

export const RowMountContext = createContext<() => boolean>(() => true);

/**
 * Whether the content gated by `shown` entered after its row had mounted:
 * decided each time `shown` turns true, and kept while it stays true.
 * Outside a row: true.
 */
export function useEntersAfterRowMount(shown: boolean): boolean {
  const rowMounted = useContext(RowMountContext);
  const [entry, setEntry] = useState(() => ({ shown, enters: shown ? rowMounted() : true }));
  // Render-phase adjustment: decided in the same render that shows the
  // content, so its first commit already carries the decision.
  if (shown !== entry.shown) {
    const next = { shown, enters: shown ? rowMounted() : entry.enters };
    setEntry(next);
    return next.enters;
  }
  return entry.enters;
}
