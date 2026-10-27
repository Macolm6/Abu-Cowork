// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../TaskProgressPanel', () => ({ default: () => <div data-testid="section">progress</div> }));
vi.mock('../ChangedFilesSection', () => ({ default: () => <div data-testid="section">changed files</div> }));
vi.mock('../WorkspaceFilesSection', () => ({ default: () => <div data-testid="section">all files</div> }));

import SummaryBody from './SummaryBody';

describe('SummaryBody', () => {
  afterEach(cleanup);

  it('shows the progress, the changed files and all the files of the workspace, in that order', () => {
    render(<SummaryBody />);
    expect(screen.getAllByTestId('section').map((section) => section.textContent)).toEqual([
      'progress',
      'changed files',
      'all files',
    ]);
  });
});
