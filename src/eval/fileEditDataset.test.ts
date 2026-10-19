/**
 * Shape and coverage checks for `datasets/file-edit.json` — the cases the
 * per-model file-edit eval runs. No model is called here.
 */
import { describe, expect, it } from 'vitest';
import dataset from './datasets/file-edit.json';
import type { FileEditCase, FileEditCategory } from './types';

const cases = dataset as FileEditCase[];

const CATEGORIES: FileEditCategory[] = [
  'single-replace',
  'multi-replace',
  'create',
  'delete-fragment',
  'special-chars',
  'multi-file',
  'read-then-edit',
];

function isRelativePath(p: string): boolean {
  return p.length > 0 && !p.startsWith('/') && !/^[A-Za-z]:/.test(p) && !p.split('/').includes('..');
}

describe('file-edit dataset', () => {
  it('holds about twenty cases with unique ids', () => {
    expect(cases.length).toBeGreaterThanOrEqual(20);
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
  });

  it('covers every category', () => {
    const seen = new Set(cases.map((c) => c.category));
    for (const category of CATEGORIES) expect(seen.has(category), `category ${category}`).toBe(true);
  });

  it.each(cases)('$id is well formed', (evalCase) => {
    expect(CATEGORIES).toContain(evalCase.category);
    expect(['easy', 'medium', 'hard']).toContain(evalCase.difficulty);
    expect(evalCase.id.startsWith(`${evalCase.category}-`)).toBe(true);
    // Instructions are written for Abu's users, in Chinese.
    expect(evalCase.instruction).toMatch(/[一-鿿]/);
    expect(Object.keys(evalCase.expected).length).toBeGreaterThan(0);
    for (const p of [...Object.keys(evalCase.files), ...Object.keys(evalCase.expected)]) {
      expect(isRelativePath(p), `path ${p}`).toBe(true);
    }
  });

  it.each(cases)('$id asks for a real change', (evalCase) => {
    for (const [path, expected] of Object.entries(evalCase.expected)) {
      expect(expected, `${path} must differ from its initial content`).not.toBe(evalCase.files[path]);
    }
  });

  it('create cases add files that did not exist', () => {
    for (const evalCase of cases.filter((c) => c.category === 'create')) {
      for (const path of Object.keys(evalCase.expected)) {
        expect(path in evalCase.files, `${evalCase.id}: ${path}`).toBe(false);
      }
    }
  });

  it('every other category edits files that already exist', () => {
    for (const evalCase of cases.filter((c) => c.category !== 'create' && c.category !== 'multi-file')) {
      for (const path of Object.keys(evalCase.expected)) {
        expect(path in evalCase.files, `${evalCase.id}: ${path}`).toBe(true);
      }
    }
  });

  it('multi-file cases touch at least two files', () => {
    for (const evalCase of cases.filter((c) => c.category === 'multi-file')) {
      expect(Object.keys(evalCase.expected).length, evalCase.id).toBeGreaterThanOrEqual(2);
    }
  });

  it('special-chars cases cover $, backslash, tab and Chinese text', () => {
    const contents = cases
      .filter((c) => c.category === 'special-chars')
      .flatMap((c) => [...Object.values(c.files), ...Object.values(c.expected)]);
    const joined = contents.join('\n');
    expect(joined).toContain('$');
    expect(joined).toContain('\\');
    expect(joined).toContain('\t');
    expect(joined).toMatch(/[一-鿿]/);
  });

  it('read-then-edit instructions do not spell out the new value for every case', () => {
    const derived = cases.filter((c) => c.category === 'read-then-edit');
    expect(derived.length).toBeGreaterThanOrEqual(2);
    // At least one case only makes sense after reading the file (e.g. "double it").
    expect(derived.some((c) => c.instruction.includes('两倍'))).toBe(true);
  });
});
