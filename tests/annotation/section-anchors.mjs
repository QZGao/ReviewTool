export function headingAnchors(source, parsed) {
  if (!Array.isArray(parsed.tocdata?.sections)) throw new Error('Missing section metadata.');
  // TOCData uses Unicode codepoints; the renderer's public positions use UTF-8 bytes.
  const bytes = [0];
  for (const character of source) bytes.push(bytes[bytes.length - 1] + Buffer.byteLength(character));
  const title = value => value?.replace(/_/g, ' ').trim();
  return parsed.tocdata.sections.flatMap(section => {
    if (title(section.fromTitle) !== title(parsed.title) || !Number.isInteger(section.codepointOffset) || section.codepointOffset < 0) return [];
    const start = bytes[section.codepointOffset];
    if (start === undefined) throw new Error('Section offset is outside the source revision.');
    return [{ unit: 'utf8-byte', start, level: section.hLevel, id: section.anchor }];
  });
}
