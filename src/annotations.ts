import state from './state';

export interface Annotation {
    id: string;
    sectionPath: string;
    sentenceIndex: number;
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
    const raw = sessionStorage.getItem(key);
    if (!raw) {
        return {
            pageName,
            createdAt: Date.now(),
            annotations: []
        };
    }
    try {
        return JSON.parse(raw) as AnnotationStore;
    } catch (e) {
        console.warn('[ReviewTool] failed to parse annotations from sessionStorage', e);
        return {
            pageName,
            createdAt: Date.now(),
            annotations: []
        };
    }
}

export function saveAnnotations(store: AnnotationStore): void {
    const key = storageKeyForPage(store.pageName);
    try {
        sessionStorage.setItem(key, JSON.stringify(store));
    } catch (e) {
        console.error('[ReviewTool] failed to save annotations to sessionStorage', e);
    }
}

export function createAnnotation(pageName: string, sectionPath: string, sentenceIndex: number, sentenceText: string, opinion: string): Annotation {
    const store = loadAnnotations(pageName);
    const normalizedSectionPath = sectionPath === '目次' ? '序言' : sectionPath;
    const anno: Annotation = {
        id: uuidv4(),
        sectionPath: normalizedSectionPath,
        sentenceIndex,
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

export function updateAnnotation(pageName: string, id: string, updates: Partial<Pick<Annotation, 'opinion' | 'sentenceText' | 'resolved'>>): Annotation | null {
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

function sortAnnotationsBySentenceIndex(list: Annotation[]): Annotation[] {
    return [...list].sort((a, b) => {
        const aIdx = typeof a.sentenceIndex === 'number' ? a.sentenceIndex : Number.MAX_SAFE_INTEGER;
        const bIdx = typeof b.sentenceIndex === 'number' ? b.sentenceIndex : Number.MAX_SAFE_INTEGER;
        if (aIdx === bIdx) {
            return 0;
        }
        return aIdx - bIdx;
    });
}

export function groupAnnotationsBySection(pageName: string): AnnotationGroup[] {
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
            annotations: sortAnnotationsBySentenceIndex(annotations)
        });
    }

    groups.sort((a, b) => {
        const aIdx = a.annotations[0]?.sentenceIndex ?? Number.MAX_SAFE_INTEGER;
        const bIdx = b.annotations[0]?.sentenceIndex ?? Number.MAX_SAFE_INTEGER;
        if (aIdx === bIdx) {
            return a.sectionPath.localeCompare(b.sectionPath);
        }
        return aIdx - bIdx;
    });

    return groups;
}
