// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../TaskProgressPanel', () => ({ default: () => <div data-testid="section">progress</div> }));
vi.mock('../ChangedFilesSection', () => ({ default: () => <div data-testid="section">changed files</div> }));
vi.mock('../WorkspaceSection', () => ({ default: () => <div data-testid="section">workspace</div> }));
vi.mock('../ContextSection', () => ({ default: () => <div data-testid="section">context</div> }));

import SummaryBody from './SummaryBody';

describe('SummaryBody', () => {
  afterEach(cleanup);

  it('shows the progress, the changed files, the workspace and the operation record, in that order', () => {
    render(<SummaryBody />);
    expect(screen.getAllByTestId('section').map((section) => section.textContent)).toEqual([
      'progress',
      'changed files',
      'workspace',
      'context',
    ]);
  });
});
