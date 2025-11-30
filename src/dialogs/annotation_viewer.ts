import state from "../state";
import { AnnotationGroup, Annotation } from "../annotations";
import {
    loadCodexAndVue,
    mountApp,
    registerCodexComponents,
    removeDialogMount,
    getMountedApp
} from "../dialog";
import { compareOrderKeys } from "../dom/numeric_pos";

export interface AnnotationViewerDialogOptions {
    groups: AnnotationGroup[];
    onEditAnnotation?: (annotationId: string, sectionPath: string) => void;
    onDeleteAnnotation?: (annotationId: string, sectionPath: string) => Promise<void> | void;
    onClearAllAnnotations?: () => Promise<boolean | void> | boolean | void;
}

let viewerAppInstance: any = null;
let viewerDialogOptions: AnnotationViewerDialogOptions | null = null;

export function isAnnotationViewerDialogOpen(): boolean {
    return Boolean(viewerAppInstance);
}

export function closeAnnotationViewerDialog(): void {
    if (viewerAppInstance) {
        viewerAppInstance.open = false;
        setTimeout(() => removeDialogMount(), 200);
        viewerAppInstance = null;
        viewerDialogOptions = null;
    }
}

export function updateAnnotationViewerDialogGroups(groups: AnnotationGroup[]): void {
    if (viewerAppInstance) {
        viewerAppInstance.groups = groups;
    }
}

