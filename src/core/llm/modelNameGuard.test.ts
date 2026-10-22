/**
 * Guards the one-place rule for model names: `model-data/families.ts` (and the
 * build-time classifier beside it) is where an id is inspected. Every other file
 * of the LLM layer reads the model profile instead, so a new provider quirk
 * lands in the profile tables and never as a fresh `if (/deepseek/.test(id))`.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const LLM_DIR = join(__dirname);

/** Family or vendor names a regex literal must not carry outside model-data/. */
const FAMILY_WORDS = /\/[^/\n]*(claude|gpt-|deepseek|kimi|moonshot|qwen|glm|gemini|minimax|mistral|llama)[^/\n]*\/[gimsuy]*/;

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name === 'model-data' || name === 'generated' || name === '__contractFixtures__' || name === 'imageGen') continue;
      sourceFiles(path, out);
      continue;
    }
    if (!name.endsWith('.ts') || name.endsWith('.test.ts') || name.endsWith('.d.ts')) continue;
    out.push(path);
  }
  return out;
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

describe('model names are read in model-data/families.ts only', () => {
  it('no regex literal in src/core/llm names a model family', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(LLM_DIR)) {
      const lines = stripComments(readFileSync(file, 'utf8')).split('\n');
      lines.forEach((line, i) => {
        if (FAMILY_WORDS.test(line)) offenders.push(`${file.slice(LLM_DIR.length + 1)}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
