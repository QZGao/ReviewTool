// Module responsible for dialog-related side effects (loader, mount element, mounting)
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
	CdxButtonGroup: unknown;
	CdxSelect: unknown;
	CdxTextInput: unknown;
	CdxTextArea: unknown;
	CdxCheckbox: unknown;
}>;

let _mountedApp: VueApp | null = null;
let _mountedRoot: unknown = null;
let _imeListenersInstalled = false;
let _isImeComposing = false;
let _imeResetTimer: number | null = null;
let _lastCompositionAt = 0;

/**
 * Helper to determine if an event target is an editable element that may be using IME, for the purpose of guarding Escape key behavior during composition.
 * @param {EventTarget | null} target - The event target to check.
 * @returns {boolean} True if the target is an editable element that may be using IME, false otherwise.
 */
function isEditableEventTarget(target: EventTarget | null): boolean {
	if (!target || !(target instanceof HTMLElement)) return false;
	if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
		return !target.disabled && !target.readOnly;
	}
	return target.isContentEditable;
}

/**
 * Mark IME composition as active.
 */
function onCompositionStart(): void {
	if (_imeResetTimer !== null) {
		window.clearTimeout(_imeResetTimer);
		_imeResetTimer = null;
	}
	_isImeComposing = true;
	_lastCompositionAt = Date.now();
}

/**
 * Reset IME composition state when composition ends.
 */
function onCompositionEnd(): void {
	_lastCompositionAt = Date.now();
	// Keep composition active briefly to absorb Esc cancel timing differences across browsers/IMEs.
	if (_imeResetTimer !== null) {
		window.clearTimeout(_imeResetTimer);
	}
	_imeResetTimer = window.setTimeout(() => {
		_isImeComposing = false;
		_imeResetTimer = null;
	}, 80);
}

/**
 * Track composition-like input activity to handle browser/IME event-order differences.
 * @param {InputEvent} event - The beforeinput/input event.
 */
function onCompositionInput(event: InputEvent): void {
	const inputType = typeof event.inputType === 'string' ? event.inputType : '';
	if (event.isComposing || inputType.indexOf('insertComposition') === 0) {
		_lastCompositionAt = Date.now();
		_isImeComposing = true;
	}
}

/**
 * Check if IME composition is currently active or was active very recently.
 * @returns {boolean} True when composition should still suppress Escape-driven dialog close.
 */
function isCompositionLikelyActive(): boolean {
	if (_isImeComposing) return true;
	return Date.now() - _lastCompositionAt <= 500;
}

/**
 * Guard Escape key behavior during IME composition to prevent dialogs from closing when users intend to cancel IME input.
 * @param {KeyboardEvent} event - The key event to check.
 */
function onEscapeKey(event: KeyboardEvent): void {
	if (event.key !== 'Escape') return;
	const isImeKeyEvent = event.isComposing || event.keyCode === 229;
	const editableTarget = isEditableEventTarget(event.target) || isEditableEventTarget(document.activeElement);
	// While IME composition is active, keep Escape for IME cancellation instead of dialog close.
	if (isImeKeyEvent || (editableTarget && isCompositionLikelyActive())) {
		event.preventDefault();
		event.stopImmediatePropagation();
		event.stopPropagation();
	}
}

/**
 * Prevent native dialog cancel (Esc) while IME composition is active/recent.
 * @param {Event} event - The cancel event dispatched by HTMLDialogElement.
 */
function onDialogCancel(event: Event): void {
	const target = event.target as HTMLElement | null;
	if (!target || target.tagName !== 'DIALOG') return;
	if (!isCompositionLikelyActive()) return;
	if (!isEditableEventTarget(document.activeElement)) return;
	event.preventDefault();
	event.stopImmediatePropagation();
	event.stopPropagation();
}

/**
 * Install global event listeners to track IME composition state and guard Escape key behavior accordingly.
 * This should be called when any dialog is opened to ensure proper handling of Escape key during IME input.
 */
