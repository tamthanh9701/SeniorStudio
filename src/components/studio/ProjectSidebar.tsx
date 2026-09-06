"use client";

import { FolderPlus } from "lucide-react";
import { ModuleLinks, RecentPrompts, SectionLabel, SidebarBranding, SidebarFooter } from "@/components/studio/ModuleContextSidebar";
import type { ModuleId } from "@/components/studio/ModuleContextSidebar";
import type { ProjectJobFeedItem } from "@/db/ai-jobs";

export default function ProjectSidebar({ activeModule = "playground", recentJobs = [], userEmail, onNewProject }: {
  activeModule?: ModuleId;
  recentJobs?: ProjectJobFeedItem[];
  userEmail: string;
  onNewProject?: () => void;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col p-3">
      <SidebarBranding />
      {onNewProject && <button onClick={onNewProject} className="studio-button-secondary w-full justify-start"><FolderPlus className="size-4" />New project</button>}
      <div className="mt-5 min-h-0 flex-1 overflow-y-auto">
        <SectionLabel>Modules</SectionLabel>
        <ModuleLinks active={activeModule} className="mt-2" />
        {recentJobs.length > 0 && (
          <>
            <SectionLabel className="mt-6">Recent prompts</SectionLabel>
            <RecentPrompts items={recentJobs} className="mt-2" />
          </>
        )}
      </div>
      <SidebarFooter userEmail={userEmail} />
    </div>
  );
}
