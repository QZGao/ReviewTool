<script lang="ts">
import state from "../../state";
import type { AnnotationGroup, Annotation } from "../../annotations";
import type { UnknownApiParams } from "types-mediawiki/api_params";
import { createApi, mode } from "../../mediawiki";
import { resolveAnnotationArticle, listAnnotatedRevisions, loadAnnotationRevision, type AnnotationReadRequest, type AnnotationArticle, type AnnotatedRevision } from "../../annotation/revision-import";
import { compareOrderKeys } from "../../dom/numeric_pos";
import { findSectionInfoFromHeading, appendTextToSection, retrieveFullText, parseWikitextToHtml, compareWikitext } from "../../api";
import { advanceDialogStep, regressDialogStep, triggerDialogContentHooks } from "../utils";
import { removeDialogMount } from "../../dialog";

type CheckWritingI18n = {
	dialogTitle: string;
	save: string;
	saving: string;
	cancel: string;
	addChapter: string;
	removeChapter: string;
	addSuggestion: string;
	removeSuggestion: string;
	chapterTitleLabel: string;
	quoteLabel: string;
	quotePlaceholder: string;
	suggestionPlaceholder: string;
	next: string;
	previous: string;
	previewHeading: string;
	diffHeading: string;
	diffLoading: string;
	editHeading: string;
	editInstruction: string;
	editPlaceholder: string;
	loadAnnotations: string;
	importFromFile: string;
	importSuccess: string;
	importError: string;
	importInvalid: string;
	annotationFallbackChapter: string;
	chooseAnnotationRevision: string;
	chooseAnnotationRevisionHelp: string;
	loadingAnnotations: string;
	loadSelectedAnnotations: string;
	noAnnotations: string;
	noComments: string;
	annotationFilters: string;
	annotationOnlyOwn: string;
	annotationTopLevelOnly: string;
	annotationUnresolvedOnly: string;
	annotationListFailed: string;
	annotationLoadFailed: string;
	annotationArticleMissing: string;
	retry: string;
	close: string;
	newest: string;
};

type CheckWritingSuggestion = { quote: string; suggestion: string };
type CheckWritingChapter = { title: string; suggestions: CheckWritingSuggestion[] };

type CheckWritingDialogVm = {
	open: boolean;
	isSaving: boolean;
	isLoadingAnnotations: boolean;
	annotationPickerOpen: boolean;
	annotationRevisions: AnnotatedRevision[];
	selectedAnnotationRevision: number | null;
	annotationArticle: AnnotationArticle | null;
	annotationReader: ReturnType<typeof createAnnotationReader> | null;
	annotationImportToken: number;
	annotationPickerError: string;
	annotationOnlyOwn: boolean;
	annotationTopLevelOnly: boolean;
	annotationUnresolvedOnly: boolean;
	currentStep: number;
	chapters: CheckWritingChapter[];
	previewWikitext: string;
	previewHtml: string;
	existingSectionText: string;
	pendingNewSectionText: string;
	diffHtml: string;
	diffLines: string[];
	editedDraft: string;
	$nextTick: (cb: () => void) => void;
	primaryAction: { label: string; actionType: string; disabled: boolean };
	defaultAction: { label: string; disabled: boolean };
	showAnnotationLoaderButton: boolean;
	$options: { i18n: CheckWritingI18n };
	$refs: Record<string, HTMLElement | HTMLInputElement | HTMLElement[] | undefined>;
	triggerContentHooks: (kind: "preview" | "diff") => void;
	getPendingCheckWritingSectionInfo: () => {
		headingEl: Element | null;
		sec: { pageTitle?: string | null; sectionId?: number | null } | null;
		pageTitleToUse: string;
		sectionIdToUse: number | null;
	};
	getStepClass: (step: number) => Record<string, boolean>;
	prepareEditDraft: () => void;
	preparePreviewContent: () => void;
	prepareDiffContent: () => void;
	onPrimaryAction: () => void;
	onDefaultAction: () => void;
	onUpdateOpen: (newValue: boolean) => void;
	closeDialog: () => void;
	buildPreviewBundle: () => { previewFragment: string; appendSuffix: string } | null;
	buildWikitext: () => string;
	buildDiffLines: (oldText: string, appendedFragment: string) => string[];
	handleImportClick: () => void;
	generateImportAnnotationId: () => string;
	normalizeImportedAnnotation: (raw: unknown, fallbackSection?: string) => Annotation;
	onAnnotationFileSelected: (ev: Event) => void;
	loadAnnotationsIntoForm: () => Promise<void>;
	loadSelectedAnnotations: () => Promise<void>;
	closeAnnotationPicker: () => void;
	onAnnotationPickerOpen: (open: boolean) => void;
	annotationRevisionLabel: (revision: AnnotatedRevision) => string;
	buildChaptersFromAnnotationGroups: (groups: AnnotationGroup[]) => CheckWritingChapter[];
	applyAnnotationChapters: (nextChapters: CheckWritingChapter[]) => void;
	sortAnnotationsByPosition: (list: Annotation[] | undefined) => Annotation[];
	groupAnnotationsBySection: (list: Annotation[]) => AnnotationGroup[];
	applyImportedAnnotations: (importedAnnotations: Annotation[]) => void;
	reportAnnotationLoadFailure: (message: string) => void;
	saveCheckWriting: () => void;
	addChapter: () => void;
	removeChapter: (idx: number) => void;
	addSuggestion: (chIdx: number) => void;
	removeSuggestion: (chIdx: number, sIdx: number) => void;
};

