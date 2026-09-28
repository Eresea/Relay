import {
  ChangeDetectionStrategy,
  Component,
  ContentChild,
  DestroyRef,
  ElementRef,
  TemplateRef,
  computed,
  effect,
  inject,
  input,
  output,
  viewChild,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { UmbraSkeletonComponent } from '@umbra/components/umbra-skeleton/umbra-skeleton.component';
import {
  UmbraTimelineGroupTemplateContext,
  UmbraTimelineGroupValue,
  UmbraTimelineHeaderData,
  UmbraTimelineTemplateContext,
} from './umbra-timeline.types';

export interface UmbraTimelineEntry<T> {
  key: string | number;
  item: T;
  index: number;
  first: boolean;
  last: boolean;
  group: UmbraTimelineGroupValue | null;
  groupLabel: string | null;
  showGroup: boolean;
  context: UmbraTimelineTemplateContext<T>;
}

export function defaultUmbraTimelineGroupLabel(group: UmbraTimelineGroupValue): string {
  if (group instanceof Date) {
    return new Intl.DateTimeFormat(undefined, {
      month: 'long',
      year: 'numeric',
    }).format(group);
  }

  return String(group);
}

export function buildUmbraTimelineEntries<T>(
  items: readonly T[],
  trackBy: (item: T, index: number) => string | number,
  groupBy: ((item: T, index: number) => UmbraTimelineGroupValue | null) | null,
  groupLabel: (group: UmbraTimelineGroupValue, index: number) => string,
): UmbraTimelineEntry<T>[] {
  let previousGroupKey: string | null = null;

  return items.map((item, index) => {
    const group = groupBy ? groupBy(item, index) : null;
    const groupKey = group === null ? null : timelineGroupKey(group);
    const showGroup = groupBy !== null && groupKey !== previousGroupKey;
    const label = group === null ? null : groupLabel(group, index);
    previousGroupKey = groupKey;

    const context: UmbraTimelineTemplateContext<T> = {
      $implicit: item,
      item,
      index,
      first: index === 0,
      last: index === items.length - 1,
      group,
      groupLabel: label,
    };

    return {
      key: trackBy(item, index),
      item,
      index,
      first: context.first,
      last: context.last,
      group,
      groupLabel: label,
      showGroup,
      context,
    };
  });
}

export function shouldUmbraTimelineLoadMore(
  hasMore: boolean,
  loading: boolean,
  isIntersecting: boolean,
): boolean {
  return hasMore && !loading && isIntersecting;
}

function timelineGroupKey(group: UmbraTimelineGroupValue): string {
  return group instanceof Date ? `date:${group.getTime()}` : `${typeof group}:${group}`;
}

@Component({
  selector: 'umbra-timeline',
  standalone: true,
  imports: [NgTemplateOutlet, UmbraSkeletonComponent],
  templateUrl: './umbra-timeline.component.html',
  styleUrl: './umbra-timeline.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'umbra-timeline-host',
  },
})
export class UmbraTimelineComponent<T> {
  readonly items = input<readonly T[]>([]);
  readonly trackBy = input<(item: T, index: number) => string | number>((_item, index) => index);
  readonly groupBy = input<((item: T, index: number) => UmbraTimelineGroupValue | null) | null>(
    null,
  );
  readonly groupLabel = input<(group: UmbraTimelineGroupValue, index: number) => string>((group) =>
    defaultUmbraTimelineGroupLabel(group),
  );
  readonly headerData = input<readonly UmbraTimelineHeaderData[]>([]);
  readonly ariaLabel = input('Timeline');
  readonly emptyMessage = input('No items yet');
  readonly hasMore = input(false);
  readonly loading = input(false);
  readonly loadingRows = input(3);
  readonly loadMoreRootMargin = input('320px');

  readonly loadMore = output<void>();

  @ContentChild('left', { read: TemplateRef })
  leftTemplate?: TemplateRef<UmbraTimelineTemplateContext<T>>;

  @ContentChild('middle', { read: TemplateRef })
  middleTemplate?: TemplateRef<UmbraTimelineTemplateContext<T>>;

  @ContentChild('right', { read: TemplateRef })
  rightTemplate?: TemplateRef<UmbraTimelineTemplateContext<T>>;

  @ContentChild('group', { read: TemplateRef })
  groupTemplate?: TemplateRef<UmbraTimelineGroupTemplateContext>;

  readonly entries = computed(() =>
    buildUmbraTimelineEntries(this.items(), this.trackBy(), this.groupBy(), this.groupLabel()),
  );
  readonly loadingIndexes = computed(() =>
    Array.from({ length: Math.max(0, this.loadingRows()) }, (_, index) => index),
  );

  private readonly sentinel = viewChild<ElementRef<HTMLElement>>('sentinel');
  private readonly destroyRef = inject(DestroyRef);
  private observer?: IntersectionObserver;

  constructor() {
    effect(() => {
      this.sentinel();
      this.hasMore();
      this.loading();
      this.connectLazyLoader();
    });

    this.destroyRef.onDestroy(() => this.observer?.disconnect());
  }

  private connectLazyLoader(): void {
    this.observer?.disconnect();
    this.observer = undefined;

    const sentinel = this.sentinel()?.nativeElement;
    if (
      !sentinel ||
      !this.hasMore() ||
      this.loading() ||
      typeof IntersectionObserver === 'undefined'
    ) {
      return;
    }

    this.observer = new IntersectionObserver(
      ([entry]) => {
        if (
          entry &&
          shouldUmbraTimelineLoadMore(this.hasMore(), this.loading(), entry.isIntersecting)
        ) {
          this.loadMore.emit();
        }
      },
      { rootMargin: this.loadMoreRootMargin() },
    );
    this.observer.observe(sentinel);
  }
}
