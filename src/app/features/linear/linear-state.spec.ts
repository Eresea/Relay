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

  it('replaces mutually exclusive assignee and cycle changes', () => {
    expect(mergeLinearIssueUpdates({ clearAssignee: true }, { assigneeId: 'user-1' })).toEqual({
      assigneeId: 'user-1',
    });
    expect(mergeLinearIssueUpdates({ cycleId: 'cycle-1' }, { clearCycle: true })).toEqual({
      clearCycle: true,
    });
  });
});
