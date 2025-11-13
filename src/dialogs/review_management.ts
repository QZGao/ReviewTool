import state from "../state";
import {assessments, getAssessmentLabels} from "../templates";

import { loadCodexAndVue, mountApp, removeDialogMount, registerCodexComponents, getMountedApp } from "../dialog";
declare var mw: any;

/**
 * 創建評審對話框。
 */
function createReviewManagementDialog(): void {
    loadCodexAndVue().then(({Vue, Codex}: any) => {
        const app = Vue.createMwApp({
            i18n: {
                submitting: state.convByVar({hant: '添加中…', hans: '添加中…'}),
                submit: state.convByVar({hant: '添加', hans: '添加'}),
                cancel: state.convByVar({hant: '取消', hans: '取消'}),
                dialogTitle: state.convByVar({
                    hant: '為「',
                    hans: '为「'
                }) + state.articleTitle + state.convByVar({hant: '」添加評審意見', hans: '」添加评审意见'}),
                submitUnderOpinionSubsection: state.convByVar({
                    hant: '將評審內容置於「',
                    hans: '将评审内容置于「'
                }) + state.userName + state.convByVar({hant: '的意見」小節內', hans: '的意见」小节内'}),
                selectCriterion: state.convByVar({hant: '評審標準：', hans: '评审标准：'}),
                criterionPlaceholder: state.convByVar({hant: '選擇評審標準', hans: '选择评审标准'}),
                addCriteriaToReview: state.convByVar({hant: '將以下標準加入評審', hans: '将以下标准加入评审'}),
            }, data() {
                return {
                    open: true,
                    isSubmitting: false,
                    submitUnderOpinionSubsection: !state.inTalkPage, // selected assessment type (e.g. 'bplus', 'good', ...)
                    selectedAssessmentType: state.assessmentType || '', // selected suggested criteria (array of strings)
                    selectedCriteria: [], // selected specific criterion (if needed)
                    criterion: null,
                };
            }, computed: {
                assessmentLabels(): Record<string, string> {
                    return getAssessmentLabels();
                }, // options shaped for Codex CdxSelect (MenuItemData: { value, label })
                codexOptions() {
                    return Object.entries(this.assessmentLabels).map(([type, label]) => ({value: type, label}));
                }, suggestedCriteria(): string[] {
                    if (!this.selectedAssessmentType) return [];
                    const a = assessments()[this.selectedAssessmentType];
                    return a ? (a.suggested_criteria || []) : [];
                }, // shaped items for Codex checkbox list
                codexCriteriaItems() {
                    return this.suggestedCriteria.map(item => ({value: item, label: item}));
                }, primaryAction() {
                    return {
                        label: this.isSubmitting ? this.$options.i18n.submitting : this.$options.i18n.submit,
                        actionType: 'progressive',
                        disabled: this.isSubmitting,
                    };
                }, defaultAction() {
                    return {
                        label: this.$options.i18n.cancel,
                    };
                }
            }, methods: {
                onPrimaryAction() {
                    this.submitReview();
                }, onDefaultAction() {
                    this.closeDialog();
                }, onUpdateOpen(newValue) {
                    if (!newValue) {
                        this.closeDialog();
                    }
                }, closeDialog() {
                    this.open = false;
                    setTimeout(() => {
                        removeDialogMount();
                    }, 300);
                }, submitReview() {
                    if (!this.selectedAssessmentType) {
                        mw.notify(state.convByVar({hant: '請選擇評審標準。', hans: '请选择评审标准。'}), {
                            type: 'error',
                            title: '[ReviewTool]'
                        });
                        return;
                    }

                    this.isSubmitting = true;

                    const payload = {
                        articleTitle: state.articleTitle,
                        userName: state.userName,
                        submitUnderOpinionSubsection: !!this.submitUnderOpinionSubsection,
                        assessmentType: this.selectedAssessmentType,
                        selectedCriteria: Array.isArray(this.selectedCriteria) ? this.selectedCriteria.slice() : [],
                        criterion: this.criterion,
                    };

                    console.debug('[ReviewTool] submitReview payload', payload);

                    // Simulate async submission (replace with real API call as needed)
                    setTimeout(() => {
                        this.isSubmitting = false;
                        this.open = false;
                        setTimeout(() => {
                            removeDialogMount();
                        }, 200);
                    }, 500);
                }
            }, template: `
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

        registerCodexComponents(app, Codex);
        mountApp(app);
    }).catch((error) => {
        console.error('[ReviewTool] 無法加載 Codex:', error);
        mw.notify(state.convByVar({hant: '無法加載對話框組件。', hans: '无法加载对话框组件。'}), {
            type: 'error',
            title: '[ReviewTool]'
        });
    });
}

/**
 * 打開評審對話框。
 */
export function openReviewManagementDialog(): void {
    if (getMountedApp && getMountedApp()) removeDialogMount();
    createReviewManagementDialog();
}
