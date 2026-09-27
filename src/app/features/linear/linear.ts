import { ChangeDetectionStrategy, Component, DestroyRef, inject, signal } from '@angular/core';

import { NexusAccount } from '@core/nexus-account';
import { currentSurface } from '@core/surface';
import {
  type LinearCodexContext,
  type LinearCodexLink,
  TauriBridge,
  type LinearConnection,
  type LinearCycle,
  type LinearInitiative,
  type LinearIssue,
  type LinearIssueDetail,
  type LinearLabel,
  type LinearMilestone,
  type LinearProject,
  type LinearProjectStatus,
  type LinearPerson,
  type LinearTeam,
  type LinearWorkflowState,
  type WorkspaceSummary,
} from '@core/tauri';
import { UmbraButtonComponent } from '@umbra/components/umbra-button/umbra-button.component';

interface LinearIssueDraft {
  teamId: string;
  title: string;
  description: string;
  milestoneId?: string;
}

@Component({
  selector: 'rl-linear',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [UmbraButtonComponent],
  template: `
    <section class="wrap">
      <header>
        <div>
          <p class="u-title">{{ pageTitle() }}</p>
          <p class="hint">{{ pageDescription() }}</p>
        </div>
        @if (connections().length) {
          <div class="header-actions">
            @if (selected() && !selected()?.nexusCredentialId) {
              <umbra-button
                size="sm"
                variant="outline"
                (click)="syncSelected()"
                [disabled]="syncing() || !nexus.status().connected"
              >
                {{ syncing() ? 'Syncing' : 'Sync through Nexus' }}
              </umbra-button>
            }
            <umbra-button
              size="sm"
              variant="outline"
              (click)="connect()"
              [disabled]="pending() || !oauthConfigured()"
            >
              Connect workspace
            </umbra-button>
          </div>
        }
      </header>

      @if (error()) {
        <p class="error" role="alert">{{ error() }}</p>
      }
      @if (!oauthConfigured()) {
        <p class="hint">
          Linear is ready to connect once Relay’s Linear OAuth app is registered and its client ID
          is added to the release configuration.
        </p>
      }
      @if (!nexus.status().connected) {
        <p class="hint">
          Connect Relay to Nexus first to keep Linear connections available across devices.
        </p>
      }
      @if (!connections().length) {
        <div class="empty">
          <p class="label">No Linear workspaces connected</p>
          <p class="hint">Nexus sign-in is required before Linear can be connected.</p>
          <umbra-button
            size="sm"
            [disabled]="pending() || !nexus.status().connected || !oauthConfigured()"
            (click)="connect()"
          >
            {{
              pending()
                ? 'Opening Linear'
                : oauthConfigured()
                  ? 'Connect Linear'
                  : 'OAuth setup pending'
            }}
          </umbra-button>
        </div>
      } @else {
        <nav class="workspaces" aria-label="Linear workspaces">
          @for (connection of connections(); track connection.organizationId) {
            <button
              type="button"
              class="workspace"
              [class.active]="selected()?.organizationId === connection.organizationId"
              (click)="select(connection)"
            >
              <span>{{ connection.organizationName }}</span>
              <span class="muted">{{ connection.viewerName }}</span>
              <span class="sync-state">
                {{ connection.nexusCredentialId ? 'Synced through Nexus' : 'This device only' }}
              </span>
            </button>
          }
        </nav>
        @if (selected()) {
          <nav class="sections" aria-label="Linear views">
            <button
              type="button"
              [class.active]="section() === 'work'"
              (click)="setSection('work')"
            >
              My work
            </button>
            <button
              type="button"
              [class.active]="section() === 'projects'"
              (click)="setSection('projects')"
            >
              Projects
            </button>
            <button
              type="button"
              [class.active]="section() === 'cycles'"
              (click)="setSection('cycles')"
            >
              Cycles
            </button>
            <button
              type="button"
              [class.active]="section() === 'roadmap'"
              (click)="setSection('roadmap')"
            >
              Roadmap
            </button>
          </nav>
          @if (issueDetail(); as detail) {
            <section class="issue-detail" aria-label="Linear issue details">
              <div class="issue-heading">
                <div>
                  <p class="muted">{{ detail.issue.identifier }} · {{ detail.issue.team.name }}</p>
                  <h2>{{ detail.issue.title }}</h2>
                </div>
                <umbra-button size="sm" variant="link" (click)="closeIssueDetail()">
                  Close
                </umbra-button>
              </div>
              @if (detail.issue.description) {
                <p class="issue-description">{{ detail.issue.description }}</p>
              }
              <div class="issue-fields">
                <label>
                  <span>Status</span>
                  <select
                    [value]="detail.issue.state?.id ?? ''"
                    (change)="updateStatus(detail.issue, $any($event.target).value)"
                  >
                    @for (state of statesFor(detail.issue); track state.id) {
                      <option [value]="state.id">{{ state.name }}</option>
                    }
                  </select>
                </label>
                <label>
                  <span>Priority</span>
                  <select
                    [value]="detail.issue.priority"
                    (change)="updatePriority(detail.issue, +$any($event.target).value)"
                  >
                    <option [value]="0">No priority</option>
                    <option [value]="1">Urgent</option>
                    <option [value]="2">High</option>
                    <option [value]="3">Normal</option>
                    <option [value]="4">Low</option>
                  </select>
                </label>
                <label>
                  <span>Assignee</span>
                  <select
                    [value]="detail.issue.assignee?.id ?? ''"
                    (change)="updateAssignee(detail.issue, $any($event.target).value)"
                  >
                    <option value="">Unassigned</option>
                    @for (user of users(); track user.id) {
                      <option [value]="user.id">{{ user.name }}</option>
                    }
                  </select>
                </label>
                <label>
                  <span>Cycle</span>
                  <select
                    [value]="detail.issue.cycle?.id ?? ''"
                    (change)="updateCycle(detail.issue, $any($event.target).value)"
                  >
                    <option value="">No cycle</option>
                    @for (cycle of cyclesFor(detail.issue.team.id); track cycle.id) {
                      <option [value]="cycle.id">{{ cycle.name }}</option>
                    }
                  </select>
                </label>
                <label>
                  <span>Labels</span>
                  <select multiple size="4" (change)="updateLabels(detail.issue, $event)">
                    @for (label of labelsFor(detail.issue.team.id); track label.id) {
                      <option
                        [value]="label.id"
                        [selected]="detail.issue.labels.some((item) => item.id === label.id)"
                      >
                        {{ label.name }}
                      </option>
                    }
                  </select>
                </label>
                @if (detail.issue.project) {
                  <span class="muted">Project {{ detail.issue.project.name }}</span>
                }
                @if (detail.issue.cycle) {
                  <span class="muted">Cycle {{ detail.issue.cycle.name }}</span>
                }
              </div>
              @if (canUseCodex) {
                <section class="detail-section" aria-label="Codex work">
                  <h3>Codex</h3>
                  @if (detail.issue.project && isCodexAllowed(detail.issue)) {
                    @if (codexRequest()?.issue.id === detail.issue.id) {
                      <div class="codex-confirm" role="group" aria-label="Confirm Codex handoff">
                        <p>
                          {{ codexRequest()?.continueThread ? 'Continue' : 'Start' }} a Codex thread
                          for {{ detail.issue.identifier }} in {{ selectedCodexWorkspace()?.name }}?
                        </p>
                        <p class="hint">
                          Codex can change files in this local repository. Relay will post its final
                          report as an issue comment and leave the issue in review.
                        </p>
                        <div class="issue-actions">
                          <umbra-button
                            size="sm"
                            [disabled]="codexPending()"
                            (click)="confirmCodexRequest()"
                          >
                            {{ codexPending() ? 'Working in Codex' : 'Confirm and run' }}
                          </umbra-button>
                          <umbra-button
                            size="sm"
                            variant="outline"
                            [disabled]="codexPending()"
                            (click)="codexRequest.set(null)"
                          >
                            Cancel
                          </umbra-button>
                        </div>
                      </div>
                    }
                    <label>
                      <span>Local code workspace</span>
                      <select
                        [value]="selectedCodexWorkspacePath()"
                        (change)="selectCodexWorkspace($any($event.target).value)"
                      >
                        <option value="">Choose a repository</option>
                        @for (workspace of codexWorkspaces(); track workspace.path) {
                          @if (
                            workspace.githubRepo === codexProjectRepo(detail.issue.project!.id)
                          ) {
                            <option [value]="workspace.path">
                              {{ workspace.name }} — {{ workspace.githubRepo }}
                            </option>
                          }
                        }
                      </select>
                    </label>
                    <div class="issue-actions">
                      <umbra-button
                        size="sm"
                        [disabled]="codexPending() || !selectedCodexWorkspacePath()"
                        (click)="requestCodex(detail.issue, false)"
                      >
                        {{ codexPending() ? 'Working in Codex' : 'Start new Codex thread' }}
                      </umbra-button>
                      @if (localCodexLink(); as link) {
                        <umbra-button
                          size="sm"
                          variant="outline"
                          [disabled]="codexPending() || !selectedCodexWorkspacePath()"
                          (click)="requestCodex(detail.issue, true)"
                        >
                          Continue Codex
                        </umbra-button>
                      }
                    </div>
                    @for (link of remoteCodexLinks(); track link.deviceId) {
                      <p class="muted">
                        This issue also has a Codex thread on {{ link.workspaceName }} on another
                        device.
                      </p>
                    }
                    @if (codexPending()) {
                      <p class="hint" role="status">
                        Codex is working in the selected local repository.
                      </p>
                    }
                  } @else if (detail.issue.project) {
                    <p class="hint">
                      Codex is disabled for this Linear project. Enable it from the project page.
                    </p>
                  } @else {
                    <p class="hint">
                      Link this issue to a Linear project with Codex enabled before sending it to
                      Codex.
                    </p>
                  }
                </section>
              }
              @if (detail.children.length) {
                <section class="detail-section" aria-label="Sub-issues">
                  <h3>Sub-issues</h3>
                  @for (child of detail.children; track child.id) {
                    <button type="button" class="issue-link" (click)="openIssueDetail(child)">
                      {{ child.identifier }} · {{ child.title }}
                    </button>
                  }
                </section>
              }
              <form class="detail-form" (submit)="createSubIssue($event, detail.issue)">
                <label>
                  <span>Add sub-issue</span>
                  <input
                    required
                    maxlength="255"
                    [value]="newSubIssueTitle()"
                    (input)="newSubIssueTitle.set($any($event.target).value)"
                  />
                </label>
                <umbra-button
                  size="sm"
                  [disabled]="creatingSubIssue() || !newSubIssueTitle().trim()"
                >
                  {{ creatingSubIssue() ? 'Creating' : 'Add sub-issue' }}
                </umbra-button>
              </form>
              <section class="detail-section" aria-label="Comments">
                <h3>Comments</h3>
                @for (comment of detail.comments; track comment.id) {
                  <article class="comment">
                    <p>{{ comment.body }}</p>
                    <span class="muted">{{ comment.user?.name ?? 'Linear integration' }}</span>
                  </article>
                } @empty {
                  <p class="hint">No comments yet.</p>
                }
                <form class="detail-form" (submit)="createComment($event, detail.issue)">
                  <label>
                    <span>Write a comment</span>
                    <textarea
                      required
                      maxlength="10000"
                      rows="3"
                      [value]="newComment()"
                      (input)="newComment.set($any($event.target).value)"
                    ></textarea>
                  </label>
                  <umbra-button size="sm" [disabled]="sendingComment() || !newComment().trim()">
                    {{ sendingComment() ? 'Sending' : 'Comment' }}
                  </umbra-button>
                </form>
              </section>
            </section>
          }
          @if (section() === 'work') {
            <section class="issues" aria-label="My Linear issues">
              <div class="issue-heading">
                <h2>My work</h2>
                <div class="issue-actions">
                  <umbra-button
                    size="sm"
                    variant="link"
                    [disabled]="loading()"
                    (click)="loadIssues()"
                  >
                    {{ loading() ? 'Loading' : 'Refresh' }}
                  </umbra-button>
                  <umbra-button size="sm" variant="outline" (click)="disconnectSelected()">
                    Disconnect
                  </umbra-button>
                </div>
              </div>
              @if (teams().length) {
                <form class="create-form" (submit)="createIssue($event)">
                  <label>
                    <span>Team</span>
                    <select
                      [value]="createTeamId()"
                      (change)="setCreateTeam($any($event.target).value)"
                    >
                      @for (team of teams(); track team.id) {
                        <option [value]="team.id">{{ team.name }}</option>
                      }
                    </select>
                  </label>
                  <label>
                    <span>New issue</span>
                    <input
                      required
                      maxlength="255"
                      [value]="newTitle()"
                      (input)="updateIssueDraft('title', $any($event.target).value)"
                      placeholder="Issue title"
                    />
                  </label>
                  <label class="description-field">
                    <span>Description</span>
                    <textarea
                      rows="2"
                      [value]="newDescription()"
                      (input)="updateIssueDraft('description', $any($event.target).value)"
                      placeholder="Add context (optional)"
                    ></textarea>
                  </label>
                  <umbra-button size="sm" [disabled]="creating() || !newTitle().trim()">
                    {{ creating() ? 'Creating' : 'Create issue' }}
                  </umbra-button>
                </form>
                @if (newTitle() || newDescription()) {
                  <p class="hint">Draft saved on this device.</p>
                }
              }
              @if (issues().length === 0 && !loading()) {
                <p class="hint">No assigned issues found.</p>
              }
              @for (issue of issues(); track issue.id) {
                <article class="issue">
                  <button type="button" class="issue-link" (click)="openIssue(issue.url)">
                    {{ issue.identifier }}
                  </button>
                  <button type="button" class="issue-title" (click)="openIssueDetail(issue)">
                    {{ issue.title }}
                  </button>
                  <label class="status-control">
                    <span class="sr-only">Status for {{ issue.identifier }}</span>
                    <select
                      [value]="issue.state?.id ?? ''"
                      (change)="updateStatus(issue, $any($event.target).value)"
                    >
                      @for (state of statesFor(issue); track state.id) {
                        <option [value]="state.id">{{ state.name }}</option>
                      }
                    </select>
                  </label>
                </article>
              }
              @if (hasNextPage()) {
                <umbra-button
                  size="sm"
                  variant="outline"
                  [disabled]="loading()"
                  (click)="loadMore()"
                >
                  Load more
                </umbra-button>
              }
            </section>
          } @else if (section() === 'projects') {
            <section class="issues" aria-label="Linear projects">
              <div class="issue-heading">
                <h2>{{ selectedProject()?.name ?? 'Projects' }}</h2>
                @if (selectedProject()) {
                  <umbra-button size="sm" variant="link" (click)="selectedProject.set(null)">
                    All projects
                  </umbra-button>
                } @else {
                  <div class="issue-actions">
                    <umbra-button size="sm" variant="link" (click)="loadProjects()">
                      Refresh
                    </umbra-button>
                    <umbra-button
                      size="sm"
                      variant="outline"
                      (click)="createProjectOpen.set(!createProjectOpen())"
                    >
                      New project
                    </umbra-button>
                  </div>
                }
              </div>
              @if (selectedProject()) {
                <form class="project-edit" (submit)="saveProject($event)">
                  <label>
                    <span>Project name</span>
                    <input
                      required
                      maxlength="255"
                      [value]="editProjectName()"
                      (input)="editProjectName.set($any($event.target).value)"
                    />
                  </label>
                  <label>
                    <span>Description</span>
                    <textarea
                      rows="3"
                      [value]="editProjectDescription()"
                      (input)="editProjectDescription.set($any($event.target).value)"
                    ></textarea>
                  </label>
                  <label>
                    <span>Start date</span>
                    <input
                      type="date"
                      [value]="editProjectStartDate()"
                      (input)="editProjectStartDate.set($any($event.target).value)"
                    />
                  </label>
                  <label>
                    <span>Target date</span>
                    <input
                      type="date"
                      [value]="editProjectTargetDate()"
                      (input)="editProjectTargetDate.set($any($event.target).value)"
                    />
                  </label>
                  <label>
                    <span>Status</span>
                    <select
                      [value]="editProjectStatusId()"
                      (change)="editProjectStatusId.set($any($event.target).value)"
                    >
                      @for (status of projectStatuses(); track status.id) {
                        <option [value]="status.id">{{ status.name }}</option>
                      }
                    </select>
                  </label>
                  <label>
                    <span>Project lead</span>
                    <select
                      [value]="editProjectLeadId()"
                      (change)="editProjectLeadId.set($any($event.target).value)"
                    >
                      <option value="">No lead</option>
                      @for (user of users(); track user.id) {
                        <option [value]="user.id">{{ user.name }}</option>
                      }
                    </select>
                  </label>
                  <umbra-button size="sm" [disabled]="savingProject() || !editProjectName().trim()">
                    {{ savingProject() ? 'Saving' : 'Save project' }}
                  </umbra-button>
                </form>
                @if (canUseCodex) {
                  <div class="codex-policy">
                    <label>
                      <span>Linked code repository</span>
                      <select
                        [value]="selectedCodexProjectRepo()"
                        (change)="
                          setCodexProjectRepo(selectedProject()!.id, $any($event.target).value)
                        "
                      >
                        <option value="">Choose a GitHub repository</option>
                        @for (workspace of codexWorkspaces(); track workspace.path) {
                          @if (workspace.githubRepo) {
                            <option [value]="workspace.githubRepo">
                              {{ workspace.name }} — {{ workspace.githubRepo }}
                            </option>
                          }
                        }
                      </select>
                    </label>
                    <label class="codex-policy-toggle">
                      <input
                        type="checkbox"
                        [disabled]="!selectedCodexProjectRepo()"
                        [checked]="isCodexProjectAllowed(selectedProject()!.id)"
                        (change)="
                          setCodexProjectAllowed(selectedProject()!.id, $any($event.target).checked)
                        "
                      />
                      <span>Allow Codex to work on issues in this project</span>
                    </label>
                  </div>
                }
                <section class="milestones" aria-label="Project milestones">
                  <h3>Milestones</h3>
                  @for (milestone of milestones(); track milestone.id) {
                    <article class="issue">
                      <strong>{{ milestone.name }}</strong>
                      @if (milestone.targetDate) {
                        <span class="muted">Target {{ milestone.targetDate }}</span>
                      }
                      @if (milestone.description) {
                        <span>{{ milestone.description }}</span>
                      }
                      <umbra-button size="sm" variant="link" (click)="editMilestone(milestone)">
                        Edit
                      </umbra-button>
                    </article>
                    @if (editingMilestoneId() === milestone.id) {
                      <form class="project-edit" (submit)="saveMilestone($event, milestone)">
                        <label>
                          <span>Milestone name</span>
                          <input
                            required
                            maxlength="255"
                            [value]="editMilestoneName()"
                            (input)="editMilestoneName.set($any($event.target).value)"
                          />
                        </label>
                        <label>
                          <span>Target date</span>
                          <input
                            type="date"
                            [value]="editMilestoneDate()"
                            (input)="editMilestoneDate.set($any($event.target).value)"
                          />
                        </label>
                        <label>
                          <span>Description</span>
                          <textarea
                            rows="2"
                            [value]="editMilestoneDescription()"
                            (input)="editMilestoneDescription.set($any($event.target).value)"
                          ></textarea>
                        </label>
                        <umbra-button
                          size="sm"
                          [disabled]="savingMilestone() || !editMilestoneName().trim()"
                        >
                          {{ savingMilestone() ? 'Saving' : 'Save milestone' }}
                        </umbra-button>
                      </form>
                    }
                  } @empty {
                    <p class="hint">No milestones yet.</p>
                  }
                  <form class="project-edit" (submit)="createMilestone($event)">
                    <label>
                      <span>Milestone name</span>
                      <input
                        required
                        maxlength="255"
                        [value]="newMilestoneName()"
                        (input)="newMilestoneName.set($any($event.target).value)"
                      />
                    </label>
                    <label>
                      <span>Target date</span>
                      <input
                        type="date"
                        [value]="newMilestoneDate()"
                        (input)="newMilestoneDate.set($any($event.target).value)"
                      />
                    </label>
                    <label>
                      <span>Status</span>
                      <select
                        [value]="newProjectStatusId()"
                        (change)="newProjectStatusId.set($any($event.target).value)"
                      >
                        <option value="">Use workspace default</option>
                        @for (status of projectStatuses(); track status.id) {
                          <option [value]="status.id">{{ status.name }}</option>
                        }
                      </select>
                    </label>
                    <label>
                      <span>Project lead</span>
                      <select
                        [value]="newProjectLeadId()"
                        (change)="newProjectLeadId.set($any($event.target).value)"
                      >
                        <option value="">No lead</option>
                        @for (user of users(); track user.id) {
                          <option [value]="user.id">{{ user.name }}</option>
                        }
                      </select>
                    </label>
                    <label>
                      <span>Description</span>
                      <textarea
                        rows="2"
                        [value]="newMilestoneDescription()"
                        (input)="newMilestoneDescription.set($any($event.target).value)"
                      ></textarea>
                    </label>
                    <umbra-button
                      size="sm"
                      [disabled]="creatingMilestone() || !newMilestoneName().trim()"
                    >
                      {{ creatingMilestone() ? 'Creating' : 'Add milestone' }}
                    </umbra-button>
                  </form>
                </section>
                @if (teams().length) {
                  <form class="create-form" (submit)="createProjectIssue($event)">
                    <label>
                      <span>Team</span>
                      <select
                        [value]="createTeamId()"
                        (change)="setCreateTeam($any($event.target).value)"
                      >
                        @for (team of teams(); track team.id) {
                          <option [value]="team.id">{{ team.name }}</option>
                        }
                      </select>
                    </label>
                    <label>
                      <span>New project issue</span>
                      <input
                        required
                        maxlength="255"
                        [value]="newProjectIssueTitle()"
                        (input)="updateProjectIssueDraft('title', $any($event.target).value)"
                        placeholder="Issue title"
                      />
                    </label>
                    <label>
                      <span>Milestone</span>
                      <select
                        [value]="newProjectIssueMilestoneId()"
                        (change)="updateProjectIssueMilestone($any($event.target).value)"
                      >
                        <option value="">No milestone</option>
                        @for (milestone of milestones(); track milestone.id) {
                          <option [value]="milestone.id">{{ milestone.name }}</option>
                        }
                      </select>
                    </label>
                    <label class="description-field">
                      <span>Description</span>
                      <textarea
                        rows="2"
                        [value]="newProjectIssueDescription()"
                        (input)="updateProjectIssueDraft('description', $any($event.target).value)"
                      ></textarea>
                    </label>
                    <umbra-button
                      size="sm"
                      [disabled]="creatingProjectIssue() || !newProjectIssueTitle().trim()"
                    >
                      {{ creatingProjectIssue() ? 'Creating' : 'Add issue' }}
                    </umbra-button>
                  </form>
                  @if (newProjectIssueTitle() || newProjectIssueDescription()) {
                    <p class="hint">Draft saved on this device.</p>
                  }
                }
                @for (issue of projectIssues(); track issue.id) {
                  <article class="issue">
                    <button type="button" class="issue-link" (click)="openIssue(issue.url)">
                      {{ issue.identifier }}
                    </button>
                    <button type="button" class="issue-title" (click)="openIssueDetail(issue)">
                      {{ issue.title }}
                    </button>
                    <label class="status-control">
                      <span class="sr-only">Status for {{ issue.identifier }}</span>
                      <select
                        [value]="issue.state?.id ?? ''"
                        (change)="updateStatus(issue, $any($event.target).value)"
                      >
                        @for (state of statesFor(issue); track state.id) {
                          <option [value]="state.id">{{ state.name }}</option>
                        }
                      </select>
                    </label>
                  </article>
                } @empty {
                  <p class="hint">No issues are linked to this project.</p>
                }
              } @else {
                @if (createProjectOpen()) {
                  <form class="create-form" (submit)="createProject($event)">
                    <label>
                      <span>Team</span>
                      <select
                        [value]="createTeamId()"
                        (change)="setCreateTeam($any($event.target).value)"
                      >
                        @for (team of teams(); track team.id) {
                          <option [value]="team.id">{{ team.name }}</option>
                        }
                      </select>
                    </label>
                    <label>
                      <span>Project name</span>
                      <input
                        required
                        maxlength="255"
                        [value]="newProjectName()"
                        (input)="newProjectName.set($any($event.target).value)"
                      />
                    </label>
                    <label class="description-field">
                      <span>Description</span>
                      <textarea
                        rows="2"
                        [value]="newProjectDescription()"
                        (input)="newProjectDescription.set($any($event.target).value)"
                      ></textarea>
                    </label>
                    <label>
                      <span>Start date</span>
                      <input
                        type="date"
                        [value]="newProjectStartDate()"
                        (input)="newProjectStartDate.set($any($event.target).value)"
                      />
                    </label>
                    <label>
                      <span>Target date</span>
                      <input
                        type="date"
                        [value]="newProjectTargetDate()"
                        (input)="newProjectTargetDate.set($any($event.target).value)"
                      />
                    </label>
                    <umbra-button
                      size="sm"
                      [disabled]="creatingProject() || !newProjectName().trim()"
                    >
                      {{ creatingProject() ? 'Creating' : 'Create project' }}
                    </umbra-button>
                  </form>
                }
                @for (project of projects(); track project.id) {
                  <article class="resource-row">
                    <div>
                      <h3>{{ project.name }}</h3>
                      <p>{{ project.description || 'No description' }}</p>
                      <span class="muted">{{
                        project.targetDate ? 'Target ' + project.targetDate : 'No target date'
                      }}</span>
                      <span class="muted">{{ project.status?.name || 'No status' }}</span>
                      @if (project.lead) {
                        <span class="muted">Lead {{ project.lead.name }}</span>
                      }
                    </div>
                    <umbra-button size="sm" variant="outline" (click)="openProject(project)">
                      View project
                    </umbra-button>
                  </article>
                } @empty {
                  <p class="hint">No projects found in this workspace.</p>
                }
              }
            </section>
          } @else if (section() === 'cycles') {
            <section class="issues" aria-label="Linear cycles">
              @for (team of teams(); track team.id) {
                <h2 class="group-title">{{ team.name }}</h2>
                @for (cycle of cyclesFor(team.id); track cycle.id) {
                  <article class="resource-row">
                    <div>
                      <h3>{{ cycle.name }}</h3>
                      <p>{{ cycle.startsAt || 'Open' }} – {{ cycle.endsAt || 'Open' }}</p>
                    </div>
                    <span class="muted">{{
                      cycle.isActive ? 'Current' : 'Cycle ' + cycle.number
                    }}</span>
                  </article>
                } @empty {
                  <p class="hint">No cycles are available for this team.</p>
                }
              }
            </section>
          } @else {
            <section class="issues" aria-label="Linear roadmap initiatives">
              <form class="create-form" (submit)="createInitiative($event)">
                <label>
                  <span>Initiative name</span>
                  <input
                    required
                    maxlength="255"
                    [value]="newInitiativeName()"
                    (input)="newInitiativeName.set($any($event.target).value)"
                  />
                </label>
                <label>
                  <span>Target date</span>
                  <input
                    type="date"
                    [value]="newInitiativeTargetDate()"
                    (input)="newInitiativeTargetDate.set($any($event.target).value)"
                  />
                </label>
                <label class="description-field">
                  <span>Description</span>
                  <textarea
                    rows="2"
                    [value]="newInitiativeDescription()"
                    (input)="newInitiativeDescription.set($any($event.target).value)"
                  ></textarea>
                </label>
                <umbra-button
                  size="sm"
                  [disabled]="savingInitiative() || !newInitiativeName().trim()"
                >
                  {{ savingInitiative() ? 'Creating' : 'Create initiative' }}
                </umbra-button>
              </form>
              @for (initiative of initiatives(); track initiative.id) {
                <article class="resource-row initiative-row">
                  <div>
                    <h3>{{ initiative.name }}</h3>
                    <p>{{ initiative.description || 'No description' }}</p>
                    <span class="muted">{{
                      initiative.targetDate ? 'Target ' + initiative.targetDate : 'No target date'
                    }}</span>
                    @if (initiative.projects.length) {
                      <div class="initiative-projects">
                        @for (project of initiative.projects; track project.id) {
                          <button
                            type="button"
                            class="issue-link"
                            (click)="openProjectById(project.id)"
                          >
                            {{ project.name }}
                          </button>
                        }
                      </div>
                    }
                  </div>
                  <umbra-button size="sm" variant="outline" (click)="editInitiative(initiative)">
                    Edit
                  </umbra-button>
                </article>
                @if (editingInitiativeId() === initiative.id) {
                  <form class="project-edit" (submit)="saveInitiative($event, initiative)">
                    <label>
                      <span>Initiative name</span>
                      <input
                        required
                        maxlength="255"
                        [value]="editInitiativeName()"
                        (input)="editInitiativeName.set($any($event.target).value)"
                      />
                    </label>
                    <label>
                      <span>Target date</span>
                      <input
                        type="date"
                        [value]="editInitiativeTargetDate()"
                        (input)="editInitiativeTargetDate.set($any($event.target).value)"
                      />
                    </label>
                    <label>
                      <span>Description</span>
                      <textarea
                        rows="2"
                        [value]="editInitiativeDescription()"
                        (input)="editInitiativeDescription.set($any($event.target).value)"
                      ></textarea>
                    </label>
                    <umbra-button
                      size="sm"
                      [disabled]="savingInitiative() || !editInitiativeName().trim()"
                    >
                      {{ savingInitiative() ? 'Saving' : 'Save initiative' }}
                    </umbra-button>
                  </form>
                }
              } @empty {
                <p class="hint">No initiatives are available in this workspace.</p>
              }
            </section>
          }
        }
      }
    </section>
  `,
  styles: `
    :host {
      display: block;
    }
    .wrap {
      max-width: 860px;
      margin-inline: auto;
    }
    header,
    .issue-heading {
      display: flex;
      align-items: start;
      justify-content: space-between;
      gap: var(--space-5);
    }
    .header-actions {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2);
    }
    .issue-actions {
      display: flex;
      align-items: center;
      gap: var(--space-2);
    }
    .u-title,
    .hint,
    h2,
    .label {
      margin: 0;
    }
    .hint,
    .muted {
      color: var(--text-muted);
      font-size: var(--text-12);
    }
    .hint {
      margin-top: var(--space-2);
    }
    .error {
      color: var(--danger);
    }
    .empty {
      display: grid;
      justify-items: center;
      gap: var(--space-3);
      padding: var(--space-9);
      text-align: center;
    }
    .workspaces {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2);
      margin-block: var(--space-5);
    }
    .sections {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2);
      margin-block: var(--space-4);
      border-bottom: 1px solid var(--border-subtle);
    }
    .sections button {
      padding: var(--space-2) var(--space-3);
      border-bottom: 2px solid transparent;
      color: var(--text-muted);
    }
    .sections button.active {
      border-color: var(--accent);
      color: var(--text-primary);
    }
    .workspace {
      display: grid;
      gap: var(--space-1);
      padding: var(--space-3);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-md);
      text-align: start;
    }
    .workspace.active {
      border-color: var(--accent);
    }
    .sync-state {
      color: var(--text-muted);
      font-size: var(--text-11);
    }
    .resource-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-4);
      padding: var(--space-4);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-md);
    }
    .resource-row h3,
    .resource-row p {
      margin: 0;
    }
    .resource-row h3 {
      font-size: var(--text-14);
    }
    .resource-row p,
    .resource-row .muted {
      display: block;
      margin-top: var(--space-1);
      color: var(--text-muted);
      font-size: var(--text-12);
    }
    .group-title {
      margin: var(--space-3) 0 0;
      font-size: var(--text-14);
    }
    .initiative-projects {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-3);
      margin-top: var(--space-3);
    }
    .issues {
      display: grid;
      gap: var(--space-3);
    }
    .create-form {
      display: grid;
      grid-template-columns: minmax(120px, 0.7fr) minmax(180px, 1.5fr) auto;
      align-items: end;
      gap: var(--space-3);
      padding: var(--space-4);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-md);
    }
    .create-form label {
      display: grid;
      gap: var(--space-1);
      color: var(--text-muted);
      font-size: var(--text-12);
    }
    .project-edit {
      display: grid;
      gap: var(--space-3);
      padding: var(--space-4);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-md);
    }
    .project-edit label {
      display: grid;
      gap: var(--space-1);
      color: var(--text-muted);
      font-size: var(--text-12);
    }

    .issue-title {
      border: 0;
      background: transparent;
      color: inherit;
      cursor: pointer;
      font: inherit;
      text-align: start;
    }

    .issue-title:hover {
      color: var(--color-accent, #6f7cff);
    }

    .issue-detail,
    .detail-section,
    .detail-form {
      display: grid;
      gap: var(--space-3);
    }

    .issue-detail {
      border: 1px solid var(--color-border, #30323a);
      border-radius: var(--radius-md, 12px);
      padding: var(--space-4);
    }

    .issue-detail h2,
    .detail-section h3 {
      margin: 0;
    }

    .issue-fields {
      align-items: end;
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-3);
    }

    .issue-fields label,
    .detail-form label {
      display: grid;
      gap: var(--space-1);
    }

    .comment {
      border-top: 1px solid var(--color-border, #30323a);
      padding-top: var(--space-2);
    }

    .comment p {
      margin: 0 0 var(--space-1);
      white-space: pre-wrap;
    }

    .codex-policy {
      display: grid;
      gap: var(--space-3);
    }

    .codex-policy-toggle {
      align-items: center;
      display: flex;
      gap: var(--space-2);
    }
    input,
    select,
    textarea {
      min-height: 36px;
      padding-inline: var(--space-2);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-sm);
      background: var(--surface-raised);
      color: var(--text-primary);
      font: inherit;
    }
    .description-field {
      grid-column: 1 / -1;
    }
    .status-control select {
      max-width: 160px;
      color: var(--text-muted);
      font-size: var(--text-12);
    }
    .sr-only {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
      border: 0;
    }
    h2 {
      font-size: var(--text-15);
    }
    .issue {
      display: grid;
      grid-template-columns: 74px minmax(0, 1fr) auto;
      gap: var(--space-3);
      padding-block: var(--space-3);
      border-bottom: 1px solid var(--border-subtle);
    }
    .issue-link {
      justify-self: start;
      color: var(--accent);
      text-align: start;
    }
    @media (max-width: 600px) {
      .issue {
        grid-template-columns: 1fr auto;
      }
      .create-form {
        grid-template-columns: 1fr;
      }
      .issue span:nth-child(2) {
        grid-row: 2;
        grid-column: 1 / -1;
      }
    }
  `,
})
export class Linear {
  private readonly tauri = inject(TauriBridge);
  protected readonly nexus = inject(NexusAccount);
  private readonly destroyRef = inject(DestroyRef);
  protected readonly canUseCodex = this.tauri.available && currentSurface() === 'main';

