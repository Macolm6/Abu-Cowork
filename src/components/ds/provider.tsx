import { Tooltip as TooltipPrimitive } from 'radix-ui';
import { useEffect, type ReactNode } from 'react';
import { ConfirmProvider } from './confirm-provider';
import { trackInputModality } from './input-modality';
import { LayerProvider } from './layer';

// Everything the design-system components need above them. The app mounts it once at
// the root (from the first batch that uses these components); the design preview
// mounts its own with its host node as the portal container.
// `onModalChange` hears whether a dialog or a question is open, `onDecisionChange` whether an
// approval or a question is asking the user to decide, `onFloatingChange` whether a menu, a
// select list or a popover is shown (see LayerProvider).
export function DesignSystemProvider({ children, container, onModalChange, onDecisionChange, onFloatingChange }: {
  children: ReactNode;
  container?: HTMLElement | null;
  onModalChange?: (open: boolean) => void;
  onDecisionChange?: (asked: boolean) => void;
  onFloatingChange?: (open: boolean) => void;
}) {
  // Dialogs read it to open without a focus ring after a pointer press.
  useEffect(() => trackInputModality(), []);
  return (
    <TooltipPrimitive.Provider delayDuration={500} skipDelayDuration={300}>
      <LayerProvider
        container={container}
        onModalChange={onModalChange}
        onDecisionChange={onDecisionChange}
        onFloatingChange={onFloatingChange}
      >
        <ConfirmProvider>{children}</ConfirmProvider>
      </LayerProvider>
    </TooltipPrimitive.Provider>
  );
}
