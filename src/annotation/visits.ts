export interface AnnotationVisit {
  pageName: string;
  oldid: number;
  subscribed: boolean;
  viewedRevision?: number;
}

/** One key per article revision avoids overwriting unrelated subscriptions from another tab. */
export function annotationVisits(storage: Storage, scope: string) {
  const prefix = `reviewtool-annotation-visits/${scope}/`;
  const get = (oldid: number): AnnotationVisit | undefined => {
    const text = storage.getItem(prefix + oldid);
    if (!text) return undefined;
    const value = JSON.parse(text) as AnnotationVisit;
    if (value.oldid !== oldid || typeof value.pageName !== 'string' || typeof value.subscribed !== 'boolean'
      || (value.viewedRevision !== undefined && (!Number.isSafeInteger(value.viewedRevision) || value.viewedRevision < 0))) throw new Error('Invalid annotation visit record.');
    return value;
  };
  const update = (pageName: string, oldid: number, patch: Partial<AnnotationVisit>) => {
    if (!Number.isSafeInteger(oldid) || oldid < 1) throw new Error('Invalid annotation revision.');
    const previous = get(oldid);
    storage.setItem(prefix + oldid, JSON.stringify({ subscribed: false, ...previous, ...patch, pageName, oldid }));
  };
  return {
    prefix, get,
    subscriptions(): AnnotationVisit[] {
      const found: AnnotationVisit[] = [];
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);
        if (!key?.startsWith(prefix)) continue;
        const oldid = Number(key.slice(prefix.length));
        if (!Number.isSafeInteger(oldid) || oldid < 1) continue;
        const value = get(oldid);
        if (value?.subscribed) found.push(value);
      }
      return found;
    },
    subscribe(pageName: string, oldid: number, subscribed: boolean) { update(pageName, oldid, { subscribed }); },
    viewed(pageName: string, oldid: number, revision: number) {
      if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('Invalid viewed data revision.');
      update(pageName, oldid, { viewedRevision: Math.max(get(oldid)?.viewedRevision ?? 0, revision) });
    },
  };
}
export type AnnotationVisits = ReturnType<typeof annotationVisits>;
