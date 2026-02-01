<script lang="ts" setup>
import state from "../../state";
import { AnnotationGroup, Annotation } from "../../annotations";
import { compareOrderKeys } from "../../dom/numeric_pos";
import { removeDialogMount } from "../../dialog";
import type { Ref, ComputedRef } from "vue";

type AnnotationViewerI18n = {
	title: string;
	empty: string;
	edit: string;
	delete: string;
	deleteConfirm: string;
	clearAll: string;
	clearAllConfirm: string;
	clearAllDone: string;
	clearAllNothing: string;
	clearAllError: string;
	sectionFallback: string;
	close: string;
	export: string;
	exportDone: string;
	exportError: string;
	sortLabel: string;
	sortCreatedAsc: string;
	sortCreatedDesc: string;
	sortPosition: string;
};

function buildI18n(): AnnotationViewerI18n {
	return {
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
		export: state.convByVar({ hant: "匯出", hans: "导出" }),
		exportDone: state.convByVar({ hant: "已匯出批註。", hans: "已导出批注。" }),
		exportError: state.convByVar({ hant: "匯出批註時發生錯誤。", hans: "导出批注时发生错误。" }),
		sortLabel: state.convByVar({ hant: "排序方式", hans: "排序方式" }),
		sortCreatedAsc: state.convByVar({ hant: "最早時間優先", hans: "最早时间优先" }),
		sortCreatedDesc: state.convByVar({ hant: "最新時間優先", hans: "最新时间优先" }),
		sortPosition: state.convByVar({ hant: "頁面位置", hans: "页面位置" })
	};
}

type VueRuntime = {
	ref: <T>(value: T) => Ref<T>;
	computed: <T>(getter: () => T) => ComputedRef<T>;
};

const VueRuntime = (window as unknown as { Vue?: VueRuntime }).Vue;
if (!VueRuntime) {
	throw new Error("Vue runtime not found");
}
const { ref, computed } = VueRuntime;

const props = withDefaults(defineProps<{
	initialGroups?: AnnotationGroup[];
	onEditAnnotation?: (annotationId: string, sectionPath: string) => void;
	onDeleteAnnotation?: (annotationId: string, sectionPath: string) => Promise<void> | void;
	onClearAllAnnotations?: () => Promise<boolean | void> | boolean | void;
	onClosed?: () => void;
}>(), {
	initialGroups: () => [],
	onEditAnnotation: undefined,
	onDeleteAnnotation: undefined,
	onClearAllAnnotations: undefined,
	onClosed: undefined
});

const i18n = buildI18n();
const open = ref(true);
const groups = ref<AnnotationGroup[]>(props.initialGroups || []);
const deletingAnnotationId = ref<string | null>(null);
const clearingAll = ref(false);
const sortMethod = ref("position");

defineExpose({ open, groups });

const canClearAll = computed(() => Boolean(props.onClearAllAnnotations));
const isEmpty = computed(() => {
	if (!Array.isArray(groups.value) || !groups.value.length) return true;
	return groups.value.every((group: AnnotationGroup) => !group.annotations || group.annotations.length === 0);
});

const flattenedAnnotations = computed(() => {
	if (!Array.isArray(groups.value)) return [] as Annotation[];
	const list: Annotation[] = [];
	groups.value.forEach((group: AnnotationGroup) => {
		if (!Array.isArray(group.annotations)) return;
		group.annotations.forEach((anno) => list.push(anno));
	});
	return list;
});

const sortingOptions = computed(() => ([
	{ value: "position", label: i18n.sortPosition || "頁面位置" },
	{ value: "created-desc", label: i18n.sortCreatedDesc || "最新時間優先" },
	{ value: "created-asc", label: i18n.sortCreatedAsc || "最早時間優先" }
]));

function buildPositionSortedGroups(): AnnotationGroup[] {
	const buckets = new Map<string, Annotation[]>();
	flattenedAnnotations.value.forEach((anno) => {
		const key = (anno.sectionPath || "").trim();
		const bucket = buckets.get(key);
		if (bucket) {
			bucket.push(anno);
		} else {
			buckets.set(key, [anno]);
		}
	});
	const mapped = Array.from(buckets.entries()).map(([sectionPath, annotations]) => ({
		sectionPath,
		annotations: annotations.slice().sort((a, b) => {
			const cmp = compareOrderKeys(a.sentencePos, b.sentencePos);
			if (cmp !== 0) return cmp;
			return (a.createdAt || 0) - (b.createdAt || 0);
		})
	}));
	mapped.sort((a, b) => {
		const firstA = a.annotations[0];
		const firstB = b.annotations[0];
		const cmp = compareOrderKeys(firstA?.sentencePos, firstB?.sentencePos);
		if (cmp !== 0) return cmp;
		return (a.sectionPath || "").localeCompare(b.sectionPath || "");
	});
	return mapped;
}

function buildTimeSortedGroups(order: "asc" | "desc"): AnnotationGroup[] {
	const sorted = flattenedAnnotations.value.slice().sort((a, b) => {
		const delta = (a.createdAt || 0) - (b.createdAt || 0);
		return order === "asc" ? delta : -delta;
	});
	const mapped: AnnotationGroup[] = [];
	sorted.forEach((anno) => {
		const sectionPath = (anno.sectionPath || "").trim();
		const lastGroup = mapped[mapped.length - 1];
		if (!lastGroup || lastGroup.sectionPath !== sectionPath) {
			mapped.push({ sectionPath, annotations: [anno] });
		} else {
			lastGroup.annotations.push(anno);
		}
	});
	return mapped;
}

