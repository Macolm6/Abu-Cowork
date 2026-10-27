import type { ToolDefinition } from '@/types';
import { orderSectionsForCaching, type PromptSection } from '../llm/promptSections';

/** Stable prompt sections used by normal requests and manual compaction. */
export function composeRequestPromptSections(
  baseSections: PromptSection[],
  tools: ToolDefinition[],
  deferredToolsSummary: string,
): PromptSection[] {
  const byServer = new Map<string, string[]>();
  for (const tool of tools.filter((entry) => entry.name.includes('__'))) {
    const [server, toolName] = tool.name.split('__', 2);
    const names = byServer.get(server) ?? [];
    names.push(toolName);
    byServer.set(server, names);
  }
  const dynamic: PromptSection[] = [];
  if (byServer.size > 0) {
    const lines = [...byServer].map(([server, names]) => `- ${server}: ${names.join(', ')}`);
    dynamic.push({ name: 'mcp-capabilities', text: `## Currently connected MCP tools\n${lines.join('\n')}`, cacheable: true });
  }
  if (deferredToolsSummary) dynamic.push({ name: 'deferred-tools', text: deferredToolsSummary, cacheable: true });
  return orderSectionsForCaching([...baseSections, ...dynamic]);
}
