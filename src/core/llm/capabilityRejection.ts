/**
 * Capability rejections — a 400 whose text says the endpoint does not take one
 * request feature Abu sent.
 *
 * `classifyCapabilityRejection` maps the provider's error text to one of a
 * fixed set of classes. Every pattern below is a verbatim provider message (the
 * source is named next to it); a text that matches none is not a capability
 * rejection and the error is reported unchanged. The agent loop records the
 * class in the session's rejection memory, re-resolves the model profile with
 * that class switched off (`resolveModelProfile` `overrides`) and re-sends the
 * same request once.
 */

export type CapabilityRejectionClass =
  | 'thinking'             // the thinking / reasoning parameters
  | 'reasoning_effort'     // the `reasoning_effort` field alone
  | 'max_tokens_field'     // `max_tokens` vs `max_completion_tokens`
  | 'parallel_tool_calls'  // the `parallel_tool_calls` field
  | 'image_block'          // image content parts
  | 'tool_schema_keyword'; // a JSON Schema keyword in a tool's parameters

export const CAPABILITY_REJECTION_CLASSES: readonly CapabilityRejectionClass[] = [
  'thinking',
  'reasoning_effort',
  'max_tokens_field',
  'parallel_tool_calls',
  'image_block',
  'tool_schema_keyword',
];

const CLASS_SET: ReadonlySet<string> = new Set(CAPABILITY_REJECTION_CLASSES);

export function isCapabilityRejectionClass(value: unknown): value is CapabilityRejectionClass {
  return typeof value === 'string' && CLASS_SET.has(value);
}

export interface CapabilityRejectionPattern {
  class: CapabilityRejectionClass;
  /** Which endpoint produces this text, and where the sample comes from. */
  source: string;
  test: RegExp;
}

/**
 * The fixed pattern table. Each regex is anchored on the field name the
 * provider names, so quoted user text that happens to mention "thinking" or
 * "image" cannot match.
 */
export const CAPABILITY_REJECTION_PATTERNS: readonly CapabilityRejectionPattern[] = [
  // ── thinking ──────────────────────────────────────────────────────────────
  {
    class: 'thinking',
    source: 'Anthropic Messages API, platform.claude.com/docs/en/api/errors ("Extended thinking not supported")',
    test: /"thinking\.type\.enabled" is not supported for this model/i,
  },
  {
    class: 'thinking',
    source: 'Anthropic Messages API field validation ("<field>: Extra inputs are not permitted", documented for block_binding / context_management), here on the thinking field',
    test: /(?:^|[\s:,."'])thinking: Extra inputs are not permitted/i,
  },
  {
    class: 'thinking',
    source: 'OpenAI chat completions and compatible gateways, "Unrecognized request argument supplied: <field>" (community.openai.com/t/1265200 for enable_thinking)',
    test: /Unrecognized request argument supplied: (?:thinking|thinking_budget|enable_thinking)\b/i,
  },
  {
    class: 'thinking',
    source: 'OpenAI chat completions, unsupported_parameter form ("Unsupported parameter: \'<field>\' is not supported with this model.")',
    test: /Unsupported parameter: '(?:thinking|thinking_budget|enable_thinking)'/i,
  },
  // ── reasoning_effort ──────────────────────────────────────────────────────
  {
    class: 'reasoning_effort',
    source: 'OpenAI chat completions, unsupported_parameter form (meta.discourse.org/t/259214/227; github.com/scaleapi/vero/pull/54 for reasoning.effort)',
    test: /Unsupported parameter: 'reasoning_effort'/i,
  },
  {
    class: 'reasoning_effort',
    source: 'OpenAI chat completions and compatible gateways, "Unrecognized request argument supplied: <field>"',
    test: /Unrecognized request argument supplied: reasoning_effort\b/i,
  },
  // ── max_tokens_field ──────────────────────────────────────────────────────
  {
    class: 'max_tokens_field',
    source: 'OpenAI chat completions, reasoning models (community.n8n.io/t/84178; community.make.com/t/56099)',
    test: /Unsupported parameter: 'max_tokens' is not supported with this model\. Use 'max_completion_tokens' instead/i,
  },
  {
    class: 'max_tokens_field',
    source: 'OpenAI-compatible gateways that predate the renamed field, "Unrecognized request argument supplied: <field>"',
    test: /Unrecognized request argument supplied: max_completion_tokens\b/i,
  },
  // ── parallel_tool_calls ───────────────────────────────────────────────────
  {
    class: 'parallel_tool_calls',
    source: 'OpenAI chat completions, o4-mini (community.openai.com/t/1310788)',
    test: /Unsupported parameter: 'parallel_tool_calls'/i,
  },
  {
    class: 'parallel_tool_calls',
    source: 'OpenAI-compatible gateways, "Unrecognized request argument supplied: <field>"',
    test: /Unrecognized request argument supplied: parallel_tool_calls\b/i,
  },
  // ── image_block ───────────────────────────────────────────────────────────
  {
    class: 'image_block',
    source: 'OpenAI chat completions, text-only models (community.openai.com/t/1110985, o1-mini with a base64 image)',
    test: /Invalid content type\. image_url is only supported by certain models/i,
  },
  // ── tool_schema_keyword ───────────────────────────────────────────────────
  {
    class: 'tool_schema_keyword',
    source: 'Gemini OpenAI-compatible endpoint, draft-7 keywords in function parameters (levelup.gitconnected.com, "Fix Gemini MCP Tool Schema Errors")',
    test: /Invalid JSON payload received\. Unknown name "[^"]+" at 'tools\[\d+\]\.function_declarations\[\d+\]\.parameters/i,
  },
];

/**
 * Classify a provider's 400 error text. Returns the class of the first
 * pattern that matches, `undefined` for any other text and for any other
 * status code.
 */
export function classifyCapabilityRejection(
  statusCode: number | undefined,
  message: string,
): CapabilityRejectionClass | undefined {
  if (statusCode !== 400 || !message) return undefined;
  for (const pattern of CAPABILITY_REJECTION_PATTERNS) {
    if (pattern.test.test(message)) return pattern.class;
  }
  return undefined;
}
