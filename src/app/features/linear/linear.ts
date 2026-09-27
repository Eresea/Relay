import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  effect,
  inject,
  signal,
} from '@angular/core';

import { NexusAccount } from '@core/nexus-account';
import { currentSurface } from '@core/surface';
import {
  type LinearCodexContext,
  type LinearCodexLink,
  type LinearComment,
  TauriBridge,
  type LinearConnection,
  type LinearCycle,
  type LinearInitiative,
  type LinearInitiativeUpdate,
  type LinearIssue,
  type LinearIssueDetail,
  type LinearIssuePage,
  type LinearIssueRelationType,
  type LinearLabel,
  type LinearMilestone,
  type LinearProject,
  type LinearProjectHealth,
  type LinearProjectStatus,
  type LinearProjectUpdate,
  type LinearPerson,
  type LinearTeam,
  type LinearWorkflowState,
  type WorkspaceSummary,
} from '@core/tauri';
import { UmbraButtonComponent } from '@umbra/components/umbra-button/umbra-button.component';
import {
  isPendingLinearIssueUpdate,
  linearEstimateOptions,
  linearCodexPrompt,
  mergeLinearIssueUpdates,
  type LinearIssueUpdate,
  type PendingLinearIssueUpdate,
} from './linear-state';
import { cycleDateInTimezone, cycleDateToIso, todayInTimezone } from './cycle-dates';

