import { Fragment, useLayoutEffect } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { when } from '@/lib/jsx';
import { useController, useSignals } from '@/lib/signals';
import { DestroyRef } from '@/lib/signals';
import { inject } from '@/lib/inject';
import { computed, signal, type WritableSignal } from '@/lib/signals';

import { NexusAccount } from '@/core/nexus-account';
import { currentSurface } from '@/core/surface';
import {
  type LinearCodexContext,
  type LinearCodexLink,
  type LinearComment,
  TauriBridge,
  type LinearConnection,
  type LinearCycle,
  type LinearDocument,
  type LinearExternalLink,
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
  type LinearProjectResources,
  type LinearProjectStatus,
  type LinearProjectUpdate,
  type LinearPerson,
  type LinearTeam,
  type LinearWorkflowState,
  type WorkspaceSummary,
  type GithubRepositorySummary,
} from '@/core/tauri';
import {
  codexFailureRestoreTarget,
  isLinearCycleDraft,
  isLinearCycleEditDraft,
  isLinearCommentDraft,
  isLinearInitiativeDraft,
  isLinearInitiativeEditDraft,
  isLinearInitiativeUpdateDraft,
  isLinearStatusUpdateEditDraft,
  isLinearIssueRelationDraft,
  isLinearIssueLabelDraft,
  isLinearLabelEditDraft,
  isLinearIssueDetailsDraft,
  isLinearMilestoneEditDraft,
  isLinearProjectDraft,
  isLinearOrganizationCacheKey,
  isLinearProjectDocumentDraft,
  isLinearProjectDocumentCreateDraft,
  isLinearProjectEditDraft,
  isLinearProjectLinkDraft,
  isPendingLinearIssueUpdate,
  linearCommentDraftConflicts,
  linearIssueDetailsDraftConflicts,
  linearProjectDocumentDraftConflicts,
  linearIssueConflicts,
  linearIssueValues,
  linearEstimateOptions,
  linearCodexPrompt,
  linearProjectIssueCacheKey,
  isLinearProjectPlanningDraft,
  linearCycleEditDraftConflicts,
  linearCycleEditValuesEqual,
  linearInitiativeEditDraftConflicts,
  linearInitiativeEditValues,
  linearInitiativeEditValuesEqual,
  linearStatusUpdateEditDraftConflicts,
  linearStatusUpdateEditValuesEqual,
  linearLabelEditDraftConflicts,
  linearLabelEditValuesEqual,
  mergeLinearIssueUpdates,
  type LinearIssueUpdate,
  type LinearCycleDraft,
  type LinearCycleEditDraft,
  type LinearCycleEditValues,
  type PendingLinearIssueUpdate,
  type LinearProjectDocumentDraft,
  type LinearProjectDocumentCreateDraft,
  type LinearProjectLinkDraft,
  type LinearInitiativeDraft,
  type LinearInitiativeEditDraft,
  type LinearInitiativeEditValues,
  type LinearInitiativeUpdateDraft,
  type LinearStatusUpdateEditDraft,
  type LinearIssueRelationDraft,
  type LinearIssueLabelDraft,
  type LinearLabelEditDraft,
  type LinearLabelEditValues,
  type LinearIssueDetailsDraft,
  type LinearMilestoneEditDraft,
  type LinearMilestoneEditValues,
  type LinearProjectDraft,
  type LinearProjectEditDraft,
  type LinearProjectEditValues,
  type LinearProjectPlanningDraft,
  linearProjectEditDraftConflicts,
  linearProjectEditValues,
  linearProjectEditValuesEqual,
  linearMilestoneEditDraftConflicts,
  linearMilestoneEditValues,
  linearMilestoneEditValuesEqual,
} from './linear-state';
import { cycleDateInTimezone, cycleDateToIso, todayInTimezone } from './cycle-dates';

interface LinearIssueDraft {
  teamId: string;
  title: string;
  description: string;
  milestoneId?: string;
  estimate?: string;
  assigneeId?: string;
  priority?: string;
  dueDate?: string;
  labelIds?: readonly string[];
  stateId?: string;
  cycleId?: string;
}

function isLinearTeamList(value: unknown): value is readonly LinearTeam[] {
  return (
    Array.isArray(value) &&
    value.every(
      (team: unknown) =>
        !!team &&
        typeof team === 'object' &&
        typeof (team as LinearTeam).id === 'string' &&
        typeof (team as LinearTeam).name === 'string' &&
        typeof (team as LinearTeam).key === 'string',
    )
  );
}

import './linear.css';

export class LinearState {
  readonly projectRequest = signal<{ organizationId: string; projectId: string } | null>(null);
  onProjectRequestHandled: (value: { organizationId: string; projectId: string }) => void = () =>
    undefined;

  private readonly tauri = inject(TauriBridge);
  readonly nexus = inject(NexusAccount);
  readonly destroyRef = new DestroyRef();
  readonly canUseCodex = this.tauri.available && currentSurface() === 'main';

  readonly connections = signal<readonly LinearConnection[]>([]);
  readonly selected = signal<LinearConnection | null>(null);
  readonly confirmDisconnectOrganizationId = signal<string | null>(null);
  readonly disconnectingOrganizationId = signal<string | null>(null);
  readonly issues = signal<readonly LinearIssue[]>([]);
  readonly includeArchivedIssues = signal(false);
  readonly issueStateId = signal('');
  readonly issuePriority = signal('');
  readonly issueAssigneeId = signal('');
  readonly issueLabelId = signal('');
  readonly issueCycleId = signal('');
  readonly confirmArchiveIssueId = signal<string | null>(null);
  readonly confirmArchiveIssueDetailId = signal<string | null>(null);
  readonly archivingIssueId = signal<string | null>(null);
  readonly issueDetail = signal<LinearIssueDetail | null>(null);
  readonly issueDetailStale = signal(false);
  readonly creatingIssueRelation = signal(false);
  readonly relatedIssueIdentifier = signal('');
  readonly newIssueRelationType = signal<LinearIssueRelationType>('blocks');
  readonly confirmDeleteIssueRelationId = signal<string | null>(null);
  readonly deletingIssueRelationId = signal<string | null>(null);
  readonly editingIssueDetailsId = signal<string | null>(null);
  readonly editIssueTitle = signal('');
  readonly editIssueDescription = signal('');
  readonly issueDetailsDraftConflict = signal(false);
  readonly hasIssueDetailsDraft = signal(false);
  readonly savingIssueDetails = signal(false);
  readonly codexContext = signal<LinearCodexContext | null>(null);
  readonly codexRequest = signal<{
    readonly issue: LinearIssue;
    readonly continueThread: boolean;
  } | null>(null);
  readonly codexWorkspaces = signal<readonly WorkspaceSummary[]>([]);
  readonly selectedCodexWorkspacePath = signal('');
  readonly selectedCodexProjectRepo = signal('');
  readonly projectIssues = signal<readonly LinearIssue[]>([]);
  readonly projectIssueCacheStale = signal(false);
  readonly projectIssueSearchInput = signal('');
  readonly projectIssueSearchTerm = signal('');
  readonly projectIssueStateId = signal('');
  readonly projectIssuePriority = signal('');
  readonly projectIssueAssigneeId = signal('');
  readonly projectIssueLabelId = signal('');
  readonly includeArchivedProjectIssues = signal(false);
  readonly loadingProjectIssues = signal(false);
  readonly projectIssuesHasNextPage = signal(false);
  readonly milestones = signal<readonly LinearMilestone[]>([]);
  readonly projectResources = signal<LinearProjectResources>({
    documents: [],
    externalLinks: [],
  });
  readonly editingProjectDocumentId = signal<string | null>(null);
  readonly loadingProjectDocumentId = signal<string | null>(null);
  readonly editProjectDocumentTitle = signal('');
  readonly editProjectDocumentContent = signal('');
  readonly editProjectDocumentUpdatedAt = signal('');
  readonly projectDocumentEditConflict = signal(false);
  readonly projectDocumentEditOffline = signal(false);
  readonly savingProjectDocument = signal(false);
  readonly newProjectDocumentTitle = signal('');
  readonly newProjectDocumentContent = signal('');
  readonly creatingProjectDocument = signal(false);
  readonly newProjectLinkLabel = signal('');
  readonly newProjectLinkUrl = signal('');
  readonly creatingProjectLink = signal(false);
  readonly githubRepositoriesForLink = signal<readonly GithubRepositorySummary[] | null>(null);
  readonly loadingGithubRepositories = signal(false);
  readonly selectedGithubRepository = signal('');
  readonly creatingGithubProjectLink = signal(false);
  readonly availableGithubRepositories = computed(() => {
    const links = new Set(
      this.projectResources().externalLinks.map((link) =>
        link.url.replace(/\/$/, '').toLowerCase(),
      ),
    );
    return (this.githubRepositoriesForLink() ?? []).filter(
      (repository) => !links.has(repository.htmlUrl.replace(/\/$/, '').toLowerCase()),
    );
  });
  readonly confirmDeleteProjectLinkId = signal<string | null>(null);
  readonly deletingProjectLinkId = signal<string | null>(null);
  readonly projectUpdates = signal<readonly LinearProjectUpdate[]>([]);
  readonly newProjectUpdateBody = signal('');
  readonly newProjectUpdateHealth = signal<LinearProjectHealth>('onTrack');
  readonly creatingProjectUpdate = signal(false);
  readonly editingProjectUpdateId = signal<string | null>(null);
  readonly editProjectUpdateBody = signal('');
  readonly editProjectUpdateHealth = signal<LinearProjectHealth>('onTrack');
  readonly savingProjectUpdate = signal(false);
  readonly projectUpdateEditDraftConflict = signal(false);
  readonly hasProjectUpdateEditDraft = signal(false);
  private readonly projectUpdateEditBase = signal<LinearInitiativeUpdateDraft | null>(null);
  readonly includeArchivedProjectUpdates = signal(false);
  readonly busyProjectUpdateId = signal<string | null>(null);
  readonly confirmArchiveProjectUpdateId = signal<string | null>(null);
  readonly projects = signal<readonly LinearProject[]>([]);
  readonly projectStatuses = signal<readonly LinearProjectStatus[]>([]);
  readonly initiatives = signal<readonly LinearInitiative[]>([]);
  readonly initiativeUpdateId = signal<string | null>(null);
  readonly initiativeUpdateBody = signal('');
  readonly initiativeUpdateHealth = signal<LinearProjectHealth>('onTrack');
  readonly creatingInitiativeUpdate = signal(false);
  readonly editingInitiativeUpdateId = signal<string | null>(null);
  readonly editInitiativeUpdateBody = signal('');
  readonly editInitiativeUpdateHealth = signal<LinearProjectHealth>('onTrack');
  readonly savingInitiativeUpdate = signal(false);
  readonly initiativeUpdateEditDraftConflict = signal(false);
  readonly hasInitiativeUpdateEditDraft = signal(false);
  private readonly initiativeUpdateEditBase = signal<LinearInitiativeUpdateDraft | null>(null);
  readonly busyInitiativeUpdateId = signal<string | null>(null);
  readonly confirmArchiveInitiativeUpdateId = signal<string | null>(null);
  readonly includeArchivedInitiativeUpdates = signal(false);
  readonly includeArchivedInitiatives = signal(false);
  readonly busyInitiativeId = signal<string | null>(null);
  readonly confirmArchiveInitiativeId = signal<string | null>(null);
  readonly newInitiativeName = signal('');
  readonly newInitiativeDescription = signal('');
  readonly newInitiativeTargetDate = signal('');
  readonly editingInitiativeId = signal<string | null>(null);
  readonly editInitiativeName = signal('');
  readonly editInitiativeDescription = signal('');
  readonly editInitiativeTargetDate = signal('');
  readonly savingInitiative = signal(false);
  readonly initiativeEditDraftConflict = signal(false);
  readonly hasInitiativeEditDraft = signal(false);
  private readonly initiativeEditBase = signal<LinearInitiativeEditValues | null>(null);
  readonly initiativeProjectSelection = signal<Readonly<Record<string, string>>>({});
  readonly savingInitiativeProjectId = signal<string | null>(null);
  readonly confirmRemoveInitiativeProjectId = signal<string | null>(null);
  readonly cycles = signal<Readonly<Record<string, readonly LinearCycle[]>>>({});
  readonly createCycleTeamId = signal<string | null>(null);
  readonly newCycleName = signal('');
  readonly newCycleStartDate = signal('');
  readonly newCycleEndDate = signal('');
  readonly creatingCycle = signal(false);
  readonly editingCycleId = signal<string | null>(null);
  readonly editCycleName = signal('');
  readonly editCycleDescription = signal('');
  readonly editCycleStartDate = signal('');
  readonly editCycleEndDate = signal('');
  readonly savingCycle = signal(false);
  readonly cycleEditDraftConflict = signal(false);
  readonly hasCycleEditDraft = signal(false);
  private readonly cycleEditBase = signal<LinearCycleEditValues | null>(null);
  readonly selectedProject = signal<LinearProject | null>(null);
  readonly showArchivedProjects = signal(false);
  readonly confirmArchiveProjectId = signal<string | null>(null);
  readonly archivingProject = signal(false);
  readonly createProjectOpen = signal(false);
  readonly newProjectName = signal('');
  readonly newProjectDescription = signal('');
  readonly newProjectStartDate = signal('');
  readonly newProjectTargetDate = signal('');
  readonly newProjectStatusId = signal('');
  readonly newProjectLeadId = signal('');
  readonly newProjectTeamIds = signal<readonly string[]>([]);
  readonly editProjectName = signal('');
  readonly editProjectDescription = signal('');
  readonly editProjectStartDate = signal('');
  readonly editProjectTargetDate = signal('');
  readonly editProjectStatusId = signal('');
  readonly editProjectLeadId = signal('');
  readonly editProjectTeamIds = signal<readonly string[]>([]);
  readonly projectEditDraftConflict = signal(false);
  readonly hasProjectEditDraft = signal(false);
  readonly newMilestoneName = signal('');
  readonly newMilestoneDescription = signal('');
  readonly newMilestoneDate = signal('');
  readonly newProjectIssueTitle = signal('');
  readonly newProjectIssueDescription = signal('');
  readonly newProjectIssueMilestoneId = signal('');
  readonly newProjectIssueEstimate = signal('');
  readonly newProjectIssueAssigneeId = signal('');
  readonly newProjectIssuePriority = signal('');
  readonly newProjectIssueDueDate = signal('');
  readonly newProjectIssueLabelIds = signal<readonly string[]>([]);
  readonly newProjectIssueStateId = signal('');
  readonly newProjectIssueCycleId = signal('');
  readonly newEstimate = signal('');
  readonly newAssigneeId = signal('');
  readonly newPriority = signal('');
  readonly newDueDate = signal('');
  readonly newLabelIds = signal<readonly string[]>([]);
  readonly newStateId = signal('');
  readonly newCycleId = signal('');
  readonly newSubIssueTitle = signal('');
  readonly newComment = signal('');
  readonly editingCommentId = signal<string | null>(null);
  readonly editCommentBody = signal('');
  readonly commentEditConflict = signal(false);
  readonly savingComment = signal(false);
  readonly deletingCommentId = signal<string | null>(null);
  readonly confirmDeleteCommentId = signal<string | null>(null);
  readonly editingMilestoneId = signal<string | null>(null);
  readonly loadingMilestoneId = signal<string | null>(null);
  readonly editMilestoneName = signal('');
  readonly editMilestoneDescription = signal('');
  readonly editMilestoneDate = signal('');
  readonly milestoneEditDraftConflict = signal(false);
  readonly hasMilestoneEditDraft = signal(false);
  private readonly milestoneEditBase = signal<LinearMilestoneEditValues | null>(null);
  readonly section = signal<'work' | 'projects' | 'cycles' | 'roadmap' | 'labels'>('work');
  readonly teams = signal<readonly LinearTeam[]>([]);
  readonly users = signal<readonly LinearPerson[]>([]);
  readonly labels = signal<readonly LinearLabel[]>([]);
  readonly newLabelName = signal('');
  readonly newLabelTeamId = signal('');
  readonly newLabelColor = signal('#6b7280');
  readonly creatingLabel = signal(false);
  readonly editingLabelId = signal<string | null>(null);
  readonly editLabelName = signal('');
  readonly editLabelColor = signal('#6b7280');
  readonly savingLabel = signal(false);
  readonly labelEditDraftConflict = signal(false);
  readonly hasLabelEditDraft = signal(false);
  private readonly labelEditBase = signal<LinearLabelEditValues | null>(null);
  readonly confirmDeleteLabelId = signal<string | null>(null);
  readonly deletingLabelId = signal<string | null>(null);
  readonly workflowStates = signal<Readonly<Record<string, readonly LinearWorkflowState[]>>>({});
  readonly createTeamId = signal('');
  readonly issueTeamId = signal('');
  readonly issueSearchInput = signal('');
  readonly issueSearchTerm = signal('');
  readonly newTitle = signal('');
  readonly newDescription = signal('');
  readonly hasNextPage = signal(false);
  readonly error = signal<string | null>(null);
  readonly issueCacheStale = signal(false);
  readonly projectCacheStale = signal(false);
  readonly pendingIssueUpdates = signal<readonly PendingLinearIssueUpdate[]>([]);
  readonly retryingIssueUpdates = signal(false);
  readonly conflictedIssueUpdates = computed(() =>
    this.pendingIssueUpdates().filter((pending) => pending.conflicts?.length),
  );
  readonly pending = signal(false);
  readonly syncing = signal(false);
  readonly oauthConfigured = signal(false);
  readonly loading = signal(false);
  readonly creating = signal(false);
  readonly creatingProject = signal(false);
  readonly savingProject = signal(false);
  readonly creatingMilestone = signal(false);
  readonly savingMilestone = signal(false);
  readonly confirmDeleteMilestoneId = signal<string | null>(null);
  readonly deletingMilestoneId = signal<string | null>(null);
  readonly creatingProjectIssue = signal(false);
  readonly creatingSubIssue = signal(false);
  readonly sendingComment = signal(false);
  readonly codexPending = signal(false);
  private nextCursor: string | null = null;
  private nextProjectIssueCursor: string | null = null;
  private projectIssuesRequest = 0;
  private projectOpenRequest = 0;
  private projectsRequest = 0;
  private issueDetailRequest = 0;
  private issueDetailsEditRequest = 0;
  private initiativeRequest = 0;
  private projectUpdatesRequest = 0;
  private milestoneRequest = 0;
  private milestoneEditRequest = 0;

  pageTitle(): string {
    return {
      work: 'My work',
      projects: 'Projects',
      cycles: 'Cycles',
      roadmap: 'Roadmap',
      labels: 'Labels',
    }[this.section()];
  }

