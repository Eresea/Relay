import { Component, ViewEncapsulation, signal } from '@angular/core';
import { defineChart } from '@tanstack/charts';
import { pie, polar, radialArc } from '@tanstack/charts/polar';
import { of } from 'rxjs';

import { UmbraAlertComponent } from '@umbra/components/umbra-alert/umbra-alert.component';
import { UmbraBadgeComponent } from '@umbra/components/umbra-badge/umbra-badge.component';
import { UmbraButtonComponent } from '@umbra/components/umbra-button/umbra-button.component';
import { UmbraCardComponent } from '@umbra/components/umbra-card/umbra-card.component';
import { UmbraChartComponent } from '@umbra/components/umbra-chart/umbra-chart.component';
import { UmbraCheckboxComponent } from '@umbra/components/umbra-checkbox/umbra-checkbox.component';
import { UmbraDateComponent } from '@umbra/components/umbra-date/umbra-date.component';
import { UmbraDialogComponent } from '@umbra/components/umbra-dialog/umbra-dialog.component';
import { UmbraDrawerComponent } from '@umbra/components/umbra-drawer/umbra-drawer.component';
import { UmbraEmptyStateComponent } from '@umbra/components/umbra-empty-state/umbra-empty-state.component';
import { UmbraEntityRowComponent } from '@umbra/components/umbra-entity-row/umbra-entity-row.component';
import { UmbraEntityTileComponent } from '@umbra/components/umbra-entity-tile/umbra-entity-tile.component';
import { UmbraFileInputComponent } from '@umbra/components/umbra-file-input/umbra-file-input.component';
import { UmbraGlassPanelComponent } from '@umbra/components/umbra-glass-panel/umbra-glass-panel.component';
import { UmbraInputComponent } from '@umbra/components/umbra-input/umbra-input.component';
import { UmbraKbdComponent } from '@umbra/components/umbra-kbd/umbra-kbd.component';
import { UmbraMenuComponent, type UmbraMenuItem } from '@umbra/components/umbra-menu/umbra-menu.component';
import { UmbraMetricTileComponent } from '@umbra/components/umbra-metric-tile/umbra-metric-tile.component';
import { UmbraNavItemComponent } from '@umbra/components/umbra-nav-rail/umbra-nav-item.component';
import { UmbraNavRailComponent } from '@umbra/components/umbra-nav-rail/umbra-nav-rail.component';
import { UmbraPopoverComponent } from '@umbra/components/umbra-popover/umbra-popover.component';
import { UmbraProgressComponent } from '@umbra/components/umbra-progress/umbra-progress.component';
import {
  UmbraRadioGroupComponent,
  type UmbraRadioOption,
} from '@umbra/components/umbra-radio-group/umbra-radio-group.component';
import { UmbraSelectComponent } from '@umbra/components/umbra-select/umbra-select.component';
import type { UmbraSelectDataSource } from '@umbra/components/umbra-select/umbra-select.types';
import { UmbraSeparatorComponent } from '@umbra/components/umbra-separator/umbra-separator.component';
import { UmbraSkeletonComponent } from '@umbra/components/umbra-skeleton/umbra-skeleton.component';
import { UmbraSliderComponent } from '@umbra/components/umbra-slider/umbra-slider.component';
import { UmbraStatusDotComponent, type UmbraStatus } from '@umbra/components/umbra-status-dot/umbra-status-dot.component';
import { UmbraSwitchComponent } from '@umbra/components/umbra-switch/umbra-switch.component';
import { UmbraTableComponent } from '@umbra/components/umbra-table/umbra-table.component';
import { column, defineColumns } from '@umbra/components/umbra-table/umbra-table.types';
import { UmbraTabsComponent, type UmbraTab } from '@umbra/components/umbra-tabs/umbra-tabs.component';
import { UmbraTextareaComponent } from '@umbra/components/umbra-textarea/umbra-textarea.component';
import { UmbraTimelineComponent } from '@umbra/components/umbra-timeline/umbra-timeline.component';
import { UmbraToastComponent } from '@umbra/components/umbra-toast/umbra-toast.component';
import { UmbraTooltipDirective } from '@umbra/components/umbra-tooltip/umbra-tooltip.component';

interface Service {
  name: string;
  region: string;
  owner: string;
  requests: number;
  latency: string;
  uptime: string;
}

interface Option {
  id: string;
  name: string;
}

const OPTIONS: Option[] = [
  { id: 'eu', name: 'Frankfurt' },
  { id: 'us', name: 'Virginia' },
  { id: 'ap', name: 'Singapore' },
  { id: 'sa', name: 'São Paulo' },
];

const SERVICES: Service[] = Array.from({ length: 24 }, (_, index) => ({
  name: ['Gateway', 'Billing', 'Search', 'Mail relay', 'Scheduler', 'Vault'][index % 6] + ` ${index + 1}`,
  region: OPTIONS[index % 4].name,
  owner: ['Platform', 'Payments', 'Core'][index % 3],
  requests: 4128 + index * 317,
  latency: `${40 + index * 3} ms`,
  uptime: `${(99.9 - index * 0.01).toFixed(2)}%`,
}));

