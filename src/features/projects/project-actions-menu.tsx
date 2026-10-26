import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { Icon } from '@/shared/icon';

import type { ProjectSummary } from './project-summary';

export type ProjectAction =
  | { readonly id: 'open' }
  | { readonly id: 'terminal' }
  | { readonly id: 'github' }
  | { readonly id: 'pullRequests' }
  | { readonly id: 'copyPath' }
  | { readonly id: 'copyUrl' }
  | { readonly id: 'gitFetch' }
  | { readonly id: 'gitPull' }
  | { readonly id: 'gitSwitch'; readonly branch: string }
  | { readonly id: 'runScript'; readonly script: string };

/** Everything you can do to one project, behind its ellipsis button. */
export function ProjectActionsMenu({
  project,
  onAction,
}: {
  project: ProjectSummary;
  onAction: (action: ProjectAction) => void;
}) {
  const branches = project.branches ?? [];
  const scripts = project.packageScripts ?? [];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger>
        <button
          type="button"
          aria-label={`Actions for ${project.name}`}
          className="inline-grid size-(--control-sm) place-items-center rounded-(--radius-sm) text-muted hover:bg-(--tint-hover) hover:text-body data-[state=open]:bg-(--tint-hover) data-[state=open]:text-body"
        >
          <Icon name="ellipsis" size={16} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent aria-label={`${project.name} actions`}>
        <DropdownMenuLabel>Project</DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => onAction({ id: 'open' })}>Open</DropdownMenuItem>
        {project.path && (
          <>
            <DropdownMenuItem onSelect={() => onAction({ id: 'terminal' })}>
              Open terminal
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onAction({ id: 'copyPath' })}>
              Copy path
            </DropdownMenuItem>
          </>
        )}
        {project.githubUrl && (
          <>
            <DropdownMenuItem onSelect={() => onAction({ id: 'github' })}>
              Open GitHub
            </DropdownMenuItem>
            {project.pullRequests.length > 0 && (
              <DropdownMenuItem onSelect={() => onAction({ id: 'pullRequests' })}>
                Pull requests
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onSelect={() => onAction({ id: 'copyUrl' })}>
              Copy GitHub URL
            </DropdownMenuItem>
          </>
        )}

        {project.path && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>Git</DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuItem onSelect={() => onAction({ id: 'gitFetch' })}>
                  Fetch
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => onAction({ id: 'gitPull' })}>
                  Pull
                </DropdownMenuItem>
                {branches.length > 0 && (
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger>Switch branch</DropdownMenuSubTrigger>
                    <DropdownMenuSubContent>
                      {branches.map((branch) => (
                        <DropdownMenuItem
                          key={branch}
                          className={cn(
                            branch === project.currentBranch && 'bg-(--tint-hover) text-strong',
                          )}
                          onSelect={() => onAction({ id: 'gitSwitch', branch })}
                        >
                          {branch}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                )}
              </DropdownMenuSubContent>
            </DropdownMenuSub>

            {scripts.length > 0 && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>Scripts</DropdownMenuSubTrigger>
                  <DropdownMenuSubContent>
                    {scripts.map((script) => (
                      <DropdownMenuItem
                        key={script}
                        onSelect={() => onAction({ id: 'runScript', script })}
                      >
                        npm run {script}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              </>
            )}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
