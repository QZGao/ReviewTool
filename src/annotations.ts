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
    const anno: Annotation = {
        id: uuidv4(),
        sectionPath,
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