function installImeEscGuard(): void {
	if (_imeListenersInstalled) return;
	window.addEventListener('compositionstart', onCompositionStart, true);
	window.addEventListener('compositionend', onCompositionEnd, true);
	window.addEventListener('beforeinput', onCompositionInput, true);
	window.addEventListener('input', onCompositionInput, true);
	window.addEventListener('keydown', onEscapeKey, true);
	window.addEventListener('keyup', onEscapeKey, true);
	window.addEventListener('cancel', onDialogCancel, true);
	_imeListenersInstalled = true;
}

/**
 * Remove global event listeners for IME composition tracking and Escape key guarding.
 * This should be called when dialogs are closed to clean up event listeners.
 */
function removeImeEscGuard(): void {
	if (!_imeListenersInstalled) return;
	window.removeEventListener('compositionstart', onCompositionStart, true);
	window.removeEventListener('compositionend', onCompositionEnd, true);
	window.removeEventListener('beforeinput', onCompositionInput, true);
	window.removeEventListener('input', onCompositionInput, true);
	window.removeEventListener('keydown', onEscapeKey, true);
	window.removeEventListener('keyup', onEscapeKey, true);
	window.removeEventListener('cancel', onDialogCancel, true);
	if (_imeResetTimer !== null) {
		window.clearTimeout(_imeResetTimer);
		_imeResetTimer = null;
	}
	_imeListenersInstalled = false;
	_isImeComposing = false;
	_lastCompositionAt = 0;
}

/**
 * Load Codex and Vue modules.
 * @returns {JQuery.Promise<{ Vue: VueModule, Codex: CodexModule }>} A promise that resolves with the loaded modules.
 */
export function loadCodexAndVue(): JQuery.Promise<{ Vue: VueModule, Codex: CodexModule }> {
	return mw.loader.using('@wikimedia/codex').then((requireFn: (name: string) => unknown) => {
		const Vue = requireFn('vue') as VueModule;
		const Codex = requireFn('@wikimedia/codex') as CodexModule;
		if (typeof window !== 'undefined' && !(window as unknown as { Vue?: VueModule }).Vue) {
			(window as unknown as { Vue?: VueModule }).Vue = Vue;
		}
		return { Vue, Codex };
	});
}

/**
 * Create dialog mount point if it doesn't exist, and return the mount element.
 * @returns {HTMLElement | null} The dialog mount element, or null if it cannot be created.
 */
export function createDialogMountIfNeeded(): HTMLElement | null {
	if (!document.getElementById('review-tool-dialog-mount')) {
		const mountPoint = document.createElement('div');
		mountPoint.id = 'review-tool-dialog-mount';
		document.body.appendChild(mountPoint);
	}
	return document.getElementById('review-tool-dialog-mount');
}

/**
 * Mount a Vue app to the dialog mount point, creating the mount if necessary, and set up IME Escape key guarding.
 * @param {VueApp} app - The Vue app instance to mount.
 * @returns {unknown} The result of the app's mount function, typically the root component instance.
 */
export function mountApp(app: VueApp): unknown {
	createDialogMountIfNeeded();
	installImeEscGuard();
	_mountedApp = app;
	_mountedRoot = app.mount('#review-tool-dialog-mount');
	return _mountedRoot;
}

/**
 * Get the currently mounted Vue app instance, if any.
 * @returns {VueApp | null} The currently mounted Vue app instance, or null if no app is mounted.
 */
export function getMountedApp(): VueApp | null {
	return _mountedApp;
}

/**
 * Remove the dialog mount element from the DOM, clean up IME Escape key guarding, and clear internal app references.
 */
export function removeDialogMount() {
	const mountPoint = document.getElementById('review-tool-dialog-mount');
	if (mountPoint) mountPoint.remove();
	removeImeEscGuard();
	_mountedApp = null;
	_mountedRoot = null;
}

/**
 * Convenience helper to register commonly-used Codex components on a Vue app.
 * @param {VueApp} app - The Vue app instance to register components on.
 * @param {CodexModule} Codex - The loaded Codex module containing components to register.
 */
