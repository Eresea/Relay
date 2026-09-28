import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  OnChanges,
  TemplateRef,
  computed,
  inject,
  input,
  model,
  SimpleChanges,
  viewChild,
  WritableSignal,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { injectVirtualizer } from '@tanstack/angular-virtual';
import {
  ColumnDef,
  ColumnFiltersState,
  ColumnOrderState,
  ColumnVisibilityState,
  Row,
  RowSelectionState,
  SortingState,
  Cell,
  Column,
  Updater,
  createFilteredRowModel,
  createSortedRowModel,
  columnFilteringFeature,
  columnOrderingFeature,
  columnPinningFeature,
  columnSizingFeature,
  columnVisibilityFeature,
  globalFilteringFeature,
  injectTable,
  rowSelectionFeature,
  rowSortingFeature,
  tableFeatures,
} from '@tanstack/angular-table';
import {
  UmbraTableCellContent,
  UmbraTableCellContext,
  UmbraTableColumn,
  UmbraTableColumnPinning,
} from './umbra-table.types';
import { UmbraSkeletonComponent } from '../umbra-skeleton/umbra-skeleton.component';

const umbraTableFeatures = tableFeatures({
  columnFilteringFeature,
  columnOrderingFeature,
  columnPinningFeature,
  columnSizingFeature,
  columnVisibilityFeature,
  globalFilteringFeature,
  rowSelectionFeature,
  rowSortingFeature,
  filteredRowModel: createFilteredRowModel(),
  sortedRowModel: createSortedRowModel(),
});

type UmbraTableFeatures = typeof umbraTableFeatures;
type UmbraTableRow<T> = Row<UmbraTableFeatures, T>;
type UmbraTableColumnInstance<T> = Column<UmbraTableFeatures, T, unknown>;
type UmbraTableCell<T> = Cell<UmbraTableFeatures, T, unknown>;

@Component({
  selector: 'umbra-table',
  standalone: true,
  imports: [UmbraSkeletonComponent, NgTemplateOutlet],
  templateUrl: './umbra-table.component.html',
  styleUrl: './umbra-table.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'umbra-table-host',
  },
})
export class UmbraTableComponent<T> implements OnChanges {
  readonly rows = input<readonly T[]>([]);
  readonly columns = input<readonly UmbraTableColumn<T>[]>([]);
  readonly rowId = input<(row: T, index: number) => string>((_row, index) => String(index));
  readonly height = input.required<string>();
  readonly rowHeight = input(34);
  readonly overscan = input(6);
  readonly loading = input(false);
  readonly loadingRows = input(8);
  readonly selectable = input(false);
  readonly selectionMode = input<'single' | 'multiple'>('multiple');
  readonly resizable = input(true);
  readonly ariaLabel = input.required<string>();

  readonly sorting = model<SortingState>([]);
  readonly columnFilters = model<ColumnFiltersState>([]);
  readonly globalFilter = model('');
  readonly columnVisibility = model<ColumnVisibilityState>({});
  readonly columnOrder = model<ColumnOrderState>([]);
  readonly columnSizing = model<Record<string, number>>({});
  readonly columnPinning = model<UmbraTableColumnPinning>({
    left: [],
    right: [],
  });
  readonly rowSelection = model<RowSelectionState>({});
  readonly focusedCell = model<{ rowId: string; columnId: string } | null>(null);

  private readonly destroyRef = inject(DestroyRef);
  private resizeCleanup?: () => void;
  private lastSelectedRowId?: string;
  private pendingShiftSelection = false;

  readonly tanstackColumns = computed<ColumnDef<UmbraTableFeatures, T, unknown>[]>(() =>
    this.columns().map((definition) => ({
      id: definition.id,
      accessorFn: definition.accessor,
      header: definition.title,
      enableSorting: definition.sortable,
      enablePinning: definition.pinnable,
      size: definition.width,
      minSize: definition.minWidth,
      maxSize: definition.maxWidth,
      ...(definition.sorter
        ? {
            sortFn: (left: UmbraTableRow<T>, right: UmbraTableRow<T>, id: string) =>
              definition.sorter!(left.getValue(id), right.getValue(id)),
          }
        : {}),
      ...(definition.filter
        ? {
            filterFn: (row: UmbraTableRow<T>, id: string, value: unknown) =>
              definition.filter!(row.getValue(id), value),
          }
        : {}),
    })),
  );

