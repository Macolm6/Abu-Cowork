/**
 * Share Redactor — replaces credentials and personal filesystem paths in
 * strings before they leave the user's machine via an exported share bundle.
 *
 * Scope: credential-shaped tokens and home-directory absolute paths. Not a
 * general-purpose DLP — the goal is to stop obvious accidental leaks, not to
 * defend against motivated exfiltration (the user already controls the
 * bundle and could just copy-paste anything).
 *
 * Patterns are intentionally narrow: we prefer under-matching (false
 * negatives) to over-matching (false positives that corrupt the dialogue).
 */

export type RedactionKind =
  | 'anthropic-key'
  | 'openai-key'
  | 'google-api-key'
  | 'aws-access-key'
  | 'github-token'
  | 'slack-token'
  | 'jwt'
  | 'private-key-block'
  | 'bearer-header'
  | 'home-path-posix'
  | 'home-path-windows';

export interface RedactionSample {
  kind: RedactionKind;
  /** First 20 chars of the original match, for the preview dialog. */
  preview: string;
}

export interface RedactionResult {
  text: string;
  count: number;
  samples: RedactionSample[];
}

interface Rule {
  kind: RedactionKind;
  regex: RegExp;
  /** Replacement. May be a literal string or a function of the match. */
  replace: string | ((match: string, ...groups: string[]) => string);
  /**
   * True for rules that redact CREDENTIALS (as opposed to privacy scrubbing
   * like home paths). Colocated on the rule so a new vendor pattern can't be
   * added without deciding whether the memory-hygiene path gets it too.
   */
  credential: boolean;
  /**
   * Where the last possible match ends. The rule runs on the text before it
   * only, so a start with no end after it is never scanned to the end of the
   * text again and again.
   */
  searchEnd?: (text: string) => number;
}

const PRIVATE_KEY_END = /-----END (?:RSA |OPENSSH |EC |DSA |PGP |ENCRYPTED )?PRIVATE KEY-----/g;

function afterLastPrivateKeyEnd(text: string): number {
  let end = 0;
  PRIVATE_KEY_END.lastIndex = 0;
  // End lines may overlap (a header's closing dashes open the next one), so
  // the search moves on by one character, never past a whole match.
  for (let match = PRIVATE_KEY_END.exec(text); match; match = PRIVATE_KEY_END.exec(text)) {
    end = match.index + match[0].length;
    PRIVATE_KEY_END.lastIndex = match.index + 1;
  }
  return end;
}

// Anthropic key must come before the generic OpenAI rule so it wins.
// ⚠️ When adding/widening a credential rule, bump SWEEP_MARKER in
// core/memdir/secretSweep.ts so already-written memory files get re-swept.
const RULES: Rule[] = [
  {
    kind: 'anthropic-key',
    regex: /sk-ant-[A-Za-z0-9_-]{20,}/g,
    replace: '[REDACTED:anthropic-key]',
    credential: true,
  },
  {
    kind: 'openai-key',
    // Matches sk-... but excludes sk-ant- (handled above) via negative lookahead.
    regex: /sk-(?!ant-)[A-Za-z0-9_-]{20,}/g,
    replace: '[REDACTED:openai-key]',
    credential: true,
  },
  {
    kind: 'google-api-key',
    regex: /AIza[0-9A-Za-z_-]{35}/g,
    replace: '[REDACTED:google-api-key]',
    credential: true,
  },
  {
    kind: 'aws-access-key',
    regex: /AKIA[0-9A-Z]{16}/g,
    replace: '[REDACTED:aws-access-key]',
    credential: true,
  },
  {
    kind: 'github-token',
    regex: /gh[pousr]_[A-Za-z0-9_]{36,}/g,
    replace: '[REDACTED:github-token]',
    credential: true,
  },
  {
    kind: 'slack-token',
    regex: /xox[baprs]-[A-Za-z0-9-]{10,}/g,
    replace: '[REDACTED:slack-token]',
    credential: true,
  },
  {
    kind: 'jwt',
    // A token's first part runs to the end of its run of token characters, so
    // only the first "eyJ" of a run can start one. The match therefore starts
    // at the run's start and keeps the text before that "eyJ"; trying every
    // "eyJ" of a long run would rescan the run from each of them.
    regex: /(?<![A-Za-z0-9_-])((?:(?!eyJ)[A-Za-z0-9_-])*)eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
    replace: (_m, prefix: string) => `${prefix}[REDACTED:jwt]`,
    credential: true,
  },
  {
    kind: 'private-key-block',
    regex: /-----BEGIN (?:RSA |OPENSSH |EC |DSA |PGP |ENCRYPTED )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |OPENSSH |EC |DSA |PGP |ENCRYPTED )?PRIVATE KEY-----/g,
    replace: '[REDACTED:private-key-block]',
    credential: true,
    searchEnd: afterLastPrivateKeyEnd,
  },
  {
    kind: 'bearer-header',
    // "Authorization: Bearer <token>" — replace only the token portion.
    regex: /(Authorization:\s*Bearer\s+)([A-Za-z0-9._-]{16,})/gi,
    replace: (_m, prefix: string) => `${prefix}[REDACTED:bearer]`,
    credential: true,
  },
  {
    kind: 'home-path-posix',
    // /Users/<name>/ on macOS and /home/<name>/ on Linux.
    regex: /\/(?:Users|home)\/[A-Za-z0-9._-]+(?=\/)/g,
    replace: '~',
    credential: false,
  },
  {
    kind: 'home-path-windows',
    // C:\Users\<name>\ — keep the trailing slash so paths continue to parse.
    regex: /[A-Za-z]:\\Users\\[A-Za-z0-9._-]+(?=\\)/g,
    replace: '~',
    credential: false,
  },
];

