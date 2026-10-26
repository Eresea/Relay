import { useState } from 'react';

import { cn } from '@/lib/utils';

import { AppPopover, PopoverContent, PopoverTrigger } from './app-popover';
import { Icon } from './icon';
import './icon-picker.css';

const PROJECT_ICONS = [
  'circle',
  'folder',
  'house',
  'library',
  'inbox',
  'file-text',
  'star',
  'square',
  'command',
  'eye',
  'lock',
  'settings',
  'search',
  'download',
  'clock',
  'info',
  'circle-check',
  'circle-alert',
  'triangle-alert',
  'pencil',
  'copy',
  'plus',
  'sun',
  'moon',
  'trash-2',
  'panel-left',
  'arrow-left',
  'ellipsis',
  'x',
] as const;

function iconLabel(icon: string): string {
  return icon
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

/** Picks a project's icon from a filterable grid. */
export function IconPicker({
  value = 'folder',
  label = 'Choose project icon',
  onValueChange,
}: {
  value?: string;
  label?: string;
  onValueChange: (icon: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const needle = query.trim().toLowerCase();
  const icons = needle
    ? PROJECT_ICONS.filter((icon) => icon.includes(needle) || iconLabel(icon).includes(needle))
    : PROJECT_ICONS;

  return (
    <span className="icon-picker">
      <AppPopover open={open} onOpenChange={setOpen}>
        <PopoverTrigger>
          <button type="button" className="trigger" aria-label={label} title={label}>
            <Icon name={value} size={16} />
          </button>
        </PopoverTrigger>
        <PopoverContent className="picker">
          <div className="picker-header">
            <p className="picker-title">Project icon</p>
            <button
              type="button"
              className="clear-button"
              disabled={!query}
              onClick={() => setQuery('')}
            >
              Clear
            </button>
          </div>

          <label className="search-field">
            <Icon name="search" size={14} />
            <input
              type="search"
              value={query}
              placeholder="Filter icons"
              aria-label="Filter project icons"
              onChange={(event) => setQuery(event.currentTarget.value)}
            />
          </label>

          {icons.length > 0 ? (
            <div className="icon-grid" role="listbox" aria-label="Project icons">
              {icons.map((icon) => (
                <button
                  key={icon}
                  type="button"
                  className={cn('icon-option', icon === value && 'selected')}
                  role="option"
                  aria-selected={icon === value}
                  aria-label={iconLabel(icon)}
                  title={iconLabel(icon)}
                  onClick={() => {
                    onValueChange(icon);
                    setOpen(false);
                  }}
                >
                  <Icon name={icon} size={16} />
                </button>
              ))}
            </div>
          ) : (
            <p className="empty">No matching icons</p>
          )}
        </PopoverContent>
      </AppPopover>
    </span>
  );
}
