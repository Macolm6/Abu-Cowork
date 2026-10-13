import { invokeElectronFileOperation, type ElectronPathNameComparison } from '@/utils/electronHost';
import type { FsStat } from '@/core/tools/fsBridge';
import { FileOperationDenied, type FileOperationTarget, type FileOpenDocumentReport } from '@/core/tools/fileOperation';

export interface ObservedFileTarget {
  reference: string;
  path: string;
  canonicalPath: string;
  exists: boolean;
  isFile: boolean;
  isDirectory: boolean;
  isSymlink: boolean;
  identity: string | null;
  comparison: ElectronPathNameComparison;
}

export interface FileDirectoryEntryReference {
  name: string;
  reference: string;
}

export interface FileDirectoryPage {
  entries: FileDirectoryEntryReference[];
  cursor: string | null;
  complete: boolean;
}

export interface FileSearchResult {
  searchable: boolean;
  matches: Array<{ lineNumber: number; line: string }>;
  bytesRead: number;
}

/** Generic native operations; the caller owns its authorization decisions. */
export class FileOperationHost {
  private readonly opened: Promise<string>;
  private released = false;

  constructor(targets: readonly FileOperationTarget[]) {
    this.opened = invokeElectronFileOperation<{ session: string }>('open', { targets }).then(result => result.session);
  }

  private async request<T>(action: string, request: Record<string, unknown>): Promise<T> {
    try {
      if (this.released) throw new FileOperationDenied('Error: file operation is closed');
      const session = await this.opened;
      if (this.released) throw new FileOperationDenied('Error: file operation is closed');
      return await invokeElectronFileOperation<T>(action, { ...request, session });
    } catch (error) {
      if (error instanceof FileOperationDenied) throw error;
      throw new FileOperationDenied('Error: file operation could not be completed safely');
    }
  }

  observe(target: FileOperationTarget): Promise<ObservedFileTarget> {
    return this.request('observe', { path: target.path, purpose: target.purpose, followFinalSymlink: target.followFinalSymlink });
  }

  observeChild(parent: string, entry: string, target: FileOperationTarget): Promise<ObservedFileTarget> {
    return this.request('observe-child', {
      parent, entry, purpose: target.purpose, followFinalSymlink: target.followFinalSymlink,
    });
  }

  validate(reference: string): Promise<void> {
    return this.request('validate', { reference });
  }

  compareComponent(reference: string, pathKind: 'lexical' | 'canonical', component: number, pattern: string): Promise<'match' | 'no-match' | 'unknown'> {
    return this.request('compare-component', { reference, pathKind, component, pattern });
  }

  searchLines(reference: string, pattern: string, maxResults: number): Promise<FileSearchResult> {
    return this.request('search-lines', { reference, pattern, maxResults });
  }

  stat(reference: string): Promise<FsStat> {
    return this.request<Omit<FsStat, 'mtime'> & { mtime: string | number | null }>('stat', { reference })
      .then(info => ({ ...info, mtime: info.mtime === null ? null : new Date(info.mtime) }));
  }

  exists(reference: string): Promise<boolean> {
    return this.request('exists', { reference });
  }

  read(reference: string): Promise<Uint8Array> {
    return this.request<{ bytes: number[] }>('read', { reference }).then(result => Uint8Array.from(result.bytes));
  }

  openDocument(reference: string): Promise<FileOpenDocumentReport> {
    return this.request('office-document', { reference });
  }

  async processImage(reference: string, outputReference: string | null, operation: string, params: Record<string, unknown>): Promise<Uint8Array | void> {
    const result = await this.request<{ bytes: number[] } | null>('image-process', {
      reference, ...(outputReference ? { outputReference } : {}), operation, params,
    });
    if (result) return Uint8Array.from(result.bytes);
  }

  runProcessor(reference: string, program: string, args: readonly (string | null)[]): Promise<{ stdout: string; stderr: string; code: number }> {
    return this.request('processor', { reference, program, args });
  }

  write(reference: string, bytes: Uint8Array): Promise<void> {
    return this.request('write', { reference, bytes: Array.from(bytes) });
  }

  ensureParent(reference: string): Promise<void> {
    return this.request('ensure-parent', { reference });
  }

  enumerate(reference: string, cursor: string | null): Promise<FileDirectoryPage> {
    return this.request('enumerate', { reference, cursor });
  }

  trash(reference: string, manifest: readonly string[]): Promise<void> {
    return this.request('trash', { reference, manifest });
  }

  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    const session = await this.opened;
    await invokeElectronFileOperation('release', { session });
  }
}
