import type { SubagentMetadata } from '../../src/types';
export interface ConvertedAgent { name: string; description: string; frontmatter: Record<string, unknown>; body: string; }
export const AGENT_FRONTMATTER_ALLOWLIST: readonly string[];
export function convertSingleFileAgent(raw: string, fallbackName: string): ConvertedAgent;
export function renderAgentMd(agent: ConvertedAgent, options?: { pluginKey?: string }): string;
export function serializeAgentMd(metadata: Partial<SubagentMetadata>, systemPrompt: string): string;
export type AgentI18nFields = Pick<SubagentMetadata, 'displayNames' | 'descriptions' | 'intros' | 'expertiseI18n' | 'samplePromptsI18n' | 'tagsI18n'>;
export function parseAgentI18n(value: unknown): AgentI18nFields;
export function serializeAgentI18n(metadata: Partial<SubagentMetadata>): Record<string, Record<string, string | string[]>> | undefined;
export function formatAgentSource(source: SubagentMetadata['source']): string | undefined;

export const BUILTIN_AGENT_NAMES: readonly string[];
