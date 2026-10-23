/**
 * L1 — Prompt section snapshot tests
 *
 * Ensures the system prompt structure doesn't change accidentally.
 * Uses snapshot testing for section names + content existence checks for key instructions.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks (same as orchestrator.test.ts) ──
vi.mock('@/core/agent/registry', () => ({
  agentRegistry: {
    getAgent: vi.fn().mockReturnValue({ name: 'abu', systemPrompt: '你是阿布', description: '桌面助手' }),
    getAvailableAgents: vi.fn().mockReturnValue([]),
  },
}));

vi.mock('@/core/skill/loader', () => ({
  skillLoader: {
    getSkill: vi.fn(),
    getAvailableSkills: vi.fn().mockReturnValue([]),
    findMatchingSkills: vi.fn().mockReturnValue([]),
  },
}));

vi.mock('@/core/memdir/scan', () => ({
  loadMemoryIndex: vi.fn().mockResolvedValue(''),
  scanMemoryFiles: vi.fn().mockResolvedValue([]),
  readMemoryFile: vi.fn().mockResolvedValue(null),
}));

vi.mock('@/core/memdir/write', () => ({
  touchMemory: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/core/agent/projectRules', () => ({
  loadAllRules: vi.fn().mockResolvedValue(''),
}));

vi.mock('@/stores/workspaceStore', () => ({
  useWorkspaceStore: {
    getState: vi.fn().mockReturnValue({ currentPath: '/test/workspace' }),
    subscribe: vi.fn(),
  },
}));

vi.mock('@/stores/settingsStore', () => ({
  readConfirmedBrowserPermissionConfig: vi.fn(() => null),
  useSettingsStore: {
    getState: vi.fn().mockReturnValue({
      computerUseEnabled: false,
      disabledSkills: [],
      disabledAgents: [],
      contextWindowSize: 200000,
      allowSkillCommands: false,
    }),
  },
}));

vi.mock('@/core/session/sessionDir', () => ({
  getSessionOutputDir: vi.fn().mockResolvedValue('/tmp/session-output'),
}));

vi.mock('@/utils/platform', () => ({
  isWindows: vi.fn().mockReturnValue(false),
}));

vi.mock('@/core/mcp/client', () => ({
  mcpManager: {
    isConnected: vi.fn().mockReturnValue(false),
  },
}));

vi.mock('@/core/skill/preprocessor', () => ({
  substituteVariables: vi.fn((content: string) => content),
  executeInlineCommands: vi.fn((content: string) => content),
}));

vi.mock('@/utils/pythonRuntime', () => ({
  hasEmbeddedPython: vi.fn().mockResolvedValue(false),
}));

import { buildSystemPromptSections, buildSystemPrompt, routeInput } from '@/core/agent/orchestrator';
import { resolveModelProfile } from '@/core/llm/modelProfile';
import { MODEL_FAMILIES, type ModelFamily } from '@/core/llm/model-data/families';
import { PROMPT_VARIANTS } from '@/core/agent/prompts/variants';

beforeEach(() => {
  vi.clearAllMocks();
});

/** One representative model id per family, for the per-family snapshots. */
const FAMILY_MODEL_IDS: Record<ModelFamily, string> = {
  claude: 'claude-opus-5-5',
  gpt: 'gpt-5.6-sol',
  deepseek: 'deepseek-v4-pro',
  kimi: 'moonshotai/kimi-k2.6',
  qwen: 'qwen3-max',
  glm: 'glm-5',
  gemini: 'google/gemini-3-pro',
  other: 'llama3.3:70b',
};

describe('System prompt sections per model family', () => {
  it.each(MODEL_FAMILIES)('%s: general mode section names match snapshot', async (family) => {
    const route = routeInput('你好');
    const profile = resolveModelProfile({ modelId: FAMILY_MODEL_IDS[family] });
    const sections = await buildSystemPromptSections(route, '你是阿布', 'eval-conv-001', undefined, 0, undefined, profile);
    expect(sections.map(s => s.name)).toMatchSnapshot();
  });

  it.each(MODEL_FAMILIES)('%s: persona is the caller\'s capability prompt and the planning text is the family\'s', async (family) => {
    const route = routeInput('你好');
    const profile = resolveModelProfile({ modelId: FAMILY_MODEL_IDS[family] });
    const sections = await buildSystemPromptSections(route, '你是阿布', 'eval-conv-001', undefined, 0, undefined, profile);
    const variant = PROMPT_VARIANTS[profile.harness.promptVariant];

    expect(sections.find(s => s.name === 'persona')?.text).toBe('你是阿布');
    const planning = sections.find(s => s.name === 'planning');
    expect(planning?.cacheable).toBe(true);
    expect(planning?.text).toContain('Situation A');
    expect(planning?.text).toContain('Execution Examples');
    if (variant?.planning) expect(planning?.text).toContain(variant.planning.trim().slice(0, 200));

    const notes = sections.find(s => s.name === 'family-notes');
    if (variant?.familyNotes) {
      expect(notes?.cacheable).toBe(true);
      expect(notes?.text).toContain(variant.familyNotes.trim());
      // Right after the planning block, inside the cacheable prefix.
      const names = sections.map(s => s.name);
      expect(names.indexOf('family-notes')).toBe(names.indexOf('planning') + 1);
    } else {
      expect(notes).toBeUndefined();
    }
  });

  it('gpt: the planning text and notes carry the family rules', async () => {
    const route = routeInput('你好');
    const profile = resolveModelProfile({ modelId: FAMILY_MODEL_IDS.gpt });
    const prompt = await buildSystemPrompt(route, '你是阿布', 'eval-conv-001', undefined, 0, undefined, profile);
    expect(prompt).toContain('report_plan is the plan');
    expect(prompt).toContain('apply_patch');
    expect(prompt).toContain('/test/workspace');
  });

  it('a family with notes keeps them in skill mode and in fork mode', async () => {
    const profile = resolveModelProfile({ modelId: FAMILY_MODEL_IDS.deepseek });
    const skill = {
      name: 'test-skill',
      description: 'test',
      content: 'skill content',
      filePath: '/test',
      skillDir: '/test',
    };
    const inline = await buildSystemPromptSections(
      { type: 'skill', name: 'test-skill', skill, skillContent: 'skill content', cleanInput: 'x' },
      '你是阿布', 'eval-conv-001', undefined, 0, undefined, profile,
    );
    const inlineNames = inline.map(s => s.name);
    expect(inlineNames).not.toContain('planning');
    expect(inlineNames.indexOf('family-notes')).toBe(inlineNames.indexOf('skill-content') + 1);

    const fork = await buildSystemPromptSections(
      { type: 'skill', name: 'test-skill', skill: { ...skill, context: 'fork' as const }, skillContent: 'skill content', cleanInput: 'x' },
      '你是阿布', 'eval-conv-001', undefined, 0, undefined, profile,
    );
    const forkNames = fork.map(s => s.name);
    expect(forkNames.indexOf('family-notes')).toBe(forkNames.indexOf('identity') + 1);
    expect(fork.find(s => s.name === 'identity')?.text).toContain('You are Abu');
  });
});

