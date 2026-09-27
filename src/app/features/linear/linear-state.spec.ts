import { describe, expect, it } from 'vitest';

import { mergeLinearIssueUpdates } from './linear-state';

describe('Linear issue update drafts', () => {
  it('keeps changes to different fields together', () => {
    expect(mergeLinearIssueUpdates({ stateId: 'started' }, { priority: 2 })).toEqual({
      stateId: 'started',
      priority: 2,
    });
  });

  it('retains issue detail edits when later changes are queued or merged', () => {
    expect(
      mergeLinearIssueUpdates(
        { title: 'Old title', description: 'Old description' },
        { title: 'Updated title', stateId: 'started' },
      ),
    ).toEqual({
      title: 'Updated title',
      description: 'Old description',
      stateId: 'started',
    });
  });

  it('replaces a pending project move with the latest association change', () => {
    expect(mergeLinearIssueUpdates({ projectId: 'project-1' }, { clearProject: true })).toEqual({
      clearProject: true,
      clearProjectMilestone: true,
    });
    expect(mergeLinearIssueUpdates({ clearProject: true }, { projectId: 'project-2' })).toEqual({
      projectId: 'project-2',
      clearProjectMilestone: true,
    });
  });

  it('drops a pending milestone when its issue changes projects', () => {
    expect(
      mergeLinearIssueUpdates({ projectMilestoneId: 'milestone-1' }, { projectId: 'project-2' }),
    ).toEqual({ projectId: 'project-2', clearProjectMilestone: true });
  });

  it('keeps only the latest due-date change in an offline draft', () => {
    expect(mergeLinearIssueUpdates({ dueDate: '2026-10-01' }, { clearDueDate: true })).toEqual({
      clearDueDate: true,
    });
    expect(mergeLinearIssueUpdates({ clearDueDate: true }, { dueDate: '2026-10-15' })).toEqual({
      dueDate: '2026-10-15',
    });
  });

  it('replaces mutually exclusive assignee and cycle changes', () => {
    expect(mergeLinearIssueUpdates({ clearAssignee: true }, { assigneeId: 'user-1' })).toEqual({
      assigneeId: 'user-1',
    });
    expect(mergeLinearIssueUpdates({ cycleId: 'cycle-1' }, { clearCycle: true })).toEqual({
      clearCycle: true,
    });
  });
});
