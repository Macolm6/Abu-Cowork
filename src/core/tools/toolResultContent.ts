import type { ToolResultContent } from '@/types';

/** Image payload of a tool result's first renderable image block. */
export interface ToolResultImage {
  mediaType: string;
  base64?: string;
  outputRef?: {
    relPath: string;
    basename?: string;
    sizeBytes?: number;
  };
}

/**
 * One value per image block of a tool result: the base64 data, or the
 * snapshot path for a block that carries only an output reference.
 * The semantic loop guard hashes these values along with the result text.
 */
export function imageIdentities(resultContent: ToolResultContent[] | undefined): string[] {
  if (!resultContent) return [];
  return resultContent.flatMap((block) => {
    if (block.type !== 'image') return [];
    if (block.source?.data) return [block.source.data];
    if (block.outputRef?.relPath) return [`ref:${block.outputRef.relPath}`];
    throw new Error('Tool result image block has neither data nor an output reference');
  });
}

/**
 * The first renderable image block in a tool result, or `undefined`.
 *
 * Single source of truth for "pull the image out of a tool result". Four
 * hand-copied variants of this scan had already drifted apart — only one of
 * them guarded against an empty `source.data`, so the others could hand a
 * renderer `data:image/png;base64,` and paint a broken image. It matters most
 * that the LIVE path (`eventRouter` building the image DetailBlock) and the
 * REPLAY path (`backfillDetailBlockImages` restoring one from a snapshot) agree
 * exactly: if they disagree, an image renders during execution and vanishes —
 * or appears broken — the moment the execution is evicted.
 *
 * Callers that need EVERY image block (e.g. the chat gallery in
 * `ToolCallsGroup`) intentionally do not use this — they have different
 * semantics, not a duplicated one.
 */
export function firstImageContent(
  resultContent: ToolResultContent[] | undefined,
): ToolResultImage | undefined {
  if (!resultContent) return undefined;
  for (const block of resultContent) {
    if (block.type !== 'image') continue;
    if (!block.source?.data && !block.outputRef?.relPath) continue;
    return {
      mediaType: block.source.media_type,
      ...(block.source.data ? { base64: block.source.data } : {}),
      ...(block.outputRef ? { outputRef: { ...block.outputRef } } : {}),
    };
  }
  return undefined;
}
