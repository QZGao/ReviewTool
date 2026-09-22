/** Coordinate conversion never normalizes line endings, Unicode, or whitespace. */
export class SourceIndex {
  private readonly bytes: number[] = [0];
  private readonly positions: number[] = [0];
  readonly byteLength: number;

  constructor(readonly source: string) {
    let offset = 0;
    let byteOffset = 0;
    for (const character of source) {
      const code = character.charCodeAt(0);
      if (character.length === 1 && code >= 0xd800 && code <= 0xdfff) {
        throw new RangeError('Source contains an unpaired UTF-16 surrogate.');
      }
      offset += character.length;
      byteOffset += character.length === 2 ? 4 : code <= 0x7f ? 1 : code <= 0x7ff ? 2 : 3;
      this.positions.push(offset);
      this.bytes.push(byteOffset);
    }
    this.byteLength = byteOffset;
  }

  toByte(utf16Offset: number): number {
    return this.lookup(this.positions, this.bytes, utf16Offset, 'UTF-16');
  }

  toUtf16(byteOffset: number): number {
    return this.lookup(this.bytes, this.positions, byteOffset, 'UTF-8');
  }

  private lookup(keys: number[], values: number[], offset: number, unit: string): number {
    if (!Number.isInteger(offset)) throw new RangeError(`${unit} offset must be an integer.`);
    let low = 0;
    let high = keys.length - 1;
    while (low <= high) {
      const middle = (low + high) >>> 1;
      const key = keys[middle];
      if (key === offset) return values[middle];
      if (key < offset) low = middle + 1;
      else high = middle - 1;
    }
    throw new RangeError(`${unit} offset is outside the source or splits a Unicode scalar.`);
  }
}

export function scalarBoundary(text: string, offset: number, side: 'start' | 'end'): number {
  const before = text.charCodeAt(offset - 1);
  const after = text.charCodeAt(offset);
  const splitsPair = before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
  return splitsPair ? offset + (side === 'start' ? -1 : 1) : offset;
}
