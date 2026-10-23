/**
 * The renderer's answer to the window close button (`close-requested`,
 * sent by `wireWindowEvents` in `electron/tauriHost.cjs`).
 */

export interface CloseRequest {
  /** Background commands of every conversation still running, counted by the main process. */
  backgroundCommandCount: number;
}

export type CloseAction = 'ask' | 'minimize' | 'quit';

export type CloseRequestAnswer =
  | { kind: 'quit' }
  | { kind: 'minimize' }
  | { kind: 'ask'; backgroundCommandCount: number };

/** What a close request does under the user's close setting; asking always opens the close dialog. */
export function answerCloseRequest(request: CloseRequest, closeAction: CloseAction): CloseRequestAnswer {
  if (closeAction === 'quit') return { kind: 'quit' };
  if (closeAction === 'minimize') return { kind: 'minimize' };
  return { kind: 'ask', backgroundCommandCount: request.backgroundCommandCount };
}