const sortedGroups = computed(() => {
	if (sortMethod.value === "created-desc") {
		return buildTimeSortedGroups("desc");
	}
	if (sortMethod.value === "created-asc") {
		return buildTimeSortedGroups("asc");
	}
	return buildPositionSortedGroups();
});

function quotePreview(text: string): string {
	if (!text) return "";
	const trimmed = text.trim();
	if (trimmed.length <= 60) return trimmed;
	return `${trimmed.slice(0, 57)}…`;
}

function formatTimestamp(ts: number | undefined): string {
	if (!ts) return "";
	try {
		return new Date(ts).toLocaleString();
	} catch {
		return "";
	}
}

function handleEdit(annotationId: string, sectionPath: string) {
	props.onEditAnnotation?.(annotationId, sectionPath);
}

function handleDelete(annotationId: string, sectionPath: string) {
	if (!props.onDeleteAnnotation) return;
	const ok = window.confirm(i18n.deleteConfirm);
	if (!ok) return;
	deletingAnnotationId.value = annotationId;
	Promise.resolve(props.onDeleteAnnotation(annotationId, sectionPath))
		.catch((error) => {
			console.error("[ReviewTool] Failed to delete annotation", error);
			if (mw && mw.notify) {
				mw.notify(
					state.convByVar({ hant: "刪除批註時發生錯誤。", hans: "删除批注时发生错误。" }),
					{ type: "error", title: "[ReviewTool]" }
				);
			}
		})
		.finally(() => {
			deletingAnnotationId.value = null;
		});
}

function handleClearAll() {
	if (!props.onClearAllAnnotations || isEmpty.value) return;
	const ok = window.confirm(i18n.clearAllConfirm);
	if (!ok) return;
	clearingAll.value = true;
	Promise.resolve(props.onClearAllAnnotations())
		.then((result) => {
			const cleared = Boolean(result);
			if (mw && mw.notify) {
				mw.notify(
					cleared ? i18n.clearAllDone : i18n.clearAllNothing,
					{ tag: "review-tool" }
				);
			}
		})
		.catch((error) => {
			console.error("[ReviewTool] Failed to clear annotations", error);
			if (mw && mw.notify) {
				mw.notify(i18n.clearAllError, { type: "error", title: "[ReviewTool]" });
			}
		})
		.finally(() => {
			clearingAll.value = false;
		});
}

function handleExport() {
	if (isEmpty.value) return;
	try {
		const payload = {
			exportedAt: Date.now(),
			groups: groups.value
		};
		const json = JSON.stringify(payload, null, 2);
		const blob = new Blob([json], { type: "application/json;charset=utf-8" });
		const filename = `review-tool-annotations-${new Date().toISOString().replace(/[:.]/g, "")}.json`;
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = filename;
		document.body.appendChild(a);
		a.click();
		a.remove();
		URL.revokeObjectURL(url);
		if (mw && mw.notify) {
			mw.notify(i18n.exportDone, { tag: "review-tool" });
		}
	} catch (error) {
		console.error("[ReviewTool] Failed to export annotations", error);
		if (mw && mw.notify) {
			mw.notify(i18n.exportError, { type: "error", title: "[ReviewTool]" });
		}
	}
}

function onUpdateOpen(newValue: boolean) {
	if (!newValue) {
		closeDialog();
	}
}

function closeDialog() {
	open.value = false;
	setTimeout(() => {
		removeDialogMount();
		props.onClosed?.();
	}, 200);
}
</script>

<template>
	<cdx-dialog
		v-model:open="open"
		:title="i18n.title"
		:use-close-button="true"
		:default-action="{ label: i18n.close }"
		@default="closeDialog"
		@update:open="onUpdateOpen"
		class="review-tool-dialog review-tool-annotation-viewer-dialog"
	>
		<div v-if="isEmpty" class="review-tool-annotation-viewer__empty">
			{{ i18n.empty }}
		</div>
		<div v-else class="review-tool-annotation-viewer__list">
			<div
				v-for="group in sortedGroups"
				:key="group.sectionPath || 'default'"
				class="review-tool-annotation-viewer__section"
			>
				<h4 class="review-tool-annotation-viewer__section-title">
					{{ group.sectionPath || i18n.sectionFallback }}
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
								{{ i18n.edit }}
							</cdx-button>
							<cdx-button
								size="small"
								weight="quiet"
								action="destructive"
								:disabled="deletingAnnotationId === anno.id"
								@click.prevent="handleDelete(anno.id, group.sectionPath)"
							>
								{{ i18n.delete }}
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
						:aria-label="i18n.sortLabel"
						class="review-tool-annotation-viewer__sort-select"
					/>
				</div>
				<div class="review-tool-annotation-viewer__footer-actions">
					<cdx-button
						v-if="!isEmpty"
						weight="quiet"
						@click.prevent="handleExport"
					>
						{{ i18n.export }}
					</cdx-button>

					<cdx-button
						v-if="canClearAll && !isEmpty"
						action="destructive"
						weight="quiet"
						:disabled="clearingAll"
						@click.prevent="handleClearAll"
					>
						{{ i18n.clearAll }}
					</cdx-button>
				</div>
			</div>
		</template>
	</cdx-dialog>
</template>
