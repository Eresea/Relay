import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  effect,
  input,
  output,
  viewChild,
} from '@angular/core';
import { mountChart } from '@tanstack/charts/dom';
import type {
  ChartHost,
  ChartHostOptions,
  ChartPoint,
  DomChartDefinition,
} from '@tanstack/charts';

@Component({
  selector: 'umbra-chart',
  standalone: true,
  template: '<div #host class="umbra-chart-host"></div>',
  styles: `
    :host { display: block; min-width: 0; }
    .umbra-chart-host { min-width: 0; width: 100%; }
    .umbra-chart-host svg { display: block; max-width: 100%; }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UmbraChartComponent implements OnDestroy {
  readonly definition = input.required<DomChartDefinition<any, any, any>>();
  readonly ariaLabel = input.required<string>();
  readonly ariaDescription = input<string>();
  readonly height = input.required<number>();
  readonly className = input('');
  readonly focusChange = output<ChartPoint | null>();

  private readonly host = viewChild<ElementRef<HTMLDivElement>>('host');
  private chart?: ChartHost<any, any, any>;

  constructor() {
    effect(() => {
      const container = this.host()?.nativeElement;
      if (!container) return;

      const options: ChartHostOptions<any, any, any> = {
        definition: this.definition(),
        ariaLabel: this.ariaLabel(),
        ariaDescription: this.ariaDescription(),
        height: this.height(),
        className: this.className(),
        onFocusChange: (point) => this.focusChange.emit(point),
      };

      if (this.chart) {
        this.chart.update(options);
      } else {
        this.chart = mountChart(container, options);
      }
    });
  }

  ngOnDestroy(): void {
    this.chart?.destroy();
  }
}
