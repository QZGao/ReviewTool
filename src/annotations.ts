import state from './state';

export interface Annotation {
    id: string;
    sectionPath: string;
    sentencePos: string;
    sentenceText: string;
    opinion: string;
    createdBy: string;
    createdAt: number;
    resolved?: boolean;
}

export interface AnnotationStore {
    pageName: string;
    createdAt: number;
    annotations: Annotation[];
}

export interface AnnotationGroup {
    sectionPath: string;
    annotations: Annotation[];
}

const KEY_PREFIX = 'reviewtool:annotations:';

function storageKeyForPage(pageName: string): string {
    return KEY_PREFIX + (pageName || 'unknown');
}

function getStorage(type: 'local' | 'session'): Storage | null {
    if (typeof window === 'undefined') return null;
    try {
        return type === 'local' ? window.localStorage : window.sessionStorage;
    } catch (e) {
        console.error(`[ReviewTool] ${type}Storage unavailable`, e);
        return null;
    }
}

function createEmptyStore(pageName: string): AnnotationStore {
    return {
        pageName,
        createdAt: Date.now(),
        annotations: []
    };
}

function uuidv4(): string {
    // simple UUIDv4 generator
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        const v = c === 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
    });
}

export function loadAnnotations(pageName: string): AnnotationStore {
    const key = storageKeyForPage(pageName);
    const localStore = getStorage('local');
    const sessionStore = getStorage('session');
    let raw: string | null = null;
    let source: 'local' | 'session' | null = null;

    if (localStore) {
        try {
            raw = localStore.getItem(key);
            if (raw) source = 'local';
        } catch (e) {
            console.error('[ReviewTool] failed to read annotations from localStorage', e);
        }
    }

    if (!raw && sessionStore) {
        try {
            raw = sessionStore.getItem(key);
            if (raw) source = 'session';
        } catch (e) {
            console.error('[ReviewTool] failed to read annotations from sessionStorage', e);
        }
    }

    if (!raw) {
        return createEmptyStore(pageName);
    }

    let parsed: AnnotationStore | null = null;
    try {
        parsed = JSON.parse(raw) as AnnotationStore;
    } catch (e) {
        console.warn('[ReviewTool] failed to parse annotations payload', e);
        return createEmptyStore(pageName);
    }

    const annotations = Array.isArray(parsed?.annotations)
        ? parsed.annotations.map((anno: any) => ({
            ...anno,
            sentencePos: typeof anno?.sentencePos === 'string' ? anno.sentencePos : ''
        }))
        : [];

    const normalized: AnnotationStore = {
        pageName: parsed?.pageName || pageName,
        createdAt: parsed?.createdAt || Date.now(),
        annotations
    };

    if (source === 'session' && localStore) {
        try {
            localStore.setItem(key, JSON.stringify(normalized));
            sessionStore?.removeItem(key);
        } catch (e) {
            console.error('[ReviewTool] failed to migrate annotations from sessionStorage to localStorage', e);
        }
    }

    return normalized;
}

export function saveAnnotations(store: AnnotationStore): void {
    const key = storageKeyForPage(store.pageName);
    const payload = JSON.stringify(store);
    const localStore = getStorage('local');
    if (localStore) {
        try {
            localStore.setItem(key, payload);
            return;
        } catch (e) {
            console.error('[ReviewTool] failed to save annotations to localStorage', e);
        }
    }

    const sessionStore = getStorage('session');
    if (sessionStore) {
        try {
            sessionStore.setItem(key, payload);
        } catch (e) {
            console.error('[ReviewTool] failed to save annotations to sessionStorage fallback', e);
        }
    } else {
        console.error('[ReviewTool] no available storage to save annotations');
    }
}

export function createAnnotation(
    pageName: string,
    sectionPath: string,
    sentenceText: string,
    opinion: string,
    sentencePos = ''
): Annotation {
    const store = loadAnnotations(pageName);
    const normalizedSectionPath = sectionPath === '目次' ? '序言' : sectionPath;
    const anno: Annotation = {
        id: uuidv4(),
        sectionPath: normalizedSectionPath,
        sentencePos,
        sentenceText,
        opinion,
        createdBy: state.userName || 'unknown',
        createdAt: Date.now(),
        resolved: false
    };
    store.annotations.push(anno);
    saveAnnotations(store);
    return anno;
}

export function getAnnotationsForSection(pageName: string, sectionPath: string): Annotation[] {
    const store = loadAnnotations(pageName);
    return store.annotations.filter(a => a.sectionPath === sectionPath);
}

export function getAnnotation(pageName: string, id: string): Annotation | null {
    const store = loadAnnotations(pageName);
    return store.annotations.find(a => a.id === id) || null;
}

export function updateAnnotation(
    pageName: string,
    id: string,
    updates: Partial<Pick<Annotation, 'opinion' | 'sentenceText' | 'resolved' | 'sentencePos'>>
): Annotation | null {
    const store = loadAnnotations(pageName);
    const idx = store.annotations.findIndex(a => a.id === id);
    if (idx === -1) return null;
    const updated = { ...store.annotations[idx], ...updates } as Annotation;
    store.annotations[idx] = updated;
    saveAnnotations(store);
    return updated;
}

export function deleteAnnotation(pageName: string, id: string): boolean {
    const store = loadAnnotations(pageName);
    const before = store.annotations.length;
    store.annotations = store.annotations.filter(a => a.id !== id);
    if (store.annotations.length !== before) {
        saveAnnotations(store);
        return true;
    }
    return false;
}

export function clearAnnotations(pageName: string): boolean {
    const key = storageKeyForPage(pageName);
    const localStore = getStorage('local');
    const sessionStore = getStorage('session');
    let removed = false;

    if (localStore) {
        try {
            if (localStore.getItem(key) !== null) removed = true;
            localStore.removeItem(key);
        } catch (e) {
            console.error('[ReviewTool] failed to clear annotations from localStorage', e);
        }
    }

    if (sessionStore) {
        try {
            if (sessionStore.getItem(key) !== null) removed = true;
            sessionStore.removeItem(key);
        } catch (e) {
            console.error('[ReviewTool] failed to clear annotations from sessionStorage', e);
        }
    }

    return removed;
}

function sortAnnotationsByTimestamp(list: Annotation[]): Annotation[] {
    return [...list].sort((a, b) => a.createdAt - b.createdAt);
}

export function buildAnnotationGroups(pageName: string): AnnotationGroup[] {
    const store = loadAnnotations(pageName);
    if (!store.annotations.length) {
        return [];
    }

    const buckets = new Map<string, Annotation[]>();
    for (const anno of store.annotations) {
        const key = typeof anno.sectionPath === 'string' && anno.sectionPath.trim()
            ? anno.sectionPath.trim()
            : '';
        const existing = buckets.get(key);
        if (existing) {
            existing.push(anno);
        } else {
            buckets.set(key, [anno]);
        }
    }

    const groups: AnnotationGroup[] = [];
    for (const [sectionPath, annotations] of buckets.entries()) {
        groups.push({
            sectionPath,
            annotations: sortAnnotationsByTimestamp(annotations)
        });
    }

    groups.sort((a, b) => {
        const aTs = a.annotations[0]?.createdAt ?? Number.MAX_SAFE_INTEGER;
        const bTs = b.annotations[0]?.createdAt ?? Number.MAX_SAFE_INTEGER;
        if (aTs === bTs) {
            return a.sectionPath.localeCompare(b.sectionPath);
        }
        return aTs - bTs;
    });

    return groups;
}
