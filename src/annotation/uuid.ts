const canonicalUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const compactShape = /^[A-Za-z0-9_-]{22}$/;

/** Encode the 16 bytes in UUID text order, retaining every version and variant bit. */
export function compactUuid(uuid: string): string {
  const canonical = uuid.toLowerCase();
  if (!canonicalUuid.test(canonical)) throw new Error('Invalid UUID.');
  const hex = canonical.replace(/-/g, '');
  let bytes = '';
  for (let i = 0; i < hex.length; i += 2) bytes += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
  return btoa(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function expandUuid(compact: string): string {
  // Only two bits of the final character carry data; require zero padding bits.
  if (!compactShape.test(compact) || !/[AQgw]$/.test(compact)) throw new Error('Invalid compact UUID.');
  const bytes = atob(compact.replace(/-/g, '+').replace(/_/g, '/') + '==');
  const hex = Array.from(bytes, char => char.charCodeAt(0).toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Opaque legacy IDs remain supported; escape literals that could be confused with compact UUIDs. */
export function encodeId(id: string): string {
  if (canonicalUuid.test(id)) return compactUuid(id);
  return id.startsWith('~') || compactShape.test(id) ? '~' + id : id;
}

export function decodeId(id: string): string {
  if (id.startsWith('~')) return id.slice(1);
  return compactShape.test(id) ? expandUuid(id) : id;
}

/** Links accept both published UUID spellings; models always receive canonical UUID text. */
export function commentIdFromUrl(id: string | null): string | null {
  if (!id) return null;
  if (canonicalUuid.test(id.toLowerCase())) return id.toLowerCase();
  try { return decodeId(id); } catch { return null; }
}
