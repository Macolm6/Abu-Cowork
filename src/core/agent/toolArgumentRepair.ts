/**
 * Tool argument repair — the `harness.guards.toolArgumentRepair` guard.
 *
 * Some models write a tool call's arguments in the wrong JSON shape: an object
 * or array as a JSON string, a number as a numeric literal in quotes, a boolean
 * as `"true"` / `"false"`, or `null` for an optional field they meant to leave
 * out. The tool's `inputSchema` says which shape each field has, so these four
 * cases can be repaired deterministically before dispatch:
 *
 *   - `type: object` / `type: array` and the value is a string that parses as
 *     JSON of that shape → the parsed value (then repaired recursively);
 *   - `type: number` / `type: integer` and the value is a numeric literal in a
 *     string → the number (an integer field only takes an integer literal);
 *   - `type: boolean` and the value is `"true"` / `"false"` → the boolean;
 *   - a field that is not `required` and holds `null` → removed.
 *
 * Anything else is left exactly as the model wrote it: a value that does not
 * repair goes to the tool unchanged and the tool's own validation reports it.
 * A call whose arguments did not parse at all (`_parse_error`) is never touched.
 */
import type { ToolCall, ToolDefinition } from '../../types';
import type { ModelProfile } from '../llm/modelProfile';

/** The subset of JSON Schema the repair reads. */
interface RepairSchema {
  type?: unknown;
  properties?: Record<string, RepairSchema>;
  required?: unknown;
  items?: RepairSchema;
}

export interface ToolArgumentRepairResult {
  input: Record<string, unknown>;
  /** Dotted paths of the fields that were changed, in schema order. */
  repairedPaths: string[];
}

const INTEGER_LITERAL = /^[+-]?\d+$/;
const NUMBER_LITERAL = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function schemaType(schema: RepairSchema): string | null {
  return typeof schema.type === 'string' ? schema.type : null;
}

function requiredKeys(schema: RepairSchema): Set<string> {
  return new Set(Array.isArray(schema.required) ? schema.required.filter((key): key is string => typeof key === 'string') : []);
}

function parseJsonString(value: string): unknown {
  const trimmed = value.trim();
  if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

/** Repair one value against its schema; returns the value to use and whether it changed. */
function repairValue(
  value: unknown,
  schema: RepairSchema,
  path: string,
  repairedPaths: string[],
): unknown {
  const type = schemaType(schema);
  let current = value;

  if ((type === 'object' || type === 'array') && typeof current === 'string') {
    const parsed = parseJsonString(current);
    const matches = type === 'object' ? isPlainObject(parsed) : Array.isArray(parsed);
    if (matches) {
      current = parsed;
      repairedPaths.push(path);
    }
  } else if ((type === 'number' || type === 'integer') && typeof current === 'string') {
    const literal = current.trim();
    const pattern = type === 'integer' ? INTEGER_LITERAL : NUMBER_LITERAL;
    if (pattern.test(literal) && Number.isFinite(Number(literal))) {
      current = Number(literal);
      repairedPaths.push(path);
    }
  } else if (type === 'boolean' && typeof current === 'string') {
    const literal = current.trim().toLowerCase();
    if (literal === 'true' || literal === 'false') {
      current = literal === 'true';
      repairedPaths.push(path);
    }
  }

  if (type === 'object' && isPlainObject(current) && schema.properties) {
    return repairObject(current, schema, path, repairedPaths);
  }
  if (type === 'array' && Array.isArray(current) && schema.items) {
    const items = schema.items;
    let changed = false;
    const repairedItems = current.map((item, index) => {
      const before = repairedPaths.length;
      const repaired = repairValue(item, items, `${path}[${index}]`, repairedPaths);
      if (repairedPaths.length !== before) changed = true;
      return repaired;
    });
    return changed ? repairedItems : current;
  }
  return current;
}

function repairObject(
  input: Record<string, unknown>,
  schema: RepairSchema,
  path: string,
  repairedPaths: string[],
): Record<string, unknown> {
  const properties = schema.properties ?? {};
  const required = requiredKeys(schema);
  const output: Record<string, unknown> = { ...input };
  for (const [key, propertySchema] of Object.entries(properties)) {
    if (!(key in output)) continue;
    const fieldPath = path ? `${path}.${key}` : key;
    if (output[key] === null && !required.has(key)) {
      delete output[key];
      repairedPaths.push(fieldPath);
      continue;
    }
    output[key] = repairValue(output[key], propertySchema, fieldPath, repairedPaths);
  }
  return output;
}

/**
 * Repair a tool call's arguments against the tool's input schema. Returns the
 * (possibly unchanged) arguments and the list of fields that were repaired.
 */
export function repairToolArguments(
  input: Record<string, unknown>,
  inputSchema: ToolDefinition['inputSchema'],
): ToolArgumentRepairResult {
  if ('_parse_error' in input) return { input, repairedPaths: [] };
  const repairedPaths: string[] = [];
  const schema: RepairSchema = {
    type: 'object',
    properties: inputSchema.properties as Record<string, RepairSchema>,
    required: inputSchema.required,
  };
  const repaired = repairObject(input, schema, '', repairedPaths);
  return { input: repairedPaths.length > 0 ? repaired : input, repairedPaths };
}

export interface RepairedToolCallsLog {
  info: (message: string, data?: Record<string, unknown>) => void;
}

/**
 * Apply the guard to a turn's tool calls when the model's profile asks for it.
 * Tools the batch names that are not in `tools` (MCP tools resolved later,
 * tools outside the roster) are passed through untouched. Each repaired call
 * is logged once with the tool name and the repaired field paths; argument
 * values never reach the log.
 */
export function repairToolCallsForProfile(
  toolCalls: ToolCall[],
  tools: readonly ToolDefinition[],
  profile: Pick<ModelProfile, 'harness'>,
  log: RepairedToolCallsLog,
): ToolCall[] {
  if (!profile.harness.guards.toolArgumentRepair) return toolCalls;
  const schemas = new Map<string, ToolDefinition['inputSchema']>();
  for (const tool of tools) schemas.set(tool.name, tool.inputSchema);
  return toolCalls.map((toolCall) => {
    const inputSchema = schemas.get(toolCall.name);
    if (!inputSchema) return toolCall;
    const { input, repairedPaths } = repairToolArguments(toolCall.input, inputSchema);
    if (repairedPaths.length === 0) return toolCall;
    log.info('Repaired tool arguments before dispatch', { tool: toolCall.name, fields: repairedPaths });
    return { ...toolCall, input };
  });
}
