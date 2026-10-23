/**
 * `apply_patch` — file editing in the V4A patch format
 * (`*** Begin Patch` / `*** Update File:` / `*** Add File:` / `*** Delete File:`
 * / `*** Move to:` / `@@` hunks / `*** End Patch`), the format GPT models were
 * trained on in Codex.
 *
 * Parsing and hunk application come from `@galaxysj/v4a` (a port of OpenAI's
 * reference `apply_patch`); this module does the I/O through the same
 * authorized file access, file locks, turn captures and version snapshots as
 * `edit_file` / `write_file`. Every section is read and applied in memory
 * first; a file is written only once the whole patch applied cleanly, so a
 * hunk that does not match leaves the disk untouched.
 */
import { applyDiff, parsePatch, type FileOp } from '@galaxysj/v4a';
import { invoke } from '@tauri-apps/api/core';
import type { ToolDefinition, ToolExecutionContext } from '@/types';
import { exists, readTextFile, writeTextFile } from '../fsBridge';
import { ensureParentDir, isLocalFilePath, joinPath, normalizeLexicalPath } from '@/utils/pathUtils';
import { captureTurnFileBefore, snapshotBeforeAiEdit } from '@/utils/aiEditSnapshots';
import { computeFileChange, diffTexts } from '@/core/files/fileChange';
import { bindWorkspaceFromWrite } from '../../agent/defaultWorkspace';
import { getI18n, format } from '../../../i18n';
import { TOOL_NAMES } from '../toolNames';
import { acquireFileLock, fileBusyMessage, releaseFileLock, writtenVersionOf } from './fileTools';
import { recordFileVersion } from '../fileReadRecords';

/** One file section of a parsed patch, with its paths as the model wrote them. */
export type PatchOperation = FileOp;

/** The paths of a section after the file planner resolved them. */
export interface ResolvedPatchOperation {
  type: PatchOperation['type'];
  path: string;
  moveTo?: string;
}

