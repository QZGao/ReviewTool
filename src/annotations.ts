import state from './state';

export interface Annotation {
    id: string;
    sectionPath: string;
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
const BC_CHANNEL = 'reviewtool:annotations:channel';

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

// BroadcastChannel for immediate same-origin notifications (if available)
let bc: BroadcastChannel | null = null;
try {
    if (typeof BroadcastChannel !== 'undefined') {
        bc = new BroadcastChannel(BC_CHANNEL);
    }
} catch (e) {
    console.warn('[ReviewTool] BroadcastChannel unavailable or failed to initialize', e);
    bc = null;
}

// In-memory fallback when localStorage is not available
const inMemoryStores = new Map<string, AnnotationStore>();

function notifyUpdate(key: string, store: AnnotationStore | null) {
    try {
        if (bc) bc.postMessage({ type: store ? 'updated' : 'cleared', key, store });
    } catch (e) {
        console.warn('[ReviewTool] failed to post BroadcastChannel message', e, { key, store });
    }
}

export function loadAnnotations(pageName: string): AnnotationStore {
    const key = storageKeyForPage(pageName);
    console.log('[ReviewTool] Loading annotations from localStorage with key:', key);
    try {
        let raw = localStorage.getItem(key);

        // If no localStorage entry, try migrating from sessionStorage (one-time migration)
        if (!raw) {
            try {
                if (typeof sessionStorage !== 'undefined') {
                    const sess = sessionStorage.getItem(key);
                    if (sess) {
                        // migrate into localStorage so it's persistent across tabs/sessions
                        try {
                            localStorage.setItem(key, sess);
                            // remove from sessionStorage to avoid duplicate source of truth
                            try { sessionStorage.removeItem(key); } catch (e) { console.warn('[ReviewTool] failed to remove migrated sessionStorage key', e); }
                            raw = sess;
                            console.log('[ReviewTool] Migrated annotations from sessionStorage to localStorage for key:', key);
                            notifyUpdate(key, JSON.parse(sess) as AnnotationStore);
                        } catch (e) {
                            console.warn('[ReviewTool] failed to migrate sessionStorage to localStorage', e);
                        }
                    }
                }
            } catch (e) {
                console.warn('[ReviewTool] sessionStorage access failed during migration check', e);
            }
        }

        console.log('[ReviewTool] Raw annotations data:', raw);
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
            console.warn('[ReviewTool] failed to parse annotations from localStorage', e);
            return {
                pageName,
                createdAt: Date.now(),
                annotations: []
            };
        }
    } catch (e) {
        // localStorage might be unavailable (private mode, blocked). Fallback to memory.
        console.warn('[ReviewTool] localStorage unavailable, using in-memory store', e);
        const mem = inMemoryStores.get(key);
        if (mem) return mem;
        const empty: AnnotationStore = { pageName, createdAt: Date.now(), annotations: [] };
        inMemoryStores.set(key, empty);
        return empty;
    }
}

export function saveAnnotations(store: AnnotationStore): void {
    const key = storageKeyForPage(store.pageName);
    try {
        localStorage.setItem(key, JSON.stringify(store));
        // notify other tabs/windows
        notifyUpdate(key, store);
    } catch (e) {
        console.error('[ReviewTool] failed to save annotations to localStorage, falling back to in-memory', e);
        try {
            inMemoryStores.set(key, store);
            notifyUpdate(key, store);
        } catch (err) {
            console.error('[ReviewTool] failed to save annotations to in-memory store', err);
        }
    }
}

export function createAnnotation(pageName: string, sectionPath: string, sentenceText: string, opinion: string): Annotation {
    const store = loadAnnotations(pageName);
    const anno: Annotation = {
        id: uuidv4(),
        sectionPath: sectionPath,
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

export function clearAnnotations(pageName: string): boolean {
    const key = storageKeyForPage(pageName);
    let existed;
    try {
        existed = localStorage.getItem(key) !== null;
        try {
            localStorage.removeItem(key);
        } catch (e) {
            console.error('[ReviewTool] failed to remove annotations from localStorage', e);
        }
        notifyUpdate(key, null);
        return existed;
    } catch (e) {
        console.warn('[ReviewTool] localStorage unavailable when clearing annotations, using in-memory fallback', e);
        existed = inMemoryStores.has(key);
        inMemoryStores.delete(key);
        notifyUpdate(key, null);
        return existed;
    }
}

function sortAnnotationsByTimestamp(list: Annotation[]): Annotation[] {
    return [...list].sort((a, b) => a.createdAt - b.createdAt);
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

// Listen for BroadcastChannel messages to update in-memory store
if (bc) {
    bc.onmessage = (ev) => {
        const { key, store, type } = ev.data;
        if (type === 'updated' && store) {
            inMemoryStores.set(key, store);
        } else if (type === 'cleared') {
            inMemoryStores.delete(key);
        }
    };
}

// Also listen for storage events (fires in other tabs/windows when localStorage changes)
if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('storage', (ev: StorageEvent) => {
        try {
            if (!ev.key || !ev.key.startsWith(KEY_PREFIX)) return;
            if (ev.newValue) {
                const parsed = JSON.parse(ev.newValue) as AnnotationStore;
                inMemoryStores.set(ev.key, parsed);
            } else {
                inMemoryStores.delete(ev.key);
            }
        } catch (e) {
            console.warn('[ReviewTool] failed to handle storage event', e);
        }
    });
}
