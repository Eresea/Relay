import { Observable } from 'rxjs';

export interface UmbraSelectRequest {
  query: string;
  cursor?: string;
  limit: number;
}

export interface UmbraSelectResult<T> {
  items: T[];
  nextCursor?: string;
}

export interface UmbraSelectDataSource<T, V> {
  search(request: UmbraSelectRequest): Observable<UmbraSelectResult<T>>;
  resolveByValue?(value: V): Observable<T | null>;
}

export type UmbraSelectWidthStrategy = 'trigger' | 'content' | 'full';

export interface UmbraSelectLabels {
  search: string;
  clear: string;
  loading: string;
  loadingMore: string;
  retry: string;
  noOptions: string;
  noResults: (query: string) => string;
  unableToLoad: string;
  unableToLoadMore: string;
  resultCount: (count: number) => string;
  additionalResults: (count: number) => string;
}

export interface UmbraSelectState<T> {
  query: string;
  items: T[];
  cursor?: string;
  hasMore: boolean;
  loadingInitial: boolean;
  loadingMore: boolean;
  searchError: unknown | null;
  paginationError: unknown | null;
}
