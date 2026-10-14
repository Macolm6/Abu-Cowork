import { useEffect, useRef } from 'react';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { useConfirm } from '@/components/ds/confirm-context';
import { useI18n } from '@/i18n';
import { isTauriEnv } from '@/utils/tauriEnv';
import { useChatStore } from '@/stores/chatStore';
import { answerQuitRequest, type QuitRequest } from '@/core/session/quitFlush';

/**
 * Answers the main process when the application is quit: asks before a
 * running task is interrupted. The host starts saving after confirmation.
 */
export default function QuitRequestListener() {
  const confirm = useConfirm();
  const { t } = useI18n();
  const latest = useRef({ confirm, t });
  useEffect(() => {
    latest.current = { confirm, t };
  }, [confirm, t]);

  useEffect(() => {
    if (!isTauriEnv()) return;
    let unlistenFn: (() => void) | null = null;
    let cancelled = false;
    listen<QuitRequest>('quit-requested', (event) => {
      void answerQuitRequest(event.payload, {
        hasRunningConversation: () => {
          const state = useChatStore.getState();
          return Object.values(state.conversations).some(c => c.status === 'running'
            && (!state.hasAbortController(c.id) || !state.getAbortController(c.id).signal.aborted));
        },
        askToQuit: async () => {
          // The window may be in the tray: the question has to be seen.
          await invoke('window_show');
          const { confirm: ask, t: text } = latest.current;
          return ask({
            title: text.windowClose.quitWhileRunning,
            confirmLabel: text.windowClose.quit,
          });
        },
        report: (requestId, stage) => invoke('app_quit_report', { requestId, stage }),
      });
    }).then((fn) => {
      if (cancelled) fn();
      else unlistenFn = fn;
    });
    return () => {
      cancelled = true;
      unlistenFn?.();
    };
  }, []);

  return null;
}
