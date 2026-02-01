import state from "../state";
import {
    loadCodexAndVue,
    mountApp,
    registerCodexComponents,
    removeDialogMount,
    getMountedApp
} from "../dialog";

export interface AnnotationEditorDialogOptions {
    sectionPath: string;
    sentenceText: string;
    initialOpinion?: string;
    mode?: "create" | "edit";
    allowDelete?: boolean;
}

export type AnnotationEditorDialogResult =
    | { action: "save"; opinion: string }
    | { action: "delete" }
    | { action: "cancel" };

type AnnotationEditorI18n = {
    titleCreate: string;
    titleEdit: string;
    sectionLabel: string;
    sentenceLabel: string;
    opinionLabel: string;
    opinionPlaceholder: string;
    opinionRequired: string;
    cancel: string;
    save: string;
    create: string;
    delete: string;
    deleteConfirm: string;
};

type AnnotationEditorDialogVm = {
    open: boolean;
    mode: "create" | "edit";
    sectionPath: string;
    sentenceText: string;
    opinion: string;
    allowDelete: boolean;
    showValidationError: boolean;
    dialogTitle: string;
    primaryLabel: string;
    canSave: boolean;
    onPrimaryAction: () => void;
    onCancelAction: () => void;
    onDeleteClick: () => void;
    onUpdateOpen: (newValue: boolean) => void;
    closeDialog: () => void;
    $options: { i18n: AnnotationEditorI18n };
};

