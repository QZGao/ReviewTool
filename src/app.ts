import state from "./state";
import { getAssessmentLabels, assessments } from "./templates";

declare var mw: any;

let vueApp: any = null;

/**
 * 創建評審對話框。
 */
function createReviewManagementDialog(): void {
	mw.loader.using('@wikimedia/codex').then((require) => {
		const Vue = require('vue');
		const Codex = require('@wikimedia/codex');

		if (!document.getElementById('review-tool-dialog-mount')) {
			const mountPoint = document.createElement('div');
			mountPoint.id = 'review-tool-dialog-mount';
			document.body.appendChild(mountPoint);
		}

		const app = Vue.createMwApp({
			i18n: {
				submitting: state.convByVar({ hant: '添加中…', hans: '添加中…' }),
				submit: state.convByVar({ hant: '添加', hans: '添加' }),
				cancel: state.convByVar({ hant: '取消', hans: '取消' }),
				dialogTitle: state.convByVar({ hant: '為「', hans: '为「' }) + state.articleTitle + state.convByVar({ hant: '」添加評審意見', hans: '」添加评审意见' }),
				submitUnderOpinionSubsection: state.convByVar({ hant: '將評審內容置於「', hans: '将评审内容置于「' }) + state.userName + state.convByVar({ hant: '的意見」小節內', hans: '的意见」小节内' }),
				selectCriterion: state.convByVar({ hant: '評審標準：', hans: '评审标准：' }),
				criterionPlaceholder: state.convByVar({ hant: '選擇評審標準', hans: '选择评审标准' }),
				addCriteriaToReview: state.convByVar({ hant: '將以下標準加入評審', hans: '将以下标准加入评审' }),
			},
			data() {
				return {
					open: true,
					isSubmitting: false,
					submitUnderOpinionSubsection: !state.inTalkPage,
					// selected assessment type (e.g. 'bplus', 'good', ...)
					selectedAssessmentType: state.assessmentType || '',
					// selected suggested criteria (array of strings)
					selectedCriteria: [],
					// selected specific criterion (if needed)
					criterion: null,
				};
			},
			computed: {
				assessmentLabels(): Record<string, string> {
					return getAssessmentLabels();
				},
				// options shaped for Codex CdxSelect (MenuItemData: { value, label })
				codexOptions() {
					return Object.entries(this.assessmentLabels).map(([type, label]) => ({ value: type, label }));
				},
				suggestedCriteria(): string[] {
					if (!this.selectedAssessmentType) return [];
					const a = assessments()[this.selectedAssessmentType];
					return a ? (a.suggested_criteria || []) : [];
				},
				// shaped items for Codex checkbox list
				codexCriteriaItems() {
					return this.suggestedCriteria.map(item => ({ value: item, label: item }));
				},
				primaryAction() {
					return {
						label: this.isSubmitting ? this.$options.i18n.submitting : this.$options.i18n.submit,
						actionType: 'progressive',
						disabled: this.isSubmitting,
					};
				},
				defaultAction() {
					return {
						label: this.$options.i18n.cancel,
					};
				}
			},
			methods: {
				onPrimaryAction() {
					this.submitReview();
				},
				onDefaultAction() {
					this.closeDialog();
				},
				onUpdateOpen(newValue) {
					if (!newValue) {
						this.closeDialog();
					}
				},
				closeDialog() {
					this.open = false;
					setTimeout(() => {
						const mountPoint = document.getElementById('review-tool-dialog-mount');
						if (mountPoint) {
							mountPoint.remove();
						}
						vueApp = null;
					}, 300);
				},
				submitReview() {
					// Submission logic here
				}
			},
			template: `
				<cdx-dialog
					v-model:open="open"
					:title="$options.i18n.dialogTitle"
					:use-close-button="true"
					:primary-action="primaryAction"
					:default-action="defaultAction"
					@primary="onPrimaryAction"
					@default="onDefaultAction"
					@update:open="onUpdateOpen"
					class="review-tool-dialog review-tool-review-management-dialog"
				>
					
						<div class="review-tool-form-section">
							<cdx-checkbox v-model="submitUnderOpinionSubsection">{{ $options.i18n.submitUnderOpinionSubsection }}</cdx-checkbox>
						</div>

						<div class="review-tool-form-section">
							<label class="review-tool-select-label">{{ $options.i18n.selectCriterion }}</label>
							<cdx-select
								v-model:selected="selectedAssessmentType"
								:menu-items="codexOptions"
								:default-label="$options.i18n.criterionPlaceholder"
							></cdx-select>
						</div>

						<div class="review-tool-form-section" v-if="selectedAssessmentType">
							<label class="review-tool-checkbox-label">{{ $options.i18n.addCriteriaToReview }}</label>
							<div class="review-tool-suggested-criteria-grid">
								<cdx-checkbox
									v-for="(item, idx) in codexCriteriaItems"
									:key="idx"
									v-model="selectedCriteria"
									:input-value="item.value"
								>
									{{ item.label }}
								</cdx-checkbox>
							</div>
						</div>
				</cdx-dialog>
			`,
		});

		app.component('cdx-dialog', Codex.CdxDialog)
			.component('cdx-text-input', Codex.CdxTextInput)
			.component('cdx-text-area', Codex.CdxTextArea)
			.component('cdx-checkbox', Codex.CdxCheckbox)
			.component('cdx-select', Codex.CdxSelect);
		vueApp = app.mount('#review-tool-dialog-mount');
	}).catch((error) => {
		console.error('[ReviewTool] 無法加載 Codex:', error);
		mw.notify(state.convByVar({ hant: '無法加載對話框組件。', hans: '无法加载对话框组件。' }), { type: 'error', title: '[ReviewTool]' });
	});
}

