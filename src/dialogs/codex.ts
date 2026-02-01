type VueModule = {
	createMwApp: (options: unknown) => VueApp;
};

type VueApp = {
	mount: (selector: string) => unknown;
	component?: (name: string, value: unknown) => VueApp;
};

type CodexModule = Partial<{
	CdxDialog: unknown;
	CdxButton: unknown;
	CdxSelect: unknown;
	CdxTextInput: unknown;
	CdxCheckbox: unknown;
	CdxField: unknown;
	CdxMultiselectLookup: unknown;
	CdxTextArea: unknown;
}>;

let mountedApp: VueApp | null = null;
let mountedRoot: unknown = null;
const MOUNT_ID = 'citeforge-dialog-mount';

/**
 * Load Codex and Vue from ResourceLoader. Mirrors ReviewTool pattern for future UI work.
 * @returns Promise resolving to Vue and Codex module objects.
 */
function loadCodex(): Promise<{ Vue: unknown; Codex: unknown }> {
	return new Promise((resolve, reject) => {
		mw.loader
			.using('@wikimedia/codex')
			.then((requireFn: (name: string) => unknown) => {
				resolve({
					Vue: requireFn ? requireFn('vue') : null,
					Codex: requireFn ? requireFn('@wikimedia/codex') : null
				});
			})
			.catch((err: unknown) => {
				const reason =
					err instanceof Error
						? err
						: new Error(
							typeof err === 'string'
								? err
								: (() => {
									try {
										return JSON.stringify(err);
									} catch {
										return 'Unknown error';
									}
								})()
						);
				reject(reason);
			});
	});
}

/**
 * Load Codex and Vue modules with proper typing.
 * Wraps the internal loadCodex function with typed return values.
 * @returns Promise resolving to Vue and Codex module objects.
 */
export async function loadCodexAndVue(): Promise<{ Vue: VueModule; Codex: CodexModule }> {
	const loaded = await loadCodex();
	return loaded as { Vue: VueModule; Codex: CodexModule };
}

/**
 * Ensure a DOM mount point exists for Vue apps.
 * Creates a div with the provided id and appends to body if missing.
 * @param id - Element id to create or reuse.
 * @returns The mount point element.
 */
export function ensureMount(id = MOUNT_ID): HTMLElement {
	let mount = document.getElementById(id);
	if (!mount) {
		mount = document.createElement('div');
		mount.id = id;
		document.body.appendChild(mount);
	}
	return mount;
}

/**
 * Ensure a style element with given id exists, injecting the provided CSS text.
 * @param id - Element id for the style tag.
 * @param cssText - CSS text content to inject.
 */
export function ensureStyleElement(id: string, cssText: string): void {
	if (document.getElementById(id)) return;
	try {
		const styleEl = document.createElement('style');
		styleEl.id = id;
		styleEl.appendChild(document.createTextNode(cssText));
		document.head.appendChild(styleEl);
	} catch {
		const div = document.createElement('div');
		div.innerHTML = `<style id="${id}">${cssText}</style>`;
		const styleEl = div.firstChild as HTMLElement | null;
		if (styleEl) {
			document.head.appendChild(styleEl);
		}
	}
}

/**
 * Create the dialog mount point in the DOM if it doesn't exist.
 * The mount point is where Vue apps are mounted.
 * @returns The mount point HTMLElement.
 */
export function createDialogMountIfNeeded(): HTMLElement {
	return ensureMount(MOUNT_ID);
}

/**
 * Mount a Vue app to the dialog mount point.
 * Creates the mount point if needed and stores references to the app and root.
 * @param app - The Vue app instance to mount.
 * @returns The mounted Vue app.
 */
export function mountApp(app: VueApp): VueApp {
	createDialogMountIfNeeded();
	mountedApp = app;
	mountedRoot = mountedApp.mount(`#${MOUNT_ID}`);
	return mountedApp;
}

/**
 * Get the currently mounted Vue app instance.
 * @returns The mounted app, or null if none is mounted.
 */
export function getMountedApp(): VueApp | null {
	return mountedApp;
}

/**
 * Get the root component instance of the mounted app.
 * @returns The root component instance, or null if none is mounted.
 */
export function getMountedRoot(): unknown {
	return mountedRoot;
}

/**
 * Remove the dialog mount point from the DOM and clear app references.
 * Should be called when the dialog is permanently closed.
 */
export function removeDialogMount(): void {
	const mount = document.getElementById(MOUNT_ID);
	if (mount) {
		mount.remove();
	}
	mountedApp = null;
	mountedRoot = null;
}

/**
 * Register Codex UI components with a Vue app.
 * Registers CdxDialog, CdxButton, CdxSelect, and CdxTextInput.
 * @param app - The Vue app to register components with.
 * @param Codex - The Codex module containing component definitions.
 */
export function registerCodexComponents(app: VueApp, Codex: CodexModule): void {
	if (!app || !app.component || !Codex) return;
	try {
		if (Codex.CdxDialog) app.component('cdx-dialog', Codex.CdxDialog);
		if (Codex.CdxButton) app.component('cdx-button', Codex.CdxButton);
		if (Codex.CdxSelect) app.component('cdx-select', Codex.CdxSelect);
		if (Codex.CdxTextInput) app.component('cdx-text-input', Codex.CdxTextInput);
		if (Codex.CdxTextArea) app.component('cdx-text-area', Codex.CdxTextArea);
		if (Codex.CdxCheckbox) app.component('cdx-checkbox', Codex.CdxCheckbox);
		if (Codex.CdxField) app.component('cdx-field', Codex.CdxField);
		if (Codex.CdxMultiselectLookup) app.component('cdx-multiselect-lookup', Codex.CdxMultiselectLookup);
	} catch {
		// best effort; ignore registration errors
	}
}
