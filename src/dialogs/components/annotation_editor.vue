<script lang="ts" setup>
import state from "../../state";
import { removeDialogMount } from "../../dialog";
import type { Ref, ComputedRef } from "vue";

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

function buildI18n(): AnnotationEditorI18n {
	return {
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
	};
}

type VueRuntime = {
	ref: <T>(value: T) => Ref<T>;
	computed: <T>(getter: () => T) => ComputedRef<T>;
	watch: <T>(source: unknown, cb: (value: T) => void) => void;
};

const VueRuntime = (window as unknown as { Vue?: VueRuntime }).Vue;
if (!VueRuntime) {
	throw new Error("Vue runtime not found");
}
const { ref, computed, watch } = VueRuntime;

const props = withDefaults(defineProps<{
	mode?: "create" | "edit";
	sectionPath?: string;
	sentenceText?: string;
	initialOpinion?: string;
	allowDelete?: boolean;
	onResolve?: (result: { action: "save"; opinion: string } | { action: "delete" } | { action: "cancel" }) => void;
}>(), {
	mode: "create",
	sectionPath: "",
	sentenceText: "",
	initialOpinion: "",
	allowDelete: false,
	onResolve: undefined
});

const i18n = buildI18n();
const open = ref(true);
const opinion = ref(typeof props.initialOpinion === "string" ? props.initialOpinion : "");
const showValidationError = ref(false);

const dialogTitle = computed(() => (props.mode === "edit" ? i18n.titleEdit : i18n.titleCreate));
const primaryLabel = computed(() => (props.mode === "edit" ? i18n.save : i18n.create));
const canSave = computed(() => Boolean((opinion.value || "").trim()));

watch(opinion, () => {
	if (showValidationError.value && canSave.value) {
		showValidationError.value = false;
	}
});

function closeDialog() {
	open.value = false;
	setTimeout(() => removeDialogMount(), 200);
}

function onPrimaryAction() {
	if (!canSave.value) {
		showValidationError.value = true;
		return;
	}
	props.onResolve?.({ action: "save", opinion: opinion.value.trim() });
	closeDialog();
}

function onCancelAction() {
	props.onResolve?.({ action: "cancel" });
	closeDialog();
}

function onDeleteClick() {
	if (!props.allowDelete) return;
	const ok = window.confirm(i18n.deleteConfirm);
	if (!ok) return;
	props.onResolve?.({ action: "delete" });
	closeDialog();
}

function onUpdateOpen(newValue: boolean) {
	if (!newValue) {
		onCancelAction();
	}
}
</script>

<template>
	<cdx-dialog
		v-model:open="open"
		:title="dialogTitle"
		:use-close-button="true"
		@update:open="onUpdateOpen"
		class="review-tool-dialog review-tool-annotation-editor-dialog"
	>
		<div class="review-tool-form-section">
			<div class="review-tool-annotation-editor__label">{{ i18n.sectionLabel }}</div>
			<div class="review-tool-annotation-editor__section">{{ props.sectionPath }}</div>
		</div>

		<div class="review-tool-form-section">
			<div class="review-tool-annotation-editor__label">{{ i18n.sentenceLabel }}</div>
			<div class="review-tool-annotation-editor__quote">{{ props.sentenceText }}</div>
		</div>

		<div class="review-tool-form-section">
			<label class="review-tool-annotation-editor__label" :for="'annotation-opinion-input'">
				{{ i18n.opinionLabel }}
			</label>
			<cdx-text-area
				id="annotation-opinion-input"
				v-model="opinion"
				rows="5"
				:placeholder="i18n.opinionPlaceholder"
			></cdx-text-area>
			<div v-if="showValidationError" class="review-tool-annotation-editor__error">
				{{ i18n.opinionRequired }}
			</div>
		</div>

		<template #footer>
			<div class="review-tool-annotation-editor__footer">
				<cdx-button
					v-if="props.allowDelete"
					weight="quiet"
					action="destructive"
					class="review-tool-annotation-editor__delete"
					@click.prevent="onDeleteClick"
				>
					{{ i18n.delete }}
				</cdx-button>
				<div class="review-tool-annotation-editor__actions">
					<cdx-button weight="quiet" @click.prevent="onCancelAction">
						{{ i18n.cancel }}
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
</template>
