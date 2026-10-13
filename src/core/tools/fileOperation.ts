import type { ToolExecutionContext } from '@/types';
import type { FsDirEntry, FsStat } from '@/core/tools/fsBridge';
import type { FileSearchResult } from '@/core/tools/fileOperationHost';

export type FileAccessPurpose = 'read' | 'write' | 'list' | 'traverse' | 'delete';

export interface FileOperationTarget {
  readonly inputPath: string;
  readonly path: string;
  readonly purpose: FileAccessPurpose;
  readonly followFinalSymlink: boolean;
}

export interface FileOperationPlan {
  readonly input: Readonly<Record<string, unknown>>;
  readonly targets: readonly FileOperationTarget[];
  readonly homePath: string;
  readonly workspacePath: string | null;
}

export interface FileOpenDocumentReport {
  supported: boolean;
  complete: boolean;
  documents: Array<{ app: string; name: string; path: string; unsaved: boolean; samePath: boolean }>;
}

/** This object stays in the host process and belongs to one tool invocation. */
export interface ToolFileAccess {
  readonly executionInput: Readonly<Record<string, unknown>>;
  /** The approved lexical path for a target whose execution path follows links. */
  originalPath(path: string): string;
  prepare(): Promise<void>;
  assertCurrent(): Promise<void>;
  /** Check cancellation synchronously immediately before starting external I/O. */
  assertActive(): void;
  /** A captured result keeps logical authorization after its native handles close. */
  resultGuard(): FileOperationGuard;
  stat(path: string): Promise<FsStat>;
  exists(path: string): Promise<boolean>;
  readTextFile(path: string): Promise<string>;
  readFile(path: string): Promise<Uint8Array>;
  processImage(inputPath: string, outputPath: string | null, operation: string, params: Record<string, unknown>): Promise<Uint8Array | void>;
  runProcessor(path: string, program: string, args: readonly (string | null)[]): Promise<{ stdout: string; stderr: string; code: number }>;
  openDocument(path: string): Promise<FileOpenDocumentReport>;
  writeTextFile(path: string, text: string): Promise<void>;
  writeFile(path: string, bytes: Uint8Array): Promise<void>;
  ensureParentDir(path: string): Promise<void>;
  readDir(path: string): Promise<FsDirEntry[]>;
  walkFiles(path: string, options?: {
    excludeNames?: readonly string[];
    skipHiddenDirectories?: boolean;
    skipSymlinks?: boolean;
    maxDepth?: number;
  }): AsyncIterable<{ path: string; name: string }>;
  searchLines(path: string, pattern: string, maxResults: number): Promise<FileSearchResult>;
  prepareDelete(path: string): Promise<void>;
  moveToTrash(path: string): Promise<void>;
  dispose(): Promise<void>;
}

export interface FileOperationContext {
  readonly toolContext: ToolExecutionContext | undefined;
  /** The approval may acquire a temporary grant after the operation is created. */
  getScopeId(): string | undefined;
}

export type FileOperationGuard = Pick<ToolFileAccess, 'assertCurrent' | 'assertActive'>;

/** Keep each external stage inside the original invocation's lifetime. */
export async function runFileOperationStage<T>(guard: FileOperationGuard | undefined, operation: () => Promise<T>): Promise<T> {
  await guard?.assertCurrent();
  guard?.assertActive();
  const result = await operation();
  await guard?.assertCurrent();
  guard?.assertActive();
  return result;
}

/** Authorization refusals are returned as tool feedback without transport retry. */
export class FileOperationDenied extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FileOperationDenied';
  }
}
