import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Skill } from '../../types';

const getSkillMock = vi.fn();
const listSupportingFilesMock = vi.fn();

vi.mock('./loader', () => ({
  skillLoader: {
    getSkill: (...args: unknown[]) => getSkillMock(...args),
    listSupportingFiles: (...args: unknown[]) => listSupportingFilesMock(...args),
  },
}));

import {
  buildActiveSkillsSection,
  renderSkillInstructions,
  resolveActiveSkillInfo,
} from './activeSkillInstructions';

function skill(overrides: Partial<Skill> & { name: string }): Skill {
  return {
    description: `${overrides.name} description`,
    content: `Body of ${overrides.name}.`,
    filePath: `/skills/${overrides.name}/SKILL.md`,
    skillDir: `/skills/${overrides.name}`,
    ...overrides,
  } as Skill;
}

describe('activeSkillInstructions', () => {
  beforeEach(() => {
    getSkillMock.mockReset();
    listSupportingFilesMock.mockReset();
    listSupportingFilesMock.mockResolvedValue([]);
  });

  describe('resolveActiveSkillInfo', () => {
    it('returns name and blocked tools for each skill the index resolves', () => {
      getSkillMock.mockImplementation((name: string) => {
        if (name === 'docx') return skill({ name: 'docx', blockedTools: ['computer'] });
        if (name === 'plain') return skill({ name: 'plain' });
        return undefined;
      });

      expect(resolveActiveSkillInfo(['docx', 'plain'])).toEqual([
        { name: 'docx', blockedTools: ['computer'] },
        { name: 'plain' },
      ]);
    });

    it('drops a name the index refuses, such as a skill blocked by the organization', () => {
      getSkillMock.mockImplementation((name: string) => (name === 'kept' ? skill({ name: 'kept' }) : undefined));

      expect(resolveActiveSkillInfo(['blocked-by-policy', 'kept'])).toEqual([{ name: 'kept' }]);
    });

    it('returns an empty list when no skill is active', () => {
      expect(resolveActiveSkillInfo(undefined)).toEqual([]);
      expect(resolveActiveSkillInfo([])).toEqual([]);
    });
  });

  describe('renderSkillInstructions', () => {
    it('appends the arguments line when the body has no $ARGUMENTS placeholder', async () => {
      const text = await renderSkillInstructions(skill({ name: 'mermaid' }), 'draw a login flow', 'conv-1');

      expect(text).toBe('### mermaid\nBody of mermaid.\nARGUMENTS: draw a login flow');
    });

    it('substitutes the arguments into the body placeholder', async () => {
      const text = await renderSkillInstructions(
        skill({ name: 'echo', content: 'Say: $ARGUMENTS' }),
        'hello',
        'conv-1',
      );

      expect(text).toBe('### echo\nSay: hello');
    });

    it('lists reference files, with the absolute path for scripts', async () => {
      listSupportingFilesMock.mockResolvedValue(['reference.md', 'scripts/run.py']);

      const text = await renderSkillInstructions(skill({ name: 'pdf' }), '', 'conv-1');

      expect(listSupportingFilesMock).toHaveBeenCalledWith('pdf');
      expect(text).toContain('**Available reference files** (use `read_skill_file` tool to load when needed):');
      expect(text).toContain('- reference.md');
      expect(text).toContain('- scripts/run.py (path: /skills/pdf/scripts/run.py)');
    });
  });

  describe('buildActiveSkillsSection', () => {
    it('renders every resolvable skill with its own arguments into one cacheable section', async () => {
      getSkillMock.mockImplementation((name: string) => (name === 'gone' ? undefined : skill({ name })));

      const section = await buildActiveSkillsSection(['a', 'gone', 'b'], { b: 'for b' }, 'conv-1');

      expect(section).toEqual({
        name: 'active-skills',
        cacheable: true,
        text: '## Active Skill Instructions\n### a\nBody of a.\n\n### b\nBody of b.\nARGUMENTS: for b',
      });
    });

    it('returns nothing when no active skill resolves', async () => {
      getSkillMock.mockReturnValue(undefined);

      expect(await buildActiveSkillsSection(['gone'], undefined, 'conv-1')).toBeUndefined();
      expect(await buildActiveSkillsSection(undefined, undefined, 'conv-1')).toBeUndefined();
    });
  });
});
