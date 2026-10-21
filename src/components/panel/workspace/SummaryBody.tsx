import { ScrollArea } from '@/components/ds/scroll-area';
import TaskProgressPanel from '../TaskProgressPanel';
import ChangedFilesSection from '../ChangedFilesSection';
import WorkspaceSection from '../WorkspaceSection';
import ContextSection from '../ContextSection';

/**
 * The "task summary" (任务摘要) tab body: task progress, the files the
 * conversation changed, the workspace, and context. This was the right
 * panel's old fixed "details mode" — now it's the default tab in the
 * workspace tab strip.
 */
export default function SummaryBody() {
  return (
    <ScrollArea className="h-full">
      <div className="p-4 space-y-5">
        <TaskProgressPanel />
        <ChangedFilesSection />
        <WorkspaceSection />
        <div className="border-t border-separator" />
        <ContextSection />
      </div>
    </ScrollArea>
  );
}
