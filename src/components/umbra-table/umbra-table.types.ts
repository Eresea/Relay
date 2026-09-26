import { TemplateRef } from "@angular/core";

export type UmbraTablePath<T> = T extends object
  ? {
      [K in keyof T & string]: T[K] extends readonly unknown[]
        ? K
        : T[K] extends object
          ? K | `${K}.${UmbraTablePath<T[K]>}`
          : K;
    }[keyof T & string]
  : never;

export type UmbraTablePrimitive =
  string | number | boolean | bigint | null | undefined;

export type UmbraTablePathValue<
  T,
  P extends string,
> = P extends `${infer K}.${infer Rest}`
  ? K extends keyof T
    ? UmbraTablePathValue<T[K], Rest>
    : never
  : P extends keyof T
    ? T[P]
    : never;

export interface UmbraTableCellContext<T, TValue> {
  readonly value: TValue;
  readonly row: T;
  readonly column: UmbraTableColumn<T, TValue>;
}

export type UmbraTableCellContent<T, TValue> =
  | TValue
  | UmbraTablePrimitive
  | TemplateRef<{ $implicit: UmbraTableCellContext<T, TValue> }>;

export type UmbraTableCellRenderer<T, TValue> = (
  context: UmbraTableCellContext<T, TValue>,
) => UmbraTableCellContent<T, TValue>;

export type UmbraTableFilter<TValue> = (
  value: TValue,
  filterValue: unknown,
) => boolean;

export interface UmbraTableColumnOptions<T, TValue> {
  readonly id?: string;
  readonly title?: string;
  readonly width?: number;
  readonly minWidth?: number;
  readonly maxWidth?: number;
  readonly sortable?: boolean;
  readonly pinnable?: boolean;
  readonly filter?: UmbraTableFilter<TValue>;
  readonly sorter?: (left: TValue, right: TValue) => number;
  readonly cell?: UmbraTableCellRenderer<T, TValue>;
}

export interface UmbraTableColumnDefinition<T, TValue> {
  readonly id: string;
  readonly title: string;
  readonly accessor: (row: T) => TValue;
  readonly width: number;
  readonly minWidth: number;
  readonly maxWidth: number;
  readonly sortable: boolean;
  readonly pinnable: boolean;
  readonly filter?: UmbraTableFilter<TValue>;
  readonly sorter?: (left: TValue, right: TValue) => number;
  readonly cell?: UmbraTableCellRenderer<T, TValue>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type UmbraTableColumn<T, TValue = any> = UmbraTableColumnDefinition<
  T,
  TValue
>;

export interface UmbraTableColumnPinning {
  readonly left?: readonly string[];
  readonly right?: readonly string[];
}

function titleFromPath(path: string): string {
  const value = path.split(".").at(-1) ?? path;
  return value
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^./, (character) => character.toUpperCase());
}

export function column<T, P extends UmbraTablePath<T> = UmbraTablePath<T>>(
  path: P,
  options: UmbraTableColumnOptions<T, UmbraTablePathValue<T, P>> = {},
): UmbraTableColumnDefinition<T, UmbraTablePathValue<T, P>> {
  return {
    id: options.id ?? path,
    title: options.title ?? titleFromPath(path),
    accessor: (row) =>
      path.split(".").reduce<unknown>((value, key) => {
        if (value == null || typeof value !== "object" || !(key in value))
          return undefined;
        return (value as Record<string, unknown>)[key];
      }, row) as UmbraTablePathValue<T, P>,
    width: options.width ?? 160,
    minWidth: options.minWidth ?? 80,
    maxWidth: options.maxWidth ?? 600,
    sortable: options.sortable ?? true,
    pinnable: options.pinnable ?? true,
    filter: options.filter,
    sorter: options.sorter,
    cell: options.cell,
  };
}

export function accessorColumn<T, TValue>(
  id: string,
  accessor: (row: T) => TValue,
  options: Omit<UmbraTableColumnOptions<T, TValue>, "id"> = {},
): UmbraTableColumnDefinition<T, TValue> {
  return {
    id,
    title: options.title ?? titleFromPath(id),
    accessor,
    width: options.width ?? 160,
    minWidth: options.minWidth ?? 80,
    maxWidth: options.maxWidth ?? 600,
    sortable: options.sortable ?? true,
    pinnable: options.pinnable ?? true,
    filter: options.filter,
    sorter: options.sorter,
    cell: options.cell,
  };
}

export function defineColumns<T>(
  columns: readonly UmbraTableColumn<T>[],
): readonly UmbraTableColumn<T>[] {
  return columns;
}

export function textFilter(): UmbraTableFilter<unknown> {
  return (value, filterValue) =>
    String(value ?? "")
      .toLocaleLowerCase()
      .includes(String(filterValue ?? "").toLocaleLowerCase());
}

export function equalsFilter<TValue>(): UmbraTableFilter<TValue> {
  return (value, filterValue) => value === filterValue;
}

export function numberFilter(
  operator: "eq" | "gt" | "gte" | "lt" | "lte" = "eq",
): UmbraTableFilter<number | null | undefined> {
  return (value, filterValue) => {
    if (value == null || filterValue == null || filterValue === "")
      return false;
    const left = Number(value);
    const right = Number(filterValue);
    if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
    return operator === "gt"
      ? left > right
      : operator === "gte"
        ? left >= right
        : operator === "lt"
          ? left < right
          : operator === "lte"
            ? left <= right
            : left === right;
  };
}