interface LinearIssueDraft {
  teamId: string;
  title: string;
  description: string;
  milestoneId?: string;
  estimate?: string;
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
            @if (selected() && pendingIssueUpdates().length) {
              <umbra-button
                size="sm"
                variant="outline"
                [disabled]="retryingIssueUpdates()"
                (click)="retryPendingIssueUpdates()"
              >
                {{ retryingIssueUpdates() ? 'Retrying changes' : 'Retry issue changes' }}
              </umbra-button>
            }
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
            <button
              type="button"
              [class.active]="section() === 'labels'"
              (click)="setSection('labels')"
            >
              Labels
            </button>
          </nav>
          @if (issueDetail(); as detail) {
            <section class="issue-detail" aria-label="Linear issue details">
              <div class="issue-heading">
                <div>
                  <p class="muted">{{ detail.issue.identifier }} · {{ detail.issue.team.name }}</p>
                  @if (editingIssueDetailsId() === detail.issue.id) {
                    <form class="project-edit" (submit)="saveIssueDetails($event, detail.issue)">
                      <label>
                        <span>Issue title</span>
                        <input
                          required
                          maxlength="255"
                          [value]="editIssueTitle()"
                          (input)="editIssueTitle.set($any($event.target).value)"
                        />
                      </label>
                      <label>
                        <span>Description</span>
                        <textarea
                          rows="4"
                          [value]="editIssueDescription()"
                          (input)="editIssueDescription.set($any($event.target).value)"
                        ></textarea>
                      </label>
                      <div class="issue-actions">
                        <umbra-button size="sm" [disabled]="savingIssueDetails()">
                          {{ savingIssueDetails() ? 'Saving' : 'Save details' }}
                        </umbra-button>
                        <umbra-button
                          size="sm"
                          variant="link"
                          type="button"
                          (click)="editingIssueDetailsId.set(null)"
                        >
                          Cancel
                        </umbra-button>
                      </div>
                    </form>
                  } @else {
                    <h2>{{ detail.issue.title }}</h2>
                    @if (detail.issue.description) {
                      <p class="issue-description">{{ detail.issue.description }}</p>
                    }
                  }
                </div>
                <div class="issue-actions">
                  @if (detail.issue.archivedAt) {
                    <span class="hint">Archived</span>
                    <umbra-button
                      size="sm"
                      variant="outline"
                      [disabled]="!!archivingIssueId()"
                      (click)="setIssueArchived(detail.issue, false)"
                    >
                      {{ archivingIssueId() === detail.issue.id ? 'Restoring' : 'Restore issue' }}
                    </umbra-button>
                  } @else if (confirmArchiveIssueDetailId() === detail.issue.id) {
                    <umbra-button
                      size="sm"
                      variant="outline"
                      [disabled]="!!archivingIssueId()"
                      (click)="setIssueArchived(detail.issue, true, true)"
                    >
                      {{ archivingIssueId() === detail.issue.id ? 'Archiving' : 'Confirm archive' }}
                    </umbra-button>
                    <umbra-button
                      size="sm"
                      variant="link"
                      (click)="confirmArchiveIssueDetailId.set(null)"
                    >
                      Cancel
                    </umbra-button>
                  } @else {
                    <umbra-button
                      size="sm"
                      variant="link"
                      (click)="confirmArchiveIssueDetailId.set(detail.issue.id)"
                    >
                      Archive issue
                    </umbra-button>
                  }
                  @if (editingIssueDetailsId() !== detail.issue.id) {
                    <umbra-button
                      size="sm"
                      variant="outline"
                      (click)="editIssueDetails(detail.issue)"
                    >
                      Edit details
                    </umbra-button>
                  }
                  <umbra-button size="sm" variant="link" (click)="closeIssueDetail()">
                    Close
                  </umbra-button>
                </div>
              </div>
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
                @if (estimateOptions(detail.issue.team.id).length) {
                  <label>
                    <span>Estimate</span>
                    <select
                      [value]="detail.issue.estimate ?? ''"
                      (change)="updateEstimate(detail.issue, $any($event.target).value)"
                    >
                      <option value="">No estimate</option>
                      @for (option of estimateOptions(detail.issue.team.id); track option.value) {
                        <option [value]="option.value">{{ option.label }}</option>
                      }
                    </select>
                  </label>
                }
                <label>
                  <span>Due date</span>
                  <input
                    type="date"
                    [value]="detail.issue.dueDate ?? ''"
                    (change)="updateDueDate(detail.issue, $any($event.target).value)"
                  />
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
                      <option [value]="cycle.id">
                        {{ cycle.name || 'Cycle ' + cycle.number }}
                      </option>
                    }
                  </select>
                </label>
                <label>
                  <span>Project</span>
                  <select
                    [value]="detail.issue.project?.id ?? ''"
                    (change)="updateProject(detail.issue, $any($event.target).value)"
                  >
                    <option value="">No project</option>
                    @for (project of projects(); track project.id) {
                      <option [value]="project.id">{{ project.name }}</option>
                    }
                  </select>
                </label>
                @if (detail.issue.project) {
                  <label>
                    <span>Milestone</span>
                    <select
                      [value]="detail.issue.projectMilestone?.id ?? ''"
                      (change)="updateIssueMilestone(detail.issue, $any($event.target).value)"
                    >
                      <option value="">No milestone</option>
                      @for (milestone of milestones(); track milestone.id) {
                        <option [value]="milestone.id">{{ milestone.name }}</option>
                      }
                    </select>
                  </label>
                }
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
                  <span class="muted">{{
                    detail.issue.cycle.name || 'Cycle ' + detail.issue.cycle.number
                  }}</span>
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
              <section class="detail-section" aria-label="Issue dependencies and links">
                <h3>Dependencies and links</h3>
                @for (relation of issueRelations(detail); track relation.id) {
                  <article class="issue">
                    <span>{{ relationLabel(relation.type, relation.inverse) }}</span>
                    <button
                      type="button"
                      class="issue-link"
                      (click)="openIssueDetail(relation.target)"
                    >
                      {{ relation.target.identifier }} · {{ relation.target.title }}
                    </button>
                    @if (confirmDeleteIssueRelationId() === relation.id) {
                      <div class="issue-actions">
                        <umbra-button
                          size="sm"
                          variant="destructive"
                          [disabled]="deletingIssueRelationId() === relation.id"
                          (click)="deleteIssueRelation(detail.issue, relation.id)"
                        >
                          {{ deletingIssueRelationId() === relation.id ? 'Removing' : 'Confirm' }}
                        </umbra-button>
                        <umbra-button
                          size="sm"
                          variant="link"
                          (click)="confirmDeleteIssueRelationId.set(null)"
                        >
                          Cancel
                        </umbra-button>
                      </div>
                    } @else {
                      <umbra-button
                        size="sm"
                        variant="link"
                        (click)="confirmDeleteIssueRelationId.set(relation.id)"
                      >
                        Remove
                      </umbra-button>
                    }
                  </article>
                }
                @if (!detail.relations.length && !detail.inverseRelations.length) {
                  <p class="hint">No linked issues.</p>
                }
                <form class="detail-form" (submit)="createIssueRelation($event, detail.issue)">
                  <label>
                    <span>Link issue by identifier</span>
                    <input
                      required
                      maxlength="32"
                      [value]="relatedIssueIdentifier()"
                      (input)="relatedIssueIdentifier.set($any($event.target).value)"
                      placeholder="ENG-123"
                    />
                  </label>
                  <label>
                    <span>Relationship</span>
                    <select
                      [value]="newIssueRelationType()"
                      (change)="newIssueRelationType.set($any($event.target).value)"
                    >
                      <option value="blocks">This issue blocks</option>
                      <option value="related">Related to</option>
                      <option value="duplicate">Duplicate of</option>
                      <option value="similar">Similar to</option>
                    </select>
                  </label>
                  <umbra-button
                    size="sm"
                    [disabled]="creatingIssueRelation() || !relatedIssueIdentifier().trim()"
                  >
                    {{ creatingIssueRelation() ? 'Linking' : 'Link issue' }}
                  </umbra-button>
                </form>
              </section>
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
                    @if (editingCommentId() === comment.id) {
                      <form class="detail-form" (submit)="saveComment($event, comment)">
                        <label>
                          <span>Edit comment</span>
                          <textarea
                            required
                            maxlength="10000"
                            rows="3"
                            [value]="editCommentBody()"
                            (input)="editCommentBody.set($any($event.target).value)"
                          ></textarea>
                        </label>
                        <div class="issue-actions">
                          <umbra-button
                            size="sm"
                            [disabled]="savingComment() || !editCommentBody().trim()"
                          >
                            {{ savingComment() ? 'Saving' : 'Save comment' }}
                          </umbra-button>
                          <umbra-button
                            size="sm"
                            variant="link"
                            type="button"
                            (click)="editingCommentId.set(null)"
                          >
                            Cancel
                          </umbra-button>
                        </div>
                      </form>
                    } @else {
                      <p>{{ comment.body }}</p>
                      <span class="muted">
                        {{ comment.user?.name ?? 'Linear integration' }} ·
                        {{ projectUpdateDate(comment.createdAt) }}
                        @if (comment.editedAt) {
                          · edited
                        }
                      </span>
                      @if (comment.user?.id === selected()?.viewerId) {
                        @if (confirmDeleteCommentId() === comment.id) {
                          <div
                            class="issue-actions"
                            role="group"
                            aria-label="Confirm comment deletion"
                          >
                            <span class="muted">Delete this comment? This cannot be undone.</span>
                            <umbra-button
                              size="sm"
                              variant="destructive"
                              type="button"
                              [disabled]="deletingCommentId() === comment.id"
                              (click)="deleteComment(comment)"
                            >
                              {{
                                deletingCommentId() === comment.id ? 'Deleting' : 'Confirm delete'
                              }}
                            </umbra-button>
                            <umbra-button
                              size="sm"
                              variant="link"
                              type="button"
                              (click)="confirmDeleteCommentId.set(null)"
                            >
                              Cancel
                            </umbra-button>
                          </div>
                        } @else {
                          <div class="issue-actions">
                            <umbra-button
                              size="sm"
                              variant="link"
                              type="button"
                              (click)="editComment(comment)"
                            >
                              Edit
                            </umbra-button>
                            <umbra-button
                              size="sm"
                              variant="link"
                              type="button"
                              (click)="confirmDeleteCommentId.set(comment.id)"
                            >
                              Delete
                            </umbra-button>
                          </div>
                        }
                      }
                    }
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
            <section class="issues" aria-label="Linear issues">
              <div class="issue-heading">
                <h2>{{ issueTeamId() ? teamName(issueTeamId()) + ' issues' : 'My work' }}</h2>
                <div class="issue-actions">
                  <label>
                    <span class="sr-only">Issue scope</span>
                    <select
                      aria-label="Issue scope"
                      [value]="issueTeamId()"
                      [disabled]="loading()"
                      (change)="setIssueTeam($any($event.target).value)"
                    >
                      <option value="">Assigned to me</option>
                      @for (team of teams(); track team.id) {
                        <option [value]="team.id">All {{ team.name }} issues</option>
                      }
                    </select>
                  </label>
                  <umbra-button
                    size="sm"
                    variant="link"
                    [disabled]="loading()"
                    (click)="loadIssues()"
                  >
                    {{ loading() ? 'Loading' : 'Refresh' }}
                  </umbra-button>
                  <umbra-button
                    size="sm"
                    variant="link"
                    [disabled]="loading()"
                    (click)="toggleArchivedIssues()"
                  >
                    {{ includeArchivedIssues() ? 'Hide archived' : 'Include archived' }}
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
                  @if (estimateOptions(createTeamId()).length) {
                    <label>
                      <span>Estimate</span>
                      <select
                        [value]="newEstimate()"
                        (change)="updateIssueDraftEstimate($any($event.target).value)"
                      >
                        <option value="">No estimate</option>
                        @for (option of estimateOptions(createTeamId()); track option.value) {
                          <option [value]="option.value">{{ option.label }}</option>
                        }
                      </select>
                    </label>
                  }
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
                @if (newTitle() || newDescription() || newEstimate()) {
                  <p class="hint">Draft saved on this device.</p>
                }
              }
              @if (issueCacheStale()) {
                <p class="hint" role="status">
                  Showing saved issues; refresh to check for updates.
                </p>
              }
              @if (issues().length === 0 && !loading()) {
                <p class="hint">
                  {{
                    issueTeamId() ? 'No issues found for this team.' : 'No assigned issues found.'
                  }}
                </p>
              }
              @for (issue of issues(); track issue.id) {
                <article class="issue">
                  <button type="button" class="issue-link" (click)="openIssue(issue.url)">
                    {{ issue.identifier }}
                  </button>
                  <button type="button" class="issue-title" (click)="openIssueDetail(issue)">
                    {{ issue.title }}
                  </button>
                  <div class="issue-actions">
                    @if (issue.archivedAt) {
                      <span class="hint">Archived</span>
                      <umbra-button
                        size="sm"
                        variant="outline"
                        [disabled]="!!archivingIssueId()"
                        (click)="setIssueArchived(issue, false)"
                      >
                        {{ archivingIssueId() === issue.id ? 'Restoring' : 'Restore' }}
                      </umbra-button>
                    } @else {
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
                      @if (confirmArchiveIssueId() === issue.id) {
                        <umbra-button
                          size="sm"
                          variant="outline"
                          [disabled]="!!archivingIssueId()"
                          (click)="setIssueArchived(issue, true)"
                        >
                          {{ archivingIssueId() === issue.id ? 'Archiving' : 'Confirm archive' }}
                        </umbra-button>
                        <umbra-button
                          size="sm"
                          variant="link"
                          type="button"
                          (click)="confirmArchiveIssueId.set(null)"
                        >
                          Cancel
                        </umbra-button>
                      } @else {
                        <umbra-button
                          size="sm"
                          variant="link"
                          (click)="confirmArchiveIssueId.set(issue.id)"
                        >
                          Archive
                        </umbra-button>
                      }
                    }
                  </div>
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
              @if (projectCacheStale()) {
                <p class="hint" role="status">
                  Showing saved projects; refresh to check for updates.
                </p>
              }
              <div class="issue-heading">
                <h2>{{ selectedProject()?.name ?? 'Projects' }}</h2>
                @if (selectedProject()) {
                  <umbra-button size="sm" variant="link" (click)="closeSelectedProject()">
                    All projects
                  </umbra-button>
                } @else {
                  <div class="issue-actions">
                    <umbra-button size="sm" variant="link" (click)="loadProjects()">
                      Refresh
                    </umbra-button>
                    <umbra-button size="sm" variant="link" (click)="toggleArchivedProjects()">
                      {{ showArchivedProjects() ? 'Hide archived' : 'Include archived' }}
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
                <div class="issue-actions">
                  @if (selectedProject()!.archivedAt) {
                    <umbra-button
                      size="sm"
                      variant="outline"
                      [disabled]="archivingProject()"
                      (click)="unarchiveSelectedProject()"
                    >
                      {{ archivingProject() ? 'Restoring' : 'Restore project' }}
                    </umbra-button>
                  } @else if (confirmArchiveProjectId() === selectedProject()!.id) {
                    <umbra-button
                      size="sm"
                      variant="outline"
                      [disabled]="archivingProject()"
                      (click)="archiveSelectedProject()"
                    >
                      {{ archivingProject() ? 'Archiving' : 'Confirm archive' }}
                    </umbra-button>
                    <umbra-button
                      size="sm"
                      variant="link"
                      type="button"
                      (click)="confirmArchiveProjectId.set(null)"
                    >
                      Cancel
                    </umbra-button>
                  } @else {
                    <umbra-button
                      size="sm"
                      variant="outline"
                      (click)="confirmArchiveProjectId.set(selectedProject()!.id)"
                    >
                      Archive project
                    </umbra-button>
                  }
                </div>
                @if (selectedProject()!.archivedAt) {
                  <p class="hint">This project is archived.</p>
                }
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
                      @if (confirmDeleteMilestoneId() === milestone.id) {
                        <div
                          class="issue-actions"
                          role="group"
                          aria-label="Confirm milestone deletion"
                        >
                          <span class="muted">Remove this milestone and its issue grouping?</span>
                          <umbra-button
                            size="sm"
                            variant="destructive"
                            type="button"
                            [disabled]="deletingMilestoneId() === milestone.id"
                            (click)="deleteMilestone(milestone)"
                          >
                            {{
                              deletingMilestoneId() === milestone.id ? 'Deleting' : 'Confirm delete'
                            }}
                          </umbra-button>
                          <umbra-button
                            size="sm"
                            variant="link"
                            type="button"
                            (click)="confirmDeleteMilestoneId.set(null)"
                          >
                            Cancel
                          </umbra-button>
                        </div>
                      } @else {
                        <umbra-button
                          size="sm"
                          variant="link"
                          type="button"
                          (click)="confirmDeleteMilestoneId.set(milestone.id)"
                        >
                          Delete
                        </umbra-button>
                      }
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
                <section class="milestones" aria-label="Project status updates">
                  <div class="issue-actions">
                    <h3>Status updates</h3>
                    <umbra-button
                      size="sm"
                      variant="link"
                      type="button"
                      (click)="toggleArchivedProjectUpdates()"
                    >
                      {{ includeArchivedProjectUpdates() ? 'Hide archived' : 'Include archived' }}
                    </umbra-button>
                  </div>
                  @for (update of projectUpdates(); track update.id) {
                    <article class="issue">
                      <strong>{{ projectHealthLabel(update.health) }}</strong>
                      <span class="muted"
                        >{{ update.user.name }} · {{ projectUpdateDate(update.createdAt) }}</span
                      >
                      <p>{{ update.body }}</p>
                      @if (update.archivedAt) {
                        <span class="muted">Archived</span>
                      }
                      @if (!selectedProject()!.archivedAt) {
                        @if (update.archivedAt) {
                          <umbra-button
                            size="sm"
                            variant="link"
                            type="button"
                            [disabled]="busyProjectUpdateId() === update.id"
                            (click)="setProjectUpdateArchived(update, false)"
                          >
                            {{ busyProjectUpdateId() === update.id ? 'Restoring' : 'Restore' }}
                          </umbra-button>
                        } @else {
                          <umbra-button
                            size="sm"
                            variant="link"
                            type="button"
                            (click)="editProjectUpdate(update)"
                          >
                            Edit update
                          </umbra-button>
                          <umbra-button
                            size="sm"
                            variant="link"
                            type="button"
                            [disabled]="busyProjectUpdateId() === update.id"
                            (click)="setProjectUpdateArchived(update, true)"
                          >
                            {{ busyProjectUpdateId() === update.id ? 'Archiving' : 'Archive' }}
                          </umbra-button>
                        }
                      }
                    </article>
                    @if (editingProjectUpdateId() === update.id) {
                      <form class="project-edit" (submit)="saveProjectUpdate($event, update)">
                        <label>
                          <span>Health</span>
                          <select
                            [value]="editProjectUpdateHealth()"
                            (change)="editProjectUpdateHealth.set($any($event.target).value)"
                          >
                            <option value="onTrack">On track</option>
                            <option value="atRisk">At risk</option>
                            <option value="offTrack">Off track</option>
                          </select>
                        </label>
                        <label>
                          <span>Update</span>
                          <textarea
                            required
                            maxlength="10000"
                            rows="3"
                            [value]="editProjectUpdateBody()"
                            (input)="editProjectUpdateBody.set($any($event.target).value)"
                          ></textarea>
                        </label>
                        <div class="issue-actions">
                          <umbra-button
                            size="sm"
                            [disabled]="savingProjectUpdate() || !editProjectUpdateBody().trim()"
                          >
                            {{ savingProjectUpdate() ? 'Saving' : 'Save update' }}
                          </umbra-button>
                          <umbra-button
                            size="sm"
                            variant="link"
                            type="button"
                            (click)="editingProjectUpdateId.set(null)"
                          >
                            Cancel
                          </umbra-button>
                        </div>
                      </form>
                    }
                  } @empty {
                    <p class="hint">No status updates yet.</p>
                  }
                  @if (!selectedProject()!.archivedAt) {
                    <form class="project-edit" (submit)="createProjectUpdate($event)">
                      <label>
                        <span>Health</span>
                        <select
                          [value]="newProjectUpdateHealth()"
                          (change)="newProjectUpdateHealth.set($any($event.target).value)"
                        >
                          <option value="onTrack">On track</option>
                          <option value="atRisk">At risk</option>
                          <option value="offTrack">Off track</option>
                        </select>
                      </label>
                      <label>
                        <span>Update</span>
                        <textarea
                          required
                          maxlength="10000"
                          rows="3"
                          [value]="newProjectUpdateBody()"
                          (input)="newProjectUpdateBody.set($any($event.target).value)"
                        ></textarea>
                      </label>
                      <umbra-button
                        size="sm"
                        [disabled]="creatingProjectUpdate() || !newProjectUpdateBody().trim()"
                      >
                        {{ creatingProjectUpdate() ? 'Posting' : 'Post update' }}
                      </umbra-button>
                    </form>
                  }
                </section>
                <div class="issue-heading">
                  <h3>Issues</h3>
                  <umbra-button
                    size="sm"
                    variant="link"
                    [disabled]="loadingProjectIssues()"
                    (click)="toggleArchivedProjectIssues()"
                  >
                    {{ includeArchivedProjectIssues() ? 'Hide archived' : 'Include archived' }}
                  </umbra-button>
                </div>
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
                    @if (estimateOptions(createTeamId()).length) {
                      <label>
                        <span>Estimate</span>
                        <select
                          [value]="newProjectIssueEstimate()"
                          (change)="updateProjectIssueEstimate($any($event.target).value)"
                        >
                          <option value="">No estimate</option>
                          @for (option of estimateOptions(createTeamId()); track option.value) {
                            <option [value]="option.value">{{ option.label }}</option>
                          }
                        </select>
                      </label>
                    }
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
                  @if (
                    newProjectIssueTitle() ||
                    newProjectIssueDescription() ||
                    newProjectIssueEstimate()
                  ) {
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
                    <div class="issue-actions">
                      @if (issue.archivedAt) {
                        <span class="hint">Archived</span>
                        <umbra-button
                          size="sm"
                          variant="outline"
                          [disabled]="!!archivingIssueId()"
                          (click)="setIssueArchived(issue, false)"
                        >
                          {{ archivingIssueId() === issue.id ? 'Restoring' : 'Restore' }}
                        </umbra-button>
                      } @else {
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
                        @if (confirmArchiveIssueId() === issue.id) {
                          <umbra-button
                            size="sm"
                            variant="outline"
                            [disabled]="!!archivingIssueId()"
                            (click)="setIssueArchived(issue, true)"
                          >
                            {{ archivingIssueId() === issue.id ? 'Archiving' : 'Confirm archive' }}
                          </umbra-button>
                          <umbra-button
                            size="sm"
                            variant="link"
                            type="button"
                            (click)="confirmArchiveIssueId.set(null)"
                          >
                            Cancel
                          </umbra-button>
                        } @else {
                          <umbra-button
                            size="sm"
                            variant="link"
                            (click)="confirmArchiveIssueId.set(issue.id)"
                          >
                            Archive
                          </umbra-button>
                        }
                      }
                    </div>
                  </article>
                } @empty {
                  <p class="hint">No issues are linked to this project.</p>
                }
                @if (projectIssuesHasNextPage()) {
                  <umbra-button
                    size="sm"
                    variant="outline"
                    [disabled]="loadingProjectIssues()"
                    (click)="loadMoreProjectIssues()"
                  >
                    {{ loadingProjectIssues() ? 'Loading' : 'Load more issues' }}
                  </umbra-button>
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
                      @if (project.archivedAt) {
                        <span class="muted">Archived</span>
                      }
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
                <div class="issue-heading">
                  <h2 class="group-title">{{ team.name }}</h2>
                  <umbra-button size="sm" variant="outline" (click)="toggleCreateCycle(team)">
                    {{ createCycleTeamId() === team.id ? 'Cancel' : 'New cycle' }}
                  </umbra-button>
                </div>
                @if (createCycleTeamId() === team.id) {
                  <form class="project-edit" (submit)="createCycle($event, team)">
                    <label>
                      <span>Cycle name <span class="muted">Optional</span></span>
                      <input
                        maxlength="255"
                        [value]="newCycleName()"
                        (input)="newCycleName.set($any($event.target).value)"
                        placeholder="Cycle name"
                      />
                    </label>
                    <label>
                      <span>Start date · {{ team.timezone || 'America/Los_Angeles' }}</span>
                      <input
                        type="date"
                        required
                        [min]="todayForTeam(team)"
                        [value]="newCycleStartDate()"
                        (input)="newCycleStartDate.set($any($event.target).value)"
                      />
                    </label>
                    <label>
                      <span>End date · {{ team.timezone || 'America/Los_Angeles' }}</span>
                      <input
                        type="date"
                        required
                        [min]="newCycleStartDate()"
                        [value]="newCycleEndDate()"
                        (input)="newCycleEndDate.set($any($event.target).value)"
                      />
                    </label>
                    <div class="issue-actions">
                      <umbra-button
                        size="sm"
                        [disabled]="creatingCycle() || !newCycleStartDate() || !newCycleEndDate()"
                      >
                        {{ creatingCycle() ? 'Creating' : 'Create cycle' }}
                      </umbra-button>
                      <umbra-button
                        size="sm"
                        variant="link"
                        type="button"
                        (click)="toggleCreateCycle(team)"
                      >
                        Cancel
                      </umbra-button>
                    </div>
                  </form>
                }
                @for (cycle of cyclesFor(team.id); track cycle.id) {
                  <article class="resource-row">
                    <div>
                      <h3>{{ cycle.name || 'Cycle ' + cycle.number }}</h3>
                      @if (cycle.description) {
                        <p>{{ cycle.description }}</p>
                      }
                      <p>
                        {{ cycleDateInTeam(cycle.startsAt, team) }} –
                        {{ cycleDateInTeam(cycle.endsAt, team) }}
                      </p>
                    </div>
                    <umbra-button size="sm" variant="outline" (click)="editCycle(cycle)">
                      Edit cycle
                    </umbra-button>
                    @if (canEditCycle(cycle, team)) {
                      <span class="muted">{{ cycle.isActive ? 'Current' : 'Upcoming' }}</span>
                    } @else {
                      <span class="muted">Past</span>
                    }
                  </article>
                  @if (editingCycleId() === cycle.id) {
                    <form class="project-edit" (submit)="saveCycle($event, cycle)">
                      <label>
                        <span>Cycle name</span>
                        <input
                          maxlength="255"
                          [value]="editCycleName()"
                          (input)="editCycleName.set($any($event.target).value)"
                        />
                      </label>
                      <label>
                        <span>Description</span>
                        <textarea
                          rows="2"
                          [value]="editCycleDescription()"
                          (input)="editCycleDescription.set($any($event.target).value)"
                        ></textarea>
                      </label>
                      @if (!cycle.isActive) {
                        @if (canEditCycle(cycle, team)) {
                          <label>
                            <span>Start date · {{ team.timezone || 'America/Los_Angeles' }}</span>
                            <input
                              type="date"
                              required
                              [value]="editCycleStartDate()"
                              [min]="todayForTeam(team)"
                              (input)="editCycleStartDate.set($any($event.target).value)"
                            />
                          </label>
                        }
                      }
                      @if (canEditCycle(cycle, team)) {
                        <label>
                          <span>End date · {{ team.timezone || 'America/Los_Angeles' }}</span>
                          <input
                            type="date"
                            required
                            [value]="editCycleEndDate()"
                            [min]="cycle.isActive ? todayForTeam(team) : editCycleStartDate()"
                            (input)="editCycleEndDate.set($any($event.target).value)"
                          />
                        </label>
                      } @else {
                        <p class="hint">Past cycle dates cannot be changed.</p>
                      }
                      <umbra-button size="sm" [disabled]="savingCycle()">
                        {{ savingCycle() ? 'Saving' : 'Save schedule' }}
                      </umbra-button>
                      <umbra-button
                        size="sm"
                        variant="link"
                        type="button"
                        (click)="editingCycleId.set(null)"
                        >Cancel</umbra-button
                      >
                    </form>
                  }
                } @empty {
                  <p class="hint">No cycles are available for this team.</p>
                }
              }
            </section>
          } @else if (section() === 'roadmap') {
            <section class="issues" aria-label="Linear roadmap initiatives">
              <div class="issue-actions">
                <h2>Initiatives</h2>
                <umbra-button
                  size="sm"
                  variant="link"
                  type="button"
                  (click)="toggleArchivedInitiatives()"
                >
                  {{ includeArchivedInitiatives() ? 'Hide archived' : 'Include archived' }}
                </umbra-button>
                <umbra-button
                  size="sm"
                  variant="link"
                  type="button"
                  (click)="toggleArchivedInitiativeUpdates()"
                >
                  {{
                    includeArchivedInitiativeUpdates()
                      ? 'Hide archived updates'
                      : 'Include archived updates'
                  }}
                </umbra-button>
              </div>
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
                    @if (initiative.archivedAt) {
                      <span class="muted">Archived</span>
                    }
                    <span class="muted">{{
                      initiative.targetDate ? 'Target ' + initiative.targetDate : 'No target date'
                    }}</span>
                    @if (initiative.projects.length) {
                      <div class="initiative-projects">
                        @for (link of initiative.projects; track link.id) {
                          <div class="issue-actions">
                            <button
                              type="button"
                              class="issue-link"
                              (click)="openProjectById(link.project.id)"
                            >
                              {{ link.project.name }}
                            </button>
                            @if (!initiative.archivedAt) {
                              <umbra-button
                                size="sm"
                                variant="link"
                                [disabled]="savingInitiativeProjectId() === initiative.id"
                                [ariaLabel]="
                                  'Remove ' + link.project.name + ' from ' + initiative.name
                                "
                                (click)="removeInitiativeProject(initiative, link.id)"
                              >
                                Remove
                              </umbra-button>
                            }
                          </div>
                        }
                      </div>
                    }
                    @if (initiative.updates.length) {
                      <div class="project-updates" aria-label="Initiative status updates">
                        @for (update of initiative.updates; track update.id) {
                          @if (includeArchivedInitiativeUpdates() || !update.archivedAt) {
                            <article class="project-update">
                              <div>
                                <strong>{{ projectHealthLabel(update.health) }}</strong>
                                <span class="muted"
                                  >{{ update.user.name }} ·
                                  {{ projectUpdateDate(update.createdAt) }}</span
                                >
                              </div>
                              <p>{{ update.body }}</p>
                              @if (update.archivedAt) {
                                <span class="muted">Archived</span>
                              }
                              @if (!initiative.archivedAt) {
                                @if (update.archivedAt) {
                                  <umbra-button
                                    size="sm"
                                    variant="link"
                                    type="button"
                                    [disabled]="busyInitiativeUpdateId() === update.id"
                                    (click)="setInitiativeUpdateArchived(update, false)"
                                  >
                                    {{
                                      busyInitiativeUpdateId() === update.id
                                        ? 'Restoring'
                                        : 'Restore'
                                    }}
                                  </umbra-button>
                                } @else {
                                  <umbra-button
                                    size="sm"
                                    variant="link"
                                    type="button"
                                    (click)="editInitiativeUpdate(update)"
                                  >
                                    Edit update
                                  </umbra-button>
                                  <umbra-button
                                    size="sm"
                                    variant="link"
                                    type="button"
                                    [disabled]="busyInitiativeUpdateId() === update.id"
                                    (click)="setInitiativeUpdateArchived(update, true)"
                                  >
                                    {{
                                      busyInitiativeUpdateId() === update.id
                                        ? 'Archiving'
                                        : 'Archive'
                                    }}
                                  </umbra-button>
                                }
                              }
                            </article>
                            @if (editingInitiativeUpdateId() === update.id) {
                              <form
                                class="project-edit"
                                (submit)="saveInitiativeUpdate($event, update)"
                              >
                                <label>
                                  <span>Health</span>
                                  <select
                                    [value]="editInitiativeUpdateHealth()"
                                    (change)="
                                      editInitiativeUpdateHealth.set($any($event.target).value)
                                    "
                                  >
                                    <option value="onTrack">On track</option>
                                    <option value="atRisk">At risk</option>
                                    <option value="offTrack">Off track</option>
                                  </select>
                                </label>
                                <label>
                                  <span>Update</span>
                                  <textarea
                                    required
                                    maxlength="10000"
                                    rows="3"
                                    [value]="editInitiativeUpdateBody()"
                                    (input)="
                                      editInitiativeUpdateBody.set($any($event.target).value)
                                    "
                                  ></textarea>
                                </label>
                                <div class="issue-actions">
                                  <umbra-button
                                    size="sm"
                                    [disabled]="
                                      savingInitiativeUpdate() || !editInitiativeUpdateBody().trim()
                                    "
                                  >
                                    {{ savingInitiativeUpdate() ? 'Saving' : 'Save update' }}
                                  </umbra-button>
                                  <umbra-button
                                    size="sm"
                                    variant="link"
                                    type="button"
                                    (click)="editingInitiativeUpdateId.set(null)"
                                  >
                                    Cancel
                                  </umbra-button>
                                </div>
                              </form>
                            }
                          }
                        }
                      </div>
                    }
                    @if (!initiative.archivedAt) {
                      <umbra-button
                        size="sm"
                        variant="outline"
                        (click)="toggleInitiativeUpdate(initiative)"
                      >
                        {{
                          initiativeUpdateId() === initiative.id
                            ? 'Cancel update'
                            : 'Post status update'
                        }}
                      </umbra-button>
                    }
                    @if (!initiative.archivedAt && availableInitiativeProjects(initiative).length) {
                      <div class="issue-actions">
                        <label>
                          <span class="sr-only">Project to add to {{ initiative.name }}</span>
                          <select
                            [value]="initiativeProjectSelection()[initiative.id] ?? ''"
                            (change)="
                              setInitiativeProject(initiative.id, $any($event.target).value)
                            "
                          >
                            <option value="">Choose project</option>
                            @for (
                              project of availableInitiativeProjects(initiative);
                              track project.id
                            ) {
                              <option [value]="project.id">{{ project.name }}</option>
                            }
                          </select>
                        </label>
                        <umbra-button
                          size="sm"
                          variant="outline"
                          [disabled]="
                            !initiativeProjectSelection()[initiative.id] ||
                            savingInitiativeProjectId() === initiative.id
                          "
                          (click)="addInitiativeProject(initiative)"
                        >
                          {{
                            savingInitiativeProjectId() === initiative.id
                              ? 'Linking'
                              : 'Link project'
                          }}
                        </umbra-button>
                      </div>
                    }
                  </div>
                  <div class="issue-actions">
                    @if (initiative.archivedAt) {
                      <umbra-button
                        size="sm"
                        variant="outline"
                        [disabled]="busyInitiativeId() === initiative.id"
                        (click)="setInitiativeArchived(initiative, false)"
                      >
                        {{ busyInitiativeId() === initiative.id ? 'Restoring' : 'Restore' }}
                      </umbra-button>
                    } @else {
                      <umbra-button
                        size="sm"
                        variant="outline"
                        (click)="editInitiative(initiative)"
                      >
                        Edit
                      </umbra-button>
                      <umbra-button
                        size="sm"
                        variant="link"
                        [disabled]="busyInitiativeId() === initiative.id"
                        (click)="setInitiativeArchived(initiative, true)"
                      >
                        {{ busyInitiativeId() === initiative.id ? 'Archiving' : 'Archive' }}
                      </umbra-button>
                    }
                  </div>
                </article>
                @if (initiativeUpdateId() === initiative.id) {
                  <form class="project-edit" (submit)="createInitiativeUpdate($event, initiative)">
                    <label>
                      <span>Health</span>
                      <select
                        [value]="initiativeUpdateHealth()"
                        (change)="initiativeUpdateHealth.set($any($event.target).value)"
                      >
                        <option value="onTrack">On track</option>
                        <option value="atRisk">At risk</option>
                        <option value="offTrack">Off track</option>
                      </select>
                    </label>
                    <label>
                      <span>Status update</span>
                      <textarea
                        required
                        maxlength="10000"
                        rows="3"
                        [value]="initiativeUpdateBody()"
                        (input)="initiativeUpdateBody.set($any($event.target).value)"
                      ></textarea>
                    </label>
                    <umbra-button
                      size="sm"
                      [disabled]="creatingInitiativeUpdate() || !initiativeUpdateBody().trim()"
                    >
                      {{ creatingInitiativeUpdate() ? 'Posting' : 'Post update' }}
                    </umbra-button>
                  </form>
                }
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
          } @else {
            <section class="issues" aria-label="Linear issue labels">
              <form class="project-edit" (submit)="createLabel($event)">
                <label>
                  <span>Label name</span>
                  <input
                    required
                    maxlength="255"
                    [value]="newLabelName()"
                    (input)="newLabelName.set($any($event.target).value)"
                  />
                </label>
                <label>
                  <span>Scope</span>
                  <select
                    [value]="newLabelTeamId()"
                    (change)="newLabelTeamId.set($any($event.target).value)"
                  >
                    <option value="">Workspace</option>
                    @for (team of teams(); track team.id) {
                      <option [value]="team.id">{{ team.name }}</option>
                    }
                  </select>
                </label>
                <label>
                  <span>Color</span>
                  <input
                    type="color"
                    [value]="newLabelColor()"
                    (input)="newLabelColor.set($any($event.target).value)"
                  />
                </label>
                <umbra-button size="sm" [disabled]="creatingLabel() || !newLabelName().trim()">
                  {{ creatingLabel() ? 'Creating' : 'Create label' }}
                </umbra-button>
              </form>
              @for (label of labels(); track label.id) {
                <article class="issue">
                  <span
                    class="label-color"
                    [style.background-color]="label.color ?? '#6b7280'"
                  ></span>
                  @if (editingLabelId() === label.id) {
                    <form class="issue-actions" (submit)="saveLabel($event, label)">
                      <label>
                        <span class="sr-only">Label name</span>
                        <input
                          required
                          maxlength="255"
                          [value]="editLabelName()"
                          (input)="editLabelName.set($any($event.target).value)"
                        />
                      </label>
                      <label>
                        <span class="sr-only">Label color</span>
                        <input
                          type="color"
                          [value]="editLabelColor()"
                          (input)="editLabelColor.set($any($event.target).value)"
                        />
                      </label>
                      <umbra-button size="sm" [disabled]="savingLabel() || !editLabelName().trim()">
                        {{ savingLabel() ? 'Saving' : 'Save' }}
                      </umbra-button>
                      <umbra-button
                        size="sm"
                        variant="link"
                        type="button"
                        (click)="editingLabelId.set(null)"
                      >
                        Cancel
                      </umbra-button>
                    </form>
                  } @else {
                    <span class="issue-title">{{ label.name }}</span>
                    <span class="muted">{{
                      label.team?.id ? teamName(label.team.id) : 'Workspace'
                    }}</span>
                    @if (confirmDeleteLabelId() === label.id) {
                      <span class="muted">Delete this label?</span>
                      <umbra-button
                        size="sm"
                        variant="destructive"
                        [disabled]="deletingLabelId() === label.id"
                        (click)="deleteLabel(label)"
                      >
                        {{ deletingLabelId() === label.id ? 'Deleting' : 'Confirm delete' }}
                      </umbra-button>
                      <umbra-button
                        size="sm"
                        variant="link"
                        (click)="confirmDeleteLabelId.set(null)"
                      >
                        Cancel
                      </umbra-button>
                    } @else {
                      <umbra-button size="sm" variant="outline" (click)="editLabel(label)">
                        Edit
                      </umbra-button>
                      <umbra-button
                        size="sm"
                        variant="link"
                        (click)="confirmDeleteLabelId.set(label.id)"
                      >
                        Delete
                      </umbra-button>
                    }
                  }
                </article>
              } @empty {
                <p class="hint">No issue labels are available in this workspace.</p>
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
      flex-wrap: wrap;
      gap: var(--space-2);
    }
    .label-color {
      width: 0.8rem;
      height: 0.8rem;
      flex: 0 0 auto;
      border-radius: 50%;
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
  protected readonly includeArchivedIssues = signal(false);
  protected readonly confirmArchiveIssueId = signal<string | null>(null);
  protected readonly confirmArchiveIssueDetailId = signal<string | null>(null);
  protected readonly archivingIssueId = signal<string | null>(null);
  protected readonly issueDetail = signal<LinearIssueDetail | null>(null);
  protected readonly creatingIssueRelation = signal(false);
  protected readonly relatedIssueIdentifier = signal('');
  protected readonly newIssueRelationType = signal<LinearIssueRelationType>('blocks');
  protected readonly confirmDeleteIssueRelationId = signal<string | null>(null);
  protected readonly deletingIssueRelationId = signal<string | null>(null);
  protected readonly editingIssueDetailsId = signal<string | null>(null);
  protected readonly editIssueTitle = signal('');
  protected readonly editIssueDescription = signal('');
  protected readonly savingIssueDetails = signal(false);
  protected readonly codexContext = signal<LinearCodexContext | null>(null);
  protected readonly codexRequest = signal<{
    readonly issue: LinearIssue;
    readonly continueThread: boolean;
  } | null>(null);
  protected readonly codexWorkspaces = signal<readonly WorkspaceSummary[]>([]);
  protected readonly selectedCodexWorkspacePath = signal('');
  protected readonly selectedCodexProjectRepo = signal('');
  protected readonly projectIssues = signal<readonly LinearIssue[]>([]);
  protected readonly includeArchivedProjectIssues = signal(false);
  protected readonly loadingProjectIssues = signal(false);
  protected readonly projectIssuesHasNextPage = signal(false);
  protected readonly milestones = signal<readonly LinearMilestone[]>([]);
  protected readonly projectUpdates = signal<readonly LinearProjectUpdate[]>([]);
  protected readonly newProjectUpdateBody = signal('');
  protected readonly newProjectUpdateHealth = signal<LinearProjectHealth>('onTrack');
  protected readonly creatingProjectUpdate = signal(false);
  protected readonly editingProjectUpdateId = signal<string | null>(null);
  protected readonly editProjectUpdateBody = signal('');
  protected readonly editProjectUpdateHealth = signal<LinearProjectHealth>('onTrack');
  protected readonly savingProjectUpdate = signal(false);
  protected readonly includeArchivedProjectUpdates = signal(false);
  protected readonly busyProjectUpdateId = signal<string | null>(null);
  protected readonly projects = signal<readonly LinearProject[]>([]);
  protected readonly projectStatuses = signal<readonly LinearProjectStatus[]>([]);
  protected readonly initiatives = signal<readonly LinearInitiative[]>([]);
  protected readonly initiativeUpdateId = signal<string | null>(null);
  protected readonly initiativeUpdateBody = signal('');
  protected readonly initiativeUpdateHealth = signal<LinearProjectHealth>('onTrack');
  protected readonly creatingInitiativeUpdate = signal(false);
  protected readonly editingInitiativeUpdateId = signal<string | null>(null);
  protected readonly editInitiativeUpdateBody = signal('');
  protected readonly editInitiativeUpdateHealth = signal<LinearProjectHealth>('onTrack');
  protected readonly savingInitiativeUpdate = signal(false);
  protected readonly busyInitiativeUpdateId = signal<string | null>(null);
  protected readonly includeArchivedInitiativeUpdates = signal(false);
  protected readonly includeArchivedInitiatives = signal(false);
  protected readonly busyInitiativeId = signal<string | null>(null);
  protected readonly newInitiativeName = signal('');
  protected readonly newInitiativeDescription = signal('');
  protected readonly newInitiativeTargetDate = signal('');
  protected readonly editingInitiativeId = signal<string | null>(null);
  protected readonly editInitiativeName = signal('');
  protected readonly editInitiativeDescription = signal('');
  protected readonly editInitiativeTargetDate = signal('');
  protected readonly savingInitiative = signal(false);
  protected readonly initiativeProjectSelection = signal<Readonly<Record<string, string>>>({});
  protected readonly savingInitiativeProjectId = signal<string | null>(null);
  protected readonly cycles = signal<Readonly<Record<string, readonly LinearCycle[]>>>({});
  protected readonly createCycleTeamId = signal<string | null>(null);
  protected readonly newCycleName = signal('');
  protected readonly newCycleStartDate = signal('');
  protected readonly newCycleEndDate = signal('');
  protected readonly creatingCycle = signal(false);
  protected readonly editingCycleId = signal<string | null>(null);
  protected readonly editCycleName = signal('');
  protected readonly editCycleDescription = signal('');
  protected readonly editCycleStartDate = signal('');
  protected readonly editCycleEndDate = signal('');
  protected readonly savingCycle = signal(false);
  protected readonly selectedProject = signal<LinearProject | null>(null);
  protected readonly showArchivedProjects = signal(false);
  protected readonly confirmArchiveProjectId = signal<string | null>(null);
  protected readonly archivingProject = signal(false);
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
  protected readonly newProjectIssueEstimate = signal('');
  protected readonly newEstimate = signal('');
  protected readonly newSubIssueTitle = signal('');
  protected readonly newComment = signal('');
  protected readonly editingCommentId = signal<string | null>(null);
  protected readonly editCommentBody = signal('');
  protected readonly savingComment = signal(false);
  protected readonly deletingCommentId = signal<string | null>(null);
  protected readonly confirmDeleteCommentId = signal<string | null>(null);
  protected readonly editingMilestoneId = signal<string | null>(null);
  protected readonly editMilestoneName = signal('');
  protected readonly editMilestoneDescription = signal('');
  protected readonly editMilestoneDate = signal('');
  protected readonly section = signal<'work' | 'projects' | 'cycles' | 'roadmap' | 'labels'>(
    'work',
  );
  protected readonly teams = signal<readonly LinearTeam[]>([]);
  protected readonly users = signal<readonly LinearPerson[]>([]);
  protected readonly labels = signal<readonly LinearLabel[]>([]);
  protected readonly newLabelName = signal('');
  protected readonly newLabelTeamId = signal('');
  protected readonly newLabelColor = signal('#6b7280');
  protected readonly creatingLabel = signal(false);
  protected readonly editingLabelId = signal<string | null>(null);
  protected readonly editLabelName = signal('');
  protected readonly editLabelColor = signal('#6b7280');
  protected readonly savingLabel = signal(false);
  protected readonly confirmDeleteLabelId = signal<string | null>(null);
  protected readonly deletingLabelId = signal<string | null>(null);
  protected readonly workflowStates = signal<
    Readonly<Record<string, readonly LinearWorkflowState[]>>
  >({});
  protected readonly createTeamId = signal('');
  protected readonly issueTeamId = signal('');
  protected readonly newTitle = signal('');
  protected readonly newDescription = signal('');
  protected readonly hasNextPage = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly issueCacheStale = signal(false);
  protected readonly projectCacheStale = signal(false);
  protected readonly pendingIssueUpdates = signal<readonly PendingLinearIssueUpdate[]>([]);
  protected readonly retryingIssueUpdates = signal(false);
  protected readonly pending = signal(false);
  protected readonly syncing = signal(false);
  protected readonly oauthConfigured = signal(false);
  protected readonly loading = signal(false);
  protected readonly creating = signal(false);
  protected readonly creatingProject = signal(false);
  protected readonly savingProject = signal(false);
  protected readonly creatingMilestone = signal(false);
  protected readonly savingMilestone = signal(false);
  protected readonly confirmDeleteMilestoneId = signal<string | null>(null);
  protected readonly deletingMilestoneId = signal<string | null>(null);
  protected readonly creatingProjectIssue = signal(false);
  protected readonly creatingSubIssue = signal(false);
  protected readonly sendingComment = signal(false);
  protected readonly codexPending = signal(false);
  private nextCursor: string | null = null;
  private nextProjectIssueCursor: string | null = null;
  private projectIssuesRequest = 0;

  protected pageTitle(): string {
    return {
      work: 'My work',
      projects: 'Projects',
      cycles: 'Cycles',
      roadmap: 'Roadmap',
      labels: 'Labels',
    }[this.section()];
  }

  protected pageDescription(): string {
    return {
      work: 'Assigned Linear issues across your connected workspaces.',
      projects: 'Projects and their issues in your connected workspace.',
      cycles: 'Team planning cycles and current work periods.',
      roadmap: 'Initiatives and the projects connected to them.',
      labels: 'Workspace and team issue labels.',
    }[this.section()];
  }

  constructor() {
    void this.tauri
      .linearOauthConfigured()
      .then((configured) => this.oauthConfigured.set(configured));
    void this.refreshConnections();
    effect(() => {
      if (this.nexus.status().connected) void this.refreshConnections();
    });
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
    this.selectedProject.set(null);
    this.projectIssues.set([]);
    this.nextProjectIssueCursor = null;
    this.projectIssuesHasNextPage.set(false);
    this.projectIssuesRequest++;
    this.loadingProjectIssues.set(false);
    this.issueTeamId.set('');
    this.restoreIssueDraft(connection);
    this.restorePendingIssueUpdates(connection);
    this.issueCacheStale.set(false);
    this.projectCacheStale.set(false);
    this.issues.set([]);
    this.issueDetail.set(null);
    this.confirmArchiveIssueId.set(null);
    this.confirmArchiveIssueDetailId.set(null);
    this.confirmDeleteIssueRelationId.set(null);
    this.newLabelTeamId.set('');
    this.editingLabelId.set(null);
    this.confirmDeleteLabelId.set(null);
    this.codexContext.set(null);
    this.nextCursor = null;
    void this.loadTeams(connection);
    void this.loadIssues();
    void this.loadSection(connection);
  }

  protected teamName(teamId: string): string {
    return this.teams().find((team) => team.id === teamId)?.name ?? 'Team';
  }

  protected setIssueTeam(teamId: string): void {
    if (this.loading() || teamId === this.issueTeamId()) return;
    this.issueTeamId.set(teamId);
    this.confirmArchiveIssueId.set(null);
    this.nextCursor = null;
    this.hasNextPage.set(false);
    this.issues.set([]);
    void this.loadIssues();
  }

  protected toggleArchivedIssues(): void {
    if (this.loading()) return;
    this.includeArchivedIssues.update((value) => !value);
    this.issues.set([]);
    this.nextCursor = null;
    this.hasNextPage.set(false);
    void this.loadIssues();
  }

  protected async setIssueArchived(
    issue: LinearIssue,
    archived: boolean,
    fromDetail = false,
  ): Promise<void> {
    const connection = this.selected();
    if (!connection || this.archivingIssueId()) return;
    const confirmed = fromDetail
      ? this.confirmArchiveIssueDetailId() === issue.id
      : this.confirmArchiveIssueId() === issue.id;
    if (archived && !confirmed) return;
    this.archivingIssueId.set(issue.id);
    this.error.set(null);
    try {
      if (archived) {
        await this.tauri.linearArchiveIssue(connection.organizationId, issue.id);
      } else {
        await this.tauri.linearUnarchiveIssue(connection.organizationId, issue.id);
      }
      this.confirmArchiveIssueId.set(null);
      this.confirmArchiveIssueDetailId.set(null);
      this.issueDetail.update((detail) =>
        detail?.issue.id === issue.id
          ? {
              ...detail,
              issue: {
                ...detail.issue,
                archivedAt: archived ? new Date().toISOString() : null,
              },
            }
          : detail,
      );
      this.writeLocal(this.issueCacheKey(connection), null);
      const project = this.selectedProject();
      if (project) {
        this.projectIssues.set([]);
        this.nextProjectIssueCursor = null;
        this.projectIssuesHasNextPage.set(false);
        await this.loadProjectIssues(project.id);
      } else await this.loadIssues();
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.archivingIssueId.set(null);
    }
  }

  protected statesFor(issue: LinearIssue): readonly LinearWorkflowState[] {
    return this.workflowStates()[issue.team.id] ?? [];
  }

  protected estimateOptions(teamId: string) {
    const team = this.teams().find((item) => item.id === teamId);
    return linearEstimateOptions(
      team?.issueEstimationType ?? 'notUsed',
      team?.issueEstimationExtended ?? false,
      team?.issueEstimationAllowZero ?? false,
    );
  }

  protected async openIssueDetail(issue: Pick<LinearIssue, 'id'>): Promise<void> {
    const connection = this.selected();
    if (!connection) return;
    void this.loadProjects();
    this.issueDetail.set(null);
    this.confirmArchiveIssueId.set(null);
    this.confirmArchiveIssueDetailId.set(null);
    this.confirmDeleteIssueRelationId.set(null);
    this.editingIssueDetailsId.set(null);
    this.codexRequest.set(null);
    this.error.set(null);
    try {
      const detail = await this.tauri.linearIssueDetail(connection.organizationId, issue.id);
      if (detail.issue.project) await this.loadMilestones(detail.issue.project.id);
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

  protected issueRelations(detail: LinearIssueDetail) {
    return [
      ...detail.relations.flatMap((relation) =>
        relation.relatedIssue
          ? [
              {
                id: relation.id,
                type: relation.type,
                target: relation.relatedIssue,
                inverse: false,
              },
            ]
          : [],
      ),
      ...detail.inverseRelations.flatMap((relation) =>
        relation.issue
          ? [{ id: relation.id, type: relation.type, target: relation.issue, inverse: true }]
          : [],
      ),
    ];
  }

  protected relationLabel(type: LinearIssueRelationType, inverse: boolean): string {
    if (type === 'blocks') return inverse ? 'is blocked by' : 'blocks';
    if (type === 'duplicate') return inverse ? 'is duplicated by' : 'duplicates';
    return type === 'similar' ? 'is similar to' : 'is related to';
  }

  protected async createIssueRelation(event: Event, issue: LinearIssue): Promise<void> {
    event.preventDefault();
    const connection = this.selected();
    const relatedIssueId = this.relatedIssueIdentifier().trim();
    if (!connection || !relatedIssueId || this.creatingIssueRelation()) return;
    if (issue.identifier.toLocaleLowerCase() === relatedIssueId.toLocaleLowerCase()) {
      this.error.set('An issue cannot be linked to itself.');
      return;
    }
    this.creatingIssueRelation.set(true);
    this.error.set(null);
    try {
      await this.tauri.linearCreateIssueRelation(
        connection.organizationId,
        issue.id,
        relatedIssueId,
        this.newIssueRelationType(),
      );
      const detail = await this.tauri.linearIssueDetail(connection.organizationId, issue.id);
      if (this.issueDetail()?.issue.id === issue.id) this.issueDetail.set(detail);
      this.relatedIssueIdentifier.set('');
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.creatingIssueRelation.set(false);
    }
  }

  protected async deleteIssueRelation(issue: LinearIssue, relationId: string): Promise<void> {
    const connection = this.selected();
    if (
      !connection ||
      this.confirmDeleteIssueRelationId() !== relationId ||
      this.deletingIssueRelationId()
    ) {
      return;
    }
    this.deletingIssueRelationId.set(relationId);
    this.error.set(null);
    try {
      await this.tauri.linearDeleteIssueRelation(connection.organizationId, relationId);
      this.confirmDeleteIssueRelationId.set(null);
      const detail = await this.tauri.linearIssueDetail(connection.organizationId, issue.id);
      if (this.issueDetail()?.issue.id === issue.id) this.issueDetail.set(detail);
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.deletingIssueRelationId.set(null);
    }
  }

  protected editIssueDetails(issue: LinearIssue): void {
    this.error.set(null);
    this.editingIssueDetailsId.set(issue.id);
    this.editIssueTitle.set(issue.title);
    this.editIssueDescription.set(issue.description ?? '');
  }

  protected async saveIssueDetails(event: Event, issue: LinearIssue): Promise<void> {
    event.preventDefault();
    const title = this.editIssueTitle().trim();
    if (!title || this.savingIssueDetails()) return;
    this.savingIssueDetails.set(true);
    const saved = await this.saveIssueUpdate(issue, {
      title,
      description: this.editIssueDescription(),
    });
    if (saved) this.editingIssueDetailsId.set(null);
    this.savingIssueDetails.set(false);
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
      const prompt = linearCodexPrompt(issue, this.issueDetail());
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
    this.editingIssueDetailsId.set(null);
    this.confirmArchiveIssueDetailId.set(null);
    this.codexContext.set(null);
    this.newComment.set('');
    this.editingCommentId.set(null);
    this.confirmDeleteCommentId.set(null);
    this.newSubIssueTitle.set('');
  }

  protected editComment(comment: LinearComment): void {
    this.editingCommentId.set(comment.id);
    this.editCommentBody.set(comment.body);
    this.confirmDeleteCommentId.set(null);
  }

  protected async saveComment(event: Event, current: LinearComment): Promise<void> {
    event.preventDefault();
    const connection = this.selected();
    const detail = this.issueDetail();
    const body = this.editCommentBody().trim();
    if (!connection || !detail || !body || this.savingComment()) return;
    this.savingComment.set(true);
    this.error.set(null);
    try {
      const comment = await this.tauri.linearUpdateComment(
        connection.organizationId,
        current.id,
        body,
      );
      this.issueDetail.update((item) =>
        item?.issue.id === detail.issue.id
          ? {
              ...item,
              comments: item.comments.map((entry) => (entry.id === comment.id ? comment : entry)),
            }
          : item,
      );
      this.editingCommentId.set(null);
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.savingComment.set(false);
    }
  }

  protected async deleteComment(comment: LinearComment): Promise<void> {
    const connection = this.selected();
    const detail = this.issueDetail();
    if (
      !connection ||
      !detail ||
      this.confirmDeleteCommentId() !== comment.id ||
      this.deletingCommentId()
    ) {
      return;
    }
    this.deletingCommentId.set(comment.id);
    this.error.set(null);
    try {
      await this.tauri.linearDeleteComment(connection.organizationId, comment.id);
      this.issueDetail.update((item) =>
        item?.issue.id === detail.issue.id
          ? { ...item, comments: item.comments.filter((entry) => entry.id !== comment.id) }
          : item,
      );
      this.confirmDeleteCommentId.set(null);
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.deletingCommentId.set(null);
    }
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
    if (teamId !== this.createTeamId()) {
      this.newEstimate.set('');
      this.newProjectIssueEstimate.set('');
    }
    this.createTeamId.set(teamId);
    this.saveIssueDraft();
    this.saveProjectIssueDraft();
  }

  protected updateIssueDraft(field: 'title' | 'description', value: string): void {
    if (field === 'title') this.newTitle.set(value);
    else this.newDescription.set(value);
    this.saveIssueDraft();
  }

  protected updateIssueDraftEstimate(value: string): void {
    this.newEstimate.set(value);
    this.saveIssueDraft();
  }

  private issueDraftKey(organizationId: string): string {
    return `relay.linear.issueDraft.${organizationId}`;
  }

  private projectIssueDraftKey(organizationId: string, projectId: string): string {
    return `relay.linear.projectIssueDraft.${organizationId}.${projectId}`;
  }

  private issueCacheKey(connection: LinearConnection): string {
    const teamId = this.issueTeamId();
    const scope = teamId
      ? `relay.linear.issues.${connection.organizationId}.${connection.viewerId}.team.${teamId}`
      : `relay.linear.issues.${connection.organizationId}.${connection.viewerId}`;
    return this.includeArchivedIssues() ? `${scope}.all` : scope;
  }

  private projectCacheKey(connection: LinearConnection, includeArchived = false): string {
    const key = `relay.linear.projects.${connection.organizationId}.${connection.viewerId}`;
    return includeArchived ? `${key}.all` : key;
  }

  private pendingUpdatesKey(organizationId: string): string {
    return `relay.linear.pendingIssueUpdates.${organizationId}`;
  }

  private restorePendingIssueUpdates(connection: LinearConnection): void {
    this.pendingIssueUpdates.set(this.readPendingIssueUpdates(connection.organizationId));
  }

  private readPendingIssueUpdates(organizationId: string): PendingLinearIssueUpdate[] {
    const stored = this.readLocal<unknown>(this.pendingUpdatesKey(organizationId));
    return Array.isArray(stored) ? stored.filter(isPendingLinearIssueUpdate) : [];
  }

  private storePendingIssueUpdates(
    organizationId: string,
    updates: readonly PendingLinearIssueUpdate[],
  ): void {
    this.writeLocal(this.pendingUpdatesKey(organizationId), updates.length ? updates : null);
    if (this.selected()?.organizationId === organizationId) {
      this.pendingIssueUpdates.set(updates);
    }
  }

  private queueIssueUpdate(
    organizationId: string,
    issueId: string,
    update: LinearIssueUpdate,
  ): LinearIssueUpdate {
    const updates = this.readPendingIssueUpdates(organizationId);
    const index = updates.findIndex((item) => item.issueId === issueId);
    const merged = mergeLinearIssueUpdates(updates[index]?.update ?? {}, update);
    if (index < 0) updates.push({ issueId, update: merged });
    else updates[index] = { issueId, update: merged };
    this.storePendingIssueUpdates(organizationId, updates);
    return merged;
  }

  private removePendingIssueUpdate(organizationId: string, issueId: string): void {
    this.storePendingIssueUpdates(
      organizationId,
      this.readPendingIssueUpdates(organizationId).filter((item) => item.issueId !== issueId),
    );
  }

  private applyUpdatedIssue(organizationId: string, updated: LinearIssue): void {
    if (this.selected()?.organizationId !== organizationId) return;
    this.issues.update((items) =>
      items.map((entry) => (entry.id === updated.id ? updated : entry)),
    );
    this.projectIssues.update((items) =>
      items.map((entry) => (entry.id === updated.id ? updated : entry)),
    );
    this.issueDetail.update((detail) =>
      detail?.issue.id === updated.id ? { ...detail, issue: updated } : detail,
    );
    const connection = this.selected();
    if (connection) this.saveIssueCache(connection);
  }

  private saveIssueCache(connection: LinearConnection): void {
    this.writeLocal(this.issueCacheKey(connection), {
      issues: this.issues(),
      endCursor: this.nextCursor,
      hasNextPage: this.hasNextPage(),
    } satisfies LinearIssuePage);
  }

  private readLocal<T>(key: string): T | null {
    try {
      const saved = localStorage.getItem(key);
      return saved ? (JSON.parse(saved) as T) : null;
    } catch {
      return null;
    }
  }

  private writeLocal<T>(key: string, value: T | null): void {
    try {
      if (value) localStorage.setItem(key, JSON.stringify(value));
      else localStorage.removeItem(key);
    } catch {
      // Keep the composer usable if local persistence is unavailable.
    }
  }

  private saveIssueDraft(): void {
    const connection = this.selected();
    if (!connection) return;
    this.writeLocal(this.issueDraftKey(connection.organizationId), {
      teamId: this.createTeamId(),
      title: this.newTitle(),
      description: this.newDescription(),
      estimate: this.newEstimate(),
    });
  }

  private restoreIssueDraft(connection: LinearConnection): void {
    const draft = this.readLocal<Partial<LinearIssueDraft>>(
      this.issueDraftKey(connection.organizationId),
    );
    this.newTitle.set(typeof draft?.title === 'string' ? draft.title : '');
    this.newDescription.set(typeof draft?.description === 'string' ? draft.description : '');
    this.newEstimate.set(typeof draft?.estimate === 'string' ? draft.estimate : '');
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

  protected updateProjectIssueEstimate(value: string): void {
    this.newProjectIssueEstimate.set(value);
    this.saveProjectIssueDraft();
  }

  private saveProjectIssueDraft(): void {
    const connection = this.selected();
    const project = this.selectedProject();
    if (!connection || !project) return;
    this.writeLocal(this.projectIssueDraftKey(connection.organizationId, project.id), {
      teamId: this.createTeamId(),
      title: this.newProjectIssueTitle(),
      description: this.newProjectIssueDescription(),
      milestoneId: this.newProjectIssueMilestoneId(),
      estimate: this.newProjectIssueEstimate(),
    });
  }

  private restoreProjectIssueDraft(connection: LinearConnection, projectId: string): void {
    const draft = this.readLocal<Partial<LinearIssueDraft>>(
      this.projectIssueDraftKey(connection.organizationId, projectId),
    );
    this.newProjectIssueTitle.set(typeof draft?.title === 'string' ? draft.title : '');
    this.newProjectIssueDescription.set(
      typeof draft?.description === 'string' ? draft.description : '',
    );
    this.newProjectIssueMilestoneId.set(
      typeof draft?.milestoneId === 'string' ? draft.milestoneId : '',
    );
    this.newProjectIssueEstimate.set(typeof draft?.estimate === 'string' ? draft.estimate : '');
    if (typeof draft?.teamId === 'string') this.createTeamId.set(draft.teamId);
  }

  protected setSection(section: 'work' | 'projects' | 'cycles' | 'roadmap' | 'labels'): void {
    this.section.set(section);
    this.selectedProject.set(null);
    this.confirmArchiveProjectId.set(null);
    const connection = this.selected();
    if (connection) void this.loadSection(connection);
  }

  protected cyclesFor(teamId: string): readonly LinearCycle[] {
    return this.cycles()[teamId] ?? [];
  }

  protected cycleDateInTeam(value: string | null, team: LinearTeam): string {
    return value ? cycleDateInTimezone(value, team.timezone) : 'Open';
  }

  protected todayForTeam(team: LinearTeam): string {
    return todayInTimezone(team.timezone);
  }

  protected canEditCycle(cycle: LinearCycle, team: LinearTeam): boolean {
    if (!cycle.startsAt || !cycle.endsAt) return false;
    return (
      cycle.isActive || cycleDateInTimezone(cycle.endsAt, team.timezone) >= this.todayForTeam(team)
    );
  }

  protected toggleCreateCycle(team: LinearTeam): void {
    if (this.createCycleTeamId() === team.id) {
      this.createCycleTeamId.set(null);
      return;
    }
    this.error.set(null);
    this.createCycleTeamId.set(team.id);
    this.newCycleName.set('');
    this.newCycleStartDate.set(this.todayForTeam(team));
    this.newCycleEndDate.set('');
  }

  protected async createCycle(event: Event, team: LinearTeam): Promise<void> {
    event.preventDefault();
    const connection = this.selected();
    const start = this.newCycleStartDate();
    const end = this.newCycleEndDate();
    if (
      !connection ||
      this.createCycleTeamId() !== team.id ||
      !start ||
      !end ||
      end <= start ||
      this.creatingCycle()
    ) {
      if (end && start && end <= start) this.error.set('End date must be after the start date.');
      return;
    }
    this.creatingCycle.set(true);
    this.error.set(null);
    try {
      const cycle = await this.tauri.linearCreateCycle(
        connection.organizationId,
        team.id,
        this.newCycleName().trim(),
        cycleDateToIso(start, team.timezone),
        cycleDateToIso(end, team.timezone),
      );
      this.cycles.update((items) => ({
        ...items,
        [team.id]: [...(items[team.id] ?? []), cycle].sort((left, right) =>
          (left.startsAt ?? '').localeCompare(right.startsAt ?? ''),
        ),
      }));
      this.createCycleTeamId.set(null);
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.creatingCycle.set(false);
    }
  }

  protected editCycle(cycle: LinearCycle): void {
    this.error.set(null);
    this.editingCycleId.set(cycle.id);
    this.editCycleName.set(cycle.name ?? '');
    this.editCycleDescription.set(cycle.description ?? '');
    this.editCycleStartDate.set(
      cycle.startsAt ? cycleDateInTimezone(cycle.startsAt, cycle.team.timezone) : '',
    );
    this.editCycleEndDate.set(
      cycle.endsAt ? cycleDateInTimezone(cycle.endsAt, cycle.team.timezone) : '',
    );
  }

  protected async saveCycle(event: Event, cycle: LinearCycle): Promise<void> {
    event.preventDefault();
    const connection = this.selected();
    if (!connection || this.savingCycle()) return;
    this.savingCycle.set(true);
    this.error.set(null);
    try {
      const updated = await this.tauri.linearUpdateCycle(
        connection.organizationId,
        cycle.id,
        this.editCycleName().trim(),
        this.editCycleDescription(),
        this.canEditCycle(cycle, cycle.team) && !cycle.isActive
          ? cycleDateToIso(this.editCycleStartDate(), cycle.team.timezone)
          : null,
        this.canEditCycle(cycle, cycle.team)
          ? cycleDateToIso(this.editCycleEndDate(), cycle.team.timezone)
          : null,
      );
      this.cycles.update((cycles) => ({
        ...cycles,
        [cycle.team.id]: (cycles[cycle.team.id] ?? []).map((item) =>
          item.id === updated.id ? updated : item,
        ),
      }));
      this.editingCycleId.set(null);
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.savingCycle.set(false);
    }
  }

  protected async loadProjects(): Promise<void> {
    const connection = this.selected();
    if (!connection) return;
    const includeArchived = this.showArchivedProjects();
    this.projectCacheStale.set(false);
    const cacheKey = this.projectCacheKey(connection, includeArchived);
    const cached = this.readLocal<readonly LinearProject[]>(cacheKey);
    const hasCache = Array.isArray(cached);
    if (hasCache) {
      this.projects.set(cached);
      this.projectCacheStale.set(true);
    } else {
      this.projects.set([]);
    }
    try {
      const projects = await this.tauri.linearProjects(connection.organizationId, includeArchived);
      this.projects.set(projects);
      this.writeLocal(cacheKey, projects);
      this.projectCacheStale.set(false);
    } catch (error) {
      this.projectCacheStale.set(hasCache);
      this.error.set(
        hasCache
          ? 'Linear is unavailable. Showing saved projects.'
          : error instanceof Error
            ? error.message
            : String(error),
      );
    }
  }

  protected toggleArchivedProjects(): void {
    this.showArchivedProjects.update((value) => !value);
    this.selectedProject.set(null);
    this.createProjectOpen.set(false);
    void this.loadProjects();
  }

  protected async archiveSelectedProject(): Promise<void> {
    const connection = this.selected();
    const project = this.selectedProject();
    if (
      !connection ||
      !project ||
      project.archivedAt ||
      this.confirmArchiveProjectId() !== project.id ||
      this.archivingProject()
    ) {
      return;
    }
    this.archivingProject.set(true);
    this.error.set(null);
    try {
      await this.tauri.linearArchiveProject(connection.organizationId, project.id);
      this.writeLocal(this.projectCacheKey(connection), null);
      this.writeLocal(this.projectCacheKey(connection, true), null);
      this.projects.update((items) => items.filter((item) => item.id !== project.id));
      this.confirmArchiveProjectId.set(null);
      this.selectedProject.set(null);
      await this.loadProjects();
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.archivingProject.set(false);
    }
  }

  protected async unarchiveSelectedProject(): Promise<void> {
    const connection = this.selected();
    const project = this.selectedProject();
    if (!connection || !project?.archivedAt || this.archivingProject()) return;
    this.archivingProject.set(true);
    this.error.set(null);
    try {
      await this.tauri.linearUnarchiveProject(connection.organizationId, project.id);
      this.writeLocal(this.projectCacheKey(connection), null);
      this.writeLocal(this.projectCacheKey(connection, true), null);
      this.showArchivedProjects.set(false);
      this.selectedProject.set(null);
      await this.loadProjects();
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.archivingProject.set(false);
    }
  }

  protected toggleArchivedInitiatives(): void {
    this.includeArchivedInitiatives.update((includeArchived) => !includeArchived);
    void this.loadInitiatives();
  }

  protected async setInitiativeArchived(
    initiative: LinearInitiative,
    archived: boolean,
  ): Promise<void> {
    const connection = this.selected();
    if (!connection || this.busyInitiativeId()) return;
    this.busyInitiativeId.set(initiative.id);
    this.error.set(null);
    try {
      if (archived) {
        await this.tauri.linearArchiveInitiative(connection.organizationId, initiative.id);
      } else {
        await this.tauri.linearUnarchiveInitiative(connection.organizationId, initiative.id);
      }
      this.editingInitiativeId.set(null);
      await this.loadInitiatives();
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.busyInitiativeId.set(null);
    }
  }

  private async loadInitiatives(): Promise<void> {
    const connection = this.selected();
    if (!connection) return;
    try {
      this.initiatives.set(
        await this.tauri.linearInitiatives(
          connection.organizationId,
          this.includeArchivedInitiatives(),
          this.includeArchivedInitiativeUpdates(),
        ),
      );
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
    }
  }

  protected toggleInitiativeUpdate(initiative: LinearInitiative): void {
    if (this.initiativeUpdateId() === initiative.id) {
      this.initiativeUpdateId.set(null);
      this.initiativeUpdateBody.set('');
      return;
    }
    this.initiativeUpdateId.set(initiative.id);
    this.initiativeUpdateBody.set('');
    this.initiativeUpdateHealth.set('onTrack');
  }

  protected toggleArchivedInitiativeUpdates(): void {
    this.includeArchivedInitiativeUpdates.update((includeArchived) => !includeArchived);
    void this.loadInitiatives();
  }

  protected editInitiativeUpdate(update: LinearInitiativeUpdate): void {
    this.editingInitiativeUpdateId.set(update.id);
    this.editInitiativeUpdateBody.set(update.body);
    this.editInitiativeUpdateHealth.set(update.health);
  }

  protected async setInitiativeUpdateArchived(
    update: LinearInitiativeUpdate,
    archived: boolean,
  ): Promise<void> {
    const connection = this.selected();
    if (!connection || this.busyInitiativeUpdateId()) return;
    this.busyInitiativeUpdateId.set(update.id);
    this.error.set(null);
    try {
      if (archived) {
        await this.tauri.linearArchiveInitiativeUpdate(connection.organizationId, update.id);
      } else {
        await this.tauri.linearUnarchiveInitiativeUpdate(connection.organizationId, update.id);
      }
      this.editingInitiativeUpdateId.set(null);
      await this.loadInitiatives();
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.busyInitiativeUpdateId.set(null);
    }
  }

  protected async saveInitiativeUpdate(
    event: Event,
    current: LinearInitiativeUpdate,
  ): Promise<void> {
    event.preventDefault();
    const connection = this.selected();
    const body = this.editInitiativeUpdateBody().trim();
    if (!connection || !body || this.savingInitiativeUpdate()) return;
    this.savingInitiativeUpdate.set(true);
    this.error.set(null);
    try {
      const update = await this.tauri.linearUpdateInitiativeUpdate(
        connection.organizationId,
        current.id,
        body,
        this.editInitiativeUpdateHealth(),
      );
      this.initiatives.update((items) =>
        items.map((initiative) => ({
          ...initiative,
          updates: initiative.updates.map((item) => (item.id === update.id ? update : item)),
        })),
      );
      this.editingInitiativeUpdateId.set(null);
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.savingInitiativeUpdate.set(false);
    }
  }

  protected async createInitiativeUpdate(
    event: Event,
    initiative: LinearInitiative,
  ): Promise<void> {
    event.preventDefault();
    const connection = this.selected();
    const body = this.initiativeUpdateBody().trim();
    if (!connection || !body || this.creatingInitiativeUpdate()) return;
    this.creatingInitiativeUpdate.set(true);
    this.error.set(null);
    try {
      const update: LinearInitiativeUpdate = await this.tauri.linearCreateInitiativeUpdate(
        connection.organizationId,
        initiative.id,
        body,
        this.initiativeUpdateHealth(),
      );
      this.initiatives.update((items) =>
        items.map((item) =>
          item.id === initiative.id ? { ...item, updates: [update, ...item.updates] } : item,
        ),
      );
      this.initiativeUpdateId.set(null);
      this.initiativeUpdateBody.set('');
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.creatingInitiativeUpdate.set(false);
    }
  }

  protected setInitiativeProject(initiativeId: string, projectId: string): void {
    this.initiativeProjectSelection.update((selection) => ({
      ...selection,
      [initiativeId]: projectId,
    }));
  }

  protected availableInitiativeProjects(initiative: LinearInitiative): readonly LinearProject[] {
    const assigned = new Set(
      this.initiatives().flatMap((item) => item.projects.map((link) => link.project.id)),
    );
    return this.projects().filter(
      (project) =>
        !project.archivedAt &&
        (!assigned.has(project.id) ||
          initiative.projects.some((link) => link.project.id === project.id)),
    );
  }

  protected async addInitiativeProject(initiative: LinearInitiative): Promise<void> {
    const connection = this.selected();
    const projectId = this.initiativeProjectSelection()[initiative.id];
    if (!connection || !projectId || this.savingInitiativeProjectId()) return;
    this.savingInitiativeProjectId.set(initiative.id);
    this.error.set(null);
    try {
      const link = await this.tauri.linearAddProjectToInitiative(
        connection.organizationId,
        initiative.id,
        projectId,
      );
      this.initiatives.update((items) =>
        items.map((item) =>
          item.id === initiative.id ? { ...item, projects: [...item.projects, link] } : item,
        ),
      );
      this.initiativeProjectSelection.update(({ [initiative.id]: _, ...selection }) => selection);
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.savingInitiativeProjectId.set(null);
    }
  }

  protected async removeInitiativeProject(
    initiative: LinearInitiative,
    linkId: string,
  ): Promise<void> {
    const connection = this.selected();
    if (!connection || this.savingInitiativeProjectId()) return;
    this.savingInitiativeProjectId.set(initiative.id);
    this.error.set(null);
    try {
      await this.tauri.linearRemoveProjectFromInitiative(connection.organizationId, linkId);
      this.initiatives.update((items) =>
        items.map((item) =>
          item.id === initiative.id
            ? { ...item, projects: item.projects.filter((link) => link.id !== linkId) }
            : item,
        ),
      );
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.savingInitiativeProjectId.set(null);
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
    this.confirmArchiveProjectId.set(null);
    this.confirmArchiveIssueId.set(null);
    this.confirmDeleteMilestoneId.set(null);
    this.includeArchivedProjectIssues.set(false);
    this.selectedProject.set(project);
    this.projectIssues.set([]);
    this.nextProjectIssueCursor = null;
    this.projectIssuesHasNextPage.set(false);
    const connection = this.selected();
    if (connection) this.restoreProjectIssueDraft(connection, project.id);
    this.editProjectName.set(project.name);
    this.editProjectDescription.set(project.description ?? '');
    this.editProjectStartDate.set(project.startDate ?? '');
    this.editProjectTargetDate.set(project.targetDate ?? '');
    this.editProjectStatusId.set(project.status?.id ?? '');
    this.editProjectLeadId.set(project.lead?.id ?? '');
    this.projectUpdates.set([]);
    this.newProjectUpdateBody.set('');
    await Promise.all([
      this.loadProjectIssues(project.id),
      this.loadMilestones(project.id),
      this.loadProjectUpdates(project.id),
      this.canUseCodex ? this.loadCodexPolicy() : Promise.resolve(),
    ]);
  }

  protected toggleArchivedProjectIssues(): void {
    const project = this.selectedProject();
    if (!project || this.loadingProjectIssues()) return;
    this.includeArchivedProjectIssues.update((value) => !value);
    this.projectIssues.set([]);
    this.nextProjectIssueCursor = null;
    this.projectIssuesHasNextPage.set(false);
    void this.loadProjectIssues(project.id);
  }

  protected loadMoreProjectIssues(): void {
    const project = this.selectedProject();
    if (!project || !this.nextProjectIssueCursor || this.loadingProjectIssues()) return;
    void this.loadProjectIssues(project.id, this.nextProjectIssueCursor, true);
  }

  protected closeSelectedProject(): void {
    this.selectedProject.set(null);
    this.confirmArchiveProjectId.set(null);
    this.confirmDeleteMilestoneId.set(null);
    this.projectUpdates.set([]);
  }

  protected projectHealthLabel(health: LinearProjectHealth): string {
    return health === 'onTrack' ? 'On track' : health === 'atRisk' ? 'At risk' : 'Off track';
  }

  protected projectUpdateDate(createdAt: string): string {
    return new Date(createdAt).toLocaleString();
  }

  protected editProjectUpdate(update: LinearProjectUpdate): void {
    this.editingProjectUpdateId.set(update.id);
    this.editProjectUpdateBody.set(update.body);
    this.editProjectUpdateHealth.set(update.health);
  }

  protected toggleArchivedProjectUpdates(): void {
    const project = this.selectedProject();
    if (!project) return;
    this.includeArchivedProjectUpdates.update((includeArchived) => !includeArchived);
    void this.loadProjectUpdates(project.id);
  }

  protected async setProjectUpdateArchived(
    update: LinearProjectUpdate,
    archived: boolean,
  ): Promise<void> {
    const connection = this.selected();
    const project = this.selectedProject();
    if (!connection || !project || this.busyProjectUpdateId()) return;
    this.busyProjectUpdateId.set(update.id);
    this.error.set(null);
    try {
      if (archived) {
        await this.tauri.linearArchiveProjectUpdate(connection.organizationId, update.id);
      } else {
        await this.tauri.linearUnarchiveProjectUpdate(connection.organizationId, update.id);
      }
      await this.loadProjectUpdates(project.id);
      this.editingProjectUpdateId.set(null);
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.busyProjectUpdateId.set(null);
    }
  }

  protected async saveProjectUpdate(event: Event, current: LinearProjectUpdate): Promise<void> {
    event.preventDefault();
    const connection = this.selected();
    const body = this.editProjectUpdateBody().trim();
    if (!connection || !body || this.savingProjectUpdate()) return;
    this.savingProjectUpdate.set(true);
    this.error.set(null);
    try {
      const updated = await this.tauri.linearUpdateProjectUpdate(
        connection.organizationId,
        current.id,
        body,
        this.editProjectUpdateHealth(),
      );
      this.projectUpdates.update((updates) =>
        updates.map((update) => (update.id === updated.id ? updated : update)),
      );
      this.editingProjectUpdateId.set(null);
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.savingProjectUpdate.set(false);
    }
  }

  protected async createProjectUpdate(event: Event): Promise<void> {
    event.preventDefault();
    const connection = this.selected();
    const project = this.selectedProject();
    const body = this.newProjectUpdateBody().trim();
    if (!connection || !project || !body || this.creatingProjectUpdate()) return;
    this.creatingProjectUpdate.set(true);
    this.error.set(null);
    try {
      const update = await this.tauri.linearCreateProjectUpdate(
        connection.organizationId,
        project.id,
        body,
        this.newProjectUpdateHealth(),
      );
      this.projectUpdates.update((updates) => [update, ...updates]);
      this.newProjectUpdateBody.set('');
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.creatingProjectUpdate.set(false);
    }
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

  protected async deleteMilestone(milestone: LinearMilestone): Promise<void> {
    const connection = this.selected();
    if (
      !connection ||
      !this.selectedProject() ||
      this.confirmDeleteMilestoneId() !== milestone.id ||
      this.deletingMilestoneId()
    ) {
      return;
    }
    this.deletingMilestoneId.set(milestone.id);
    this.error.set(null);
    try {
      await this.tauri.linearDeleteMilestone(connection.organizationId, milestone.id);
      this.milestones.update((items) => items.filter((item) => item.id !== milestone.id));
      if (this.editingMilestoneId() === milestone.id) this.editingMilestoneId.set(null);
      this.confirmDeleteMilestoneId.set(null);
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.deletingMilestoneId.set(null);
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
      this.writeLocal(
        this.projectCacheKey(connection, this.showArchivedProjects()),
        this.projects(),
      );
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
      this.writeLocal(
        this.projectCacheKey(connection, this.showArchivedProjects()),
        this.projects(),
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
      const connection = this.selected();
      if (connection) {
        try {
          project = (await this.tauri.linearProjects(connection.organizationId, true)).find(
            (entry) => entry.id === projectId,
          );
        } catch (error) {
          this.error.set(error instanceof Error ? error.message : String(error));
        }
      }
    }
    if (project) {
      this.section.set('projects');
      await this.openProject(project);
    }
  }

  private async loadSection(connection: LinearConnection): Promise<void> {
    if (this.section() === 'labels') await this.loadLabels(connection);
    if (this.section() === 'projects') await this.loadProjects();
    if (this.section() === 'roadmap') {
      await Promise.all([this.loadInitiatives(), this.loadProjects()]);
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

  private async loadLabels(connection: LinearConnection): Promise<void> {
    try {
      const labels = await this.tauri.linearIssueLabels(connection.organizationId);
      if (this.selected()?.organizationId === connection.organizationId) this.labels.set(labels);
    } catch (error) {
      if (this.selected()?.organizationId === connection.organizationId) {
        this.error.set(error instanceof Error ? error.message : String(error));
      }
    }
  }

  private async loadProjectIssues(
    projectId: string,
    after: string | null = null,
    append = false,
  ): Promise<void> {
    const connection = this.selected();
    if (!connection) return;
    const request = ++this.projectIssuesRequest;
    this.loadingProjectIssues.set(true);
    try {
      const page = await this.tauri.linearProjectIssues(
        connection.organizationId,
        projectId,
        after,
        this.includeArchivedProjectIssues(),
      );
      if (request === this.projectIssuesRequest && this.selectedProject()?.id === projectId) {
        this.projectIssues.update((items) => (append ? [...items, ...page.issues] : page.issues));
        this.nextProjectIssueCursor = page.endCursor;
        this.projectIssuesHasNextPage.set(page.hasNextPage);
      }
    } catch (error) {
      if (request === this.projectIssuesRequest) {
        this.error.set(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (request === this.projectIssuesRequest) this.loadingProjectIssues.set(false);
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

  private async loadProjectUpdates(projectId: string): Promise<void> {
    const connection = this.selected();
    if (!connection) return;
    try {
      this.projectUpdates.set(
        await this.tauri.linearProjectUpdates(
          connection.organizationId,
          projectId,
          this.includeArchivedProjectUpdates(),
        ),
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
        null,
        null,
        null,
        this.newEstimate() === '' ? undefined : Number(this.newEstimate()),
      );
      this.newTitle.set('');
      this.newDescription.set('');
      this.newEstimate.set('');
      this.writeLocal(this.issueDraftKey(connection.organizationId), null);
      if (!this.issueTeamId() || this.issueTeamId() === created.team.id) {
        this.issues.update((issues) => [created, ...issues]);
        this.saveIssueCache(connection);
      }
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
        null,
        this.newProjectIssueEstimate() === '' ? undefined : Number(this.newProjectIssueEstimate()),
      );
      this.projectIssues.update((issues) => [issue, ...issues]);
      this.newProjectIssueTitle.set('');
      this.newProjectIssueDescription.set('');
      this.newProjectIssueMilestoneId.set('');
      this.newProjectIssueEstimate.set('');
      this.writeLocal(this.projectIssueDraftKey(connection.organizationId, project.id), null);
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
      this.writeLocal(this.issueCacheKey(connection), null);
      this.writeLocal(this.projectCacheKey(connection), null);
      this.writeLocal(this.projectCacheKey(connection, true), null);
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

  protected async updateDueDate(issue: LinearIssue, dueDate: string): Promise<void> {
    if (dueDate === (issue.dueDate ?? '')) return;
    await this.saveIssueUpdate(issue, dueDate ? { dueDate } : { clearDueDate: true });
  }

  protected async updateEstimate(issue: LinearIssue, estimate: string): Promise<void> {
    if (estimate === '') {
      if (issue.estimate == null) return;
      await this.saveIssueUpdate(issue, { clearEstimate: true });
      return;
    }
    const value = Number(estimate);
    if (!Number.isInteger(value) || value === issue.estimate) return;
    await this.saveIssueUpdate(issue, { estimate: value });
  }

  protected async updateAssignee(issue: LinearIssue, assigneeId: string): Promise<void> {
    if (assigneeId === (issue.assignee?.id ?? '')) return;
    await this.saveIssueUpdate(issue, assigneeId ? { assigneeId } : { clearAssignee: true });
  }

  protected async updateCycle(issue: LinearIssue, cycleId: string): Promise<void> {
    if (cycleId === (issue.cycle?.id ?? '')) return;
    await this.saveIssueUpdate(issue, cycleId ? { cycleId } : { clearCycle: true });
  }

  protected async updateProject(issue: LinearIssue, projectId: string): Promise<void> {
    const saved = await this.saveIssueUpdate(
      issue,
      projectId ? { projectId, clearProjectMilestone: true } : { clearProject: true },
    );
    if (!saved) return;
    if (projectId) await this.loadMilestones(projectId);
    else this.milestones.set([]);
  }

  protected async updateIssueMilestone(
    issue: LinearIssue,
    projectMilestoneId: string,
  ): Promise<void> {
    if (projectMilestoneId === (issue.projectMilestone?.id ?? '')) return;
    await this.saveIssueUpdate(
      issue,
      projectMilestoneId ? { projectMilestoneId } : { clearProjectMilestone: true },
    );
  }

  protected labelsFor(teamId: string): readonly LinearLabel[] {
    return this.labels().filter((label) => !label.team?.id || label.team.id === teamId);
  }

  protected editLabel(label: LinearLabel): void {
    this.error.set(null);
    this.editingLabelId.set(label.id);
    this.editLabelName.set(label.name);
    this.editLabelColor.set(label.color ?? '#6b7280');
  }

  protected async createLabel(event: Event): Promise<void> {
    event.preventDefault();
    const connection = this.selected();
    const name = this.newLabelName().trim();
    if (!connection || !name || this.creatingLabel()) return;
    this.creatingLabel.set(true);
    this.error.set(null);
    try {
      const label = await this.tauri.linearCreateIssueLabel(
        connection.organizationId,
        name,
        this.newLabelColor(),
        this.newLabelTeamId() || null,
      );
      if (this.selected()?.organizationId === connection.organizationId) {
        this.labels.update((items) => [...items, label]);
      }
      this.newLabelName.set('');
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.creatingLabel.set(false);
    }
  }

  protected async saveLabel(event: Event, label: LinearLabel): Promise<void> {
    event.preventDefault();
    const connection = this.selected();
    const name = this.editLabelName().trim();
    if (!connection || this.editingLabelId() !== label.id || !name || this.savingLabel()) {
      return;
    }
    this.savingLabel.set(true);
    this.error.set(null);
    try {
      const updated = await this.tauri.linearUpdateIssueLabel(
        connection.organizationId,
        label.id,
        name,
        this.editLabelColor(),
      );
      if (this.selected()?.organizationId === connection.organizationId) {
        this.labels.update((items) =>
          items.map((item) => (item.id === updated.id ? updated : item)),
        );
        for (const issue of [...this.issues(), ...this.projectIssues()]) {
          if (issue.labels.some((item) => item.id === updated.id)) {
            this.applyUpdatedIssue(connection.organizationId, {
              ...issue,
              labels: issue.labels.map((item) => (item.id === updated.id ? updated : item)),
            });
          }
        }
      }
      this.editingLabelId.set(null);
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.savingLabel.set(false);
    }
  }

  protected async deleteLabel(label: LinearLabel): Promise<void> {
    const connection = this.selected();
    if (!connection || this.confirmDeleteLabelId() !== label.id || this.deletingLabelId()) {
      return;
    }
    this.deletingLabelId.set(label.id);
    this.error.set(null);
    try {
      await this.tauri.linearDeleteIssueLabel(connection.organizationId, label.id);
      if (this.selected()?.organizationId === connection.organizationId) {
        this.labels.update((items) => items.filter((item) => item.id !== label.id));
        for (const issue of [...this.issues(), ...this.projectIssues()]) {
          if (issue.labels.some((item) => item.id === label.id)) {
            this.applyUpdatedIssue(connection.organizationId, {
              ...issue,
              labels: issue.labels.filter((item) => item.id !== label.id),
            });
          }
        }
        this.confirmDeleteLabelId.set(null);
      }
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.deletingLabelId.set(null);
    }
  }

  protected async updateLabels(issue: LinearIssue, event: Event): Promise<void> {
    const select = event.target as HTMLSelectElement;
    await this.saveIssueUpdate(issue, {
      labelIds: Array.from(select.selectedOptions, (option) => option.value),
    });
  }

  private async saveIssueUpdate(issue: LinearIssue, update: LinearIssueUpdate): Promise<boolean> {
    const connection = this.selected();
    if (!connection) return false;
    const combined = this.queueIssueUpdate(connection.organizationId, issue.id, update);
    try {
      const updated = await this.tauri.linearUpdateIssue(
        connection.organizationId,
        issue.id,
        combined,
      );
      this.removePendingIssueUpdate(connection.organizationId, issue.id);
      this.applyUpdatedIssue(connection.organizationId, updated);
      return true;
    } catch (error) {
      this.queueIssueUpdate(connection.organizationId, issue.id, update);
      this.error.set(error instanceof Error ? error.message : String(error));
      return false;
    }
  }

  protected async retryPendingIssueUpdates(): Promise<void> {
    const connection = this.selected();
    if (!connection || this.retryingIssueUpdates()) return;
    this.retryingIssueUpdates.set(true);
    this.error.set(null);
    try {
      for (const pending of [...this.pendingIssueUpdates()]) {
        try {
          const updated = await this.tauri.linearUpdateIssue(
            connection.organizationId,
            pending.issueId,
            pending.update,
          );
          this.removePendingIssueUpdate(connection.organizationId, pending.issueId);
          this.applyUpdatedIssue(connection.organizationId, updated);
        } catch (error) {
          this.error.set(error instanceof Error ? error.message : String(error));
        }
      }
    } finally {
      this.retryingIssueUpdates.set(false);
    }
  }

  protected async loadIssues(): Promise<void> {
    const connection = this.selected();
    if (!connection || this.loading()) return;
    const cached = this.readLocal<LinearIssuePage>(this.issueCacheKey(connection));
    const hasCache = !!cached && Array.isArray(cached.issues);
    if (hasCache && cached) {
      this.issues.set(cached.issues);
      this.nextCursor = typeof cached.endCursor === 'string' ? cached.endCursor : null;
      this.hasNextPage.set(cached.hasNextPage === true);
      this.issueCacheStale.set(true);
    }
    this.loading.set(true);
    this.error.set(null);
    try {
      const page = await this.fetchIssues(connection.organizationId);
      this.issues.set(page.issues);
      this.nextCursor = page.endCursor;
      this.hasNextPage.set(page.hasNextPage);
      this.saveIssueCache(connection);
      this.issueCacheStale.set(false);
    } catch (error) {
      this.issueCacheStale.set(hasCache);
      this.error.set(
        hasCache
          ? 'Linear is unavailable. Showing saved issues.'
          : error instanceof Error
            ? error.message
            : String(error),
      );
    } finally {
      this.loading.set(false);
    }
  }

  protected async loadMore(): Promise<void> {
    const connection = this.selected();
    if (!connection || !this.nextCursor || this.loading()) return;
    this.loading.set(true);
    try {
      const page = await this.fetchIssues(connection.organizationId, this.nextCursor);
      this.issues.update((issues) => [...issues, ...page.issues]);
      this.nextCursor = page.endCursor;
      this.hasNextPage.set(page.hasNextPage);
      this.saveIssueCache(connection);
    } catch (error) {
      this.issueCacheStale.set(true);
      this.error.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.loading.set(false);
    }
  }

  private fetchIssues(organizationId: string, after: string | null = null) {
    const teamId = this.issueTeamId();
    return teamId
      ? this.tauri.linearTeamIssues(organizationId, teamId, after, this.includeArchivedIssues())
      : this.tauri.linearMyIssues(organizationId, after, this.includeArchivedIssues());
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
