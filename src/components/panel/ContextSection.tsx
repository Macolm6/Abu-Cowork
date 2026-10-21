import { useState, useMemo, useEffect } from 'react';
import { Icon } from '@/components/ds/icon';
import { AppIcons } from '@/components/ds/icons';
import { Pressable } from '@/components/ds/pressable';
import { Spinner } from '@/components/ds/spinner';
import { Tag } from '@/components/ds/tag';
import { cn } from '@/lib/utils';
import { useActiveToolCallLists } from './useActiveToolCallLists';
import { useMCPStore, initMCPStoreSync, type MCPServerEntry } from '@/stores/mcpStore';
import { useI18n } from '@/i18n';
import { useShallow } from 'zustand/react/shallow';

/**
 * ContextSection - Shows tool call statistics and MCP connectors
 */
export default function ContextSection() {
  const [expanded, setExpanded] = useState(false);
  const [connectorsExpanded, setConnectorsExpanded] = useState(true);
  // Only the tool calls: text streaming into a message leaves them as they are, so
  // the section stays as it is for every streamed character.
  const toolCallLists = useActiveToolCallLists();
  const mcpServers = useMCPStore(useShallow((s) => Object.values(s.servers)));
  const isLoadingMCP = useMCPStore((s) => s.isLoading);
  const { t } = useI18n();

  // Initialize MCP store sync on mount
  useEffect(() => {
    initMCPStoreSync();
  }, []);

  // Tool use and the connectors it reached, from the conversation's tool calls
  const contextData = useMemo(() => {
    const toolStats: Record<string, number> = {};
    const usedMCPServers = new Set<string>();

    for (const toolCalls of toolCallLists) {
      if (toolCalls) {
        for (const tc of toolCalls) {
          // Count tool usage
          toolStats[tc.name] = (toolStats[tc.name] || 0) + 1;

          // Track MCP server usage (format: serverName__toolName)
          const sepIndex = tc.name.indexOf('__');
          if (sepIndex > 0) {
            usedMCPServers.add(tc.name.substring(0, sepIndex));
          }
        }
      }
    }

    const totalToolCalls = Object.values(toolStats).reduce((a, b) => a + b, 0);

    return { toolStats, totalToolCalls, usedMCPServers };
  }, [toolCallLists]);

  // Only show MCP servers that were actually used in this conversation
  const usedServers = mcpServers.filter((s) => contextData.usedMCPServers.has(s.config.name));
  const hasUsedMCPServers = usedServers.length > 0;
  const hasContent = contextData.totalToolCalls > 0 || hasUsedMCPServers;

  return (
    <div>
      {/* Header */}
      <Pressable
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        className="flex w-full items-center justify-between text-left"
      >
        <span className="flex items-center gap-2">
          <Icon icon={AppIcons.clock} className="text-label-secondary" />
          <span className="text-ui font-medium text-label">{t.panel.context}</span>
          {contextData.totalToolCalls > 0 && (
            <span className="text-ui-sm text-label-tertiary">
              {contextData.totalToolCalls} ops
            </span>
          )}
        </span>
        <Icon
          icon={AppIcons.expand}
          size="sm"
          className={cn('text-label-tertiary transition-transform duration-fast', !expanded && '-rotate-90')}
        />
      </Pressable>

      {expanded && (
        <div className="mt-3">
          {hasContent ? (
            <div className="space-y-4">
              {/* Tool Stats */}
              {Object.keys(contextData.toolStats).length > 0 && (
                <div>
                  <div className="mb-2 text-ui-sm text-label-tertiary">{t.panel.toolUsage}</div>
                  <div className="flex flex-wrap gap-1">
                    {Object.entries(contextData.toolStats).map(([tool, count]) => (
                      <Tag key={tool}>
                        <Icon icon={AppIcons.tool} size="sm" />
                        {formatToolName(tool)}
                        <span className="text-label-tertiary">x{count}</span>
                      </Tag>
                    ))}
                  </div>
                </div>
              )}

              {/* Connectors (MCP Servers) - only show servers used in this conversation */}
              {hasUsedMCPServers && (
                <ConnectorsSection
                  servers={usedServers}
                  expanded={connectorsExpanded}
                  onToggle={() => setConnectorsExpanded(!connectorsExpanded)}
                  isLoading={isLoadingMCP}
                  t={t}
                />
              )}
            </div>
          ) : (
            <div className="flex flex-col items-center py-4 text-center">
              <div className="mb-2 flex items-center gap-2">
                <div className="h-6 w-5 rounded-control bg-fill" />
                <div className="h-6 w-5 rounded-control bg-fill" />
                <div className="h-6 w-5 rounded-control bg-fill" />
              </div>
              <p className="text-ui-sm text-label-tertiary">
                {t.panel.contextEmptyHint}
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// --- Connectors Section ---

interface ConnectorsSectionProps {
  servers: MCPServerEntry[];
  expanded: boolean;
  onToggle: () => void;
  isLoading: boolean;
  t: ReturnType<typeof useI18n>['t'];
}

function ConnectorsSection({ servers, expanded, onToggle, isLoading, t }: ConnectorsSectionProps) {
  const connectedCount = servers.filter((s) => s.status === 'connected').length;

  return (
    <div>
      <Pressable
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex w-full items-center justify-between text-left"
      >
        <span className="flex items-center gap-2">
          <Icon icon={AppIcons.plug} size="sm" className="text-label-tertiary" />
          <span className="text-ui-sm text-label-tertiary">{t.panel.connectors}</span>
          <span className="text-caption text-label-tertiary">
            {connectedCount}/{servers.length}
          </span>
        </span>
        <Icon
          icon={AppIcons.expand}
          size="sm"
          className={cn('text-label-tertiary transition-transform duration-fast', !expanded && '-rotate-90')}
        />
      </Pressable>

      {expanded && (
        <div className="mt-2 space-y-1">
          {servers.map((server) => (
            <ConnectorRow key={server.config.name} server={server} />
          ))}
          {/* The one spinner of the connectors area; a reconnecting row shows a still icon */}
          {isLoading && <Spinner size="sm" label={t.panel.refreshing} />}
        </div>
      )}
    </div>
  );
}

interface ConnectorRowProps {
  server: MCPServerEntry;
}

function ConnectorRow({ server }: ConnectorRowProps) {
  const { config, status, tools } = server;

  // Every status mark sits in the same 16px box, so the names share one column.
  const renderStatusIcon = () => {
    if (status === 'connected') {
      return <Icon icon={AppIcons.plug} size="md" className="text-label-secondary" />;
    }
    if (status === 'reconnecting') {
      return <Icon icon={AppIcons.loading} size="md" className="text-label-tertiary" />;
    }
    return (
      <span className="flex h-4 w-4 shrink-0 items-center justify-center">
        <span className="h-2 w-2 rounded-full border border-control-border" />
      </span>
    );
  };

  return (
    <div className="flex items-center gap-3 py-1">
      {renderStatusIcon()}
      <span className="text-ui text-label-tertiary">{config.name}</span>
      {status === 'connected' && tools.length > 0 && (
        <span className="text-caption text-label-tertiary">{tools.length} tools</span>
      )}
    </div>
  );
}

// Format tool name for display
function formatToolName(name: string): string {
  return name
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace('Get System Info', 'System Info')
    .replace('List Directory', 'List Dir')
    .replace('Read File', 'Read')
    .replace('Write File', 'Write')
    .replace('Run Command', 'Run');
}
