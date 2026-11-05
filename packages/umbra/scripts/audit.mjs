#!/usr/bin/env node
// Enforces docs/design-system.md against the source. No dependencies: node scripts/audit.mjs
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const walk = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
const rel = (path) => relative(root, path).split(sep).join('/');
const line = (text, index) => text.slice(0, index).split('\n').length;

const tokenFiles = walk(join(root, 'src/styles/umbra')).filter((f) => f.endsWith('.scss'));
const componentFiles = walk(join(root, 'src/components')).filter((f) => /\.(scss|ts|html)$/.test(f) && !f.endsWith('.spec.ts'));
const sources = Object.fromEntries([...tokenFiles, ...componentFiles].map((f) => [f, readFileSync(f, 'utf8')]));
const scss = Object.entries(sources).filter(([f]) => f.endsWith('.scss'));
const componentScss = scss.filter(([f]) => componentFiles.includes(f) || f.endsWith('_recipes.scss'));
// Inline `styles:` blocks count as stylesheets too.
const inlineStyles = Object.entries(sources).flatMap(([f, text]) =>
  f.endsWith('.ts') ? [...text.matchAll(/styles:\s*`([\s\S]*?)`/g)].map((m) => [f, m[1]]) : [],
);
const allComponentCss = [...componentScss, ...inlineStyles];

const findings = {};
const report = (rule, where, detail) => (findings[rule] ??= []).push(`${where}  ${detail}`);
const scan = (entries, regex, rule, detail = (m) => m[0]) => {
  for (const [file, text] of entries) {
    for (const m of text.matchAll(regex)) report(rule, `${rel(file)}:${line(text, m.index)}`, detail(m));
  }
};

