import { ScrollArea } from '@/components/ds/scroll-area';
import TaskProgressPanel from '../TaskProgressPanel';
import ChangedFilesSection from '../ChangedFilesSection';
import WorkspaceFilesSection from '../WorkspaceFilesSection';

/**
 * The "task summary" (任务摘要) tab body: the task's progress, the files the
 * conversation changed, and every file of the workspace folder, each a section
 * that folds away (`SummarySection`), with a line between them. It is the
 * default tab of the workspace tab strip.
 */
export default function SummaryBody() {
  return (
    <ScrollArea className="h-full">
      <div className="p-4 divide-y divide-separator">
        <TaskProgressPanel />
        <ChangedFilesSection />
        <WorkspaceFilesSection />
      </div>
    </ScrollArea>
  );
}