  pageDescription(): string {
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
    this.destroyRef.effect(() => {
      this.nexus.status();
      const request = this.projectRequest();
      if (request) void this.openRequestedProject(request);
      else void this.refreshConnections();
    });
    this.destroyRef.effect(() => {
      const connection = this.selected();
      const detail = this.issueDetail();
      if (connection && detail) {
        this.writeLocal(this.issueDetailCacheKey(connection, detail.issue.id), detail);
      }
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

  async connect(): Promise<void> {
    this.error.set(null);
    this.pending.set(true);
    try {
      await this.tauri.linearConnectStart();
    } catch (error) {
      this.pending.set(false);
      this.error.set(error instanceof Error ? error.message : String(error));
    }
  }

  async cancelConnect(): Promise<void> {
    try {
      await this.tauri.linearConnectCancel();
      this.pending.set(false);
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
    }
  }

  private async openRequestedProject(request: { organizationId: string; projectId: string }) {
    const requestId = ++this.projectOpenRequest;
    this.error.set(null);
    try {
      await this.refreshConnections(request.organizationId, requestId);
      if (requestId !== this.projectOpenRequest) return;
      const connection = this.selected();
      if (!connection || connection.organizationId !== request.organizationId) {
        throw new Error('Reconnect this Linear workspace on this device to open the project.');
      }
      const project = (await this.tauri.linearProjects(connection.organizationId, true)).find(
        (item) => item.id === request.projectId,
      );
      if (!project) throw new Error('This Linear project is no longer available.');
      if (requestId !== this.projectOpenRequest) return;
      this.section.set('projects');
      await this.openProject(project);
    } catch (error) {
      if (requestId === this.projectOpenRequest) {
        this.error.set(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (requestId === this.projectOpenRequest) this.onProjectRequestHandled(request);
    }
  }

  async syncSelected(): Promise<void> {
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

  select(connection: LinearConnection): void {
    if (connection.pausedOnDevice) return;
    this.projectsRequest++;
    this.issueDetailRequest++;
    this.selected.set(connection);
    this.selectedProject.set(null);
    this.createProjectOpen.set(false);
    this.projectIssues.set([]);
    this.nextProjectIssueCursor = null;
    this.projectIssuesHasNextPage.set(false);
    this.projectIssuesRequest++;
    this.loadingProjectIssues.set(false);
    this.issueTeamId.set('');
    this.issueAssigneeId.set('');
    this.issueLabelId.set('');
    this.issueCycleId.set('');
    this.issueStateId.set('');
    this.cycles.set({});
    this.restoreIssueDraft(connection);
    this.restoreInitiativeDraft(connection);
    this.restoreIssueLabelDraft(connection);
    this.restorePendingIssueUpdates(connection);
    this.issueCacheStale.set(false);
    this.projectCacheStale.set(false);
    this.issues.set([]);
    this.issueDetail.set(null);
    this.confirmArchiveIssueId.set(null);
    this.confirmArchiveIssueDetailId.set(null);
    this.confirmDeleteIssueRelationId.set(null);
    this.editingLabelId.set(null);
    this.confirmDeleteLabelId.set(null);
    this.codexContext.set(null);
    this.nextCursor = null;
    void this.loadTeams(connection);
    void this.loadIssues();
    void this.loadSection(connection);
  }

  teamName(teamId: string): string {
    return this.teams().find((team) => team.id === teamId)?.name ?? 'Team';
  }

  setIssueTeam(teamId: string): void {
    if (this.loading() || teamId === this.issueTeamId()) return;
    this.issueTeamId.set(teamId);
    if (!teamId) this.issueAssigneeId.set('');
    this.issueCycleId.set('');
    if (teamId && !this.labelsFor(teamId).some((label) => label.id === this.issueLabelId())) {
      this.issueLabelId.set('');
    }
    if (teamId && !this.statesForTeam(teamId).some((state) => state.id === this.issueStateId())) {
      this.issueStateId.set('');
    }
    this.confirmArchiveIssueId.set(null);
    this.nextCursor = null;
    this.hasNextPage.set(false);
    this.issues.set([]);
    const connection = this.selected();
    if (connection && teamId) void this.loadTeamCycles(connection, teamId);
    void this.loadIssues();
  }

  setIssueStateFilter(stateId: string): void {
    if (this.loading() || stateId === this.issueStateId()) return;
    this.issueStateId.set(stateId);
    this.resetIssuePage();
    void this.loadIssues();
  }

  setIssuePriorityFilter(priority: string): void {
    if (this.loading() || priority === this.issuePriority()) return;
    this.issuePriority.set(priority);
    this.resetIssuePage();
    void this.loadIssues();
  }

  setIssueAssigneeFilter(assigneeId: string): void {
    if (this.loading() || assigneeId === this.issueAssigneeId()) return;
    this.issueAssigneeId.set(assigneeId);
    this.resetIssuePage();
    void this.loadIssues();
  }

  setIssueLabelFilter(labelId: string): void {
    if (this.loading() || labelId === this.issueLabelId()) return;
    this.issueLabelId.set(labelId);
    this.resetIssuePage();
    void this.loadIssues();
  }

  setIssueCycleFilter(cycleId: string): void {
    if (this.loading() || cycleId === this.issueCycleId()) return;
    this.issueCycleId.set(cycleId);
    this.resetIssuePage();
    void this.loadIssues();
  }

  issueFilterCount(): number {
    return (
      Number(!!this.issueStateId()) +
      Number(!!this.issuePriority()) +
      Number(!!this.issueTeamId() && !!this.issueAssigneeId()) +
      Number(!!this.issueLabelId()) +
      Number(!!this.issueTeamId() && !!this.issueCycleId())
    );
  }

  private resetIssuePage(): void {
    this.issues.set([]);
    this.nextCursor = null;
    this.hasNextPage.set(false);
  }

  searchIssues(event: Event): void {
    event.preventDefault();
    const search = this.issueSearchInput().trim();
    if (this.loading() || search === this.issueSearchTerm()) return;
    this.issueSearchTerm.set(search);
    this.issues.set([]);
    this.nextCursor = null;
    this.hasNextPage.set(false);
    void this.loadIssues();
  }

  clearIssueSearch(): void {
    if (this.loading() || !this.issueSearchTerm()) return;
    this.issueSearchInput.set('');
    this.issueSearchTerm.set('');
    this.issues.set([]);
    this.nextCursor = null;
    this.hasNextPage.set(false);
    void this.loadIssues();
  }

  toggleArchivedIssues(): void {
    if (this.loading()) return;
    this.includeArchivedIssues.update((value) => !value);
    this.issues.set([]);
    this.nextCursor = null;
    this.hasNextPage.set(false);
    void this.loadIssues();
  }

  async setIssueArchived(issue: LinearIssue, archived: boolean, fromDetail = false): Promise<void> {
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

  statesFor(issue: LinearIssue): readonly LinearWorkflowState[] {
    return this.workflowStates()[issue.team.id] ?? [];
  }

  statesForTeam(teamId: string): readonly LinearWorkflowState[] {
    return this.workflowStates()[teamId] ?? [];
  }

  estimateOptions(teamId: string) {
    const team = this.teams().find((item) => item.id === teamId);
    return linearEstimateOptions(
      team?.issueEstimationType ?? 'notUsed',
      team?.issueEstimationExtended ?? false,
      team?.issueEstimationAllowZero ?? false,
    );
  }

  async openIssueDetail(issue: Pick<LinearIssue, 'id'>): Promise<void> {
    const connection = this.selected();
    if (!connection) return;
    const requestId = ++this.issueDetailRequest;
    void this.loadProjects();
    this.issueDetail.set(null);
    this.issueDetailStale.set(false);
    this.newComment.set(
      this.readLocal<string>(this.issueCommentDraftKey(connection, issue.id)) ?? '',
    );
    const relationDraft = this.readLocal<unknown>(this.issueRelationDraftKey(connection, issue.id));
    this.relatedIssueIdentifier.set(
      isLinearIssueRelationDraft(relationDraft) ? relationDraft.identifier : '',
    );
    this.newIssueRelationType.set(
      isLinearIssueRelationDraft(relationDraft) ? relationDraft.type : 'blocks',
    );
    const subIssueDraft = this.readLocal<unknown>(this.subIssueDraftKey(connection, issue.id));
    this.newSubIssueTitle.set(typeof subIssueDraft === 'string' ? subIssueDraft : '');
    this.confirmArchiveIssueId.set(null);
    this.confirmArchiveIssueDetailId.set(null);
    this.confirmDeleteIssueRelationId.set(null);
    this.editingIssueDetailsId.set(null);
    this.editingCommentId.set(null);
    this.commentEditConflict.set(false);
    this.codexRequest.set(null);
    this.error.set(null);
    try {
      const detail = await this.tauri.linearIssueDetail(connection.organizationId, issue.id);
      if (requestId !== this.issueDetailRequest) return;
      this.issueDetail.set(detail);
      this.issueDetailStale.set(false);
      if (detail.issue.project) await this.loadMilestones(detail.issue.project.id);
      const teamCycles = await this.tauri.linearCycles(
        connection.organizationId,
        detail.issue.team.id,
      );
      if (requestId !== this.issueDetailRequest) return;
      this.cycles.update((items) => ({ ...items, [detail.issue.team.id]: teamCycles }));
      this.persistCycleCache(connection, detail.issue.team.id);
      this.codexContext.set(
        await this.tauri.linearCodexContext(connection.organizationId, issue.id),
      );
      if (this.canUseCodex && detail.issue.project && this.isCodexAllowed(detail.issue)) {
        await this.loadCodexWorkspaces(this.codexProjectRepo(detail.issue.project.id));
      }
    } catch (error) {
      if (requestId !== this.issueDetailRequest) return;
      if (this.issueDetail()?.issue.id === issue.id) return;
      const cached = this.readLocal<LinearIssueDetail>(
        this.issueDetailCacheKey(connection, issue.id),
      );
      if (cached && cached.issue?.id === issue.id && Array.isArray(cached.comments)) {
        this.issueDetail.set(cached);
        this.issueDetailStale.set(true);
        this.error.set(null);
      } else this.error.set(error instanceof Error ? error.message : String(error));
    }
  }

  issueRelations(detail: LinearIssueDetail) {
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

  relationLabel(type: LinearIssueRelationType, inverse: boolean): string {
    if (type === 'blocks') return inverse ? 'is blocked by' : 'blocks';
    if (type === 'duplicate') return inverse ? 'is duplicated by' : 'duplicates';
    return type === 'similar' ? 'is similar to' : 'is related to';
  }

  async createIssueRelation(event: Event, issue: LinearIssue): Promise<void> {
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
      this.writeLocal(this.issueRelationDraftKey(connection, issue.id), null);
      if (this.issueDetail()?.issue.id === issue.id) {
        this.relatedIssueIdentifier.set('');
        this.newIssueRelationType.set('blocks');
      }
      const detail = await this.tauri.linearIssueDetail(connection.organizationId, issue.id);
      if (this.issueDetail()?.issue.id === issue.id) this.issueDetail.set(detail);
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.creatingIssueRelation.set(false);
    }
  }

  async deleteIssueRelation(issue: LinearIssue, relationId: string): Promise<void> {
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

  async editIssueDetails(issue: LinearIssue): Promise<void> {
    const connection = this.selected();
    if (!connection) return;
    const requestId = ++this.issueDetailsEditRequest;
    this.error.set(null);
    let currentIssue = issue;
    try {
      const detail = await this.tauri.linearIssueDetail(connection.organizationId, issue.id);
      if (requestId !== this.issueDetailsEditRequest || this.issueDetail()?.issue.id !== issue.id) {
        return;
      }
      currentIssue = detail.issue;
      this.issueDetail.set(detail);
      this.issueDetailStale.set(false);
    } catch {
      if (requestId !== this.issueDetailsEditRequest || this.issueDetail()?.issue.id !== issue.id) {
        return;
      }
      this.issueDetailStale.set(true);
    }
    const draft = this.readIssueDetailsDraft(connection, issue.id);
    this.editingIssueDetailsId.set(issue.id);
    this.editIssueTitle.set(draft?.title ?? currentIssue.title);
    this.editIssueDescription.set(draft?.description ?? currentIssue.description ?? '');
    this.issueDetailsDraftConflict.set(
      draft ? linearIssueDetailsDraftConflicts(draft, currentIssue) : false,
    );
    this.hasIssueDetailsDraft.set(!!draft);
  }

  updateIssueDetailsDraft(issue: LinearIssue, field: 'title' | 'description', value: string): void {
    if (field === 'title') this.editIssueTitle.set(value);
    else this.editIssueDescription.set(value);
    const connection = this.selected();
    if (!connection) return;
    const original = this.readIssueDetailsDraft(connection, issue.id);
    const draft: LinearIssueDetailsDraft = {
      title: this.editIssueTitle(),
      description: this.editIssueDescription(),
      baseTitle: original?.baseTitle ?? issue.title,
      baseDescription: original?.baseDescription ?? issue.description ?? '',
    };
    const hasDraft = draft.title !== draft.baseTitle || draft.description !== draft.baseDescription;
    this.writeLocal(this.issueDetailsDraftKey(connection, issue.id), hasDraft ? draft : null);
    this.hasIssueDetailsDraft.set(hasDraft);
  }

  resolveIssueDetailsDraftConflict(issue: LinearIssue, keepDraft: boolean): void {
    const connection = this.selected();
    if (!connection) return;
    if (keepDraft) {
      const draft = this.readIssueDetailsDraft(connection, issue.id);
      if (draft) {
        this.writeLocal(this.issueDetailsDraftKey(connection, issue.id), {
          ...draft,
          baseTitle: issue.title,
          baseDescription: issue.description ?? '',
        } satisfies LinearIssueDetailsDraft);
      }
    } else {
      this.editIssueTitle.set(issue.title);
      this.editIssueDescription.set(issue.description ?? '');
      this.writeLocal(this.issueDetailsDraftKey(connection, issue.id), null);
      this.hasIssueDetailsDraft.set(false);
    }
    this.issueDetailsDraftConflict.set(false);
  }

  async saveIssueDetails(event: Event, issue: LinearIssue): Promise<void> {
    event.preventDefault();
    const title = this.editIssueTitle().trim();
    if (!title || this.savingIssueDetails() || this.issueDetailsDraftConflict()) return;
    const connection = this.selected();
    if (!connection) return;
    this.savingIssueDetails.set(true);
    const saved = await this.saveIssueUpdate(issue, {
      title,
      description: this.editIssueDescription(),
    });
    if (saved || this.pendingIssueUpdates().some((pending) => pending.issueId === issue.id)) {
      this.writeLocal(this.issueDetailsDraftKey(connection, issue.id), null);
      this.hasIssueDetailsDraft.set(false);
    }
    if (saved) this.editingIssueDetailsId.set(null);
    this.savingIssueDetails.set(false);
  }

  isCodexAllowed(issue: LinearIssue): boolean {
    return Boolean(issue.project && this.isCodexProjectAllowed(issue.project.id));
  }

  isCodexProjectAllowed(projectId: string): boolean {
    return (
      this.codexContext()?.allowedProjects.find((policy) => policy.projectId === projectId)
        ?.allowed ?? false
    );
  }

  codexProjectRepo(projectId: string): string {
    return (
      this.codexContext()?.allowedProjects.find((policy) => policy.projectId === projectId)
        ?.workspaceRepo ?? ''
    );
  }

  localCodexLink(): LinearCodexLink | null {
    const context = this.codexContext();
    return context?.links.find((link) => link.deviceId === context.deviceId) ?? null;
  }

  remoteCodexLinks(): readonly LinearCodexLink[] {
    const context = this.codexContext();
    return context?.links.filter((link) => link.deviceId !== context.deviceId) ?? [];
  }

  selectCodexWorkspace(path: string): void {
    this.selectedCodexWorkspacePath.set(path);
  }

  selectedCodexWorkspace(): WorkspaceSummary | null {
    return (
      this.codexWorkspaces().find(
        (workspace) => workspace.path === this.selectedCodexWorkspacePath(),
      ) ?? null
    );
  }

  requestCodex(issue: LinearIssue, continueThread: boolean): void {
    this.codexRequest.set({ issue, continueThread });
  }

  async confirmCodexRequest(): Promise<void> {
    const request = this.codexRequest();
    if (!request || this.codexPending()) return;
    this.codexRequest.set(null);
    await this.runIssueInCodex(request.issue, request.continueThread);
  }

  async setCodexProjectAllowed(projectId: string, allowed: boolean): Promise<void> {
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

  async setCodexProjectRepo(projectId: string, repo: string): Promise<void> {
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

  async runIssueInCodex(issue: LinearIssue, continueThread: boolean): Promise<void> {
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
    if (!connection.agentInstalled) {
      this.error.set('Install the Relay agent for this Linear workspace in Settings first.');
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
    const previousStateId = issue.state?.id;
    let inProgressStateId: string | null = null;
    try {
      const inProgress = this.statesFor(issue).find(
        (state) => /in progress/i.test(state.name) || state.kind === 'started',
      );
      if (inProgress && inProgress.id !== issue.state?.id) {
        const updated = await this.tauri.linearAgentUpdateIssueState(
          connection.organizationId,
          projectId,
          issue.id,
          inProgress.id,
        );
        this.applyUpdatedIssue(connection.organizationId, updated);
        inProgressStateId = inProgress.id;
      }
      const prompt = linearCodexPrompt(issue, this.issueDetail());
      let run: Awaited<ReturnType<TauriBridge['codexSend']>>;
      try {
        run = await this.tauri.codexSend(
          prompt,
          workspace.path,
          continueThread ? (existingLink?.threadId ?? null) : null,
        );
      } catch (error) {
        if (inProgressStateId && previousStateId) {
          try {
            const latest = await this.tauri.linearIssueDetail(connection.organizationId, issue.id);
            const restoreTarget = codexFailureRestoreTarget(
              previousStateId,
              inProgressStateId,
              latest.issue.state?.id,
            );
            if (restoreTarget) {
              const restored = await this.tauri.linearAgentUpdateIssueState(
                connection.organizationId,
                projectId,
                issue.id,
                restoreTarget,
              );
              this.applyUpdatedIssue(connection.organizationId, restored);
            }
          } catch (restoreError) {
            const failure = error instanceof Error ? error.message : String(error);
            const restoreFailure =
              restoreError instanceof Error ? restoreError.message : String(restoreError);
            throw new Error(
              `${failure}. Relay could not verify or restore the Linear status: ${restoreFailure}`,
            );
          }
        }
        throw error;
      }

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
      if (review) {
        const updated = await this.tauri.linearAgentUpdateIssueState(
          connection.organizationId,
          projectId,
          issue.id,
          review.id,
        );
        this.applyUpdatedIssue(connection.organizationId, updated);
      }
      const response = run.response.trim().replace(/\n{3,}/g, '\n\n');
      const conciseResponse =
        response.length > 2_000 ? `${response.slice(0, 1_997).trimEnd()}…` : response;
      const comment = await this.tauri.linearAgentCreateComment(
        connection.organizationId,
        projectId,
        issue.id,
        `Codex result — ${workspace.name}\n\n${conciseResponse}`,
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

  closeIssueDetail(): void {
    this.issueDetailRequest++;
    this.issueDetail.set(null);
    this.issueDetailStale.set(false);
    this.editingIssueDetailsId.set(null);
    this.confirmArchiveIssueDetailId.set(null);
    this.codexContext.set(null);
    this.newComment.set('');
    this.relatedIssueIdentifier.set('');
    this.newIssueRelationType.set('blocks');
    this.editingCommentId.set(null);
    this.confirmDeleteCommentId.set(null);
    this.newSubIssueTitle.set('');
  }

  editComment(comment: LinearComment): void {
    const connection = this.selected();
    const draft = connection
      ? this.readLocal<unknown>(this.issueCommentEditDraftKey(connection, comment.id))
      : null;
    this.editingCommentId.set(comment.id);
    this.editCommentBody.set(isLinearCommentDraft(draft) ? draft.body : comment.body);
    this.commentEditConflict.set(
      isLinearCommentDraft(draft) && linearCommentDraftConflicts(draft, comment.body),
    );
    this.confirmDeleteCommentId.set(null);
  }

  updateCommentEditDraft(comment: LinearComment, body: string): void {
    this.editCommentBody.set(body);
    const connection = this.selected();
    if (connection) {
      this.writeLocal(this.issueCommentEditDraftKey(connection, comment.id), {
        body,
        originalBody: comment.body,
      });
    }
  }

  resolveCommentEditConflict(comment: LinearComment, keepDraft: boolean): void {
    const connection = this.selected();
    if (!connection) return;
    if (keepDraft) {
      this.writeLocal(this.issueCommentEditDraftKey(connection, comment.id), {
        body: this.editCommentBody(),
        originalBody: comment.body,
      });
    } else {
      this.editCommentBody.set(comment.body);
      this.writeLocal(this.issueCommentEditDraftKey(connection, comment.id), null);
    }
    this.commentEditConflict.set(false);
  }

  cancelCommentEdit(): void {
    this.editingCommentId.set(null);
    this.commentEditConflict.set(false);
  }

  async saveComment(event: Event, current: LinearComment): Promise<void> {
    event.preventDefault();
    const connection = this.selected();
    const detail = this.issueDetail();
    const body = this.editCommentBody().trim();
    if (!connection || !detail || !body || this.savingComment() || this.commentEditConflict())
      return;
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
      this.writeLocal(this.issueCommentEditDraftKey(connection, current.id), null);
      this.editingCommentId.set(null);
      this.commentEditConflict.set(false);
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.savingComment.set(false);
    }
  }

  async deleteComment(comment: LinearComment): Promise<void> {
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

  async createComment(event: Event, issue: LinearIssue): Promise<void> {
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
      this.writeLocal(this.issueCommentDraftKey(connection, issue.id), null);
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.sendingComment.set(false);
    }
  }

  updateNewComment(issue: LinearIssue, value: string): void {
    this.newComment.set(value);
    const connection = this.selected();
    if (connection) this.writeLocal(this.issueCommentDraftKey(connection, issue.id), value || null);
  }

  async createSubIssue(event: Event, parent: LinearIssue): Promise<void> {
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
      this.writeLocal(this.subIssueDraftKey(connection, parent.id), null);
      this.issueDetail.update((detail) =>
        detail?.issue.id === parent.id
          ? { ...detail, children: [...detail.children, child] }
          : detail,
      );
      if (this.issueDetail()?.issue.id === parent.id) this.newSubIssueTitle.set('');
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.creatingSubIssue.set(false);
    }
  }

  setCreateTeam(teamId: string): void {
    if (teamId !== this.createTeamId()) {
      this.newEstimate.set('');
      this.newProjectIssueEstimate.set('');
      this.newLabelIds.set([]);
      this.newProjectIssueLabelIds.set([]);
      this.newStateId.set('');
      this.newProjectIssueStateId.set('');
      this.newCycleId.set('');
      this.newProjectIssueCycleId.set('');
    }
    this.createTeamId.set(teamId);
    this.saveIssueDraft();
    this.saveProjectIssueDraft();
    const connection = this.selected();
    if (connection) void this.loadTeamCycles(connection, teamId);
  }

  toggleCreateProject(): void {
    const opening = !this.createProjectOpen();
    if (opening) {
      const connection = this.selected();
      if (connection) this.restoreProjectDraft(connection);
    }
    this.createProjectOpen.set(opening);
  }

  updateProjectDraft(field: keyof Omit<LinearProjectDraft, 'teamIds'>, value: string): void {
    if (field === 'name') this.newProjectName.set(value);
    else if (field === 'description') this.newProjectDescription.set(value);
    else if (field === 'startDate') this.newProjectStartDate.set(value);
    else if (field === 'targetDate') this.newProjectTargetDate.set(value);
    else if (field === 'statusId') this.newProjectStatusId.set(value);
    else this.newProjectLeadId.set(value);
    this.saveProjectDraft();
  }

  private restoreProjectDraft(connection: LinearConnection): void {
    const stored = this.readLocal<unknown>(this.projectDraftKey(connection));
    const draft = isLinearProjectDraft(stored) ? stored : null;
    this.newProjectName.set(draft?.name ?? '');
    this.newProjectDescription.set(draft?.description ?? '');
    this.newProjectStartDate.set(draft?.startDate ?? '');
    this.newProjectTargetDate.set(draft?.targetDate ?? '');
    this.newProjectStatusId.set(draft?.statusId ?? '');
    this.newProjectLeadId.set(draft?.leadId ?? '');
    const defaultTeam = this.createTeamId() || this.teams()[0]?.id;
    this.newProjectTeamIds.set(draft?.teamIds ?? (defaultTeam ? [defaultTeam] : []));
  }

  private saveProjectDraft(): void {
    const connection = this.selected();
    if (!connection) return;
    const draft: LinearProjectDraft = {
      name: this.newProjectName(),
      description: this.newProjectDescription(),
      startDate: this.newProjectStartDate(),
      targetDate: this.newProjectTargetDate(),
      statusId: this.newProjectStatusId(),
      leadId: this.newProjectLeadId(),
      teamIds: this.newProjectTeamIds(),
    };
    this.writeLocal(
      this.projectDraftKey(connection),
      draft.name ||
        draft.description ||
        draft.startDate ||
        draft.targetDate ||
        draft.statusId ||
        draft.leadId ||
        draft.teamIds.length
        ? draft
        : null,
    );
  }

  updateProjectEditDraft(
    field: keyof Omit<LinearProjectEditValues, 'teamIds'>,
    value: string,
  ): void {
    if (field === 'name') this.editProjectName.set(value);
    else if (field === 'description') this.editProjectDescription.set(value);
    else if (field === 'startDate') this.editProjectStartDate.set(value);
    else if (field === 'targetDate') this.editProjectTargetDate.set(value);
    else if (field === 'statusId') this.editProjectStatusId.set(value);
    else this.editProjectLeadId.set(value);
    const connection = this.selected();
    const project = this.selectedProject();
    if (connection && project) this.saveProjectEditDraft(connection, project);
  }

  resolveProjectEditDraftConflict(keepDraft: boolean): void {
    const connection = this.selected();
    const project = this.selectedProject();
    if (!connection || !project) return;
    if (keepDraft) {
      const draft = this.readProjectEditDraft(connection, project.id);
      if (draft) {
        this.writeLocal(this.projectEditDraftKey(connection, project.id), {
          values: this.currentProjectEditValues(),
          base: linearProjectEditValues(project),
        } satisfies LinearProjectEditDraft);
      }
    } else {
      this.applyProjectEditValues(linearProjectEditValues(project));
      this.writeLocal(this.projectEditDraftKey(connection, project.id), null);
      this.hasProjectEditDraft.set(false);
    }
    this.projectEditDraftConflict.set(false);
  }

  private restoreProjectEditDraft(connection: LinearConnection, project: LinearProject): void {
    const current = linearProjectEditValues(project);
    const draft = this.readProjectEditDraft(connection, project.id);
    this.applyProjectEditValues(draft?.values ?? current);
    this.projectEditDraftConflict.set(
      draft ? linearProjectEditDraftConflicts(draft, current) : false,
    );
    this.hasProjectEditDraft.set(!!draft);
  }

  private currentProjectEditValues(): LinearProjectEditValues {
    return {
      name: this.editProjectName(),
      description: this.editProjectDescription(),
      startDate: this.editProjectStartDate(),
      targetDate: this.editProjectTargetDate(),
      statusId: this.editProjectStatusId(),
      leadId: this.editProjectLeadId(),
      teamIds: this.editProjectTeamIds(),
    };
  }

  private applyProjectEditValues(values: LinearProjectEditValues): void {
    this.editProjectName.set(values.name);
    this.editProjectDescription.set(values.description);
    this.editProjectStartDate.set(values.startDate);
    this.editProjectTargetDate.set(values.targetDate);
    this.editProjectStatusId.set(values.statusId);
    this.editProjectLeadId.set(values.leadId);
    this.editProjectTeamIds.set(values.teamIds);
  }

  private saveProjectEditDraft(connection: LinearConnection, project: LinearProject): void {
    const values = this.currentProjectEditValues();
    const original = this.readProjectEditDraft(connection, project.id);
    const draft: LinearProjectEditDraft = {
      values,
      base: original?.base ?? linearProjectEditValues(project),
    };
    const hasDraft = !linearProjectEditValuesEqual(draft.values, draft.base);
    this.writeLocal(this.projectEditDraftKey(connection, project.id), hasDraft ? draft : null);
    this.hasProjectEditDraft.set(hasDraft);
  }

  private readProjectEditDraft(
    connection: LinearConnection,
    projectId: string,
  ): LinearProjectEditDraft | null {
    const value = this.readLocal<unknown>(this.projectEditDraftKey(connection, projectId));
    return isLinearProjectEditDraft(value) ? value : null;
  }

  toggleProjectTeam(which: 'create' | 'edit', teamId: string, event: Event): void {
    const selected = which === 'create' ? this.newProjectTeamIds() : this.editProjectTeamIds();
    const checked = (event.target as HTMLInputElement | null)?.checked ?? false;
    const next = checked
      ? selected.includes(teamId)
        ? selected
        : [...selected, teamId]
      : selected.filter((id) => id !== teamId);
    if (which === 'create') this.newProjectTeamIds.set(next);
    else this.editProjectTeamIds.set(next);
    if (which === 'create') this.saveProjectDraft();
    else {
      const project = this.selectedProject();
      const connection = this.selected();
      if (connection && project) this.saveProjectEditDraft(connection, project);
    }
  }

  updateIssueDraft(field: 'title' | 'description', value: string): void {
    if (field === 'title') this.newTitle.set(value);
    else this.newDescription.set(value);
    this.saveIssueDraft();
  }

  updateIssueDraftEstimate(value: string): void {
    this.newEstimate.set(value);
    this.saveIssueDraft();
  }

  updateIssueDraftAssignee(value: string): void {
    this.newAssigneeId.set(value);
    this.saveIssueDraft();
  }

  updateIssueDraftPriority(value: string): void {
    this.newPriority.set(value);
    this.saveIssueDraft();
  }

  updateIssueDraftDueDate(value: string): void {
    this.newDueDate.set(value);
    this.saveIssueDraft();
  }

  updateIssueDraftLabels(event: Event): void {
    this.newLabelIds.set(
      Array.from((event.target as HTMLSelectElement).selectedOptions, (option) => option.value),
    );
    this.saveIssueDraft();
  }

  updateIssueDraftState(value: string): void {
    this.newStateId.set(value);
    this.saveIssueDraft();
  }

  updateIssueDraftCycle(value: string): void {
    this.newCycleId.set(value);
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
    const archived = this.includeArchivedIssues() ? '.all' : '';
    const search = this.issueSearchTerm().trim();
    const state = this.issueStateId();
    const priority = this.issuePriority();
    const assignee = this.issueAssigneeId();
    const label = this.issueLabelId();
    const cycle = this.issueCycleId();
    return `${scope}${archived}${search ? `.search.${encodeURIComponent(search)}` : ''}${state ? `.state.${encodeURIComponent(state)}` : ''}${priority ? `.priority.${priority}` : ''}${assignee ? `.assignee.${encodeURIComponent(assignee)}` : ''}${label ? `.label.${encodeURIComponent(label)}` : ''}${cycle ? `.cycle.${encodeURIComponent(cycle)}` : ''}`;
  }

  private projectCacheKey(connection: LinearConnection, includeArchived = false): string {
    const key = `relay.linear.projects.${connection.organizationId}.${connection.viewerId}`;
    return includeArchived ? `${key}.all` : key;
  }

  private projectDraftKey(connection: LinearConnection): string {
    return `relay.linear.projectDraft.${connection.organizationId}.${connection.viewerId}`;
  }

  private projectEditDraftKey(connection: LinearConnection, projectId: string): string {
    return `relay.linear.projectEditDraft.${connection.organizationId}.${connection.viewerId}.${projectId}`;
  }

  private projectIssueCacheKey(connection: LinearConnection, projectId: string): string {
    return linearProjectIssueCacheKey(connection.organizationId, connection.viewerId, projectId, {
      includeArchived: this.includeArchivedProjectIssues(),
      search: this.projectIssueSearchTerm(),
      stateId: this.projectIssueStateId(),
      priority: this.projectIssuePriority(),
      assigneeId: this.projectIssueAssigneeId(),
      labelId: this.projectIssueLabelId(),
    });
  }

  private saveProjectIssueCache(connection: LinearConnection, projectId: string): void {
    this.writeLocal(this.projectIssueCacheKey(connection, projectId), {
      issues: this.projectIssues(),
      endCursor: this.nextProjectIssueCursor,
      hasNextPage: this.projectIssuesHasNextPage(),
    } satisfies LinearIssuePage);
  }

  private projectResourcesCacheKey(connection: LinearConnection, projectId: string): string {
    return `relay.linear.projectResources.${connection.organizationId}.${projectId}`;
  }

  private projectPlanningDraftKey(connection: LinearConnection, projectId: string): string {
    return `relay.linear.projectPlanningDraft.${connection.organizationId}.${connection.viewerId}.${projectId}`;
  }

  private projectDocumentDraftKey(connection: LinearConnection, documentId: string): string {
    return `relay.linear.projectDocumentDraft.${connection.organizationId}.${documentId}`;
  }

  private projectDocumentCreateDraftKey(connection: LinearConnection, projectId: string): string {
    return `relay.linear.projectDocumentCreateDraft.${connection.organizationId}.${connection.viewerId}.${projectId}`;
  }

  private projectLinkDraftKey(connection: LinearConnection, projectId: string): string {
    return `relay.linear.projectLinkDraft.${connection.organizationId}.${connection.viewerId}.${projectId}`;
  }

  updateProjectDocumentCreateDraft(
    field: keyof LinearProjectDocumentCreateDraft,
    value: string,
  ): void {
    if (field === 'title') this.newProjectDocumentTitle.set(value);
    else this.newProjectDocumentContent.set(value);
    const connection = this.selected();
    const projectId = this.selectedProject()?.id;
    if (!connection || !projectId) return;
    const draft: LinearProjectDocumentCreateDraft = {
      title: this.newProjectDocumentTitle(),
      content: this.newProjectDocumentContent(),
    };
    this.writeLocal(
      this.projectDocumentCreateDraftKey(connection, projectId),
      draft.title || draft.content ? draft : null,
    );
  }

  private restoreProjectDocumentCreateDraft(connection: LinearConnection, projectId: string): void {
    const stored = this.readLocal<unknown>(
      this.projectDocumentCreateDraftKey(connection, projectId),
    );
    const draft = isLinearProjectDocumentCreateDraft(stored) ? stored : null;
    this.newProjectDocumentTitle.set(draft?.title ?? '');
    this.newProjectDocumentContent.set(draft?.content ?? '');
  }

  updateProjectLinkDraft(field: keyof LinearProjectLinkDraft, value: string): void {
    if (field === 'label') this.newProjectLinkLabel.set(value);
    else this.newProjectLinkUrl.set(value);
    const connection = this.selected();
    const projectId = this.selectedProject()?.id;
    if (!connection || !projectId) return;
    const draft: LinearProjectLinkDraft = {
      label: this.newProjectLinkLabel(),
      url: this.newProjectLinkUrl(),
    };
    this.writeLocal(
      this.projectLinkDraftKey(connection, projectId),
      draft.label || draft.url ? draft : null,
    );
  }

  private restoreProjectLinkDraft(connection: LinearConnection, projectId: string): void {
    const stored = this.readLocal<unknown>(this.projectLinkDraftKey(connection, projectId));
    const draft = isLinearProjectLinkDraft(stored) ? stored : null;
    this.newProjectLinkLabel.set(draft?.label ?? '');
    this.newProjectLinkUrl.set(draft?.url ?? '');
  }

  private issueDetailCacheKey(connection: LinearConnection, issueId: string): string {
    return `relay.linear.issueDetail.${connection.organizationId}.${connection.viewerId}.${issueId}`;
  }

  private issueDetailsDraftKey(connection: LinearConnection, issueId: string): string {
    return `relay.linear.issueDetailsDraft.${connection.organizationId}.${connection.viewerId}.${issueId}`;
  }

  private readIssueDetailsDraft(
    connection: LinearConnection,
    issueId: string,
  ): LinearIssueDetailsDraft | null {
    const value = this.readLocal<unknown>(this.issueDetailsDraftKey(connection, issueId));
    return isLinearIssueDetailsDraft(value) ? value : null;
  }

  private issueCommentDraftKey(connection: LinearConnection, issueId: string): string {
    return `relay.linear.issueCommentDraft.${connection.organizationId}.${connection.viewerId}.${issueId}`;
  }

  private issueCommentEditDraftKey(connection: LinearConnection, commentId: string): string {
    return `relay.linear.issueCommentEditDraft.${connection.organizationId}.${connection.viewerId}.${commentId}`;
  }

  private issueRelationDraftKey(connection: LinearConnection, issueId: string): string {
    return `relay.linear.issueRelationDraft.${connection.organizationId}.${connection.viewerId}.${issueId}`;
  }

  private issueLabelDraftKey(connection: LinearConnection): string {
    return `relay.linear.issueLabelDraft.${connection.organizationId}.${connection.viewerId}`;
  }

  private subIssueDraftKey(connection: LinearConnection, issueId: string): string {
    return `relay.linear.subIssueDraft.${connection.organizationId}.${connection.viewerId}.${issueId}`;
  }

  updateIssueRelationDraft(
    issue: LinearIssue,
    field: keyof LinearIssueRelationDraft,
    value: string,
  ): void {
    const type: LinearIssueRelationType = ['blocks', 'related', 'duplicate', 'similar'].includes(
      value,
    )
      ? (value as LinearIssueRelationType)
      : 'blocks';
    if (field === 'identifier') this.relatedIssueIdentifier.set(value);
    else this.newIssueRelationType.set(type);
    const connection = this.selected();
    if (!connection) return;
    const draft: LinearIssueRelationDraft = {
      identifier: this.relatedIssueIdentifier(),
      type: this.newIssueRelationType(),
    };
    this.writeLocal(
      this.issueRelationDraftKey(connection, issue.id),
      draft.identifier || draft.type !== 'blocks' ? draft : null,
    );
  }

  updateSubIssueDraft(parent: LinearIssue, title: string): void {
    this.newSubIssueTitle.set(title);
    const connection = this.selected();
    if (connection) {
      this.writeLocal(this.subIssueDraftKey(connection, parent.id), title || null);
    }
  }

  updateIssueLabelDraft(field: keyof LinearIssueLabelDraft, value: string): void {
    if (field === 'name') this.newLabelName.set(value);
    else if (field === 'teamId') this.newLabelTeamId.set(value);
    else this.newLabelColor.set(value);
    this.saveIssueLabelDraft();
  }

  private saveIssueLabelDraft(): void {
    const connection = this.selected();
    if (!connection) return;
    const draft: LinearIssueLabelDraft = {
      name: this.newLabelName(),
      teamId: this.newLabelTeamId(),
      color: this.newLabelColor(),
    };
    this.writeLocal(
      this.issueLabelDraftKey(connection),
      draft.name || draft.teamId || draft.color !== '#6b7280' ? draft : null,
    );
  }

  private restoreIssueLabelDraft(connection: LinearConnection): void {
    const stored = this.readLocal<unknown>(this.issueLabelDraftKey(connection));
    const draft = isLinearIssueLabelDraft(stored) ? stored : null;
    this.newLabelName.set(draft?.name ?? '');
    this.newLabelTeamId.set(draft?.teamId ?? '');
    this.newLabelColor.set(draft?.color ?? '#6b7280');
  }

  private readProjectDocumentDraft(
    connection: LinearConnection,
    documentId: string,
  ): LinearProjectDocumentDraft | null {
    const value = this.readLocal<unknown>(this.projectDocumentDraftKey(connection, documentId));
    return isLinearProjectDocumentDraft(value) ? value : null;
  }

  updateProjectDocumentDraft(field: 'title' | 'content', value: string): void {
    if (field === 'title') this.editProjectDocumentTitle.set(value);
    else this.editProjectDocumentContent.set(value);
    const connection = this.selected();
    const documentId = this.editingProjectDocumentId();
    const updatedAt = this.editProjectDocumentUpdatedAt();
    if (connection && documentId && updatedAt) {
      this.writeLocal(this.projectDocumentDraftKey(connection, documentId), {
        title: this.editProjectDocumentTitle(),
        content: this.editProjectDocumentContent(),
        updatedAt,
      } satisfies LinearProjectDocumentDraft);
    }
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
    issue: LinearIssue,
    update: LinearIssueUpdate,
  ): LinearIssueUpdate {
    const updates = this.readPendingIssueUpdates(organizationId);
    const index = updates.findIndex((item) => item.issueId === issue.id);
    const merged = mergeLinearIssueUpdates(updates[index]?.update ?? {}, update);
    const base = updates[index]?.base ?? linearIssueValues(issue);
    if (index < 0) updates.push({ issueId: issue.id, update: merged, base });
    else updates[index] = { issueId: issue.id, update: merged, base };
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
      items.flatMap((entry) => {
        if (entry.id !== updated.id) return [entry];
        return this.matchesIssueQuery(updated) ? [updated] : [];
      }),
    );
    this.projectIssues.update((items) =>
      items.flatMap((entry) => {
        if (entry.id !== updated.id) return [entry];
        return this.matchesProjectIssueQuery(updated) ? [updated] : [];
      }),
    );
    this.issueDetail.update((detail) =>
      detail?.issue.id === updated.id ? { ...detail, issue: updated } : detail,
    );
    const connection = this.selected();
    if (connection) {
      this.saveIssueCache(connection);
      const project = this.selectedProject();
      if (project) this.saveProjectIssueCache(connection, project.id);
    }
  }

  private matchesIssueQuery(issue: LinearIssue): boolean {
    const connection = this.selected();
    const search = this.issueSearchTerm().trim().toLowerCase();
    return (
      !!connection &&
      (this.issueTeamId()
        ? issue.team.id === this.issueTeamId()
        : issue.assignee?.id === connection.viewerId) &&
      (this.includeArchivedIssues() || !issue.archivedAt) &&
      (!search || issue.title.toLowerCase().includes(search)) &&
      (!this.issueStateId() || issue.state?.id === this.issueStateId()) &&
      (this.issuePriority() === '' || issue.priority === Number(this.issuePriority())) &&
      (!this.issueTeamId() ||
        !this.issueCycleId() ||
        (this.issueCycleId() === 'uncycled'
          ? !issue.cycle
          : issue.cycle?.id === this.issueCycleId())) &&
      (!this.issueTeamId() ||
        !this.issueAssigneeId() ||
        (this.issueAssigneeId() === 'unassigned'
          ? !issue.assignee
          : issue.assignee?.id === this.issueAssigneeId())) &&
      (!this.issueLabelId() || issue.labels.some((label) => label.id === this.issueLabelId()))
    );
  }

  private matchesProjectIssueQuery(issue: LinearIssue): boolean {
    const project = this.selectedProject();
    const search = this.projectIssueSearchTerm().trim().toLowerCase();
    return (
      !!project &&
      issue.project?.id === project.id &&
      (this.includeArchivedProjectIssues() || !issue.archivedAt) &&
      (!search || issue.title.toLowerCase().includes(search)) &&
      (!this.projectIssueStateId() || issue.state?.id === this.projectIssueStateId()) &&
      (this.projectIssuePriority() === '' ||
        issue.priority === Number(this.projectIssuePriority())) &&
      (!this.projectIssueAssigneeId() ||
        (this.projectIssueAssigneeId() === 'unassigned'
          ? !issue.assignee
          : issue.assignee?.id === this.projectIssueAssigneeId())) &&
      (!this.projectIssueLabelId() ||
        issue.labels.some((label) => label.id === this.projectIssueLabelId()))
    );
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

  private clearOrganizationCache(organizationId: string): void {
    try {
      for (let index = localStorage.length - 1; index >= 0; index--) {
        const key = localStorage.key(index);
        if (key && isLinearOrganizationCacheKey(key, organizationId)) {
          localStorage.removeItem(key);
        }
      }
    } catch {
      // Disconnect must still finish if browser storage is unavailable.
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
      assigneeId: this.newAssigneeId(),
      priority: this.newPriority(),
      dueDate: this.newDueDate(),
      labelIds: this.newLabelIds(),
      stateId: this.newStateId(),
      cycleId: this.newCycleId(),
    });
  }

  private restoreIssueDraft(connection: LinearConnection): void {
    const draft = this.readLocal<Partial<LinearIssueDraft>>(
      this.issueDraftKey(connection.organizationId),
    );
    this.newTitle.set(typeof draft?.title === 'string' ? draft.title : '');
    this.newDescription.set(typeof draft?.description === 'string' ? draft.description : '');
    this.newEstimate.set(typeof draft?.estimate === 'string' ? draft.estimate : '');
    this.newAssigneeId.set(typeof draft?.assigneeId === 'string' ? draft.assigneeId : '');
    this.newPriority.set(typeof draft?.priority === 'string' ? draft.priority : '');
    this.newDueDate.set(typeof draft?.dueDate === 'string' ? draft.dueDate : '');
    this.newStateId.set(typeof draft?.stateId === 'string' ? draft.stateId : '');
    this.newCycleId.set(typeof draft?.cycleId === 'string' ? draft.cycleId : '');
    this.newLabelIds.set(
      Array.isArray(draft?.labelIds)
        ? draft.labelIds.filter((labelId): labelId is string => typeof labelId === 'string')
        : [],
    );
    if (typeof draft?.teamId === 'string') this.createTeamId.set(draft.teamId);
  }

  updateProjectIssueDraft(field: 'title' | 'description', value: string): void {
    if (field === 'title') this.newProjectIssueTitle.set(value);
    else this.newProjectIssueDescription.set(value);
    this.saveProjectIssueDraft();
  }

  updateProjectIssueMilestone(milestoneId: string): void {
    this.newProjectIssueMilestoneId.set(milestoneId);
    this.saveProjectIssueDraft();
  }

  updateProjectIssueEstimate(value: string): void {
    this.newProjectIssueEstimate.set(value);
    this.saveProjectIssueDraft();
  }

  updateProjectIssueAssignee(value: string): void {
    this.newProjectIssueAssigneeId.set(value);
    this.saveProjectIssueDraft();
  }

  updateProjectIssuePriority(value: string): void {
    this.newProjectIssuePriority.set(value);
    this.saveProjectIssueDraft();
  }

  updateProjectIssueDueDate(value: string): void {
    this.newProjectIssueDueDate.set(value);
    this.saveProjectIssueDraft();
  }

  updateProjectIssueLabels(event: Event): void {
    this.newProjectIssueLabelIds.set(
      Array.from((event.target as HTMLSelectElement).selectedOptions, (option) => option.value),
    );
    this.saveProjectIssueDraft();
  }

  updateProjectIssueState(value: string): void {
    this.newProjectIssueStateId.set(value);
    this.saveProjectIssueDraft();
  }

  updateProjectIssueCycle(value: string): void {
    this.newProjectIssueCycleId.set(value);
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
      assigneeId: this.newProjectIssueAssigneeId(),
      priority: this.newProjectIssuePriority(),
      dueDate: this.newProjectIssueDueDate(),
      labelIds: this.newProjectIssueLabelIds(),
      stateId: this.newProjectIssueStateId(),
      cycleId: this.newProjectIssueCycleId(),
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
    this.newProjectIssueAssigneeId.set(
      typeof draft?.assigneeId === 'string' ? draft.assigneeId : '',
    );
    this.newProjectIssuePriority.set(typeof draft?.priority === 'string' ? draft.priority : '');
    this.newProjectIssueDueDate.set(typeof draft?.dueDate === 'string' ? draft.dueDate : '');
    this.newProjectIssueStateId.set(typeof draft?.stateId === 'string' ? draft.stateId : '');
    this.newProjectIssueCycleId.set(typeof draft?.cycleId === 'string' ? draft.cycleId : '');
    this.newProjectIssueLabelIds.set(
      Array.isArray(draft?.labelIds)
        ? draft.labelIds.filter((labelId): labelId is string => typeof labelId === 'string')
        : [],
    );
    if (typeof draft?.teamId === 'string') this.createTeamId.set(draft.teamId);
  }

  setSection(section: 'work' | 'projects' | 'cycles' | 'roadmap' | 'labels'): void {
    this.section.set(section);
    this.selectedProject.set(null);
    this.confirmArchiveProjectId.set(null);
    const connection = this.selected();
    if (connection) void this.loadSection(connection);
  }

  cyclesFor(teamId: string): readonly LinearCycle[] {
    return this.cycles()[teamId] ?? [];
  }

  private async loadTeamCycles(connection: LinearConnection, teamId: string): Promise<void> {
    if (!teamId || this.cycles()[teamId]) return;
    const cacheKey = this.cycleCacheKey(connection, teamId);
    const cached = this.readLocal<readonly LinearCycle[]>(cacheKey);
    if (Array.isArray(cached) && this.selected()?.organizationId === connection.organizationId) {
      this.cycles.update((items) => ({ ...items, [teamId]: cached }));
    }
    try {
      const cycles = await this.tauri.linearCycles(connection.organizationId, teamId);
      if (this.selected()?.organizationId === connection.organizationId) {
        this.cycles.update((items) => ({ ...items, [teamId]: cycles }));
        this.writeLocal(cacheKey, cycles);
      }
    } catch (error) {
      if (this.selected()?.organizationId === connection.organizationId) {
        this.error.set(
          Array.isArray(cached)
            ? 'Linear is unavailable. Showing saved cycles.'
            : error instanceof Error
              ? error.message
              : String(error),
        );
      }
    }
  }

  private persistCycleCache(connection: LinearConnection, teamId: string): void {
    if (
      this.selected()?.organizationId === connection.organizationId &&
      this.selected()?.viewerId === connection.viewerId
    ) {
      this.writeLocal(this.cycleCacheKey(connection, teamId), this.cycles()[teamId] ?? []);
    }
  }

  cycleDateInTeam(value: string | null, team: LinearTeam): string {
    return value ? cycleDateInTimezone(value, team.timezone) : 'Open';
  }

  todayForTeam(team: LinearTeam): string {
    return todayInTimezone(team.timezone);
  }

  canEditCycle(cycle: LinearCycle, team: LinearTeam): boolean {
    if (!cycle.startsAt || !cycle.endsAt) return false;
    return (
      cycle.isActive || cycleDateInTimezone(cycle.endsAt, team.timezone) >= this.todayForTeam(team)
    );
  }

  toggleCreateCycle(team: LinearTeam): void {
    if (this.createCycleTeamId() === team.id) {
      this.createCycleTeamId.set(null);
      return;
    }
    this.error.set(null);
    this.createCycleTeamId.set(team.id);
    const connection = this.selected();
    const stored = connection
      ? this.readLocal<unknown>(this.cycleDraftKey(connection, team.id))
      : null;
    const draft = isLinearCycleDraft(stored) ? stored : null;
    this.newCycleName.set(draft?.name ?? '');
    this.newCycleStartDate.set(draft?.startsAt || this.todayForTeam(team));
    this.newCycleEndDate.set(draft?.endsAt ?? '');
  }

  updateCycleDraft(team: LinearTeam, field: keyof LinearCycleDraft, value: string): void {
    if (field === 'name') this.newCycleName.set(value);
    else if (field === 'startsAt') this.newCycleStartDate.set(value);
    else this.newCycleEndDate.set(value);
    const connection = this.selected();
    if (!connection) return;
    const draft: LinearCycleDraft = {
      name: this.newCycleName(),
      startsAt: this.newCycleStartDate(),
      endsAt: this.newCycleEndDate(),
    };
    this.writeLocal(this.cycleDraftKey(connection, team.id), draft);
  }

  async createCycle(event: Event, team: LinearTeam): Promise<void> {
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
      this.persistCycleCache(connection, team.id);
      this.writeLocal(this.cycleDraftKey(connection, team.id), null);
      this.createCycleTeamId.set(null);
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.creatingCycle.set(false);
    }
  }

  editCycle(cycle: LinearCycle): void {
    this.error.set(null);
    this.editingCycleId.set(cycle.id);
    const current = this.cycleEditValues(cycle);
    const connection = this.selected();
    const draft = connection ? this.readCycleEditDraft(connection, cycle.id) : null;
    const values = draft?.values ?? current;
    this.applyCycleEditValues(values);
    this.cycleEditBase.set(draft?.base ?? current);
    this.cycleEditDraftConflict.set(draft ? linearCycleEditDraftConflicts(draft, current) : false);
    this.hasCycleEditDraft.set(!!draft);
  }

  updateCycleEditDraft(
    cycle: LinearCycle,
    field: keyof LinearCycleEditValues,
    value: string,
  ): void {
    if (field === 'name') this.editCycleName.set(value);
    else if (field === 'description') this.editCycleDescription.set(value);
    else if (field === 'startDate') this.editCycleStartDate.set(value);
    else this.editCycleEndDate.set(value);
    const connection = this.selected();
    if (connection) this.saveCycleEditDraft(connection, cycle);
  }

  resolveCycleEditDraftConflict(cycle: LinearCycle, keepDraft: boolean): void {
    const connection = this.selected();
    if (!connection) return;
    const current = this.cycleEditValues(cycle);
    if (keepDraft) {
      const draft = this.readCycleEditDraft(connection, cycle.id);
      if (draft) {
        this.cycleEditBase.set(current);
        this.writeLocal(this.cycleEditDraftKey(connection, cycle.id), {
          values: this.currentCycleEditValues(),
          base: current,
        } satisfies LinearCycleEditDraft);
      }
    } else {
      this.applyCycleEditValues(current);
      this.cycleEditBase.set(current);
      this.writeLocal(this.cycleEditDraftKey(connection, cycle.id), null);
      this.hasCycleEditDraft.set(false);
    }
    this.cycleEditDraftConflict.set(false);
  }

  async saveCycle(event: Event, cycle: LinearCycle): Promise<void> {
    event.preventDefault();
    const connection = this.selected();
    if (!connection || this.savingCycle() || this.cycleEditDraftConflict()) return;
    this.savingCycle.set(true);
    this.error.set(null);
    try {
      const latestCycles = await this.tauri.linearCycles(connection.organizationId, cycle.team.id);
      if (
        this.selected()?.organizationId !== connection.organizationId ||
        this.selected()?.viewerId !== connection.viewerId
      ) {
        return;
      }
      const currentCycle = latestCycles.find((item) => item.id === cycle.id);
      if (!currentCycle) throw new Error('Linear no longer has this cycle. Refresh and retry.');
      const current = this.cycleEditValues(currentCycle);
      const draft = this.readCycleEditDraft(connection, cycle.id) ?? {
        values: this.currentCycleEditValues(),
        base: this.cycleEditBase() ?? this.cycleEditValues(cycle),
      };
      if (linearCycleEditDraftConflicts(draft, current)) {
        this.cycles.update((items) => ({ ...items, [cycle.team.id]: latestCycles }));
        this.persistCycleCache(connection, cycle.team.id);
        this.cycleEditDraftConflict.set(true);
        return;
      }
      if (linearCycleEditValuesEqual(draft.values, current)) {
        this.applyCycleEditValues(current);
        this.writeLocal(this.cycleEditDraftKey(connection, cycle.id), null);
        this.hasCycleEditDraft.set(false);
        this.cycleEditBase.set(current);
        this.cycles.update((items) => ({ ...items, [cycle.team.id]: latestCycles }));
        this.persistCycleCache(connection, cycle.team.id);
        this.editingCycleId.set(null);
        return;
      }
      const updated = await this.tauri.linearUpdateCycle(
        connection.organizationId,
        currentCycle.id,
        draft.values.name.trim(),
        draft.values.description,
        this.canEditCycle(currentCycle, currentCycle.team) && !currentCycle.isActive
          ? cycleDateToIso(draft.values.startDate, currentCycle.team.timezone)
          : null,
        this.canEditCycle(currentCycle, currentCycle.team)
          ? cycleDateToIso(draft.values.endDate, currentCycle.team.timezone)
          : null,
      );
      if (
        this.selected()?.organizationId !== connection.organizationId ||
        this.selected()?.viewerId !== connection.viewerId
      ) {
        return;
      }
      this.cycles.update((cycles) => ({
        ...cycles,
        [cycle.team.id]: latestCycles.map((item) => (item.id === updated.id ? updated : item)),
      }));
      this.writeLocal(this.cycleEditDraftKey(connection, cycle.id), null);
      this.hasCycleEditDraft.set(false);
      this.cycleEditDraftConflict.set(false);
      this.cycleEditBase.set(null);
      this.persistCycleCache(connection, cycle.team.id);
      this.editingCycleId.set(null);
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.savingCycle.set(false);
    }
  }

  private cycleEditValues(cycle: LinearCycle): LinearCycleEditValues {
    return {
      name: cycle.name ?? '',
      description: cycle.description ?? '',
      startDate: cycle.startsAt ? cycleDateInTimezone(cycle.startsAt, cycle.team.timezone) : '',
      endDate: cycle.endsAt ? cycleDateInTimezone(cycle.endsAt, cycle.team.timezone) : '',
    };
  }

  private currentCycleEditValues(): LinearCycleEditValues {
    return {
      name: this.editCycleName(),
      description: this.editCycleDescription(),
      startDate: this.editCycleStartDate(),
      endDate: this.editCycleEndDate(),
    };
  }

  private applyCycleEditValues(values: LinearCycleEditValues): void {
    this.editCycleName.set(values.name);
    this.editCycleDescription.set(values.description);
    this.editCycleStartDate.set(values.startDate);
    this.editCycleEndDate.set(values.endDate);
  }

  private saveCycleEditDraft(connection: LinearConnection, cycle: LinearCycle): void {
    const values = this.currentCycleEditValues();
    const original = this.readCycleEditDraft(connection, cycle.id);
    const draft: LinearCycleEditDraft = {
      values,
      base: original?.base ?? this.cycleEditBase() ?? this.cycleEditValues(cycle),
    };
    const hasDraft = !linearCycleEditValuesEqual(draft.values, draft.base);
    this.writeLocal(this.cycleEditDraftKey(connection, cycle.id), hasDraft ? draft : null);
    this.hasCycleEditDraft.set(hasDraft);
  }

  private readCycleEditDraft(
    connection: LinearConnection,
    cycleId: string,
  ): LinearCycleEditDraft | null {
    const value = this.readLocal<unknown>(this.cycleEditDraftKey(connection, cycleId));
    return isLinearCycleEditDraft(value) ? value : null;
  }

  async loadProjects(): Promise<void> {
    const connection = this.selected();
    if (!connection) return;
    const requestId = ++this.projectsRequest;
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
      if (
        requestId !== this.projectsRequest ||
        this.selected()?.organizationId !== connection.organizationId ||
        this.selected()?.viewerId !== connection.viewerId
      ) {
        return;
      }
      this.projects.set(projects);
      this.writeLocal(cacheKey, projects);
      this.projectCacheStale.set(false);
    } catch (error) {
      if (
        requestId !== this.projectsRequest ||
        this.selected()?.organizationId !== connection.organizationId ||
        this.selected()?.viewerId !== connection.viewerId
      ) {
        return;
      }
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

  toggleArchivedProjects(): void {
    this.showArchivedProjects.update((value) => !value);
    this.selectedProject.set(null);
    this.createProjectOpen.set(false);
    void this.loadProjects();
  }

  async archiveSelectedProject(): Promise<void> {
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

  async unarchiveSelectedProject(): Promise<void> {
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

  toggleArchivedInitiatives(): void {
    this.includeArchivedInitiatives.update((includeArchived) => !includeArchived);
    void this.loadInitiatives();
  }

  async setInitiativeArchived(initiative: LinearInitiative, archived: boolean): Promise<void> {
    if (archived && this.confirmArchiveInitiativeId() !== initiative.id) {
      this.confirmArchiveInitiativeId.set(initiative.id);
      return;
    }
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
      this.confirmArchiveInitiativeId.set(null);
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
    const requestId = ++this.initiativeRequest;
    const includeArchived = this.includeArchivedInitiatives();
    const includeArchivedUpdates = this.includeArchivedInitiativeUpdates();
    const cacheKey = this.initiativeCacheKey(connection, includeArchived, includeArchivedUpdates);
    const cached = this.readLocal<readonly LinearInitiative[]>(cacheKey);
    const hasCache = Array.isArray(cached);
    if (hasCache) this.initiatives.set(cached);
    try {
      const initiatives = await this.tauri.linearInitiatives(
        connection.organizationId,
        includeArchived,
        includeArchivedUpdates,
      );
      if (
        requestId !== this.initiativeRequest ||
        this.selected()?.organizationId !== connection.organizationId
      ) {
        return;
      }
      this.initiatives.set(initiatives);
      this.writeLocal(cacheKey, initiatives);
    } catch (error) {
      if (requestId !== this.initiativeRequest) return;
      this.error.set(
        hasCache
          ? 'Linear is unavailable. Showing saved initiatives.'
          : error instanceof Error
            ? error.message
            : String(error),
      );
    }
  }

  private persistInitiativesCache(connection: LinearConnection): void {
    if (
      this.selected()?.organizationId !== connection.organizationId ||
      this.selected()?.viewerId !== connection.viewerId
    ) {
      return;
    }
    this.writeLocal(
      this.initiativeCacheKey(
        connection,
        this.includeArchivedInitiatives(),
        this.includeArchivedInitiativeUpdates(),
      ),
      this.initiatives(),
    );
  }

  toggleInitiativeUpdate(initiative: LinearInitiative): void {
    if (this.initiativeUpdateId() === initiative.id) {
      this.initiativeUpdateId.set(null);
      this.initiativeUpdateBody.set('');
      this.initiativeUpdateHealth.set('onTrack');
      return;
    }
    this.initiativeUpdateId.set(initiative.id);
    const connection = this.selected();
    const stored = connection
      ? this.readLocal<unknown>(this.initiativeUpdateDraftKey(connection, initiative.id))
      : null;
    const draft = isLinearInitiativeUpdateDraft(stored) ? stored : null;
    this.initiativeUpdateBody.set(draft?.body ?? '');
    this.initiativeUpdateHealth.set(draft?.health ?? 'onTrack');
  }

  updateInitiativeDraft(field: keyof LinearInitiativeDraft, value: string): void {
    if (field === 'name') this.newInitiativeName.set(value);
    else if (field === 'description') this.newInitiativeDescription.set(value);
    else this.newInitiativeTargetDate.set(value);
    this.saveInitiativeDraft();
  }

  private restoreInitiativeDraft(connection: LinearConnection): void {
    const stored = this.readLocal<unknown>(this.initiativeDraftKey(connection));
    const draft = isLinearInitiativeDraft(stored) ? stored : null;
    this.newInitiativeName.set(draft?.name ?? '');
    this.newInitiativeDescription.set(draft?.description ?? '');
    this.newInitiativeTargetDate.set(draft?.targetDate ?? '');
  }

  private saveInitiativeDraft(): void {
    const connection = this.selected();
    if (!connection) return;
    const draft: LinearInitiativeDraft = {
      name: this.newInitiativeName(),
      description: this.newInitiativeDescription(),
      targetDate: this.newInitiativeTargetDate(),
    };
    this.writeLocal(
      this.initiativeDraftKey(connection),
      draft.name || draft.description || draft.targetDate ? draft : null,
    );
  }

  updateInitiativeUpdateDraft(field: keyof LinearInitiativeUpdateDraft, value: string): void {
    if (field === 'body') this.initiativeUpdateBody.set(value);
    else {
      this.initiativeUpdateHealth.set(
        ['onTrack', 'atRisk', 'offTrack'].includes(value)
          ? (value as LinearProjectHealth)
          : 'onTrack',
      );
    }
    const connection = this.selected();
    const initiativeId = this.initiativeUpdateId();
    if (connection && initiativeId) {
      const draft: LinearInitiativeUpdateDraft = {
        body: this.initiativeUpdateBody(),
        health: this.initiativeUpdateHealth(),
      };
      this.writeLocal(
        this.initiativeUpdateDraftKey(connection, initiativeId),
        draft.body || draft.health !== 'onTrack' ? draft : null,
      );
    }
  }

  toggleArchivedInitiativeUpdates(): void {
    this.includeArchivedInitiativeUpdates.update((includeArchived) => !includeArchived);
    void this.loadInitiatives();
  }

  editInitiativeUpdate(update: LinearInitiativeUpdate): void {
    this.editingInitiativeUpdateId.set(update.id);
    const current = { body: update.body, health: update.health };
    this.initiativeUpdateEditBase.set(current);
    const connection = this.selected();
    const draft = connection
      ? this.readStatusUpdateEditDraft(this.initiativeUpdateEditDraftKey(connection, update.id))
      : null;
    const values = draft?.values ?? current;
    this.editInitiativeUpdateBody.set(values.body);
    this.editInitiativeUpdateHealth.set(values.health);
    this.initiativeUpdateEditDraftConflict.set(
      draft ? linearStatusUpdateEditDraftConflicts(draft, current) : false,
    );
    this.hasInitiativeUpdateEditDraft.set(!!draft);
  }

  updateInitiativeUpdateEdit(field: 'body' | 'health', value: string): void {
    if (field === 'body') this.editInitiativeUpdateBody.set(value);
    else this.editInitiativeUpdateHealth.set(this.updateHealth(value));
    const connection = this.selected();
    const updateId = this.editingInitiativeUpdateId();
    if (connection && updateId) {
      this.saveStatusUpdateEditDraft(
        this.initiativeUpdateEditDraftKey(connection, updateId),
        { body: this.editInitiativeUpdateBody(), health: this.editInitiativeUpdateHealth() },
        this.initiativeUpdateEditBase() ?? {
          body: this.editInitiativeUpdateBody(),
          health: this.editInitiativeUpdateHealth(),
        },
        this.hasInitiativeUpdateEditDraft,
      );
    }
  }

  resolveInitiativeUpdateEditDraftConflict(
    update: LinearInitiativeUpdate,
    keepDraft: boolean,
  ): void {
    const connection = this.selected();
    if (!connection) return;
    const current = { body: update.body, health: update.health };
    const key = this.initiativeUpdateEditDraftKey(connection, update.id);
    const draft = this.readStatusUpdateEditDraft(key);
    if (keepDraft && draft) {
      this.writeLocal(key, { values: this.currentInitiativeUpdateEditValues(), base: current });
      this.initiativeUpdateEditBase.set(current);
    } else {
      this.applyInitiativeUpdateEditValues(current);
      this.initiativeUpdateEditBase.set(current);
      this.writeLocal(key, null);
      this.hasInitiativeUpdateEditDraft.set(false);
    }
    this.initiativeUpdateEditDraftConflict.set(false);
  }

  private currentInitiativeUpdateEditValues(): LinearInitiativeUpdateDraft {
    return {
      body: this.editInitiativeUpdateBody(),
      health: this.editInitiativeUpdateHealth(),
    };
  }

  private applyInitiativeUpdateEditValues(values: LinearInitiativeUpdateDraft): void {
    this.editInitiativeUpdateBody.set(values.body);
    this.editInitiativeUpdateHealth.set(values.health);
  }

  async setInitiativeUpdateArchived(
    update: LinearInitiativeUpdate,
    archived: boolean,
  ): Promise<void> {
    if (archived && this.confirmArchiveInitiativeUpdateId() !== update.id) {
      this.confirmArchiveInitiativeUpdateId.set(update.id);
      return;
    }
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
      this.confirmArchiveInitiativeUpdateId.set(null);
      this.editingInitiativeUpdateId.set(null);
      await this.loadInitiatives();
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.busyInitiativeUpdateId.set(null);
    }
  }

  async saveInitiativeUpdate(event: Event, current: LinearInitiativeUpdate): Promise<void> {
    event.preventDefault();
    const connection = this.selected();
    const body = this.editInitiativeUpdateBody().trim();
    if (
      !connection ||
      !body ||
      this.savingInitiativeUpdate() ||
      this.initiativeUpdateEditDraftConflict()
    ) {
      return;
    }
    this.savingInitiativeUpdate.set(true);
    this.error.set(null);
    try {
      const latest = await this.tauri.linearInitiatives(connection.organizationId, true, true);
      if (
        this.selected()?.organizationId !== connection.organizationId ||
        this.selected()?.viewerId !== connection.viewerId
      ) {
        return;
      }
      const currentInitiative = latest.find((item) =>
        item.updates.some((candidate) => candidate.id === current.id),
      );
      const currentUpdate = currentInitiative?.updates.find((item) => item.id === current.id);
      if (!currentInitiative || !currentUpdate)
        throw new Error('Linear no longer has this initiative update. Refresh and retry.');
      const currentValues = { body: currentUpdate.body, health: currentUpdate.health };
      const key = this.initiativeUpdateEditDraftKey(connection, current.id);
      const draft = this.readStatusUpdateEditDraft(key) ?? {
        values: {
          body: this.editInitiativeUpdateBody(),
          health: this.editInitiativeUpdateHealth(),
        },
        base: { body: current.body, health: current.health },
      };
      if (linearStatusUpdateEditDraftConflicts(draft, currentValues)) {
        this.initiatives.update((items) =>
          items.map((item) =>
            item.id === currentInitiative.id
              ? { ...currentInitiative, projects: item.projects }
              : item,
          ),
        );
        this.persistInitiativesCache(connection);
        this.initiativeUpdateEditDraftConflict.set(true);
        return;
      }
      if (linearStatusUpdateEditValuesEqual(draft.values, currentValues)) {
        this.applyInitiativeUpdateEditValues(currentValues);
        this.writeLocal(key, null);
        this.hasInitiativeUpdateEditDraft.set(false);
        this.initiativeUpdateEditBase.set(null);
        this.initiatives.update((items) =>
          items.map((item) =>
            item.id === currentInitiative.id
              ? { ...currentInitiative, projects: item.projects }
              : item,
          ),
        );
        this.persistInitiativesCache(connection);
        this.editingInitiativeUpdateId.set(null);
        return;
      }
      const update = await this.tauri.linearUpdateInitiativeUpdate(
        connection.organizationId,
        current.id,
        draft.values.body.trim(),
        draft.values.health,
      );
      if (
        this.selected()?.organizationId !== connection.organizationId ||
        this.selected()?.viewerId !== connection.viewerId
      ) {
        return;
      }
      this.initiatives.update((items) =>
        items.map((initiative) => ({
          ...initiative,
          updates: initiative.updates.map((item) => (item.id === update.id ? update : item)),
        })),
      );
      this.writeLocal(key, null);
      this.hasInitiativeUpdateEditDraft.set(false);
      this.initiativeUpdateEditDraftConflict.set(false);
      this.initiativeUpdateEditBase.set(null);
      this.persistInitiativesCache(connection);
      this.editingInitiativeUpdateId.set(null);
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.savingInitiativeUpdate.set(false);
    }
  }

  async createInitiativeUpdate(event: Event, initiative: LinearInitiative): Promise<void> {
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
      if (this.selected()?.organizationId === connection.organizationId) {
        this.initiatives.update((items) =>
          items.map((item) =>
            item.id === initiative.id ? { ...item, updates: [update, ...item.updates] } : item,
          ),
        );
        this.persistInitiativesCache(connection);
      }
      this.writeLocal(this.initiativeUpdateDraftKey(connection, initiative.id), null);
      if (this.initiativeUpdateId() === initiative.id) {
        this.initiativeUpdateId.set(null);
        this.initiativeUpdateBody.set('');
        this.initiativeUpdateHealth.set('onTrack');
      }
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.creatingInitiativeUpdate.set(false);
    }
  }

  setInitiativeProject(initiativeId: string, projectId: string): void {
    this.initiativeProjectSelection.update((selection) => ({
      ...selection,
      [initiativeId]: projectId,
    }));
  }

  availableInitiativeProjects(initiative: LinearInitiative): readonly LinearProject[] {
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

  async addInitiativeProject(initiative: LinearInitiative): Promise<void> {
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
      this.persistInitiativesCache(connection);
      this.initiativeProjectSelection.update(({ [initiative.id]: _, ...selection }) => selection);
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.savingInitiativeProjectId.set(null);
    }
  }

  async removeInitiativeProject(initiative: LinearInitiative, linkId: string): Promise<void> {
    if (this.confirmRemoveInitiativeProjectId() !== linkId) {
      this.confirmRemoveInitiativeProjectId.set(linkId);
      return;
    }
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
      this.persistInitiativesCache(connection);
      this.confirmRemoveInitiativeProjectId.set(null);
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.savingInitiativeProjectId.set(null);
    }
  }

  async createInitiative(event: Event): Promise<void> {
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
      if (this.selected()?.organizationId === connection.organizationId) {
        this.initiatives.update((items) => [...items, initiative]);
        this.persistInitiativesCache(connection);
        this.newInitiativeName.set('');
        this.newInitiativeDescription.set('');
        this.newInitiativeTargetDate.set('');
      }
      this.writeLocal(this.initiativeDraftKey(connection), null);
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.savingInitiative.set(false);
    }
  }

  editInitiative(initiative: LinearInitiative): void {
    this.editingInitiativeId.set(initiative.id);
    const current = linearInitiativeEditValues(initiative);
    const connection = this.selected();
    const draft = connection ? this.readInitiativeEditDraft(connection, initiative.id) : null;
    this.applyInitiativeEditValues(draft?.values ?? current);
    this.initiativeEditBase.set(draft?.base ?? current);
    this.initiativeEditDraftConflict.set(
      draft ? linearInitiativeEditDraftConflicts(draft, current) : false,
    );
    this.hasInitiativeEditDraft.set(!!draft);
  }

  updateInitiativeEditDraft(
    initiative: LinearInitiative,
    field: keyof LinearInitiativeEditValues,
    value: string,
  ): void {
    if (field === 'name') this.editInitiativeName.set(value);
    else if (field === 'description') this.editInitiativeDescription.set(value);
    else this.editInitiativeTargetDate.set(value);
    const connection = this.selected();
    if (connection) this.saveInitiativeEditDraft(connection, initiative);
  }

  resolveInitiativeEditDraftConflict(initiative: LinearInitiative, keepDraft: boolean): void {
    const connection = this.selected();
    if (!connection) return;
    const current = linearInitiativeEditValues(initiative);
    if (keepDraft) {
      const draft = this.readInitiativeEditDraft(connection, initiative.id);
      if (draft) {
        this.initiativeEditBase.set(current);
        this.writeLocal(this.initiativeEditDraftKey(connection, initiative.id), {
          values: this.currentInitiativeEditValues(),
          base: current,
        } satisfies LinearInitiativeEditDraft);
      }
    } else {
      this.applyInitiativeEditValues(current);
      this.initiativeEditBase.set(current);
      this.writeLocal(this.initiativeEditDraftKey(connection, initiative.id), null);
      this.hasInitiativeEditDraft.set(false);
    }
    this.initiativeEditDraftConflict.set(false);
  }

  async saveInitiative(event: Event, initiative: LinearInitiative): Promise<void> {
    event.preventDefault();
    const connection = this.selected();
    const name = this.editInitiativeName().trim();
    if (!connection || !name || this.savingInitiative() || this.initiativeEditDraftConflict()) {
      return;
    }
    this.savingInitiative.set(true);
    this.error.set(null);
    try {
      const latest = await this.tauri.linearInitiatives(connection.organizationId, true, true);
      if (
        this.selected()?.organizationId !== connection.organizationId ||
        this.selected()?.viewerId !== connection.viewerId
      ) {
        return;
      }
      const currentInitiative = latest.find((item) => item.id === initiative.id);
      if (!currentInitiative)
        throw new Error('Linear no longer has this initiative. Refresh and retry.');
      const applyLatestInitiative = (): void =>
        this.initiatives.update((items) =>
          items.map((item) =>
            item.id === currentInitiative.id
              ? { ...currentInitiative, projects: item.projects }
              : item,
          ),
        );
      const current = linearInitiativeEditValues(currentInitiative);
      const draft = this.readInitiativeEditDraft(connection, initiative.id) ?? {
        values: this.currentInitiativeEditValues(),
        base: this.initiativeEditBase() ?? linearInitiativeEditValues(initiative),
      };
      if (linearInitiativeEditDraftConflicts(draft, current)) {
        applyLatestInitiative();
        this.persistInitiativesCache(connection);
        this.initiativeEditDraftConflict.set(true);
        return;
      }
      if (linearInitiativeEditValuesEqual(draft.values, current)) {
        this.applyInitiativeEditValues(current);
        this.writeLocal(this.initiativeEditDraftKey(connection, initiative.id), null);
        this.hasInitiativeEditDraft.set(false);
        this.initiativeEditBase.set(current);
        applyLatestInitiative();
        this.persistInitiativesCache(connection);
        this.editingInitiativeId.set(null);
        return;
      }
      const updated = await this.tauri.linearUpdateInitiative(
        connection.organizationId,
        currentInitiative.id,
        draft.values.name.trim(),
        draft.values.description,
        draft.values.targetDate,
      );
      if (
        this.selected()?.organizationId !== connection.organizationId ||
        this.selected()?.viewerId !== connection.viewerId
      ) {
        return;
      }
      this.initiatives.update((items) =>
        items.map((item) =>
          item.id === updated.id ? { ...updated, projects: currentInitiative.projects } : item,
        ),
      );
      this.writeLocal(this.initiativeEditDraftKey(connection, initiative.id), null);
      this.hasInitiativeEditDraft.set(false);
      this.initiativeEditDraftConflict.set(false);
      this.initiativeEditBase.set(null);
      this.persistInitiativesCache(connection);
      this.editingInitiativeId.set(null);
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.savingInitiative.set(false);
    }
  }

  private currentInitiativeEditValues(): LinearInitiativeEditValues {
    return {
      name: this.editInitiativeName(),
      description: this.editInitiativeDescription(),
      targetDate: this.editInitiativeTargetDate(),
    };
  }

  private applyInitiativeEditValues(values: LinearInitiativeEditValues): void {
    this.editInitiativeName.set(values.name);
    this.editInitiativeDescription.set(values.description);
    this.editInitiativeTargetDate.set(values.targetDate);
  }

  private saveInitiativeEditDraft(
    connection: LinearConnection,
    initiative: LinearInitiative,
  ): void {
    const values = this.currentInitiativeEditValues();
    const original = this.readInitiativeEditDraft(connection, initiative.id);
    const draft: LinearInitiativeEditDraft = {
      values,
      base: original?.base ?? this.initiativeEditBase() ?? linearInitiativeEditValues(initiative),
    };
    const hasDraft = !linearInitiativeEditValuesEqual(draft.values, draft.base);
    this.writeLocal(
      this.initiativeEditDraftKey(connection, initiative.id),
      hasDraft ? draft : null,
    );
    this.hasInitiativeEditDraft.set(hasDraft);
  }

  private readInitiativeEditDraft(
    connection: LinearConnection,
    initiativeId: string,
  ): LinearInitiativeEditDraft | null {
    const value = this.readLocal<unknown>(this.initiativeEditDraftKey(connection, initiativeId));
    return isLinearInitiativeEditDraft(value) ? value : null;
  }

  async openProject(project: LinearProject): Promise<void> {
    this.closeIssueDetail();
    this.confirmArchiveProjectId.set(null);
    this.confirmArchiveIssueId.set(null);
    this.confirmDeleteMilestoneId.set(null);
    this.includeArchivedProjectIssues.set(false);
    this.projectIssueSearchInput.set('');
    this.projectIssueSearchTerm.set('');
    this.projectIssueStateId.set('');
    this.projectIssuePriority.set('');
    this.projectIssueAssigneeId.set('');
    this.projectIssueLabelId.set('');
    this.selectedProject.set(project);
    if (project.teams?.length && !project.teams.some((team) => team.id === this.createTeamId())) {
      this.setCreateTeam(project.teams[0].id);
    }
    this.projectIssues.set([]);
    this.projectIssueCacheStale.set(false);
    this.nextProjectIssueCursor = null;
    this.projectIssuesHasNextPage.set(false);
    const connection = this.selected();
    if (connection) {
      this.restoreProjectIssueDraft(connection, project.id);
      this.restoreProjectPlanningDraft(connection, project.id);
      this.restoreProjectDocumentCreateDraft(connection, project.id);
      this.restoreProjectLinkDraft(connection, project.id);
    }
    if (connection) this.restoreProjectEditDraft(connection, project);
    else this.applyProjectEditValues(linearProjectEditValues(project));
    this.projectUpdates.set([]);
    this.projectResources.set({ documents: [], externalLinks: [] });
    this.closeProjectDocumentEditor();
    this.confirmDeleteProjectLinkId.set(null);
    this.githubRepositoriesForLink.set(null);
    this.selectedGithubRepository.set('');
    await Promise.all([
      this.loadProjectIssues(project.id),
      this.loadMilestones(project.id),
      this.loadProjectUpdates(project.id),
      this.loadProjectResources(project.id),
      this.canUseCodex ? this.loadCodexPolicy() : Promise.resolve(),
    ]);
  }

  toggleArchivedProjectIssues(): void {
    const project = this.selectedProject();
    if (!project || this.loadingProjectIssues()) return;
    this.includeArchivedProjectIssues.update((value) => !value);
    this.projectIssues.set([]);
    this.nextProjectIssueCursor = null;
    this.projectIssuesHasNextPage.set(false);
    void this.loadProjectIssues(project.id);
  }

  searchProjectIssues(event: Event): void {
    event.preventDefault();
    const project = this.selectedProject();
    const search = this.projectIssueSearchInput().trim();
    if (!project || this.loadingProjectIssues() || search === this.projectIssueSearchTerm()) return;
    this.projectIssueSearchTerm.set(search);
    this.projectIssues.set([]);
    this.nextProjectIssueCursor = null;
    this.projectIssuesHasNextPage.set(false);
    void this.loadProjectIssues(project.id);
  }

  clearProjectIssueSearch(): void {
    const project = this.selectedProject();
    if (!project || this.loadingProjectIssues() || !this.projectIssueSearchTerm()) return;
    this.projectIssueSearchInput.set('');
    this.projectIssueSearchTerm.set('');
    this.projectIssues.set([]);
    this.nextProjectIssueCursor = null;
    this.projectIssuesHasNextPage.set(false);
    void this.loadProjectIssues(project.id);
  }

  setProjectIssueStateFilter(stateId: string): void {
    const project = this.selectedProject();
    if (!project || this.loadingProjectIssues() || stateId === this.projectIssueStateId()) return;
    this.projectIssueStateId.set(stateId);
    this.resetProjectIssuePage(project.id);
  }

  setProjectIssuePriorityFilter(priority: string): void {
    const project = this.selectedProject();
    if (!project || this.loadingProjectIssues() || priority === this.projectIssuePriority()) return;
    this.projectIssuePriority.set(priority);
    this.resetProjectIssuePage(project.id);
  }

  setProjectIssueAssigneeFilter(assigneeId: string): void {
    const project = this.selectedProject();
    if (!project || this.loadingProjectIssues() || assigneeId === this.projectIssueAssigneeId())
      return;
    this.projectIssueAssigneeId.set(assigneeId);
    this.resetProjectIssuePage(project.id);
  }

  setProjectIssueLabelFilter(labelId: string): void {
    const project = this.selectedProject();
    if (!project || this.loadingProjectIssues() || labelId === this.projectIssueLabelId()) return;
    this.projectIssueLabelId.set(labelId);
    this.resetProjectIssuePage(project.id);
  }

  projectIssueFilterCount(): number {
    return (
      Number(!!this.projectIssueStateId()) +
      Number(!!this.projectIssuePriority()) +
      Number(!!this.projectIssueAssigneeId()) +
      Number(!!this.projectIssueLabelId())
    );
  }

  private resetProjectIssuePage(projectId: string): void {
    this.projectIssues.set([]);
    this.nextProjectIssueCursor = null;
    this.projectIssuesHasNextPage.set(false);
    void this.loadProjectIssues(projectId);
  }

  loadMoreProjectIssues(): void {
    const project = this.selectedProject();
    if (!project || !this.nextProjectIssueCursor || this.loadingProjectIssues()) return;
    void this.loadProjectIssues(project.id, this.nextProjectIssueCursor, true);
  }

  closeSelectedProject(): void {
    this.selectedProject.set(null);
    this.confirmArchiveProjectId.set(null);
    this.confirmDeleteMilestoneId.set(null);
    this.projectUpdates.set([]);
  }

  projectHealthLabel(health: LinearProjectHealth): string {
    return health === 'onTrack' ? 'On track' : health === 'atRisk' ? 'At risk' : 'Off track';
  }

  projectUpdateDate(createdAt: string): string {
    return new Date(createdAt).toLocaleString();
  }

  editProjectUpdate(update: LinearProjectUpdate): void {
    this.editingProjectUpdateId.set(update.id);
    this.projectUpdateEditBase.set({ body: update.body, health: update.health });
    const connection = this.selected();
    const draft = connection
      ? this.readStatusUpdateEditDraft(this.projectUpdateEditDraftKey(connection, update.id))
      : null;
    const values = draft?.values ?? { body: update.body, health: update.health };
    this.editProjectUpdateBody.set(values.body);
    this.editProjectUpdateHealth.set(values.health);
    this.projectUpdateEditDraftConflict.set(
      draft
        ? linearStatusUpdateEditDraftConflicts(draft, { body: update.body, health: update.health })
        : false,
    );
    this.hasProjectUpdateEditDraft.set(!!draft);
  }

  updateProjectUpdateEdit(field: 'body' | 'health', value: string): void {
    if (field === 'body') this.editProjectUpdateBody.set(value);
    else this.editProjectUpdateHealth.set(this.updateHealth(value));
    const connection = this.selected();
    const updateId = this.editingProjectUpdateId();
    if (!connection || !updateId) return;
    this.saveStatusUpdateEditDraft(
      this.projectUpdateEditDraftKey(connection, updateId),
      { body: this.editProjectUpdateBody(), health: this.editProjectUpdateHealth() },
      this.projectUpdateEditBase() ?? {
        body: this.editProjectUpdateBody(),
        health: this.editProjectUpdateHealth(),
      },
      this.hasProjectUpdateEditDraft,
    );
  }

  resolveProjectUpdateEditDraftConflict(update: LinearProjectUpdate, keepDraft: boolean): void {
    const connection = this.selected();
    if (!connection) return;
    const current = { body: update.body, health: update.health };
    const key = this.projectUpdateEditDraftKey(connection, update.id);
    const draft = this.readStatusUpdateEditDraft(key);
    if (keepDraft && draft) {
      this.projectUpdateEditBase.set(current);
      this.writeLocal(key, { values: this.currentProjectUpdateEditValues(), base: current });
    } else {
      this.projectUpdateEditBase.set(current);
      this.applyProjectUpdateEditValues(current);
      this.writeLocal(key, null);
      this.hasProjectUpdateEditDraft.set(false);
    }
    this.projectUpdateEditDraftConflict.set(false);
  }

  private currentProjectUpdateEditValues(): LinearInitiativeUpdateDraft {
    return { body: this.editProjectUpdateBody(), health: this.editProjectUpdateHealth() };
  }

  private applyProjectUpdateEditValues(values: LinearInitiativeUpdateDraft): void {
    this.editProjectUpdateBody.set(values.body);
    this.editProjectUpdateHealth.set(values.health);
  }

  private updateHealth(value: string): LinearProjectHealth {
    return ['onTrack', 'atRisk', 'offTrack'].includes(value)
      ? (value as LinearProjectHealth)
      : 'onTrack';
  }

  private readStatusUpdateEditDraft(key: string): LinearStatusUpdateEditDraft | null {
    const value = this.readLocal<unknown>(key);
    return isLinearStatusUpdateEditDraft(value) ? value : null;
  }

  private saveStatusUpdateEditDraft(
    key: string,
    values: LinearInitiativeUpdateDraft,
    base: LinearInitiativeUpdateDraft,
    hasDraftSignal: WritableSignal<boolean>,
  ): void {
    const draft: LinearStatusUpdateEditDraft = {
      values,
      base: this.readStatusUpdateEditDraft(key)?.base ?? base,
    };
    const hasDraft = !linearStatusUpdateEditValuesEqual(draft.values, draft.base);
    this.writeLocal(key, hasDraft ? draft : null);
    hasDraftSignal.set(hasDraft);
  }

  private projectUpdateEditDraftKey(connection: LinearConnection, updateId: string): string {
    return `relay.linear.projectUpdateEditDraft.${connection.organizationId}.${connection.viewerId}.${updateId}`;
  }

  private initiativeUpdateEditDraftKey(connection: LinearConnection, updateId: string): string {
    return `relay.linear.initiativeUpdateEditDraft.${connection.organizationId}.${connection.viewerId}.${updateId}`;
  }

  private labelEditDraftKey(connection: LinearConnection, labelId: string): string {
    return `relay.linear.labelEditDraft.${connection.organizationId}.${connection.viewerId}.${labelId}`;
  }

  toggleArchivedProjectUpdates(): void {
    const project = this.selectedProject();
    if (!project) return;
    this.includeArchivedProjectUpdates.update((includeArchived) => !includeArchived);
    void this.loadProjectUpdates(project.id);
  }

  async setProjectUpdateArchived(update: LinearProjectUpdate, archived: boolean): Promise<void> {
    if (archived && this.confirmArchiveProjectUpdateId() !== update.id) {
      this.confirmArchiveProjectUpdateId.set(update.id);
      return;
    }
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
      this.confirmArchiveProjectUpdateId.set(null);
      await this.loadProjectUpdates(project.id);
      this.editingProjectUpdateId.set(null);
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.busyProjectUpdateId.set(null);
    }
  }

  async saveProjectUpdate(event: Event, current: LinearProjectUpdate): Promise<void> {
    event.preventDefault();
    const connection = this.selected();
    const body = this.editProjectUpdateBody().trim();
    const project = this.selectedProject();
    if (
      !connection ||
      !project ||
      !body ||
      this.savingProjectUpdate() ||
      this.projectUpdateEditDraftConflict()
    ) {
      return;
    }
    this.savingProjectUpdate.set(true);
    this.error.set(null);
    try {
      const latest = await this.tauri.linearProjectUpdates(
        connection.organizationId,
        project.id,
        this.includeArchivedProjectUpdates(),
      );
      if (
        this.selected()?.organizationId !== connection.organizationId ||
        this.selected()?.viewerId !== connection.viewerId ||
        this.selectedProject()?.id !== project.id
      ) {
        return;
      }
      const currentUpdate = latest.find((update) => update.id === current.id);
      if (!currentUpdate)
        throw new Error('Linear no longer has this project update. Refresh and retry.');
      const currentValues = { body: currentUpdate.body, health: currentUpdate.health };
      const key = this.projectUpdateEditDraftKey(connection, current.id);
      const draft = this.readStatusUpdateEditDraft(key) ?? {
        values: this.currentProjectUpdateEditValues(),
        base: this.projectUpdateEditBase() ?? { body: current.body, health: current.health },
      };
      if (linearStatusUpdateEditDraftConflicts(draft, currentValues)) {
        this.projectUpdates.set(latest);
        this.saveProjectUpdatesCache(project.id, this.includeArchivedProjectUpdates());
        this.projectUpdateEditDraftConflict.set(true);
        return;
      }
      if (linearStatusUpdateEditValuesEqual(draft.values, currentValues)) {
        this.applyProjectUpdateEditValues(currentValues);
        this.writeLocal(key, null);
        this.hasProjectUpdateEditDraft.set(false);
        this.projectUpdateEditBase.set(currentValues);
        this.projectUpdates.set(latest);
        this.saveProjectUpdatesCache(project.id, this.includeArchivedProjectUpdates());
        this.editingProjectUpdateId.set(null);
        return;
      }
      const updated = await this.tauri.linearUpdateProjectUpdate(
        connection.organizationId,
        current.id,
        draft.values.body.trim(),
        draft.values.health,
      );
      if (
        this.selected()?.organizationId !== connection.organizationId ||
        this.selected()?.viewerId !== connection.viewerId ||
        this.selectedProject()?.id !== project.id
      ) {
        return;
      }
      this.projectUpdates.set(
        latest.map((update) => (update.id === updated.id ? updated : update)),
      );
      this.writeLocal(key, null);
      this.hasProjectUpdateEditDraft.set(false);
      this.projectUpdateEditDraftConflict.set(false);
      this.projectUpdateEditBase.set(null);
      this.saveProjectUpdatesCache(project.id, this.includeArchivedProjectUpdates());
      this.editingProjectUpdateId.set(null);
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.savingProjectUpdate.set(false);
    }
  }

  updateProjectPlanningDraft(field: keyof LinearProjectPlanningDraft, value: string): void {
    if (field === 'projectUpdateBody') this.newProjectUpdateBody.set(value);
    else if (field === 'projectUpdateHealth') {
      this.newProjectUpdateHealth.set(
        ['onTrack', 'atRisk', 'offTrack'].includes(value)
          ? (value as LinearProjectHealth)
          : 'onTrack',
      );
    } else if (field === 'milestoneName') this.newMilestoneName.set(value);
    else if (field === 'milestoneDescription') this.newMilestoneDescription.set(value);
    else this.newMilestoneDate.set(value);
    const project = this.selectedProject();
    if (project) this.saveProjectPlanningDraft(project.id);
  }

  hasProjectPlanningDraft(): boolean {
    return !!(
      this.newProjectUpdateBody() ||
      this.newProjectUpdateHealth() !== 'onTrack' ||
      this.newMilestoneName() ||
      this.newMilestoneDescription() ||
      this.newMilestoneDate()
    );
  }

  private restoreProjectPlanningDraft(connection: LinearConnection, projectId: string): void {
    const stored = this.readLocal<unknown>(this.projectPlanningDraftKey(connection, projectId));
    const draft = isLinearProjectPlanningDraft(stored) ? stored : null;
    this.newProjectUpdateBody.set(draft?.projectUpdateBody ?? '');
    this.newProjectUpdateHealth.set(draft?.projectUpdateHealth ?? 'onTrack');
    this.newMilestoneName.set(draft?.milestoneName ?? '');
    this.newMilestoneDescription.set(draft?.milestoneDescription ?? '');
    this.newMilestoneDate.set(draft?.milestoneDate ?? '');
  }

  private saveProjectPlanningDraft(projectId: string): void {
    const connection = this.selected();
    if (!connection) return;
    const draft: LinearProjectPlanningDraft = {
      projectUpdateBody: this.newProjectUpdateBody(),
      projectUpdateHealth: this.newProjectUpdateHealth(),
      milestoneName: this.newMilestoneName(),
      milestoneDescription: this.newMilestoneDescription(),
      milestoneDate: this.newMilestoneDate(),
    };
    const hasDraft = Boolean(
      draft.projectUpdateBody ||
      draft.projectUpdateHealth !== 'onTrack' ||
      draft.milestoneName ||
      draft.milestoneDescription ||
      draft.milestoneDate,
    );
    this.writeLocal(this.projectPlanningDraftKey(connection, projectId), hasDraft ? draft : null);
  }

  async createProjectUpdate(event: Event): Promise<void> {
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
      this.saveProjectUpdatesCache(project.id, this.includeArchivedProjectUpdates());
      this.newProjectUpdateBody.set('');
      this.newProjectUpdateHealth.set('onTrack');
      this.saveProjectPlanningDraft(project.id);
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.creatingProjectUpdate.set(false);
    }
  }

  async createMilestone(event: Event): Promise<void> {
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
      this.saveMilestoneCache(project.id);
      this.newMilestoneName.set('');
      this.newMilestoneDescription.set('');
      this.newMilestoneDate.set('');
      this.saveProjectPlanningDraft(project.id);
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.creatingMilestone.set(false);
    }
  }

  async editMilestone(milestone: LinearMilestone): Promise<void> {
    const connection = this.selected();
    const project = this.selectedProject();
    if (!connection || !project || this.loadingMilestoneId()) return;
    const requestId = ++this.milestoneEditRequest;
    this.loadingMilestoneId.set(milestone.id);
    let current = milestone;
    try {
      const latest = await this.tauri.linearProjectMilestones(
        connection.organizationId,
        project.id,
      );
      if (requestId !== this.milestoneEditRequest || this.selectedProject()?.id !== project.id)
        return;
      current = latest.find((item) => item.id === milestone.id) ?? milestone;
      this.milestones.set(latest);
      this.saveMilestoneCache(project.id);
    } catch {
      if (requestId !== this.milestoneEditRequest || this.selectedProject()?.id !== project.id)
        return;
    } finally {
      if (requestId === this.milestoneEditRequest) this.loadingMilestoneId.set(null);
    }
    const draft = this.readMilestoneEditDraft(connection, project.id, current.id);
    const values = draft?.values ?? linearMilestoneEditValues(current);
    this.editingMilestoneId.set(current.id);
    this.editMilestoneName.set(values.name);
    this.editMilestoneDescription.set(values.description);
    this.editMilestoneDate.set(values.targetDate);
    this.milestoneEditBase.set(draft?.base ?? linearMilestoneEditValues(current));
    this.milestoneEditDraftConflict.set(
      draft ? linearMilestoneEditDraftConflicts(draft, linearMilestoneEditValues(current)) : false,
    );
    this.hasMilestoneEditDraft.set(!!draft);
  }

  updateMilestoneEditDraft(
    milestone: LinearMilestone,
    field: keyof LinearMilestoneEditValues,
    value: string,
  ): void {
    if (field === 'name') this.editMilestoneName.set(value);
    else if (field === 'description') this.editMilestoneDescription.set(value);
    else this.editMilestoneDate.set(value);
    const connection = this.selected();
    const project = this.selectedProject();
    if (connection && project) this.saveMilestoneEditDraft(connection, project.id, milestone);
  }

  resolveMilestoneEditDraftConflict(milestone: LinearMilestone, keepDraft: boolean): void {
    const connection = this.selected();
    const project = this.selectedProject();
    if (!connection || !project) return;
    const current = linearMilestoneEditValues(milestone);
    if (keepDraft) {
      const draft = this.readMilestoneEditDraft(connection, project.id, milestone.id);
      if (draft) {
        this.milestoneEditBase.set(current);
        this.writeLocal(this.milestoneEditDraftKey(connection, project.id, milestone.id), {
          values: this.currentMilestoneEditValues(),
          base: current,
        } satisfies LinearMilestoneEditDraft);
      }
    } else {
      this.applyMilestoneEditValues(current);
      this.milestoneEditBase.set(current);
      this.writeLocal(this.milestoneEditDraftKey(connection, project.id, milestone.id), null);
      this.hasMilestoneEditDraft.set(false);
    }
    this.milestoneEditDraftConflict.set(false);
  }

  async saveMilestone(event: Event, milestone: LinearMilestone): Promise<void> {
    event.preventDefault();
    const connection = this.selected();
    const project = this.selectedProject();
    const name = this.editMilestoneName().trim();
    if (
      !connection ||
      !project ||
      !name ||
      this.savingMilestone() ||
      this.milestoneEditDraftConflict()
    ) {
      return;
    }
    this.savingMilestone.set(true);
    this.error.set(null);
    try {
      const latest = await this.tauri.linearProjectMilestones(
        connection.organizationId,
        project.id,
      );
      const currentMilestone = latest.find((item) => item.id === milestone.id);
      if (!currentMilestone)
        throw new Error('Linear no longer has this milestone. Refresh and retry.');
      this.milestones.set(latest);
      const current = linearMilestoneEditValues(currentMilestone);
      const draft = this.readMilestoneEditDraft(connection, project.id, milestone.id) ?? {
        values: this.currentMilestoneEditValues(),
        base: this.milestoneEditBase() ?? linearMilestoneEditValues(milestone),
      };
      if (linearMilestoneEditDraftConflicts(draft, current)) {
        this.milestoneEditDraftConflict.set(true);
        return;
      }
      if (linearMilestoneEditValuesEqual(draft.values, current)) {
        this.applyMilestoneEditValues(current);
        this.writeLocal(this.milestoneEditDraftKey(connection, project.id, milestone.id), null);
        this.hasMilestoneEditDraft.set(false);
        this.milestoneEditBase.set(current);
        this.saveMilestoneCache(project.id);
        return;
      }
      const updated = await this.tauri.linearUpdateMilestone(
        connection.organizationId,
        currentMilestone.id,
        draft.values.name.trim(),
        draft.values.description.trim(),
        draft.values.targetDate,
      );
      this.milestones.update((items) =>
        items.map((item) => (item.id === updated.id ? updated : item)),
      );
      this.writeLocal(this.milestoneEditDraftKey(connection, project.id, milestone.id), null);
      this.hasMilestoneEditDraft.set(false);
      this.milestoneEditDraftConflict.set(false);
      this.milestoneEditBase.set(null);
      this.saveMilestoneCache(project.id);
      this.editingMilestoneId.set(null);
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.savingMilestone.set(false);
    }
  }

  async deleteMilestone(milestone: LinearMilestone): Promise<void> {
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
      const projectId = this.selectedProject()?.id;
      if (projectId) this.saveMilestoneCache(projectId);
      if (this.editingMilestoneId() === milestone.id) this.editingMilestoneId.set(null);
      this.confirmDeleteMilestoneId.set(null);
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.deletingMilestoneId.set(null);
    }
  }

  async createProject(event: Event): Promise<void> {
    event.preventDefault();
    const connection = this.selected();
    const name = this.newProjectName().trim();
    if (!connection || !this.createTeamId() || !name || this.creatingProject()) return;
    this.creatingProject.set(true);
    this.error.set(null);
    try {
      const project = await this.tauri.linearCreateProject(
        connection.organizationId,
        this.newProjectTeamIds(),
        name,
        this.newProjectDescription().trim(),
        this.newProjectStartDate(),
        this.newProjectTargetDate(),
        this.newProjectStatusId(),
        this.newProjectLeadId(),
      );
      this.writeLocal(this.projectDraftKey(connection), null);
      if (
        this.selected()?.organizationId !== connection.organizationId ||
        this.selected()?.viewerId !== connection.viewerId
      ) {
        return;
      }
      this.newProjectName.set('');
      this.newProjectDescription.set('');
      this.newProjectStartDate.set('');
      this.newProjectTargetDate.set('');
      this.newProjectStatusId.set('');
      this.newProjectLeadId.set('');
      this.newProjectTeamIds.set([]);
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

  async saveProject(event: Event): Promise<void> {
    event.preventDefault();
    const connection = this.selected();
    const openedProject = this.selectedProject();
    const name = this.editProjectName().trim();
    if (
      !connection ||
      !openedProject ||
      !name ||
      this.savingProject() ||
      this.projectEditDraftConflict()
    ) {
      return;
    }
    this.savingProject.set(true);
    this.error.set(null);
    try {
      const latest = (
        await this.tauri.linearProjects(connection.organizationId, this.showArchivedProjects())
      ).find((item) => item.id === openedProject.id);
      if (!latest) throw new Error('Linear no longer has this project. Refresh and try again.');
      const draft = this.readProjectEditDraft(connection, latest.id) ?? {
        values: this.currentProjectEditValues(),
        base: linearProjectEditValues(openedProject),
      };
      const current = linearProjectEditValues(latest);
      if (linearProjectEditDraftConflicts(draft, current)) {
        this.selectedProject.set(latest);
        this.projectEditDraftConflict.set(true);
        return;
      }
      if (linearProjectEditValuesEqual(draft.values, current)) {
        this.selectedProject.set(latest);
        this.applyProjectEditValues(current);
        this.writeLocal(this.projectEditDraftKey(connection, latest.id), null);
        this.hasProjectEditDraft.set(false);
        return;
      }
      const updated = await this.tauri.linearUpdateProject(
        connection.organizationId,
        latest.id,
        draft.values.name.trim(),
        draft.values.description,
        draft.values.startDate,
        draft.values.targetDate,
        draft.values.statusId,
        draft.values.leadId,
        !draft.values.leadId,
        draft.values.teamIds,
      );
      this.selectedProject.set(updated);
      this.applyProjectEditValues(linearProjectEditValues(updated));
      this.writeLocal(this.projectEditDraftKey(connection, latest.id), null);
      this.hasProjectEditDraft.set(false);
      this.projectEditDraftConflict.set(false);
      if (updated.teams.length && !updated.teams.some((team) => team.id === this.createTeamId())) {
        this.setCreateTeam(updated.teams[0].id);
      }
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

  async openProjectById(projectId: string): Promise<void> {
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

  projectTeamNames(project: LinearProject): string {
    return (project.teams ?? []).map((team) => team.name).join(', ');
  }

  private async loadSection(connection: LinearConnection): Promise<void> {
    if (this.section() === 'labels') await this.loadLabels(connection);
    if (this.section() === 'projects') await this.loadProjects();
    if (this.section() === 'roadmap') {
      await Promise.all([this.loadInitiatives(), this.loadProjects()]);
    }
    if (this.section() === 'cycles') {
      try {
        const teams = await this.loadCachedTeams(connection);
        await Promise.all(teams.map((team) => this.loadTeamCycles(connection, team.id)));
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
    const includeArchived = this.includeArchivedProjectIssues();
    const search = this.projectIssueSearchTerm();
    const stateId = this.projectIssueStateId() || undefined;
    const priority =
      this.projectIssuePriority() === '' ? undefined : Number(this.projectIssuePriority());
    const assigneeId = this.projectIssueAssigneeId() || undefined;
    const labelId = this.projectIssueLabelId() || undefined;
    const cacheKey = this.projectIssueCacheKey(connection, projectId);
    const cached = this.readLocal<LinearIssuePage>(cacheKey);
    const hasCache = !!cached && Array.isArray(cached.issues);
    if (!append) this.projectIssueCacheStale.set(false);
    if (!append && hasCache && cached && this.selectedProject()?.id === projectId) {
      this.projectIssues.set(cached.issues);
      this.nextProjectIssueCursor = cached.endCursor;
      this.projectIssuesHasNextPage.set(cached.hasNextPage === true);
      this.projectIssueCacheStale.set(true);
    }
    this.loadingProjectIssues.set(true);
    try {
      const page = await this.tauri.linearProjectIssues(
        connection.organizationId,
        projectId,
        after,
        includeArchived,
        search,
        stateId,
        priority,
        assigneeId,
        labelId,
      );
      if (request === this.projectIssuesRequest && this.selectedProject()?.id === projectId) {
        const issues = append ? [...this.projectIssues(), ...page.issues] : page.issues;
        this.projectIssues.set(issues);
        this.nextProjectIssueCursor = page.endCursor;
        this.projectIssuesHasNextPage.set(page.hasNextPage);
        this.projectIssueCacheStale.set(false);
        this.writeLocal(cacheKey, { ...page, issues } satisfies LinearIssuePage);
      }
    } catch (error) {
      if (request === this.projectIssuesRequest) {
        const hasVisibleIssues = this.projectIssues().length > 0;
        this.projectIssueCacheStale.set(hasCache || (append && hasVisibleIssues));
        this.error.set(
          hasCache || (append && hasVisibleIssues)
            ? 'Linear is unavailable. Showing saved project issues.'
            : error instanceof Error
              ? error.message
              : String(error),
        );
      }
    } finally {
      if (request === this.projectIssuesRequest) this.loadingProjectIssues.set(false);
    }
  }

  private async loadMilestones(projectId: string): Promise<void> {
    const connection = this.selected();
    if (!connection) return;
    const requestId = ++this.milestoneRequest;
    const cacheKey = this.milestoneCacheKey(connection, projectId);
    const cached = this.readLocal<readonly LinearMilestone[]>(cacheKey);
    const hasCache = Array.isArray(cached);
    const isVisible = () =>
      this.selected()?.organizationId === connection.organizationId &&
      (this.selectedProject()?.id === projectId ||
        this.issueDetail()?.issue.project?.id === projectId);
    if (hasCache && isVisible()) this.milestones.set(cached);
    try {
      const milestones = await this.tauri.linearProjectMilestones(
        connection.organizationId,
        projectId,
      );
      if (requestId !== this.milestoneRequest || !isVisible()) return;
      this.milestones.set(milestones);
      this.writeLocal(cacheKey, milestones);
    } catch (error) {
      if (requestId !== this.milestoneRequest || !isVisible()) return;
      this.error.set(
        hasCache
          ? 'Linear is unavailable. Showing saved milestones.'
          : error instanceof Error
            ? error.message
            : String(error),
      );
    }
  }

  private saveMilestoneCache(projectId: string): void {
    const connection = this.selected();
    if (connection)
      this.writeLocal(this.milestoneCacheKey(connection, projectId), this.milestones());
  }

  private milestoneCacheKey(connection: LinearConnection, projectId: string): string {
    return `relay.linear.milestones.${connection.organizationId}.${connection.viewerId}.${projectId}`;
  }

  private milestoneEditDraftKey(
    connection: LinearConnection,
    projectId: string,
    milestoneId: string,
  ): string {
    return `relay.linear.milestoneEditDraft.${connection.organizationId}.${connection.viewerId}.${projectId}.${milestoneId}`;
  }

  private currentMilestoneEditValues(): LinearMilestoneEditValues {
    return {
      name: this.editMilestoneName(),
      description: this.editMilestoneDescription(),
      targetDate: this.editMilestoneDate(),
    };
  }

  private applyMilestoneEditValues(values: LinearMilestoneEditValues): void {
    this.editMilestoneName.set(values.name);
    this.editMilestoneDescription.set(values.description);
    this.editMilestoneDate.set(values.targetDate);
  }

  private saveMilestoneEditDraft(
    connection: LinearConnection,
    projectId: string,
    milestone: LinearMilestone,
  ): void {
    const values = this.currentMilestoneEditValues();
    const original = this.readMilestoneEditDraft(connection, projectId, milestone.id);
    const draft: LinearMilestoneEditDraft = {
      values,
      base: original?.base ?? this.milestoneEditBase() ?? linearMilestoneEditValues(milestone),
    };
    const hasDraft = !linearMilestoneEditValuesEqual(draft.values, draft.base);
    this.writeLocal(
      this.milestoneEditDraftKey(connection, projectId, milestone.id),
      hasDraft ? draft : null,
    );
    this.hasMilestoneEditDraft.set(hasDraft);
  }

  private readMilestoneEditDraft(
    connection: LinearConnection,
    projectId: string,
    milestoneId: string,
  ): LinearMilestoneEditDraft | null {
    const value = this.readLocal<unknown>(
      this.milestoneEditDraftKey(connection, projectId, milestoneId),
    );
    return isLinearMilestoneEditDraft(value) ? value : null;
  }

  private async loadProjectResources(projectId: string): Promise<void> {
    const connection = this.selected();
    if (!connection) return;
    const cacheKey = this.projectResourcesCacheKey(connection, projectId);
    const cached = this.readLocal<LinearProjectResources>(cacheKey);
    const hasCache = Array.isArray(cached?.documents) && Array.isArray(cached?.externalLinks);
    if (hasCache && this.selectedProject()?.id === projectId) this.projectResources.set(cached);
    try {
      const resources = await this.tauri.linearProjectResources(
        connection.organizationId,
        projectId,
      );
      if (this.selectedProject()?.id === projectId) {
        this.projectResources.set(resources);
        this.writeLocal(cacheKey, resources);
      }
    } catch (error) {
      this.error.set(
        hasCache
          ? 'Linear is unavailable. Showing saved project resources.'
          : error instanceof Error
            ? error.message
            : String(error),
      );
    }
  }

  private updateProjectResources(
    projectId: string,
    update: (resources: LinearProjectResources) => LinearProjectResources,
  ): void {
    const resources = update(this.projectResources());
    this.projectResources.set(resources);
    const connection = this.selected();
    if (connection) {
      this.writeLocal(this.projectResourcesCacheKey(connection, projectId), resources);
    }
  }

  async editProjectDocument(document: LinearDocument): Promise<void> {
    const connection = this.selected();
    const project = this.selectedProject();
    if (!connection || !project || this.loadingProjectDocumentId()) return;
    this.loadingProjectDocumentId.set(document.id);
    this.error.set(null);
    try {
      const detail = await this.tauri.linearProjectDocument(connection.organizationId, document.id);
      if (this.selectedProject()?.id !== project.id) return;
      const draft = this.readProjectDocumentDraft(connection, document.id);
      this.editingProjectDocumentId.set(detail.id);
      this.editProjectDocumentTitle.set(draft?.title ?? detail.title);
      this.editProjectDocumentContent.set(draft?.content ?? detail.content ?? '');
      this.editProjectDocumentUpdatedAt.set(draft?.updatedAt ?? detail.updatedAt);
      this.projectDocumentEditConflict.set(
        draft ? linearProjectDocumentDraftConflicts(draft, detail.updatedAt) : false,
      );
      this.projectDocumentEditOffline.set(false);
    } catch (error) {
      const draft = this.readProjectDocumentDraft(connection, document.id);
      const isCachedDocument = this.projectResources().documents.some(
        (item) => item.id === document.id,
      );
      if (!draft || !isCachedDocument || this.selectedProject()?.id !== project.id) {
        this.error.set(error instanceof Error ? error.message : String(error));
        return;
      }
      this.editingProjectDocumentId.set(document.id);
      this.editProjectDocumentTitle.set(draft.title);
      this.editProjectDocumentContent.set(draft.content);
      this.editProjectDocumentUpdatedAt.set(draft.updatedAt);
      this.projectDocumentEditConflict.set(false);
      this.projectDocumentEditOffline.set(true);
    } finally {
      this.loadingProjectDocumentId.set(null);
    }
  }

  async reloadProjectDocument(): Promise<void> {
    const documentId = this.editingProjectDocumentId();
    const connection = this.selected();
    if (!documentId || !connection || this.loadingProjectDocumentId()) return;
    this.loadingProjectDocumentId.set(documentId);
    try {
      const detail = await this.tauri.linearProjectDocument(connection.organizationId, documentId);
      if (this.editingProjectDocumentId() !== documentId) return;
      this.editProjectDocumentTitle.set(detail.title);
      this.editProjectDocumentContent.set(detail.content ?? '');
      this.editProjectDocumentUpdatedAt.set(detail.updatedAt);
      this.writeLocal(this.projectDocumentDraftKey(connection, documentId), null);
      this.projectDocumentEditConflict.set(false);
      this.projectDocumentEditOffline.set(false);
      this.error.set(null);
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.loadingProjectDocumentId.set(null);
    }
  }

  async saveProjectDocument(event: Event): Promise<void> {
    event.preventDefault();
    const connection = this.selected();
    const project = this.selectedProject();
    const documentId = this.editingProjectDocumentId();
    const updatedAt = this.editProjectDocumentUpdatedAt();
    const title = this.editProjectDocumentTitle().trim();
    const content = this.editProjectDocumentContent();
    if (
      !connection ||
      !project ||
      !documentId ||
      !updatedAt ||
      !title ||
      this.savingProjectDocument()
    ) {
      return;
    }
    this.savingProjectDocument.set(true);
    this.error.set(null);
    try {
      const updated = await this.tauri.linearUpdateProjectDocument(
        connection.organizationId,
        documentId,
        updatedAt,
        title,
        content,
      );
      if (this.selectedProject()?.id !== project.id) return;
      this.updateProjectResources(project.id, (resources) => ({
        ...resources,
        documents: resources.documents.map((document) =>
          document.id === updated.id ? { ...document, ...updated } : document,
        ),
      }));
      this.writeLocal(this.projectDocumentDraftKey(connection, documentId), null);
      this.closeProjectDocumentEditor();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.projectDocumentEditConflict.set(message.includes('changed in Linear'));
      this.error.set(message);
    } finally {
      this.savingProjectDocument.set(false);
    }
  }

  closeProjectDocumentEditor(): void {
    this.editingProjectDocumentId.set(null);
    this.editProjectDocumentTitle.set('');
    this.editProjectDocumentContent.set('');
    this.editProjectDocumentUpdatedAt.set('');
    this.projectDocumentEditConflict.set(false);
    this.projectDocumentEditOffline.set(false);
  }

  async createProjectDocument(event: Event): Promise<void> {
    event.preventDefault();
    const connection = this.selected();
    const project = this.selectedProject();
    const title = this.newProjectDocumentTitle().trim();
    const content = this.newProjectDocumentContent().trim();
    if (!connection || !project || !title || !content || this.creatingProjectDocument()) return;
    this.creatingProjectDocument.set(true);
    this.error.set(null);
    try {
      const document = await this.tauri.linearCreateProjectDocument(
        connection.organizationId,
        project.id,
        title,
        content,
      );
      this.writeLocal(this.projectDocumentCreateDraftKey(connection, project.id), null);
      if (
        this.selected()?.organizationId !== connection.organizationId ||
        this.selected()?.viewerId !== connection.viewerId ||
        this.selectedProject()?.id !== project.id
      ) {
        return;
      }
      this.updateProjectResources(project.id, (resources) => ({
        ...resources,
        documents: [document, ...resources.documents],
      }));
      this.newProjectDocumentTitle.set('');
      this.newProjectDocumentContent.set('');
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.creatingProjectDocument.set(false);
    }
  }

  async createProjectLink(event: Event): Promise<void> {
    event.preventDefault();
    const connection = this.selected();
    const project = this.selectedProject();
    const label = this.newProjectLinkLabel().trim();
    const url = this.newProjectLinkUrl().trim();
    if (!connection || !project || !label || !url || this.creatingProjectLink()) return;
    this.creatingProjectLink.set(true);
    this.error.set(null);
    try {
      const link = await this.tauri.linearCreateProjectExternalLink(
        connection.organizationId,
        project.id,
        label,
        url,
      );
      this.writeLocal(this.projectLinkDraftKey(connection, project.id), null);
      if (
        this.selected()?.organizationId !== connection.organizationId ||
        this.selected()?.viewerId !== connection.viewerId ||
        this.selectedProject()?.id !== project.id
      ) {
        return;
      }
      this.updateProjectResources(project.id, (resources) => ({
        ...resources,
        externalLinks: [link, ...resources.externalLinks],
      }));
      this.newProjectLinkLabel.set('');
      this.newProjectLinkUrl.set('');
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.creatingProjectLink.set(false);
    }
  }

  async loadGithubRepositoriesForLink(): Promise<void> {
    const project = this.selectedProject();
    if (!project || this.loadingGithubRepositories()) return;
    this.loadingGithubRepositories.set(true);
    this.error.set(null);
    try {
      const repositories = await this.tauri.githubRepositories();
      if (this.selectedProject()?.id === project.id) {
        this.githubRepositoriesForLink.set(repositories);
      }
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.loadingGithubRepositories.set(false);
    }
  }

  async linkGithubRepository(event: Event): Promise<void> {
    event.preventDefault();
    const connection = this.selected();
    const project = this.selectedProject();
    const repository = this.availableGithubRepositories().find(
      (candidate) => candidate.fullName === this.selectedGithubRepository(),
    );
    if (!connection || !project || !repository || this.creatingGithubProjectLink()) return;
    this.creatingGithubProjectLink.set(true);
    this.error.set(null);
    try {
      const link = await this.tauri.linearCreateProjectExternalLink(
        connection.organizationId,
        project.id,
        `GitHub: ${repository.fullName}`,
        repository.htmlUrl,
      );
      if (this.selectedProject()?.id !== project.id) return;
      this.updateProjectResources(project.id, (resources) => ({
        ...resources,
        externalLinks: [link, ...resources.externalLinks],
      }));
      this.selectedGithubRepository.set('');
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.creatingGithubProjectLink.set(false);
    }
  }

  async deleteProjectLink(link: LinearExternalLink): Promise<void> {
    const connection = this.selected();
    const project = this.selectedProject();
    if (!connection || !project || this.deletingProjectLinkId()) return;
    this.deletingProjectLinkId.set(link.id);
    this.error.set(null);
    try {
      await this.tauri.linearDeleteProjectExternalLink(connection.organizationId, link.id);
      if (this.selectedProject()?.id !== project.id) return;
      this.updateProjectResources(project.id, (resources) => ({
        ...resources,
        externalLinks: resources.externalLinks.filter((item) => item.id !== link.id),
      }));
      this.confirmDeleteProjectLinkId.set(null);
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.deletingProjectLinkId.set(null);
    }
  }

  async openResource(url: string): Promise<void> {
    try {
      const parsed = new URL(url);
      if (!['https:', 'http:'].includes(parsed.protocol) || !parsed.hostname) {
        throw new Error('Linear returned an invalid project resource URL.');
      }
      await this.tauri.openUrl(parsed.toString());
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
    }
  }

  private async loadProjectUpdates(projectId: string): Promise<void> {
    const connection = this.selected();
    if (!connection) return;
    const requestId = ++this.projectUpdatesRequest;
    const includeArchived = this.includeArchivedProjectUpdates();
    const cacheKey = this.projectUpdatesCacheKey(connection, projectId, includeArchived);
    const cached = this.readLocal<readonly LinearProjectUpdate[]>(cacheKey);
    const hasCache = Array.isArray(cached);
    if (hasCache && this.selectedProject()?.id === projectId) this.projectUpdates.set(cached);
    try {
      const updates = await this.tauri.linearProjectUpdates(
        connection.organizationId,
        projectId,
        includeArchived,
      );
      if (
        requestId !== this.projectUpdatesRequest ||
        this.selected()?.organizationId !== connection.organizationId ||
        this.selectedProject()?.id !== projectId
      ) {
        return;
      }
      this.projectUpdates.set(updates);
      this.writeLocal(cacheKey, updates);
    } catch (error) {
      if (requestId !== this.projectUpdatesRequest) return;
      this.error.set(
        hasCache
          ? 'Linear is unavailable. Showing saved project updates.'
          : error instanceof Error
            ? error.message
            : String(error),
      );
    }
  }

  private saveProjectUpdatesCache(projectId: string, includeArchived: boolean): void {
    const connection = this.selected();
    if (connection) {
      this.writeLocal(
        this.projectUpdatesCacheKey(connection, projectId, includeArchived),
        this.projectUpdates(),
      );
    }
  }

  private projectUpdatesCacheKey(
    connection: LinearConnection,
    projectId: string,
    includeArchived: boolean,
  ): string {
    const archived = includeArchived ? '.all' : '';
    return `relay.linear.projectUpdates.${connection.organizationId}.${connection.viewerId}.${projectId}${archived}`;
  }

  async createIssue(event: Event): Promise<void> {
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
        this.newAssigneeId() || undefined,
        this.newPriority() === '' ? undefined : Number(this.newPriority()),
        this.newDueDate() || undefined,
        this.newLabelIds(),
        this.newStateId() || undefined,
        this.newCycleId() || undefined,
      );
      this.newTitle.set('');
      this.newDescription.set('');
      this.newEstimate.set('');
      this.newAssigneeId.set('');
      this.newPriority.set('');
      this.newDueDate.set('');
      this.newLabelIds.set([]);
      this.newStateId.set('');
      this.newCycleId.set('');
      this.writeLocal(this.issueDraftKey(connection.organizationId), null);
      if (
        (!this.issueTeamId() || this.issueTeamId() === created.team.id) &&
        this.matchesIssueQuery(created)
      ) {
        this.issues.update((issues) => [created, ...issues]);
        this.saveIssueCache(connection);
      }
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.creating.set(false);
    }
  }

  async createProjectIssue(event: Event): Promise<void> {
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
        this.newProjectIssueAssigneeId() || undefined,
        this.newProjectIssuePriority() === '' ? undefined : Number(this.newProjectIssuePriority()),
        this.newProjectIssueDueDate() || undefined,
        this.newProjectIssueLabelIds(),
        this.newProjectIssueStateId() || undefined,
        this.newProjectIssueCycleId() || undefined,
      );
      if (this.selectedProject()?.id === project.id) {
        if (this.matchesProjectIssueQuery(issue)) {
          this.projectIssues.update((issues) => [issue, ...issues]);
        }
        this.saveProjectIssueCache(connection, project.id);
      }
      this.newProjectIssueTitle.set('');
      this.newProjectIssueDescription.set('');
      this.newProjectIssueMilestoneId.set('');
      this.newProjectIssueEstimate.set('');
      this.newProjectIssueAssigneeId.set('');
      this.newProjectIssuePriority.set('');
      this.newProjectIssueDueDate.set('');
      this.newProjectIssueLabelIds.set([]);
      this.newProjectIssueStateId.set('');
      this.newProjectIssueCycleId.set('');
      this.writeLocal(this.projectIssueDraftKey(connection.organizationId, project.id), null);
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.creatingProjectIssue.set(false);
    }
  }

  async disconnectSelected(): Promise<void> {
    const connection = this.selected();
    if (
      !connection ||
      this.confirmDisconnectOrganizationId() !== connection.organizationId ||
      this.disconnectingOrganizationId()
    ) {
      return;
    }
    this.disconnectingOrganizationId.set(connection.organizationId);
    try {
      const warning = await this.tauri.linearDisconnect(connection.organizationId);
      this.clearOrganizationCache(connection.organizationId);
      const connections = this.connections().filter(
        (entry) => entry.organizationId !== connection.organizationId,
      );
      this.connections.set(connections);
      this.confirmDisconnectOrganizationId.set(null);
      const next = connections.find((entry) => !entry.pausedOnDevice) ?? null;
      this.selected.set(next);
      this.issues.set([]);
      if (next) this.select(next);
      this.error.set(warning);
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
      await this.refreshConnections();
    } finally {
      this.disconnectingOrganizationId.set(null);
    }
  }

  async updateStatus(issue: LinearIssue, stateId: string): Promise<void> {
    if (!stateId || stateId === issue.state?.id) return;
    await this.saveIssueUpdate(issue, { stateId });
  }

  async updatePriority(issue: LinearIssue, priority: number): Promise<void> {
    if (priority === issue.priority) return;
    await this.saveIssueUpdate(issue, { priority });
  }

  async updateDueDate(issue: LinearIssue, dueDate: string): Promise<void> {
    if (dueDate === (issue.dueDate ?? '')) return;
    await this.saveIssueUpdate(issue, dueDate ? { dueDate } : { clearDueDate: true });
  }

  async updateEstimate(issue: LinearIssue, estimate: string): Promise<void> {
    if (estimate === '') {
      if (issue.estimate == null) return;
      await this.saveIssueUpdate(issue, { clearEstimate: true });
      return;
    }
    const value = Number(estimate);
    if (!Number.isInteger(value) || value === issue.estimate) return;
    await this.saveIssueUpdate(issue, { estimate: value });
  }

  async updateAssignee(issue: LinearIssue, assigneeId: string): Promise<void> {
    if (assigneeId === (issue.assignee?.id ?? '')) return;
    await this.saveIssueUpdate(issue, assigneeId ? { assigneeId } : { clearAssignee: true });
  }

  async updateCycle(issue: LinearIssue, cycleId: string): Promise<void> {
    if (cycleId === (issue.cycle?.id ?? '')) return;
    await this.saveIssueUpdate(issue, cycleId ? { cycleId } : { clearCycle: true });
  }

  async updateProject(issue: LinearIssue, projectId: string): Promise<void> {
    const saved = await this.saveIssueUpdate(
      issue,
      projectId ? { projectId, clearProjectMilestone: true } : { clearProject: true },
    );
    if (!saved) return;
    if (projectId) await this.loadMilestones(projectId);
    else this.milestones.set([]);
  }

  async updateIssueMilestone(issue: LinearIssue, projectMilestoneId: string): Promise<void> {
    if (projectMilestoneId === (issue.projectMilestone?.id ?? '')) return;
    await this.saveIssueUpdate(
      issue,
      projectMilestoneId ? { projectMilestoneId } : { clearProjectMilestone: true },
    );
  }

  labelsFor(teamId: string): readonly LinearLabel[] {
    return this.labels().filter((label) => !label.team?.id || label.team.id === teamId);
  }

  issueFilterLabels(): readonly LinearLabel[] {
    return this.issueTeamId() ? this.labelsFor(this.issueTeamId()) : this.labels();
  }

  editLabel(label: LinearLabel): void {
    this.error.set(null);
    this.editingLabelId.set(label.id);
    const current = this.labelEditValues(label);
    const connection = this.selected();
    const draft = connection ? this.readLabelEditDraft(connection, label.id) : null;
    this.applyLabelEditValues(draft?.values ?? current);
    this.labelEditBase.set(draft?.base ?? current);
    this.labelEditDraftConflict.set(draft ? linearLabelEditDraftConflicts(draft, current) : false);
    this.hasLabelEditDraft.set(!!draft);
  }

  updateLabelEditDraft(
    label: LinearLabel,
    field: keyof LinearLabelEditValues,
    value: string,
  ): void {
    if (field === 'name') this.editLabelName.set(value);
    else this.editLabelColor.set(value);
    const connection = this.selected();
    if (connection) this.saveLabelEditDraft(connection, label);
  }

  resolveLabelEditDraftConflict(label: LinearLabel, keepDraft: boolean): void {
    const connection = this.selected();
    if (!connection) return;
    const current = this.labelEditValues(label);
    if (keepDraft) {
      const draft = this.readLabelEditDraft(connection, label.id);
      if (draft) {
        this.labelEditBase.set(current);
        this.writeLocal(this.labelEditDraftKey(connection, label.id), {
          values: this.currentLabelEditValues(),
          base: current,
        } satisfies LinearLabelEditDraft);
      }
    } else {
      this.applyLabelEditValues(current);
      this.labelEditBase.set(current);
      this.writeLocal(this.labelEditDraftKey(connection, label.id), null);
      this.hasLabelEditDraft.set(false);
    }
    this.labelEditDraftConflict.set(false);
  }

  async createLabel(event: Event): Promise<void> {
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
      this.writeLocal(this.issueLabelDraftKey(connection), null);
      if (
        this.selected()?.organizationId === connection.organizationId &&
        this.selected()?.viewerId === connection.viewerId
      ) {
        this.labels.update((items) => [...items, label]);
        this.newLabelName.set('');
        this.newLabelTeamId.set('');
        this.newLabelColor.set('#6b7280');
      }
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.creatingLabel.set(false);
    }
  }

  async saveLabel(event: Event, label: LinearLabel): Promise<void> {
    event.preventDefault();
    const connection = this.selected();
    const name = this.editLabelName().trim();
    if (
      !connection ||
      this.editingLabelId() !== label.id ||
      !name ||
      this.savingLabel() ||
      this.labelEditDraftConflict()
    ) {
      return;
    }
    this.savingLabel.set(true);
    this.error.set(null);
    try {
      const latest = await this.tauri.linearIssueLabels(connection.organizationId);
      if (
        this.selected()?.organizationId !== connection.organizationId ||
        this.selected()?.viewerId !== connection.viewerId
      ) {
        return;
      }
      const currentLabel = latest.find((item) => item.id === label.id);
      if (!currentLabel) throw new Error('Linear no longer has this label. Refresh and retry.');
      const current = this.labelEditValues(currentLabel);
      const key = this.labelEditDraftKey(connection, label.id);
      const draft = this.readLabelEditDraft(connection, label.id) ?? {
        values: this.currentLabelEditValues(),
        base: this.labelEditBase() ?? this.labelEditValues(label),
      };
      if (linearLabelEditDraftConflicts(draft, current)) {
        this.labels.set(latest);
        this.labelEditDraftConflict.set(true);
        return;
      }
      if (linearLabelEditValuesEqual(draft.values, current)) {
        this.applyLabelEditValues(current);
        this.writeLocal(key, null);
        this.hasLabelEditDraft.set(false);
        this.labelEditBase.set(current);
        this.labels.set(latest);
        this.editingLabelId.set(null);
        return;
      }
      const updated = await this.tauri.linearUpdateIssueLabel(
        connection.organizationId,
        currentLabel.id,
        draft.values.name.trim(),
        draft.values.color,
      );
      if (
        this.selected()?.organizationId !== connection.organizationId ||
        this.selected()?.viewerId !== connection.viewerId
      ) {
        return;
      }
      this.labels.set(latest.map((item) => (item.id === updated.id ? updated : item)));
      for (const issue of [...this.issues(), ...this.projectIssues()]) {
        if (issue.labels.some((item) => item.id === updated.id)) {
          this.applyUpdatedIssue(connection.organizationId, {
            ...issue,
            labels: issue.labels.map((item) => (item.id === updated.id ? updated : item)),
          });
        }
      }
      this.writeLocal(key, null);
      this.hasLabelEditDraft.set(false);
      this.labelEditDraftConflict.set(false);
      this.labelEditBase.set(null);
      this.editingLabelId.set(null);
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.savingLabel.set(false);
    }
  }

  private labelEditValues(label: LinearLabel): LinearLabelEditValues {
    return { name: label.name, color: label.color ?? '#6b7280' };
  }

  private currentLabelEditValues(): LinearLabelEditValues {
    return { name: this.editLabelName(), color: this.editLabelColor() };
  }

  private applyLabelEditValues(values: LinearLabelEditValues): void {
    this.editLabelName.set(values.name);
    this.editLabelColor.set(values.color);
  }

  private saveLabelEditDraft(connection: LinearConnection, label: LinearLabel): void {
    const values = this.currentLabelEditValues();
    const original = this.readLabelEditDraft(connection, label.id);
    const draft: LinearLabelEditDraft = {
      values,
      base: original?.base ?? this.labelEditBase() ?? this.labelEditValues(label),
    };
    const hasDraft = !linearLabelEditValuesEqual(draft.values, draft.base);
    this.writeLocal(this.labelEditDraftKey(connection, label.id), hasDraft ? draft : null);
    this.hasLabelEditDraft.set(hasDraft);
  }

  private readLabelEditDraft(
    connection: LinearConnection,
    labelId: string,
  ): LinearLabelEditDraft | null {
    const value = this.readLocal<unknown>(this.labelEditDraftKey(connection, labelId));
    return isLinearLabelEditDraft(value) ? value : null;
  }

  async deleteLabel(label: LinearLabel): Promise<void> {
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

  async updateLabels(issue: LinearIssue, event: Event): Promise<void> {
    const select = event.target as HTMLSelectElement;
    await this.saveIssueUpdate(issue, {
      labelIds: Array.from(select.selectedOptions, (option) => option.value),
    });
  }

  private async saveIssueUpdate(issue: LinearIssue, update: LinearIssueUpdate): Promise<boolean> {
    const connection = this.selected();
    if (!connection) return false;
    const combined = this.queueIssueUpdate(connection.organizationId, issue, update);
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
      this.queueIssueUpdate(connection.organizationId, issue, update);
      this.error.set(error instanceof Error ? error.message : String(error));
      return false;
    }
  }

  async retryPendingIssueUpdates(): Promise<void> {
    const connection = this.selected();
    if (!connection || this.retryingIssueUpdates()) return;
    this.retryingIssueUpdates.set(true);
    this.error.set(null);
    try {
      for (const pending of [...this.pendingIssueUpdates()]) {
        try {
          await this.retryPendingIssueUpdate(connection.organizationId, pending);
        } catch (error) {
          this.error.set(error instanceof Error ? error.message : String(error));
        }
      }
    } finally {
      this.retryingIssueUpdates.set(false);
    }
  }

  issueIdentifier(issueId: string): string {
    return (
      [...this.issues(), ...this.projectIssues()].find((issue) => issue.id === issueId)
        ?.identifier ?? issueId
    );
  }

  conflictValue(field: string, value: unknown): string {
    if (value == null || value === '') return 'None';
    const id = typeof value === 'string' || typeof value === 'number' ? `${value}` : '';
    switch (field) {
      case 'projectId':
        return this.projects().find((project) => project.id === id)?.name ?? id;
      case 'projectMilestoneId':
        return this.milestones().find((milestone) => milestone.id === id)?.name ?? id;
      case 'stateId':
        return (
          Object.values(this.workflowStates())
            .flat()
            .find((state) => state.id === id)?.name ?? id
        );
      case 'assigneeId':
        return this.users().find((user) => user.id === id)?.name ?? id;
      case 'cycleId':
        return (
          Object.values(this.cycles())
            .flat()
            .find((cycle) => cycle.id === id)?.name ?? id
        );
      case 'labelIds':
        return Array.isArray(value)
          ? value
              .filter((labelId): labelId is string => typeof labelId === 'string')
              .map(
                (labelId) => this.labels().find((label) => label.id === labelId)?.name ?? labelId,
              )
              .join(', ') || 'None'
          : id || 'Unknown value';
      case 'priority':
        return ['No priority', 'Urgent', 'High', 'Normal', 'Low'][Number(value)] ?? id;
      default:
        return Array.isArray(value)
          ? value.filter((item): item is string => typeof item === 'string').join(', ')
          : id || 'Unknown value';
    }
  }

  async resolveIssueUpdate(pending: PendingLinearIssueUpdate, applyLocal: boolean): Promise<void> {
    const connection = this.selected();
    if (!connection) return;
    if (!applyLocal) {
      this.removePendingIssueUpdate(connection.organizationId, pending.issueId);
      return;
    }
    this.retryingIssueUpdates.set(true);
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
    } finally {
      this.retryingIssueUpdates.set(false);
    }
  }

  private async retryPendingIssueUpdate(
    organizationId: string,
    pending: PendingLinearIssueUpdate,
  ): Promise<void> {
    const detail = await this.tauri.linearIssueDetail(organizationId, pending.issueId);
    const base = pending.base ?? linearIssueValues(detail.issue);
    if (!pending.base) {
      const migrated = this.readPendingIssueUpdates(organizationId).map((item) =>
        item.issueId === pending.issueId ? { ...item, base } : item,
      );
      this.storePendingIssueUpdates(organizationId, migrated);
    }
    const conflicts = linearIssueConflicts(detail.issue, pending.update, base);
    if (conflicts.length) {
      this.storePendingIssueUpdates(
        organizationId,
        this.readPendingIssueUpdates(organizationId).map((item) =>
          item.issueId === pending.issueId ? { ...item, base, conflicts } : item,
        ),
      );
      return;
    }
    const updated = await this.tauri.linearUpdateIssue(
      organizationId,
      pending.issueId,
      pending.update,
    );
    this.removePendingIssueUpdate(organizationId, pending.issueId);
    this.applyUpdatedIssue(organizationId, updated);
  }

  async loadIssues(): Promise<void> {
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

  async loadMore(): Promise<void> {
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
      ? this.tauri.linearTeamIssues(
          organizationId,
          teamId,
          after,
          this.includeArchivedIssues(),
          this.issueSearchTerm(),
          this.issueStateId() || undefined,
          this.issuePriority() === '' ? undefined : Number(this.issuePriority()),
          this.issueAssigneeId() || undefined,
          this.issueLabelId() || undefined,
          this.issueCycleId() || undefined,
        )
      : this.tauri.linearMyIssues(
          organizationId,
          after,
          this.includeArchivedIssues(),
          this.issueSearchTerm(),
          this.issueStateId() || undefined,
          this.issuePriority() === '' ? undefined : Number(this.issuePriority()),
          this.issueLabelId() || undefined,
        );
  }

  async openIssue(url: string): Promise<void> {
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

  private async refreshConnections(
    selectOrganizationId?: string,
    projectRequestId?: number,
  ): Promise<void> {
    try {
      const connections = await this.tauri.linearStatus();
      if (projectRequestId !== undefined && projectRequestId !== this.projectOpenRequest) return;
      this.connections.set(connections);
      const available = connections.filter((connection) => !connection.pausedOnDevice);
      const selected =
        available.find((connection) => connection.organizationId === selectOrganizationId) ??
        available.find(
          (connection) => connection.organizationId === this.selected()?.organizationId,
        ) ??
        available[0] ??
        null;
      this.selected.set(selected);
      if (selected) {
        this.select(selected);
      }
    } catch (error) {
      if (projectRequestId === undefined || projectRequestId === this.projectOpenRequest) {
        this.error.set(error instanceof Error ? error.message : String(error));
      }
    }
  }

  private async loadTeams(connection: LinearConnection): Promise<void> {
    try {
      const teams = await this.loadCachedTeams(connection);
      const [users, labels, statuses] = await Promise.all([
        this.tauri.linearUsers(connection.organizationId),
        this.tauri.linearIssueLabels(connection.organizationId),
        this.tauri.linearProjectStatuses(connection.organizationId),
      ]);
      if (this.selected()?.organizationId !== connection.organizationId) return;
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
      if (this.selected()?.organizationId !== connection.organizationId) return;
      this.workflowStates.set(Object.fromEntries(entries));
      await this.loadTeamCycles(connection, teamId);
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
    }
  }

  private async loadCachedTeams(connection: LinearConnection): Promise<readonly LinearTeam[]> {
    const cacheKey = this.teamCacheKey(connection);
    const cached = this.readLocal<unknown>(cacheKey);
    const hasCache = isLinearTeamList(cached);
    if (hasCache && this.selected()?.organizationId === connection.organizationId) {
      this.teams.set(cached);
    }
    try {
      const teams = await this.tauri.linearTeams(connection.organizationId);
      if (this.selected()?.organizationId === connection.organizationId) {
        this.teams.set(teams);
        this.writeLocal(cacheKey, teams);
      }
      return teams;
    } catch (error) {
      if (hasCache) {
        this.error.set('Linear is unavailable. Showing saved teams.');
        return cached;
      }
      throw error;
    }
  }

  private teamCacheKey(connection: LinearConnection): string {
    return `relay.linear.teams.${connection.organizationId}.${connection.viewerId}`;
  }

  private cycleCacheKey(connection: LinearConnection, teamId: string): string {
    return `relay.linear.cycles.${connection.organizationId}.${connection.viewerId}.${teamId}`;
  }

  private cycleDraftKey(connection: LinearConnection, teamId: string): string {
    return `relay.linear.cycleDraft.${connection.organizationId}.${connection.viewerId}.${teamId}`;
  }

  private cycleEditDraftKey(connection: LinearConnection, cycleId: string): string {
    return `relay.linear.cycleEditDraft.${connection.organizationId}.${connection.viewerId}.${cycleId}`;
  }

  private initiativeCacheKey(
    connection: LinearConnection,
    includeArchived: boolean,
    includeArchivedUpdates: boolean,
  ): string {
    const archived = includeArchived ? '.all' : '';
    const updates = includeArchivedUpdates ? '.updates.all' : '';
    return `relay.linear.initiatives.${connection.organizationId}.${connection.viewerId}${archived}${updates}`;
  }

  private initiativeDraftKey(connection: LinearConnection): string {
    return `relay.linear.initiativeDraft.${connection.organizationId}.${connection.viewerId}`;
  }

  private initiativeEditDraftKey(connection: LinearConnection, initiativeId: string): string {
    return `relay.linear.initiativeEditDraft.${connection.organizationId}.${connection.viewerId}.${initiativeId}`;
  }

  private initiativeUpdateDraftKey(connection: LinearConnection, initiativeId: string): string {
    return `relay.linear.initiativeUpdateDraft.${connection.organizationId}.${connection.viewerId}.${initiativeId}`;
  }
}

export default function Linear(props: {
  projectRequest?: { organizationId: string; projectId: string } | null;
  onProjectRequestHandled?: (value: { organizationId: string; projectId: string }) => void;
}) {
  useSignals();
  const s = useController(() => {
    const state = new LinearState();
    if (props.projectRequest !== undefined) state.projectRequest.set(props.projectRequest);
    return state;
  });
  useLayoutEffect(() => {
    if (props.projectRequest !== undefined) s.projectRequest.set(props.projectRequest);
  }, [s, props.projectRequest]);
  if (props.onProjectRequestHandled) s.onProjectRequestHandled = props.onProjectRequestHandled;
  return (
    <div className="linear">
      <section className="wrap">
        <header>
          <div>
            <p className="u-title">{s.pageTitle()}</p>
            <p className="hint">{s.pageDescription()}</p>
          </div>
          {s.connections().length ? (
            <>
              <div className="header-actions">
                {s.selected() && s.pendingIssueUpdates().length ? (
                  <>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={s.retryingIssueUpdates()}
                      onClick={() => {
                        void s.retryPendingIssueUpdates();
                      }}
                    >
                      {s.retryingIssueUpdates() ? 'Retrying changes' : 'Retry issue changes'}
                    </Button>
                  </>
                ) : null}
                {s.selected() &&
                (!s.selected()?.nexusCredentialId || s.selected()?.nexusSyncPending) ? (
                  <>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        void s.syncSelected();
                      }}
                      disabled={s.syncing() || !s.nexus.status().connected}
                    >
                      {s.syncing()
                        ? 'Syncing'
                        : s.selected()?.nexusSyncPending
                          ? 'Retry Nexus sync'
                          : 'Sync through Nexus'}
                    </Button>
                  </>
                ) : null}
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    void (s.pending() ? s.cancelConnect() : s.connect());
                  }}
                  disabled={!s.pending() && (!s.oauthConfigured() || !s.nexus.status().connected)}
                >
                  {s.pending() ? 'Cancel sign-in' : 'Connect workspace'}
                </Button>
              </div>
            </>
          ) : null}
        </header>

        {s.conflictedIssueUpdates().map((pending) => {
          return (
            <Fragment key={pending.issueId}>
              <section className="issue-conflicts" aria-label="Offline issue update conflicts">
                <p className="label">{s.issueIdentifier(pending.issueId)} changed in Linear</p>
                <p className="hint">
                  Review the remote edits before applying your offline changes.
                </p>
                {(pending.conflicts ?? []).map((conflict) => {
                  return (
                    <Fragment key={conflict.field}>
                      <p className="hint">
                        <strong>{conflict.label}:</strong>
                        Linear now has “{s.conflictValue(conflict.field, conflict.current)}”;
                        Relay’s offline change was “
                        {s.conflictValue(conflict.field, conflict.desired)}”.
                      </p>
                    </Fragment>
                  );
                })}
                <div className="header-actions">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={s.retryingIssueUpdates()}
                    onClick={() => {
                      void s.resolveIssueUpdate(pending, false);
                    }}
                  >
                    Keep Linear’s version
                  </Button>
                  <Button
                    size="sm"
                    disabled={s.retryingIssueUpdates()}
                    onClick={() => {
                      void s.resolveIssueUpdate(pending, true);
                    }}
                  >
                    Apply my changes
                  </Button>
                </div>
              </section>
            </Fragment>
          );
        })}

        {s.error() ? (
          <>
            <p className="error" role="alert">
              {s.error()}
            </p>
          </>
        ) : null}
        {!s.oauthConfigured() ? (
          <>
            <p className="hint">
              Linear is ready to connect once Relay’s Linear OAuth app is registered and its client
              ID is added to the release configuration.
            </p>
          </>
        ) : null}
        {!s.nexus.status().connected ? (
          <>
            <p className="hint">
              Connect Relay to Nexus first to keep Linear connections available across devices.
            </p>
          </>
        ) : null}
        {!s.connections().length ? (
          <>
            <div className="empty">
              <p className="label">No Linear workspaces connected</p>
              <p className="hint">Nexus sign-in is required before Linear can be connected.</p>
              <Button
                size="sm"
                disabled={!s.pending() && (!s.nexus.status().connected || !s.oauthConfigured())}
                onClick={() => {
                  void (s.pending() ? s.cancelConnect() : s.connect());
                }}
              >
                {s.pending()
                  ? 'Cancel sign-in'
                  : s.oauthConfigured()
                    ? 'Connect Linear'
                    : 'OAuth setup pending'}
              </Button>
            </div>
          </>
        ) : (
          <>
            <nav className="workspaces" aria-label="Linear workspaces">
              {s.connections().map((connection) => {
                return (
                  <Fragment key={connection.organizationId}>
                    {!connection.pausedOnDevice ? (
                      <>
                        <button
                          className={cn(
                            'workspace',
                            s.selected()?.organizationId === connection.organizationId && 'active',
                          )}
                          type="button"
                          onClick={() => {
                            void s.select(connection);
                          }}
                        >
                          <span>{connection.organizationName}</span>
                          <span className="muted">{connection.viewerName}</span>
                          <span className="sync-state">
                            {connection.nexusSyncPending
                              ? 'Needs Nexus sync'
                              : connection.nexusCredentialId
                                ? 'Synced through Nexus'
                                : 'This device only'}
                          </span>
                        </button>
                      </>
                    ) : null}
                  </Fragment>
                );
              })}
            </nav>
            {s.selected() ? (
              <>
                <nav className="sections" aria-label="Linear views">
                  <button
                    className={cn(s.section() === 'work' && 'active')}
                    type="button"
                    onClick={() => {
                      void s.setSection('work');
                    }}
                  >
                    My work
                  </button>
                  <button
                    className={cn(s.section() === 'projects' && 'active')}
                    type="button"
                    onClick={() => {
                      void s.setSection('projects');
                    }}
                  >
                    Projects
                  </button>
                  <button
                    className={cn(s.section() === 'cycles' && 'active')}
                    type="button"
                    onClick={() => {
                      void s.setSection('cycles');
                    }}
                  >
                    Cycles
                  </button>
                  <button
                    className={cn(s.section() === 'roadmap' && 'active')}
                    type="button"
                    onClick={() => {
                      void s.setSection('roadmap');
                    }}
                  >
                    Roadmap
                  </button>
                  <button
                    className={cn(s.section() === 'labels' && 'active')}
                    type="button"
                    onClick={() => {
                      void s.setSection('labels');
                    }}
                  >
                    Labels
                  </button>
                </nav>
                {when(s.issueDetail(), (detail) => (
                  <>
                    <section className="issue-detail" aria-label="Linear issue details">
                      <div className="issue-heading">
                        <div>
                          <p className="muted">
                            {detail.issue.identifier} · {detail.issue.team.name}
                          </p>
                          {s.editingIssueDetailsId() === detail.issue.id ? (
                            <>
                              <form
                                className="project-edit"
                                onSubmit={($event) => {
                                  void s.saveIssueDetails($event.nativeEvent, detail.issue);
                                }}
                              >
                                <label>
                                  <span>Issue title</span>
                                  <input
                                    required
                                    maxLength={255}
                                    disabled={s.savingIssueDetails()}
                                    value={s.editIssueTitle()}
                                    onChange={($event) => {
                                      void s.updateIssueDetailsDraft(
                                        detail.issue,
                                        'title',
                                        $event.currentTarget.value,
                                      );
                                    }}
                                  />
                                </label>
                                <label>
                                  <span>Description</span>
                                  <textarea
                                    rows={4}
                                    disabled={s.savingIssueDetails()}
                                    value={s.editIssueDescription()}
                                    onChange={($event) => {
                                      void s.updateIssueDetailsDraft(
                                        detail.issue,
                                        'description',
                                        $event.currentTarget.value,
                                      );
                                    }}
                                  />
                                </label>
                                {s.issueDetailsDraftConflict() ? (
                                  <>
                                    <div className="issue-conflicts" role="alert">
                                      <span>
                                        This draft overlaps newer issue details in Linear.
                                      </span>
                                      <Button
                                        size="sm"
                                        variant="outline"
                                        type="button"
                                        onClick={() => {
                                          void s.resolveIssueDetailsDraftConflict(
                                            detail.issue,
                                            true,
                                          );
                                        }}
                                      >
                                        Keep draft
                                      </Button>
                                      <Button
                                        size="sm"
                                        variant="outline"
                                        type="button"
                                        onClick={() => {
                                          void s.resolveIssueDetailsDraftConflict(
                                            detail.issue,
                                            false,
                                          );
                                        }}
                                      >
                                        Use Linear's version
                                      </Button>
                                    </div>
                                  </>
                                ) : s.hasIssueDetailsDraft() ? (
                                  <>
                                    <p className="hint">Issue detail draft saved on this device.</p>
                                  </>
                                ) : null}
                                <div className="issue-actions">
                                  <Button
                                    size="sm"
                                    disabled={
                                      s.savingIssueDetails() || s.issueDetailsDraftConflict()
                                    }
                                  >
                                    {s.savingIssueDetails() ? 'Saving' : 'Save details'}
                                  </Button>
                                  <Button
                                    size="sm"
                                    variant="link"
                                    type="button"
                                    onClick={() => {
                                      void s.editingIssueDetailsId.set(null);
                                    }}
                                  >
                                    Cancel
                                  </Button>
                                </div>
                              </form>
                            </>
                          ) : (
                            <>
                              <h2>{detail.issue.title}</h2>
                              {detail.issue.description ? (
                                <>
                                  <p className="issue-description">{detail.issue.description}</p>
                                </>
                              ) : null}
                            </>
                          )}
                        </div>
                        <div className="issue-actions">
                          {detail.issue.archivedAt ? (
                            <>
                              <span className="hint">Archived</span>
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={!!s.archivingIssueId()}
                                onClick={() => {
                                  void s.setIssueArchived(detail.issue, false);
                                }}
                              >
                                {s.archivingIssueId() === detail.issue.id
                                  ? 'Restoring'
                                  : 'Restore issue'}
                              </Button>
                            </>
                          ) : s.confirmArchiveIssueDetailId() === detail.issue.id ? (
                            <>
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={!!s.archivingIssueId()}
                                onClick={() => {
                                  void s.setIssueArchived(detail.issue, true, true);
                                }}
                              >
                                {s.archivingIssueId() === detail.issue.id
                                  ? 'Archiving'
                                  : 'Confirm archive'}
                              </Button>
                              <Button
                                size="sm"
                                variant="link"
                                onClick={() => {
                                  void s.confirmArchiveIssueDetailId.set(null);
                                }}
                              >
                                Cancel
                              </Button>
                            </>
                          ) : (
                            <>
                              <Button
                                size="sm"
                                variant="link"
                                onClick={() => {
                                  void s.confirmArchiveIssueDetailId.set(detail.issue.id);
                                }}
                              >
                                Archive issue
                              </Button>
                            </>
                          )}
                          {s.editingIssueDetailsId() !== detail.issue.id ? (
                            <>
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => {
                                  void s.editIssueDetails(detail.issue);
                                }}
                              >
                                Edit details
                              </Button>
                            </>
                          ) : null}
                          <Button
                            size="sm"
                            variant="link"
                            onClick={() => {
                              void s.closeIssueDetail();
                            }}
                          >
                            Close
                          </Button>
                        </div>
                      </div>
                      {s.issueDetailStale() ? (
                        <>
                          <p className="hint" role="status">
                            Linear is unavailable. Showing the saved issue.
                          </p>
                        </>
                      ) : null}
                      <div className="issue-fields">
                        <label>
                          <span>Status</span>
                          <select
                            value={detail.issue.state?.id ?? ''}
                            onChange={($event) => {
                              void s.updateStatus(detail.issue, $event.currentTarget.value);
                            }}
                          >
                            {s.statesFor(detail.issue).map((state) => {
                              return (
                                <Fragment key={state.id}>
                                  <option value={state.id}>{state.name}</option>
                                </Fragment>
                              );
                            })}
                          </select>
                        </label>
                        <label>
                          <span>Priority</span>
                          <select
                            value={detail.issue.priority}
                            onChange={($event) => {
                              void s.updatePriority(detail.issue, +$event.currentTarget.value);
                            }}
                          >
                            <option value={0}>No priority</option>
                            <option value={1}>Urgent</option>
                            <option value={2}>High</option>
                            <option value={3}>Normal</option>
                            <option value={4}>Low</option>
                          </select>
                        </label>
                        {s.estimateOptions(detail.issue.team.id).length ? (
                          <>
                            <label>
                              <span>Estimate</span>
                              <select
                                value={detail.issue.estimate ?? ''}
                                onChange={($event) => {
                                  void s.updateEstimate(detail.issue, $event.currentTarget.value);
                                }}
                              >
                                <option value="">No estimate</option>
                                {s.estimateOptions(detail.issue.team.id).map((option) => {
                                  return (
                                    <Fragment key={option.value}>
                                      <option value={option.value}>{option.label}</option>
                                    </Fragment>
                                  );
                                })}
                              </select>
                            </label>
                          </>
                        ) : null}
                        <label>
                          <span>Due date</span>
                          <input
                            type="date"
                            value={detail.issue.dueDate ?? ''}
                            onChange={($event) => {
                              void s.updateDueDate(detail.issue, $event.currentTarget.value);
                            }}
                          />
                        </label>
                        <label>
                          <span>Assignee</span>
                          <select
                            value={detail.issue.assignee?.id ?? ''}
                            onChange={($event) => {
                              void s.updateAssignee(detail.issue, $event.currentTarget.value);
                            }}
                          >
                            <option value="">Unassigned</option>
                            {s.users().map((user) => {
                              return (
                                <Fragment key={user.id}>
                                  <option value={user.id}>{user.name}</option>
                                </Fragment>
                              );
                            })}
                          </select>
                        </label>
                        <label>
                          <span>Cycle</span>
                          <select
                            value={detail.issue.cycle?.id ?? ''}
                            onChange={($event) => {
                              void s.updateCycle(detail.issue, $event.currentTarget.value);
                            }}
                          >
                            <option value="">No cycle</option>
                            {s.cyclesFor(detail.issue.team.id).map((cycle) => {
                              return (
                                <Fragment key={cycle.id}>
                                  <option value={cycle.id}>
                                    {cycle.name || 'Cycle ' + cycle.number}
                                  </option>
                                </Fragment>
                              );
                            })}
                          </select>
                        </label>
                        <label>
                          <span>Project</span>
                          <select
                            value={detail.issue.project?.id ?? ''}
                            onChange={($event) => {
                              void s.updateProject(detail.issue, $event.currentTarget.value);
                            }}
                          >
                            <option value="">No project</option>
                            {s.projects().map((project) => {
                              return (
                                <Fragment key={project.id}>
                                  <option value={project.id}>{project.name}</option>
                                </Fragment>
                              );
                            })}
                          </select>
                        </label>
                        {detail.issue.project ? (
                          <>
                            <label>
                              <span>Milestone</span>
                              <select
                                value={detail.issue.projectMilestone?.id ?? ''}
                                onChange={($event) => {
                                  void s.updateIssueMilestone(
                                    detail.issue,
                                    $event.currentTarget.value,
                                  );
                                }}
                              >
                                <option value="">No milestone</option>
                                {s.milestones().map((milestone) => {
                                  return (
                                    <Fragment key={milestone.id}>
                                      <option value={milestone.id}>{milestone.name}</option>
                                    </Fragment>
                                  );
                                })}
                              </select>
                            </label>
                          </>
                        ) : null}
                        <label>
                          <span>Labels</span>
                          <select
                            multiple
                            size={4}
                            onChange={($event) => {
                              void s.updateLabels(detail.issue, $event.nativeEvent);
                            }}
                          >
                            {s.labelsFor(detail.issue.team.id).map((label) => {
                              return (
                                <Fragment key={label.id}>
                                  <option
                                    value={label.id}
                                    selected={detail.issue.labels.some(
                                      (item) => item.id === label.id,
                                    )}
                                  >
                                    {label.name}
                                  </option>
                                </Fragment>
                              );
                            })}
                          </select>
                        </label>
                        {detail.issue.project ? (
                          <>
                            <span className="muted">Project {detail.issue.project.name}</span>
                          </>
                        ) : null}
                        {detail.issue.cycle ? (
                          <>
                            <span className="muted">
                              {detail.issue.cycle.name || 'Cycle ' + detail.issue.cycle.number}
                            </span>
                          </>
                        ) : null}
                      </div>
                      {s.canUseCodex ? (
                        <>
                          <section className="detail-section" aria-label="Codex work">
                            <h3>Codex</h3>
                            {!s.selected()?.agentInstalled ? (
                              <>
                                <p className="hint">
                                  Install the Relay agent in Linear from Settings before running
                                  Codex. Codex writes will appear under Relay’s separate agent
                                  identity.
                                </p>
                              </>
                            ) : null}
                            {detail.issue.project && s.isCodexAllowed(detail.issue) ? (
                              <>
                                {s.codexRequest()?.issue.id === detail.issue.id ? (
                                  <>
                                    <div
                                      className="codex-confirm"
                                      role="group"
                                      aria-label="Confirm Codex handoff"
                                    >
                                      <p>
                                        {s.codexRequest()?.continueThread ? 'Continue' : 'Start'} a
                                        Codex thread for {detail.issue.identifier} in{' '}
                                        {s.selectedCodexWorkspace()?.name}?
                                      </p>
                                      <p className="hint">
                                        Codex can change files in this local repository. Relay will
                                        post its final report as an issue comment and leave the
                                        issue in review.
                                      </p>
                                      <div className="issue-actions">
                                        <Button
                                          size="sm"
                                          disabled={s.codexPending()}
                                          onClick={() => {
                                            void s.confirmCodexRequest();
                                          }}
                                        >
                                          {s.codexPending()
                                            ? 'Working in Codex'
                                            : 'Confirm and run'}
                                        </Button>
                                        <Button
                                          size="sm"
                                          variant="outline"
                                          disabled={s.codexPending()}
                                          onClick={() => {
                                            void s.codexRequest.set(null);
                                          }}
                                        >
                                          Cancel
                                        </Button>
                                      </div>
                                    </div>
                                  </>
                                ) : null}
                                <label>
                                  <span>Local code workspace</span>
                                  <select
                                    value={s.selectedCodexWorkspacePath()}
                                    onChange={($event) => {
                                      void s.selectCodexWorkspace($event.currentTarget.value);
                                    }}
                                  >
                                    <option value="">Choose a repository</option>
                                    {s.codexWorkspaces().map((workspace) => {
                                      return (
                                        <Fragment key={workspace.path}>
                                          {workspace.githubRepo ===
                                          s.codexProjectRepo(detail.issue.project!.id) ? (
                                            <>
                                              <option value={workspace.path}>
                                                {workspace.name} — {workspace.githubRepo}
                                              </option>
                                            </>
                                          ) : null}
                                        </Fragment>
                                      );
                                    })}
                                  </select>
                                </label>
                                <div className="issue-actions">
                                  {s.localCodexLink() ? (
                                    <>
                                      <Button
                                        size="sm"
                                        disabled={
                                          s.codexPending() ||
                                          !s.selected()?.agentInstalled ||
                                          !s.selectedCodexWorkspacePath()
                                        }
                                        onClick={() => {
                                          void s.requestCodex(detail.issue, true);
                                        }}
                                      >
                                        Continue Codex
                                      </Button>
                                      <Button
                                        size="sm"
                                        variant="outline"
                                        disabled={
                                          s.codexPending() ||
                                          !s.selected()?.agentInstalled ||
                                          !s.selectedCodexWorkspacePath()
                                        }
                                        onClick={() => {
                                          void s.requestCodex(detail.issue, false);
                                        }}
                                      >
                                        Start new thread
                                      </Button>
                                    </>
                                  ) : (
                                    <>
                                      <Button
                                        size="sm"
                                        disabled={
                                          s.codexPending() ||
                                          !s.selected()?.agentInstalled ||
                                          !s.selectedCodexWorkspacePath()
                                        }
                                        onClick={() => {
                                          void s.requestCodex(detail.issue, false);
                                        }}
                                      >
                                        {s.codexPending()
                                          ? 'Working in Codex'
                                          : 'Start Codex thread'}
                                      </Button>
                                    </>
                                  )}
                                </div>
                                {s.remoteCodexLinks().map((link) => {
                                  return (
                                    <Fragment key={link.deviceId}>
                                      <p className="muted">
                                        This issue also has a Codex thread on {link.workspaceName}{' '}
                                        on another device.
                                      </p>
                                    </Fragment>
                                  );
                                })}
                                {s.codexPending() ? (
                                  <>
                                    <p className="hint" role="status">
                                      Codex is working in the selected local repository.
                                    </p>
                                  </>
                                ) : null}
                              </>
                            ) : detail.issue.project ? (
                              <>
                                <p className="hint">
                                  Codex is disabled for this Linear project. Enable it from the
                                  project page.
                                </p>
                              </>
                            ) : (
                              <>
                                <p className="hint">
                                  Link this issue to a Linear project with Codex enabled before
                                  sending it to Codex.
                                </p>
                              </>
                            )}
                          </section>
                        </>
                      ) : null}
                      {detail.children.length ? (
                        <>
                          <section className="detail-section" aria-label="Sub-issues">
                            <h3>Sub-issues</h3>
                            {detail.children.map((child) => {
                              return (
                                <Fragment key={child.id}>
                                  <button
                                    className="issue-link"
                                    type="button"
                                    onClick={() => {
                                      void s.openIssueDetail(child);
                                    }}
                                  >
                                    {child.identifier} · {child.title}
                                  </button>
                                </Fragment>
                              );
                            })}
                          </section>
                        </>
                      ) : null}
                      <section className="detail-section" aria-label="Issue dependencies and links">
                        <h3>Dependencies and links</h3>
                        {s.issueRelations(detail).map((relation) => {
                          return (
                            <Fragment key={relation.id}>
                              <article className="issue">
                                <span>{s.relationLabel(relation.type, relation.inverse)}</span>
                                <button
                                  className="issue-link"
                                  type="button"
                                  onClick={() => {
                                    void s.openIssueDetail(relation.target);
                                  }}
                                >
                                  {relation.target.identifier} · {relation.target.title}
                                </button>
                                {s.confirmDeleteIssueRelationId() === relation.id ? (
                                  <>
                                    <div className="issue-actions">
                                      <Button
                                        size="sm"
                                        variant="destructive"
                                        disabled={s.deletingIssueRelationId() === relation.id}
                                        onClick={() => {
                                          void s.deleteIssueRelation(detail.issue, relation.id);
                                        }}
                                      >
                                        {s.deletingIssueRelationId() === relation.id
                                          ? 'Removing'
                                          : 'Confirm'}
                                      </Button>
                                      <Button
                                        size="sm"
                                        variant="link"
                                        onClick={() => {
                                          void s.confirmDeleteIssueRelationId.set(null);
                                        }}
                                      >
                                        Cancel
                                      </Button>
                                    </div>
                                  </>
                                ) : (
                                  <>
                                    <Button
                                      size="sm"
                                      variant="link"
                                      onClick={() => {
                                        void s.confirmDeleteIssueRelationId.set(relation.id);
                                      }}
                                    >
                                      Remove
                                    </Button>
                                  </>
                                )}
                              </article>
                            </Fragment>
                          );
                        })}
                        {!detail.relations.length && !detail.inverseRelations.length ? (
                          <>
                            <p className="hint">No linked issues.</p>
                          </>
                        ) : null}
                        <form
                          className="detail-form"
                          onSubmit={($event) => {
                            void s.createIssueRelation($event.nativeEvent, detail.issue);
                          }}
                        >
                          {s.relatedIssueIdentifier() || s.newIssueRelationType() !== 'blocks' ? (
                            <>
                              <p className="hint">Issue link draft saved on this device.</p>
                            </>
                          ) : null}
                          <label>
                            <span>Link issue by identifier</span>
                            <input
                              required
                              maxLength={32}
                              value={s.relatedIssueIdentifier()}
                              onChange={($event) => {
                                void s.updateIssueRelationDraft(
                                  detail.issue,
                                  'identifier',
                                  $event.currentTarget.value,
                                );
                              }}
                              placeholder="ENG-123"
                            />
                          </label>
                          <label>
                            <span>Relationship</span>
                            <select
                              value={s.newIssueRelationType()}
                              onChange={($event) => {
                                void s.updateIssueRelationDraft(
                                  detail.issue,
                                  'type',
                                  $event.currentTarget.value,
                                );
                              }}
                            >
                              <option value="blocks">This issue blocks</option>
                              <option value="related">Related to</option>
                              <option value="duplicate">Duplicate of</option>
                              <option value="similar">Similar to</option>
                            </select>
                          </label>
                          <Button
                            size="sm"
                            disabled={
                              s.creatingIssueRelation() || !s.relatedIssueIdentifier().trim()
                            }
                          >
                            {s.creatingIssueRelation() ? 'Linking' : 'Link issue'}
                          </Button>
                        </form>
                      </section>
                      <form
                        className="detail-form"
                        onSubmit={($event) => {
                          void s.createSubIssue($event.nativeEvent, detail.issue);
                        }}
                      >
                        {s.newSubIssueTitle() ? (
                          <>
                            <p className="hint">Sub-issue draft saved on this device.</p>
                          </>
                        ) : null}
                        <label>
                          <span>Add sub-issue</span>
                          <input
                            required
                            maxLength={255}
                            value={s.newSubIssueTitle()}
                            onChange={($event) => {
                              void s.updateSubIssueDraft(detail.issue, $event.currentTarget.value);
                            }}
                          />
                        </label>
                        <Button
                          size="sm"
                          disabled={s.creatingSubIssue() || !s.newSubIssueTitle().trim()}
                        >
                          {s.creatingSubIssue() ? 'Creating' : 'Add sub-issue'}
                        </Button>
                      </form>
                      <section className="detail-section" aria-label="Comments">
                        <h3>Comments</h3>
                        {detail.comments.length === 0 ? (
                          <>
                            <p className="hint">No comments yet.</p>
                          </>
                        ) : (
                          detail.comments.map((comment) => {
                            return (
                              <Fragment key={comment.id}>
                                <article className="comment">
                                  {s.editingCommentId() === comment.id ? (
                                    <>
                                      <form
                                        className="detail-form"
                                        onSubmit={($event) => {
                                          void s.saveComment($event.nativeEvent, comment);
                                        }}
                                      >
                                        <label>
                                          <span>Edit comment</span>
                                          <textarea
                                            required
                                            maxLength={10000}
                                            rows={3}
                                            value={s.editCommentBody()}
                                            onChange={($event) => {
                                              void s.updateCommentEditDraft(
                                                comment,
                                                $event.currentTarget.value,
                                              );
                                            }}
                                          />
                                        </label>
                                        {s.commentEditConflict() ? (
                                          <>
                                            <div
                                              className="issue-conflicts"
                                              role="group"
                                              aria-label="Comment draft conflict"
                                            >
                                              <p className="hint">
                                                This comment changed in Linear while your draft was
                                                saved.
                                              </p>
                                              <div className="issue-actions">
                                                <Button
                                                  size="sm"
                                                  variant="outline"
                                                  type="button"
                                                  onClick={() => {
                                                    void s.resolveCommentEditConflict(
                                                      comment,
                                                      false,
                                                    );
                                                  }}
                                                >
                                                  Use Linear’s version
                                                </Button>
                                                <Button
                                                  size="sm"
                                                  type="button"
                                                  onClick={() => {
                                                    void s.resolveCommentEditConflict(
                                                      comment,
                                                      true,
                                                    );
                                                  }}
                                                >
                                                  Keep my edit
                                                </Button>
                                              </div>
                                            </div>
                                          </>
                                        ) : null}
                                        <div className="issue-actions">
                                          <Button
                                            size="sm"
                                            disabled={
                                              s.savingComment() ||
                                              s.commentEditConflict() ||
                                              !s.editCommentBody().trim()
                                            }
                                          >
                                            {s.savingComment() ? 'Saving' : 'Save comment'}
                                          </Button>
                                          <Button
                                            size="sm"
                                            variant="link"
                                            type="button"
                                            onClick={() => {
                                              void s.cancelCommentEdit();
                                            }}
                                          >
                                            Cancel
                                          </Button>
                                        </div>
                                      </form>
                                    </>
                                  ) : (
                                    <>
                                      <p>{comment.body}</p>
                                      <span className="muted">
                                        {comment.user?.name ?? 'Linear integration'} ·
                                        {s.projectUpdateDate(comment.createdAt)}
                                        {comment.editedAt ? <>· edited</> : null}
                                      </span>
                                      {comment.user?.id === s.selected()?.viewerId ? (
                                        <>
                                          {s.confirmDeleteCommentId() === comment.id ? (
                                            <>
                                              <div
                                                className="issue-actions"
                                                role="group"
                                                aria-label="Confirm comment deletion"
                                              >
                                                <span className="muted">
                                                  Delete this comment? This cannot be undone.
                                                </span>
                                                <Button
                                                  size="sm"
                                                  variant="destructive"
                                                  type="button"
                                                  disabled={s.deletingCommentId() === comment.id}
                                                  onClick={() => {
                                                    void s.deleteComment(comment);
                                                  }}
                                                >
                                                  {s.deletingCommentId() === comment.id
                                                    ? 'Deleting'
                                                    : 'Confirm delete'}
                                                </Button>
                                                <Button
                                                  size="sm"
                                                  variant="link"
                                                  type="button"
                                                  onClick={() => {
                                                    void s.confirmDeleteCommentId.set(null);
                                                  }}
                                                >
                                                  Cancel
                                                </Button>
                                              </div>
                                            </>
                                          ) : (
                                            <>
                                              <div className="issue-actions">
                                                <Button
                                                  size="sm"
                                                  variant="link"
                                                  type="button"
                                                  onClick={() => {
                                                    void s.editComment(comment);
                                                  }}
                                                >
                                                  Edit
                                                </Button>
                                                <Button
                                                  size="sm"
                                                  variant="link"
                                                  type="button"
                                                  onClick={() => {
                                                    void s.confirmDeleteCommentId.set(comment.id);
                                                  }}
                                                >
                                                  Delete
                                                </Button>
                                              </div>
                                            </>
                                          )}
                                        </>
                                      ) : null}
                                    </>
                                  )}
                                </article>
                              </Fragment>
                            );
                          })
                        )}
                        <form
                          className="detail-form"
                          onSubmit={($event) => {
                            void s.createComment($event.nativeEvent, detail.issue);
                          }}
                        >
                          <label>
                            <span>Write a comment</span>
                            <textarea
                              required
                              maxLength={10000}
                              rows={3}
                              value={s.newComment()}
                              onChange={($event) => {
                                void s.updateNewComment(detail.issue, $event.currentTarget.value);
                              }}
                            />
                          </label>
                          <Button size="sm" disabled={s.sendingComment() || !s.newComment().trim()}>
                            {s.sendingComment() ? 'Sending' : 'Comment'}
                          </Button>
                        </form>
                      </section>
                    </section>
                  </>
                ))}
                {s.section() === 'work' ? (
                  <>
                    <section className="issues" aria-label="Linear issues">
                      <div className="issue-heading">
                        <h2>
                          {s.issueSearchTerm()
                            ? 'Search results'
                            : s.issueFilterCount()
                              ? 'Filtered issues'
                              : s.issueTeamId()
                                ? s.teamName(s.issueTeamId()) + ' issues'
                                : 'My work'}
                        </h2>
                        <div className="issue-actions">
                          <form
                            className="issue-actions"
                            role="search"
                            onSubmit={($event) => {
                              void s.searchIssues($event.nativeEvent);
                            }}
                          >
                            <label>
                              <span className="sr-only">Search issue titles</span>
                              <input
                                type="search"
                                maxLength={255}
                                value={s.issueSearchInput()}
                                onChange={($event) => {
                                  void s.issueSearchInput.set($event.currentTarget.value);
                                }}
                                placeholder="Search issue titles"
                              />
                            </label>
                            <Button size="sm" disabled={s.loading()}>
                              {s.loading() ? 'Searching' : 'Search'}
                            </Button>
                            {s.issueSearchTerm() ? (
                              <>
                                <Button
                                  size="sm"
                                  variant="link"
                                  type="button"
                                  disabled={s.loading()}
                                  onClick={() => {
                                    void s.clearIssueSearch();
                                  }}
                                >
                                  Clear
                                </Button>
                              </>
                            ) : null}
                          </form>
                          <label>
                            <span className="sr-only">Issue scope</span>
                            <select
                              aria-label="Issue scope"
                              value={s.issueTeamId()}
                              disabled={s.loading()}
                              onChange={($event) => {
                                void s.setIssueTeam($event.currentTarget.value);
                              }}
                            >
                              <option value="">Assigned to me</option>
                              {s.teams().map((team) => {
                                return (
                                  <Fragment key={team.id}>
                                    <option value={team.id}>All {team.name} issues</option>
                                  </Fragment>
                                );
                              })}
                            </select>
                          </label>
                          <details className="issue-filters">
                            <summary>
                              Filters{s.issueFilterCount() ? ' · ' + s.issueFilterCount() : ''}
                            </summary>
                            <label>
                              <span>Status</span>
                              <select
                                value={s.issueStateId()}
                                disabled={s.loading()}
                                onChange={($event) => {
                                  void s.setIssueStateFilter($event.currentTarget.value);
                                }}
                              >
                                <option value="">Any status</option>
                                {s.teams().map((team) => {
                                  return (
                                    <Fragment key={team.id}>
                                      {!s.issueTeamId() || s.issueTeamId() === team.id ? (
                                        <>
                                          {s.statesForTeam(team.id).map((state) => {
                                            return (
                                              <Fragment key={state.id}>
                                                <option value={state.id}>
                                                  {s.issueTeamId()
                                                    ? state.name
                                                    : team.name + ' · ' + state.name}
                                                </option>
                                              </Fragment>
                                            );
                                          })}
                                        </>
                                      ) : null}
                                    </Fragment>
                                  );
                                })}
                              </select>
                            </label>
                            <label>
                              <span>Priority</span>
                              <select
                                value={s.issuePriority()}
                                disabled={s.loading()}
                                onChange={($event) => {
                                  void s.setIssuePriorityFilter($event.currentTarget.value);
                                }}
                              >
                                <option value="">Any priority</option>
                                <option value="0">No priority</option>
                                <option value="1">Urgent</option>
                                <option value="2">High</option>
                                <option value="3">Normal</option>
                                <option value="4">Low</option>
                              </select>
                            </label>
                            {s.issueTeamId() ? (
                              <>
                                <label>
                                  <span>Assignee</span>
                                  <select
                                    value={s.issueAssigneeId()}
                                    disabled={s.loading()}
                                    onChange={($event) => {
                                      void s.setIssueAssigneeFilter($event.currentTarget.value);
                                    }}
                                  >
                                    <option value="">Anyone</option>
                                    <option value="unassigned">Unassigned</option>
                                    {s.users().map((user) => {
                                      return (
                                        <Fragment key={user.id}>
                                          <option value={user.id}>{user.name}</option>
                                        </Fragment>
                                      );
                                    })}
                                  </select>
                                </label>
                                <label>
                                  <span>Cycle</span>
                                  <select
                                    value={s.issueCycleId()}
                                    disabled={s.loading()}
                                    onChange={($event) => {
                                      void s.setIssueCycleFilter($event.currentTarget.value);
                                    }}
                                  >
                                    <option value="">Any cycle</option>
                                    <option value="uncycled">No cycle</option>
                                    {s.cyclesFor(s.issueTeamId()).map((cycle) => {
                                      return (
                                        <Fragment key={cycle.id}>
                                          <option value={cycle.id}>
                                            {cycle.name || 'Cycle ' + cycle.number}
                                          </option>
                                        </Fragment>
                                      );
                                    })}
                                  </select>
                                </label>
                              </>
                            ) : null}
                            <label>
                              <span>Label</span>
                              <select
                                value={s.issueLabelId()}
                                disabled={s.loading()}
                                onChange={($event) => {
                                  void s.setIssueLabelFilter($event.currentTarget.value);
                                }}
                              >
                                <option value="">Any label</option>
                                {s.issueFilterLabels().map((label) => {
                                  return (
                                    <Fragment key={label.id}>
                                      <option value={label.id}>{label.name}</option>
                                    </Fragment>
                                  );
                                })}
                              </select>
                            </label>
                          </details>
                          <Button
                            size="sm"
                            variant="link"
                            disabled={s.loading()}
                            onClick={() => {
                              void s.loadIssues();
                            }}
                          >
                            {s.loading() ? 'Loading' : 'Refresh'}
                          </Button>
                          <Button
                            size="sm"
                            variant="link"
                            disabled={s.loading()}
                            onClick={() => {
                              void s.toggleArchivedIssues();
                            }}
                          >
                            {s.includeArchivedIssues() ? 'Hide archived' : 'Include archived'}
                          </Button>
                          {s.confirmDisconnectOrganizationId() === s.selected()?.organizationId ? (
                            <>
                              <span className="hint">Revoke Linear access on all devices?</span>
                              <Button
                                size="sm"
                                variant="destructive"
                                disabled={
                                  s.disconnectingOrganizationId() === s.selected()?.organizationId
                                }
                                onClick={() => {
                                  void s.disconnectSelected();
                                }}
                              >
                                {s.disconnectingOrganizationId() === s.selected()?.organizationId
                                  ? 'Disconnecting'
                                  : 'Confirm disconnect'}
                              </Button>
                              <Button
                                size="sm"
                                variant="link"
                                onClick={() => {
                                  void s.confirmDisconnectOrganizationId.set(null);
                                }}
                              >
                                Cancel
                              </Button>
                            </>
                          ) : (
                            <>
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => {
                                  void s.confirmDisconnectOrganizationId.set(
                                    s.selected()?.organizationId ?? null,
                                  );
                                }}
                              >
                                Disconnect everywhere
                              </Button>
                            </>
                          )}
                        </div>
                      </div>
                      {s.teams().length ? (
                        <>
                          <form
                            className="create-form"
                            onSubmit={($event) => {
                              void s.createIssue($event.nativeEvent);
                            }}
                          >
                            <label>
                              <span>Team</span>
                              <select
                                value={s.createTeamId()}
                                onChange={($event) => {
                                  void s.setCreateTeam($event.currentTarget.value);
                                }}
                              >
                                {s.teams().map((team) => {
                                  return (
                                    <Fragment key={team.id}>
                                      <option value={team.id}>{team.name}</option>
                                    </Fragment>
                                  );
                                })}
                              </select>
                            </label>
                            {s.estimateOptions(s.createTeamId()).length ? (
                              <>
                                <label>
                                  <span>Estimate</span>
                                  <select
                                    value={s.newEstimate()}
                                    onChange={($event) => {
                                      void s.updateIssueDraftEstimate($event.currentTarget.value);
                                    }}
                                  >
                                    <option value="">No estimate</option>
                                    {s.estimateOptions(s.createTeamId()).map((option) => {
                                      return (
                                        <Fragment key={option.value}>
                                          <option value={option.value}>{option.label}</option>
                                        </Fragment>
                                      );
                                    })}
                                  </select>
                                </label>
                              </>
                            ) : null}
                            <details className="issue-create-options">
                              <summary>More fields</summary>
                              <label>
                                <span>Status</span>
                                <select
                                  value={s.newStateId()}
                                  onChange={($event) => {
                                    void s.updateIssueDraftState($event.currentTarget.value);
                                  }}
                                >
                                  <option value="">Team default</option>
                                  {s.statesForTeam(s.createTeamId()).map((state) => {
                                    return (
                                      <Fragment key={state.id}>
                                        <option value={state.id}>{state.name}</option>
                                      </Fragment>
                                    );
                                  })}
                                </select>
                              </label>
                              <label>
                                <span>Cycle</span>
                                <select
                                  value={s.newCycleId()}
                                  onChange={($event) => {
                                    void s.updateIssueDraftCycle($event.currentTarget.value);
                                  }}
                                >
                                  <option value="">No cycle</option>
                                  {s.cyclesFor(s.createTeamId()).map((cycle) => {
                                    return (
                                      <Fragment key={cycle.id}>
                                        <option value={cycle.id}>
                                          {cycle.name || 'Cycle ' + cycle.number}
                                        </option>
                                      </Fragment>
                                    );
                                  })}
                                </select>
                              </label>
                              <label>
                                <span>Priority</span>
                                <select
                                  value={s.newPriority()}
                                  onChange={($event) => {
                                    void s.updateIssueDraftPriority($event.currentTarget.value);
                                  }}
                                >
                                  <option value="">No priority</option>
                                  <option value="1">Urgent</option>
                                  <option value="2">High</option>
                                  <option value="3">Normal</option>
                                  <option value="4">Low</option>
                                </select>
                              </label>
                              <label>
                                <span>Assignee</span>
                                <select
                                  value={s.newAssigneeId()}
                                  onChange={($event) => {
                                    void s.updateIssueDraftAssignee($event.currentTarget.value);
                                  }}
                                >
                                  <option value="">Me</option>
                                  {s.users().map((user) => {
                                    return (
                                      <Fragment key={user.id}>
                                        <option value={user.id}>{user.name}</option>
                                      </Fragment>
                                    );
                                  })}
                                </select>
                              </label>
                              <label>
                                <span>Due date</span>
                                <input
                                  type="date"
                                  value={s.newDueDate()}
                                  onChange={($event) => {
                                    void s.updateIssueDraftDueDate($event.currentTarget.value);
                                  }}
                                />
                              </label>
                              {s.labelsFor(s.createTeamId()).length ? (
                                <>
                                  <label>
                                    <span>Labels</span>
                                    <select
                                      multiple
                                      size={3}
                                      onChange={($event) => {
                                        void s.updateIssueDraftLabels($event.nativeEvent);
                                      }}
                                    >
                                      {s.labelsFor(s.createTeamId()).map((label) => {
                                        return (
                                          <Fragment key={label.id}>
                                            <option
                                              value={label.id}
                                              selected={s.newLabelIds().includes(label.id)}
                                            >
                                              {label.name}
                                            </option>
                                          </Fragment>
                                        );
                                      })}
                                    </select>
                                  </label>
                                </>
                              ) : null}
                            </details>
                            <label>
                              <span>New issue</span>
                              <input
                                required
                                maxLength={255}
                                value={s.newTitle()}
                                onChange={($event) => {
                                  void s.updateIssueDraft('title', $event.currentTarget.value);
                                }}
                                placeholder="Issue title"
                              />
                            </label>
                            <label className="description-field">
                              <span>Description</span>
                              <textarea
                                rows={2}
                                value={s.newDescription()}
                                onChange={($event) => {
                                  void s.updateIssueDraft(
                                    'description',
                                    $event.currentTarget.value,
                                  );
                                }}
                                placeholder="Add context (optional)"
                              />
                            </label>
                            <Button size="sm" disabled={s.creating() || !s.newTitle().trim()}>
                              {s.creating() ? 'Creating' : 'Create issue'}
                            </Button>
                          </form>
                          {s.newTitle() ||
                          s.newDescription() ||
                          s.newEstimate() ||
                          s.newAssigneeId() ||
                          s.newPriority() ||
                          s.newDueDate() ||
                          s.newLabelIds().length ||
                          s.newStateId() ||
                          s.newCycleId() ? (
                            <>
                              <p className="hint">Draft saved on this device.</p>
                            </>
                          ) : null}
                        </>
                      ) : null}
                      {s.issueCacheStale() ? (
                        <>
                          <p className="hint" role="status">
                            Showing saved issues; refresh to check for updates.
                          </p>
                        </>
                      ) : null}
                      {s.issues().length === 0 && !s.loading() ? (
                        <>
                          <p className="hint">
                            {s.issueTeamId()
                              ? 'No issues found for this team.'
                              : 'No assigned issues found.'}
                          </p>
                        </>
                      ) : null}
                      {s.issues().map((issue) => {
                        return (
                          <Fragment key={issue.id}>
                            <article className="issue">
                              <button
                                className="issue-link"
                                type="button"
                                onClick={() => {
                                  void s.openIssue(issue.url);
                                }}
                              >
                                {issue.identifier}
                              </button>
                              <button
                                className="issue-title"
                                type="button"
                                onClick={() => {
                                  void s.openIssueDetail(issue);
                                }}
                              >
                                {issue.title}
                              </button>
                              <div className="issue-actions">
                                {issue.archivedAt ? (
                                  <>
                                    <span className="hint">Archived</span>
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      disabled={!!s.archivingIssueId()}
                                      onClick={() => {
                                        void s.setIssueArchived(issue, false);
                                      }}
                                    >
                                      {s.archivingIssueId() === issue.id ? 'Restoring' : 'Restore'}
                                    </Button>
                                  </>
                                ) : (
                                  <>
                                    <label className="status-control">
                                      <span className="sr-only">Status for {issue.identifier}</span>
                                      <select
                                        value={issue.state?.id ?? ''}
                                        onChange={($event) => {
                                          void s.updateStatus(issue, $event.currentTarget.value);
                                        }}
                                      >
                                        {s.statesFor(issue).map((state) => {
                                          return (
                                            <Fragment key={state.id}>
                                              <option value={state.id}>{state.name}</option>
                                            </Fragment>
                                          );
                                        })}
                                      </select>
                                    </label>
                                    {s.confirmArchiveIssueId() === issue.id ? (
                                      <>
                                        <Button
                                          size="sm"
                                          variant="outline"
                                          disabled={!!s.archivingIssueId()}
                                          onClick={() => {
                                            void s.setIssueArchived(issue, true);
                                          }}
                                        >
                                          {s.archivingIssueId() === issue.id
                                            ? 'Archiving'
                                            : 'Confirm archive'}
                                        </Button>
                                        <Button
                                          size="sm"
                                          variant="link"
                                          type="button"
                                          onClick={() => {
                                            void s.confirmArchiveIssueId.set(null);
                                          }}
                                        >
                                          Cancel
                                        </Button>
                                      </>
                                    ) : (
                                      <>
                                        <Button
                                          size="sm"
                                          variant="link"
                                          onClick={() => {
                                            void s.confirmArchiveIssueId.set(issue.id);
                                          }}
                                        >
                                          Archive
                                        </Button>
                                      </>
                                    )}
                                  </>
                                )}
                              </div>
                            </article>
                          </Fragment>
                        );
                      })}
                      {s.hasNextPage() ? (
                        <>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={s.loading()}
                            onClick={() => {
                              void s.loadMore();
                            }}
                          >
                            Load more
                          </Button>
                        </>
                      ) : null}
                    </section>
                  </>
                ) : s.section() === 'projects' ? (
                  <>
                    <section className="issues" aria-label="Linear projects">
                      {s.projectCacheStale() ? (
                        <>
                          <p className="hint" role="status">
                            Showing saved projects; refresh to check for updates.
                          </p>
                        </>
                      ) : null}
                      <div className="issue-heading">
                        <h2>{s.selectedProject()?.name ?? 'Projects'}</h2>
                        {s.selectedProject() ? (
                          <>
                            <Button
                              size="sm"
                              variant="link"
                              onClick={() => {
                                void s.closeSelectedProject();
                              }}
                            >
                              All projects
                            </Button>
                          </>
                        ) : (
                          <>
                            <div className="issue-actions">
                              <Button
                                size="sm"
                                variant="link"
                                onClick={() => {
                                  void s.loadProjects();
                                }}
                              >
                                Refresh
                              </Button>
                              <Button
                                size="sm"
                                variant="link"
                                onClick={() => {
                                  void s.toggleArchivedProjects();
                                }}
                              >
                                {s.showArchivedProjects() ? 'Hide archived' : 'Include archived'}
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => {
                                  void s.toggleCreateProject();
                                }}
                              >
                                New project
                              </Button>
                            </div>
                          </>
                        )}
                      </div>
                      {s.selectedProject() ? (
                        <>
                          <form
                            className="project-edit"
                            onSubmit={($event) => {
                              void s.saveProject($event.nativeEvent);
                            }}
                          >
                            <label>
                              <span>Project name</span>
                              <input
                                required
                                maxLength={255}
                                disabled={s.savingProject()}
                                value={s.editProjectName()}
                                onChange={($event) => {
                                  void s.updateProjectEditDraft('name', $event.currentTarget.value);
                                }}
                              />
                            </label>
                            <label>
                              <span>Description</span>
                              <textarea
                                rows={3}
                                disabled={s.savingProject()}
                                value={s.editProjectDescription()}
                                onChange={($event) => {
                                  void s.updateProjectEditDraft(
                                    'description',
                                    $event.currentTarget.value,
                                  );
                                }}
                              />
                            </label>
                            <label>
                              <span>Start date</span>
                              <input
                                type="date"
                                disabled={s.savingProject()}
                                value={s.editProjectStartDate()}
                                onChange={($event) => {
                                  void s.updateProjectEditDraft(
                                    'startDate',
                                    $event.currentTarget.value,
                                  );
                                }}
                              />
                            </label>
                            <label>
                              <span>Target date</span>
                              <input
                                type="date"
                                disabled={s.savingProject()}
                                value={s.editProjectTargetDate()}
                                onChange={($event) => {
                                  void s.updateProjectEditDraft(
                                    'targetDate',
                                    $event.currentTarget.value,
                                  );
                                }}
                              />
                            </label>
                            <label>
                              <span>Status</span>
                              <select
                                disabled={s.savingProject()}
                                value={s.editProjectStatusId()}
                                onChange={($event) => {
                                  void s.updateProjectEditDraft(
                                    'statusId',
                                    $event.currentTarget.value,
                                  );
                                }}
                              >
                                {s.projectStatuses().map((status) => {
                                  return (
                                    <Fragment key={status.id}>
                                      <option value={status.id}>{status.name}</option>
                                    </Fragment>
                                  );
                                })}
                              </select>
                            </label>
                            <label>
                              <span>Project lead</span>
                              <select
                                disabled={s.savingProject()}
                                value={s.editProjectLeadId()}
                                onChange={($event) => {
                                  void s.updateProjectEditDraft(
                                    'leadId',
                                    $event.currentTarget.value,
                                  );
                                }}
                              >
                                <option value="">No lead</option>
                                {s.users().map((user) => {
                                  return (
                                    <Fragment key={user.id}>
                                      <option value={user.id}>{user.name}</option>
                                    </Fragment>
                                  );
                                })}
                              </select>
                            </label>
                            <fieldset className="project-teams">
                              <legend>Project teams</legend>
                              {s.teams().map((team) => {
                                return (
                                  <Fragment key={team.id}>
                                    <label>
                                      <input
                                        type="checkbox"
                                        disabled={s.savingProject()}
                                        checked={s.editProjectTeamIds().includes(team.id)}
                                        onChange={($event) => {
                                          void s.toggleProjectTeam(
                                            'edit',
                                            team.id,
                                            $event.nativeEvent,
                                          );
                                        }}
                                      />
                                      {team.name}
                                    </label>
                                  </Fragment>
                                );
                              })}
                            </fieldset>
                            {s.projectEditDraftConflict() ? (
                              <>
                                <div className="issue-conflicts" role="alert">
                                  <span>This project draft overlaps newer changes in Linear.</span>
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    type="button"
                                    onClick={() => {
                                      void s.resolveProjectEditDraftConflict(true);
                                    }}
                                  >
                                    Keep draft
                                  </Button>
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    type="button"
                                    onClick={() => {
                                      void s.resolveProjectEditDraftConflict(false);
                                    }}
                                  >
                                    Use Linear's version
                                  </Button>
                                </div>
                              </>
                            ) : s.hasProjectEditDraft() ? (
                              <>
                                <p className="hint">Project draft saved on this device.</p>
                              </>
                            ) : null}
                            <Button
                              size="sm"
                              disabled={
                                s.savingProject() ||
                                s.projectEditDraftConflict() ||
                                !s.editProjectName().trim() ||
                                !s.editProjectTeamIds().length
                              }
                            >
                              {s.savingProject() ? 'Saving' : 'Save project'}
                            </Button>
                          </form>
                          <div className="issue-actions">
                            {s.selectedProject()!.archivedAt ? (
                              <>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  disabled={s.archivingProject()}
                                  onClick={() => {
                                    void s.unarchiveSelectedProject();
                                  }}
                                >
                                  {s.archivingProject() ? 'Restoring' : 'Restore project'}
                                </Button>
                              </>
                            ) : s.confirmArchiveProjectId() === s.selectedProject()!.id ? (
                              <>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  disabled={s.archivingProject()}
                                  onClick={() => {
                                    void s.archiveSelectedProject();
                                  }}
                                >
                                  {s.archivingProject() ? 'Archiving' : 'Confirm archive'}
                                </Button>
                                <Button
                                  size="sm"
                                  variant="link"
                                  type="button"
                                  onClick={() => {
                                    void s.confirmArchiveProjectId.set(null);
                                  }}
                                >
                                  Cancel
                                </Button>
                              </>
                            ) : (
                              <>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() => {
                                    void s.confirmArchiveProjectId.set(s.selectedProject()!.id);
                                  }}
                                >
                                  Archive project
                                </Button>
                              </>
                            )}
                          </div>
                          {s.selectedProject()!.archivedAt ? (
                            <>
                              <p className="hint">This project is archived.</p>
                            </>
                          ) : null}
                          {s.canUseCodex ? (
                            <>
                              <div className="codex-policy">
                                <label>
                                  <span>Linked code repository</span>
                                  <select
                                    value={s.selectedCodexProjectRepo()}
                                    onChange={($event) => {
                                      void s.setCodexProjectRepo(
                                        s.selectedProject()!.id,
                                        $event.currentTarget.value,
                                      );
                                    }}
                                  >
                                    <option value="">Choose a GitHub repository</option>
                                    {s.codexWorkspaces().map((workspace) => {
                                      return (
                                        <Fragment key={workspace.path}>
                                          {workspace.githubRepo ? (
                                            <>
                                              <option value={workspace.githubRepo}>
                                                {workspace.name} — {workspace.githubRepo}
                                              </option>
                                            </>
                                          ) : null}
                                        </Fragment>
                                      );
                                    })}
                                  </select>
                                </label>
                                <label className="codex-policy-toggle">
                                  <input
                                    type="checkbox"
                                    disabled={!s.selectedCodexProjectRepo()}
                                    checked={s.isCodexProjectAllowed(s.selectedProject()!.id)}
                                    onChange={($event) => {
                                      void s.setCodexProjectAllowed(
                                        s.selectedProject()!.id,
                                        $event.currentTarget.checked,
                                      );
                                    }}
                                  />
                                  <span>Allow Codex to work on issues in this project</span>
                                </label>
                              </div>
                            </>
                          ) : null}
                          <section className="milestones" aria-label="Project resources">
                            <h3>Resources</h3>
                            {s.projectResources().documents.length === 0 ? (
                              <>
                                <p className="hint">No project documents yet.</p>
                              </>
                            ) : (
                              s.projectResources().documents.map((document) => {
                                return (
                                  <Fragment key={document.id}>
                                    <article className="resource-row">
                                      <div>
                                        <strong>{document.title}</strong>
                                        <span className="muted">
                                          Updated {document.updatedAt}
                                          {document.creator?.name ? (
                                            <>by {document.creator.name}</>
                                          ) : null}
                                        </span>
                                      </div>
                                      <Button
                                        size="sm"
                                        variant="link"
                                        onClick={() => {
                                          void s.openResource(document.url);
                                        }}
                                      >
                                        Open in Linear
                                      </Button>
                                      <Button
                                        size="sm"
                                        variant="link"
                                        disabled={s.loadingProjectDocumentId() === document.id}
                                        onClick={() => {
                                          void s.editProjectDocument(document);
                                        }}
                                      >
                                        {s.loadingProjectDocumentId() === document.id
                                          ? 'Loading'
                                          : 'Edit in Relay'}
                                      </Button>
                                    </article>
                                  </Fragment>
                                );
                              })
                            )}
                            {s.editingProjectDocumentId() ? (
                              <>
                                <form
                                  className="project-edit"
                                  onSubmit={($event) => {
                                    void s.saveProjectDocument($event.nativeEvent);
                                  }}
                                >
                                  <h4>Edit project document</h4>
                                  {s.projectDocumentEditConflict() ? (
                                    <>
                                      <p className="hint" role="alert">
                                        This document changed in Linear while you edited it. Your
                                        draft is still here; load the latest version only if you
                                        want to replace your draft.
                                      </p>
                                      <Button
                                        size="sm"
                                        variant="outline"
                                        disabled={
                                          s.loadingProjectDocumentId() ===
                                          s.editingProjectDocumentId()
                                        }
                                        onClick={() => {
                                          void s.reloadProjectDocument();
                                        }}
                                      >
                                        Load latest version and replace draft
                                      </Button>
                                    </>
                                  ) : null}
                                  {s.projectDocumentEditOffline() ? (
                                    <>
                                      <p className="hint" role="status">
                                        Offline draft restored. Linear will check for newer changes
                                        when you save.
                                      </p>
                                    </>
                                  ) : null}
                                  <label>
                                    <span>Title</span>
                                    <input
                                      required
                                      maxLength={255}
                                      value={s.editProjectDocumentTitle()}
                                      onChange={($event) => {
                                        void s.updateProjectDocumentDraft(
                                          'title',
                                          $event.currentTarget.value,
                                        );
                                      }}
                                    />
                                  </label>
                                  <label>
                                    <span>Markdown content</span>
                                    <textarea
                                      maxLength={50000}
                                      rows={8}
                                      value={s.editProjectDocumentContent()}
                                      onChange={($event) => {
                                        void s.updateProjectDocumentDraft(
                                          'content',
                                          $event.currentTarget.value,
                                        );
                                      }}
                                    />
                                  </label>
                                  <div className="issue-actions">
                                    <Button
                                      size="sm"
                                      disabled={
                                        s.savingProjectDocument() ||
                                        s.projectDocumentEditConflict() ||
                                        !s.editProjectDocumentTitle().trim()
                                      }
                                    >
                                      {s.savingProjectDocument() ? 'Saving' : 'Save document'}
                                    </Button>
                                    <Button
                                      size="sm"
                                      variant="link"
                                      type="button"
                                      disabled={s.savingProjectDocument()}
                                      onClick={() => {
                                        void s.closeProjectDocumentEditor();
                                      }}
                                    >
                                      Cancel
                                    </Button>
                                  </div>
                                </form>
                              </>
                            ) : null}
                            {s.projectResources().externalLinks.map((link) => {
                              return (
                                <Fragment key={link.id}>
                                  <article className="resource-row">
                                    <strong>{link.label}</strong>
                                    <div className="issue-actions">
                                      <Button
                                        size="sm"
                                        variant="link"
                                        onClick={() => {
                                          void s.openResource(link.url);
                                        }}
                                      >
                                        Open link
                                      </Button>
                                      {s.confirmDeleteProjectLinkId() === link.id ? (
                                        <>
                                          <span className="muted">Remove this project link?</span>
                                          <Button
                                            size="sm"
                                            variant="destructive"
                                            disabled={s.deletingProjectLinkId() === link.id}
                                            onClick={() => {
                                              void s.deleteProjectLink(link);
                                            }}
                                          >
                                            {s.deletingProjectLinkId() === link.id
                                              ? 'Removing'
                                              : 'Confirm remove'}
                                          </Button>
                                          <Button
                                            size="sm"
                                            variant="link"
                                            onClick={() => {
                                              void s.confirmDeleteProjectLinkId.set(null);
                                            }}
                                          >
                                            Cancel
                                          </Button>
                                        </>
                                      ) : (
                                        <>
                                          <Button
                                            size="sm"
                                            variant="link"
                                            onClick={() => {
                                              void s.confirmDeleteProjectLinkId.set(link.id);
                                            }}
                                          >
                                            Remove
                                          </Button>
                                        </>
                                      )}
                                    </div>
                                  </article>
                                </Fragment>
                              );
                            })}
                            {!s.selectedProject()!.archivedAt ? (
                              <>
                                <form
                                  className="project-edit"
                                  onSubmit={($event) => {
                                    void s.createProjectDocument($event.nativeEvent);
                                  }}
                                >
                                  {s.newProjectDocumentTitle() || s.newProjectDocumentContent() ? (
                                    <>
                                      <p className="hint">Document draft saved on this device.</p>
                                    </>
                                  ) : null}
                                  <label>
                                    <span>New document</span>
                                    <input
                                      required
                                      maxLength={255}
                                      value={s.newProjectDocumentTitle()}
                                      onChange={($event) => {
                                        void s.updateProjectDocumentCreateDraft(
                                          'title',
                                          $event.currentTarget.value,
                                        );
                                      }}
                                      placeholder="Document title"
                                    />
                                  </label>
                                  <label>
                                    <span>Markdown content</span>
                                    <textarea
                                      required
                                      maxLength={50000}
                                      rows={4}
                                      value={s.newProjectDocumentContent()}
                                      onChange={($event) => {
                                        void s.updateProjectDocumentCreateDraft(
                                          'content',
                                          $event.currentTarget.value,
                                        );
                                      }}
                                    />
                                  </label>
                                  <Button
                                    size="sm"
                                    disabled={
                                      s.creatingProjectDocument() ||
                                      !s.newProjectDocumentTitle().trim() ||
                                      !s.newProjectDocumentContent().trim()
                                    }
                                  >
                                    {s.creatingProjectDocument()
                                      ? 'Creating'
                                      : 'Create document in Linear'}
                                  </Button>
                                </form>
                                <form
                                  className="project-edit"
                                  onSubmit={($event) => {
                                    void s.createProjectLink($event.nativeEvent);
                                  }}
                                >
                                  {s.newProjectLinkLabel() || s.newProjectLinkUrl() ? (
                                    <>
                                      <p className="hint">Link draft saved on this device.</p>
                                    </>
                                  ) : null}
                                  <label>
                                    <span>Add external link</span>
                                    <input
                                      required
                                      maxLength={255}
                                      value={s.newProjectLinkLabel()}
                                      onChange={($event) => {
                                        void s.updateProjectLinkDraft(
                                          'label',
                                          $event.currentTarget.value,
                                        );
                                      }}
                                      placeholder="Link name"
                                    />
                                  </label>
                                  <label>
                                    <span>URL</span>
                                    <input
                                      required
                                      type="url"
                                      maxLength={2048}
                                      value={s.newProjectLinkUrl()}
                                      onChange={($event) => {
                                        void s.updateProjectLinkDraft(
                                          'url',
                                          $event.currentTarget.value,
                                        );
                                      }}
                                      placeholder="https://"
                                    />
                                  </label>
                                  <Button
                                    size="sm"
                                    disabled={
                                      s.creatingProjectLink() ||
                                      !s.newProjectLinkLabel().trim() ||
                                      !s.newProjectLinkUrl().trim()
                                    }
                                  >
                                    {s.creatingProjectLink() ? 'Adding' : 'Add link'}
                                  </Button>
                                </form>
                                <section
                                  className="project-edit"
                                  aria-label="Link GitHub repository"
                                >
                                  <p className="hint">
                                    Link a repository explicitly. The link is saved with this Linear
                                    project and follows it across connected devices.
                                  </p>
                                  {s.githubRepositoriesForLink() === null ? (
                                    <>
                                      <Button
                                        size="sm"
                                        variant="outline"
                                        disabled={s.loadingGithubRepositories()}
                                        onClick={() => {
                                          void s.loadGithubRepositoriesForLink();
                                        }}
                                      >
                                        {s.loadingGithubRepositories()
                                          ? 'Loading repositories'
                                          : 'Choose GitHub repository'}
                                      </Button>
                                    </>
                                  ) : s.availableGithubRepositories().length ? (
                                    <>
                                      <form
                                        onSubmit={($event) => {
                                          void s.linkGithubRepository($event.nativeEvent);
                                        }}
                                      >
                                        <label>
                                          <span>GitHub repository</span>
                                          <select
                                            value={s.selectedGithubRepository()}
                                            onChange={($event) => {
                                              void s.selectedGithubRepository.set(
                                                $event.currentTarget.value,
                                              );
                                            }}
                                          >
                                            <option value="">Choose repository</option>
                                            {s.availableGithubRepositories().map((repository) => {
                                              return (
                                                <Fragment key={repository.fullName}>
                                                  <option value={repository.fullName}>
                                                    {repository.fullName}
                                                  </option>
                                                </Fragment>
                                              );
                                            })}
                                          </select>
                                        </label>
                                        <div className="issue-actions">
                                          <Button
                                            size="sm"
                                            disabled={
                                              s.creatingGithubProjectLink() ||
                                              !s.selectedGithubRepository()
                                            }
                                          >
                                            {s.creatingGithubProjectLink()
                                              ? 'Linking'
                                              : 'Link repository'}
                                          </Button>
                                          <Button
                                            size="sm"
                                            variant="link"
                                            type="button"
                                            onClick={() => {
                                              void s.githubRepositoriesForLink.set(null);
                                            }}
                                          >
                                            Cancel
                                          </Button>
                                        </div>
                                      </form>
                                    </>
                                  ) : (
                                    <>
                                      <p className="hint">
                                        No unlinked GitHub repositories are available.
                                      </p>
                                      <Button
                                        size="sm"
                                        variant="link"
                                        onClick={() => {
                                          void s.githubRepositoriesForLink.set(null);
                                        }}
                                      >
                                        Close
                                      </Button>
                                    </>
                                  )}
                                </section>
                              </>
                            ) : null}
                          </section>
                          <section className="milestones" aria-label="Project milestones">
                            <h3>Milestones</h3>
                            {s.milestones().length === 0 ? (
                              <>
                                <p className="hint">No milestones yet.</p>
                              </>
                            ) : (
                              s.milestones().map((milestone) => {
                                return (
                                  <Fragment key={milestone.id}>
                                    <article className="issue">
                                      <strong>{milestone.name}</strong>
                                      {milestone.targetDate ? (
                                        <>
                                          <span className="muted">
                                            Target {milestone.targetDate}
                                          </span>
                                        </>
                                      ) : null}
                                      {milestone.description ? (
                                        <>
                                          <span>{milestone.description}</span>
                                        </>
                                      ) : null}
                                      <Button
                                        size="sm"
                                        variant="link"
                                        disabled={s.loadingMilestoneId() === milestone.id}
                                        onClick={() => {
                                          void s.editMilestone(milestone);
                                        }}
                                      >
                                        {s.loadingMilestoneId() === milestone.id
                                          ? 'Checking'
                                          : 'Edit'}
                                      </Button>
                                      {s.confirmDeleteMilestoneId() === milestone.id ? (
                                        <>
                                          <div
                                            className="issue-actions"
                                            role="group"
                                            aria-label="Confirm milestone deletion"
                                          >
                                            <span className="muted">
                                              Remove this milestone and its issue grouping?
                                            </span>
                                            <Button
                                              size="sm"
                                              variant="destructive"
                                              type="button"
                                              disabled={s.deletingMilestoneId() === milestone.id}
                                              onClick={() => {
                                                void s.deleteMilestone(milestone);
                                              }}
                                            >
                                              {s.deletingMilestoneId() === milestone.id
                                                ? 'Deleting'
                                                : 'Confirm delete'}
                                            </Button>
                                            <Button
                                              size="sm"
                                              variant="link"
                                              type="button"
                                              onClick={() => {
                                                void s.confirmDeleteMilestoneId.set(null);
                                              }}
                                            >
                                              Cancel
                                            </Button>
                                          </div>
                                        </>
                                      ) : (
                                        <>
                                          <Button
                                            size="sm"
                                            variant="link"
                                            type="button"
                                            onClick={() => {
                                              void s.confirmDeleteMilestoneId.set(milestone.id);
                                            }}
                                          >
                                            Delete
                                          </Button>
                                        </>
                                      )}
                                    </article>
                                    {s.editingMilestoneId() === milestone.id ? (
                                      <>
                                        <form
                                          className="project-edit"
                                          onSubmit={($event) => {
                                            void s.saveMilestone($event.nativeEvent, milestone);
                                          }}
                                        >
                                          <label>
                                            <span>Milestone name</span>
                                            <input
                                              required
                                              maxLength={255}
                                              disabled={s.savingMilestone()}
                                              value={s.editMilestoneName()}
                                              onChange={($event) => {
                                                void s.updateMilestoneEditDraft(
                                                  milestone,
                                                  'name',
                                                  $event.currentTarget.value,
                                                );
                                              }}
                                            />
                                          </label>
                                          <label>
                                            <span>Target date</span>
                                            <input
                                              type="date"
                                              disabled={s.savingMilestone()}
                                              value={s.editMilestoneDate()}
                                              onChange={($event) => {
                                                void s.updateMilestoneEditDraft(
                                                  milestone,
                                                  'targetDate',
                                                  $event.currentTarget.value,
                                                );
                                              }}
                                            />
                                          </label>
                                          <label>
                                            <span>Description</span>
                                            <textarea
                                              rows={2}
                                              disabled={s.savingMilestone()}
                                              value={s.editMilestoneDescription()}
                                              onChange={($event) => {
                                                void s.updateMilestoneEditDraft(
                                                  milestone,
                                                  'description',
                                                  $event.currentTarget.value,
                                                );
                                              }}
                                            />
                                          </label>
                                          {s.milestoneEditDraftConflict() ? (
                                            <>
                                              <div className="issue-conflicts" role="alert">
                                                <span>
                                                  This milestone draft overlaps newer changes in
                                                  Linear.
                                                </span>
                                                <Button
                                                  size="sm"
                                                  variant="outline"
                                                  type="button"
                                                  onClick={() => {
                                                    void s.resolveMilestoneEditDraftConflict(
                                                      milestone,
                                                      true,
                                                    );
                                                  }}
                                                >
                                                  Keep draft
                                                </Button>
                                                <Button
                                                  size="sm"
                                                  variant="outline"
                                                  type="button"
                                                  onClick={() => {
                                                    void s.resolveMilestoneEditDraftConflict(
                                                      milestone,
                                                      false,
                                                    );
                                                  }}
                                                >
                                                  Use Linear's version
                                                </Button>
                                              </div>
                                            </>
                                          ) : s.hasMilestoneEditDraft() ? (
                                            <>
                                              <p className="hint">
                                                Milestone draft saved on this device.
                                              </p>
                                            </>
                                          ) : null}
                                          <Button
                                            size="sm"
                                            disabled={
                                              s.savingMilestone() ||
                                              s.milestoneEditDraftConflict() ||
                                              !s.editMilestoneName().trim()
                                            }
                                          >
                                            {s.savingMilestone() ? 'Saving' : 'Save milestone'}
                                          </Button>
                                        </form>
                                      </>
                                    ) : null}
                                  </Fragment>
                                );
                              })
                            )}
                            {s.hasProjectPlanningDraft() ? (
                              <>
                                <p className="hint">
                                  Project update and milestone drafts are saved on this device.
                                </p>
                              </>
                            ) : null}
                            <form
                              className="project-edit"
                              onSubmit={($event) => {
                                void s.createMilestone($event.nativeEvent);
                              }}
                            >
                              <label>
                                <span>Milestone name</span>
                                <input
                                  required
                                  maxLength={255}
                                  value={s.newMilestoneName()}
                                  onChange={($event) => {
                                    void s.updateProjectPlanningDraft(
                                      'milestoneName',
                                      $event.currentTarget.value,
                                    );
                                  }}
                                />
                              </label>
                              <label>
                                <span>Target date</span>
                                <input
                                  type="date"
                                  value={s.newMilestoneDate()}
                                  onChange={($event) => {
                                    void s.updateProjectPlanningDraft(
                                      'milestoneDate',
                                      $event.currentTarget.value,
                                    );
                                  }}
                                />
                              </label>
                              <label>
                                <span>Description</span>
                                <textarea
                                  rows={2}
                                  value={s.newMilestoneDescription()}
                                  onChange={($event) => {
                                    void s.updateProjectPlanningDraft(
                                      'milestoneDescription',
                                      $event.currentTarget.value,
                                    );
                                  }}
                                />
                              </label>
                              <Button
                                size="sm"
                                disabled={s.creatingMilestone() || !s.newMilestoneName().trim()}
                              >
                                {s.creatingMilestone() ? 'Creating' : 'Add milestone'}
                              </Button>
                            </form>
                          </section>
                          <section className="milestones" aria-label="Project status updates">
                            <div className="issue-actions">
                              <h3>Status updates</h3>
                              <Button
                                size="sm"
                                variant="link"
                                type="button"
                                onClick={() => {
                                  void s.toggleArchivedProjectUpdates();
                                }}
                              >
                                {s.includeArchivedProjectUpdates()
                                  ? 'Hide archived'
                                  : 'Include archived'}
                              </Button>
                            </div>
                            {s.projectUpdates().length === 0 ? (
                              <>
                                <p className="hint">No status updates yet.</p>
                              </>
                            ) : (
                              s.projectUpdates().map((update) => {
                                return (
                                  <Fragment key={update.id}>
                                    <article className="issue">
                                      <strong>{s.projectHealthLabel(update.health)}</strong>
                                      <span className="muted">
                                        {update.user.name} · {s.projectUpdateDate(update.createdAt)}
                                      </span>
                                      <p>{update.body}</p>
                                      {update.archivedAt ? (
                                        <>
                                          <span className="muted">Archived</span>
                                        </>
                                      ) : null}
                                      {!s.selectedProject()!.archivedAt ? (
                                        <>
                                          {update.archivedAt ? (
                                            <>
                                              <Button
                                                size="sm"
                                                variant="link"
                                                type="button"
                                                disabled={s.busyProjectUpdateId() === update.id}
                                                onClick={() => {
                                                  void s.setProjectUpdateArchived(update, false);
                                                }}
                                              >
                                                {s.busyProjectUpdateId() === update.id
                                                  ? 'Restoring'
                                                  : 'Restore'}
                                              </Button>
                                            </>
                                          ) : (
                                            <>
                                              <Button
                                                size="sm"
                                                variant="link"
                                                type="button"
                                                onClick={() => {
                                                  void s.editProjectUpdate(update);
                                                }}
                                              >
                                                Edit update
                                              </Button>
                                              <Button
                                                size="sm"
                                                variant="link"
                                                type="button"
                                                disabled={s.busyProjectUpdateId() === update.id}
                                                onClick={() => {
                                                  void s.setProjectUpdateArchived(update, true);
                                                }}
                                              >
                                                {s.busyProjectUpdateId() === update.id
                                                  ? 'Archiving'
                                                  : s.confirmArchiveProjectUpdateId() === update.id
                                                    ? 'Confirm archive'
                                                    : 'Archive'}
                                              </Button>
                                              {s.confirmArchiveProjectUpdateId() === update.id ? (
                                                <>
                                                  <Button
                                                    size="sm"
                                                    variant="link"
                                                    type="button"
                                                    onClick={() => {
                                                      void s.confirmArchiveProjectUpdateId.set(
                                                        null,
                                                      );
                                                    }}
                                                  >
                                                    Cancel
                                                  </Button>
                                                </>
                                              ) : null}
                                            </>
                                          )}
                                        </>
                                      ) : null}
                                    </article>
                                    {s.editingProjectUpdateId() === update.id ? (
                                      <>
                                        <form
                                          className="project-edit"
                                          onSubmit={($event) => {
                                            void s.saveProjectUpdate($event.nativeEvent, update);
                                          }}
                                        >
                                          <label>
                                            <span>Health</span>
                                            <select
                                              value={s.editProjectUpdateHealth()}
                                              onChange={($event) => {
                                                void s.updateProjectUpdateEdit(
                                                  'health',
                                                  $event.currentTarget.value,
                                                );
                                              }}
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
                                              maxLength={10000}
                                              rows={3}
                                              value={s.editProjectUpdateBody()}
                                              onChange={($event) => {
                                                void s.updateProjectUpdateEdit(
                                                  'body',
                                                  $event.currentTarget.value,
                                                );
                                              }}
                                            />
                                          </label>
                                          {s.projectUpdateEditDraftConflict() ? (
                                            <>
                                              <div className="issue-conflicts" role="alert">
                                                <span>
                                                  This project update draft overlaps newer changes
                                                  in Linear.
                                                </span>
                                                <Button
                                                  size="sm"
                                                  variant="outline"
                                                  type="button"
                                                  onClick={() => {
                                                    void s.resolveProjectUpdateEditDraftConflict(
                                                      update,
                                                      true,
                                                    );
                                                  }}
                                                >
                                                  Keep draft
                                                </Button>
                                                <Button
                                                  size="sm"
                                                  variant="outline"
                                                  type="button"
                                                  onClick={() => {
                                                    void s.resolveProjectUpdateEditDraftConflict(
                                                      update,
                                                      false,
                                                    );
                                                  }}
                                                >
                                                  Use Linear's version
                                                </Button>
                                              </div>
                                            </>
                                          ) : s.hasProjectUpdateEditDraft() ? (
                                            <>
                                              <p className="hint">
                                                Project update draft saved on this device.
                                              </p>
                                            </>
                                          ) : null}
                                          <div className="issue-actions">
                                            <Button
                                              size="sm"
                                              disabled={
                                                s.savingProjectUpdate() ||
                                                s.projectUpdateEditDraftConflict() ||
                                                !s.editProjectUpdateBody().trim()
                                              }
                                            >
                                              {s.savingProjectUpdate() ? 'Saving' : 'Save update'}
                                            </Button>
                                            <Button
                                              size="sm"
                                              variant="link"
                                              type="button"
                                              onClick={() => {
                                                void s.editingProjectUpdateId.set(null);
                                              }}
                                            >
                                              Cancel
                                            </Button>
                                          </div>
                                        </form>
                                      </>
                                    ) : null}
                                  </Fragment>
                                );
                              })
                            )}
                            {!s.selectedProject()!.archivedAt ? (
                              <>
                                <form
                                  className="project-edit"
                                  onSubmit={($event) => {
                                    void s.createProjectUpdate($event.nativeEvent);
                                  }}
                                >
                                  <label>
                                    <span>Health</span>
                                    <select
                                      value={s.newProjectUpdateHealth()}
                                      onChange={($event) => {
                                        void s.updateProjectPlanningDraft(
                                          'projectUpdateHealth',
                                          $event.currentTarget.value,
                                        );
                                      }}
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
                                      maxLength={10000}
                                      rows={3}
                                      value={s.newProjectUpdateBody()}
                                      onChange={($event) => {
                                        void s.updateProjectPlanningDraft(
                                          'projectUpdateBody',
                                          $event.currentTarget.value,
                                        );
                                      }}
                                    />
                                  </label>
                                  <Button
                                    size="sm"
                                    disabled={
                                      s.creatingProjectUpdate() || !s.newProjectUpdateBody().trim()
                                    }
                                  >
                                    {s.creatingProjectUpdate() ? 'Posting' : 'Post update'}
                                  </Button>
                                </form>
                              </>
                            ) : null}
                          </section>
                          <div className="issue-heading">
                            <h3>Issues</h3>
                            <Button
                              size="sm"
                              variant="link"
                              disabled={s.loadingProjectIssues()}
                              onClick={() => {
                                void s.toggleArchivedProjectIssues();
                              }}
                            >
                              {s.includeArchivedProjectIssues()
                                ? 'Hide archived'
                                : 'Include archived'}
                            </Button>
                          </div>
                          {s.projectIssueCacheStale() ? (
                            <>
                              <p className="hint" role="status">
                                Linear is unavailable. Showing saved issues for these project
                                filters.
                              </p>
                            </>
                          ) : null}
                          <form
                            className="issue-actions"
                            role="search"
                            onSubmit={($event) => {
                              void s.searchProjectIssues($event.nativeEvent);
                            }}
                          >
                            <label>
                              <span className="sr-only">Search project issue titles</span>
                              <input
                                type="search"
                                maxLength={255}
                                value={s.projectIssueSearchInput()}
                                disabled={s.loadingProjectIssues()}
                                onChange={($event) => {
                                  void s.projectIssueSearchInput.set($event.currentTarget.value);
                                }}
                                placeholder="Search project issues"
                              />
                            </label>
                            <Button size="sm" disabled={s.loadingProjectIssues()}>
                              {s.loadingProjectIssues() ? 'Searching' : 'Search'}
                            </Button>
                            {s.projectIssueSearchTerm() ? (
                              <>
                                <Button
                                  size="sm"
                                  variant="link"
                                  type="button"
                                  disabled={s.loadingProjectIssues()}
                                  onClick={() => {
                                    void s.clearProjectIssueSearch();
                                  }}
                                >
                                  Clear
                                </Button>
                              </>
                            ) : null}
                            <details className="issue-filters">
                              <summary>
                                Filters
                                {s.projectIssueFilterCount()
                                  ? ' · ' + s.projectIssueFilterCount()
                                  : ''}
                              </summary>
                              <label>
                                <span>Status</span>
                                <select
                                  value={s.projectIssueStateId()}
                                  disabled={s.loadingProjectIssues()}
                                  onChange={($event) => {
                                    void s.setProjectIssueStateFilter($event.currentTarget.value);
                                  }}
                                >
                                  <option value="">Any status</option>
                                  {s.teams().map((team) => {
                                    return (
                                      <Fragment key={team.id}>
                                        {s.statesForTeam(team.id).map((state) => {
                                          return (
                                            <Fragment key={state.id}>
                                              <option value={state.id}>
                                                {team.name} · {state.name}
                                              </option>
                                            </Fragment>
                                          );
                                        })}
                                      </Fragment>
                                    );
                                  })}
                                </select>
                              </label>
                              <label>
                                <span>Priority</span>
                                <select
                                  value={s.projectIssuePriority()}
                                  disabled={s.loadingProjectIssues()}
                                  onChange={($event) => {
                                    void s.setProjectIssuePriorityFilter(
                                      $event.currentTarget.value,
                                    );
                                  }}
                                >
                                  <option value="">Any priority</option>
                                  <option value="0">No priority</option>
                                  <option value="1">Urgent</option>
                                  <option value="2">High</option>
                                  <option value="3">Normal</option>
                                  <option value="4">Low</option>
                                </select>
                              </label>
                              <label>
                                <span>Assignee</span>
                                <select
                                  value={s.projectIssueAssigneeId()}
                                  disabled={s.loadingProjectIssues()}
                                  onChange={($event) => {
                                    void s.setProjectIssueAssigneeFilter(
                                      $event.currentTarget.value,
                                    );
                                  }}
                                >
                                  <option value="">Anyone</option>
                                  <option value="unassigned">Unassigned</option>
                                  {s.users().map((user) => {
                                    return (
                                      <Fragment key={user.id}>
                                        <option value={user.id}>{user.name}</option>
                                      </Fragment>
                                    );
                                  })}
                                </select>
                              </label>
                              <label>
                                <span>Label</span>
                                <select
                                  value={s.projectIssueLabelId()}
                                  disabled={s.loadingProjectIssues()}
                                  onChange={($event) => {
                                    void s.setProjectIssueLabelFilter($event.currentTarget.value);
                                  }}
                                >
                                  <option value="">Any label</option>
                                  {s.labels().map((label) => {
                                    return (
                                      <Fragment key={label.id}>
                                        <option value={label.id}>{label.name}</option>
                                      </Fragment>
                                    );
                                  })}
                                </select>
                              </label>
                            </details>
                          </form>
                          {(s.selectedProject()?.teams ?? []).length ? (
                            <>
                              <form
                                className="create-form"
                                onSubmit={($event) => {
                                  void s.createProjectIssue($event.nativeEvent);
                                }}
                              >
                                <label>
                                  <span>Team</span>
                                  <select
                                    value={s.createTeamId()}
                                    onChange={($event) => {
                                      void s.setCreateTeam($event.currentTarget.value);
                                    }}
                                  >
                                    {(s.selectedProject()?.teams ?? []).map((team) => {
                                      return (
                                        <Fragment key={team.id}>
                                          <option value={team.id}>{team.name}</option>
                                        </Fragment>
                                      );
                                    })}
                                  </select>
                                </label>
                                {s.estimateOptions(s.createTeamId()).length ? (
                                  <>
                                    <label>
                                      <span>Estimate</span>
                                      <select
                                        value={s.newProjectIssueEstimate()}
                                        onChange={($event) => {
                                          void s.updateProjectIssueEstimate(
                                            $event.currentTarget.value,
                                          );
                                        }}
                                      >
                                        <option value="">No estimate</option>
                                        {s.estimateOptions(s.createTeamId()).map((option) => {
                                          return (
                                            <Fragment key={option.value}>
                                              <option value={option.value}>{option.label}</option>
                                            </Fragment>
                                          );
                                        })}
                                      </select>
                                    </label>
                                  </>
                                ) : null}
                                <details className="issue-create-options">
                                  <summary>More fields</summary>
                                  <label>
                                    <span>Status</span>
                                    <select
                                      value={s.newProjectIssueStateId()}
                                      onChange={($event) => {
                                        void s.updateProjectIssueState($event.currentTarget.value);
                                      }}
                                    >
                                      <option value="">Team default</option>
                                      {s.statesForTeam(s.createTeamId()).map((state) => {
                                        return (
                                          <Fragment key={state.id}>
                                            <option value={state.id}>{state.name}</option>
                                          </Fragment>
                                        );
                                      })}
                                    </select>
                                  </label>
                                  <label>
                                    <span>Cycle</span>
                                    <select
                                      value={s.newProjectIssueCycleId()}
                                      onChange={($event) => {
                                        void s.updateProjectIssueCycle($event.currentTarget.value);
                                      }}
                                    >
                                      <option value="">No cycle</option>
                                      {s.cyclesFor(s.createTeamId()).map((cycle) => {
                                        return (
                                          <Fragment key={cycle.id}>
                                            <option value={cycle.id}>
                                              {cycle.name || 'Cycle ' + cycle.number}
                                            </option>
                                          </Fragment>
                                        );
                                      })}
                                    </select>
                                  </label>
                                  <label>
                                    <span>Priority</span>
                                    <select
                                      value={s.newProjectIssuePriority()}
                                      onChange={($event) => {
                                        void s.updateProjectIssuePriority(
                                          $event.currentTarget.value,
                                        );
                                      }}
                                    >
                                      <option value="">No priority</option>
                                      <option value="1">Urgent</option>
                                      <option value="2">High</option>
                                      <option value="3">Normal</option>
                                      <option value="4">Low</option>
                                    </select>
                                  </label>
                                  <label>
                                    <span>Assignee</span>
                                    <select
                                      value={s.newProjectIssueAssigneeId()}
                                      onChange={($event) => {
                                        void s.updateProjectIssueAssignee(
                                          $event.currentTarget.value,
                                        );
                                      }}
                                    >
                                      <option value="">Me</option>
                                      {s.users().map((user) => {
                                        return (
                                          <Fragment key={user.id}>
                                            <option value={user.id}>{user.name}</option>
                                          </Fragment>
                                        );
                                      })}
                                    </select>
                                  </label>
                                  <label>
                                    <span>Due date</span>
                                    <input
                                      type="date"
                                      value={s.newProjectIssueDueDate()}
                                      onChange={($event) => {
                                        void s.updateProjectIssueDueDate(
                                          $event.currentTarget.value,
                                        );
                                      }}
                                    />
                                  </label>
                                  {s.labelsFor(s.createTeamId()).length ? (
                                    <>
                                      <label>
                                        <span>Labels</span>
                                        <select
                                          multiple
                                          size={3}
                                          onChange={($event) => {
                                            void s.updateProjectIssueLabels($event.nativeEvent);
                                          }}
                                        >
                                          {s.labelsFor(s.createTeamId()).map((label) => {
                                            return (
                                              <Fragment key={label.id}>
                                                <option
                                                  value={label.id}
                                                  selected={s
                                                    .newProjectIssueLabelIds()
                                                    .includes(label.id)}
                                                >
                                                  {label.name}
                                                </option>
                                              </Fragment>
                                            );
                                          })}
                                        </select>
                                      </label>
                                    </>
                                  ) : null}
                                </details>
                                <label>
                                  <span>New project issue</span>
                                  <input
                                    required
                                    maxLength={255}
                                    value={s.newProjectIssueTitle()}
                                    onChange={($event) => {
                                      void s.updateProjectIssueDraft(
                                        'title',
                                        $event.currentTarget.value,
                                      );
                                    }}
                                    placeholder="Issue title"
                                  />
                                </label>
                                <label>
                                  <span>Milestone</span>
                                  <select
                                    value={s.newProjectIssueMilestoneId()}
                                    onChange={($event) => {
                                      void s.updateProjectIssueMilestone(
                                        $event.currentTarget.value,
                                      );
                                    }}
                                  >
                                    <option value="">No milestone</option>
                                    {s.milestones().map((milestone) => {
                                      return (
                                        <Fragment key={milestone.id}>
                                          <option value={milestone.id}>{milestone.name}</option>
                                        </Fragment>
                                      );
                                    })}
                                  </select>
                                </label>
                                <label className="description-field">
                                  <span>Description</span>
                                  <textarea
                                    rows={2}
                                    value={s.newProjectIssueDescription()}
                                    onChange={($event) => {
                                      void s.updateProjectIssueDraft(
                                        'description',
                                        $event.currentTarget.value,
                                      );
                                    }}
                                  />
                                </label>
                                <Button
                                  size="sm"
                                  disabled={
                                    s.creatingProjectIssue() || !s.newProjectIssueTitle().trim()
                                  }
                                >
                                  {s.creatingProjectIssue() ? 'Creating' : 'Add issue'}
                                </Button>
                              </form>
                              {s.newProjectIssueTitle() ||
                              s.newProjectIssueDescription() ||
                              s.newProjectIssueEstimate() ||
                              s.newProjectIssueAssigneeId() ||
                              s.newProjectIssuePriority() ||
                              s.newProjectIssueDueDate() ||
                              s.newProjectIssueLabelIds().length ||
                              s.newProjectIssueStateId() ||
                              s.newProjectIssueCycleId() ? (
                                <>
                                  <p className="hint">Draft saved on this device.</p>
                                </>
                              ) : null}
                            </>
                          ) : null}
                          {s.projectIssues().length === 0 ? (
                            <>
                              <p className="hint">
                                {s.projectIssueSearchTerm()
                                  ? 'No project issues match your search.'
                                  : 'No issues are linked to this project.'}
                              </p>
                            </>
                          ) : (
                            s.projectIssues().map((issue) => {
                              return (
                                <Fragment key={issue.id}>
                                  <article className="issue">
                                    <button
                                      className="issue-link"
                                      type="button"
                                      onClick={() => {
                                        void s.openIssue(issue.url);
                                      }}
                                    >
                                      {issue.identifier}
                                    </button>
                                    <button
                                      className="issue-title"
                                      type="button"
                                      onClick={() => {
                                        void s.openIssueDetail(issue);
                                      }}
                                    >
                                      {issue.title}
                                    </button>
                                    <div className="issue-actions">
                                      {issue.archivedAt ? (
                                        <>
                                          <span className="hint">Archived</span>
                                          <Button
                                            size="sm"
                                            variant="outline"
                                            disabled={!!s.archivingIssueId()}
                                            onClick={() => {
                                              void s.setIssueArchived(issue, false);
                                            }}
                                          >
                                            {s.archivingIssueId() === issue.id
                                              ? 'Restoring'
                                              : 'Restore'}
                                          </Button>
                                        </>
                                      ) : (
                                        <>
                                          <label className="status-control">
                                            <span className="sr-only">
                                              Status for {issue.identifier}
                                            </span>
                                            <select
                                              value={issue.state?.id ?? ''}
                                              onChange={($event) => {
                                                void s.updateStatus(
                                                  issue,
                                                  $event.currentTarget.value,
                                                );
                                              }}
                                            >
                                              {s.statesFor(issue).map((state) => {
                                                return (
                                                  <Fragment key={state.id}>
                                                    <option value={state.id}>{state.name}</option>
                                                  </Fragment>
                                                );
                                              })}
                                            </select>
                                          </label>
                                          {s.confirmArchiveIssueId() === issue.id ? (
                                            <>
                                              <Button
                                                size="sm"
                                                variant="outline"
                                                disabled={!!s.archivingIssueId()}
                                                onClick={() => {
                                                  void s.setIssueArchived(issue, true);
                                                }}
                                              >
                                                {s.archivingIssueId() === issue.id
                                                  ? 'Archiving'
                                                  : 'Confirm archive'}
                                              </Button>
                                              <Button
                                                size="sm"
                                                variant="link"
                                                type="button"
                                                onClick={() => {
                                                  void s.confirmArchiveIssueId.set(null);
                                                }}
                                              >
                                                Cancel
                                              </Button>
                                            </>
                                          ) : (
                                            <>
                                              <Button
                                                size="sm"
                                                variant="link"
                                                onClick={() => {
                                                  void s.confirmArchiveIssueId.set(issue.id);
                                                }}
                                              >
                                                Archive
                                              </Button>
                                            </>
                                          )}
                                        </>
                                      )}
                                    </div>
                                  </article>
                                </Fragment>
                              );
                            })
                          )}
                          {s.projectIssuesHasNextPage() ? (
                            <>
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={s.loadingProjectIssues()}
                                onClick={() => {
                                  void s.loadMoreProjectIssues();
                                }}
                              >
                                {s.loadingProjectIssues() ? 'Loading' : 'Load more issues'}
                              </Button>
                            </>
                          ) : null}
                        </>
                      ) : (
                        <>
                          {s.createProjectOpen() ? (
                            <>
                              {s.newProjectName() ||
                              s.newProjectDescription() ||
                              s.newProjectStartDate() ||
                              s.newProjectTargetDate() ||
                              s.newProjectStatusId() ||
                              s.newProjectLeadId() ||
                              s.newProjectTeamIds().length ? (
                                <>
                                  <p className="hint">Project draft saved on this device.</p>
                                </>
                              ) : null}
                              <form
                                className="create-form"
                                onSubmit={($event) => {
                                  void s.createProject($event.nativeEvent);
                                }}
                              >
                                <fieldset className="project-teams">
                                  <legend>Project teams</legend>
                                  {s.teams().map((team) => {
                                    return (
                                      <Fragment key={team.id}>
                                        <label>
                                          <input
                                            type="checkbox"
                                            checked={s.newProjectTeamIds().includes(team.id)}
                                            onChange={($event) => {
                                              void s.toggleProjectTeam(
                                                'create',
                                                team.id,
                                                $event.nativeEvent,
                                              );
                                            }}
                                          />
                                          {team.name}
                                        </label>
                                      </Fragment>
                                    );
                                  })}
                                </fieldset>
                                <label>
                                  <span>Project name</span>
                                  <input
                                    required
                                    maxLength={255}
                                    value={s.newProjectName()}
                                    onChange={($event) => {
                                      void s.updateProjectDraft('name', $event.currentTarget.value);
                                    }}
                                  />
                                </label>
                                <label className="description-field">
                                  <span>Description</span>
                                  <textarea
                                    rows={2}
                                    value={s.newProjectDescription()}
                                    onChange={($event) => {
                                      void s.updateProjectDraft(
                                        'description',
                                        $event.currentTarget.value,
                                      );
                                    }}
                                  />
                                </label>
                                <label>
                                  <span>Start date</span>
                                  <input
                                    type="date"
                                    value={s.newProjectStartDate()}
                                    onChange={($event) => {
                                      void s.updateProjectDraft(
                                        'startDate',
                                        $event.currentTarget.value,
                                      );
                                    }}
                                  />
                                </label>
                                <label>
                                  <span>Target date</span>
                                  <input
                                    type="date"
                                    value={s.newProjectTargetDate()}
                                    onChange={($event) => {
                                      void s.updateProjectDraft(
                                        'targetDate',
                                        $event.currentTarget.value,
                                      );
                                    }}
                                  />
                                </label>
                                <label>
                                  <span>Status</span>
                                  <select
                                    value={s.newProjectStatusId()}
                                    onChange={($event) => {
                                      void s.updateProjectDraft(
                                        'statusId',
                                        $event.currentTarget.value,
                                      );
                                    }}
                                  >
                                    <option value="">Use workspace default</option>
                                    {s.projectStatuses().map((status) => {
                                      return (
                                        <Fragment key={status.id}>
                                          <option value={status.id}>{status.name}</option>
                                        </Fragment>
                                      );
                                    })}
                                  </select>
                                </label>
                                <label>
                                  <span>Project lead</span>
                                  <select
                                    value={s.newProjectLeadId()}
                                    onChange={($event) => {
                                      void s.updateProjectDraft(
                                        'leadId',
                                        $event.currentTarget.value,
                                      );
                                    }}
                                  >
                                    <option value="">No lead</option>
                                    {s.users().map((user) => {
                                      return (
                                        <Fragment key={user.id}>
                                          <option value={user.id}>{user.name}</option>
                                        </Fragment>
                                      );
                                    })}
                                  </select>
                                </label>
                                <Button
                                  size="sm"
                                  disabled={
                                    s.creatingProject() ||
                                    !s.newProjectName().trim() ||
                                    !s.newProjectTeamIds().length
                                  }
                                >
                                  {s.creatingProject() ? 'Creating' : 'Create project'}
                                </Button>
                              </form>
                            </>
                          ) : null}
                          {s.projects().length === 0 ? (
                            <>
                              <p className="hint">No projects found in this workspace.</p>
                            </>
                          ) : (
                            s.projects().map((project) => {
                              return (
                                <Fragment key={project.id}>
                                  <article className="resource-row">
                                    <div>
                                      <h3>{project.name}</h3>
                                      <p>{project.description || 'No description'}</p>
                                      <span className="muted">
                                        {project.targetDate
                                          ? 'Target ' + project.targetDate
                                          : 'No target date'}
                                      </span>
                                      <span className="muted">
                                        {project.status?.name || 'No status'}
                                      </span>
                                      {project.archivedAt ? (
                                        <>
                                          <span className="muted">Archived</span>
                                        </>
                                      ) : null}
                                      {project.lead ? (
                                        <>
                                          <span className="muted">Lead {project.lead.name}</span>
                                        </>
                                      ) : null}
                                      <span className="muted">{s.projectTeamNames(project)}</span>
                                    </div>
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      onClick={() => {
                                        void s.openProject(project);
                                      }}
                                    >
                                      View project
                                    </Button>
                                  </article>
                                </Fragment>
                              );
                            })
                          )}
                        </>
                      )}
                    </section>
                  </>
                ) : s.section() === 'cycles' ? (
                  <>
                    <section className="issues" aria-label="Linear cycles">
                      {s.teams().map((team) => {
                        return (
                          <Fragment key={team.id}>
                            <div className="issue-heading">
                              <h2 className="group-title">{team.name}</h2>
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => {
                                  void s.toggleCreateCycle(team);
                                }}
                              >
                                {s.createCycleTeamId() === team.id ? 'Cancel' : 'New cycle'}
                              </Button>
                            </div>
                            {s.createCycleTeamId() === team.id ? (
                              <>
                                <form
                                  className="project-edit"
                                  onSubmit={($event) => {
                                    void s.createCycle($event.nativeEvent, team);
                                  }}
                                >
                                  <label>
                                    <span>
                                      Cycle name <span className="muted">Optional</span>
                                    </span>
                                    <input
                                      maxLength={255}
                                      value={s.newCycleName()}
                                      onChange={($event) => {
                                        void s.updateCycleDraft(
                                          team,
                                          'name',
                                          $event.currentTarget.value,
                                        );
                                      }}
                                      placeholder="Cycle name"
                                    />
                                  </label>
                                  <label>
                                    <span>
                                      Start date · {team.timezone || 'America/Los_Angeles'}
                                    </span>
                                    <input
                                      type="date"
                                      required
                                      min={s.todayForTeam(team)}
                                      value={s.newCycleStartDate()}
                                      onChange={($event) => {
                                        void s.updateCycleDraft(
                                          team,
                                          'startsAt',
                                          $event.currentTarget.value,
                                        );
                                      }}
                                    />
                                  </label>
                                  <label>
                                    <span>End date · {team.timezone || 'America/Los_Angeles'}</span>
                                    <input
                                      type="date"
                                      required
                                      min={s.newCycleStartDate()}
                                      value={s.newCycleEndDate()}
                                      onChange={($event) => {
                                        void s.updateCycleDraft(
                                          team,
                                          'endsAt',
                                          $event.currentTarget.value,
                                        );
                                      }}
                                    />
                                  </label>
                                  <div className="issue-actions">
                                    <Button
                                      size="sm"
                                      disabled={
                                        s.creatingCycle() ||
                                        !s.newCycleStartDate() ||
                                        !s.newCycleEndDate()
                                      }
                                    >
                                      {s.creatingCycle() ? 'Creating' : 'Create cycle'}
                                    </Button>
                                    <Button
                                      size="sm"
                                      variant="link"
                                      type="button"
                                      onClick={() => {
                                        void s.toggleCreateCycle(team);
                                      }}
                                    >
                                      Cancel
                                    </Button>
                                  </div>
                                </form>
                              </>
                            ) : null}
                            {s.cyclesFor(team.id).length === 0 ? (
                              <>
                                <p className="hint">No cycles are available for this team.</p>
                              </>
                            ) : (
                              s.cyclesFor(team.id).map((cycle) => {
                                return (
                                  <Fragment key={cycle.id}>
                                    <article className="resource-row">
                                      <div>
                                        <h3>{cycle.name || 'Cycle ' + cycle.number}</h3>
                                        {cycle.description ? (
                                          <>
                                            <p>{cycle.description}</p>
                                          </>
                                        ) : null}
                                        <p>
                                          {s.cycleDateInTeam(cycle.startsAt, team)} –
                                          {s.cycleDateInTeam(cycle.endsAt, team)}
                                        </p>
                                      </div>
                                      <Button
                                        size="sm"
                                        variant="outline"
                                        onClick={() => {
                                          void s.editCycle(cycle);
                                        }}
                                      >
                                        Edit cycle
                                      </Button>
                                      {s.canEditCycle(cycle, team) ? (
                                        <>
                                          <span className="muted">
                                            {cycle.isActive ? 'Current' : 'Upcoming'}
                                          </span>
                                        </>
                                      ) : (
                                        <>
                                          <span className="muted">Past</span>
                                        </>
                                      )}
                                    </article>
                                    {s.editingCycleId() === cycle.id ? (
                                      <>
                                        <form
                                          className="project-edit"
                                          onSubmit={($event) => {
                                            void s.saveCycle($event.nativeEvent, cycle);
                                          }}
                                        >
                                          <label>
                                            <span>Cycle name</span>
                                            <input
                                              maxLength={255}
                                              value={s.editCycleName()}
                                              onChange={($event) => {
                                                void s.updateCycleEditDraft(
                                                  cycle,
                                                  'name',
                                                  $event.currentTarget.value,
                                                );
                                              }}
                                            />
                                          </label>
                                          <label>
                                            <span>Description</span>
                                            <textarea
                                              rows={2}
                                              value={s.editCycleDescription()}
                                              onChange={($event) => {
                                                void s.updateCycleEditDraft(
                                                  cycle,
                                                  'description',
                                                  $event.currentTarget.value,
                                                );
                                              }}
                                            />
                                          </label>
                                          {!cycle.isActive ? (
                                            <>
                                              {s.canEditCycle(cycle, team) ? (
                                                <>
                                                  <label>
                                                    <span>
                                                      Start date ·{' '}
                                                      {team.timezone || 'America/Los_Angeles'}
                                                    </span>
                                                    <input
                                                      type="date"
                                                      required
                                                      value={s.editCycleStartDate()}
                                                      min={s.todayForTeam(team)}
                                                      onChange={($event) => {
                                                        void s.updateCycleEditDraft(
                                                          cycle,
                                                          'startDate',
                                                          $event.currentTarget.value,
                                                        );
                                                      }}
                                                    />
                                                  </label>
                                                </>
                                              ) : null}
                                            </>
                                          ) : null}
                                          {s.canEditCycle(cycle, team) ? (
                                            <>
                                              <label>
                                                <span>
                                                  End date ·{' '}
                                                  {team.timezone || 'America/Los_Angeles'}
                                                </span>
                                                <input
                                                  type="date"
                                                  required
                                                  value={s.editCycleEndDate()}
                                                  min={
                                                    cycle.isActive
                                                      ? s.todayForTeam(team)
                                                      : s.editCycleStartDate()
                                                  }
                                                  onChange={($event) => {
                                                    void s.updateCycleEditDraft(
                                                      cycle,
                                                      'endDate',
                                                      $event.currentTarget.value,
                                                    );
                                                  }}
                                                />
                                              </label>
                                            </>
                                          ) : (
                                            <>
                                              <p className="hint">
                                                Past cycle dates cannot be changed.
                                              </p>
                                            </>
                                          )}
                                          {s.cycleEditDraftConflict() ? (
                                            <>
                                              <div className="issue-conflicts" role="alert">
                                                <span>
                                                  This cycle draft overlaps newer changes in Linear.
                                                </span>
                                                <Button
                                                  size="sm"
                                                  variant="outline"
                                                  type="button"
                                                  onClick={() => {
                                                    void s.resolveCycleEditDraftConflict(
                                                      cycle,
                                                      true,
                                                    );
                                                  }}
                                                >
                                                  Keep draft
                                                </Button>
                                                <Button
                                                  size="sm"
                                                  variant="outline"
                                                  type="button"
                                                  onClick={() => {
                                                    void s.resolveCycleEditDraftConflict(
                                                      cycle,
                                                      false,
                                                    );
                                                  }}
                                                >
                                                  Use Linear's version
                                                </Button>
                                              </div>
                                            </>
                                          ) : s.hasCycleEditDraft() ? (
                                            <>
                                              <p className="hint">
                                                Cycle draft saved on this device.
                                              </p>
                                            </>
                                          ) : null}
                                          <Button
                                            size="sm"
                                            disabled={s.savingCycle() || s.cycleEditDraftConflict()}
                                          >
                                            {s.savingCycle() ? 'Saving' : 'Save schedule'}
                                          </Button>
                                          <Button
                                            size="sm"
                                            variant="link"
                                            type="button"
                                            onClick={() => {
                                              void s.editingCycleId.set(null);
                                            }}
                                          >
                                            Cancel
                                          </Button>
                                        </form>
                                      </>
                                    ) : null}
                                  </Fragment>
                                );
                              })
                            )}
                          </Fragment>
                        );
                      })}
                    </section>
                  </>
                ) : s.section() === 'roadmap' ? (
                  <>
                    <section className="issues" aria-label="Linear roadmap initiatives">
                      <div className="issue-actions">
                        <h2>Initiatives</h2>
                        <Button
                          size="sm"
                          variant="link"
                          type="button"
                          onClick={() => {
                            void s.toggleArchivedInitiatives();
                          }}
                        >
                          {s.includeArchivedInitiatives() ? 'Hide archived' : 'Include archived'}
                        </Button>
                        <Button
                          size="sm"
                          variant="link"
                          type="button"
                          onClick={() => {
                            void s.toggleArchivedInitiativeUpdates();
                          }}
                        >
                          {s.includeArchivedInitiativeUpdates()
                            ? 'Hide archived updates'
                            : 'Include archived updates'}
                        </Button>
                      </div>
                      {s.newInitiativeName() ||
                      s.newInitiativeDescription() ||
                      s.newInitiativeTargetDate() ? (
                        <>
                          <p className="hint">Initiative draft saved on this device.</p>
                        </>
                      ) : null}
                      <form
                        className="create-form"
                        onSubmit={($event) => {
                          void s.createInitiative($event.nativeEvent);
                        }}
                      >
                        <label>
                          <span>Initiative name</span>
                          <input
                            required
                            maxLength={255}
                            value={s.newInitiativeName()}
                            onChange={($event) => {
                              void s.updateInitiativeDraft('name', $event.currentTarget.value);
                            }}
                          />
                        </label>
                        <label>
                          <span>Target date</span>
                          <input
                            type="date"
                            value={s.newInitiativeTargetDate()}
                            onChange={($event) => {
                              void s.updateInitiativeDraft(
                                'targetDate',
                                $event.currentTarget.value,
                              );
                            }}
                          />
                        </label>
                        <label className="description-field">
                          <span>Description</span>
                          <textarea
                            rows={2}
                            value={s.newInitiativeDescription()}
                            onChange={($event) => {
                              void s.updateInitiativeDraft(
                                'description',
                                $event.currentTarget.value,
                              );
                            }}
                          />
                        </label>
                        <Button
                          size="sm"
                          disabled={s.savingInitiative() || !s.newInitiativeName().trim()}
                        >
                          {s.savingInitiative() ? 'Creating' : 'Create initiative'}
                        </Button>
                      </form>
                      {s.initiatives().length === 0 ? (
                        <>
                          <p className="hint">No initiatives are available in this workspace.</p>
                        </>
                      ) : (
                        s.initiatives().map((initiative) => {
                          return (
                            <Fragment key={initiative.id}>
                              <article className="resource-row initiative-row">
                                <div>
                                  <h3>{initiative.name}</h3>
                                  <p>{initiative.description || 'No description'}</p>
                                  {initiative.archivedAt ? (
                                    <>
                                      <span className="muted">Archived</span>
                                    </>
                                  ) : null}
                                  <span className="muted">
                                    {initiative.targetDate
                                      ? 'Target ' + initiative.targetDate
                                      : 'No target date'}
                                  </span>
                                  {initiative.projects.length ? (
                                    <>
                                      <div className="initiative-projects">
                                        {initiative.projects.map((link) => {
                                          return (
                                            <Fragment key={link.id}>
                                              <div className="issue-actions">
                                                <button
                                                  className="issue-link"
                                                  type="button"
                                                  onClick={() => {
                                                    void s.openProjectById(link.project.id);
                                                  }}
                                                >
                                                  {link.project.name}
                                                </button>
                                                {!initiative.archivedAt ? (
                                                  <>
                                                    {s.confirmRemoveInitiativeProjectId() ===
                                                    link.id ? (
                                                      <>
                                                        <Button
                                                          size="sm"
                                                          variant="link"
                                                          disabled={
                                                            s.savingInitiativeProjectId() ===
                                                            initiative.id
                                                          }
                                                          onClick={() => {
                                                            void s.removeInitiativeProject(
                                                              initiative,
                                                              link.id,
                                                            );
                                                          }}
                                                        >
                                                          Confirm remove
                                                        </Button>
                                                        <Button
                                                          size="sm"
                                                          variant="link"
                                                          onClick={() => {
                                                            void s.confirmRemoveInitiativeProjectId.set(
                                                              null,
                                                            );
                                                          }}
                                                        >
                                                          Cancel
                                                        </Button>
                                                      </>
                                                    ) : (
                                                      <>
                                                        <Button
                                                          size="sm"
                                                          variant="link"
                                                          disabled={
                                                            s.savingInitiativeProjectId() ===
                                                            initiative.id
                                                          }
                                                          aria-label={
                                                            'Remove ' +
                                                            link.project.name +
                                                            ' from ' +
                                                            initiative.name
                                                          }
                                                          onClick={() => {
                                                            void s.confirmRemoveInitiativeProjectId.set(
                                                              link.id,
                                                            );
                                                          }}
                                                        >
                                                          Remove
                                                        </Button>
                                                      </>
                                                    )}
                                                  </>
                                                ) : null}
                                              </div>
                                            </Fragment>
                                          );
                                        })}
                                      </div>
                                    </>
                                  ) : null}
                                  {initiative.updates.length ? (
                                    <>
                                      <div
                                        className="project-updates"
                                        aria-label="Initiative status updates"
                                      >
                                        {initiative.updates.map((update) => {
                                          return (
                                            <Fragment key={update.id}>
                                              {s.includeArchivedInitiativeUpdates() ||
                                              !update.archivedAt ? (
                                                <>
                                                  <article className="project-update">
                                                    <div>
                                                      <strong>
                                                        {s.projectHealthLabel(update.health)}
                                                      </strong>
                                                      <span className="muted">
                                                        {update.user.name} ·
                                                        {s.projectUpdateDate(update.createdAt)}
                                                      </span>
                                                    </div>
                                                    <p>{update.body}</p>
                                                    {update.archivedAt ? (
                                                      <>
                                                        <span className="muted">Archived</span>
                                                      </>
                                                    ) : null}
                                                    {!initiative.archivedAt ? (
                                                      <>
                                                        {update.archivedAt ? (
                                                          <>
                                                            <Button
                                                              size="sm"
                                                              variant="link"
                                                              type="button"
                                                              disabled={
                                                                s.busyInitiativeUpdateId() ===
                                                                update.id
                                                              }
                                                              onClick={() => {
                                                                void s.setInitiativeUpdateArchived(
                                                                  update,
                                                                  false,
                                                                );
                                                              }}
                                                            >
                                                              {s.busyInitiativeUpdateId() ===
                                                              update.id
                                                                ? 'Restoring'
                                                                : 'Restore'}
                                                            </Button>
                                                          </>
                                                        ) : (
                                                          <>
                                                            <Button
                                                              size="sm"
                                                              variant="link"
                                                              type="button"
                                                              onClick={() => {
                                                                void s.editInitiativeUpdate(update);
                                                              }}
                                                            >
                                                              Edit update
                                                            </Button>
                                                            <Button
                                                              size="sm"
                                                              variant="link"
                                                              type="button"
                                                              disabled={
                                                                s.busyInitiativeUpdateId() ===
                                                                update.id
                                                              }
                                                              onClick={() => {
                                                                void s.setInitiativeUpdateArchived(
                                                                  update,
                                                                  true,
                                                                );
                                                              }}
                                                            >
                                                              {s.busyInitiativeUpdateId() ===
                                                              update.id
                                                                ? 'Archiving'
                                                                : s.confirmArchiveInitiativeUpdateId() ===
                                                                    update.id
                                                                  ? 'Confirm archive'
                                                                  : 'Archive'}
                                                            </Button>
                                                            {s.confirmArchiveInitiativeUpdateId() ===
                                                            update.id ? (
                                                              <>
                                                                <Button
                                                                  size="sm"
                                                                  variant="link"
                                                                  type="button"
                                                                  onClick={() => {
                                                                    void s.confirmArchiveInitiativeUpdateId.set(
                                                                      null,
                                                                    );
                                                                  }}
                                                                >
                                                                  Cancel
                                                                </Button>
                                                              </>
                                                            ) : null}
                                                          </>
                                                        )}
                                                      </>
                                                    ) : null}
                                                  </article>
                                                  {s.editingInitiativeUpdateId() === update.id ? (
                                                    <>
                                                      <form
                                                        className="project-edit"
                                                        onSubmit={($event) => {
                                                          void s.saveInitiativeUpdate(
                                                            $event.nativeEvent,
                                                            update,
                                                          );
                                                        }}
                                                      >
                                                        <label>
                                                          <span>Health</span>
                                                          <select
                                                            value={s.editInitiativeUpdateHealth()}
                                                            onChange={($event) => {
                                                              void s.updateInitiativeUpdateEdit(
                                                                'health',
                                                                $event.currentTarget.value,
                                                              );
                                                            }}
                                                          >
                                                            <option value="onTrack">
                                                              On track
                                                            </option>
                                                            <option value="atRisk">At risk</option>
                                                            <option value="offTrack">
                                                              Off track
                                                            </option>
                                                          </select>
                                                        </label>
                                                        <label>
                                                          <span>Update</span>
                                                          <textarea
                                                            required
                                                            maxLength={10000}
                                                            rows={3}
                                                            value={s.editInitiativeUpdateBody()}
                                                            onChange={($event) => {
                                                              void s.updateInitiativeUpdateEdit(
                                                                'body',
                                                                $event.currentTarget.value,
                                                              );
                                                            }}
                                                          />
                                                        </label>
                                                        {s.initiativeUpdateEditDraftConflict() ? (
                                                          <>
                                                            <div
                                                              className="issue-conflicts"
                                                              role="alert"
                                                            >
                                                              <span>
                                                                This initiative update draft
                                                                overlaps newer changes in Linear.
                                                              </span>
                                                              <Button
                                                                size="sm"
                                                                variant="outline"
                                                                type="button"
                                                                onClick={() => {
                                                                  void s.resolveInitiativeUpdateEditDraftConflict(
                                                                    update,
                                                                    true,
                                                                  );
                                                                }}
                                                              >
                                                                Keep draft
                                                              </Button>
                                                              <Button
                                                                size="sm"
                                                                variant="outline"
                                                                type="button"
                                                                onClick={() => {
                                                                  void s.resolveInitiativeUpdateEditDraftConflict(
                                                                    update,
                                                                    false,
                                                                  );
                                                                }}
                                                              >
                                                                Use Linear's version
                                                              </Button>
                                                            </div>
                                                          </>
                                                        ) : s.hasInitiativeUpdateEditDraft() ? (
                                                          <>
                                                            <p className="hint">
                                                              Initiative update draft saved on this
                                                              device.
                                                            </p>
                                                          </>
                                                        ) : null}
                                                        <div className="issue-actions">
                                                          <Button
                                                            size="sm"
                                                            disabled={
                                                              s.savingInitiativeUpdate() ||
                                                              s.initiativeUpdateEditDraftConflict() ||
                                                              !s.editInitiativeUpdateBody().trim()
                                                            }
                                                          >
                                                            {s.savingInitiativeUpdate()
                                                              ? 'Saving'
                                                              : 'Save update'}
                                                          </Button>
                                                          <Button
                                                            size="sm"
                                                            variant="link"
                                                            type="button"
                                                            onClick={() => {
                                                              void s.editingInitiativeUpdateId.set(
                                                                null,
                                                              );
                                                            }}
                                                          >
                                                            Cancel
                                                          </Button>
                                                        </div>
                                                      </form>
                                                    </>
                                                  ) : null}
                                                </>
                                              ) : null}
                                            </Fragment>
                                          );
                                        })}
                                      </div>
                                    </>
                                  ) : null}
                                  {!initiative.archivedAt ? (
                                    <>
                                      <Button
                                        size="sm"
                                        variant="outline"
                                        onClick={() => {
                                          void s.toggleInitiativeUpdate(initiative);
                                        }}
                                      >
                                        {s.initiativeUpdateId() === initiative.id
                                          ? 'Cancel update'
                                          : 'Post status update'}
                                      </Button>
                                    </>
                                  ) : null}
                                  {!initiative.archivedAt &&
                                  s.availableInitiativeProjects(initiative).length ? (
                                    <>
                                      <div className="issue-actions">
                                        <label>
                                          <span className="sr-only">
                                            Project to add to {initiative.name}
                                          </span>
                                          <select
                                            value={
                                              s.initiativeProjectSelection()[initiative.id] ?? ''
                                            }
                                            onChange={($event) => {
                                              void s.setInitiativeProject(
                                                initiative.id,
                                                $event.currentTarget.value,
                                              );
                                            }}
                                          >
                                            <option value="">Choose project</option>
                                            {s
                                              .availableInitiativeProjects(initiative)
                                              .map((project) => {
                                                return (
                                                  <Fragment key={project.id}>
                                                    <option value={project.id}>
                                                      {project.name}
                                                    </option>
                                                  </Fragment>
                                                );
                                              })}
                                          </select>
                                        </label>
                                        <Button
                                          size="sm"
                                          variant="outline"
                                          disabled={
                                            !s.initiativeProjectSelection()[initiative.id] ||
                                            s.savingInitiativeProjectId() === initiative.id
                                          }
                                          onClick={() => {
                                            void s.addInitiativeProject(initiative);
                                          }}
                                        >
                                          {s.savingInitiativeProjectId() === initiative.id
                                            ? 'Linking'
                                            : 'Link project'}
                                        </Button>
                                      </div>
                                    </>
                                  ) : null}
                                </div>
                                <div className="issue-actions">
                                  {initiative.archivedAt ? (
                                    <>
                                      <Button
                                        size="sm"
                                        variant="outline"
                                        disabled={s.busyInitiativeId() === initiative.id}
                                        onClick={() => {
                                          void s.setInitiativeArchived(initiative, false);
                                        }}
                                      >
                                        {s.busyInitiativeId() === initiative.id
                                          ? 'Restoring'
                                          : 'Restore'}
                                      </Button>
                                    </>
                                  ) : (
                                    <>
                                      <Button
                                        size="sm"
                                        variant="outline"
                                        onClick={() => {
                                          void s.editInitiative(initiative);
                                        }}
                                      >
                                        Edit
                                      </Button>
                                      <Button
                                        size="sm"
                                        variant="link"
                                        disabled={s.busyInitiativeId() === initiative.id}
                                        onClick={() => {
                                          void s.setInitiativeArchived(initiative, true);
                                        }}
                                      >
                                        {s.busyInitiativeId() === initiative.id
                                          ? 'Archiving'
                                          : s.confirmArchiveInitiativeId() === initiative.id
                                            ? 'Confirm archive'
                                            : 'Archive'}
                                      </Button>
                                      {s.confirmArchiveInitiativeId() === initiative.id ? (
                                        <>
                                          <Button
                                            size="sm"
                                            variant="link"
                                            onClick={() => {
                                              void s.confirmArchiveInitiativeId.set(null);
                                            }}
                                          >
                                            Cancel
                                          </Button>
                                        </>
                                      ) : null}
                                    </>
                                  )}
                                </div>
                              </article>
                              {s.initiativeUpdateId() === initiative.id ? (
                                <>
                                  {s.initiativeUpdateBody() ||
                                  s.initiativeUpdateHealth() !== 'onTrack' ? (
                                    <>
                                      <p className="hint">
                                        Initiative update draft saved on this device.
                                      </p>
                                    </>
                                  ) : null}
                                  <form
                                    className="project-edit"
                                    onSubmit={($event) => {
                                      void s.createInitiativeUpdate($event.nativeEvent, initiative);
                                    }}
                                  >
                                    <label>
                                      <span>Health</span>
                                      <select
                                        value={s.initiativeUpdateHealth()}
                                        onChange={($event) => {
                                          void s.updateInitiativeUpdateDraft(
                                            'health',
                                            $event.currentTarget.value,
                                          );
                                        }}
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
                                        maxLength={10000}
                                        rows={3}
                                        value={s.initiativeUpdateBody()}
                                        onChange={($event) => {
                                          void s.updateInitiativeUpdateDraft(
                                            'body',
                                            $event.currentTarget.value,
                                          );
                                        }}
                                      />
                                    </label>
                                    <Button
                                      size="sm"
                                      disabled={
                                        s.creatingInitiativeUpdate() ||
                                        !s.initiativeUpdateBody().trim()
                                      }
                                    >
                                      {s.creatingInitiativeUpdate() ? 'Posting' : 'Post update'}
                                    </Button>
                                  </form>
                                </>
                              ) : null}
                              {s.editingInitiativeId() === initiative.id ? (
                                <>
                                  <form
                                    className="project-edit"
                                    onSubmit={($event) => {
                                      void s.saveInitiative($event.nativeEvent, initiative);
                                    }}
                                  >
                                    <label>
                                      <span>Initiative name</span>
                                      <input
                                        required
                                        maxLength={255}
                                        value={s.editInitiativeName()}
                                        onChange={($event) => {
                                          void s.updateInitiativeEditDraft(
                                            initiative,
                                            'name',
                                            $event.currentTarget.value,
                                          );
                                        }}
                                      />
                                    </label>
                                    <label>
                                      <span>Target date</span>
                                      <input
                                        type="date"
                                        value={s.editInitiativeTargetDate()}
                                        onChange={($event) => {
                                          void s.updateInitiativeEditDraft(
                                            initiative,
                                            'targetDate',
                                            $event.currentTarget.value,
                                          );
                                        }}
                                      />
                                    </label>
                                    <label>
                                      <span>Description</span>
                                      <textarea
                                        rows={2}
                                        value={s.editInitiativeDescription()}
                                        onChange={($event) => {
                                          void s.updateInitiativeEditDraft(
                                            initiative,
                                            'description',
                                            $event.currentTarget.value,
                                          );
                                        }}
                                      />
                                    </label>
                                    {s.initiativeEditDraftConflict() ? (
                                      <>
                                        <div className="issue-conflicts" role="alert">
                                          <span>
                                            This initiative draft overlaps newer changes in Linear.
                                          </span>
                                          <Button
                                            size="sm"
                                            variant="outline"
                                            type="button"
                                            onClick={() => {
                                              void s.resolveInitiativeEditDraftConflict(
                                                initiative,
                                                true,
                                              );
                                            }}
                                          >
                                            Keep draft
                                          </Button>
                                          <Button
                                            size="sm"
                                            variant="outline"
                                            type="button"
                                            onClick={() => {
                                              void s.resolveInitiativeEditDraftConflict(
                                                initiative,
                                                false,
                                              );
                                            }}
                                          >
                                            Use Linear's version
                                          </Button>
                                        </div>
                                      </>
                                    ) : s.hasInitiativeEditDraft() ? (
                                      <>
                                        <p className="hint">
                                          Initiative draft saved on this device.
                                        </p>
                                      </>
                                    ) : null}
                                    <Button
                                      size="sm"
                                      disabled={
                                        s.savingInitiative() ||
                                        s.initiativeEditDraftConflict() ||
                                        !s.editInitiativeName().trim()
                                      }
                                    >
                                      {s.savingInitiative() ? 'Saving' : 'Save initiative'}
                                    </Button>
                                  </form>
                                </>
                              ) : null}
                            </Fragment>
                          );
                        })
                      )}
                    </section>
                  </>
                ) : (
                  <>
                    <section className="issues" aria-label="Linear issue labels">
                      <form
                        className="project-edit"
                        onSubmit={($event) => {
                          void s.createLabel($event.nativeEvent);
                        }}
                      >
                        {s.newLabelName() ? (
                          <>
                            <p className="hint">Label draft saved on this device.</p>
                          </>
                        ) : null}
                        <label>
                          <span>Label name</span>
                          <input
                            required
                            maxLength={255}
                            value={s.newLabelName()}
                            onChange={($event) => {
                              void s.updateIssueLabelDraft('name', $event.currentTarget.value);
                            }}
                          />
                        </label>
                        <label>
                          <span>Scope</span>
                          <select
                            value={s.newLabelTeamId()}
                            onChange={($event) => {
                              void s.updateIssueLabelDraft('teamId', $event.currentTarget.value);
                            }}
                          >
                            <option value="">Workspace</option>
                            {s.teams().map((team) => {
                              return (
                                <Fragment key={team.id}>
                                  <option value={team.id}>{team.name}</option>
                                </Fragment>
                              );
                            })}
                          </select>
                        </label>
                        <label>
                          <span>Color</span>
                          <input
                            type="color"
                            value={s.newLabelColor()}
                            onChange={($event) => {
                              void s.updateIssueLabelDraft('color', $event.currentTarget.value);
                            }}
                          />
                        </label>
                        <Button size="sm" disabled={s.creatingLabel() || !s.newLabelName().trim()}>
                          {s.creatingLabel() ? 'Creating' : 'Create label'}
                        </Button>
                      </form>
                      {s.labels().length === 0 ? (
                        <>
                          <p className="hint">No issue labels are available in this workspace.</p>
                        </>
                      ) : (
                        s.labels().map((label) => {
                          return (
                            <Fragment key={label.id}>
                              <article className="issue">
                                <span
                                  className="label-color"
                                  style={{ backgroundColor: label.color ?? '#6b7280' }}
                                />
                                {s.editingLabelId() === label.id ? (
                                  <>
                                    <form
                                      className="issue-actions"
                                      onSubmit={($event) => {
                                        void s.saveLabel($event.nativeEvent, label);
                                      }}
                                    >
                                      <label>
                                        <span className="sr-only">Label name</span>
                                        <input
                                          required
                                          maxLength={255}
                                          value={s.editLabelName()}
                                          onChange={($event) => {
                                            void s.updateLabelEditDraft(
                                              label,
                                              'name',
                                              $event.currentTarget.value,
                                            );
                                          }}
                                        />
                                      </label>
                                      <label>
                                        <span className="sr-only">Label color</span>
                                        <input
                                          type="color"
                                          value={s.editLabelColor()}
                                          onChange={($event) => {
                                            void s.updateLabelEditDraft(
                                              label,
                                              'color',
                                              $event.currentTarget.value,
                                            );
                                          }}
                                        />
                                      </label>
                                      {s.labelEditDraftConflict() ? (
                                        <>
                                          <div className="issue-conflicts" role="alert">
                                            <span>
                                              This label draft overlaps newer changes in Linear.
                                            </span>
                                            <Button
                                              size="sm"
                                              variant="outline"
                                              type="button"
                                              onClick={() => {
                                                void s.resolveLabelEditDraftConflict(label, true);
                                              }}
                                            >
                                              Keep draft
                                            </Button>
                                            <Button
                                              size="sm"
                                              variant="outline"
                                              type="button"
                                              onClick={() => {
                                                void s.resolveLabelEditDraftConflict(label, false);
                                              }}
                                            >
                                              Use Linear's version
                                            </Button>
                                          </div>
                                        </>
                                      ) : s.hasLabelEditDraft() ? (
                                        <>
                                          <p className="hint">Label draft saved on this device.</p>
                                        </>
                                      ) : null}
                                      <Button
                                        size="sm"
                                        disabled={
                                          s.savingLabel() ||
                                          s.labelEditDraftConflict() ||
                                          !s.editLabelName().trim()
                                        }
                                      >
                                        {s.savingLabel() ? 'Saving' : 'Save'}
                                      </Button>
                                      <Button
                                        size="sm"
                                        variant="link"
                                        type="button"
                                        onClick={() => {
                                          void s.editingLabelId.set(null);
                                        }}
                                      >
                                        Cancel
                                      </Button>
                                    </form>
                                  </>
                                ) : (
                                  <>
                                    <span className="issue-title">{label.name}</span>
                                    <span className="muted">
                                      {label.team?.id ? s.teamName(label.team.id) : 'Workspace'}
                                    </span>
                                    {s.confirmDeleteLabelId() === label.id ? (
                                      <>
                                        <span className="muted">Delete this label?</span>
                                        <Button
                                          size="sm"
                                          variant="destructive"
                                          disabled={s.deletingLabelId() === label.id}
                                          onClick={() => {
                                            void s.deleteLabel(label);
                                          }}
                                        >
                                          {s.deletingLabelId() === label.id
                                            ? 'Deleting'
                                            : 'Confirm delete'}
                                        </Button>
                                        <Button
                                          size="sm"
                                          variant="link"
                                          onClick={() => {
                                            void s.confirmDeleteLabelId.set(null);
                                          }}
                                        >
                                          Cancel
                                        </Button>
                                      </>
                                    ) : (
                                      <>
                                        <Button
                                          size="sm"
                                          variant="outline"
                                          onClick={() => {
                                            void s.editLabel(label);
                                          }}
                                        >
                                          Edit
                                        </Button>
                                        <Button
                                          size="sm"
                                          variant="link"
                                          onClick={() => {
                                            void s.confirmDeleteLabelId.set(label.id);
                                          }}
                                        >
                                          Delete
                                        </Button>
                                      </>
                                    )}
                                  </>
                                )}
                              </article>
                            </Fragment>
                          );
                        })
                      )}
                    </section>
                  </>
                )}
              </>
            ) : null}
          </>
        )}
        {s.connections().length && !s.selected() ? (
          <>
            <div className="empty">
              <p className="label">Linear is paused on this device</p>
              <p className="hint">
                Resume a workspace in Linear settings to use it here. Other devices remain
                connected.
              </p>
            </div>
          </>
        ) : null}
      </section>
    </div>
  );
}
