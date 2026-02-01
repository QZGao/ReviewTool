import state from "../state";
import { loadCodexAndVue, mountApp, removeDialogMount, registerCodexComponents, getMountedApp } from "../dialog";
import CheckWritingDialog from "./components/check_writing.vue";

function createCheckWritingDialog(): void {
    loadCodexAndVue().then(({ Vue, Codex }) => {
        const app = Vue.createMwApp(CheckWritingDialog);
        registerCodexComponents(app, Codex);
        mountApp(app);
    }).catch((error) => {
        console.error("[ReviewTool] 無法加載 Codex:", error);
        if (mw && mw.notify) {
            mw.notify(state.convByVar({ hant: "無法加載對話框組件。", hans: "无法加载对话框组件。" }), {
                type: "error",
                title: "[ReviewTool]"
            });
        }
    });
}

export function openCheckWritingDialog(): void {
    if (getMountedApp()) removeDialogMount();
    createCheckWritingDialog();
}