export function openAnnotationViewerDialog(options: AnnotationViewerDialogOptions): void {
    viewerDialogOptions = {
        groups: options.groups || [],
        onEditAnnotation: options.onEditAnnotation,
        onDeleteAnnotation: options.onDeleteAnnotation,
        onClearAllAnnotations: options.onClearAllAnnotations
    };

    if (getMountedApp()) removeDialogMount();

    loadCodexAndVue()
        .then(({ Vue, Codex }: any) => {
            const app = Vue.createMwApp({
                i18n: {
                    title: state.convByVar({ hant: "批註列表", hans: "批注列表" }),
                    empty: state.convByVar({ hant: "尚無批註", hans: "尚无批注" }),
                    edit: state.convByVar({ hant: "編輯", hans: "编辑" }),
                    delete: state.convByVar({ hant: "刪除", hans: "删除" }),
                    deleteConfirm: state.convByVar({ hant: "確定刪除？", hans: "确定删除？" }),
                    clearAll: state.convByVar({ hant: "清除全部", hans: "清除全部" }),
                    clearAllConfirm: state.convByVar({ hant: "確定刪除所有批註？", hans: "确定删除所有批注？" }),
                    clearAllDone: state.convByVar({ hant: "已清除所有批註。", hans: "已清除所有批注。" }),
                    clearAllNothing: state.convByVar({ hant: "沒有可清除的批註。", hans: "没有可清除的批注。" }),
                    clearAllError: state.convByVar({ hant: "清除批註時發生錯誤。", hans: "清除批注时发生错误。" }),
                    sectionFallback: state.convByVar({ hant: "（未指定章節）", hans: "（未指定章节）" }),
                    close: state.convByVar({ hant: "關閉", hans: "关闭" }),
                    // export-related strings
                    export: state.convByVar({ hant: "匯出", hans: "导出" }),
                    exportDone: state.convByVar({ hant: "已匯出批註。", hans: "已导出批注。" }),
                    exportError: state.convByVar({ hant: "匯出批註時發生錯誤。", hans: "导出批注时发生错误。" }),
                    sortLabel: state.convByVar({ hant: "排序方式", hans: "排序方式" }),
                    sortCreatedAsc: state.convByVar({ hant: "最早時間優先", hans: "最早时间优先" }),
                    sortCreatedDesc: state.convByVar({ hant: "最新時間優先", hans: "最新时间优先" }),
                    sortPosition: state.convByVar({ hant: "頁面位置", hans: "页面位置" })
                },
                data() {
                    return {
                        open: true,
                        groups: viewerDialogOptions?.groups || [],
                        deletingAnnotationId: null as string | null,
                        clearingAll: false,
                        canClearAll: Boolean(viewerDialogOptions?.onClearAllAnnotations),
                        sortMethod: 'position'
                    };
                },
                computed: {
                    isEmpty(): boolean {
                        if (!Array.isArray(this.groups) || !this.groups.length) return true;
                        return this.groups.every((group: AnnotationGroup) => !group.annotations || group.annotations.length === 0);
                    },
                    flattenedAnnotations(): Annotation[] {
                        if (!Array.isArray(this.groups)) return [];
                        const list: Annotation[] = [];
                        this.groups.forEach((group: AnnotationGroup) => {
                            if (!Array.isArray(group.annotations)) return;
                            group.annotations.forEach((anno) => list.push(anno));
                        });
                        return list;
                    },
                    sortingOptions(): Array<{ value: string, label: string }> {
                        const i18n = (this.$options as any)?.i18n || {};
                        return [
                            { value: 'position', label: i18n.sortPosition || '頁面位置' },
                            { value: 'created-desc', label: i18n.sortCreatedDesc || '最新時間優先' },
                            { value: 'created-asc', label: i18n.sortCreatedAsc || '最早時間優先' }
                        ];
                    },
                    sortedGroups(): AnnotationGroup[] {
                        if (this.sortMethod === 'created-desc') {
                            return this.buildTimeSortedGroups('desc');
                        }
                        if (this.sortMethod === 'created-asc') {
                            return this.buildTimeSortedGroups('asc');
                        }
                        return this.buildPositionSortedGroups();
                    }
                },
                methods: {
                    quotePreview(text: string): string {
                        if (!text) return "";
                        const trimmed = text.trim();
                        if (trimmed.length <= 60) return trimmed;
                        return `${trimmed.slice(0, 57)}…`;
                    },
                    formatTimestamp(ts: number | undefined): string {
                        if (!ts) return "";
                        try {
                            return new Date(ts).toLocaleString();
                        } catch (e) {
                            return "";
                        }
                    },
                    handleEdit(annotationId: string, sectionPath: string) {
                        viewerDialogOptions?.onEditAnnotation?.(annotationId, sectionPath);
                    },
                    handleDelete(annotationId: string, sectionPath: string) {
                        if (!viewerDialogOptions?.onDeleteAnnotation) return;
                        const ok = window.confirm(this.$options.i18n.deleteConfirm);
                        if (!ok) return;
                        this.deletingAnnotationId = annotationId;
                        Promise.resolve(viewerDialogOptions.onDeleteAnnotation(annotationId, sectionPath))
                            .catch((error) => {
                                console.error('[ReviewTool] Failed to delete annotation', error);
                                mw && mw.notify && mw.notify(
                                    state.convByVar({ hant: "刪除批註時發生錯誤。", hans: "删除批注时发生错误。" }),
                                    { type: 'error', title: '[ReviewTool]' }
                                );
                            })
                            .finally(() => {
                                this.deletingAnnotationId = null;
                            });
                    },
                    handleClearAll() {
                        if (!viewerDialogOptions?.onClearAllAnnotations || this.isEmpty) return;
                        const ok = window.confirm(this.$options.i18n.clearAllConfirm);
                        if (!ok) return;
                        this.clearingAll = true;
                        Promise.resolve(viewerDialogOptions.onClearAllAnnotations())
                            .then((result) => {
                                const cleared = Boolean(result);
                                if (mw && mw.notify) {
                                    mw.notify(
                                        cleared ? this.$options.i18n.clearAllDone : this.$options.i18n.clearAllNothing,
                                        { tag: 'review-tool' }
                                    );
                                }
                            })
                            .catch((error) => {
                                console.error('[ReviewTool] Failed to clear annotations', error);
                                mw && mw.notify && mw.notify(
                                    this.$options.i18n.clearAllError,
                                    { type: 'error', title: '[ReviewTool]' }
                                );
                            })
                            .finally(() => {
                                this.clearingAll = false;
                            });
                    },
                    handleExport() {
                        if (this.isEmpty) return;
                        try {
                            const payload = {
                                exportedAt: Date.now(),
                                groups: this.groups
                            };
                            const json = JSON.stringify(payload, null, 2);
                            const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
                            const filename = `review-tool-annotations-${new Date().toISOString().replace(/[:.]/g, '')}.json`;
                            const url = URL.createObjectURL(blob);
                            const a = document.createElement('a');
                            a.href = url;
                            a.download = filename;
                            document.body.appendChild(a);
                            a.click();
                            a.remove();
                            URL.revokeObjectURL(url);
                            if (mw && mw.notify) {
                                mw.notify(this.$options.i18n.exportDone, { tag: 'review-tool' });
                            }
                        } catch (error) {
                            console.error('[ReviewTool] Failed to export annotations', error);
                            mw && mw.notify && mw.notify(
                                this.$options.i18n.exportError,
                                { type: 'error', title: '[ReviewTool]' }
                            );
                        }
                    },
                    buildPositionSortedGroups(): AnnotationGroup[] {
                        const buckets = new Map<string, Annotation[]>();
                        this.flattenedAnnotations.forEach((anno) => {
                            const key = (anno.sectionPath || '').trim();
                            if (!buckets.has(key)) buckets.set(key, []);
                            buckets.get(key)!.push(anno);
                        });
                        const groups = Array.from(buckets.entries()).map(([sectionPath, annotations]) => ({
                            sectionPath,
                            annotations: annotations.slice().sort((a, b) => {
                                const cmp = compareOrderKeys(a.sentencePos, b.sentencePos);
                                if (cmp !== 0) return cmp;
                                return (a.createdAt || 0) - (b.createdAt || 0);
                            })
                        }));
                        groups.sort((a, b) => {
                            const firstA = a.annotations[0];
                            const firstB = b.annotations[0];
                            const cmp = compareOrderKeys(firstA?.sentencePos, firstB?.sentencePos);
                            if (cmp !== 0) return cmp;
                            return (a.sectionPath || '').localeCompare(b.sectionPath || '');
                        });
                        return groups;
                    },
                    buildTimeSortedGroups(order: 'asc' | 'desc'): AnnotationGroup[] {
                        const sorted = this.flattenedAnnotations.slice().sort((a, b) => {
                            const delta = (a.createdAt || 0) - (b.createdAt || 0);
                            return order === 'asc' ? delta : -delta;
                        });
                        const groups: AnnotationGroup[] = [];
                        sorted.forEach((anno) => {
                            const sectionPath = (anno.sectionPath || '').trim();
                            const lastGroup = groups[groups.length - 1];
                            if (!lastGroup || lastGroup.sectionPath !== sectionPath) {
                                groups.push({ sectionPath, annotations: [anno] });
                            } else {
                                lastGroup.annotations.push(anno);
                            }
                        });
                        return groups;
                    },
                    onUpdateOpen(newValue: boolean) {
                        if (!newValue) {
                            this.closeDialog();
                        }
                    },
                    closeDialog() {
                        this.open = false;
                        setTimeout(() => {
                            removeDialogMount();
                            viewerAppInstance = null;
                            viewerDialogOptions = null;
                        }, 200);
                    }
                },
                template: `
                    <cdx-dialog
                        v-model:open="open"
                        :title="$options.i18n.title"
                        :use-close-button="true"
                        :default-action="{ label: $options.i18n.close }"
                        @default="closeDialog"
                        @update:open="onUpdateOpen"
                        class="review-tool-dialog review-tool-annotation-viewer-dialog"
                    >
                        <div v-if="isEmpty" class="review-tool-annotation-viewer__empty">
                            {{ $options.i18n.empty }}
                        </div>
                        <div v-else class="review-tool-annotation-viewer__list">
                            <div
                                v-for="group in sortedGroups"
                                :key="group.sectionPath || 'default'"
                                class="review-tool-annotation-viewer__section"
                            >
                                <h4 class="review-tool-annotation-viewer__section-title">
                                    {{ group.sectionPath || $options.i18n.sectionFallback }}
                                </h4>
                                <ul class="review-tool-annotation-viewer__items">
                                    <li
                                        v-for="anno in group.annotations"
                                        :key="anno.id"
                                        class="review-tool-annotation-viewer__item"
                                    >
                                        <div class="review-tool-annotation-viewer__quote">“{{ quotePreview(anno.sentenceText) }}”</div>
                                        <div class="review-tool-annotation-viewer__opinion">{{ anno.opinion }}</div>
                                        <div class="review-tool-annotation-viewer__meta">
                                            {{ anno.createdBy }} · {{ formatTimestamp(anno.createdAt) }}
                                        </div>
                                        <div class="review-tool-annotation-viewer__actions">
                                            <cdx-button
                                                size="small"
                                                weight="quiet"
                                                @click.prevent="handleEdit(anno.id, group.sectionPath)"
                                            >
                                                {{ $options.i18n.edit }}
                                            </cdx-button>
                                            <cdx-button
                                                size="small"
                                                weight="quiet"
                                                action="destructive"
                                                :disabled="deletingAnnotationId === anno.id"
                                                @click.prevent="handleDelete(anno.id, group.sectionPath)"
                                            >
                                                {{ $options.i18n.delete }}
                                            </cdx-button>
                                        </div>
                                    </li>
                                </ul>
                            </div>
                        </div>
                        <template #footer>
                            <div class="review-tool-annotation-viewer__footer">
                                <div class="review-tool-annotation-viewer__footer-left">
                                    <cdx-select
                                        v-model:selected="sortMethod"
                                        :menu-items="sortingOptions"
                                        :disabled="isEmpty"
                                        :aria-label="$options.i18n.sortLabel"
                                        class="review-tool-annotation-viewer__sort-select"
                                    />
                                </div>
                                <div class="review-tool-annotation-viewer__footer-actions">
                                    <cdx-button
                                        v-if="!isEmpty"
                                        weight="quiet"
                                        @click.prevent="handleExport"
                                    >
                                        {{ $options.i18n.export }}
                                    </cdx-button>

                                    <cdx-button
                                        v-if="canClearAll && !isEmpty"
                                        action="destructive"
                                        weight="quiet"
                                        :disabled="clearingAll"
                                        @click.prevent="handleClearAll"
                                    >
                                        {{ $options.i18n.clearAll }}
                                    </cdx-button>
                                </div>
                            </div>
                        </template>
                    </cdx-dialog>
                `
            });

            registerCodexComponents(app, Codex);
            viewerAppInstance = mountApp(app);
        })
        .catch((error: any) => {
            console.error("[ReviewTool] Failed to open annotation viewer dialog", error);
            mw && mw.notify && mw.notify(
                state.convByVar({ hant: "無法開啟批註列表。", hans: "无法开启批注列表。" }),
                { type: "error", title: "[ReviewTool]" }
            );
        });
}
