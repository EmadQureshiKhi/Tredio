/** The pieces of `text` around the first case-insensitive match of `query`, for highlighting it. */
export function matchParts(text: string, query: string): Array<{ text: string; hit: boolean }> {
  const q = query.trim().toLowerCase();
  const at = q ? text.toLowerCase().indexOf(q) : -1;
  if (at < 0) return [{ text, hit: false }];
  return [
    { text: text.slice(0, at), hit: false },
    { text: text.slice(at, at + q.length), hit: true },
    { text: text.slice(at + q.length), hit: false },
  ].filter((p) => p.text.length > 0);
}