// 1. Every var() resolves to a token or to a property the same library sets.
const defined = new Set();
for (const text of Object.values(sources)) {
  for (const m of text.matchAll(/(--[a-z0-9-]+)\s*:/gi)) defined.add(m[1]);
  for (const m of text.matchAll(/\[style\.(--[a-z0-9-]+)\]/gi)) defined.add(m[1]);
  for (const m of text.matchAll(/@property\s+(--[a-z0-9-]+)/gi)) defined.add(m[1]);
}
for (const [file, text] of Object.entries(sources)) {
  for (const m of text.matchAll(/var\((--[a-z0-9-]+)/gi)) {
    if (!defined.has(m[1]) && !m[1].endsWith('-')) report('undefined-token', `${rel(file)}:${line(text, m.index)}`, m[1]);
  }
}

// 2. One styling dialect: consumers do not need any utility-class framework.
const utilityClass = /(?:^|[\s"'`])(?:\[&|\[font:|(?:hover:|focus-visible:|data-\[[^\]]+\]:|max-md:|motion-reduce:)*(?:bg|text|border|rounded|shadow|gap|flex|grid|inline-flex|justify|min-w|max-w|w|h|size|px|py|p|m|mt|mb|ms|me|shrink|truncate|overflow|whitespace)(?:-[\w[\]()/%.:,_-]+)?|items-(?:start|center|end|baseline|stretch)|select-(?:none|text|all|auto))(?=[\s"'`])/;
for (const [file, text] of Object.entries(sources)) {
  if (!/\.(ts|html)$/.test(file)) continue;
  for (const m of text.matchAll(/\bclass="([^"]*)"|class:\s*(?:'([^']*)'|`([^`]*)`)|'\[class\.([^\]]+)\]'/g)) {
    const value = (m[1] ?? m[2] ?? m[3] ?? m[4] ?? '').trim();
    const hasUtility = value.split(/\s+/).some((token) => utilityClass.test(` ${token} `) && !/^umbra-/.test(token));
    if (hasUtility) report('utility-classes', `${rel(file)}:${line(text, m.index)}`, value.slice(0, 60));
  }
}

// 3. Stylesheets draw from tokens.
const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' ')).replace(/\/\/.*$/gm, (c) => ' '.repeat(c.length));
const cleanCss = allComponentCss.map(([f, t]) => [f, stripComments(t)]);
scan(cleanCss, /(?<![\w-])\d*\.?\d+px\b/g, 'hard-coded-px');
scan(cleanCss, /#[0-9a-f]{3,8}\b(?![\w-])|rgba?\(/gi, 'hard-coded-colour');
scan(cleanCss, /(?<![\w-])\d+m?s\b/g, 'hard-coded-duration');
scan(cleanCss, /cursor:\s*pointer/g, 'cursor-pointer');
scan(cleanCss, /opacity:\s*0?\.\d+/g, 'literal-disabled-opacity');
scan(cleanCss, /!important/g, 'important');

// 4. Focus: one treatment for controls, one for fields.
for (const [file, text] of cleanCss) {
  for (const m of text.matchAll(/[^{}]*:focus(?:-visible|-within)?[^{}]*\{([^{}]*)\}/g)) {
    const shadow = m[1].match(/box-shadow:\s*([^;]+)/)?.[1];
    if (shadow && !/--focus-(ring|field)|--focus-ring-inset|\$shadow/.test(shadow)) report('focus-recipe', `${rel(file)}:${line(text, m.index)}`, shadow.trim());
  }
}

// 5. The documented contrast floor, computed from the tokens themselves.
const parseTokens = (block) => Object.fromEntries([...block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)].map((m) => [m[1], m[2].trim()]));
const tokenText = tokenFiles.filter((f) => !f.endsWith('_recipes.scss')).map((f) => stripComments(sources[f])).join('\n');
const blocks = (selector) => [...tokenText.matchAll(selector)].map((m) => m[1]);
const darkTokens = Object.assign({}, ...blocks(/:root\s*\{([^}]*)\}/g).map(parseTokens));
const lightTokens = { ...darkTokens, ...Object.assign({}, ...blocks(/:root\.light,\s*\[data-theme="light"\]\s*\{([^}]*)\}/g).map(parseTokens)) };
const parseColour = (value, tokens) => {
  const v = value.trim();
  const ref = v.match(/^var\((--[a-z0-9-]+)\)$/i);
  if (ref) return parseColour(tokens[ref[1]], tokens);
  const hex = v.match(/^#([0-9a-f]{3,8})$/i);
  if (hex) {
    const h = hex[1].length === 3 ? [...hex[1]].map((c) => c + c).join('') : hex[1];
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)).concat(1);
  }
  const rgba = v.match(/^rgba?\(([^)]+)\)$/);
  if (rgba) {
    const [r, g, b, a = 1] = rgba[1].split(',').map(Number);
    return [r, g, b, a];
  }
  const mix = v.match(/^color-mix\(in srgb,\s*(var\(--[^)]+\)|#[0-9a-f]+)(?:\s+(\d+)%)?,\s*(var\(--[^)]+\)|#[0-9a-f]+|transparent)(?:\s+(\d+)%)?\)$/i);
  if (mix) {
    const left = parseColour(mix[1], tokens);
    const right = mix[3] === 'transparent' ? [0, 0, 0, 0] : parseColour(mix[3], tokens);
    const p = mix[2] ? Number(mix[2]) / 100 : mix[4] ? 1 - Number(mix[4]) / 100 : 0.5;
    const alpha = left[3] * p + right[3] * (1 - p);
    const channel = (i) => (alpha === 0 ? 0 : (left[i] * left[3] * p + right[i] * right[3] * (1 - p)) / alpha);
    return [channel(0), channel(1), channel(2), alpha];
  }
  throw new Error(`Cannot parse colour: ${value}`);
};
const over = (top, bottom) => [0, 1, 2].map((i) => top[i] * top[3] + bottom[i] * (1 - top[3])).concat(1);
const luminance = (c) => {
  const [r, g, b] = c.slice(0, 3).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const text45 = ['--text-body', '--text-muted', '--text-subtle', '--danger-text', '--success-text', '--warning-text'];
const surfaces = ['--bg-app', '--bg-sunken', '--surface-card', '--surface-raised', '--surface-overlay'];
const pairs = [
  ...text45.flatMap((fg) => surfaces.map((bg) => [fg, bg, 4.5])),
  ...['--danger-quiet', '--success-quiet', '--warning-quiet'].flatMap((quiet) => ['--text-body', '--text-muted'].map((fg) => [fg, quiet, 4.5, '--bg-app'])),
  ['--primary-text', '--primary', 4.5],
  ['--text-inverted', '--danger', 4.5],
  ['--text-inverted', '--danger-hover', 4.5],
  ['--primary-text', '--primary-hover', 4.5],
  ['--text-link', '--bg-app', 4.5],
  ...['--border-control', '--status-running', '--status-waiting', '--status-blocked', '--status-done', '--status-idle'].flatMap((fg) => [[fg, '--bg-app', 3], [fg, '--bg-sunken', 3], [fg, '--surface-card', 3]]),
  ...['--bg-app', '--bg-sunken', '--surface-card'].map((bg) => ['--track', bg, 1.4]),
];
for (const [theme, tokens] of [['dark', darkTokens], ['light', lightTokens]]) {
  for (const [fg, bg, floor, base] of pairs) {
    if (!tokens[fg] || !tokens[bg]) {
      report('contrast', theme, `${fg} on ${bg}: token missing`);
      continue;
    }
    const baseColour = parseColour(`var(${base ?? '--bg-app'})`, tokens);
    const background = over(parseColour(`var(${bg})`, tokens), baseColour);
    const foreground = over(parseColour(`var(${fg})`, tokens), background);
    const value = ratio(foreground, background);
    if (value < floor) report('contrast', theme, `${fg} on ${bg}: ${value.toFixed(2)} < ${floor}`);
  }
}

// 6. Light must mirror every semantic token that dark sets for a theme-sensitive role.
const themed = /^--(bg|surface|text|border|primary|danger|success|warning|accent|ring|scrim|status|entity|glass|track)/;
for (const key of Object.keys(darkTokens).filter((k) => themed.test(k))) {
  const usesTheme = /var\(--(zinc|bg|surface|text)/.test(darkTokens[key]) || /^(#|rgba?\()/.test(darkTokens[key]);
  const mirrored = blocks(/:root\.light,\s*\[data-theme="light"\]\s*\{([^}]*)\}/g).some((b) => new RegExp(`${key}\\s*:`).test(b));
  if (usesTheme && !mirrored && !/^--glass-(blur|saturate)/.test(key)) report('theme-parity', key, 'no light value');
}

// 7. Every component has a documented contract.
const docs = readFileSync(join(root, 'docs/components.md'), 'utf8');
for (const dir of readdirSync(join(root, 'src/components'))) {
  if (!docs.includes(`\`${dir}\``)) report('undocumented', dir, 'missing from docs/components.md');
}

// 8. Strings that promise something the consumer's app must supply.
scan(Object.entries(sources).filter(([f]) => /\.(ts|html)$/.test(f)), /material-symbols[\w-]*/g, 'host-icon-font');

const rules = Object.keys(findings).sort();
const verbose = process.argv.includes('--verbose');
let total = 0;
for (const rule of rules) {
  total += findings[rule].length;
  console.log(`${String(findings[rule].length).padStart(4)}  ${rule}`);
  if (verbose) for (const item of findings[rule]) console.log(`      ${item}`);
}
console.log(total === 0 ? 'Audit clean.' : `${total} findings.`);
process.exitCode = total === 0 ? 0 : 1;
