import { useMemo, type ReactNode } from 'react';
import { useI18n } from '@/i18n';
import { TOOL_NAMES } from '@/core/tools/toolNames';
import { foldToolResult } from '@/utils/toolResultFold';
import { ResultRows } from '@/components/chat/DetailBlockView';
import { CommandStepView, type StepViewStatus } from './CommandStepView';
import { FileReadStepView } from './FileReadStepView';
import { FoldedRows } from './FoldedRows';
import { PathListStepView } from './PathListStepView';
import { SearchStepView } from './SearchStepView';
import { WebFetchStepView } from './WebFetchStepView';
import { WebSearchStepView } from './WebSearchStepView';
import type { ToolViewRecord } from './toolViewRecords';

const textOf = (input: Record<string, unknown>, key: string): string => {
  const value = input[key];
  return typeof value === 'string' ? value : '';
};

/** The failure text of a step that ended with an error. */
function FailureView({ text }: { text: string }) {
  const { t } = useI18n();
  const fold = useMemo(() => foldToolResult(text), [text]);
  return <FoldedRows fold={fold} renderRows={(rows) => <ResultRows rows={rows} t={t} />} className="text-danger" />;
}

/** The view of a step whose tool has one, chosen by the tool's name. */
export function StepToolView({ toolName, status, input, record, text, fullUnavailable }: {
  toolName: string;
  status: StepViewStatus;
  input: Record<string, unknown>;
  record: ToolViewRecord | undefined;
  /** The text to read: the whole result, or the saved part of it. */
  text: string;
  /** The conversation holds only part of the result. */
  fullUnavailable: boolean;
}) {
  const { t } = useI18n();
  let kind: string;
  let view: ReactNode;
  switch (toolName) {
    case TOOL_NAMES.RUN_COMMAND:
      kind = 'command';
      view = (
        <CommandStepView
          command={textOf(input, 'command')}
          background={input.background === true}
          status={status}
          outcome={record?.commandOutcome}
          text={text}
        />
      );
      break;
    case TOOL_NAMES.READ_FILE:
      kind = 'file-read';
      view = <FileReadStepView path={textOf(input, 'path')} status={status} outcome={record?.fileReadOutcome} text={text} />;
      break;
    case TOOL_NAMES.SEARCH_FILES:
      kind = 'search';
      view = <SearchStepView pattern={textOf(input, 'pattern')} status={status} text={text} />;
      break;
    case TOOL_NAMES.FIND_FILES:
      kind = 'find';
      view = <PathListStepView kind="find" subject={textOf(input, 'pattern')} status={status} text={text} />;
      break;
    case TOOL_NAMES.LIST_DIRECTORY:
      kind = 'list';
      view = <PathListStepView kind="list" subject={textOf(input, 'path')} status={status} text={text} />;
      break;
    case TOOL_NAMES.HTTP_FETCH:
      kind = 'web-fetch';
      view = <WebFetchStepView url={textOf(input, 'url')} status={status} outcome={record?.httpFetchOutcome} text={text} />;
      break;
    case TOOL_NAMES.WEB_SEARCH:
      kind = 'web-search';
      view = <WebSearchStepView query={textOf(input, 'query')} status={status} text={text} />;
      break;
    default:
      throw new Error(`StepToolView: no view for tool ${toolName}`);
  }

  return (
    <div data-step-view={kind}>
      {status === 'error' ? <FailureView text={text} /> : view}
      {fullUnavailable && <div className="mt-1 text-caption text-label-tertiary">{t.chat.toolResultFullUnavailable}</div>}
    </div>
  );
}
