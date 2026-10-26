import DOMPurify from 'dompurify';
import { marked } from 'marked';

import './markdown.css';

const cache = new Map<string, string>();

/**
 * Agent-written Markdown as HTML, sanitized before it reaches the DOM.
 * ponytail: the cache only grows; bound it if transcripts ever get huge.
 */
export function renderMarkdown(text: string): string {
  const cached = cache.get(text);
  if (cached !== undefined) return cached;
  const safe = DOMPurify.sanitize(marked.parse(text, { async: false }));
  cache.set(text, safe);
  return safe;
}
