import state from "../state";
import {assessments, getAssessmentLabels} from "../templates";

import { loadCodexAndVue, mountApp, removeDialogMount, registerCodexComponents, getMountedApp } from "../dialog";
import { findSectionInfoFromHeading, createHeaderMarkup, appendTextToSection, retrieveFullText, replaceSectionText, parseWikitextToHtml, compareWikitext } from "../api";
import { advanceDialogStep, regressDialogStep, triggerDialogContentHooks } from "./utils";
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
                next: state.convByVar({hant: '下一步', hans: '下一步'}),
                previous: state.convByVar({hant: '上一步', hans: '上一步'}),
                previewHeading: state.convByVar({hant: '預覽', hans: '预览'}),
                diffHeading: state.convByVar({hant: '差異', hans: '差异'}),
                editHeading: state.convByVar({hant: '編輯建議', hans: '编辑建议'}),
                editInstruction: state.convByVar({hant: '在此調整要新增的維基語法內容，再前往預覽或差異。', hans: '在此调整要新增的维基语法内容，再前往预览或差异。'}),
                editPlaceholder: state.convByVar({hant: '在此輸入或修改評審建議的維基語法內容…', hans: '在此输入或修改评审建议的维基语法内容…'}),
                noSpecificCriteria: state.convByVar({hant: '未選擇評審標準。', hans: '未选择评审标准。'}),
                noDiff: state.convByVar({hant: '無差異。', hans: '无差异。'}),
            }, data() {
                return {
                    open: true,
                    isSubmitting: false,
                    currentStep: 0,
                    submitUnderOpinionSubsection: !state.inTalkPage, // selected assessment type (e.g. 'bplus', 'good', ...)
                    selectedAssessmentType: state.assessmentType || '', // selected suggested criteria (array of strings)
                    selectedCriteria: [], // selected specific criterion (if needed)
                    criterion: null,
                    previewHtml: '',
                    diffHtml: '',
                    previewWikitext: '',
                    existingSectionText: '',
                    pendingNewSectionText: '',
                    sectionRevisionInfo: null as null | { starttimestamp: string; basetimestamp: string },
                    editedDraft: '',
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
                },
                
                primaryAction() {
                    if (this.currentStep < 3) {
                        return { label: this.$options.i18n.next || 'Next', actionType: 'primary', disabled: false };
                    }
                    return { label: this.isSubmitting ? this.$options.i18n.submitting : this.$options.i18n.submit, actionType: 'progressive', disabled: this.isSubmitting };
                }, defaultAction() {
                    if (this.currentStep > 0) return { label: this.$options.i18n.previous || 'Previous' };
                    return { label: this.$options.i18n.cancel };
                }
            }, methods: {
                triggerContentHooks(kind: 'preview' | 'diff') {
                    triggerDialogContentHooks(this, kind);
                },
                getPendingReviewSectionInfo() {
                    const headingEl: Element | null = (state as any).pendingReviewHeading || null;
                    const sec = findSectionInfoFromHeading(headingEl as Element | null);
                    const pageTitleToUse = sec && sec.pageTitle ? sec.pageTitle : state.articleTitle || '';
                    const sectionIdToUse = typeof (sec && (sec as any).sectionId) === 'number' ? (sec as any).sectionId : (sec && sec.sectionId != null ? sec.sectionId : null);
                    return { headingEl, sec, pageTitleToUse, sectionIdToUse };
                },
                buildHeadersForCriteria(level: number): string {
                    if (Array.isArray(this.selectedCriteria) && this.selectedCriteria.length > 0) {
                        return this.selectedCriteria.map((item: any) => createHeaderMarkup(String(item), level)).join('');
                    }
                    if (this.criterion) {
                        return createHeaderMarkup(String(this.criterion), level);
                    }
                    return '';
                },
                buildOpinionContent(level: number): string {
                    const criteriaContent = this.buildHeadersForCriteria(level);
                    return criteriaContent && criteriaContent.trim() ? criteriaContent : '';
                },
                reportMissingOpinionEntries(showAlert = false) {
                    const msg = state.convByVar({hant: '請先選擇或輸入評審子項，再提交。', hans: '请先选择或输入评审子项，再提交。'});
                    mw && mw.notify && mw.notify(msg, { type: 'error', title: '[ReviewTool]' });
                    if (showAlert) {
                        try { alert(msg); } catch (e) { /* ignore */ }
                    }
                    return msg;
                },
                prepareEditDraft() {
                    this.editedDraft = this.buildDraftContent().trim();
                },
                buildDraftContent() {
                    const level = this.submitUnderOpinionSubsection ? 4 : 3;
                    if (this.submitUnderOpinionSubsection) {
                        return this.buildOpinionContent(level);
                    }
                    return this.buildHeadersForCriteria(level);
                },
                getDraftFragment() {
                    const rawDraft = (this.editedDraft || '').trim();
                    if (!rawDraft) return '';
                    return `\n${rawDraft}`;
                },
                preparePreviewContent() {
                    const { pageTitleToUse, sectionIdToUse } = this.getPendingReviewSectionInfo();
                    const level = this.submitUnderOpinionSubsection ? 4 : 3;
                    this.previewHtml = '';
                    this.previewWikitext = '';
                    this.pendingNewSectionText = '';
                    this.existingSectionText = '';
                    this.sectionRevisionInfo = null;

                    const draftFragment = this.getDraftFragment();

                    if (!this.submitUnderOpinionSubsection) {
                        const headers = draftFragment || this.buildHeadersForCriteria(level);
                        if (!headers || !headers.trim()) {
                            this.reportMissingOpinionEntries();
                            return;
                        }
                        this.previewWikitext = headers;
                        parseWikitextToHtml(headers, pageTitleToUse).then((html: string) => {
                            this.previewHtml = html || '';
                            if (this.previewHtml && this.currentStep === 2) {
                                this.triggerContentHooks('preview');
                            }
                        }).catch((e: any) => {
                            console.error('[ReviewTool] parseWikitextToHtml failed', e);
                            this.previewHtml = '';
                        });
                        return;
                    }

                    const opinionHeaderTitle = `${state.userName}${state.convByVar({hant: ' 的意見', hans: ' 的意见'})}`;
                    const h4s = draftFragment || this.buildOpinionContent(4);
                    if (!h4s || !h4s.trim()) {
                        this.reportMissingOpinionEntries(true);
                        this.isSubmitting = false;
                        return;
                    }
                    const fallbackFragment = h4s ? (createHeaderMarkup(opinionHeaderTitle, 3) + h4s) : '';
                    const renderPreview = (fragment: string, existingText: string, newText: string) => {
                        this.previewWikitext = fragment;
                        this.existingSectionText = existingText;
                        this.pendingNewSectionText = newText;
                        parseWikitextToHtml(fragment, pageTitleToUse).then((html: string) => {
                            this.previewHtml = html || '';
                            if (this.previewHtml && this.currentStep === 2) {
                                this.triggerContentHooks('preview');
                            }
                        }).catch((e: any) => {
                            console.error('[ReviewTool] parseWikitextToHtml failed', e);
                            this.previewHtml = '';
                        });
                    };

                    if (sectionIdToUse != null) {
                        retrieveFullText(pageTitleToUse, sectionIdToUse).then(({ text, starttimestamp, basetimestamp }) => {
                            this.sectionRevisionInfo = { starttimestamp, basetimestamp };
                            const secText = text || '';
                            const insertion = this.computeOpinionInsertion(secText, h4s, opinionHeaderTitle);
                            renderPreview(insertion.previewFragment, secText, insertion.newSectionText);
                        }).catch((e: any) => {
                            console.error('[ReviewTool] retrieveFullText failed', e);
                            this.sectionRevisionInfo = null;
                            renderPreview(fallbackFragment, '', fallbackFragment);
                        });
                    } else {
                        renderPreview(fallbackFragment, '', fallbackFragment);
                    }
                },
                prepareDiffContent() {
                    const { pageTitleToUse, sectionIdToUse } = this.getPendingReviewSectionInfo();
                    this.diffHtml = '';
                    const draftFragment = this.getDraftFragment();

                    if (!this.submitUnderOpinionSubsection) {
                        const headers = this.previewWikitext || draftFragment || this.buildHeadersForCriteria(3);
                        if (!headers || !headers.trim()) {
                            this.reportMissingOpinionEntries();
                            return;
                        }
                        const runDiff = (oldText: string, newText: string) => {
                            compareWikitext(oldText || '', newText).then((dhtml: string) => {
                                this.diffHtml = dhtml || '';
                                if (this.diffHtml && this.currentStep === 3) {
                                    this.triggerContentHooks('diff');
                                }
                            }).catch((e: any) => {
                                console.error('[ReviewTool] compareWikitext failed', e);
                                this.diffHtml = '';
                            });
                        };

                        if (sectionIdToUse != null) {
                            retrieveFullText(pageTitleToUse, sectionIdToUse).then(({ text, starttimestamp, basetimestamp }) => {
                                this.sectionRevisionInfo = { starttimestamp, basetimestamp };
                                const current = text || '';
                                this.existingSectionText = current;
                                runDiff(current, (current || '') + headers);
                            }).catch((e: any) => {
                                console.error('[ReviewTool] retrieveFullText failed', e);
                                this.sectionRevisionInfo = null;
                                runDiff('', headers);
                            });
                        } else {
                            runDiff('', headers);
                        }
                        return;
                    }

                    const opinionHeaderTitle = `${state.userName}${state.convByVar({hant: ' 的意見', hans: ' 的意见'})}`;
                    const h4s = draftFragment || this.buildOpinionContent(4);
                    const runOpinionDiff = (oldText: string, newText: string) => {
                        this.existingSectionText = oldText;
                        this.pendingNewSectionText = newText;
                        compareWikitext(oldText || '', newText).then((dhtml: string) => {
                            this.diffHtml = dhtml || '';
                            if (this.diffHtml && this.currentStep === 3) {
                                this.triggerContentHooks('diff');
                            }
                        }).catch((e: any) => {
                            console.error('[ReviewTool] compareWikitext failed', e);
                            this.diffHtml = '';
                        });
                    };

                    if (this.pendingNewSectionText) {
                        runOpinionDiff(this.existingSectionText || '', this.pendingNewSectionText);
                        return;
                    }

                    const fallbackFragment = h4s ? (createHeaderMarkup(opinionHeaderTitle, 3) + h4s) : '';

                    if (sectionIdToUse != null) {
                        retrieveFullText(pageTitleToUse, sectionIdToUse).then(({ text, starttimestamp, basetimestamp }) => {
                            this.sectionRevisionInfo = { starttimestamp, basetimestamp };
                            const secText = text || '';
                            const insertion = this.computeOpinionInsertion(secText, h4s, opinionHeaderTitle);
                            runOpinionDiff(secText, insertion.newSectionText);
                        }).catch((e: any) => {
                            console.error('[ReviewTool] retrieveFullText failed', e);
                            this.sectionRevisionInfo = null;
                            runOpinionDiff('', fallbackFragment);
                        });
                    } else {
                        runOpinionDiff('', fallbackFragment);
                    }
                },
                computeOpinionInsertion(secText: string, h4s: string, opinionHeaderTitle: string) {
                    if (!h4s || !h4s.trim()) {
                        return { previewFragment: '', newSectionText: secText, insertedIntoExisting: false };
                    }
                    const h3LineRe = /^\s*(={3,})\s*(.*?)\s*\1\s*$/gm;
                    const normalizeHeadingText = (s: string): string => {
                        if (!s) return '';
                        let normalized = s.replace(/'''+/g, '').replace(/''/g, '');
                        try {
                            const txt = document.createElement('textarea');
                            txt.innerHTML = normalized;
                            normalized = txt.value;
                        } catch (e) { /* ignore */ }
                        return normalized.replace(/\s+/g, ' ').trim();
                    };
                    const targetNorm = normalizeHeadingText(opinionHeaderTitle);
                    let match: RegExpExecArray | null;
                    while ((match = h3LineRe.exec(secText)) !== null) {
                        const fullLine = match[0];
                        const inner = match[2];
                        if (normalizeHeadingText(inner) === targetNorm) {
                            const headingLevel = match[1].length;
                            const headingEnd = match.index + fullLine.length;
                            const rest = secText.slice(headingEnd);
                            const genericHeadingRe = /^\s*(={1,6})\s*([^\r\n]*?)\s*\1\s*$/gm;
                            let insertPos = secText.length;
                            let nextMatch: RegExpExecArray | null;
                            while ((nextMatch = genericHeadingRe.exec(rest)) !== null) {
                                const nextLevel = nextMatch[1].length;
                                if (nextLevel <= headingLevel) {
                                    insertPos = headingEnd + nextMatch.index;
                                    break;
                                }
                            }
                            const prefix = secText.slice(0, insertPos);
                            const suffix = secText.slice(insertPos);
                            const prefixEndsWithNewline = !prefix.length || /\r?\n$/.test(prefix);
                            let normalized = h4s;
                            if (prefixEndsWithNewline) {
                                normalized = normalized.replace(/^(?:\r?\n)+/, '');
                            } else if (!/^\r?\n/.test(normalized)) {
                                normalized = '\n' + normalized;
                            }
                            if (!/\r?\n$/.test(normalized)) {
                                normalized += '\n';
                            }
                            if (suffix.length && !/^\r?\n/.test(suffix)) {
                                normalized += '\n';
                            }
                            const insertion = normalized;
                            const newSectionText = prefix + insertion + secText.slice(insertPos);
                            return { previewFragment: h4s, newSectionText, insertedIntoExisting: true };
                        }
                    }
                    const previewFragment = createHeaderMarkup(opinionHeaderTitle, 3) + h4s;
                    const newSectionText = secText + previewFragment;
                    return { previewFragment, newSectionText, insertedIntoExisting: false };
                },
                getStepClass(step: number) {
                    return { 'review-tool-multistep-dialog__stepper__step--active': step <= this.currentStep };
                },
                onPrimaryAction() {
                    if (advanceDialogStep(this, {
                        totalSteps: 4,
                        onEnterEditStep: this.prepareEditDraft,
                        onEnterPreviewStep: this.preparePreviewContent,
                        onEnterDiffStep: this.prepareDiffContent,
                        previewStepIndex: 2,
                        diffStepIndex: 3,
                    })) {
                        return;
                    }
                    this.submitReview();
                }, onDefaultAction() {
                    if (regressDialogStep(this)) {
                        return;
                    }
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

                    // Determine the heading/section to edit from the pendingReviewHeading set when
                    // the user clicked the management button.
                    const headingEl: Element | null = (state as any).pendingReviewHeading || null;
                    const sec = findSectionInfoFromHeading(headingEl as Element | null);
                    if (!sec || !sec.sectionId) {
                        // Show an error prompt and abort
                        const msg = state.convByVar({hant: '無法識別章節編號，請在討論頁的章節標題附近點擊「管理評審」。', hans: '无法识别章节编号，请在讨论页的章节标题附近点击“管理评审”。'});
                        mw && mw.notify && mw.notify(msg, { type: 'error', title: '[ReviewTool]' });
                        alert(msg);
                        this.isSubmitting = false;
                        return;
                    }

                    // Build headers for each selected criterion.
                    // If submitUnderOpinionSubsection === false, append each as H3 to the section.
                    // If true, we need to add H4s under a H3 titled "<userName> 的意見"; if that H3
                    // exists inside the target section, insert H4s immediately after it; otherwise
                    // append a new H3 and the H4s.
                    const level = this.submitUnderOpinionSubsection ? 4 : 3;
                    const draftFragment = this.getDraftFragment();

                    // Helper to create combined content for multiple criteria at a given level
                    const buildHeadersForCriteria = (criteria: any[], lvl: number) => {
                        // createHeaderMarkup now already includes trailing newline; join without
                        // extra separators to avoid double blank lines.
                        return criteria.map((c: any) => createHeaderMarkup(String(c), lvl)).join('');
                    };

                    const pageTitleToUse = sec.pageTitle || state.articleTitle || '';
                    const sectionIdToUse = sec.sectionId as number;

                    if (!this.submitUnderOpinionSubsection) {
                        // simple case: append H3s (or H2.. as level) for each criterion
                        const headers = draftFragment || ((Array.isArray(this.selectedCriteria) && this.selectedCriteria.length > 0)
                            ? buildHeadersForCriteria(this.selectedCriteria, level)
                            : (this.criterion ? createHeaderMarkup(String(this.criterion), level) : ''));
                        if (!headers || !headers.trim()) {
                            this.reportMissingOpinionEntries(true);
                            this.isSubmitting = false;
                            return;
                        }
                        appendTextToSection(pageTitleToUse, sectionIdToUse, headers, state.convByVar({hant: '使用 [[User:SuperGrey/gadgets/ReviewTool|ReviewTool]] 新增評審項目', hans: '使用 [[User:SuperGrey/gadgets/ReviewTool|ReviewTool]] 新增评审项目'}))
                            .then((resp: any) => {
                                mw && mw.notify && mw.notify(state.convByVar({hant: '已成功新增評審項目。', hans: '已成功新增评审项目。'}), { tag: 'review-tool' });
                                this.isSubmitting = false;
                                this.open = false;
                                (state as any).pendingReviewHeading = null;
                                setTimeout(() => { removeDialogMount(); }, 200);
                            })
                            .catch((err: any) => {
                                console.error('[ReviewTool] appendTextToSection failed', err);
                                const msg = state.convByVar({hant: '新增評審項目失敗，請稍後再試。', hans: '新增评审项目失败，请稍后再试。'});
                                mw && mw.notify && mw.notify(msg, { type: 'error', title: '[ReviewTool]' });
                                alert(msg);
                                this.isSubmitting = false;
                            });
                        return;
                    }

                    // submitUnderOpinionSubsection === true: need to insert H4s under a H3 named "<userName> 的意見"
                    const opinionHeaderTitle = `${state.userName}${state.convByVar({hant: ' 的意見', hans: ' 的意见'})}`;
                    const h4s = draftFragment || this.buildOpinionContent(4);

                    const revisionInfo = this.sectionRevisionInfo;
                    if (!revisionInfo) {
                        const msg = state.convByVar({hant: '請先預覽並檢視差異，以取得最新段落資訊後再提交。', hans: '请先预览并查看差异，以取得最新段落资讯后再提交。'});
                        mw && mw.notify && mw.notify(msg, { type: 'error', title: '[ReviewTool]' });
                        alert(msg);
                        this.isSubmitting = false;
                        return;
                    }

                    const secWikitext = typeof this.existingSectionText === 'string' ? this.existingSectionText : '';
                    const insertion = this.computeOpinionInsertion(secWikitext, h4s, opinionHeaderTitle);

                    if (insertion.insertedIntoExisting) {
                        replaceSectionText(
                            pageTitleToUse,
                            sectionIdToUse,
                            insertion.newSectionText,
                            state.convByVar({hant: '使用 [[User:SuperGrey/gadgets/ReviewTool|ReviewTool]] 新增評審子項', hans: '使用 [[User:SuperGrey/gadgets/ReviewTool|ReviewTool]] 新增评审子项'}),
                            revisionInfo
                        )
                            .then((resp: any) => {
                                mw && mw.notify && mw.notify(state.convByVar({hant: '已成功新增評審子項。', hans: '已成功新增评审子项。'}), { tag: 'review-tool' });
                                this.isSubmitting = false;
                                this.open = false;
                                (state as any).pendingReviewHeading = null;
                                setTimeout(() => { removeDialogMount(); }, 200);
                            })
                            .catch((err: any) => {
                                console.error('[ReviewTool] replaceSectionText failed', err);
                                const msg = state.convByVar({hant: '新增評審子項失敗，請稍後再試。', hans: '新增评审子项失败，请稍后再试。'});
                                mw && mw.notify && mw.notify(msg, { type: 'error', title: '[ReviewTool]' });
                                alert(msg);
                                this.isSubmitting = false;
                            });
                    } else {
                        appendTextToSection(
                            pageTitleToUse,
                            sectionIdToUse,
                            insertion.previewFragment,
                            state.convByVar({hant: '使用 [[User:SuperGrey/gadgets/ReviewTool|ReviewTool]] 新增評審項', hans: '使用 [[User:SuperGrey/gadgets/ReviewTool|ReviewTool]] 新增评审项目'})
                        )
                            .then((resp: any) => {
                                mw && mw.notify && mw.notify(state.convByVar({hant: '已成功新增評審項目。', hans: '已成功新增评审项目。'}), { tag: 'review-tool' });
                                this.isSubmitting = false;
                                this.open = false;
                                (state as any).pendingReviewHeading = null;
                                setTimeout(() => { removeDialogMount(); }, 200);
                            })
                            .catch((err: any) => {
                                console.error('[ReviewTool] appendTextToSection failed', err);
                                const msg = state.convByVar({hant: '新增評審項目失敗，請稍後再試。', hans: '新增评审项目失败，请稍后再试。'});
                                mw && mw.notify && mw.notify(msg, { type: 'error', title: '[ReviewTool]' });
                                alert(msg);
                                this.isSubmitting = false;
                            });
                    }
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
                            class="review-tool-dialog review-tool-review-management-dialog review-tool-multistep-dialog"
                		>

                <template #header>
                    <div class="review-tool-multistep-dialog__header-top">
                        <h2>{{ $options.i18n.dialogTitle }}</h2>
                    </div>

                    <div class="review-tool-multistep-dialog__stepper">
                        <div class="review-tool-multistep-dialog__stepper__label">{{ ( currentStep + 1 ) + ' / 4' }}</div>
                        <div class="review-tool-multistep-dialog__stepper__steps" aria-hidden>
                            <span v-for="step of [0,1,2,3]" :key="step" class="review-tool-multistep-dialog__stepper__step" :class="getStepClass(step)"></span>
                        </div>
                    </div>
                </template>

                <!-- Step 0: Form -->
                <div v-if="currentStep === 0">
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
                </div>

                <!-- Step 1: Edit Draft -->
                <div v-else-if="currentStep === 1" class="review-tool-edit-step">
                    <h3>{{ $options.i18n.editHeading }}</h3>
                    <p class="review-tool-edit-step__instruction">{{ $options.i18n.editInstruction }}</p>
                    <cdx-text-area
                        v-model="editedDraft"
                        :placeholder="$options.i18n.editPlaceholder"
                        rows="16"
                    ></cdx-text-area>
                </div>

                <!-- Step 2: Preview -->
                <div v-else-if="currentStep === 2" class="review-tool-preview">
                    <h3>{{ $options.i18n.previewHeading }}</h3>
                    <div
                        v-if="previewHtml"
                        class="review-tool-preview-pre review-tool-preview-pre--html"
                        ref="previewHtmlHost"
                        v-html="previewHtml"
                    ></div>
                    <pre class="review-tool-preview-pre" v-else>{{ previewWikitext || editedDraft || (selectedCriteria.length ? selectedCriteria.join('\\n') : (criterion || $options.i18n.noSpecificCriteria)) }}</pre>
                </div>

                <!-- Step 3: Diff & Save -->
                <div v-else-if="currentStep === 3" class="review-tool-diff">
                    <h3>{{ $options.i18n.diffHeading }}</h3>
                    <div
                        v-if="diffHtml"
                        class="review-tool-diff-pre review-tool-diff-pre--html"
                        ref="diffHtmlHost"
                        v-html="diffHtml"
                    ></div>
                    <div v-else>
                        <p>{{ $options.i18n.noDiff }}</p>
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
