import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  OnInit,
  TemplateRef,
  ViewChild,
  ViewContainerRef,
  computed,
  inject,
  input,
  model,
  output,
  signal,
} from '@angular/core';
import { Overlay, OverlayRef } from '@angular/cdk/overlay';
import { TemplatePortal } from '@angular/cdk/portal';
import { takeUntilDestroyed, toObservable } from '@angular/core/rxjs-interop';
import { FormValueControl } from '@angular/forms/signals';
import { Subject, merge, of } from 'rxjs';
import {
  catchError,
  debounceTime,
  exhaustMap,
  filter,
  map,
  switchMap,
  tap,
} from 'rxjs/operators';
import {
  UmbraSelectDataSource,
  UmbraSelectLabels,
  UmbraSelectRequest,
  UmbraSelectResult,
  UmbraSelectState,
  UmbraSelectWidthStrategy,
} from './umbra-select.types';

let nextId = 0;

type SearchOutcome<T> =
  | { query: string; items: T[]; nextCursor?: string }
  | { query: string; error: unknown };

type PageOutcome<T> =
  | { request: UmbraSelectRequest; items: T[]; nextCursor?: string }
  | { request: UmbraSelectRequest; error: unknown };

const DEFAULT_LABELS: UmbraSelectLabels = {
  search: 'Search options',
  clear: 'Clear selection',
  loading: 'Loading options',
  loadingMore: 'Loading more options',
  retry: 'Retry',
  noOptions: 'No options available',
  noResults: (query) => `No results for "${query}"`,
  unableToLoad: 'Unable to load options.',
  unableToLoadMore: 'Unable to load more options.',
  resultCount: (count) =>
    `${count} ${count === 1 ? 'option' : 'options'} available`,
  additionalResults: (count) =>
    `${count} additional ${count === 1 ? 'option' : 'options'} loaded`,
};

