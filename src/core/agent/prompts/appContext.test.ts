import { describe, expect, it } from 'vitest';
import { APP_PROMPT_APPEND_MAX_CHARS, buildAppContextSection } from './appContext';
import type { ConversationAppBinding } from '@/types/app';

const binding: ConversationAppBinding = {
  version: 1, appId: 'shop@market', pluginKey: 'shop@market', pluginVersion: '1.0.0', appName: '店铺运营', modeId: 'sourcing',
};

describe('buildAppContextSection', () => {
  it('names the app and, when the package gives instructions, wraps them in a delimiter', () => {
    const bare = buildAppContextSection(binding);
    expect(bare).toContain('## App Context');
    expect(bare).toContain('inside the app "店铺运营"');
    expect(bare).not.toContain('<app-instructions>');

    const withText = buildAppContextSection({ ...binding, promptAppend: 'Focus on margins.' });
    expect(withText).toContain('<app-instructions>\nFocus on margins.\n</app-instructions>');
  });

  it('names an app whose name is given per locale by one fixed text: zh-CN, else en-US', () => {
    const both = buildAppContextSection({ ...binding, appName: { 'zh-CN': '店铺运营', 'en-US': 'Shop Operations' } });
    expect(both).toContain('inside the app "店铺运营"');
    expect(both).not.toContain('Shop Operations');
    expect(both).toBe(buildAppContextSection(binding));

    const englishOnly = buildAppContextSection({ ...binding, appName: { 'en-US': 'Shop Operations' } });
    expect(englishOnly).toContain('inside the app "Shop Operations"');
  });

  it('caps the package instructions', () => {
    const long = 'x'.repeat(APP_PROMPT_APPEND_MAX_CHARS + 10);
    const text = buildAppContextSection({ ...binding, promptAppend: long });
    expect(text).toContain(`[app instructions truncated at ${APP_PROMPT_APPEND_MAX_CHARS} characters]`);
    expect(text.length).toBeLessThan(long.length + 400);
  });
});
