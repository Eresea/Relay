export interface LinearIssueUpdate {
  title?: string;
  description?: string;
  projectId?: string;
  clearProject?: boolean;
  projectMilestoneId?: string;
  clearProjectMilestone?: boolean;
  dueDate?: string;
  clearDueDate?: boolean;
  estimate?: number;
  clearEstimate?: boolean;
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

export function linearEstimateOptions(type: string, extended: boolean, allowZero: boolean) {
  const scales: Record<string, [number, string][]> = {
    linear: [
      [1, '1'],
      [2, '2'],
      [3, '3'],
      [4, '4'],
      [5, '5'],
    ],
    fibonacci: [
      [1, '1'],
      [2, '2'],
      [3, '3'],
      [5, '5'],
      [8, '8'],
    ],
    exponential: [
      [1, '1'],
      [2, '2'],
      [4, '4'],
      [8, '8'],
      [16, '16'],
    ],
    tShirt: [
      [1, 'XS'],
      [2, 'S'],
      [3, 'M'],
      [5, 'L'],
      [8, 'XL'],
    ],
  };
  const extras: Record<string, [number, string][]> = {
    linear: [
      [6, '6'],
      [7, '7'],
    ],
    fibonacci: [
      [13, '13'],
      [21, '21'],
    ],
    exponential: [
      [32, '32'],
      [64, '64'],
    ],
    tShirt: [
      [13, 'XXL'],
      [21, 'XXXL'],
    ],
  };
  const values = scales[type];
  if (!values) return [];
  return [
    ...(allowZero ? [[0, '0'] as [number, string]] : []),
    ...values,
    ...(extended ? extras[type] : []),
  ].map(([value, label]) => ({ value, label }));
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
  if ('estimate' in next) delete merged.clearEstimate;
  if (next.clearEstimate) delete merged.estimate;
  if ('projectId' in next || next.clearProject) {
    delete merged.projectMilestoneId;
    merged.clearProjectMilestone = true;
  }
  return merged;
}
