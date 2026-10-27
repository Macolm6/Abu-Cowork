import { describe, it, expect } from 'vitest';
import { imageIdentities } from './toolResultContent';

describe('imageIdentities', () => {
  it('returns nothing for a text-only or missing result', () => {
    expect(imageIdentities(undefined)).toEqual([]);
    expect(imageIdentities([{ type: 'text', text: 'done' }])).toEqual([]);
  });

  it('gives one value per image, in order, from the image data', () => {
    expect(imageIdentities([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } },
      { type: 'text', text: 'between' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'BBB' } },
    ])).toEqual(['AAA', 'BBB']);
  });

  it('uses the snapshot path for an image that carries only an output reference', () => {
    expect(imageIdentities([
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: '' },
        outputRef: { relPath: 'images/shot-1.png' },
      },
    ])).toEqual(['ref:images/shot-1.png']);
  });

  it('throws for an image block with neither data nor an output reference', () => {
    expect(() => imageIdentities([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: '' } },
    ])).toThrow('neither data nor an output reference');
  });
});