export function registerCodexComponents(app: VueApp, Codex: CodexModule) {
	if (!app || !app.component || !Codex) return;
	try {
		app.component('cdx-dialog', Codex.CdxDialog)
			.component('cdx-text-input', Codex.CdxTextInput)
			.component('cdx-text-area', Codex.CdxTextArea)
			.component('cdx-checkbox', Codex.CdxCheckbox)
			.component('cdx-select', Codex.CdxSelect)
			.component('cdx-button', Codex.CdxButton)
			.component('cdx-button-group', Codex.CdxButtonGroup);
	} catch {
		// ignore registration errors
	}
}

/**
 * Show a simple, styled overlay for preview/diff HTML when inserting into the dialog body fails.
 * @param {string} html - The HTML content to display inside the overlay.
 * @param {string} [title] - Optional title to display at the top of the overlay.
 */
export function showPreviewOverlay(html: string, title?: string) {
	try {
		let backdrop = document.getElementById('rt-preview-backdrop');
		if (!backdrop) {
			backdrop = document.createElement('div');
			backdrop.id = 'rt-preview-backdrop';
			backdrop.style.position = 'fixed';
			backdrop.style.left = '0';
			backdrop.style.top = '0';
			backdrop.style.width = '100vw';
			backdrop.style.height = '100vh';
			backdrop.style.zIndex = '11990';
			backdrop.style.background = 'rgba(0,0,0,0.45)';
			backdrop.style.display = 'flex';
			backdrop.style.alignItems = 'center';
			backdrop.style.justifyContent = 'center';

			const card = document.createElement('div');
			card.id = 'rt-preview-card';
			card.style.maxWidth = '88vw';
			card.style.maxHeight = '84vh';
			card.style.width = 'min(980px, 92vw)';
			card.style.overflow = 'auto';
			card.style.background = '#fff';
			card.style.borderRadius = '8px';
			card.style.boxShadow = '0 12px 40px rgba(0,0,0,0.35)';
			card.style.padding = '14px';
			card.style.position = 'relative';

			const hdr = document.createElement('div');
			hdr.style.display = 'flex';
			hdr.style.alignItems = 'center';
			hdr.style.justifyContent = 'space-between';
			hdr.style.marginBottom = '8px';

			const titleEl = document.createElement('div');
			titleEl.style.fontWeight = '600';
			titleEl.style.fontSize = '1rem';
			titleEl.textContent = title || 'Preview';
			hdr.appendChild(titleEl);

			const closeBtn = document.createElement('button');
			closeBtn.type = 'button';
			closeBtn.setAttribute('aria-label', 'Close preview');
			closeBtn.style.border = '0';
			closeBtn.style.background = 'transparent';
			closeBtn.style.cursor = 'pointer';
			closeBtn.style.fontSize = '14px';
			closeBtn.style.padding = '6px 8px';
			closeBtn.textContent = '✕';
			closeBtn.addEventListener('click', () => {
				if (backdrop) backdrop.remove();
			});
			hdr.appendChild(closeBtn);

			const content = document.createElement('div');
			content.className = 'rt-preview-overlay-content';

			card.appendChild(hdr);
			card.appendChild(content);
			backdrop.appendChild(card);
			document.body.appendChild(backdrop);
		}
		const content = backdrop.querySelector<HTMLElement>('.rt-preview-overlay-content');
		if (content) {
			content.innerHTML = html || '';
			try {
				if (typeof mw !== 'undefined' && mw && mw.hook && typeof mw.hook === 'function') {
					const $ = (mw as unknown as { $?: JQueryStatic }).$ || (window as Window & { jQuery?: JQueryStatic }).jQuery;
					if ($) {
						mw.hook('wikipage.content').fire($(content));
					}
				}
				// If diff HTML is present, ensure diff CSS is loaded
				if (html && html.indexOf('class="diff') !== -1 && mw && mw.loader && mw.loader.load) {
					mw.loader.load('mediawiki.diff.styles');
				}
			} catch {
				/* best-effort only */
			}
		}
	} catch (error) {
		console.warn('[ReviewTool] showPreviewOverlay failed', error);
	}
}
