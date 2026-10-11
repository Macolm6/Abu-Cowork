/** One unified-diff hunk. Each line starts with ' ', '+' or '-'. */
export interface FileChangeHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

/** What one write_file, edit_file or delete_file call did to its file. */
export interface FileChange {
  /** Absolute, '/' separators. */
  path: string;
  kind: 'create' | 'modify' | 'delete';
  /** Absent when the texts could not be compared. */
  added?: number;
  deleted?: number;
  /** Unified, 3 lines of context. */
  hunks?: FileChangeHunk[];
  /** The hunks were shortened to fit the budget; the counts stay exact. */
  cut?: true;
}
