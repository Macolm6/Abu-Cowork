import { useMemo } from 'react';
import { IconButton } from '@/components/ds/button';
import { AppIcons } from '@/components/ds/icons';
import { useI18n } from '@/i18n';
import type { CommandOutcome } from '@/types';
import { foldResultRows, type ToolResultFold, type ToolResultRow } from '@/utils/toolResultFold';
import { commandOutputSections } from '@/utils/toolViews/commandView';
import { ResultRows } from '@/components/chat/DetailBlockView';
import { FoldedRows } from './FoldedRows';

export type StepViewStatus = 'pending' | 'running' | 'completed' | 'error' | 'cancelled';

interface CommandFolds {
  stdout: ToolResultFold | null;
  stderr: ToolResultFold | null;
  whole: ToolResultFold | null;
}

function commandFolds(text: string, outcome: CommandOutcome | undefined): CommandFolds {
  const sections = commandOutputSections(text, outcome);
  return {
    stdout: sections.stdout && foldResultRows(sections.stdout),
    stderr: sections.stderr && foldResultRows(sections.stderr),
    whole: sections.whole && foldResultRows(sections.whole),
  };
}

/** A run_command step: the command, then its output and error output once it has run. */
export function CommandStepView({ command, background, status, outcome, text }: {
  command: string;
  background: boolean;
  status: StepViewStatus;
  outcome: CommandOutcome | undefined;
  text: string;
}) {
  const { t } = useI18n();
  const showOutput = status === 'completed' && !background;
  const folds = useMemo(() => (showOutput ? commandFolds(text, outcome) : null), [showOutput, text, outcome]);
  const renderRows = (rows: readonly ToolResultRow[]) => <ResultRows rows={rows} t={t} />;
  const heading = (label: string) => (
    <div className="px-3 pt-2 text-caption text-label-tertiary">{label}</div>
  );

  return (
    <div className="overflow-hidden rounded-panel bg-code">
      <div className="flex items-start gap-2 py-1 pl-3 pr-1">
        <span className="min-w-0 flex-1 whitespace-pre-wrap break-all py-1 font-code text-mono text-label">{command}</span>
        <IconButton
          size="sm"
          icon={AppIcons.copy}
          label={t.chat.copy}
          onClick={() => void navigator.clipboard.writeText(command)}
        />
      </div>
      {status === 'running' && !background && (
        <div className="border-t border-separator px-3 py-2 text-caption text-label-tertiary">{t.task.outputPending}</div>
      )}
      {folds && (
        <div className="border-t border-separator">
          {folds.stdout && (
            <>
              {heading(t.task.output)}
              <FoldedRows fold={folds.stdout} renderRows={renderRows} className="text-label" />
            </>
          )}
          {folds.stderr && (
            <>
              {heading(t.task.errorOutput)}
              <FoldedRows fold={folds.stderr} renderRows={renderRows} className="text-danger" />
            </>
          )}
          {folds.whole && (
            <>
              {heading(t.task.output)}
              <FoldedRows fold={folds.whole} renderRows={renderRows} className="text-label" />
            </>
          )}
          {!folds.stdout && !folds.stderr && !folds.whole && (
            <div className="px-3 py-2 text-caption text-label-tertiary">{t.task.noOutput}</div>
          )}
        </div>
      )}
    </div>
  );
}
