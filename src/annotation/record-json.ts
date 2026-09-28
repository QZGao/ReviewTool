/** Deterministic JSON: property order never changes a record's identity. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalJson((value as Record<string, unknown>)[key])).join(',') + '}';
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('Undefined values are not record data.');
  return encoded;
}

/** Native parsing checks JSON syntax; the second pass rejects even escaped duplicate keys. */
export function parseRecordJson(text: string): unknown {
  const result: unknown = JSON.parse(text);
  let at = 0;
  const space = () => { while (/\s/.test(text[at] ?? '') && at < text.length) at++; };
  const string = (): string => {
    const start = at++;
    while (at < text.length) { if (text[at++] === '"') break; if (text[at - 1] === '\\') at++; }
    return JSON.parse(text.slice(start, at)) as string;
  };
  const value = (depth: number): void => {
    if (depth > 100) throw new Error('Annotation JSON nesting is too deep.');
    space();
    if (text[at] === '{') {
      at++; space(); const keys = new Set<string>();
      while (text[at] !== '}') {
        const key = string(); if (keys.has(key)) throw new Error(`Duplicate JSON key: ${key}`); keys.add(key);
        space(); at++; value(depth + 1); space();
        if (text[at] !== ',') break; at++; space();
      }
      at++;
    } else if (text[at] === '[') {
      at++; space();
      while (text[at] !== ']') { value(depth + 1); space(); if (text[at] !== ',') break; at++; }
      at++;
    } else if (text[at] === '"') string();
    else while (at < text.length && !/[\s,}\]]/.test(text[at])) at++;
  };
  value(0); return result;
}
