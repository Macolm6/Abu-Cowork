import { describe, expect, it } from 'vitest';
import { getHelpDocsUrl } from './helpDocs';

describe('getHelpDocsUrl', () => {
  it('opens the Chinese guide for the resolved Chinese locale', () => {
    expect(getHelpDocsUrl('zh-CN')).toBe(
      'https://abuwork.com/docs.zh-CN.html#user-guide',
    );
  });

  it('opens the English guide for the resolved English locale', () => {
    expect(getHelpDocsUrl('en-US')).toBe(
      'https://abuwork.com/docs.html#user-guide',
    );
  });
});
