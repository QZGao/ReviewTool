type HtmlHostKind = "preview" | "diff";

type DialogVm = {
    $nextTick: (cb: () => void) => void;
    $refs: Record<string, HTMLElement | HTMLElement[] | undefined>;
    currentStep: number;
    previewHtml?: string;
    diffHtml?: string;
};

declare const mw: any;

export interface StepHandlers {
    totalSteps?: number;
    onEnterPreviewStep?: () => void;
    onEnterDiffStep?: () => void;
}

export function afterServerHtmlInjected(targetEl: HTMLElement | null, html: string | null) {
    if (!targetEl || !html) return;
    try {
        if (typeof mw !== "undefined" && mw && mw.hook && typeof mw.hook === "function") {
            const $ = (window as any).jQuery;
            mw.hook("wikipage.content").fire($ ? $(targetEl) : targetEl);
        }
    } catch (e) {
        try {
            mw && mw.hook && mw.hook("wikipage.content").fire(targetEl);
        } catch (err) {
            /* ignore */
        }
    }
    if (html.indexOf('class="diff') !== -1) {
        try {
            mw && mw.loader && mw.loader.load && mw.loader.load("mediawiki.diff.styles");
        } catch (e) {
            /* ignore */
        }
    }
}

export function triggerDialogContentHooks(vm: DialogVm, kind: HtmlHostKind) {
    vm.$nextTick(() => {
        const htmlProp = kind === "preview" ? "previewHtml" : "diffHtml";
        const html = (vm as any)[htmlProp] as string | null;
        if (!html) return;
        const refName = kind === "preview" ? "previewHtmlHost" : "diffHtmlHost";
        const refs = vm.$refs as Record<string, HTMLElement | HTMLElement[] | undefined>;
        let host = refs[refName];
        if (Array.isArray(host)) host = host[0];
        if (!host) return;
        if (!host.innerHTML || !host.innerHTML.trim()) {
            host.innerHTML = html;
        }
        afterServerHtmlInjected(host as HTMLElement, html);
    });
}

export function ensureDialogStepContentHooks(vm: DialogVm) {
    vm.$nextTick(() => {
        if (vm.currentStep === 1 && vm.previewHtml) {
            triggerDialogContentHooks(vm, "preview");
        } else if (vm.currentStep === 2 && vm.diffHtml) {
            triggerDialogContentHooks(vm, "diff");
        }
    });
}

export function advanceDialogStep(vm: DialogVm, handlers: StepHandlers): boolean {
    const totalSteps = handlers.totalSteps ?? 3;
    if (vm.currentStep >= totalSteps - 1) return false;
    const nextStep = vm.currentStep + 1;
    vm.currentStep = nextStep;

    const runHandlers = () => {
        if (nextStep === 1 && handlers.onEnterPreviewStep) {
            handlers.onEnterPreviewStep.call(vm);
        } else if (nextStep === 2 && handlers.onEnterDiffStep) {
            handlers.onEnterDiffStep.call(vm);
        }
        ensureDialogStepContentHooks(vm);
    };

    if (typeof vm.$nextTick === 'function') {
        vm.$nextTick(runHandlers);
    } else {
        runHandlers();
    }
    return true;
}

export function regressDialogStep(vm: DialogVm): boolean {
    if (vm.currentStep <= 0) return false;
    vm.currentStep--;
    ensureDialogStepContentHooks(vm);
    return true;
}
