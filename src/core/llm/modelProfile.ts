/**
 * Model profile — one record that says how Abu talks to a model.
 *
 * The agent loop, the prompt builder, the tool selection and the two adapters
 * read this record and never inspect a model id themselves. It is resolved per
 * field, highest precedence first:
 *
 *   model-level declaration > provider-level declaration > per-id rule
 *   > family default > generic default
 *
 * for the wire and harness fields, while `capabilities` keep their own order
 * (generated table > family fallback, then the user's declaration on top,
 * see `resolveCapabilities` / `applyDeclaredCapabilities`).
 *
 * The record is plain data: it crosses the sidecar boundary inside
 * `ChatOptions` unchanged.
 */
import type { DeclaredCapabilities, ProviderInstance, ProviderSource } from '@/types/provider';
import {
  type AgentModelCapabilities,
  type ModelCapabilities,
  resolveAgentModelCapabilities,
  resolveCapabilities,
} from './modelCapabilities';
import { applyDeclaredCapabilities } from './applyDeclaredCapabilities';
import { resolveModelDeclared } from './resolveModelDeclared';
import { deriveThinkingFormat } from './model-data/thinkingFormat';
import {
  FAMILY_PROFILE_DEFAULTS,
  MODEL_ID_RULES,
  bareModelId,
  resolveModelFamily,
  type ModelFamily,
  type ProfileHarness,
  type ProfileWire,
} from './model-data/families';

export type { ModelFamily, ProfileHarness, ProfileWire } from './model-data/families';

export interface ModelProfile {
  family: ModelFamily;
  modelId: string;
  providerId?: string;
  capabilities: ModelCapabilities & { parallelToolCalls: boolean };
  agent: AgentModelCapabilities;
  wire: ProfileWire;
  harness: ProfileHarness;
}

export interface ResolveModelProfileInput {
  modelId: string;
  /** The provider the request goes through; its declarations and source feed the profile. */
  provider?: ProviderInstance;
  /** Already-resolved declarations (callers that resolved them for the model take precedence over `provider`). */
  declared?: DeclaredCapabilities;
  providerSource?: ProviderSource;
  /** The request URL or its host; the host picks the thinking format and the cache key. */
  baseUrl?: string;
  requestHost?: string;
}

function hostOf(input: ResolveModelProfileInput): string {
  if (input.requestHost) return input.requestHost.toLowerCase();
  const url = input.baseUrl ?? input.provider?.baseUrl;
  if (!url) return '';
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return '';
  }
}

const OFFICIAL_OPENAI_HOST = /(^|\.)api\.openai\.com$/i;

/** True when the host itself dictates the thinking format (a gateway speaks its own dialect). */
function hostDerivedThinkingFormat(host: string): ProfileWire['thinkingFormat'] | null {
  if (!host) return null;
  const derived = deriveThinkingFormat(host, '', undefined);
  return derived === 'openai' ? null : derived;
}

export function resolveModelProfile(input: ResolveModelProfileInput): ModelProfile {
  const { modelId } = input;
  const declared = input.declared ?? resolveModelDeclared(input.provider, modelId);
  const providerSource = input.providerSource ?? input.provider?.source;
  const family = resolveModelFamily(modelId);
  const defaults = FAMILY_PROFILE_DEFAULTS[family];
  const host = hostOf(input);
  const bare = bareModelId(modelId).toLowerCase();

  let wire: ProfileWire = { ...defaults.wire };
  let harness: ProfileHarness = { ...defaults.harness, guards: { ...defaults.harness.guards } };
  let parallelToolCalls = defaults.parallelToolCalls;

  for (const rule of MODEL_ID_RULES) {
    if (!rule.test.test(bare)) continue;
    if (rule.wire) wire = { ...wire, ...rule.wire };
    if (rule.harness) {
      const { guards, ...rest } = rule.harness;
      harness = { ...harness, ...rest, guards: { ...harness.guards, ...guards } };
    }
    if (rule.parallelToolCalls !== undefined) parallelToolCalls = rule.parallelToolCalls;
  }

  // A gateway's own thinking dialect wins over the model's: the gateway
  // translates for the model behind it.
  const hostFormat = hostDerivedThinkingFormat(host);
  if (hostFormat) wire.thinkingFormat = hostFormat;
  wire.promptCacheKey = OFFICIAL_OPENAI_HOST.test(host);

  if (declared) {
    wire.stripReasoningParams = declared.supportsReasoning === false;
    if (declared.supportedEfforts && declared.supportedEfforts.length > 0) {
      wire.supportedEfforts = [...declared.supportedEfforts];
    }
    if (declared.thinkingFormat) wire.thinkingFormat = declared.thinkingFormat;
    if (declared.maxTokensField) wire.maxTokensField = declared.maxTokensField;
    if (declared.requiresToolResultName !== undefined) wire.toolResultName = declared.requiresToolResultName;
    if (declared.reasoningReplay) wire.reasoningReplay = declared.reasoningReplay;
    if (declared.toolSchemaDialect) wire.toolSchemaDialect = declared.toolSchemaDialect;
    if (declared.sendTemperature !== undefined) wire.sendTemperature = declared.sendTemperature;
    if (declared.promptCacheKey !== undefined) wire.promptCacheKey = declared.promptCacheKey;
    if (declared.parallelToolCalls !== undefined) parallelToolCalls = declared.parallelToolCalls;
  }

  const capabilities = applyDeclaredCapabilities(resolveCapabilities(modelId), declared);
  const agent = resolveAgentModelCapabilities({ modelId, providerSource, declared });

  return {
    family,
    modelId,
    providerId: input.provider?.id,
    capabilities: { ...capabilities, parallelToolCalls },
    agent,
    wire,
    harness,
  };
}