  protected readonly connections = signal<readonly LinearConnection[]>([]);
  protected readonly selected = signal<LinearConnection | null>(null);
  protected readonly issues = signal<readonly LinearIssue[]>([]);
  protected readonly issueDetail = signal<LinearIssueDetail | null>(null);
  protected readonly codexContext = signal<LinearCodexContext | null>(null);
  protected readonly codexRequest = signal<{
    readonly issue: LinearIssue;
    readonly continueThread: boolean;
  } | null>(null);
  protected readonly codexWorkspaces = signal<readonly WorkspaceSummary[]>([]);
  protected readonly selectedCodexWorkspacePath = signal('');
  protected readonly selectedCodexProjectRepo = signal('');
  protected readonly projectIssues = signal<readonly LinearIssue[]>([]);
  protected readonly milestones = signal<readonly LinearMilestone[]>([]);
  protected readonly projects = signal<readonly LinearProject[]>([]);
  protected readonly projectStatuses = signal<readonly LinearProjectStatus[]>([]);
  protected readonly initiatives = signal<readonly LinearInitiative[]>([]);
  protected readonly newInitiativeName = signal('');
  protected readonly newInitiativeDescription = signal('');
  protected readonly newInitiativeTargetDate = signal('');
  protected readonly editingInitiativeId = signal<string | null>(null);
  protected readonly editInitiativeName = signal('');
  protected readonly editInitiativeDescription = signal('');
  protected readonly editInitiativeTargetDate = signal('');
  protected readonly savingInitiative = signal(false);
  protected readonly cycles = signal<Readonly<Record<string, readonly LinearCycle[]>>>({});
  protected readonly selectedProject = signal<LinearProject | null>(null);
  protected readonly createProjectOpen = signal(false);
  protected readonly newProjectName = signal('');
  protected readonly newProjectDescription = signal('');
  protected readonly newProjectStartDate = signal('');
  protected readonly newProjectTargetDate = signal('');
  protected readonly newProjectStatusId = signal('');
  protected readonly newProjectLeadId = signal('');
  protected readonly editProjectName = signal('');
  protected readonly editProjectDescription = signal('');
  protected readonly editProjectStartDate = signal('');
  protected readonly editProjectTargetDate = signal('');
  protected readonly editProjectStatusId = signal('');
  protected readonly editProjectLeadId = signal('');
  protected readonly newMilestoneName = signal('');
  protected readonly newMilestoneDescription = signal('');
  protected readonly newMilestoneDate = signal('');
  protected readonly newProjectIssueTitle = signal('');
  protected readonly newProjectIssueDescription = signal('');
  protected readonly newProjectIssueMilestoneId = signal('');
  protected readonly newSubIssueTitle = signal('');
  protected readonly newComment = signal('');
  protected readonly editingMilestoneId = signal<string | null>(null);
  protected readonly editMilestoneName = signal('');
  protected readonly editMilestoneDescription = signal('');
  protected readonly editMilestoneDate = signal('');
  protected readonly section = signal<'work' | 'projects' | 'cycles' | 'roadmap'>('work');
  protected readonly teams = signal<readonly LinearTeam[]>([]);
  protected readonly users = signal<readonly LinearPerson[]>([]);
  protected readonly labels = signal<readonly LinearLabel[]>([]);
  protected readonly workflowStates = signal<
    Readonly<Record<string, readonly LinearWorkflowState[]>>
  >({});
  protected readonly createTeamId = signal('');
  protected readonly newTitle = signal('');
  protected readonly newDescription = signal('');
  protected readonly hasNextPage = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly pending = signal(false);
  protected readonly syncing = signal(false);
  protected readonly oauthConfigured = signal(false);
  protected readonly loading = signal(false);
  protected readonly creating = signal(false);
  protected readonly creatingProject = signal(false);
  protected readonly savingProject = signal(false);
  protected readonly creatingMilestone = signal(false);
  protected readonly savingMilestone = signal(false);
  protected readonly creatingProjectIssue = signal(false);
  protected readonly creatingSubIssue = signal(false);
  protected readonly sendingComment = signal(false);
  protected readonly codexPending = signal(false);
  private nextCursor: string | null = null;

