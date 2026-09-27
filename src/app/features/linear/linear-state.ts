export interface LinearIssueUpdate {
  stateId?: string;
  assigneeId?: string;
  clearAssignee?: boolean;
  cycleId?: string;
  clearCycle?: boolean;
  priority?: number;
  labelIds?: readonly string[];
}

export interface PendingLinearIssueUpdate {
  issueId: string;
  update: LinearIssueUpdate;
}

export function isPendingLinearIssueUpdate(value: unknown): value is PendingLinearIssueUpdate {
  return (
    typeof value === 'object' &&
    value !== null &&
    'issueId' in value &&
    typeof value.issueId === 'string' &&
    'update' in value &&
    typeof value.update === 'object' &&
    value.update !== null
  );
}

export function mergeLinearIssueUpdates(
  pending: LinearIssueUpdate,
  next: LinearIssueUpdate,
): LinearIssueUpdate {
  const merged = { ...pending, ...next };
  if ('assigneeId' in next) delete merged.clearAssignee;
  if (next.clearAssignee) delete merged.assigneeId;
  if ('cycleId' in next) delete merged.clearCycle;
  if (next.clearCycle) delete merged.cycleId;
  return merged;
}
