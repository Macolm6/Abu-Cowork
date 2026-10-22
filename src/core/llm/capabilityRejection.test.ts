import { describe, it, expect } from 'vitest';
import {
  CAPABILITY_REJECTION_CLASSES,
  CAPABILITY_REJECTION_PATTERNS,
  classifyCapabilityRejection,
  isCapabilityRejectionClass,
} from './capabilityRejection';

describe('classifyCapabilityRejection', () => {
  describe('one verbatim provider text per class', () => {
    it.each([
      ['thinking', '"thinking.type.enabled" is not supported for this model. Use "thinking.type.adaptive" and "output_config.effort" to control thinking behavior.'],
      ['thinking', 'thinking: Extra inputs are not permitted'],
      ['thinking', 'Unrecognized request argument supplied: enable_thinking'],
      ['thinking', "Unsupported parameter: 'thinking_budget' is not supported with this model."],
      ['reasoning_effort', "Unsupported parameter: 'reasoning_effort' is not supported with this model."],
      ['reasoning_effort', 'Unrecognized request argument supplied: reasoning_effort'],
      ['max_tokens_field', "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead."],
      ['max_tokens_field', 'Unrecognized request argument supplied: max_completion_tokens'],
      ['parallel_tool_calls', "Unsupported parameter: 'parallel_tool_calls' is not supported with this model."],
      ['parallel_tool_calls', 'Unrecognized request argument supplied: parallel_tool_calls'],
      ['image_block', 'Invalid content type. image_url is only supported by certain models.'],
      ['tool_schema_keyword', 'Invalid JSON payload received. Unknown name "exclusiveMinimum" at \'tools[0].function_declarations[0].parameters.properties[0].value\': Cannot find field.'],
    ] as const)('%s ← %s', (expected, message) => {
      expect(classifyCapabilityRejection(400, message)).toBe(expected);
    });
  });

  describe('texts that are no capability rejection', () => {
    it.each([
      // the existing max_tokens limit retry owns this one
      'max_tokens too large: 32768. This model supports at most 4096 completion tokens',
      // a user quoting the field names inside their message
      'Your message mentions "thinking" and image_url but the request is invalid for another reason',
      // another unknown field
      'Unrecognized request argument supplied: foo_bar',
      // another unsupported parameter
      "Unsupported parameter: 'temperature' is not supported with this model.",
      // a schema keyword error on a different path
      'Invalid JSON payload received. Unknown name "foo" at \'generation_config\': Cannot find field.',
      // context overflow
      "This model's maximum context length is 128000 tokens.",
      // Anthropic's other validation messages
      'messages.1.content.0.type: Expected thinking or redacted_thinking, but found text.',
      'context_management: Extra inputs are not permitted',
      '',
    ])('%s', (message) => {
      expect(classifyCapabilityRejection(400, message)).toBeUndefined();
    });

    it('only a 400 counts', () => {
      const text = "Unsupported parameter: 'reasoning_effort' is not supported with this model.";
      expect(classifyCapabilityRejection(422, text)).toBeUndefined();
      expect(classifyCapabilityRejection(500, text)).toBeUndefined();
      expect(classifyCapabilityRejection(undefined, text)).toBeUndefined();
    });
  });

  it('every class has at least one pattern and every pattern names its source', () => {
    for (const cls of CAPABILITY_REJECTION_CLASSES) {
      expect(CAPABILITY_REJECTION_PATTERNS.some((p) => p.class === cls)).toBe(true);
    }
    for (const pattern of CAPABILITY_REJECTION_PATTERNS) {
      expect(pattern.source.length).toBeGreaterThan(10);
      expect(isCapabilityRejectionClass(pattern.class)).toBe(true);
    }
  });

  it('isCapabilityRejectionClass rejects other strings and non-strings', () => {
    expect(isCapabilityRejectionClass('thinking')).toBe(true);
    expect(isCapabilityRejectionClass('cache_control_field')).toBe(false);
    expect(isCapabilityRejectionClass(42)).toBe(false);
    expect(isCapabilityRejectionClass(undefined)).toBe(false);
  });
});