  protected pageTitle(): string {
    return {
      work: 'My work',
      projects: 'Projects',
      cycles: 'Cycles',
      roadmap: 'Roadmap',
    }[this.section()];
  }

  protected pageDescription(): string {
    return {
      work: 'Assigned Linear issues across your connected workspaces.',
      projects: 'Projects and their issues in your connected workspace.',
      cycles: 'Team planning cycles and current work periods.',
      roadmap: 'Initiatives and the projects connected to them.',
    }[this.section()];
  }

  constructor() {
    void this.tauri
      .linearOauthConfigured()
      .then((configured) => this.oauthConfigured.set(configured));
    void this.refreshConnections();
    void this.tauri
      .onLinearAuth((event) => {
        this.pending.set(false);
        if (!event.connected || !event.connection) {
          this.error.set(event.error ?? 'Linear could not connect.');
          return;
        }
        this.error.set(event.error);
        void this.refreshConnections(event.connection.organizationId);
      })
      .then((unlisten) => this.destroyRef.onDestroy(unlisten));
  }

  protected async connect(): Promise<void> {
    this.error.set(null);
    this.pending.set(true);
    try {
      await this.tauri.linearConnectStart();
    } catch (error) {
      this.pending.set(false);
      this.error.set(error instanceof Error ? error.message : String(error));
    }
  }