const CHART_ROWS = [
  { id: 'gateway', value: 42 },
  { id: 'billing', value: 28 },
  { id: 'search', value: 18 },
  { id: 'vault', value: 12 },
];

@Component({
  selector: 'umbra-gallery',
  standalone: true,
  encapsulation: ViewEncapsulation.None,
  imports: [
    UmbraAlertComponent,
    UmbraBadgeComponent,
    UmbraButtonComponent,
    UmbraCardComponent,
    UmbraChartComponent,
    UmbraCheckboxComponent,
    UmbraDateComponent,
    UmbraDialogComponent,
    UmbraDrawerComponent,
    UmbraEmptyStateComponent,
    UmbraEntityRowComponent,
    UmbraEntityTileComponent,
    UmbraFileInputComponent,
    UmbraGlassPanelComponent,
    UmbraInputComponent,
    UmbraKbdComponent,
    UmbraMenuComponent,
    UmbraMetricTileComponent,
    UmbraNavItemComponent,
    UmbraNavRailComponent,
    UmbraPopoverComponent,
    UmbraProgressComponent,
    UmbraRadioGroupComponent,
    UmbraSelectComponent,
    UmbraSeparatorComponent,
    UmbraSkeletonComponent,
    UmbraSliderComponent,
    UmbraStatusDotComponent,
    UmbraSwitchComponent,
    UmbraTableComponent,
    UmbraTabsComponent,
    UmbraTextareaComponent,
    UmbraTimelineComponent,
    UmbraToastComponent,
    UmbraTooltipDirective,
  ],
  styleUrl: './gallery.component.scss',
  templateUrl: './gallery.component.html',
})
export class GalleryComponent {
  readonly dialogOpen = signal(false);
  readonly drawerOpen = signal(false);
  readonly popoverOpen = signal(false);

  readonly tab = signal('overview');
  readonly tabs: UmbraTab[] = [
    { value: 'overview', label: 'Overview' },
    { value: 'activity', label: 'Activity', count: 12 },
    { value: 'settings', label: 'Settings' },
    { value: 'archive', label: 'Archive', disabled: true },
  ];

  readonly statuses: UmbraStatus[] = ['running', 'waiting', 'blocked', 'done', 'idle'];
  readonly hues = ['indigo', 'violet', 'cyan', 'emerald', 'amber', 'orange', 'rose'] as const;

  readonly menuItems: UmbraMenuItem[] = [
    { id: 'open', label: 'Open', shortcut: 'Ctrl K' },
    { id: 'rename', label: 'Rename' },
    { id: 'share', label: 'Share', disabled: true },
    { id: 'delete', label: 'Delete', destructive: true },
  ];

  readonly radioOptions: UmbraRadioOption[] = [
    { value: 'daily', label: 'Daily', hint: 'Runs at 02:00 UTC.' },
    { value: 'weekly', label: 'Weekly' },
    { value: 'manual', label: 'Manual', disabled: true },
  ];

  readonly dataSource: UmbraSelectDataSource<Option, string> = {
    search: ({ query }) =>
      of({ items: OPTIONS.filter((option) => option.name.toLowerCase().includes(query.toLowerCase())) }),
    resolveByValue: (value) => of(OPTIONS.find((option) => option.id === value) ?? null),
  };
  readonly displayOption = (option: Option): string => option.name;
  readonly valueOption = (option: Option): string => option.id;
  readonly disableOption = (option: Option): boolean => option.id === 'sa';

  readonly services = SERVICES;
  readonly noServices: Service[] = [];
  readonly columns = defineColumns<Service>([
    column<Service>('name', { width: 180 }),
    column<Service>('region', { width: 150 }),
    column<Service>('owner', { width: 140 }),
    column<Service>('requests', { width: 120 }),
    column<Service>('latency', { width: 120 }),
    column<Service>('uptime', { width: 120 }),
  ]);
  readonly serviceId = (row: Service): string => row.name;

  readonly events = [
    { id: 1, when: 'Today', time: '09:41', title: 'Deploy finished', note: '4,128 files · 2m 14s' },
    { id: 2, when: 'Today', time: '08:03', title: 'Backup verified', note: '12.4 GB' },
    { id: 3, when: 'Yesterday', time: '22:17', title: 'Certificate renewed', note: 'Expires in 89 days' },
  ];
  readonly eventKey = (event: { id: number }): number => event.id;
  readonly eventGroup = (event: { when: string }): string => event.when;

  readonly chart = defineChart(
    {
      marks: [
        polar({
          inset: 8,
          radiusRatio: 0.86,
          marks: [
            radialArc(pie(CHART_ROWS, { value: 'value' }), {
              innerRadius: ({ radius }) => radius * 0.58,
              cornerRadius: 3,
              color: 'id',
              key: 'id',
              strokeWidth: 1,
            }),
          ],
        }),
      ],
      color: { domain: CHART_ROWS.map((row) => row.id), range: ['#6aa6ff', '#a78bfa', '#22d3ee', '#34d399'] },
    },
    { focus: 'nearest', focusRing: false, pointer: true, keyboard: false },
  );
}