  readonly tanstack = injectTable(() => ({
    features: umbraTableFeatures,
    data: this.rows() as T[],
    columns: this.tanstackColumns(),
    state: {
      sorting: this.sorting(),
      columnFilters: this.columnFilters(),
      globalFilter: this.globalFilter(),
      columnVisibility: this.columnVisibility(),
      columnOrder: this.columnOrder(),
      columnSizing: this.columnSizing(),
      columnPinning: {
        start: [...(this.columnPinning().left ?? [])],
        end: [...(this.columnPinning().right ?? [])],
      },
      rowSelection: this.rowSelection(),
    },
    onSortingChange: (updater) => this.update(this.sorting, updater),
    onColumnFiltersChange: (updater) => this.update(this.columnFilters, updater),
    onGlobalFilterChange: (updater) => this.update(this.globalFilter, updater),
    onColumnVisibilityChange: (updater) => this.update(this.columnVisibility, updater),
    onColumnOrderChange: (updater) => this.update(this.columnOrder, updater),
    onColumnSizingChange: (updater) => this.update(this.columnSizing, updater),
    onColumnPinningChange: (updater) => {
      const current = {
        start: [...(this.columnPinning().left ?? [])],
        end: [...(this.columnPinning().right ?? [])],
      };
      const next = typeof updater === 'function' ? updater(current) : updater;
      this.columnPinning.set({ left: next.start ?? [], right: next.end ?? [] });
    },
    onRowSelectionChange: (updater) => this.update(this.rowSelection, updater),
    getRowId: (row, index) => this.rowId()(row, index),
    enableRowSelection: this.selectable(),
    enableMultiRowSelection: this.selectionMode() === 'multiple',
    globalFilterFn: (row, _id, value) => {
      const query = String(value ?? '')
        .trim()
        .toLocaleLowerCase();
      return (
        !query ||
        this.columns().some((definition) =>
          String(definition.accessor(row.original) ?? '')
            .toLocaleLowerCase()
            .includes(query),
        )
      );
    },
    defaultColumn: {
      size: 160,
      minSize: 80,
      maxSize: 600,
    },
  }));

  readonly tableRows = computed(() => this.tanstack.getRowModel().rows);
  readonly virtualRowCount = computed(
    () => this.tableRows().length + (this.loading() ? Math.max(0, this.loadingRows()) : 0),
  );
  readonly visibleColumns = computed(() => this.tanstack.getVisibleLeafColumns());
  readonly leftColumns = computed(() => this.tanstack.getStartVisibleLeafColumns());
  readonly centerColumns = computed(() => this.tanstack.getCenterVisibleLeafColumns());
  readonly rightColumns = computed(() => this.tanstack.getEndVisibleLeafColumns());
  readonly columnDefinitions = computed(
    () => new Map(this.columns().map((definition) => [definition.id, definition])),
  );
  readonly selectionColumnWidth = computed(() => (this.selectable() ? 44 : 0));
  readonly leftWidth = computed(
    () =>
      this.selectionColumnWidth() +
      this.leftColumns().reduce((total, column) => total + column.getSize(), 0),
  );
  readonly centerWidth = computed(() =>
    this.centerColumns().reduce((total, column) => total + column.getSize(), 0),
  );
  readonly rightWidth = computed(() =>
    this.rightColumns().reduce((total, column) => total + column.getSize(), 0),
  );
  readonly contentWidth = computed(() => this.leftWidth() + this.centerWidth() + this.rightWidth());
  readonly leftOffsets = computed(() => {
    let offset = this.selectionColumnWidth();
    const result = new Map<string, number>();
    for (const column of this.leftColumns()) {
      result.set(column.id, offset);
      offset += column.getSize();
    }
    return result;
  });
  readonly rightOffsets = computed(() => {
    let offset = 0;
    const result = new Map<string, number>();
    for (const column of [...this.rightColumns()].reverse()) {
      result.set(column.id, offset);
      offset += column.getSize();
    }
    return result;
  });

  readonly viewport = viewChild<ElementRef<HTMLDivElement>>('viewport');

  readonly rowVirtualizer = injectVirtualizer(() => ({
    scrollElement: this.viewport(),
    count: this.virtualRowCount(),
    estimateSize: () => this.rowHeight(),
    overscan: this.overscan(),
    getItemKey: (index) => this.tableRows()[index]?.id ?? `skeleton-${index}`,
  }));