  protected async syncSelected(): Promise<void> {
    const connection = this.selected();
    if (!connection || this.syncing()) return;
    this.syncing.set(true);
    this.error.set(null);
    try {
      const synced = await this.tauri.linearSyncConnection(connection.organizationId);
      this.connections.update((items) =>
        items.map((item) => (item.organizationId === synced.organizationId ? synced : item)),
      );
      this.selected.set(synced);
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.syncing.set(false);
    }
  }

  protected select(connection: LinearConnection): void {
    this.selected.set(connection);
    this.restoreIssueDraft(connection);
    this.issues.set([]);
    this.issueDetail.set(null);
    this.codexContext.set(null);
    this.nextCursor = null;
    void this.loadTeams(connection);
    void this.loadIssues();
    void this.loadSection(connection);
  }

  protected statesFor(issue: LinearIssue): readonly LinearWorkflowState[] {
    return this.workflowStates()[issue.team.id] ?? [];
  }

  protected async openIssueDetail(issue: LinearIssue): Promise<void> {
    const connection = this.selected();
    if (!connection) return;
    this.issueDetail.set(null);
    this.codexRequest.set(null);
    this.error.set(null);
    try {
      const detail = await this.tauri.linearIssueDetail(connection.organizationId, issue.id);
      const teamCycles = await this.tauri.linearCycles(
        connection.organizationId,
        detail.issue.team.id,
      );
      this.cycles.update((items) => ({ ...items, [detail.issue.team.id]: teamCycles }));
      this.issueDetail.set(detail);
      this.codexContext.set(
        await this.tauri.linearCodexContext(connection.organizationId, issue.id),
      );
      if (this.canUseCodex && detail.issue.project && this.isCodexAllowed(detail.issue)) {
        await this.loadCodexWorkspaces(this.codexProjectRepo(detail.issue.project.id));
      }
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
    }
  }

