export interface LinearIssueUpdate {
  title?: string;
  description?: string;
  projectId?: string;
  clearProject?: boolean;
  projectMilestoneId?: string;
  clearProjectMilestone?: boolean;
  dueDate?: string;
  clearDueDate?: boolean;
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
  if ('projectId' in next) delete merged.clearProject;
  if (next.clearProject) delete merged.projectId;
  if ('projectMilestoneId' in next) delete merged.clearProjectMilestone;
  if (next.clearProjectMilestone) delete merged.projectMilestoneId;
  if ('dueDate' in next) delete merged.clearDueDate;
  if (next.clearDueDate) delete merged.dueDate;
  if ('projectId' in next || next.clearProject) {
    delete merged.projectMilestoneId;
    merged.clearProjectMilestone = true;
  }
  return merged;
}
