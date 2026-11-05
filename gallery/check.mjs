// Runs against the built gallery in a real browser: node check.mjs
// Set UMBRA_BROWSER to a Playwright channel ("chrome", "msedge"); the default is msedge.
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { chromium } from 'playwright-core';

const require = createRequire(import.meta.url);
const axeSource = await readFile(require.resolve('axe-core/axe.min.js'), 'utf8');
const dist = new URL('dist/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' };
const server = createServer(async (request, response) => {
  const path = new URL(request.url, 'http://gallery').pathname;
  try {
    const body = await readFile(join(dist, path === '/' ? 'index.html' : path));
    response.writeHead(200, { 'content-type': types[extname(path) || '.html'] ?? 'application/octet-stream' }).end(body);
  } catch {
    response.writeHead(404).end();
  }
}).listen(0);
const base = `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch({ channel: process.env.UMBRA_BROWSER ?? 'msedge', headless: true });

let failures = 0;
const check = async (name, run) => {
  try {
    await run();
    console.log(`pass  ${name}`);
  } catch (error) {
    failures++;
    console.log(`FAIL  ${name}\n      ${String(error.message ?? error).split('\n')[0]}`);
  }
};
const equal = (actual, expected, what) => {
  if (actual !== expected) throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
};
const open = async (theme = 'dark', width = 1280) => {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  await page.goto(`${base}?theme=${theme}`);
  await page.waitForSelector('umbra-gallery h1');
  return page;
};
const activeLabel = (page) => page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.textContent?.trim());

for (const theme of ['dark', 'light']) {
  await check(`no axe violations (${theme})`, async () => {
    const page = await open(theme);
    await page.waitForTimeout(400);
    await page.addScriptTag({ content: axeSource });
    const { violations } = await page.evaluate(() => window.axe.run(document, { resultTypes: ['violations'] }));
    await page.close();
    const summary = violations.map((v) => `${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(', ')}`);
    equal(summary.join(' | '), '', 'violations');
  });
}

await check('controls on one row share a height and a top edge', async () => {
  const page = await open();
  const boxes = await page.evaluate(() =>
    [...document.querySelectorAll('#align-row > *')].map((host) => {
      const box = (host.querySelector('.field, .select-trigger, .date-control, button') ?? host).getBoundingClientRect();
      return `${box.top}/${box.height}`;
    }),
  );
  await page.close();
  equal(new Set(boxes).size, 1, `tops and heights ${boxes.join(', ')}`);
});

await check('no horizontal overflow at 420px', async () => {
  const page = await open('dark', 420);
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  await page.close();
  equal(width, 420, 'scroll width');
});

await check('a title input leaves no native tooltip on the host', async () => {
  const page = await open();
  const count = await page.locator('umbra-alert[title], umbra-card[title], umbra-toast[title], umbra-empty-state[title]').count();
  await page.close();
  equal(count, 0, 'hosts with a title attribute');
});

await check('invalid fields stay red on hover', async () => {
  const page = await open();
  const field = page.locator('[data-c=fields] umbra-input:nth-of-type(2) .field');
  const danger = await page.evaluate(() => {
    const probe = document.createElement('div');
    probe.style.color = 'var(--danger)';
    document.body.append(probe);
    const value = getComputedStyle(probe).color;
    probe.remove();
    return value;
  });
  await field.hover();
  await page.waitForTimeout(200);
  const border = await field.evaluate((el) => getComputedStyle(el).borderTopColor);
  await page.close();
  equal(border, danger, 'border colour');
});

await check('radios group natively, so arrow keys move the selection', async () => {
  const page = await open();
  const group = page.locator('umbra-radio-group').first();
  await group.locator('input').first().focus();
  await page.keyboard.press('ArrowDown');
  equal(await group.locator('input').nth(1).isChecked(), true, 'second radio checked');
  await page.close();
});

await check('calendar: focus moves in, arrow keys rove, Enter picks, Escape returns focus', async () => {
  const page = await open();
  const date = page.locator('[data-c=fields] umbra-date').first();
  await date.locator('.date-calendar-trigger').click();
  await page.waitForSelector('.calendar');
  await page.waitForTimeout(100);
  const start = await activeLabel(page);
  if (!/\d/.test(start ?? '')) throw new Error(`focus did not reach a day: ${start}`);
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(50);
  if ((await activeLabel(page)) === start) throw new Error('ArrowRight did not move focus');
  equal(await page.locator('.calendar-day[tabindex="0"]').count(), 1, 'tab stops in the grid');
  const period = await page.locator('.calendar-period').innerText();
  await page.keyboard.press('PageDown');
  await page.waitForTimeout(50);
  if ((await page.locator('.calendar-period').innerText()) === period) throw new Error('PageDown did not change month');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(50);
  equal(await page.locator('.calendar').count(), 0, 'calendars open after Escape');
  equal(await page.evaluate(() => document.activeElement?.classList.contains('date-segment')), true, 'focus back on the field');
  await date.locator('.date-calendar-trigger').click();
  await page.waitForTimeout(100);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(50);
  if (!(await date.locator('.date-segment-year').inputValue())) throw new Error('Enter did not pick a date');
  await page.close();
});

await check('menu: roving tab stop, typeahead, disabled items skipped', async () => {
  const page = await open();
  const menu = page.locator('umbra-menu');
  await menu.locator('button').first().focus();
  await page.keyboard.press('r');
  equal(await activeLabel(page), 'Rename', 'typeahead target');
  await page.waitForTimeout(50);
  equal((await menu.locator('button[tabindex="0"]').innerText()).trim(), 'Rename', 'tab stop follows focus');
  await page.keyboard.press('ArrowDown');
  equal(await activeLabel(page), 'Delete', 'skips the disabled item');
  await page.close();
});

await check('tooltip: waits on hover, Escape dismisses without moving the pointer', async () => {
  const page = await open();
  await page.locator('#tip button').hover();
  await page.waitForTimeout(100);
  equal(await page.locator('umbra-tooltip-panel').count(), 0, 'tooltips during the delay');
  await page.waitForTimeout(600);
  equal(await page.locator('umbra-tooltip-panel').count(), 1, 'tooltips after the delay');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(50);
  equal(await page.locator('umbra-tooltip-panel').count(), 0, 'tooltips after Escape');
  await page.close();
});

await check('dialog: Escape closes and focus returns to the trigger', async () => {
  const page = await open();
  const trigger = page.locator('#open-dialog button');
  await trigger.click();
  await page.waitForSelector('.dialog-panel');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(100);
  equal(await page.locator('.dialog-panel').count(), 0, 'dialogs open');
  equal(await trigger.evaluate((el) => el === document.activeElement), true, 'trigger focused');
  await page.close();
});

await check('tabs: arrow keys skip disabled tabs and select', async () => {
  const page = await open();
  const tabs = page.locator('umbra-tabs').first();
  await tabs.locator('button').nth(2).click();
  await tabs.locator('button').nth(2).focus();
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(50);
  equal(await tabs.locator('button[aria-selected="true"]').innerText(), 'Overview', 'wraps past Archive');
  await page.close();
});

await check('password field toggles visibility and its accessible name', async () => {
  const page = await open();
  const field = page.locator('umbra-input[type="password"], [data-c=fields] umbra-input:nth-of-type(3)').first();
  const toggle = field.locator('.action');
  equal(await toggle.getAttribute('aria-label'), 'Show password', 'name before');
  await toggle.click();
  equal(await field.locator('input').getAttribute('type'), 'text', 'type after');
  equal(await toggle.getAttribute('aria-label'), 'Hide password', 'name after');
  await page.close();
});

await check('select: keyboard opens it, focus reaches search, Enter picks, focus returns', async () => {
  const page = await open();
  const select = page.locator('[data-c=fields] umbra-select').first();
  const trigger = select.locator('.select-trigger');
  await trigger.focus();
  await page.keyboard.press('ArrowDown');
  await page.waitForSelector('.select-panel');
  await page.waitForTimeout(100);
  equal(await page.evaluate(() => document.activeElement?.classList.contains('select-search')), true, 'focus in search');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(100);
  equal(await page.locator('.select-panel').count(), 0, 'panels open');
  equal(await trigger.evaluate((el) => el === document.activeElement), true, 'trigger focused');
  if ((await select.locator('.select-value').innerText()) === 'Choose a region') throw new Error('nothing was selected');
  await page.close();
});

await check('selected segmented tab shows a focus ring', async () => {
  const page = await open();
  const tab = page.locator('umbra-tabs[data-variant=segmented] button[aria-selected=true]');
  await tab.focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  await page.waitForTimeout(200);
  const shadow = await tab.evaluate((el) => getComputedStyle(el).boxShadow);
  await page.close();
  if (!shadow.includes('inset')) throw new Error(`box-shadow: ${shadow}`);
});

await check('link buttons take no fill on hover', async () => {
  const page = await open();
  const link = page.locator('umbra-button[variant=link] button, [data-c=button] button[data-variant=link]').first();
  await link.hover();
  await page.waitForTimeout(200);
  const background = await link.evaluate((el) => getComputedStyle(el).backgroundColor);
  await page.close();
  equal(background, 'rgba(0, 0, 0, 0)', 'hover background');
});

await check('calendar: choosing a month or year keeps focus inside', async () => {
  const page = await open();
  await page.locator('[data-c=fields] umbra-date .date-calendar-trigger').first().click();
  await page.waitForSelector('.calendar');
  await page.locator('.calendar-period-button').first().click();
  await page.locator('.calendar-choice').nth(5).click();
  await page.waitForTimeout(100);
  equal(await page.evaluate(() => !!document.activeElement?.closest('.calendar')), true, 'focus in calendar');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(50);
  equal(await page.locator('.calendar').count(), 0, 'calendars open after Escape');
  await page.close();
});

await check('an empty table says so inside the visible area at 420px', async () => {
  const page = await open('dark', 420);
  const table = page.locator('umbra-table').last();
  await table.scrollIntoViewIfNeeded();
  const message = table.locator('.umbra-table__empty [role=gridcell]');
  const [box, frame] = await Promise.all([message.boundingBox(), table.boundingBox()]);
  await page.close();
  if (box.x < frame.x || box.x + box.width > frame.x + frame.width) throw new Error(`message at ${box.x}, table ${frame.x}-${frame.x + frame.width}`);
});

await check('table: Space selects the focused row, and row checkboxes are not tab stops', async () => {
  const page = await open();
  const table = page.locator('umbra-table').first();
  equal(await table.locator('.umbra-table__row input').first().getAttribute('tabindex'), '-1', 'checkbox tabindex');
  await table.locator('.umbra-table__data-cell').first().focus();
  await page.keyboard.press('Space');
  await page.waitForTimeout(50);
  equal(await table.locator('.umbra-table__row').first().getAttribute('aria-selected'), 'true', 'row selected');
  await page.close();
});

await check('dialog and drawer: a heading names the panel, and its close button works', async () => {
  const page = await open();
  await page.locator('#open-dialog button').click();
  const dialog = page.locator('.dialog-panel');
  await dialog.waitFor();
  const heading = await dialog.locator('h2').getAttribute('id');
  equal(await dialog.getAttribute('aria-labelledby'), heading, 'dialog labelled by heading');
  await dialog.locator('.overlay-close').click();
  await page.waitForTimeout(100);
  equal(await page.locator('.dialog-panel').count(), 0, 'dialogs open');
  await page.locator('#open-drawer button').click();
  const drawer = page.locator('.drawer-panel');
  await drawer.waitFor();
  equal(await drawer.getAttribute('aria-labelledby'), await drawer.locator('h2').getAttribute('id'), 'drawer labelled by heading');
  await drawer.locator('.overlay-close').click();
  await page.waitForTimeout(100);
  equal(await page.locator('.drawer-panel').count(), 0, 'drawers open');
  await page.close();
});

await check('drawer opens on its first field, not on Close', async () => {
  const page = await open();
  await page.locator('#open-drawer button').click();
  await page.waitForSelector('.drawer-panel');
  await page.waitForTimeout(100);
  equal(await page.evaluate(() => document.activeElement?.tagName), 'INPUT', 'focused element');
  await page.close();
});

await check('table: Shift+Space extends the selected range', async () => {
  const page = await open();
  const table = page.locator('umbra-table').first();
  const cells = table.locator('.umbra-table__data-cell[data-column-id=name]');
  await cells.nth(0).focus();
  await page.keyboard.press('Space');
  await cells.nth(2).focus();
  await page.keyboard.press('Shift+Space');
  await page.waitForTimeout(50);
  equal(await table.locator('.umbra-table__row[aria-selected=true]').count(), 3, 'rows selected');
  await page.close();
});

await browser.close();
server.close();
console.log(failures === 0 ? 'All checks passed.' : `${failures} checks failed.`);
process.exitCode = failures === 0 ? 0 : 1;