/**
 * 打開評審對話框。
 */
export function openReviewManagementDialog(): void {
	if (vueApp) {
		const mountPoint = document.getElementById('review-tool-dialog-mount');
		if (mountPoint) {
			mountPoint.remove();
		}
		vueApp = null;
	}
	createReviewManagementDialog();
}

/**
 * 創建檢查文筆對話框。
 */
function createCheckWritingDialog(): void {
	mw.loader.using('@wikimedia/codex').then((require) => {
		const Vue = require('vue');
		const Codex = require('@wikimedia/codex');

		if (!document.getElementById('review-tool-dialog-mount')) {
			const mountPoint = document.createElement('div');
			mountPoint.id = 'review-tool-dialog-mount';
			document.body.appendChild(mountPoint);
		}

		const app = Vue.createMwApp({
			i18n: {
				dialogTitle: state.convByVar({ hant: '檢查「', hans: '检查「' }) + state.articleTitle + state.convByVar({ hant: '」的文筆', hans: '」的文笔' }),
				save: state.convByVar({ hant: '儲存', hans: '保存' }),
				saving: state.convByVar({ hant: '儲存中…', hans: '保存中…' }),
				cancel: state.convByVar({ hant: '取消', hans: '取消' }),
				addChapter: state.convByVar({ hant: '新增章節', hans: '新增章节' }),
				removeChapter: state.convByVar({ hant: '刪除章節', hans: '删除章节' }),
				addSuggestion: state.convByVar({ hant: '新增意見', hans: '新增意见' }),
				removeSuggestion: state.convByVar({ hant: '刪除意見', hans: '删除意见' }),
				chapterTitleLabel: state.convByVar({ hant: '章節標題', hans: '章节标题' }),
				quoteLabel: state.convByVar({ hant: '引用原文', hans: '引用原文' }),
				quotePlaceholder: state.convByVar({ hant: '原文句子', hans: '原文句子' }),
				suggestionPlaceholder: state.convByVar({ hant: '意見或建議', hans: '意见或建议' }),
			},
			data() {
				return {
					open: true,
					isSaving: false,
					chapters: [{
						title: '',
						suggestions: [{ quote: '', suggestion: '' }]
					}],
				};
			},
			computed: {
				primaryAction() {
					return {
						label: this.isSaving ? this.$options.i18n.saving : this.$options.i18n.save,
						actionType: 'progressive',
						disabled: this.isSaving
					};
				},
				defaultAction() {
					return {
						label: this.$options.i18n.cancel
					};
				}
			},
			methods: {
				onPrimaryAction() {
					this.saveCheckWriting();
				},
				onDefaultAction() {
					this.closeDialog();
				},
				onUpdateOpen(newValue: any) {
					if (!newValue) {
						this.closeDialog();
					}
				},
				closeDialog() {
					this.open = false;
					setTimeout(() => {
						const mountPoint = document.getElementById('review-tool-dialog-mount');
						if (mountPoint) {
							mountPoint.remove();
						}
						vueApp = null;
					}, 300);
				},
				saveCheckWriting() {
					this.isSaving = true;
					const payload = {
						chapters: this.chapters.map(ch => ({
							title: ch.title,
							suggestions: ch.suggestions.map(s => ({
								quote: s.quote,
								suggestion: s.suggestion
							}))
						}))
					};
					console.debug('[ReviewTool] saveCheckWriting payload', payload);
					setTimeout(() => {
						this.isSaving = false;
						this.open = false;
						setTimeout(() => {
							const mountPoint = document.getElementById('review-tool-dialog-mount');
							if (mountPoint) mountPoint.remove();
							vueApp = null;
						}, 200);
					}, 500);
				},
				addChapter() {
					this.chapters.push({
						title: '',
						suggestions: [{ quote: '', suggestion: '' }]
					});
				},
				removeChapter(idx: number) {
					if (this.chapters.length <= 1) {
						return;
					}
					this.chapters.splice(idx, 1);
				},
				addSuggestion(chIdx: number) {
					this.chapters[chIdx].suggestions.push({ quote: '', suggestion: '' });
				},
				removeSuggestion(chIdx: number, sIdx: number) {
					const suggestions = this.chapters[chIdx].suggestions;
					if (suggestions.length <= 1) {
						return;
					}
					suggestions.splice(sIdx, 1);
				},
			},
			template: `
				<cdx-dialog
					v-model:open="open"
					:title="$options.i18n.dialogTitle"
					:use-close-button="true"
					:primary-action="primaryAction"
					:default-action="defaultAction"
					@primary="onPrimaryAction"
					@default="onDefaultAction"
					@update:open="onUpdateOpen"
					class="review-tool-dialog review-tool-check-writing-dialog"
				>

					<div v-for="(ch, chIdx) in chapters" :key="chIdx" class="review-tool-form-section chapter-block">
						<cdx-text-input v-model="ch.title" :placeholder="$options.i18n.chapterTitleLabel" class="chapter-title-input"></cdx-text-input>

						<div class="chapter-suggestions">
							<div v-for="(s, sIdx) in ch.suggestions" :key="sIdx" class="suggestion-row">
								<div class="suggestion-bullet" aria-hidden="true"></div>
								<div class="suggestion-columns">
									<div class="quote-col">
										<cdx-text-area class="quote-area" v-model="s.quote" :placeholder="$options.i18n.quotePlaceholder" rows="1"></cdx-text-area>
									</div>
									<div class="suggestion-col">
										<cdx-text-area class="suggestion-area" v-model="s.suggestion" :placeholder="$options.i18n.suggestionPlaceholder" rows="1"></cdx-text-area>
									</div>
									<div class="suggestion-controls">
										<cdx-button
											size="small"
											class="cdx-button--icon-only"
											:aria-label="$options.i18n.removeSuggestion"
											:disabled="ch.suggestions.length <= 1"
											@click.prevent="removeSuggestion(chIdx, sIdx)"
										>
											<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" aria-hidden="true" focusable="false" width="16" height="16"><path d="M3 6h18v2H3V6zm2 3h14l-1 11H6L5 9zm3-6h6l1 2H7l1-2z"/></svg>
										</cdx-button>
									</div>
								</div>
							</div>

						<!-- Row containing add-suggestion and chapter controls side-by-side -->
						<div class="row-controls">
							<div class="suggestion-add">
								<cdx-button size="small" @click.prevent="addSuggestion(chIdx)">
									<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" aria-hidden="true" focusable="false" width="16" height="16" style="margin-right:6px"><path d="M11 11V6h2v5h5v2h-5v5h-2v-5H6v-2z"/></svg>
									{{ $options.i18n.addSuggestion }}
								</cdx-button>
							</div>

							<div class="chapter-controls">
								<!-- Add chapter only on the last chapter block -->
								<cdx-button v-if="chIdx === chapters.length - 1" size="small" @click.prevent="addChapter">
									<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" aria-hidden="true" focusable="false" width="16" height="16" style="margin-right:6px"><path d="M11 11V6h2v5h5v2h-5v5h-2v-5H6v-2z"/></svg>
									{{ $options.i18n.addChapter }}
								</cdx-button>
								<!-- Delete chapter button with icon + text so it's distinguishable from entry delete -->
								<cdx-button size="small" :disabled="chapters.length <= 1" @click.prevent="removeChapter(chIdx)">
									<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" aria-hidden="true" focusable="false" width="16" height="16" style="margin-right:6px"><path d="M3 6h18v2H3V6zm2 3h14l-1 11H6L5 9zm3-6h6l1 2H7l1-2z"/></svg>
									{{ $options.i18n.removeChapter }}
								</cdx-button>
							</div>
						</div>
					</div>
				</cdx-dialog>
			`,
		});

		app.component('cdx-dialog', Codex.CdxDialog)
			.component('cdx-text-input', Codex.CdxTextInput)
			.component('cdx-text-area', Codex.CdxTextArea)
			.component('cdx-checkbox', Codex.CdxCheckbox)
			.component('cdx-select', Codex.CdxSelect)
			.component('cdx-button', Codex.CdxButton)
			.component('cdx-button-group', Codex.CdxButtonGroup);
		vueApp = app.mount('#review-tool-dialog-mount');
	}).catch((error) => {
		console.error('[ReviewTool] 無法加載 Codex:', error);
		mw.notify(state.convByVar({ hant: '無法加載對話框組件。', hans: '无法加载对话框组件。' }), { type: 'error', title: '[ReviewTool]' });
	});
}

/**
 * 打開檢查文筆對話框。
 */
export function openCheckWritingDialog(): void {
	if (vueApp) {
		const mountPoint = document.getElementById('review-tool-dialog-mount');
		if (mountPoint) {
			mountPoint.remove();
		}
		vueApp = null;
	}
	createCheckWritingDialog();
}