  protected isCodexAllowed(issue: LinearIssue): boolean {
    return Boolean(issue.project && this.isCodexProjectAllowed(issue.project.id));
  }

  protected isCodexProjectAllowed(projectId: string): boolean {
    return (
      this.codexContext()?.allowedProjects.find((policy) => policy.projectId === projectId)
        ?.allowed ?? false
    );
  }

  protected codexProjectRepo(projectId: string): string {
    return (
      this.codexContext()?.allowedProjects.find((policy) => policy.projectId === projectId)
        ?.workspaceRepo ?? ''
    );
  }

  protected localCodexLink(): LinearCodexLink | null {
    const context = this.codexContext();
    return context?.links.find((link) => link.deviceId === context.deviceId) ?? null;
  }

  protected remoteCodexLinks(): readonly LinearCodexLink[] {
    const context = this.codexContext();
    return context?.links.filter((link) => link.deviceId !== context.deviceId) ?? [];
  }

  protected selectCodexWorkspace(path: string): void {
    this.selectedCodexWorkspacePath.set(path);
  }

  protected selectedCodexWorkspace(): WorkspaceSummary | null {
    return (
      this.codexWorkspaces().find(
        (workspace) => workspace.path === this.selectedCodexWorkspacePath(),
      ) ?? null
    );
  }

