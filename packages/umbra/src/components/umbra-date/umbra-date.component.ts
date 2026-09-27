import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  input,
  model,
  output,
  QueryList,
  signal,
  TemplateRef,
  ViewChild,
  ViewChildren,
  ViewContainerRef,
} from '@angular/core';
import { Overlay, OverlayRef } from '@angular/cdk/overlay';
import { TemplatePortal } from '@angular/cdk/portal';
import type { FormValueControl } from '@angular/forms/signals';
import {
  addMonths,
  eachDayOfInterval,
  endOfMonth,
  endOfWeek,
  format,
  isSameMonth,
  isToday,
  isValid,
  parse,
  parseISO,
  startOfMonth,
  startOfWeek,
  subMonths,
} from 'date-fns';

type CalendarView = 'days' | 'months' | 'years';

let nextId = 0;

@Component({
  selector: 'umbra-date',
  standalone: true,
  templateUrl: './umbra-date.component.html',
  styleUrl: './umbra-date.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UmbraDateComponent implements FormValueControl<string | null> {
  readonly value = model<string | null>(null);
  readonly label = input('');
  readonly placeholder = input('DD/MM/YYYY');
  readonly hint = input<string>();
  readonly error = input<string>();
  readonly name = input('');
  readonly inputId = input<string>();
  readonly ariaLabel = input<string>();
  readonly disabled = input(false);
  readonly readonly = input(false);
  readonly required = input(false);
  readonly showClear = input(false);
  readonly touch = output<void>();

  @ViewChildren('segment') private segments?: QueryList<ElementRef<HTMLInputElement>>;
  @ViewChild('calendarTrigger') private calendarTrigger?: ElementRef<HTMLButtonElement>;
  @ViewChild('calendarTemplate') private calendarTemplate?: TemplateRef<unknown>;

  readonly id = `umbra-date-${nextId++}`;
  readonly calendarId = `${this.id}-calendar`;
  readonly controlId = computed(() => this.inputId() ?? this.id);
  readonly hintId = `${this.id}-hint`;
  readonly errorId = `${this.id}-error`;
  readonly day = signal('');
  readonly month = signal('');
  readonly year = signal('');
  readonly placeholderParts = computed(() => {
    const [day = 'DD', month = 'MM', year = 'YYYY'] = this.placeholder().split('/');
    return [day, month, year];
  });
  readonly invalidText = signal(false);
  readonly wasTouched = signal(false);
  readonly open = signal(false);
  readonly viewDate = signal(new Date());
  readonly calendarView = signal<CalendarView>('days');
  readonly weekdays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  readonly months = Array.from({ length: 12 }, (_, month) =>
    format(new Date(2020, month, 1), 'MMMM'),
  );
  readonly yearRange = computed(() => {
    const start = Math.floor(this.viewDate().getFullYear() / 10) * 10;
    return Array.from({ length: 10 }, (_, offset) => start + offset).filter(
      (year) => year >= 1 && year <= 9999,
    );
  });
  readonly yearRangeLabel = computed(() => {
    const years = this.yearRange();
    return `${years[0]}–${years[years.length - 1]}`;
  });
  readonly monthLabel = computed(() => this.months[this.viewDate().getMonth()]);
  readonly yearLabel = computed(() =>
    this.calendarView() === 'years' ? this.yearRangeLabel() : String(this.viewDate().getFullYear()),
  );
  readonly canGoPrevious = computed(() => {
    const date = this.viewDate();
    switch (this.calendarView()) {
      case 'days':
        return date.getFullYear() > 1 || date.getMonth() > 0;
      case 'months':
        return date.getFullYear() > 1;
      case 'years':
        return this.yearRange()[0] > 1;
    }
  });
  readonly canGoNext = computed(() => {
    const date = this.viewDate();
    switch (this.calendarView()) {
      case 'days':
        return date.getFullYear() < 9999 || date.getMonth() < 11;
      case 'months':
        return date.getFullYear() < 9999;
      case 'years':
        return this.yearRange()[this.yearRange().length - 1] < 9999;
    }
  });

  readonly calendarDays = computed(() => {
    const start = startOfWeek(startOfMonth(this.viewDate()), { weekStartsOn: 1 });
    const end = endOfWeek(endOfMonth(this.viewDate()), { weekStartsOn: 1 });

    return eachDayOfInterval({ start, end }).map((date) => {
      const selected = this.value() === format(date, 'yyyy-MM-dd');
      return {
        date,
        outsideMonth: !isSameMonth(date, this.viewDate()),
        today: isToday(date),
        selected,
        ariaLabel: `${format(date, 'EEEE, MMMM d, yyyy')}${selected ? ', selected' : ''}`,
      };
    });
  });
  readonly resolvedError = computed(
    () =>
      this.error() ||
      (this.invalidText() ? 'Enter a valid date in DD/MM/YYYY format.' : '') ||
      (this.wasTouched() && this.required() && !this.value() ? 'Choose a date.' : ''),
  );
  readonly describedBy = computed(() =>
    this.resolvedError() ? this.errorId : this.hint() ? this.hintId : null,
  );
  readonly calendarTriggerLabel = computed(() =>
    this.label() ? `Open calendar for ${this.label()}` : 'Open calendar',
  );

  private readonly destroyRef = inject(DestroyRef);
  private readonly overlay = inject(Overlay);
  private readonly viewContainerRef = inject(ViewContainerRef);
  private overlayRef?: OverlayRef;

  constructor() {
    this.destroyRef.onDestroy(() => this.overlayRef?.dispose());
    effect(() => {
      const value = this.value();
      if (value === this.lastValue) return;
      this.lastValue = value;
      const date = value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? parseISO(value) : null;
      if (date && isValid(date) && format(date, 'yyyy-MM-dd') === value) {
        this.setSegments(format(date, 'dd/MM/yyyy'));
        this.setViewDate(date);
      } else {
        this.setSegments('');
      }
    });
  }

  onSegmentInput(event: Event, index: number): void {
    const target = event.target as HTMLInputElement;
    const limit = index === 2 ? 4 : 2;
    const segment = target.value.replace(/\D/g, '').slice(0, limit);
    target.value = segment;
    this.setSegment(index, segment);
    this.invalidText.set(false);

    const date = this.parseSegments();
    this.setValue(date ? format(date, 'yyyy-MM-dd') : null);
    if (date) this.viewDate.set(date);
    if (segment.length === limit && index < 2) this.focusSegment(index + 1);
  }

  onSegmentKeydown(event: KeyboardEvent, index: number): void {
    const input = event.target as HTMLInputElement;
    if (event.key === '/' || event.key === '-') {
      event.preventDefault();
    } else if (event.key === 'Backspace' && !input.value && index > 0) {
      event.preventDefault();
      this.focusSegment(index - 1);
    } else if (event.key === 'ArrowLeft' && input.selectionStart === 0 && index > 0) {
      event.preventDefault();
      this.focusSegment(index - 1);
    } else if (
      event.key === 'ArrowRight' &&
      input.selectionEnd === input.value.length &&
      index < 2
    ) {
      event.preventDefault();
      this.focusSegment(index + 1);
    } else if (event.altKey && event.key === 'ArrowDown') {
      event.preventDefault();
      this.openCalendar();
    }
  }

  onSegmentFocus(event: FocusEvent): void {
    (event.target as HTMLInputElement).select();
  }

  onSegmentPaste(event: ClipboardEvent): void {
    const pasted = event.clipboardData?.getData('text').trim();
    const match = pasted?.match(/^(\d{2})[./-](\d{2})[./-](\d{4})$/);
    if (!match) return;
    event.preventDefault();
    this.setSegments(`${match[1]}/${match[2]}/${match[3]}`);
    this.invalidText.set(false);
    const date = this.parseSegments();
    this.setValue(date ? format(date, 'yyyy-MM-dd') : null);
    if (date) this.viewDate.set(date);
    this.focusSegment(2);
  }

  onControlBlur(event: FocusEvent): void {
    const next = event.relatedTarget;
    if (
      this.open() ||
      (next instanceof Node && (event.currentTarget as HTMLElement).contains(next))
    )
      return;
    this.wasTouched.set(true);
    this.invalidText.set(this.hasSegments() && !this.parseSegments());
    this.touch.emit();
  }

  openCalendar(): void {
    if (this.disabled() || this.readonly() || this.open()) return;
    const value = this.value();
    const date = value ? parseISO(value) : null;
    this.setViewDate(date && isValid(date) ? date : new Date());
    this.calendarView.set('days');

    const trigger = this.calendarTrigger?.nativeElement;
    const template = this.calendarTemplate;
    if (!trigger || !template) return;

    const styles = getComputedStyle(trigger);
    const gap = this.tokenPixels(styles, '--space-3');
    const margin = this.tokenPixels(styles, '--space-4');
    const below = {
      originX: 'end' as const,
      originY: 'bottom' as const,
      overlayX: 'end' as const,
      overlayY: 'top' as const,
      offsetY: gap,
    };
    const positionStrategy = this.overlay
      .position()
      .flexibleConnectedTo(trigger)
      .withPositions([below])
      .withPush(true)
      .withViewportMargin(margin);
    const width = Math.min(
      this.tokenPixels(styles, '--space-32') * 4,
      window.innerWidth - 2 * margin,
    );
    const overlayRef = this.overlay.create({
      positionStrategy,
      scrollStrategy: this.overlay.scrollStrategies.reposition(),
      panelClass: 'umbra-date-overlay',
      width,
    });
    this.overlayRef = overlayRef;
    overlayRef.attach(new TemplatePortal(template, this.viewContainerRef));
    let openingClick = true;
    queueMicrotask(() => (openingClick = false));
    overlayRef.outsidePointerEvents().subscribe(() => {
      if (!openingClick) this.dismissCalendar();
    });
    this.open.set(true);
  }

  showMonths(): void {
    this.calendarView.set('months');
  }

  showYears(): void {
    this.calendarView.set('years');
  }

  previousPeriod(): void {
    if (!this.canGoPrevious()) return;
    const date = this.viewDate();
    switch (this.calendarView()) {
      case 'days':
        this.setViewDate(subMonths(date, 1));
        break;
      case 'months':
        this.setViewYear(date.getFullYear() - 1);
        break;
      case 'years':
        this.setViewYear(this.yearRange()[0] - 10);
        break;
    }
  }

  nextPeriod(): void {
    if (!this.canGoNext()) return;
    const date = this.viewDate();
    switch (this.calendarView()) {
      case 'days':
        this.setViewDate(addMonths(date, 1));
        break;
      case 'months':
        this.setViewYear(date.getFullYear() + 1);
        break;
      case 'years':
        this.setViewYear(this.yearRange()[0] + 10);
        break;
    }
  }

  selectYear(year: number): void {
    this.setViewYear(year);
    this.calendarView.set('months');
  }

  selectMonth(month: number): void {
    const date = new Date(this.viewDate());
    date.setFullYear(date.getFullYear(), month, 1);
    this.setViewDate(date);
    this.calendarView.set('days');
  }

  selectDate(date: Date): void {
    this.setValue(format(date, 'yyyy-MM-dd'));
    this.setSegments(format(date, 'dd/MM/yyyy'));
    this.invalidText.set(false);
    this.closeCalendar();
  }

  selectToday(): void {
    this.selectDate(new Date());
  }

  clearDate(): void {
    this.setValue(null);
    this.setSegments('');
    this.invalidText.set(false);
    this.dismissCalendar();
    this.focusInput();
  }

  closeCalendar(event?: KeyboardEvent): void {
    event?.preventDefault();
    event?.stopPropagation();
    this.dismissCalendar();
    this.focusInput();
  }

  private dismissCalendar(): void {
    this.open.set(false);
    this.overlayRef?.dispose();
    this.overlayRef = undefined;
  }

  private focusInput(): void {
    this.segments?.first?.nativeElement.focus();
  }

  private focusSegment(index: number): void {
    this.segments?.get(index)?.nativeElement.focus();
  }

  private setSegments(text: string): void {
    const [day = '', month = '', year = ''] = text.split('/');
    this.day.set(day);
    this.month.set(month);
    this.year.set(year);
  }

  private setSegment(index: number, value: string): void {
    [this.day, this.month, this.year][index].set(value);
  }

  private hasSegments(): boolean {
    return !!(this.day() || this.month() || this.year());
  }

  private parseSegments(): Date | null {
    const text = `${this.day()}/${this.month()}/${this.year()}`;
    if (!/^\d{2}\/\d{2}\/\d{4}$/.test(text)) return null;
    const date = parse(text, 'dd/MM/yyyy', new Date(2000, 0, 1));
    return isValid(date) && format(date, 'dd/MM/yyyy') === text ? date : null;
  }

  private setViewDate(date: Date): void {
    this.viewDate.set(date);
  }

  private setViewYear(year: number): void {
    const date = new Date(this.viewDate());
    date.setFullYear(Math.max(1, Math.min(9999, year)), date.getMonth(), 1);
    this.setViewDate(date);
  }

  private lastValue: string | null = null;

  private setValue(value: string | null): void {
    this.lastValue = value;
    this.value.set(value);
  }

  private tokenPixels(styles: CSSStyleDeclaration, token: string): number {
    const value = Number.parseFloat(styles.getPropertyValue(token));
    return Number.isFinite(value) ? value : 0;
  }
}