/** Parses the whole envelope; a malformed patch comes back as the parser's message. */
export function parsePatchOperations(input: string): { operations: PatchOperation[] } | { error: string } {
  try {
    return { operations: parsePatch(input).operations };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/** A path inside a patch: absolute as written, otherwise under the workspace. */
export function resolvePatchPath(raw: string, workspacePath: string | null | undefined): string {
  const trimmed = raw.trim();
  const expanded = !isLocalFilePath(trimmed) && workspacePath ? joinPath(workspacePath, trimmed) : trimmed;
  return normalizeLexicalPath(expanded);
}

type FileIo = Pick<ToolExecutionContext, 'files'>['files'];

async function fileExists(path: string, files: FileIo): Promise<boolean> {
  return files ? files.exists(path) : exists(path);
}

async function readText(path: string, files: FileIo): Promise<string> {
  return files ? files.readTextFile(path) : readTextFile(path);
}

async function writeText(path: string, text: string, files: FileIo): Promise<void> {
  await (files ? files.ensureParentDir(path) : ensureParentDir(path));
  await (files ? files.writeTextFile(path, text) : writeTextFile(path, text));
}

async function trash(path: string, files: FileIo): Promise<void> {
  if (files) {
    await files.prepareDelete(path);
    await files.moveToTrash(path);
    return;
  }
  await invoke('move_to_trash', { path });
}

/** A section applied in memory, waiting to be written. */
type PlannedWrite =
  | { kind: 'update'; path: string; before: string; after: string }
  | { kind: 'add'; path: string; after: string }
  | { kind: 'delete'; path: string; before: string | null }
  | { kind: 'move'; from: string; to: string; before: string; after: string };

/** The sections' paths the way the tool executes them, from the planner when it ran. */
function resolvedOperations(
  operations: PatchOperation[],
  planned: unknown,
  workspacePath: string | null | undefined,
): ResolvedPatchOperation[] {
  if (Array.isArray(planned) && planned.length === operations.length) {
    return planned.map((entry, index) => {
      const op = operations[index];
      const record = entry as Partial<ResolvedPatchOperation>;
      return {
        type: op.type,
        path: typeof record.path === 'string' ? record.path : resolvePatchPath(op.path, workspacePath),
        ...(op.type === 'update' && op.moveTo
          ? { moveTo: typeof record.moveTo === 'string' ? record.moveTo : resolvePatchPath(op.moveTo, workspacePath) }
          : {}),
      };
    });
  }
  return operations.map((op) => ({
    type: op.type,
    path: resolvePatchPath(op.path, workspacePath),
    ...(op.type === 'update' && op.moveTo ? { moveTo: resolvePatchPath(op.moveTo, workspacePath) } : {}),
  }));
}

function addedFileText(lines: string[]): string {
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
}

/** "+a −d" for a text comparison, or nothing when the texts are too large to compare. */
function countsOf(before: string, after: string): string {
  const diff = diffTexts(before, after);
  return diff ? format(getI18n().toolResult.patch.counts, { added: String(diff.added), deleted: String(diff.deleted) }) : '';
}

function describeWrite(write: PlannedWrite): string {
  const t = getI18n().toolResult.patch;
  switch (write.kind) {
    case 'update':
      return format(t.updatedLine, { path: write.path, counts: countsOf(write.before, write.after) });
    case 'add':
      return format(t.addedLine, { path: write.path, lines: String(write.after === '' ? 0 : write.after.split('\n').length - 1) });
    case 'delete':
      return format(t.deletedLine, { path: write.path });
    case 'move':
      return format(t.movedLine, { from: write.from, to: write.to, counts: countsOf(write.before, write.after) });
  }
}

const GENERIC_DESCRIPTION = `Apply a patch to one or more text files. The argument is one text block in this format:

*** Begin Patch
*** Update File: src/app.ts
@@ function greet(
 unchanged line (prefixed with one space)
-removed line
+added line
*** Add File: docs/new.md
+every line of the new file, each prefixed with +
*** Delete File: old/notes.txt
*** End Patch

Paths are absolute or relative to the workspace. A hunk is located by its unchanged context lines, so include about three of them before and after each change and keep them exact; the text after @@ may name a line that exists in the file (a function header, a heading) to pick the right place when the context alone repeats; put *** End of File after a hunk that sits at the end of the file. Rename a file with *** Move to: new/path on the line after its *** Update File: line. Every section is checked before anything is written: if one hunk does not match the file, nothing is changed and the error names the file.`;

const GPT_DESCRIPTION = `Use apply_patch for every file edit, in the patch format you know from Codex. Do not create or edit files with cat, echo, printf, shell redirection, or a Python script; formatting commands and bulk mechanical rewrites through a formatter are fine.

One argument, "input": the whole patch as text.

*** Begin Patch
*** Update File: src/app.ts
@@ function greet(
 context line, one leading space
-line to remove
+line to add
*** Add File: docs/new.md
+each line of the new file starts with +
*** Delete File: old/notes.txt
*** End Patch

Paths are relative to the workspace unless absolute. Give each hunk three lines of exact context before and after; use the text after @@ to name a unique line (a function header) when the context repeats; mark a hunk at the end of the file with *** End of File. Rename with *** Move to: new/path right after the *** Update File: line. The patch is applied as a whole: when any hunk does not match, no file is changed and the result names the file, so read it again and rebuild the hunk from its current contents.`;

export const applyPatchTool: ToolDefinition = {
  name: TOOL_NAMES.APPLY_PATCH,
  description: GENERIC_DESCRIPTION,
  descriptionByFamily: { gpt: GPT_DESCRIPTION },
  inputSchema: {
    type: 'object',
    properties: {
      input: { type: 'string', description: 'The full patch text, from "*** Begin Patch" to "*** End Patch".' },
    },
    required: ['input'],
  },
  execute: async (input, context) => {
    const t = getI18n().toolResult.patch;
    const text = typeof input.input === 'string' ? input.input : '';
    const parsed = parsePatchOperations(text);
    if ('error' in parsed) return format(t.errParse, { error: parsed.error });
    const operations = resolvedOperations(parsed.operations, input.operations, context?.workspacePath);
    const files = context?.files;

    // Every path a section writes or removes is locked for the whole call.
    const lockedPaths: string[] = [];
    for (const op of operations) {
      for (const path of [op.path, ...(op.moveTo ? [op.moveTo] : [])]) {
        const holder = acquireFileLock(path, context?.loopId);
        if (holder) {
          for (const locked of lockedPaths) releaseFileLock(locked);
          return format(getI18n().toolResult.file.errFileLocked, { path });
        }
        lockedPaths.push(path);
      }
    }

    try {
      // Phase 1: read and apply every section in memory.
      const writes: PlannedWrite[] = [];
      for (let index = 0; index < operations.length; index += 1) {
        const op = parsed.operations[index];
        const resolved = operations[index];
        if (op.type === 'add') {
          if (await fileExists(resolved.path, files)) return format(t.errAddExists, { path: resolved.path });
          writes.push({ kind: 'add', path: resolved.path, after: addedFileText(op.lines) });
          continue;
        }
        if (!(await fileExists(resolved.path, files))) return format(t.errFileNotFound, { path: resolved.path });
        if (op.type === 'delete') {
          const before = await readText(resolved.path, files);
          writes.push({ kind: 'delete', path: resolved.path, before });
          continue;
        }
        const before = await readText(resolved.path, files);
        let after: string;
        try {
          after = applyDiff(before, op.diff);
        } catch (err) {
          return format(t.errContext, { path: resolved.path, error: err instanceof Error ? err.message : String(err) });
        }
        if (resolved.moveTo && resolved.moveTo !== resolved.path) {
          if (await fileExists(resolved.moveTo, files)) return format(t.errAddExists, { path: resolved.moveTo });
          writes.push({ kind: 'move', from: resolved.path, to: resolved.moveTo, before, after });
        } else {
          writes.push({ kind: 'update', path: resolved.path, before, after });
        }
      }

      // Phase 2: write. Each file is captured for the turn's change record and
      // the version history first, as edit_file and delete_file do. What each
      // section leaves on disk is what this agent has now seen of that path
      // (fileReadRecords.ts).
      const snapshotOpts = { loopId: context?.loopId, conversationId: context?.conversationId, files };
      for (const write of writes) {
        switch (write.kind) {
          case 'update':
            await snapshotBeforeAiEdit(write.path, { ...snapshotOpts, knownContent: write.before });
            await writeText(write.path, write.after, files);
            await recordFileVersion(write.path, await writtenVersionOf(write.after), context);
            break;
          case 'add':
            await snapshotBeforeAiEdit(write.path, snapshotOpts);
            await writeText(write.path, write.after, files);
            await recordFileVersion(write.path, await writtenVersionOf(write.after), context);
            break;
          case 'delete':
            await captureTurnFileBefore(write.path, context?.loopId, files);
            await trash(write.path, files);
            await recordFileVersion(write.path, null, context);
            break;
          case 'move':
            await snapshotBeforeAiEdit(write.to, snapshotOpts);
            await writeText(write.to, write.after, files);
            await recordFileVersion(write.to, await writtenVersionOf(write.after), context);
            await captureTurnFileBefore(write.from, context?.loopId, files);
            await trash(write.from, files);
            await recordFileVersion(write.from, null, context);
            break;
        }
      }

      // The step shows one file's counts; a patch over several files is
      // reported by the turn's change record instead.
      if (writes.length === 1) {
        const write = writes[0];
        const fileChange = write.kind === 'update' ? computeFileChange({ path: write.path, before: write.before, after: write.after })
          : write.kind === 'add' ? computeFileChange({ path: write.path, before: null, after: write.after })
          : write.kind === 'delete' ? computeFileChange({ path: write.path, before: write.before, after: null })
          : null;
        if (fileChange) context?.reportMetadata?.({ fileChange });
      }

      if (context?.interactionMode === 'foreground') {
        for (const write of writes) {
          if (write.kind === 'delete') continue;
          void bindWorkspaceFromWrite(context.conversationId, write.kind === 'move' ? write.to : write.path, context.interactionMode);
        }
      }

      return `${t.applied}\n${writes.map(describeWrite).join('\n')}`;
    } catch (err) {
      const busy = lockedPaths.map((path) => fileBusyMessage(err, path)).find((message) => message !== null);
      return busy ?? format(t.errApply, { error: err instanceof Error ? err.message : String(err) });
    } finally {
      for (const path of lockedPaths) releaseFileLock(path);
    }
  },
  isConcurrencySafe: false,
};