  protected requestCodex(issue: LinearIssue, continueThread: boolean): void {
    this.codexRequest.set({ issue, continueThread });
  }

  protected async confirmCodexRequest(): Promise<void> {
    const request = this.codexRequest();
    if (!request || this.codexPending()) return;
    this.codexRequest.set(null);
    await this.runIssueInCodex(request.issue, request.continueThread);
  }

  protected async setCodexProjectAllowed(projectId: string, allowed: boolean): Promise<void> {
    const connection = this.selected();
    if (!connection) return;
    this.error.set(null);
    try {
      await this.tauri.linearSetCodexProjectAllowed(
        connection.organizationId,
        projectId,
        allowed,
        this.selectedCodexProjectRepo() || null,
      );
      this.codexContext.set(await this.tauri.linearCodexContext(connection.organizationId));
      if (allowed && this.canUseCodex) await this.loadCodexWorkspaces();
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
      try {
        this.codexContext.set(await this.tauri.linearCodexContext(connection.organizationId));
      } catch {
        // Keep the last known policy if Nexus is unavailable.
      }
    }
  }

  protected async setCodexProjectRepo(projectId: string, repo: string): Promise<void> {
    const allowed = Boolean(repo) && this.isCodexProjectAllowed(projectId);
    const connection = this.selected();
    if (!connection) return;
    this.selectedCodexProjectRepo.set(repo);
    this.error.set(null);
    try {
      await this.tauri.linearSetCodexProjectAllowed(
        connection.organizationId,
        projectId,
        allowed,
        repo || null,
      );
      this.codexContext.set(await this.tauri.linearCodexContext(connection.organizationId));
      await this.loadCodexWorkspaces(repo);
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
    }
  }

  protected async runIssueInCodex(issue: LinearIssue, continueThread: boolean): Promise<void> {
    const connection = this.selected();
    const projectId = issue.project?.id;
    const workspace = this.codexWorkspaces().find(
      (entry) => entry.path === this.selectedCodexWorkspacePath(),
    );
    const existingLink = this.localCodexLink();
    if (!connection || !projectId || !this.isCodexAllowed(issue)) {
      this.error.set('Enable Codex for this issue’s Linear project first.');
      return;
    }
    if (!workspace?.githubRepo) {
      this.error.set('Choose a Relay-discovered workspace linked to a GitHub repository.');
      return;
    }
    if (workspace.githubRepo !== this.codexProjectRepo(projectId)) {
      this.error.set('Choose the repository linked to this Linear project.');
      return;
    }
    if (continueThread && !existingLink) {
      this.error.set('This device has no Codex thread linked to the issue.');
      return;
    }
    if (continueThread && existingLink?.workspaceRepo !== workspace.githubRepo) {
      this.error.set('Choose the workspace linked to this Codex thread.');
      return;
    }

    this.codexPending.set(true);
    this.error.set(null);
    try {
      const inProgress = this.statesFor(issue).find(
        (state) => /in progress/i.test(state.name) || state.kind === 'started',
      );
      if (inProgress && inProgress.id !== issue.state?.id) {
        await this.saveIssueUpdate(issue, { stateId: inProgress.id });
      }
      const prompt = [
        `Work on Linear issue ${issue.identifier}: ${issue.title}`,
        issue.description ? `\nIssue description:\n${issue.description}` : '',
        `\nLinear issue: ${issue.url}`,
        '\nUse the selected repository and follow its existing conventions. Implement the issue, run relevant validation, and report what changed, which checks passed or failed, and any commit or pull request links. Do not mark the Linear issue done; Relay will move it to review and post your final report.',
      ].join('');
      const run = await this.tauri.codexSend(
        prompt,
        workspace.path,
        continueThread ? (existingLink?.threadId ?? null) : null,
      );

      let syncError: string | null = null;
      try {
        await this.tauri.linearSaveCodexLink(
          connection.organizationId,
          issue.id,
          workspace.githubRepo,
          workspace.name,
          run.threadId,
        );
        this.codexContext.set(
          await this.tauri.linearCodexContext(connection.organizationId, issue.id),
        );
      } catch (error) {
        syncError = error instanceof Error ? error.message : String(error);
        try {
          this.codexContext.set(
            await this.tauri.linearCodexContext(connection.organizationId, issue.id),
          );
        } catch {
          // The local link may still be available even when Nexus is offline.
        }
      }

      const review = this.statesFor(issue).find((state) => /review/i.test(state.name));
      if (review) await this.saveIssueUpdate(issue, { stateId: review.id });
      const comment = await this.tauri.linearCreateComment(
        connection.organizationId,
        issue.id,
        `Codex result — ${workspace.name}\n\n${run.response}`,
      );
      this.issueDetail.update((detail) =>
        detail?.issue.id === issue.id
          ? { ...detail, comments: [...detail.comments, comment] }
          : detail,
      );
      if (syncError) {
        this.error.set(
          `Codex finished, but the issue/thread link could not sync through Nexus: ${syncError}`,
        );
      }
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.codexPending.set(false);
    }
  }

  private async loadCodexWorkspaces(requiredRepo = ''): Promise<void> {
    try {
      const workspaces = await this.tauri.scanWorkspaces();
      const eligible = workspaces.filter((workspace) => workspace.githubRepo);
      this.codexWorkspaces.set(eligible);
      const linkedRepo = this.localCodexLink()?.workspaceRepo ?? requiredRepo;
      const selected = eligible.find((workspace) => workspace.githubRepo === linkedRepo);
      if (selected) this.selectedCodexWorkspacePath.set(selected.path);
      else if (
        !eligible.some((workspace) => workspace.path === this.selectedCodexWorkspacePath())
      ) {
        this.selectedCodexWorkspacePath.set(eligible[0]?.path ?? '');
      }
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
    }
  }

  private async loadCodexPolicy(): Promise<void> {
    const connection = this.selected();
    if (!connection) return;
    try {
      this.codexContext.set(await this.tauri.linearCodexContext(connection.organizationId));
      const projectId = this.selectedProject()?.id;
      if (projectId) {
        this.selectedCodexProjectRepo.set(this.codexProjectRepo(projectId));
        await this.loadCodexWorkspaces(this.selectedCodexProjectRepo());
      }
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
    }
  }

  protected closeIssueDetail(): void {
    this.issueDetail.set(null);
    this.codexContext.set(null);
    this.newComment.set('');
    this.newSubIssueTitle.set('');
  }

  protected async createComment(event: Event, issue: LinearIssue): Promise<void> {
    event.preventDefault();
    const connection = this.selected();
    const body = this.newComment().trim();
    if (!connection || !body || this.sendingComment()) return;
    this.sendingComment.set(true);
    this.error.set(null);
    try {
      const comment = await this.tauri.linearCreateComment(
        connection.organizationId,
        issue.id,
        body,
      );
      this.issueDetail.update((detail) =>
        detail?.issue.id === issue.id
          ? { ...detail, comments: [...detail.comments, comment] }
          : detail,
      );
      this.newComment.set('');
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.sendingComment.set(false);
    }
  }

  protected async createSubIssue(event: Event, parent: LinearIssue): Promise<void> {
    event.preventDefault();
    const connection = this.selected();
    const title = this.newSubIssueTitle().trim();
    if (!connection || !title || this.creatingSubIssue()) return;
    this.creatingSubIssue.set(true);
    this.error.set(null);
    try {
      const child = await this.tauri.linearCreateIssue(
        connection.organizationId,
        parent.team.id,
        title,
        '',
        parent.project?.id ?? null,
        null,
        parent.id,
      );
      this.issueDetail.update((detail) =>
        detail?.issue.id === parent.id
          ? { ...detail, children: [...detail.children, child] }
          : detail,
      );
      this.newSubIssueTitle.set('');
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.creatingSubIssue.set(false);
    }
  }

  protected setCreateTeam(teamId: string): void {
    this.createTeamId.set(teamId);
    this.saveIssueDraft();
    this.saveProjectIssueDraft();
  }

  protected updateIssueDraft(field: 'title' | 'description', value: string): void {
    if (field === 'title') this.newTitle.set(value);
    else this.newDescription.set(value);
    this.saveIssueDraft();
  }

  private issueDraftKey(organizationId: string): string {
    return `relay.linear.issueDraft.${organizationId}`;
  }

  private projectIssueDraftKey(organizationId: string, projectId: string): string {
    return `relay.linear.projectIssueDraft.${organizationId}.${projectId}`;
  }

  private readIssueDraft(key: string): Partial<LinearIssueDraft> | null {
    try {
      const saved = localStorage.getItem(key);
      return saved ? (JSON.parse(saved) as Partial<LinearIssueDraft>) : null;
    } catch {
      return null;
    }
  }

  private writeIssueDraft(key: string, draft: LinearIssueDraft | null): void {
    try {
      if (draft) localStorage.setItem(key, JSON.stringify(draft));
      else localStorage.removeItem(key);
    } catch {
      // Keep the composer usable if local persistence is unavailable.
    }
  }

