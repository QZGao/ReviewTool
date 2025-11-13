declare var mw: any;

// Module responsible for dialog-related side effects (loader, mount element, mounting)
let _mountedApp: any = null;

export function loadCodexAndVue(): Promise<{Vue: any, Codex: any}> {
    return mw.loader.using('@wikimedia/codex').then((require: any) => ({
        Vue: require('vue'),
        Codex: require('@wikimedia/codex')
    }));
}

export function createDialogMountIfNeeded(): HTMLElement | null {
    if (!document.getElementById('review-tool-dialog-mount')) {
        const mountPoint = document.createElement('div');
        mountPoint.id = 'review-tool-dialog-mount';
        document.body.appendChild(mountPoint);
    }
    return document.getElementById('review-tool-dialog-mount');
}

export function mountApp(app: any) {
    createDialogMountIfNeeded();
    _mountedApp = app.mount('#review-tool-dialog-mount');
    return _mountedApp;
}

export function getMountedApp() {
    return _mountedApp;
}

export function removeDialogMount() {
    const mountPoint = document.getElementById('review-tool-dialog-mount');
    if (mountPoint) mountPoint.remove();
    _mountedApp = null;
}

// Convenience helper to register commonly-used Codex components on a Vue app
export function registerCodexComponents(app: any, Codex: any) {
    if (!app || !Codex) return;
    try {
        app.component('cdx-dialog', Codex.CdxDialog)
            .component('cdx-text-input', Codex.CdxTextInput)
            .component('cdx-text-area', Codex.CdxTextArea)
            .component('cdx-checkbox', Codex.CdxCheckbox)
            .component('cdx-select', Codex.CdxSelect)
            .component('cdx-button', Codex.CdxButton)
            .component('cdx-button-group', Codex.CdxButtonGroup);
    } catch (e) {
        // ignore registration errors
    }
}
