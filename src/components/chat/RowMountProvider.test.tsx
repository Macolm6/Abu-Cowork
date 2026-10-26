// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import RowMountProvider from './RowMountProvider';
import { useEntersAfterRowMount } from './rowMount';

function Probe({ shown = true }: { shown?: boolean }) {
  const entersAfter = useEntersAfterRowMount(shown);
  return <span data-testid="probe">{String(entersAfter)}</span>;
}

describe('RowMountProvider', () => {
  afterEach(() => cleanup());

  describe('useEntersAfterRowMount', () => {
    it('is false for content shown together with its row', () => {
      render(<RowMountProvider><Probe /></RowMountProvider>);
      expect(screen.getByTestId('probe').textContent).toBe('false');
    });

    it('is true for content that mounts inside a row that has already mounted', () => {
      const { rerender } = render(<RowMountProvider>{null}</RowMountProvider>);
      rerender(<RowMountProvider><Probe /></RowMountProvider>);
      expect(screen.getByTestId('probe').textContent).toBe('true');
    });

    it('is true for content first shown after its row mounted, by a component that mounted with the row', () => {
      const { rerender } = render(<RowMountProvider><Probe shown={false} /></RowMountProvider>);
      rerender(<RowMountProvider><Probe shown /></RowMountProvider>);
      expect(screen.getByTestId('probe').textContent).toBe('true');
    });

    it('keeps its decision while the content stays shown', () => {
      const { rerender } = render(<RowMountProvider><Probe /></RowMountProvider>);
      rerender(<RowMountProvider><Probe /></RowMountProvider>);
      expect(screen.getByTestId('probe').textContent).toBe('false');
    });

    it('decides again when content shown with its row is hidden and shown again', () => {
      const { rerender } = render(<RowMountProvider><Probe /></RowMountProvider>);
      rerender(<RowMountProvider><Probe shown={false} /></RowMountProvider>);
      rerender(<RowMountProvider><Probe /></RowMountProvider>);
      expect(screen.getByTestId('probe').textContent).toBe('true');
    });

    it('is true outside a row', () => {
      render(<Probe />);
      expect(screen.getByTestId('probe').textContent).toBe('true');
    });
  });
});