  private saveIssueDraft(): void {
    const connection = this.selected();
    if (!connection) return;
    this.writeIssueDraft(this.issueDraftKey(connection.organizationId), {
      teamId: this.createTeamId(),
      title: this.newTitle(),
      description: this.newDescription(),
    });
  }

  private restoreIssueDraft(connection: LinearConnection): void {
    const draft = this.readIssueDraft(this.issueDraftKey(connection.organizationId));
    this.newTitle.set(typeof draft?.title === 'string' ? draft.title : '');
    this.newDescription.set(typeof draft?.description === 'string' ? draft.description : '');
    if (typeof draft?.teamId === 'string') this.createTeamId.set(draft.teamId);
  }

  protected updateProjectIssueDraft(field: 'title' | 'description', value: string): void {
    if (field === 'title') this.newProjectIssueTitle.set(value);
    else this.newProjectIssueDescription.set(value);
    this.saveProjectIssueDraft();
  }

  protected updateProjectIssueMilestone(milestoneId: string): void {
    this.newProjectIssueMilestoneId.set(milestoneId);
    this.saveProjectIssueDraft();
  }

  private saveProjectIssueDraft(): void {
    const connection = this.selected();
    const project = this.selectedProject();
    if (!connection || !project) return;
    this.writeIssueDraft(this.projectIssueDraftKey(connection.organizationId, project.id), {
      teamId: this.createTeamId(),
      title: this.newProjectIssueTitle(),
      description: this.newProjectIssueDescription(),
      milestoneId: this.newProjectIssueMilestoneId(),
    });
  }

  private restoreProjectIssueDraft(connection: LinearConnection, projectId: string): void {
    const draft = this.readIssueDraft(
      this.projectIssueDraftKey(connection.organizationId, projectId),
    );
    this.newProjectIssueTitle.set(typeof draft?.title === 'string' ? draft.title : '');
    this.newProjectIssueDescription.set(
      typeof draft?.description === 'string' ? draft.description : '',
    );
    this.newProjectIssueMilestoneId.set(
      typeof draft?.milestoneId === 'string' ? draft.milestoneId : '',
    );
    if (typeof draft?.teamId === 'string') this.createTeamId.set(draft.teamId);
  }

  protected setSection(section: 'work' | 'projects' | 'cycles' | 'roadmap'): void {
    this.section.set(section);
    this.selectedProject.set(null);
    const connection = this.selected();
    if (connection) void this.loadSection(connection);
  }

  protected cyclesFor(teamId: string): readonly LinearCycle[] {
    return this.cycles()[teamId] ?? [];
  }

  protected async loadProjects(): Promise<void> {
    const connection = this.selected();
    if (!connection) return;
    try {
      this.projects.set(await this.tauri.linearProjects(connection.organizationId));
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
    }
  }

  protected async createInitiative(event: Event): Promise<void> {
    event.preventDefault();
    const connection = this.selected();
    const name = this.newInitiativeName().trim();
    if (!connection || !name || this.savingInitiative()) return;
    this.savingInitiative.set(true);
    this.error.set(null);
    try {
      const initiative = await this.tauri.linearCreateInitiative(
        connection.organizationId,
        name,
        this.newInitiativeDescription().trim(),
        this.newInitiativeTargetDate(),
      );
      this.initiatives.update((items) => [...items, initiative]);
      this.newInitiativeName.set('');
      this.newInitiativeDescription.set('');
      this.newInitiativeTargetDate.set('');
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.savingInitiative.set(false);
    }
  }

  protected editInitiative(initiative: LinearInitiative): void {
    this.editingInitiativeId.set(initiative.id);
    this.editInitiativeName.set(initiative.name);
    this.editInitiativeDescription.set(initiative.description ?? '');
    this.editInitiativeTargetDate.set(initiative.targetDate ?? '');
  }

  protected async saveInitiative(event: Event, initiative: LinearInitiative): Promise<void> {
    event.preventDefault();
    const connection = this.selected();
    const name = this.editInitiativeName().trim();
    if (!connection || !name || this.savingInitiative()) return;
    this.savingInitiative.set(true);
    this.error.set(null);
    try {
      const updated = await this.tauri.linearUpdateInitiative(
        connection.organizationId,
        initiative.id,
        name,
        this.editInitiativeDescription(),
        this.editInitiativeTargetDate(),
      );
      this.initiatives.update((items) =>
        items.map((item) =>
          item.id === updated.id ? { ...updated, projects: item.projects } : item,
        ),
      );
      this.editingInitiativeId.set(null);
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.savingInitiative.set(false);
    }
  }

  protected async openProject(project: LinearProject): Promise<void> {
    this.closeIssueDetail();
    this.selectedProject.set(project);
    const connection = this.selected();
    if (connection) this.restoreProjectIssueDraft(connection, project.id);
    this.editProjectName.set(project.name);
    this.editProjectDescription.set(project.description ?? '');
    this.editProjectStartDate.set(project.startDate ?? '');
    this.editProjectTargetDate.set(project.targetDate ?? '');
    this.editProjectStatusId.set(project.status?.id ?? '');
    this.editProjectLeadId.set(project.lead?.id ?? '');
    await Promise.all([
      this.loadProjectIssues(project.id),
      this.loadMilestones(project.id),
      this.canUseCodex ? this.loadCodexPolicy() : Promise.resolve(),
    ]);
  }

  protected async createMilestone(event: Event): Promise<void> {
    event.preventDefault();
    const connection = this.selected();
    const project = this.selectedProject();
    const name = this.newMilestoneName().trim();
    if (!connection || !project || !name || this.creatingMilestone()) return;
    this.creatingMilestone.set(true);
    this.error.set(null);
    try {
      const milestone = await this.tauri.linearCreateMilestone(
        connection.organizationId,
        project.id,
        name,
        this.newMilestoneDescription().trim(),
        this.newMilestoneDate(),
      );
      this.milestones.update((items) => [...items, milestone]);
      this.newMilestoneName.set('');
      this.newMilestoneDescription.set('');
      this.newMilestoneDate.set('');
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.creatingMilestone.set(false);
    }
  }

  protected editMilestone(milestone: LinearMilestone): void {
    this.editingMilestoneId.set(milestone.id);
    this.editMilestoneName.set(milestone.name);
    this.editMilestoneDescription.set(milestone.description ?? '');
    this.editMilestoneDate.set(milestone.targetDate ?? '');
  }

  protected async saveMilestone(event: Event, milestone: LinearMilestone): Promise<void> {
    event.preventDefault();
    const connection = this.selected();
    const name = this.editMilestoneName().trim();
    if (!connection || !name || this.savingMilestone()) return;
    this.savingMilestone.set(true);
    this.error.set(null);
    try {
      const updated = await this.tauri.linearUpdateMilestone(
        connection.organizationId,
        milestone.id,
        name,
        this.editMilestoneDescription().trim(),
        this.editMilestoneDate(),
      );
      this.milestones.update((items) =>
        items.map((item) => (item.id === updated.id ? updated : item)),
      );
      this.editingMilestoneId.set(null);
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.savingMilestone.set(false);
    }
  }

  protected async createProject(event: Event): Promise<void> {
    event.preventDefault();
    const connection = this.selected();
    const name = this.newProjectName().trim();
    if (!connection || !this.createTeamId() || !name || this.creatingProject()) return;
    this.creatingProject.set(true);
    this.error.set(null);
    try {
      const project = await this.tauri.linearCreateProject(
        connection.organizationId,
        this.createTeamId(),
        name,
        this.newProjectDescription().trim(),
        this.newProjectStartDate(),
        this.newProjectTargetDate(),
        this.newProjectStatusId(),
        this.newProjectLeadId(),
      );
      this.newProjectName.set('');
      this.newProjectDescription.set('');
      this.newProjectStartDate.set('');
      this.newProjectTargetDate.set('');
      this.newProjectStatusId.set('');
      this.newProjectLeadId.set('');
      this.createProjectOpen.set(false);
      this.projects.update((projects) => [project, ...projects]);
      await this.openProject(project);
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.creatingProject.set(false);
    }
  }

  protected async saveProject(event: Event): Promise<void> {
    event.preventDefault();
    const connection = this.selected();
    const project = this.selectedProject();
    const name = this.editProjectName().trim();
    if (!connection || !project || !name || this.savingProject()) return;
    this.savingProject.set(true);
    this.error.set(null);
    try {
      const updated = await this.tauri.linearUpdateProject(
        connection.organizationId,
        project.id,
        name,
        this.editProjectDescription(),
        this.editProjectStartDate(),
        this.editProjectTargetDate(),
        this.editProjectStatusId(),
        this.editProjectLeadId(),
        !this.editProjectLeadId(),
      );
      this.selectedProject.set(updated);
      this.projects.update((projects) =>
        projects.map((entry) => (entry.id === updated.id ? updated : entry)),
      );
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.savingProject.set(false);
    }
  }