const CREDENTIAL_RULES: readonly Rule[] = RULES.filter(r => r.credential);

/**
 * Redact only credential-shaped matches (vendor keys, tokens, JWTs, private
 * key blocks, bearer headers) — home paths and other privacy scrubbing are
 * left untouched, since consumers like memory hygiene legitimately reference
 * local files. Same result shape as redactText.
 */
export function redactCredentials(input: string): RedactionResult {
  return applyRules(input, CREDENTIAL_RULES);
}

/** Apply a rule subset to one string. Shared by redactText / redactCredentials. */
function applyRules(input: string, rules: readonly Rule[]): RedactionResult {
  if (!input) return { text: input, count: 0, samples: [] };

  let text = input;
  let count = 0;
  const samples: RedactionSample[] = [];

  for (const rule of rules) {
    const end = rule.searchEnd ? rule.searchEnd(text) : text.length;
    const head = text.slice(0, end);
    // Collect samples before replacing so we preserve the original form.
    const matches = head.match(rule.regex);
    if (matches && matches.length > 0) {
      count += matches.length;
      // Keep the first original match per rule for the preview.
      samples.push({
        kind: rule.kind,
        preview: matches[0].slice(0, 20),
      });
      text = (typeof rule.replace === 'string'
        ? head.replace(rule.regex, rule.replace)
        : head.replace(rule.regex, rule.replace)) + text.slice(end);
    }
  }

  return { text, count, samples };
}

/** Redact a single string. Safe on empty input. */
export function redactText(input: string): RedactionResult {
  return applyRules(input, RULES);
}

/**
 * A whole string that is one base64 data URL (`data:image/png;base64,...`).
 * Its payload is encoded bytes, which a rule could match by chance and
 * corrupt; text that only begins with `data:` is not one.
 */
const BASE64_DATA_URL = /^data:[\w.+-]+\/[\w.+-]+(?:;[\w.+-]+=[\w.+-]+)*;base64,[A-Za-z0-9+/=\s]*$/;

/**
 * Recursively redact every string inside a structured value, whatever its
 * length. Used for tool inputs / results whose shape we don't control. A
 * base64 data URL, and an object `keep` accepts, are returned as they are,
 * with nothing inside them redacted.
 */
export function redactDeep(
  value: unknown,
  keep?: (node: Record<string, unknown>) => boolean,
): { value: unknown; count: number; samples: RedactionSample[] } {
  let count = 0;
  const samples: RedactionSample[] = [];

  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      if (BASE64_DATA_URL.test(v)) return v;
      const r = redactText(v);
      count += r.count;
      samples.push(...r.samples);
      return r.text;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      if (keep?.(v as Record<string, unknown>)) return v;
      const out: Record<string, unknown> = {};
      for (const [k, vv] of Object.entries(v as Record<string, unknown>)) {
        out[k] = walk(vv);
      }
      return out;
    }
    return v;
  };

  return { value: walk(value), count, samples };
}