@Component({
  selector: 'umbra-select',
  standalone: true,
  templateUrl: './umbra-select.component.html',
  styleUrl: './umbra-select.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'inline-block max-w-full',
    '[class.w-full]': "widthStrategy() === 'full'",
  },
})
export class UmbraSelectComponent<T, V>
  implements FormValueControl<V | null>, OnInit
{
  readonly dataSource = input.required<UmbraSelectDataSource<T, V>>();
  readonly displayWith = input.required<(item: T) => string>();
  readonly valueWith = input.required<(item: T) => V>();
  readonly value = model<V | null>(null);

  readonly placeholder = input('Select an option');
  readonly searchPlaceholder = input('Search...');
  readonly limit = input(20);
  readonly disabled = input(false);
  readonly invalid = input(false);
  readonly required = input(false);
  readonly showClear = input(false);
  readonly widthStrategy = input<UmbraSelectWidthStrategy>('trigger');
  readonly prefetch = input(false);
  readonly label = input('');
  readonly isOptionDisabled = input<(item: T) => boolean>(() => false);
  readonly labels = input<Partial<UmbraSelectLabels>>({});
  readonly dropdownPosition = input<'down' | 'up'>('down');
  readonly ariaLabel = input('Select an option');
  readonly ariaLabelledBy = input<string>();
  readonly ariaDescribedBy = input<string>();
  readonly touch = output<void>();

  @ViewChild('triggerButton') private triggerButton?: ElementRef<HTMLButtonElement>;
  @ViewChild('panelTemplate') private panelTemplate?: TemplateRef<unknown>;
  @ViewChild('searchInput') private searchInput?: ElementRef<HTMLInputElement>;
  @ViewChild('listbox') private listbox?: ElementRef<HTMLDivElement>;

  readonly isOpen = signal(false);
  readonly activeIndex = signal(-1);
  readonly selectedItem = signal<T | null>(null);
  readonly announcement = signal('');
  readonly resolvedLabels = computed(() => ({
    ...DEFAULT_LABELS,
    ...this.labels(),
  }));
  readonly state = signal<UmbraSelectState<T>>({
    query: '',
    items: [],
    hasMore: false,
    loadingInitial: false,
    loadingMore: false,
    searchError: null,
    paginationError: null,
  });
  readonly visibleItems = computed(() => {
    const state = this.state();
    const query = state.query.trim().toLowerCase();
    const selected = this.selectedItem();
    const items =
      selected &&
      (!query || this.displayWith()(selected).toLowerCase().includes(query)) &&
      !state.items.some((item) =>
        Object.is(this.valueWith()(item), this.valueWith()(selected)),
      )
        ? [selected, ...state.items]
        : state.items;
    if (!query || state.query === this.itemsQuery()) return items;
    return items.filter((item) =>
      this.displayWith()(item).toLowerCase().includes(query),
    );
  });

  readonly id = `umbra-select-${nextId++}`;
  readonly listboxId = `${this.id}-listbox`;
  readonly activeOptionId = computed(() => {
    const index = this.activeIndex();
    return index < 0 ? null : `${this.id}-option-${index}`;
  });
  readonly displayLabel = computed(() => {
    const item = this.selectedItem();
    return item === null ? null : this.displayWith()(item);
  });
  readonly hasValue = computed(
    () => this.value() !== null && this.value() !== undefined,
  );
  readonly triggerAriaLabel = computed(() => {
    const value = this.displayLabel() ?? this.placeholder();
    return this.label() ? `${this.label()}: ${value}` : value;
  });

  private readonly destroyRef = inject(DestroyRef);
  private readonly overlay = inject(Overlay);
  private readonly viewContainerRef = inject(ViewContainerRef);
  private readonly query$ = new Subject<string>();
  private readonly immediateSearch$ = new Subject<string>();
  private readonly retrySearch$ = new Subject<void>();
  private readonly loadMore$ = new Subject<'load' | 'retry'>();
  private readonly itemsQuery = signal('');
  private defaultResult: UmbraSelectResult<T> | null = null;
  private overlayRef?: OverlayRef;

  constructor() {
    this.connectSearch();
    this.connectPagination();
    this.connectValue();
    this.destroyRef.onDestroy(() => this.overlayRef?.dispose());
  }

  ngOnInit(): void {
    if (this.prefetch()) this.searchNow('');
  }

  open(): void {
    if (this.disabled() || this.isOpen()) return;
    const trigger = this.triggerButton?.nativeElement;
    const panel = this.panelTemplate;
    if (!trigger || !panel) return;

    const styles = getComputedStyle(trigger);
    const gap = this.tokenPixels(styles, '--space-3');
    const margin = this.tokenPixels(styles, '--space-4');
    const below = {
      originX: 'start' as const,
      originY: 'bottom' as const,
      overlayX: 'start' as const,
      overlayY: 'top' as const,
      offsetY: gap,
    };
    const above = {
      originX: 'start' as const,
      originY: 'top' as const,
      overlayX: 'start' as const,
      overlayY: 'bottom' as const,
      offsetY: -gap,
    };
    const positionStrategy = this.overlay
      .position()
      .flexibleConnectedTo(trigger)
      .withPositions(
        this.dropdownPosition() === 'up' ? [above, below] : [below, above],
      )
      .withPush(true)
      .withViewportMargin(margin);
    const overlayRef = this.overlay.create({
      positionStrategy,
      scrollStrategy: this.overlay.scrollStrategies.reposition(),
      panelClass: 'umbra-select-overlay',
      ...(this.widthStrategy() === 'content'
        ? {}
        : {
            width: Math.max(
              trigger.getBoundingClientRect().width,
              this.tokenPixels(styles, '--overlay-min-w'),
            ),
          }),
    });
    this.overlayRef = overlayRef;
    overlayRef.attach(new TemplatePortal(panel, this.viewContainerRef));
    let openingClick = true;
    queueMicrotask(() => (openingClick = false));
    overlayRef
      .outsidePointerEvents()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        if (!openingClick) this.close();
      });
    this.isOpen.set(true);
    this.prepareOpen();
  }

  private prepareOpen(): void {
    this.activeIndex.set(-1);
    if (!this.defaultResult && !this.state().loadingInitial) this.searchNow('');
    queueMicrotask(() => this.searchInput?.nativeElement.focus());
  }

  close(restoreFocus = false, markTouched = true): void {
    if (!this.isOpen()) return;
    this.isOpen.set(false);
    this.overlayRef?.dispose();
    this.overlayRef = undefined;
    this.activeIndex.set(-1);
    if (this.state().query) this.restoreDefaultResult();
    if (markTouched) this.touch.emit();
    if (restoreFocus) queueMicrotask(() => this.focus());
  }

  toggle(): void {
    this.isOpen() ? this.close() : this.open();
  }

  focus(options?: FocusOptions): void {
    this.triggerButton?.nativeElement.focus(options);
  }

  onTriggerBlur(): void {
    if (!this.isOpen()) this.touch.emit();
  }

  onSearchChange(event: Event): void {
    this.setQuery((event.target as HTMLInputElement).value);
  }

  retrySearch(): void {
    this.retrySearch$.next();
  }

  retryPagination(): void {
    this.loadMore$.next('retry');
  }

  selectOption(item: T): void {
    if (this.isOptionDisabled()(item)) return;
    this.selectedItem.set(item);
    this.value.set(this.valueWith()(item));
    this.close(true);
  }

  clear(event: Event): void {
    event.stopPropagation();
    this.selectedItem.set(null);
    this.value.set(null);
    this.touch.emit();
    this.focus();
  }

  onScroll(event: Event): void {
    const target = event.target as HTMLElement;
    if (target.scrollHeight - target.scrollTop <= target.clientHeight + 40)
      this.loadMore$.next('load');
  }

  onTriggerKeydown(event: KeyboardEvent): void {
    if (this.disabled()) return;
    if (event.altKey && event.key === 'ArrowDown') {
      event.preventDefault();
      this.open();
      return;
    }
    if (
      event.key === 'ArrowDown' ||
      event.key === 'ArrowUp' ||
      event.key === 'Enter' ||
      event.key === ' '
    ) {
      event.preventDefault();
      this.open();
      if (event.key === 'ArrowUp') this.moveActive(-1);
      return;
    }
    if (
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      event.key.length === 1
    ) {
      event.preventDefault();
      this.open();
      this.setQuery(event.key);
    }
  }

  onSearchKeydown(event: KeyboardEvent): void {
    if (event.altKey && event.key === 'ArrowUp') {
      event.preventDefault();
      this.close(true);
      return;
    }
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        this.moveActive(1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        this.moveActive(-1);
        break;
      case 'Home':
        event.preventDefault();
        this.activateBoundary(1);
        break;
      case 'End':
        event.preventDefault();
        this.activateBoundary(-1);
        break;
      case 'Enter': {
        event.preventDefault();
        const item = this.visibleItems()[this.activeIndex()];
        if (item && !this.isOptionDisabled()(item)) this.selectOption(item);
        break;
      }
      case 'Escape':
        event.preventDefault();
        this.close(true);
        break;
      case 'Tab':
        this.close(false);
        break;
    }
  }

  private connectSearch(): void {
    merge(
      this.query$.pipe(debounceTime(250)),
      this.immediateSearch$,
      this.retrySearch$.pipe(map(() => this.state().query)),
    )
      .pipe(
        tap((query) =>
          this.state.update((state) => {
            this.announcement.set(this.resolvedLabels().loading);
            return {
              ...state,
              query,
              cursor: undefined,
              hasMore: false,
              loadingInitial: true,
              loadingMore: false,
              searchError: null,
              paginationError: null,
            };
          }),
        ),
        switchMap((query) =>
          this.dataSource()
            .search({ query, limit: this.limit() })
            .pipe(
              map((result): SearchOutcome<T> => ({
                query,
                items: result.items,
                nextCursor: result.nextCursor,
              })),
              catchError((error) => of({ query, error } as SearchOutcome<T>)),
            ),
        ),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((outcome) => {
        if (outcome.query !== this.state().query) return;
        if ('error' in outcome) {
          this.state.update((state) => ({
            ...state,
            loadingInitial: false,
            searchError: outcome.error,
          }));
          return;
        }
        const items = this.dedupe(outcome.items);
        this.itemsQuery.set(outcome.query);
        this.state.update((state) => ({
          ...state,
          items,
          cursor: outcome.nextCursor,
          hasMore: outcome.nextCursor !== undefined && items.length > 0,
          loadingInitial: false,
          searchError: null,
        }));
        if (outcome.query === '') {
          this.defaultResult = {
            items,
            nextCursor: outcome.nextCursor,
          };
        }
        this.syncSelectedFrom(items);
        this.activeIndex.set(-1);
        this.announcement.set(
          items.length
            ? this.resolvedLabels().resultCount(items.length)
            : outcome.query
              ? this.resolvedLabels().noResults(outcome.query)
              : this.resolvedLabels().noOptions,
        );
      });
  }

  private connectPagination(): void {
    this.loadMore$
      .pipe(
        filter((mode) => {
          const state = this.state();
          return (
            !state.loadingInitial &&
            !state.loadingMore &&
            state.hasMore &&
            (mode === 'retry' || !state.paginationError)
          );
        }),
        map((): UmbraSelectRequest => ({
          query: this.state().query,
          cursor: this.state().cursor,
          limit: this.limit(),
        })),
        tap(() => {
          this.announcement.set(this.resolvedLabels().loadingMore);
          this.state.update((state) => ({
            ...state,
            loadingMore: true,
            paginationError: null,
          }));
        }),
        exhaustMap((request) =>
          this.dataSource()
            .search(request)
            .pipe(
              map((result): PageOutcome<T> => ({
                request,
                items: result.items,
                nextCursor: result.nextCursor,
              })),
              catchError((error) => of({ request, error } as PageOutcome<T>)),
            ),
        ),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((outcome) => {
        const state = this.state();
        if (
          outcome.request.query !== state.query ||
          outcome.request.cursor !== state.cursor
        )
          return;
        if ('error' in outcome) {
          this.state.update((current) => ({
            ...current,
            loadingMore: false,
            paginationError: outcome.error,
          }));
          return;
        }
        const items = this.dedupe([...state.items, ...outcome.items]);
        this.state.update((current) => ({
          ...current,
          items,
          cursor: outcome.nextCursor,
          hasMore: outcome.nextCursor !== undefined && outcome.items.length > 0,
          loadingMore: false,
          paginationError: null,
        }));
        this.syncSelectedFrom(items);
        if (state.query === '') {
          this.defaultResult = {
            items,
            nextCursor: outcome.nextCursor,
          };
        }
        this.announcement.set(
          this.resolvedLabels().additionalResults(outcome.items.length),
        );
      });
  }

  private connectValue(): void {
    toObservable(this.value)
      .pipe(
        switchMap((value) => {
          if (value === null || value === undefined)
            return of({ value, item: null as T | null });
          const loaded = this.state().items.find((item) =>
            Object.is(this.valueWith()(item), value),
          );
          if (loaded) return of({ value, item: loaded });
          const source = this.dataSource();
          if (!source.resolveByValue)
            return of({ value, item: null as T | null });
          return source.resolveByValue(value).pipe(
            map((item) => ({ value, item })),
            catchError(() => of({ value, item: null as T | null })),
          );
        }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe(({ value, item }) => {
        if (Object.is(this.value(), value)) this.selectedItem.set(item);
      });
  }

  private setQuery(query: string): void {
    this.state.update((state) => ({
      ...state,
      query,
      cursor: undefined,
      hasMore: false,
      loadingInitial: true,
      paginationError: null,
    }));
    this.activeIndex.set(-1);
    this.query$.next(query);
  }

  private searchNow(query: string): void {
    this.state.update((state) => ({ ...state, query }));
    this.immediateSearch$.next(query);
  }

  private restoreDefaultResult(): void {
    const result = this.defaultResult;
    this.itemsQuery.set('');
    this.state.update((state) => ({
      ...state,
      query: '',
      items: result?.items ?? [],
      cursor: result?.nextCursor,
      hasMore: result?.nextCursor !== undefined && !!result.items.length,
      loadingInitial: false,
      loadingMore: false,
      searchError: null,
      paginationError: null,
    }));
  }

  private dedupe(items: T[]): T[] {
    return [
      ...new Map(items.map((item) => [this.valueWith()(item), item])).values(),
    ];
  }

  private syncSelectedFrom(items: T[]): void {
    const value = this.value();
    if (value === null || value === undefined) return;
    const item = items.find((candidate) =>
      Object.is(this.valueWith()(candidate), value),
    );
    if (item) this.selectedItem.set(item);
  }

  private tokenPixels(styles: CSSStyleDeclaration, token: string): number {
    const value = Number.parseFloat(styles.getPropertyValue(token));
    return Number.isFinite(value) ? value : 0;
  }

  activateOption(index: number): void {
    const item = this.visibleItems()[index];
    if (item && !this.isOptionDisabled()(item)) this.activeIndex.set(index);
  }

  isSelected(item: T): boolean {
    return Object.is(this.valueWith()(item), this.value());
  }

  private moveActive(direction: 1 | -1): void {
    const items = this.visibleItems();
    let index = this.activeIndex();
    if (index < 0) index = direction === 1 ? -1 : items.length;
    for (
      index += direction;
      index >= 0 && index < items.length;
      index += direction
    ) {
      if (!this.isOptionDisabled()(items[index])) {
        this.activeIndex.set(index);
        this.scrollActiveIntoView();
        return;
      }
    }
  }

  private activateBoundary(direction: 1 | -1): void {
    this.activeIndex.set(direction === 1 ? -1 : this.visibleItems().length);
    this.moveActive(direction);
  }

  private scrollActiveIntoView(): void {
    queueMicrotask(() => {
      const option = this.listbox?.nativeElement.querySelector<HTMLElement>(
        `[data-index="${this.activeIndex()}"]`,
      );
      option?.scrollIntoView({ block: 'nearest' });
    });
  }
}
