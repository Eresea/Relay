import './inline-text.css';

/**
 * Notification text with its `code` spans set as code, the way producers
 * write details ("Run `npm test`"). Nothing else is interpreted, so a detail
 * can never inject markup.
 */
export function InlineText({ text }: { text: string }) {
  return (
    <>
      {text.split(/(`[^`]+`)/).map((part, index) =>
        part.length > 2 && part.startsWith('`') && part.endsWith('`') ? (
          <code key={index} className="inline-code">
            {part.slice(1, -1)}
          </code>
        ) : (
          part
        ),
      )}
    </>
  );
}