describe('System prompt section structure', () => {
  it('general mode section names match snapshot', async () => {
    const route = routeInput('你好');
    const sections = await buildSystemPromptSections(route, '你是阿布', 'eval-conv-001');

    const names = sections.map(s => s.name);
    expect(names).toMatchSnapshot();
  });

  it('general mode has persona and planning sections', async () => {
    const route = routeInput('你好');
    const sections = await buildSystemPromptSections(route, '你是阿布', 'eval-conv-001');

    const names = sections.map(s => s.name);
    expect(names).toContain('persona');
    expect(names).toContain('planning');
  });

  it('includes current-time as a CACHEABLE day-granularity date section', async () => {
    const route = routeInput('你好');
    const sections = await buildSystemPromptSections(route, '你是阿布', 'eval-conv-001');

    const timeSection = sections.find(s => s.name === 'current-time');
    expect(timeSection).toBeDefined();
    // Day granularity flips the prompt bytes once per day, so the section is
    // deliberately cacheable — a minute-level timestamp here would invalidate
    // the cached prompt prefix on every turn (see orchestrator.ts).
    expect(timeSection!.cacheable).toBe(true);
    expect(timeSection!.text).not.toMatch(/\d{1,2}:\d{2}/); // no clock time
  });

  it('persona and planning are cacheable', async () => {
    const route = routeInput('你好');
    const sections = await buildSystemPromptSections(route, '你是阿布', 'eval-conv-001');

    const persona = sections.find(s => s.name === 'persona');
    const planning = sections.find(s => s.name === 'planning');
    expect(persona?.cacheable).toBe(true);
    expect(planning?.cacheable).toBe(true);
  });
});

describe('System prompt key content', () => {
  const basePrompt = '你是阿布，专业桌面助手。';

  it('contains tool selection principles', async () => {
    const route = routeInput('你好');
    const prompt = await buildSystemPrompt(route, basePrompt, 'test-conv');

    expect(prompt).toContain('read_file');
    expect(prompt).toContain('run_command');
    expect(prompt).toContain('report_plan');
  });

  it('contains planning instruction', async () => {
    const route = routeInput('你好');
    const prompt = await buildSystemPrompt(route, basePrompt, 'test-conv');

    expect(prompt).toContain('Execution Rules');
    expect(prompt).toContain('Situation A');
    expect(prompt).toContain('use_skill');
  });

  it('contains safety anchor', async () => {
    const route = routeInput('你好');
    const prompt = await buildSystemPrompt(route, basePrompt, 'test-conv');

    expect(prompt).toContain('Safety Reminders');
  });

  it('contains workspace path', async () => {
    const route = routeInput('你好');
    const prompt = await buildSystemPrompt(route, basePrompt, 'test-conv');

    expect(prompt).toContain('/test/workspace');
  });
});

describe('Skill mode prompt structure', () => {
  it('skill mode injects skill content', async () => {
    const route = {
      type: 'skill' as const,
      name: 'test-skill',
      skill: {
        name: 'test-skill',
        description: 'test',
        content: '这是技能指令内容',
        filePath: '/test',
        skillDir: '/test',
      },
      skillContent: '这是技能指令内容',
      cleanInput: 'test input',
    };

    const sections = await buildSystemPromptSections(route, '你是阿布', 'test-conv');
    const fullText = sections.map(s => s.text).join('\n');
    expect(fullText).toContain('技能指令内容');
  });

  it('skill mode does not include planning instruction', async () => {
    const route = {
      type: 'skill' as const,
      name: 'test-skill',
      skill: {
        name: 'test-skill',
        description: 'test',
        content: 'skill content',
        filePath: '/test',
        skillDir: '/test',
      },
      skillContent: 'skill content',
      cleanInput: 'test input',
    };

    const sections = await buildSystemPromptSections(route, '你是阿布', 'test-conv');
    const names = sections.map(s => s.name);
    expect(names).not.toContain('planning');
  });
});