  readonly columnVirtualizer = injectVirtualizer(() => ({
    scrollElement: this.viewport(),
    horizontal: true,
    count: this.centerColumns().length,
    estimateSize: (index) => this.centerColumns()[index]?.getSize() ?? 160,
    overscan: this.overscan(),
    getItemKey: (index) => this.centerColumns()[index]?.id ?? index,
  }));

  constructor() {
    this.destroyRef.onDestroy(() => this.resizeCleanup?.());
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['rows'] || changes['columns'] || changes['columnPinning']) {
      this.tanstack.setOptions((previous) => ({
        ...previous,
        data: this.rows() as T[],
        columns: this.tanstackColumns(),
        state: {
          ...previous.state,
          columnPinning: {
            start: [...(this.columnPinning().left ?? [])],
            end: [...(this.columnPinning().right ?? [])],
          },
        },
      }));
    }
  }

  setColumnPinning(pinning: UmbraTableColumnPinning): void {
    const next = {
      left: [...(pinning.left ?? [])],
      right: [...(pinning.right ?? [])],
    };
    this.columnPinning.set(next);
    this.tanstack.setColumnPinning({ start: next.left, end: next.right });
  }

  pinColumn(id: string, side: 'left' | 'right'): void {
    const current = this.columnPinning();
    const left = (current.left ?? []).filter((columnId) => columnId !== id);
    const right = (current.right ?? []).filter((columnId) => columnId !== id);
    (side === 'left' ? left : right).push(id);
    this.setColumnPinning({ left, right });
  }

  unpinColumn(id: string): void {
    this.setColumnPinning({
      left: (this.columnPinning().left ?? []).filter((columnId) => columnId !== id),
      right: (this.columnPinning().right ?? []).filter((columnId) => columnId !== id),
    });
  }

  columnSize(column: UmbraTableColumnInstance<T>): number {
    return column.getSize();
  }

  leftOffset(column: UmbraTableColumnInstance<T>): number {
    return this.leftOffsets().get(column.id) ?? this.selectionColumnWidth();
  }

  rightOffset(column: UmbraTableColumnInstance<T>): number {
    return this.rightOffsets().get(column.id) ?? 0;
  }

  cellFor(row: UmbraTableRow<T>, columnId: string): UmbraTableCell<T> | undefined {
    return row.getVisibleCells().find((cell) => cell.column.id === columnId);
  }

  cellContent(cell: UmbraTableCell<T>): UmbraTableCellContent<T, unknown> {
    const definition = this.columnDefinitions().get(cell.column.id);
    const context = {
      value: cell.getValue(),
      row: cell.row.original,
      column: definition,
    } as UmbraTableCellContext<T, unknown>;
    return definition?.cell?.(context) ?? context.value;
  }

  isTemplate(
    content: UmbraTableCellContent<T, unknown>,
  ): content is TemplateRef<{ $implicit: UmbraTableCellContext<T, unknown> }> {
    return content instanceof TemplateRef;
  }

  cellContext(cell: UmbraTableCell<T>): UmbraTableCellContext<T, unknown> {
    return {
      value: cell.getValue(),
      row: cell.row.original,
      column: this.columnDefinitions().get(cell.column.id)!,
    };
  }

  toggleAllRows(event: Event): void {
    this.tanstack.toggleAllRowsSelected((event.target as HTMLInputElement).checked);
  }

  captureSelectionModifiers(event: MouseEvent): void {
    this.pendingShiftSelection = event.shiftKey;
  }

  toggleRow(row: UmbraTableRow<T>, event: Event): void {
    const control = event.target as HTMLInputElement;
    const shiftKey = this.pendingShiftSelection;
    this.pendingShiftSelection = false;
    const rows = this.tableRows();
    const currentIndex = rows.findIndex((candidate) => candidate.id === row.id);
    const previousIndex = this.lastSelectedRowId
      ? rows.findIndex((candidate) => candidate.id === this.lastSelectedRowId)
      : -1;

    if (control.checked && shiftKey && previousIndex >= 0) {
      const start = Math.min(previousIndex, currentIndex);
      const end = Math.max(previousIndex, currentIndex);
      this.rowSelection.update((selection) => {
        const next = { ...selection };
        for (const selectedRow of rows.slice(start, end + 1)) next[selectedRow.id] = true;
        return next;
      });
    } else {
      row.toggleSelected(control.checked);
    }
    this.lastSelectedRowId = row.id;
  }

  startResize(column: UmbraTableColumnInstance<T>, event: PointerEvent): void {
    if (!this.resizable()) return;
    event.preventDefault();
    this.resizeCleanup?.();
    const startX = event.clientX;
    const startSize = column.getSize();
    const move = (moveEvent: PointerEvent) => {
      const nextSize = Math.max(
        column.columnDef.minSize ?? 40,
        Math.min(column.columnDef.maxSize ?? 1000, startSize + moveEvent.clientX - startX),
      );
      this.columnSizing.update((sizing) => ({
        ...sizing,
        [column.id]: nextSize,
      }));
    };
    const stop = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
      this.resizeCleanup = undefined;
    };
    this.resizeCleanup = stop;
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop, { once: true });
    window.addEventListener('pointercancel', stop, { once: true });
  }

  resizeByKey(column: UmbraTableColumnInstance<T>, event: KeyboardEvent): void {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const direction = event.key === 'ArrowRight' ? 1 : -1;
    const nextSize = column.getSize() + direction * 10;
    this.columnSizing.update((sizing) => ({
      ...sizing,
      [column.id]: Math.max(
        column.columnDef.minSize ?? 40,
        Math.min(column.columnDef.maxSize ?? 1000, nextSize),
      ),
    }));
  }

  onCellKeydown(
    event: KeyboardEvent,
    row: UmbraTableRow<T>,
    column: UmbraTableColumnInstance<T>,
  ): void {
    const keys = [
      'ArrowUp',
      'ArrowDown',
      'ArrowLeft',
      'ArrowRight',
      'Home',
      'End',
      'PageUp',
      'PageDown',
    ];
    if (!keys.includes(event.key)) return;
    const rows = this.tableRows();
    const columns = this.visibleColumns();
    const rowIndex = rows.findIndex((candidate) => candidate.id === row.id);
    const columnIndex = columns.findIndex((candidate) => candidate.id === column.id);
    let nextRow = rowIndex;
    let nextColumn = columnIndex;
    if (event.key === 'ArrowUp') nextRow--;
    if (event.key === 'ArrowDown') nextRow++;
    if (event.key === 'PageUp')
      nextRow -= Math.max(
        1,
        Math.floor(this.viewport()?.nativeElement.clientHeight / this.rowHeight()),
      );
    if (event.key === 'PageDown')
      nextRow += Math.max(
        1,
        Math.floor(this.viewport()?.nativeElement.clientHeight / this.rowHeight()),
      );
    if (event.key === 'ArrowLeft') nextColumn--;
    if (event.key === 'ArrowRight') nextColumn++;
    if (event.key === 'Home') nextColumn = 0;
    if (event.key === 'End') nextColumn = columns.length - 1;
    if (nextColumn < 0) {
      nextColumn = columns.length - 1;
      nextRow--;
    }
    if (nextColumn >= columns.length) {
      nextColumn = 0;
      nextRow++;
    }
    nextRow = Math.max(0, Math.min(rows.length - 1, nextRow));
    nextColumn = Math.max(0, Math.min(columns.length - 1, nextColumn));
    const targetRow = rows[nextRow];
    const targetColumn = columns[nextColumn];
    if (!targetRow || !targetColumn) return;
    event.preventDefault();
    this.focusCell(nextRow, targetColumn.id, targetRow.id);
  }

  private focusCell(rowIndex: number, columnId: string, rowId: string): void {
    this.focusedCell.set({ rowId, columnId });
    this.rowVirtualizer.scrollToIndex(rowIndex, { align: 'auto' });
    const centerIndex = this.centerColumns().findIndex((column) => column.id === columnId);
    if (centerIndex >= 0) this.columnVirtualizer.scrollToIndex(centerIndex, { align: 'auto' });
    queueMicrotask(() => {
      const target = [
        ...(this.viewport()?.nativeElement.querySelectorAll<HTMLElement>('[data-umbra-cell]') ??
          []),
      ].find(
        (element) => element.dataset['rowId'] === rowId && element.dataset['columnId'] === columnId,
      );
      target?.focus();
    });
  }

  isFocused(row: UmbraTableRow<T>, column: UmbraTableColumnInstance<T>): boolean {
    const focused = this.focusedCell();
    if (focused) return focused.rowId === row.id && focused.columnId === column.id;
    return this.tableRows()[0]?.id === row.id && this.visibleColumns()[0]?.id === column.id;
  }

  private update<TValue>(state: WritableSignal<TValue>, updater: Updater<TValue>): void {
    state.set(
      typeof updater === 'function' ? (updater as (value: TValue) => TValue)(state()) : updater,
    );
  }
}
