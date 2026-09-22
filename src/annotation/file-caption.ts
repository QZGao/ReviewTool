import { bracketExtent, opaqueAt, readTag, tagExtent } from './opaque';
import type { SourceExtent } from './types';

// Standard image options and their Chinese Wikipedia aliases. Captions are the last other field.
const flags = new Set([
  'thumb', 'thumbnail', '缩略图', '縮圖', 'frame', 'framed', 'enframed', '有框',
  'frameless', '无框', '無框', 'border', '边框', '邊框', 'right', '右', 'left', '左',
  'center', 'centre', '居中', '置中', 'none', '无', '無', 'baseline', '基线',
  'sub', '子', '下標', 'super', 'sup', '超', '上標', 'top', '顶部', '垂直置頂',
  'text-top', '文字顶部', '文字置頂', 'middle', '中间', '垂直置中',
  'bottom', '底部', '垂直置底', 'text-bottom', '文字底部', '文字置底',
  'upright', '右上', '替代文字',
]);
const parameter = /^(?:alt|替代|替代文本|link|链接|連結|class|类|類別|lang|语言|語言|thumb|thumbnail|缩略图|縮圖|upright|右上|page|页数|頁|lossy|thumbtime|start|end)\s*=/;

function isOption(value: string): boolean {
  return flags.has(value) || parameter.test(value)
    || /^(?:\d+(?:x\d+)?|x\d+)(?:px|像素)$/.test(value)
    || /^(?:page\s+\d+|\d+[页頁]|upright\s+\d+(?:\.\d+)?|右上\s*\d+(?:\.\d+)?)$/.test(value);
}

/** Find the effective caption without splitting pipes inside nested wikitext or tag bodies. */
export function fileCaption(source: string, from: number, to: number): SourceExtent | null {
  let caption: SourceExtent | null = null;
  let start = from;
  const field = (end: number) => {
    if (!isOption(source.slice(start, end).trim())) caption = { from: start, to: end };
  };
  for (let cursor = from; cursor < to;) {
    const opaque = opaqueAt(source, cursor);
    const tag = source[cursor] === '<' ? readTag(source, cursor) : null;
    const next = opaque?.end ?? (source.startsWith('[[', cursor) ? bracketExtent(source, cursor)
      : tag ? tagExtent(source, cursor, tag) : cursor);
    if (next > to) return null;
    if (next > cursor) { cursor = next; continue; }
    if (source[cursor] === '|') { field(cursor); start = cursor + 1; }
    cursor++;
  }
  field(to);
  return caption;
}
