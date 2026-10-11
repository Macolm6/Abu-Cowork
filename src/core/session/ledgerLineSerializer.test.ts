import { describe, expect, it } from 'vitest';
import type { Message } from '@/types';
import { serializeLedgerPut, stripForDisk } from './ledgerLineSerializer';

const options = { findToolResultImageSnapshot: () => null };

const message: Message = {
  id: 'assistant-1',
  role: 'assistant',
  content: '',
  timestamp: 1,
  toolCalls: [{
    id: 'call-edit',
    name: 'edit_file',
    input: { path: '/w/plan.md', old_content: 'a', new_content: 'b' },
    result: 'Successfully edited /w/plan.md: replaced 1 line(s) with 1 line(s)',
    fileChange: {
      path: '/w/plan.md',
      kind: 'modify',
      added: 1,
      deleted: 1,
      hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }],
    },
  }],
};

describe('ledger line serialization of a tool call file change', () => {
  it('keeps the file change in the disk projection', () => {
    const stripped = stripForDisk(message, 'conv-1', options);
    expect(stripped.toolCalls?.[0].fileChange).toEqual(message.toolCalls?.[0].fileChange);
  });

  it('writes the file change into the ledger line', () => {
    const line = JSON.parse(serializeLedgerPut('conv-1', message, undefined, options)) as Message;
    expect(line.toolCalls?.[0].fileChange).toEqual(message.toolCalls?.[0].fileChange);
  });
});