function buildI18n(): CheckWritingI18n {
	return {
		dialogTitle: state.convByVar({ hant: "檢查「", hans: "检查「" }) + state.articleTitle + state.convByVar({ hant: "」的文筆", hans: "」的文笔" }),
		save: state.convByVar({ hant: "儲存", hans: "保存" }),
		saving: state.convByVar({ hant: "儲存中…", hans: "保存中…" }),
		cancel: state.convByVar({ hant: "取消", hans: "取消" }),
		addChapter: state.convByVar({ hant: "新增章節", hans: "新增章节" }),
		removeChapter: state.convByVar({ hant: "刪除章節", hans: "删除章节" }),
		addSuggestion: state.convByVar({ hant: "新增意見", hans: "新增意见" }),
		removeSuggestion: state.convByVar({ hant: "刪除意見", hans: "删除意见" }),
		chapterTitleLabel: state.convByVar({ hant: "章節標題", hans: "章节标题" }),
		quoteLabel: state.convByVar({ hant: "引用原文", hans: "引用原文" }),
		quotePlaceholder: state.convByVar({ hant: "原文句子（可留空）", hans: "原文句子（可留空）" }),
		suggestionPlaceholder: state.convByVar({ hant: "意見或建議", hans: "意见或建议" }),
		next: state.convByVar({ hant: "下一步", hans: "下一步" }),
		previous: state.convByVar({ hant: "上一步", hans: "上一步" }),
		previewHeading: state.convByVar({ hant: "預覽", hans: "预览" }),
		diffHeading: state.convByVar({ hant: "差異", hans: "差异" }),
		diffLoading: state.convByVar({ hant: "差異載入中…", hans: "差异载入中…" }),
		editHeading: state.convByVar({ hant: "檢查編輯", hans: "检查编辑" }),
		editInstruction: state.convByVar({ hant: "在此調整要新增的維基語法內容，再前往預覽或差異。", hans: "在此调整要新增的维基语法内容，再前往预览或差异。" }),
		editPlaceholder: state.convByVar({ hant: "在此輸入或修改文筆建議的維基語法內容…", hans: "在此输入或修改文笔建议的维基语法内容…" }),
		loadAnnotations: state.convByVar({ hant: "載入批註", hans: "载入批注" }),
		importFromFile: state.convByVar({ hant: "從檔案載入", hans: "从文件载入" }),
		importSuccess: state.convByVar({ hant: "已從檔案載入批註。", hans: "已从文件载入批注。" }),
		importError: state.convByVar({ hant: "載入檔案時發生錯誤。", hans: "读取文件时发生错误。" }),
		importInvalid: state.convByVar({ hant: "無效的批註檔案。", hans: "无效的批注文件。" }),
		annotationFallbackChapter: state.convByVar({ hant: "（未指定章節）", hans: "（未指定章节）" }),
		chooseAnnotationRevision: state.convByVar({ hant: "選擇批註版本", hans: "选择批注版本" }),
		chooseAnnotationRevisionHelp: state.convByVar({ hant: "選擇要載入哪個條目版本的批註。", hans: "选择要载入哪个条目版本的批注。" }),
		loadingAnnotations: state.convByVar({ hant: "載入中…", hans: "载入中…" }),
		loadSelectedAnnotations: state.convByVar({ hant: "載入", hans: "载入" }),
		noAnnotations: state.convByVar({ hant: "這個條目還沒有批註。", hans: "这个条目还没有批注。" }),
		noComments: state.convByVar({ hant: "沒有符合條件的評論，請調整選項或選擇其他版本。", hans: "没有符合条件的评论，请调整选项或选择其他版本。" }),
		annotationFilters: state.convByVar({ hant: "載入範圍", hans: "载入范围" }),
		annotationOnlyOwn: state.convByVar({ hant: "只載入我的評論", hans: "只载入我的评论" }),
		annotationTopLevelOnly: state.convByVar({ hant: "只載入各討論串的首則評論", hans: "只载入各讨论串的首条评论" }),
		annotationUnresolvedOnly: state.convByVar({ hant: "只載入尚未解決的評論", hans: "只载入尚未解决的评论" }),
		annotationListFailed: state.convByVar({ hant: "無法取得批註版本，請重試。", hans: "无法获取批注版本，请重试。" }),
		annotationLoadFailed: state.convByVar({ hant: "無法載入這個版本的批註，請重試或選擇其他版本。", hans: "无法载入这个版本的批注，请重试或选择其他版本。" }),
		annotationArticleMissing: state.convByVar({ hant: "找不到這個條目。", hans: "找不到这个条目。" }),
		retry: state.convByVar({ hant: "重試", hans: "重试" }),
		close: state.convByVar({ hant: "關閉", hans: "关闭" }),
		newest: state.convByVar({ hant: "最新", hans: "最新" })
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object";
}

function createAnnotationReader() {
	const api = createApi();
	let cancelled = false;
	const request: AnnotationReadRequest = params => new Promise((resolve, reject) => {
		if (cancelled) { reject(new Error("Annotation import cancelled.")); return; }
		api.get(params as UnknownApiParams).done(resolve).fail((code: unknown) => reject(new Error(typeof code === 'string' ? code : 'MediaWiki read failed.')));
	});
	return { request, cancel: () => { cancelled = true; api.abort(); } };
}

export default {
	data() {
		return {
			open: true,
			isSaving: false,
			isLoadingAnnotations: false,
			annotationPickerOpen: false,
			annotationRevisions: [] as AnnotatedRevision[],
			selectedAnnotationRevision: null as number | null,
			annotationArticle: null as AnnotationArticle | null,
			annotationReader: null as ReturnType<typeof createAnnotationReader> | null,
			annotationImportToken: 0,
			annotationPickerError: "",
			annotationOnlyOwn: true,
			annotationTopLevelOnly: true,
			annotationUnresolvedOnly: true,
			currentStep: 0,
			chapters: [{ title: "", suggestions: [{ quote: "", suggestion: "" }] }],
			previewWikitext: "",
			previewHtml: "",
			existingSectionText: "",
			pendingNewSectionText: "",
			diffHtml: "",
			diffLines: [] as string[],
			editedDraft: ""
		};
	},
	computed: {
		annotationPickerPrimary(this: CheckWritingDialogVm) {
			if (!this.annotationRevisions.length) return undefined;
			return { label: this.isLoadingAnnotations ? this.$options.i18n.loadingAnnotations : this.$options.i18n.loadSelectedAnnotations,
				actionType: "progressive", disabled: this.isLoadingAnnotations || this.selectedAnnotationRevision === null };
		},
		primaryAction(this: CheckWritingDialogVm) {
			if (this.currentStep < 3) {
				return { label: this.$options.i18n.next || "Next", actionType: "progressive", disabled: false };
			}
			return {
				label: this.isSaving ? this.$options.i18n.saving : this.$options.i18n.save,
				actionType: "progressive",
				disabled: this.isSaving
			};
		},
		defaultAction(this: CheckWritingDialogVm) {
			if (this.currentStep > 0) return { label: this.$options.i18n.previous || "Previous", disabled: false };
			return { label: this.$options.i18n.cancel, disabled: false };
		},
		showAnnotationLoaderButton(this: CheckWritingDialogVm) {
			return this.currentStep === 0;
		}
	},
	beforeCreate(this: CheckWritingDialogVm) {
		this.$options.i18n = buildI18n();
	},
	beforeUnmount(this: CheckWritingDialogVm) { this.closeAnnotationPicker(); },
	methods: {
		triggerContentHooks(this: CheckWritingDialogVm, kind: "preview" | "diff") {
			triggerDialogContentHooks(this, kind);
		},
		getPendingCheckWritingSectionInfo(this: CheckWritingDialogVm) {
			const headingEl: Element | null = state.pendingReviewHeading || null;
			const sec = findSectionInfoFromHeading(headingEl);
			const pageTitleToUse = sec && sec.pageTitle ? sec.pageTitle : (state.articleTitle || "");
			const sectionIdToUse = typeof sec?.sectionId === "number" ? sec.sectionId : (sec?.sectionId ?? null);
			return { headingEl, sec, pageTitleToUse, sectionIdToUse };
		},
		getStepClass(this: CheckWritingDialogVm, step: number) {
			return { "review-tool-multistep-dialog__stepper__step--active": step <= this.currentStep };
		},
		prepareEditDraft(this: CheckWritingDialogVm) {
			this.editedDraft = this.buildWikitext().trim();
		},
		preparePreviewContent(this: CheckWritingDialogVm) {
			const { pageTitleToUse, sectionIdToUse } = this.getPendingCheckWritingSectionInfo();
			this.previewHtml = "";
			this.previewWikitext = "";
			this.pendingNewSectionText = "";
			this.existingSectionText = "";
			this.diffHtml = "";
			this.diffLines = [];

			const bundle = this.buildPreviewBundle();
			if (!bundle) {
				return;
			}
			const { previewFragment, appendSuffix } = bundle;
			this.previewWikitext = previewFragment;

			const renderPreview = (existingText: string) => {
				const baseline = existingText || "";
				this.existingSectionText = baseline;
				this.pendingNewSectionText = baseline + appendSuffix;
				parseWikitextToHtml(previewFragment, pageTitleToUse).then((html: string) => {
					this.previewHtml = html || "";
					if (this.previewHtml && this.currentStep === 2) {
						this.triggerContentHooks("preview");
					}
				}).catch((error: unknown) => {
					console.error("[ReviewTool] parseWikitextToHtml failed", error);
					this.previewHtml = "";
				});
			};

			if (sectionIdToUse != null) {
				retrieveFullText(pageTitleToUse, sectionIdToUse).then(({ text }) => {
					renderPreview(text || "");
				}).catch((error: unknown) => {
					console.error("[ReviewTool] retrieveFullText failed", error);
					renderPreview("");
				});
			} else {
				renderPreview("");
			}
		},
		prepareDiffContent(this: CheckWritingDialogVm) {
			const { pageTitleToUse, sectionIdToUse } = this.getPendingCheckWritingSectionInfo();
			this.diffHtml = "";
			this.diffLines = [];

			const bundle = this.buildPreviewBundle();
			if (!bundle) {
				return;
			}
			const { previewFragment, appendSuffix } = bundle;
			this.previewWikitext = previewFragment;

			const runDiff = (existingText: string) => {
				const baseline = existingText || "";
				const newSectionText = baseline + appendSuffix;
				this.existingSectionText = baseline;
				this.pendingNewSectionText = newSectionText;
				compareWikitext(baseline, newSectionText).then((diffHtml: string) => {
					this.diffHtml = diffHtml || "";
					if (this.diffHtml && this.currentStep === 3) {
						this.triggerContentHooks("diff");
					} else {
						this.diffLines = this.buildDiffLines(baseline, appendSuffix);
					}
				}).catch((error: unknown) => {
					console.error("[ReviewTool] compareWikitext failed", error);
					this.diffHtml = "";
					this.diffLines = this.buildDiffLines(baseline, appendSuffix);
				});
			};

			if (
				this.pendingNewSectionText &&
				typeof this.existingSectionText === "string" &&
				this.pendingNewSectionText === this.existingSectionText + appendSuffix
			) {
				runDiff(this.existingSectionText);
				return;
			}

			if (sectionIdToUse != null) {
				retrieveFullText(pageTitleToUse, sectionIdToUse).then(({ text }) => {
					runDiff(text || "");
				}).catch((error: unknown) => {
					console.error("[ReviewTool] retrieveFullText failed", error);
					runDiff("");
				});
			} else {
				runDiff("");
			}
		},
		onPrimaryAction(this: CheckWritingDialogVm) {
			if (advanceDialogStep(this, {
				totalSteps: 4,
				onEnterEditStep: this.prepareEditDraft,
				onEnterPreviewStep: this.preparePreviewContent,
				onEnterDiffStep: this.prepareDiffContent,
				previewStepIndex: 2,
				diffStepIndex: 3
			})) {
				return;
			}
			this.saveCheckWriting();
		},
		onDefaultAction(this: CheckWritingDialogVm) {
			if (regressDialogStep(this)) {
				return;
			}
			this.closeDialog();
		},
		onUpdateOpen(this: CheckWritingDialogVm, newValue: boolean) {
			if (!newValue) {
				this.closeDialog();
			}
		},
		closeDialog(this: CheckWritingDialogVm) {
			this.closeAnnotationPicker();
			this.open = false;
			setTimeout(() => {
				removeDialogMount();
			}, 300);
		},
		buildPreviewBundle(this: CheckWritingDialogVm): { previewFragment: string; appendSuffix: string } | null {
			const draft = (this.editedDraft || "").trim();
			const fragment = draft || this.buildWikitext().trim();
			if (!fragment) {
				return null;
			}
			const appendSuffix = `\n\n${fragment}`;
			return { previewFragment: fragment, appendSuffix };
		},
		buildWikitext(this: CheckWritingDialogVm) {
			let wikitext = "";
			for (const ch of this.chapters) {
				const title = (ch.title || "").trim();
				wikitext += "'''" + title + "'''\n";
				for (const s of (ch.suggestions || [])) {
					const quote = (s.quote || "").trim();
					const suggestion = (s.suggestion || "").trim()
						.replace(/\n{2,}/g, "{{pb}}")
						.replace(/\n/g, "<br>");
					wikitext += `* {{rvw|1=${quote}}} —— ${suggestion}\n`;
				}
				wikitext += "--~~~~\n\n";
			}
			wikitext = wikitext.replace("{{rvw|1=}} —— ", "");
			return wikitext;
		},
		buildDiffLines(this: CheckWritingDialogVm, oldText: string, appendedFragment: string) {
			const oldLines = (oldText || "").split(/\r?\n/);
			const appendedOnly = (appendedFragment || "").replace(/^\s*\n+/, "");
			const newLines = appendedOnly.split(/\r?\n/);
			const out: string[] = [];
			out.push("--- Existing section ---");
			out.push(...oldLines.map(l => "  " + l));
			out.push("");
			out.push("+++ New content to append +++");
			out.push(...newLines.map(l => "+ " + l));
			return out;
		},
		handleImportClick(this: CheckWritingDialogVm) {
			const input = this.$refs.annotationImportInput;
			const inputEl = input instanceof HTMLInputElement ? input : null;
			if (inputEl && typeof inputEl.click === "function") {
				inputEl.value = "";
				inputEl.click();
			} else {
				console.warn("[ReviewTool] file input not available for import");
			}
		},
		generateImportAnnotationId(this: CheckWritingDialogVm): string {
			return `import-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
		},
		normalizeImportedAnnotation(this: CheckWritingDialogVm, raw: unknown, fallbackSection = ""): Annotation {
			const record = isRecord(raw) ? raw : {};
			const id = typeof record.id === "string" && record.id.trim()
				? record.id.trim()
				: this.generateImportAnnotationId();
			const sectionPath = typeof record.sectionPath === "string" && record.sectionPath.trim()
				? record.sectionPath.trim()
				: (fallbackSection || "");
			return {
				id,
				sectionPath,
				sentencePos: typeof record.sentencePos === "string" ? record.sentencePos : "",
				sentenceText: typeof record.sentenceText === "string" ? record.sentenceText : (typeof record.quote === "string" ? record.quote : ""),
				opinion: typeof record.opinion === "string" ? record.opinion : (typeof record.suggestion === "string" ? record.suggestion : ""),
				createdBy: typeof record.createdBy === "string" ? record.createdBy : (state.userName || "import"),
				createdAt: typeof record.createdAt === "number" ? record.createdAt : Date.now(),
				resolved: Boolean(record.resolved)
			};
		},
		onAnnotationFileSelected(this: CheckWritingDialogVm, ev: Event) {
			const input = ev.target instanceof HTMLInputElement ? ev.target : null;
			if (!input || !input.files || !input.files.length) return;
			const file = input.files[0];
			const reader = new FileReader();
			reader.onload = (event: ProgressEvent<FileReader>) => {
				try {
					const result = event.target?.result;
					const text = typeof result === "string" ? result : "";
					const parsed: unknown = JSON.parse(text);
					const pageName = state.articleTitle || "";
					if (!pageName) {
						this.reportAnnotationLoadFailure(state.convByVar({ hant: "無法識別條目名稱，無法載入檔案中的批註。", hans: "无法识别条目名称，无法载入文件中的批注。" }));
						return;
					}

					const importedAnnotations: Annotation[] = [];
					if (isRecord(parsed) && Array.isArray((parsed as { annotations?: unknown[] }).annotations)) {
						for (const a of (parsed as { annotations: unknown[] }).annotations) {
							importedAnnotations.push(this.normalizeImportedAnnotation(a));
						}
					} else if (isRecord(parsed) && Array.isArray((parsed as { groups?: unknown[] }).groups)) {
						for (const g of (parsed as { groups: unknown[] }).groups) {
							const group = isRecord(g) ? g : {};
							const section = typeof group.sectionPath === "string" ? group.sectionPath : "";
							const annos = Array.isArray(group.annotations) ? group.annotations : [];
							for (const a of annos) {
								const record = isRecord(a) ? a : {};
								const sectionPath = typeof record.sectionPath === "string" ? record.sectionPath : section;
								const merged = { ...record, sectionPath };
								importedAnnotations.push(this.normalizeImportedAnnotation(merged, section));
							}
						}
					} else {
						throw new Error("invalid-format");
					}

					if (!importedAnnotations.length) {
						throw new Error("empty-import");
					}

					this.applyImportedAnnotations(importedAnnotations);

					const msg = this.$options.i18n.importSuccess || "Imported annotations from file.";
					if (mw && mw.notify) {
						mw.notify(msg, { tag: "review-tool" });
					}
				} catch (error) {
					console.error("[ReviewTool] failed to import annotations from file", error);
					const msg = this.$options.i18n.importInvalid || "Invalid annotation file.";
					this.reportAnnotationLoadFailure(msg);
				}
			};
			reader.onerror = (error) => {
				console.error("[ReviewTool] FileReader error", error);
				const msg = this.$options.i18n.importError || "Failed to read file.";
				this.reportAnnotationLoadFailure(msg);
			};
			reader.readAsText(file, "utf-8");
		},
		async loadAnnotationsIntoForm(this: CheckWritingDialogVm) {
			if (this.isLoadingAnnotations) return;
			this.annotationReader?.cancel();
			const token = ++this.annotationImportToken;
			const reader = createAnnotationReader(); this.annotationReader = reader;
			this.annotationPickerOpen = true; this.isLoadingAnnotations = true;
			this.annotationPickerError = ""; this.annotationRevisions = []; this.selectedAnnotationRevision = null;
			this.annotationArticle = null;
			try {
				const article = await resolveAnnotationArticle(reader.request, state.articleTitle);
				if (token !== this.annotationImportToken) return;
				if (!article) { this.annotationPickerError = this.$options.i18n.annotationArticleMissing; return; }
				const talk = mw.Title.newFromText(article.title)?.getTalkPage();
				if (!talk) throw new Error('Article has no talk page.');
				const revisions = await listAnnotatedRevisions(reader.request, article, talk.getPrefixedText());
				if (token !== this.annotationImportToken) return;
				this.annotationArticle = article; this.annotationRevisions = revisions;
				this.selectedAnnotationRevision = revisions[0]?.revisionId ?? null;
			} catch (error) {
				if (token !== this.annotationImportToken) return;
				console.error('[ReviewTool] Could not list annotation revisions', error);
				this.annotationPickerError = this.$options.i18n.annotationListFailed;
			} finally { if (token === this.annotationImportToken) this.isLoadingAnnotations = false; }
		},
		async loadSelectedAnnotations(this: CheckWritingDialogVm) {
			const selected = this.annotationRevisions.find(item => item.revisionId === this.selectedAnnotationRevision);
			if (this.isLoadingAnnotations || !selected || !this.annotationArticle || !this.annotationReader) return;
			const token = this.annotationImportToken;
			this.isLoadingAnnotations = true; this.annotationPickerError = "";
			try {
				const groups = await loadAnnotationRevision(this.annotationReader.request, mw.config.get('wgDBname'), this.annotationArticle, selected, {
					currentUser: mw.config.get('wgUserName') || (mode === 'dry-run' ? 'Example' : null),
					onlyOwn: this.annotationOnlyOwn, topLevelOnly: this.annotationTopLevelOnly, unresolvedOnly: this.annotationUnresolvedOnly,
				});
				if (token !== this.annotationImportToken || !this.open || !this.annotationPickerOpen) return;
				if (!groups.length) { this.annotationPickerError = this.$options.i18n.noComments; return; }
				this.applyAnnotationChapters(this.buildChaptersFromAnnotationGroups(groups));
				this.closeAnnotationPicker();
				mw.notify(state.convByVar({ hant: "已載入批註，請檢查後繼續。", hans: "已载入批注，请检查后继续。" }), { tag: 'review-tool' });
			} catch (error) {
				if (token !== this.annotationImportToken) return;
				console.error('[ReviewTool] Could not import annotation revision', error);
				this.annotationPickerError = this.$options.i18n.annotationLoadFailed;
			} finally { if (token === this.annotationImportToken) this.isLoadingAnnotations = false; }
		},
		closeAnnotationPicker(this: CheckWritingDialogVm) {
			++this.annotationImportToken; this.annotationReader?.cancel(); this.annotationReader = null;
			this.annotationPickerOpen = false; this.isLoadingAnnotations = false;
		},
		onAnnotationPickerOpen(this: CheckWritingDialogVm, open: boolean) { if (!open) this.closeAnnotationPicker(); },
		annotationRevisionLabel(this: CheckWritingDialogVm, revision: AnnotatedRevision) {
			const label = state.convByVar({ hant: `版本 ${revision.revisionId}`, hans: `版本 ${revision.revisionId}` });
			if (!revision.timestamp) return label;
			const date = new Intl.DateTimeFormat(state.convByVar({ hant: 'zh-Hant', hans: 'zh-Hans' }), { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(revision.timestamp));
			return `${label} · ${date}`;
		},
		buildChaptersFromAnnotationGroups(this: CheckWritingDialogVm, groups: AnnotationGroup[]) {
			if (!groups.length) {
				return [];
			}
			const fallbackTitle = this.$options.i18n.annotationFallbackChapter || "";
			const sortedGroups = groups
				.map(group => ({
					...group,
					annotations: this.sortAnnotationsByPosition(group.annotations)
				}))
				.sort((a, b) => {
					const firstA = a.annotations[0];
					const firstB = b.annotations[0];
					const cmp = compareOrderKeys(firstA?.sentencePos, firstB?.sentencePos);
					if (cmp !== 0) return cmp;
					return (a.sectionPath || "").localeCompare(b.sectionPath || "");
				});
			const mapped = sortedGroups.map(group => {
				const suggestions = (group.annotations || []).map(anno => ({
					quote: anno.sentenceText || "",
					suggestion: anno.opinion || ""
				}));
				const usableSuggestions = suggestions.length ? suggestions : [{ quote: "", suggestion: "" }];
				return {
					title: group.sectionPath || fallbackTitle,
					suggestions: usableSuggestions
				};
			}).filter(group => Array.isArray(group.suggestions) && group.suggestions.length);
			return mapped;
		},
		applyAnnotationChapters(this: CheckWritingDialogVm, nextChapters: CheckWritingChapter[]) {
			if (!nextChapters.length) {
				return;
			}
			this.chapters = nextChapters;
			if (this.currentStep === 2) {
				this.preparePreviewContent();
			} else if (this.currentStep === 3) {
				this.prepareDiffContent();
			}
		},
		sortAnnotationsByPosition(this: CheckWritingDialogVm, list: Annotation[] | undefined): Annotation[] {
			if (!Array.isArray(list)) return [];
			return list.slice().sort((a, b) => {
				const cmp = compareOrderKeys(a?.sentencePos, b?.sentencePos);
				if (cmp !== 0) return cmp;
				return (a.createdAt || 0) - (b.createdAt || 0);
			});
		},
		groupAnnotationsBySection(this: CheckWritingDialogVm, list: Annotation[]): AnnotationGroup[] {
			const buckets = new Map<string, Annotation[]>();
			list.forEach((anno) => {
				const key = (anno.sectionPath || "").trim();
				const bucket = buckets.get(key);
				if (bucket) {
					bucket.push(anno);
				} else {
					buckets.set(key, [anno]);
				}
			});
			return Array.from(buckets.entries()).map(([sectionPath, annotations]) => ({
				sectionPath,
				annotations
			}));
		},
		applyImportedAnnotations(this: CheckWritingDialogVm, importedAnnotations: Annotation[]) {
			if (!Array.isArray(importedAnnotations) || !importedAnnotations.length) {
				throw new Error("empty-import");
			}
			const groups = this.groupAnnotationsBySection(importedAnnotations);
			const chapters = this.buildChaptersFromAnnotationGroups(groups);
			if (!chapters.length) {
				throw new Error("empty-chapters");
			}
			this.applyAnnotationChapters(chapters);
		},
		reportAnnotationLoadFailure(this: CheckWritingDialogVm, message: string) {
			if (mw && mw.notify) {
				mw.notify(message, { type: "warn", title: "[ReviewTool]" });
			}
			alert(message);
		},
		saveCheckWriting(this: CheckWritingDialogVm) {
			this.isSaving = true;
			const { sec, pageTitleToUse, sectionIdToUse } = this.getPendingCheckWritingSectionInfo();
			if (!sec || sectionIdToUse == null) {
				const msg = state.convByVar({ hant: "無法識別文筆章節編號，請在討論頁的文筆章節附近點擊「檢查文筆」。", hans: "无法识别文笔章节编号，请在讨论页的文笔章节附近点击“检查文笔”。" });
				if (mw && mw.notify) {
					mw.notify(msg, { type: "error", title: "[ReviewTool]" });
				}
				alert(msg);
				this.isSaving = false;
				return;
			}

			const bundle = this.buildPreviewBundle();
			if (!bundle) {
				const msg = state.convByVar({ hant: "請先輸入文筆建議內容，再嘗試儲存。", hans: "请先输入文笔建议内容，再尝试保存。" });
				if (mw && mw.notify) {
					mw.notify(msg, { type: "error", title: "[ReviewTool]" });
				}
				alert(msg);
				this.isSaving = false;
				return;
			}

			appendTextToSection(
				pageTitleToUse,
				sectionIdToUse,
				bundle.appendSuffix,
				state.convByVar({ hant: "使用 [[User:SuperGrey/gadgets/ReviewTool|ReviewTool]] 新增文筆建議", hans: "使用 [[User:SuperGrey/gadgets/ReviewTool|ReviewTool]] 新增文笔建议" })
			)
				.then(() => {
					if (mw && mw.notify) {
						mw.notify(state.convByVar({ hant: "已成功新增文筆建議。", hans: "已成功新增文笔建议。" }), { tag: "review-tool" });
					}
					this.isSaving = false;
					this.open = false;
					state.pendingReviewHeading = null;
					setTimeout(() => { removeDialogMount(); }, 200);
				})
				.catch((error: unknown) => {
					console.error("[ReviewTool] appendTextToSection failed", error);
					const msg = state.convByVar({ hant: "新增文筆建議失敗，請稍後再試。", hans: "新增文笔建议失败，请稍后再试。" });
					if (mw && mw.notify) {
						mw.notify(msg, { type: "error", title: "[ReviewTool]" });
					}
					alert(msg);
					this.isSaving = false;
				});
		},
		addChapter(this: CheckWritingDialogVm) {
			this.chapters.push({ title: "", suggestions: [{ quote: "", suggestion: "" }] });
		},
		removeChapter(this: CheckWritingDialogVm, idx: number) {
			if (this.chapters.length <= 1) {
				return;
			}
			this.chapters.splice(idx, 1);
		},
		addSuggestion(this: CheckWritingDialogVm, chIdx: number) {
			this.chapters[chIdx].suggestions.push({ quote: "", suggestion: "" });
		},
		removeSuggestion(this: CheckWritingDialogVm, chIdx: number, sIdx: number) {
			const suggestions = this.chapters[chIdx].suggestions;
			if (suggestions.length <= 1) {
				return;
			}
			suggestions.splice(sIdx, 1);
		}
	}
};
</script>

<template>
	<cdx-dialog v-model:open="open" :title="$options.i18n.dialogTitle" :use-close-button="true" :close-button-label="$options.i18n.close"
		@update:open="onUpdateOpen"
		class="review-tool-dialog review-tool-check-writing-dialog review-tool-multistep-dialog">
		<template #header>
			<div class="review-tool-multistep-dialog__header-top">
				<h2>{{ $options.i18n.dialogTitle }}</h2>
			</div>

			<div class="review-tool-multistep-dialog__stepper">
				<div class="review-tool-multistep-dialog__stepper__label">{{ (currentStep + 1) + " / 4" }}</div>
				<div class="review-tool-multistep-dialog__stepper__steps" aria-hidden>
					<span v-for="step of [0, 1, 2, 3]" :key="step" class="review-tool-multistep-dialog__stepper__step"
						:class="getStepClass(step)"></span>
				</div>
			</div>
		</template>

		<div v-if="currentStep === 0">
			<div v-for="(ch, chIdx) in chapters" :key="chIdx" class="review-tool-form-section chapter-block">
				<cdx-text-input v-model="ch.title" :placeholder="$options.i18n.chapterTitleLabel"
					class="chapter-title-input"></cdx-text-input>

				<div class="chapter-suggestions">
					<div v-for="(s, sIdx) in ch.suggestions" :key="sIdx" class="suggestion-row">
						<div class="suggestion-bullet" aria-hidden="true"></div>
						<div class="suggestion-columns">
							<div class="quote-col">
								<cdx-text-area class="quote-area" v-model="s.quote"
									:placeholder="$options.i18n.quotePlaceholder" rows="1"></cdx-text-area>
							</div>
							<div class="suggestion-col">
								<cdx-text-area class="suggestion-area" v-model="s.suggestion"
									:placeholder="$options.i18n.suggestionPlaceholder" rows="1"></cdx-text-area>
							</div>
							<div class="suggestion-controls">
								<cdx-button size="small" class="cdx-button--icon-only"
									:aria-label="$options.i18n.removeSuggestion" :disabled="ch.suggestions.length <= 1"
									@click.prevent="removeSuggestion(chIdx, sIdx)">
									<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" aria-hidden="true"
										focusable="false" width="16" height="16">
										<path d="M3 6h18v2H3V6zm2 3h14l-1 11H6L5 9zm3-6h6l1 2H7l1-2z" />
									</svg>
								</cdx-button>
							</div>
						</div>
					</div>

				</div>

				<div class="row-controls">
					<div class="suggestion-add">
						<cdx-button size="small" @click.prevent="addSuggestion(chIdx)">
							<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" aria-hidden="true"
								focusable="false" width="16" height="16" style="margin-right:6px">
								<path d="M11 11V6h2v5h5v2h-5v5h-2v-5H6v-2z" />
							</svg>
							{{ $options.i18n.addSuggestion }}
						</cdx-button>
					</div>

					<div class="chapter-controls">
						<cdx-button v-if="chIdx === chapters.length - 1" size="small" @click.prevent="addChapter">
							<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" aria-hidden="true"
								focusable="false" width="16" height="16" style="margin-right:6px">
								<path d="M11 11V6h2v5h5v2h-5v5h-2v-5H6v-2z" />
							</svg>
							{{ $options.i18n.addChapter }}
						</cdx-button>
						<cdx-button size="small" :disabled="chapters.length <= 1" @click.prevent="removeChapter(chIdx)">
							<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" aria-hidden="true"
								focusable="false" width="16" height="16" style="margin-right:6px">
								<path d="M3 6h18v2H3V6zm2 3h14l-1 11H6L5 9zm3-6h6l1 2H7l1-2z" />
							</svg>
							{{ $options.i18n.removeChapter }}
						</cdx-button>
					</div>
				</div>
			</div>
		</div>

		<div v-else-if="currentStep === 1" class="review-tool-edit-step">
			<h3>{{ $options.i18n.editHeading }}</h3>
			<p class="review-tool-edit-step__instruction">{{ $options.i18n.editInstruction }}</p>
			<cdx-text-area v-model="editedDraft" :placeholder="$options.i18n.editPlaceholder" rows="16"></cdx-text-area>
		</div>

		<div v-else-if="currentStep === 2" class="review-tool-preview">
			<h3>{{ $options.i18n.previewHeading }}</h3>
			<div v-if="previewHtml" class="review-tool-preview-pre review-tool-preview-pre--html" ref="previewHtmlHost"
				v-html="previewHtml"></div>
			<pre class="review-tool-preview-pre" v-else>{{ previewWikitext }}</pre>
		</div>

		<div v-else-if="currentStep === 3" class="review-tool-diff">
			<h3>{{ $options.i18n.diffHeading }}</h3>
			<div v-if="diffHtml" class="review-tool-diff-pre review-tool-diff-pre--html" ref="diffHtmlHost"
				v-html="diffHtml">
			</div>
			<div v-else>
				<p>{{ $options.i18n.diffLoading }}</p>
				<pre class="review-tool-diff-pre">{{ diffLines.join("\n") }}</pre>
			</div>
		</div>

		<template #footer>
			<div class="review-tool-multistep-dialog__footer-left">
				<cdx-button v-if="showAnnotationLoaderButton" weight="quiet" :disabled="isLoadingAnnotations"
					@click.prevent="loadAnnotationsIntoForm">
					{{ $options.i18n.loadAnnotations }}
				</cdx-button>
				<cdx-button v-if="showAnnotationLoaderButton" weight="quiet" @click.prevent="handleImportClick">
					{{ $options.i18n.importFromFile }}
				</cdx-button>
				<input ref="annotationImportInput" type="file" accept="application/json,.json" style="display:none"
					@change="onAnnotationFileSelected" />
			</div>
			<div class="review-tool-multistep-dialog__actions">
				<cdx-button v-if="defaultAction" action="normal" :disabled="defaultAction.disabled"
					@click.prevent="onDefaultAction">
					{{ defaultAction.label }}
				</cdx-button>
				<cdx-button v-if="primaryAction" :action="primaryAction.actionType" :disabled="primaryAction.disabled"
					@click.prevent="onPrimaryAction">
					{{ primaryAction.label }}
				</cdx-button>
			</div>
		</template>
	</cdx-dialog>
	<cdx-dialog :open="annotationPickerOpen" :title="$options.i18n.chooseAnnotationRevision" :use-close-button="true"
		:close-button-label="$options.i18n.close" class="review-tool-annotation-revision-dialog"
		:primary-action="annotationPickerPrimary"
		:default-action="{ label: annotationRevisions.length || isLoadingAnnotations ? $options.i18n.cancel : $options.i18n.close }"
		@primary="loadSelectedAnnotations" @default="closeAnnotationPicker" @update:open="onAnnotationPickerOpen">
		<p v-if="isLoadingAnnotations" role="status">{{ $options.i18n.loadingAnnotations }}</p>
		<p v-if="annotationPickerError" role="alert">{{ annotationPickerError }}</p>
		<cdx-button v-if="annotationPickerError && !annotationRevisions.length" :disabled="isLoadingAnnotations" @click="loadAnnotationsIntoForm">{{ $options.i18n.retry }}</cdx-button>
		<template v-if="annotationRevisions.length">
			<p>{{ $options.i18n.chooseAnnotationRevisionHelp }}</p>
			<div role="radiogroup" :aria-label="$options.i18n.chooseAnnotationRevisionHelp">
				<cdx-radio v-for="(revision, index) in annotationRevisions" :key="revision.revisionId"
					v-model="selectedAnnotationRevision" :input-value="revision.revisionId" name="reviewtool-annotation-revision"
					:disabled="isLoadingAnnotations">
					{{ annotationRevisionLabel(revision) }}<span v-if="index === 0"> · {{ $options.i18n.newest }}</span>
				</cdx-radio>
			</div>
			<fieldset class="review-tool-annotation-import-filters" :disabled="isLoadingAnnotations">
				<legend>{{ $options.i18n.annotationFilters }}</legend>
				<cdx-checkbox v-model="annotationOnlyOwn" :disabled="isLoadingAnnotations">{{ $options.i18n.annotationOnlyOwn }}</cdx-checkbox>
				<cdx-checkbox v-model="annotationTopLevelOnly" :disabled="isLoadingAnnotations">{{ $options.i18n.annotationTopLevelOnly }}</cdx-checkbox>
				<cdx-checkbox v-model="annotationUnresolvedOnly" :disabled="isLoadingAnnotations">{{ $options.i18n.annotationUnresolvedOnly }}</cdx-checkbox>
			</fieldset>
		</template>
		<p v-else-if="!isLoadingAnnotations && !annotationPickerError">{{ $options.i18n.noAnnotations }}</p>
	</cdx-dialog>
</template>
