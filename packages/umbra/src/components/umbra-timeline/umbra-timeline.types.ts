export type UmbraTimelineGroupValue = string | number | Date;

export interface UmbraTimelineHeaderData {
  label: string;
  value: string;
}

export interface UmbraTimelineTemplateContext<T> {
  $implicit: T;
  item: T;
  index: number;
  first: boolean;
  last: boolean;
  group: UmbraTimelineGroupValue | null;
  groupLabel: string | null;
}

export interface UmbraTimelineGroupTemplateContext {
  $implicit: UmbraTimelineGroupValue;
  group: UmbraTimelineGroupValue;
  label: string;
  index: number;
}
