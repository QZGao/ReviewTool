type HtmlHostKind = "preview" | "diff";

type DialogVm = {
    $nextTick: (cb: () => void) => void;
    $refs: Record<string, HTMLElement | HTMLElement[] | undefined>;
    currentStep: number;
    previewHtml?: string;
    diffHtml?: string;
};

export interface StepHandlers {
    totalSteps?: number;
    onEnterPreviewStep?: () => void;
    onEnterDiffStep?: () => void;
    onEnterEditStep?: () => void;
    previewStepIndex?: number;
    diffStepIndex?: number;
}

export function afterServerHtmlInjected(targetEl: HTMLElement | null, html: string | null) {
    if (!targetEl || !html) return;
    try {
        if (typeof mw !== "undefined" && mw && mw.hook && typeof mw.hook === "function") {
            const $ = (window as Window & { jQuery?: JQueryStatic }).jQuery;
            mw.hook("wikipage.content").fire($ ? $(targetEl) : targetEl);
        }
    } catch {
        /* ignore */
    }
    if (html.indexOf('class="diff') !== -1) {
        try {
            if (mw && mw.loader && mw.loader.load) {
                mw.loader.load("mediawiki.diff.styles");
            }
        } catch {
            /* ignore */
        }
    }
}

function getHtmlByKind(vm: DialogVm, kind: HtmlHostKind): string | null {
    if (kind === "preview") return vm.previewHtml ?? null;
    return vm.diffHtml ?? null;
}

export function triggerDialogContentHooks(vm: DialogVm, kind: HtmlHostKind) {
    vm.$nextTick(() => {
        const html = getHtmlByKind(vm, kind);
        if (!html) return;
        const refName = kind === "preview" ? "previewHtmlHost" : "diffHtmlHost";
        const refs = vm.$refs;
        let host = refs[refName];
        if (Array.isArray(host)) host = host[0];
        if (!host) return;
        if (!host.innerHTML || !host.innerHTML.trim()) {
            host.innerHTML = html;
        }
        afterServerHtmlInjected(host, html);
    });
}

export function ensureDialogStepContentHooks(vm: DialogVm, handlers?: StepHandlers) {
    vm.$nextTick(() => {
        const previewStep = handlers?.previewStepIndex ?? 1;
        const diffStep = handlers?.diffStepIndex ?? 2;
        if (vm.currentStep === previewStep && vm.previewHtml) {
            triggerDialogContentHooks(vm, "preview");
        } else if (vm.currentStep === diffStep && vm.diffHtml) {
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
        if (nextStep === 1 && handlers.onEnterEditStep) {
            handlers.onEnterEditStep.call(vm);
        } else if (nextStep === 2 && handlers.onEnterPreviewStep) {
            handlers.onEnterPreviewStep.call(vm);
        } else if (nextStep === 3 && handlers.onEnterDiffStep) {
            handlers.onEnterDiffStep.call(vm);
        }
        ensureDialogStepContentHooks(vm, handlers);
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
