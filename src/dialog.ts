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

export function createDialogMountIfNeeded(): HTMLElement | null {
	if (!document.getElementById('review-tool-dialog-mount')) {
		const mountPoint = document.createElement('div');
		mountPoint.id = 'review-tool-dialog-mount';
		document.body.appendChild(mountPoint);
	}
	return document.getElementById('review-tool-dialog-mount');
}

export function mountApp(app: VueApp): unknown {
	createDialogMountIfNeeded();
	_mountedApp = app;
	_mountedRoot = app.mount('#review-tool-dialog-mount');
	return _mountedRoot;
}

export function getMountedApp(): VueApp | null {
	return _mountedApp;
}

export function removeDialogMount() {
	const mountPoint = document.getElementById('review-tool-dialog-mount');
	if (mountPoint) mountPoint.remove();
	_mountedApp = null;
	_mountedRoot = null;
}

// Convenience helper to register commonly-used Codex components on a Vue app
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

// Show a simple, styled overlay for preview/diff HTML when inserting into the dialog body fails.
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
