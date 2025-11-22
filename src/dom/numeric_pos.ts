export type PathArray = number[];

export interface OrderKeyOptions {
    root?: Element | string;
    paddingWidth?: number;
}

const DEFAULT_ROOT_SELECTOR = '#mw-content-text';
const DEFAULT_PADDING = 6;

function resolveRoot(root?: Element | string): Element | null {
    if (!root) {
        return document.querySelector(DEFAULT_ROOT_SELECTOR);
    }
    if (typeof root === 'string') {
        return document.querySelector(root);
    }
    return root;
}

function countPreviousElementSiblings(node: Element | null): number {
    let index = 0;
    let sibling = node ? node.previousElementSibling : null;
    while (sibling) {
        index++;
        sibling = sibling.previousElementSibling;
    }
    return index;
}

export function getElementPathArray(element: Element | null, root?: Element | string): PathArray | null {
    if (!element) return null;
    const rootEl = resolveRoot(root);
    if (!rootEl || !rootEl.contains(element)) return null;

    const path: number[] = [];
    let node: Element | null = element;

    while (node && node !== rootEl) {
        path.push(countPreviousElementSiblings(node));
        node = node.parentElement;
    }

    if (node !== rootEl) {
        return null;
    }

    path.reverse();
    return path;
}

export function pathArrayToKey(path: PathArray | null, paddingWidth = DEFAULT_PADDING): string | null {
    if (!path) return null;
    const width = Math.max(1, paddingWidth | 0);
    return path
        .map((segment) => String(segment).padStart(width, '0'))
        .join('.');
}

export function getElementOrderKey(element: Element | null, options?: OrderKeyOptions): string | null {
    const path = getElementPathArray(element, options?.root ?? DEFAULT_ROOT_SELECTOR);
    return pathArrayToKey(path, options?.paddingWidth ?? DEFAULT_PADDING);
}

export function compareOrderKeys(a?: string | null, b?: string | null): number {
    if (!a && !b) return 0;
    if (!a) return -1;
    if (!b) return 1;

    const partsA = a.split('.').map((part) => parseInt(part, 10));
    const partsB = b.split('.').map((part) => parseInt(part, 10));
    const len = Math.min(partsA.length, partsB.length);

    for (let i = 0; i < len; i++) {
        if (partsA[i] !== partsB[i]) {
            return partsA[i] - partsB[i];
        }
    }

    return partsA.length - partsB.length;
}

