import { describe, expect, it } from 'vitest';
import { parseSkillFile, serializeSkillMd } from './loader';
import { localizedSkillDescription } from './displayDescription';

const filePath = '/home/u/.abu/skills/alert-sop/SKILL.md';
const skillFile = (frontmatter: string) => `---\nname: alert-sop\n${frontmatter}\n---\n\nDo the thing.\n`;

const withDisplay = skillFile([
  'description: 自动分析告警信息，按SOP排查问题并生成处理报告',
  'display-description:',
  '  zh-CN: 自动分析告警信息，按 SOP 排查问题并生成处理报告',
  '  en-US: Analyze an alert, investigate it by the SOP and write a handling report',
].join('\n'));

describe('display-description', () => {
  it('is parsed per locale and leaves description as the file gives it', () => {
    const skill = parseSkillFile(withDisplay, filePath)!;
    expect(skill.description).toBe('自动分析告警信息，按SOP排查问题并生成处理报告');
    expect(skill.displayDescription).toEqual({
      'zh-CN': '自动分析告警信息，按 SOP 排查问题并生成处理报告',
      'en-US': 'Analyze an alert, investigate it by the SOP and write a handling report',
    });
  });

  it('is shown in the interface language', () => {
    const skill = parseSkillFile(withDisplay, filePath)!;
    expect(localizedSkillDescription(skill, 'en-US')).toBe('Analyze an alert, investigate it by the SOP and write a handling report');
    expect(localizedSkillDescription(skill, 'zh-CN')).toBe('自动分析告警信息，按 SOP 排查问题并生成处理报告');
  });

  it('shows description for a skill without the field, and for a locale the field leaves out', () => {
    const plain = parseSkillFile(skillFile('description: Reads a PDF'), filePath)!;
    expect(plain.displayDescription).toBeUndefined();
    expect(localizedSkillDescription(plain, 'en-US')).toBe('Reads a PDF');
    expect(localizedSkillDescription(plain, 'zh-CN')).toBe('Reads a PDF');

    const chineseOnly = parseSkillFile(skillFile('description: Reads a PDF\ndisplay-description:\n  zh-CN: 读取 PDF'), filePath)!;
    expect(localizedSkillDescription(chineseOnly, 'zh-CN')).toBe('读取 PDF');
    expect(localizedSkillDescription(chineseOnly, 'en-US')).toBe('Reads a PDF');
  });

  it.each([
    ['a plain string', 'display-description: Reads a PDF'],
    ['a list', 'display-description:\n  - Reads a PDF'],
    ['a number', 'display-description: 42'],
    ['an unknown locale only', 'display-description:\n  fr-FR: Lit un PDF'],
    ['blank text', 'display-description:\n  en-US: "  "'],
    ['text that is no string', 'display-description:\n  en-US: 42'],
  ])('ignores %s and shows description', (_label, field) => {
    const skill = parseSkillFile(skillFile(`description: Reads a PDF\n${field}`), filePath)!;
    expect(skill.displayDescription).toBeUndefined();
    expect(skill.description).toBe('Reads a PDF');
    expect(localizedSkillDescription(skill, 'en-US')).toBe('Reads a PDF');
  });

  it('keeps the locales it knows when the field also carries one it does not', () => {
    const skill = parseSkillFile(skillFile('description: Reads a PDF\ndisplay-description:\n  en-US: Read PDF files\n  fr-FR: Lit un PDF'), filePath)!;
    expect(skill.displayDescription).toEqual({ 'en-US': 'Read PDF files' });
  });

  it('survives a save: serializing a parsed skill writes the field back', () => {
    const skill = parseSkillFile(withDisplay, filePath)!;
    const again = parseSkillFile(serializeSkillMd(skill, skill.content), filePath)!;
    expect(again.description).toBe(skill.description);
    expect(again.displayDescription).toEqual(skill.displayDescription);
    expect(serializeSkillMd({ name: 'x', description: 'Reads a PDF' }, 'body')).not.toContain('display-description');
  });
});
