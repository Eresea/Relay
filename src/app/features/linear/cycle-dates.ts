const parts = (date: Date, timeZone: string): Record<string, number> =>
  Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)]),
  );

export function cycleDateInTimezone(value: string, timeZone?: string | null): string {
  if (!value) return '';
  const { year, month, day } = parts(new Date(value), timeZone || 'America/Los_Angeles');
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function cycleDateToIso(value: string, timeZone?: string | null): string {
  const [year, month, day] = value.split('-').map(Number);
  const target = Date.UTC(year, month - 1, day);
  const zone = timeZone || 'America/Los_Angeles';
  let instant = target;
  for (let attempt = 0; attempt < 3; attempt++) {
    const local = parts(new Date(instant), zone);
    instant +=
      target -
      Date.UTC(
        local['year'],
        local['month'] - 1,
        local['day'],
        local['hour'],
        local['minute'],
        local['second'],
      );
  }
  return new Date(instant).toISOString();
}

export function todayInTimezone(timeZone?: string | null): string {
  return cycleDateInTimezone(new Date().toISOString(), timeZone);
}