export function openAnnotationEditorDialog(options: AnnotationEditorDialogOptions): JQuery.Promise<AnnotationEditorDialogResult> {
    const dialogOptions: Required<AnnotationEditorDialogOptions> = {
        sectionPath: options.sectionPath,
        sentenceText: options.sentenceText,
        initialOpinion: options.initialOpinion || "",
        mode: options.mode || "create",
        allowDelete: options.allowDelete ?? options.mode === "edit"
    };

    if (getMountedApp()) removeDialogMount();

    return loadCodexAndVue()
        .then(({ Vue, Codex }) => {
            return new Promise<AnnotationEditorDialogResult>((resolve) => {
                let resolved = false;
                const finalize = (result: AnnotationEditorDialogResult) => {
                    if (resolved) return;
                    resolved = true;
                    resolve(result);
                };

                const app = Vue.createMwApp({
                    i18n: {
                        titleCreate: state.convByVar({ hant: "新增批註", hans: "新增批注" }),
                        titleEdit: state.convByVar({ hant: "編輯批註", hans: "编辑批注" }),
                        sectionLabel: state.convByVar({ hant: "章節：", hans: "章节：" }),
                        sentenceLabel: state.convByVar({ hant: "句子：", hans: "句子：" }),
                        opinionLabel: state.convByVar({ hant: "批註內容", hans: "批注内容" }),
                        opinionPlaceholder: state.convByVar({ hant: "請輸入批註內容…", hans: "请输入批注内容…" }),
                        opinionRequired: state.convByVar({ hant: "批註內容不能為空", hans: "批注内容不能为空" }),
                        cancel: state.convByVar({ hant: "取消", hans: "取消" }),
                        save: state.convByVar({ hant: "儲存", hans: "保存" }),
                        create: state.convByVar({ hant: "新增", hans: "新增" }),
                        delete: state.convByVar({ hant: "刪除", hans: "删除" }),
                        deleteConfirm: state.convByVar({ hant: "確定要刪除這條批註？", hans: "确定要删除这条批注？" })
                    },
                    data() {
                        return {
                            open: true,
                            mode: dialogOptions.mode,
                            sectionPath: dialogOptions.sectionPath,
                            sentenceText: dialogOptions.sentenceText,
                            opinion: dialogOptions.initialOpinion,
                            allowDelete: dialogOptions.allowDelete,
                            showValidationError: false
                        };
                    },
                    computed: {
                        dialogTitle(this: AnnotationEditorDialogVm) {
                            return this.mode === "edit"
                                ? this.$options.i18n.titleEdit
                                : this.$options.i18n.titleCreate;
                        },
                        primaryLabel(this: AnnotationEditorDialogVm) {
                            return this.mode === "edit" ? this.$options.i18n.save : this.$options.i18n.create;
                        },
                        canSave(this: AnnotationEditorDialogVm): boolean {
                            return Boolean((this.opinion || "").trim());
                        }
                    },
                    watch: {
                        opinion(this: AnnotationEditorDialogVm) {
                            if (this.showValidationError && this.canSave) {
                                this.showValidationError = false;
                            }
                        }
                    },
                    methods: {
                        onPrimaryAction(this: AnnotationEditorDialogVm) {
                            if (!this.canSave) {
                                this.showValidationError = true;
                                return;
                            }
                            finalize({ action: "save", opinion: this.opinion.trim() });
                            this.closeDialog();
                        },
                        onCancelAction(this: AnnotationEditorDialogVm) {
                            finalize({ action: "cancel" });
                            this.closeDialog();
                        },
                        onDeleteClick(this: AnnotationEditorDialogVm) {
                            if (!this.allowDelete) return;
                            const ok = window.confirm(this.$options.i18n.deleteConfirm);
                            if (!ok) return;
                            finalize({ action: "delete" });
                            this.closeDialog();
                        },
                        onUpdateOpen(this: AnnotationEditorDialogVm, newValue: boolean) {
                            if (!newValue) {
                                this.onCancelAction();
                            }
                        },
                        closeDialog(this: AnnotationEditorDialogVm) {
                            this.open = false;
                            setTimeout(() => removeDialogMount(), 200);
                        }
                    },
                    template: `
                        <cdx-dialog
                            v-model:open="open"
                            :title="dialogTitle"
                            :use-close-button="true"
                            @update:open="onUpdateOpen"
                            class="review-tool-dialog review-tool-annotation-editor-dialog"
                        >
                            <div class="review-tool-form-section">
                                <div class="review-tool-annotation-editor__label">{{ $options.i18n.sectionLabel }}</div>
                                <div class="review-tool-annotation-editor__section">{{ sectionPath }}</div>
                            </div>

                            <div class="review-tool-form-section">
                                <div class="review-tool-annotation-editor__label">{{ $options.i18n.sentenceLabel }}</div>
                                <div class="review-tool-annotation-editor__quote">{{ sentenceText }}</div>
                            </div>

                            <div class="review-tool-form-section">
                                <label class="review-tool-annotation-editor__label" :for="'annotation-opinion-input'">
                                    {{ $options.i18n.opinionLabel }}
                                </label>
                                <cdx-text-area
                                    id="annotation-opinion-input"
                                    v-model="opinion"
                                    rows="5"
                                    :placeholder="$options.i18n.opinionPlaceholder"
                                ></cdx-text-area>
                                <div v-if="showValidationError" class="review-tool-annotation-editor__error">
                                    {{ $options.i18n.opinionRequired }}
                                </div>
                            </div>

                            <template #footer>
                                <div class="review-tool-annotation-editor__footer">
                                    <cdx-button
                                        v-if="allowDelete"
                                        weight="quiet"
                                        action="destructive"
                                        class="review-tool-annotation-editor__delete"
                                        @click.prevent="onDeleteClick"
                                    >
                                        {{ $options.i18n.delete }}
                                    </cdx-button>
                                    <div class="review-tool-annotation-editor__actions">
                                        <cdx-button weight="quiet" @click.prevent="onCancelAction">
                                            {{ $options.i18n.cancel }}
                                        </cdx-button>
                                        <cdx-button
                                            action="progressive"
                                            :disabled="!canSave"
                                            @click.prevent="onPrimaryAction"
                                        >
                                            {{ primaryLabel }}
                                        </cdx-button>
                                    </div>
                                </div>
                            </template>
                        </cdx-dialog>
                    `
                });

                registerCodexComponents(app, Codex);
                mountApp(app);
            });
        })
        .catch((error) => {
            console.error("[ReviewTool] Failed to open annotation editor dialog", error);
            if (mw && mw.notify) {
                mw.notify(
                    state.convByVar({ hant: "無法開啟批註對話框。", hans: "无法开启批注对话框。" }),
                    { type: "error", title: "[ReviewTool]" }
                );
            }
            throw error;
        });
}