  protected async openProjectById(projectId: string): Promise<void> {
    let project = this.projects().find((entry) => entry.id === projectId);
    if (!project) {
      await this.loadProjects();
      project = this.projects().find((entry) => entry.id === projectId);
    }
    if (project) {
      this.section.set('projects');
      await this.openProject(project);
    }
  }

  private async loadSection(connection: LinearConnection): Promise<void> {
    if (this.section() === 'projects') await this.loadProjects();
    if (this.section() === 'roadmap') {
      try {
        this.initiatives.set(await this.tauri.linearInitiatives(connection.organizationId));
      } catch (error) {
        this.error.set(error instanceof Error ? error.message : String(error));
      }
    }
    if (this.section() === 'cycles') {
      try {
        const teams = await this.tauri.linearTeams(connection.organizationId);
        this.teams.set(teams);
        const entries = await Promise.all(
          teams.map(
            async (team) =>
              [team.id, await this.tauri.linearCycles(connection.organizationId, team.id)] as const,
          ),
        );
        this.cycles.set(Object.fromEntries(entries));
      } catch (error) {
        this.error.set(error instanceof Error ? error.message : String(error));
      }
    }
  }

  private async loadProjectIssues(projectId: string): Promise<void> {
    const connection = this.selected();
    if (!connection) return;
    try {
      const page = await this.tauri.linearProjectIssues(connection.organizationId, projectId);
      this.projectIssues.set(page.issues);
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
    }
  }

  private async loadMilestones(projectId: string): Promise<void> {
    const connection = this.selected();
    if (!connection) return;
    try {
      this.milestones.set(
        await this.tauri.linearProjectMilestones(connection.organizationId, projectId),
      );
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
    }
  }

  protected async createIssue(event: Event): Promise<void> {
    event.preventDefault();
    const connection = this.selected();
    const title = this.newTitle().trim();
    if (!connection || !this.createTeamId() || !title || this.creating()) return;
    this.creating.set(true);
    this.error.set(null);
    try {
      const created = await this.tauri.linearCreateIssue(
        connection.organizationId,
        this.createTeamId(),
        title,
        this.newDescription().trim(),
      );
      this.newTitle.set('');
      this.newDescription.set('');
      this.writeIssueDraft(this.issueDraftKey(connection.organizationId), null);
      this.issues.update((issues) => [created, ...issues]);
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.creating.set(false);
    }
  }

  protected async createProjectIssue(event: Event): Promise<void> {
    event.preventDefault();
    const connection = this.selected();
    const project = this.selectedProject();
    const title = this.newProjectIssueTitle().trim();
    if (!connection || !project || !this.createTeamId() || !title || this.creatingProjectIssue()) {
      return;
    }
    this.creatingProjectIssue.set(true);
    this.error.set(null);
    try {
      const issue = await this.tauri.linearCreateIssue(
        connection.organizationId,
        this.createTeamId(),
        title,
        this.newProjectIssueDescription().trim(),
        project.id,
        this.newProjectIssueMilestoneId() || null,
      );
      this.projectIssues.update((issues) => [issue, ...issues]);
      this.newProjectIssueTitle.set('');
      this.newProjectIssueDescription.set('');
      this.newProjectIssueMilestoneId.set('');
      this.writeIssueDraft(this.projectIssueDraftKey(connection.organizationId, project.id), null);
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.creatingProjectIssue.set(false);
    }
  }

  protected async disconnectSelected(): Promise<void> {
    const connection = this.selected();
    if (!connection) return;
    try {
      await this.tauri.linearDisconnect(connection.organizationId);
      const connections = this.connections().filter(
        (entry) => entry.organizationId !== connection.organizationId,
      );
      this.connections.set(connections);
      this.selected.set(connections[0] ?? null);
      this.issues.set([]);
      if (connections[0]) this.select(connections[0]);
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
      await this.refreshConnections();
    }
  }

  protected async updateStatus(issue: LinearIssue, stateId: string): Promise<void> {
    if (!stateId || stateId === issue.state?.id) return;
    await this.saveIssueUpdate(issue, { stateId });
  }

  protected async updatePriority(issue: LinearIssue, priority: number): Promise<void> {
    if (priority === issue.priority) return;
    await this.saveIssueUpdate(issue, { priority });
  }

  protected async updateAssignee(issue: LinearIssue, assigneeId: string): Promise<void> {
    if (assigneeId === (issue.assignee?.id ?? '')) return;
    await this.saveIssueUpdate(issue, assigneeId ? { assigneeId } : { clearAssignee: true });
  }

  protected async updateCycle(issue: LinearIssue, cycleId: string): Promise<void> {
    if (cycleId === (issue.cycle?.id ?? '')) return;
    await this.saveIssueUpdate(issue, cycleId ? { cycleId } : { clearCycle: true });
  }

  protected labelsFor(teamId: string): readonly LinearLabel[] {
    return this.labels().filter((label) => !label.team?.id || label.team.id === teamId);
  }

  protected async updateLabels(issue: LinearIssue, event: Event): Promise<void> {
    const select = event.target as HTMLSelectElement;
    await this.saveIssueUpdate(issue, {
      labelIds: Array.from(select.selectedOptions, (option) => option.value),
    });
  }

  private async saveIssueUpdate(
    issue: LinearIssue,
    update: {
      stateId?: string;
      assigneeId?: string;
      clearAssignee?: boolean;
      cycleId?: string;
      clearCycle?: boolean;
      priority?: number;
      labelIds?: readonly string[];
    },
  ): Promise<void> {
    const connection = this.selected();
    if (!connection) return;
    try {
      const updated = await this.tauri.linearUpdateIssue(
        connection.organizationId,
        issue.id,
        update,
      );
      this.issues.update((items) =>
        items.map((entry) => (entry.id === issue.id ? updated : entry)),
      );
      this.projectIssues.update((items) =>
        items.map((entry) => (entry.id === issue.id ? updated : entry)),
      );
      this.issueDetail.update((detail) =>
        detail?.issue.id === issue.id ? { ...detail, issue: updated } : detail,
      );
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
    }
  }

  protected async loadIssues(): Promise<void> {
    const connection = this.selected();
    if (!connection || this.loading()) return;
    this.loading.set(true);
    this.error.set(null);
    try {
      const page = await this.tauri.linearMyIssues(connection.organizationId);
      this.issues.set(page.issues);
      this.nextCursor = page.endCursor;
      this.hasNextPage.set(page.hasNextPage);
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.loading.set(false);
    }
  }

  protected async loadMore(): Promise<void> {
    const connection = this.selected();
    if (!connection || !this.nextCursor || this.loading()) return;
    this.loading.set(true);
    try {
      const page = await this.tauri.linearMyIssues(connection.organizationId, this.nextCursor);
      this.issues.update((issues) => [...issues, ...page.issues]);
      this.nextCursor = page.endCursor;
      this.hasNextPage.set(page.hasNextPage);
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.loading.set(false);
    }
  }

  protected async openIssue(url: string): Promise<void> {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' || parsed.hostname !== 'linear.app') {
        throw new Error('Linear returned an invalid issue link.');
      }
      await this.tauri.openUrl(parsed.toString());
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
    }
  }

  private async refreshConnections(selectOrganizationId?: string): Promise<void> {
    try {
      const connections = await this.tauri.linearStatus();
      this.connections.set(connections);
      const selected =
        connections.find((connection) => connection.organizationId === selectOrganizationId) ??
        connections.find(
          (connection) => connection.organizationId === this.selected()?.organizationId,
        ) ??
        connections[0] ??
        null;
      this.selected.set(selected);
      if (selected) {
        this.select(selected);
      }
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
    }
  }

  private async loadTeams(connection: LinearConnection): Promise<void> {
    try {
      const teams = await this.tauri.linearTeams(connection.organizationId);
      this.teams.set(teams);
      const [users, labels, statuses] = await Promise.all([
        this.tauri.linearUsers(connection.organizationId),
        this.tauri.linearIssueLabels(connection.organizationId),
        this.tauri.linearProjectStatuses(connection.organizationId),
      ]);
      this.users.set(users);
      this.labels.set(labels);
      this.projectStatuses.set(statuses);
      const teamId = teams.some((team) => team.id === this.createTeamId())
        ? this.createTeamId()
        : (teams[0]?.id ?? '');
      this.createTeamId.set(teamId);
      const entries = await Promise.all(
        teams.map(
          async (team) =>
            [
              team.id,
              await this.tauri.linearWorkflowStates(connection.organizationId, team.id),
            ] as const,
        ),
      );
      this.workflowStates.set(Object.fromEntries(entries));
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
    }
  }
}
