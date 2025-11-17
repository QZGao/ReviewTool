import state from "../state";
import {assessments, getAssessmentLabels} from "../templates";

import { loadCodexAndVue, mountApp, removeDialogMount, registerCodexComponents, getMountedApp } from "../dialog";
import { findSectionInfoFromHeading, createHeaderMarkup, appendTextToSection, getSectionWikitext, replaceSectionText, parseWikitextToHtml, compareWikitext } from "../api";
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
                    if (this.currentStep < 2) {
                        return { label: this.$options.i18n.next || 'Next', actionType: 'primary', disabled: false };
                    }
                    return { label: this.isSubmitting ? this.$options.i18n.submitting : this.$options.i18n.submit, actionType: 'progressive', disabled: this.isSubmitting };
                }, defaultAction() {
                    if (this.currentStep > 0) return { label: this.$options.i18n.previous || 'Previous' };
                    return { label: this.$options.i18n.cancel };
                }
            }, methods: {
                triggerContentHooks(kind: 'preview' | 'diff') {
                    this.$nextTick(() => {
                        const html = kind === 'preview' ? this.previewHtml : this.diffHtml;
                        const resolution = this.resolveHostForHtml(kind, html);
                        const host = resolution?.host || null;
                        if (!host || !html) {
                            this.setFallbackHostVisible(kind, false);
                            return;
                        }
                        if (resolution?.usedFallback || !host.innerHTML || !host.innerHTML.trim()) {
                            host.innerHTML = html;
                        }
                        if (resolution?.usedFallback) {
                            this.setFallbackHostVisible(kind, true);
                            this.setFallbackHostVisible(kind === 'preview' ? 'diff' : 'preview', false);
                        } else {
                            this.setFallbackHostVisible(kind, false);
                        }
                        this.afterServerHtmlInjected(host as HTMLElement, html);
                    });
                },
                resolveHostForHtml(kind: 'preview' | 'diff', html: string | null): { host: HTMLElement | null, usedFallback?: boolean } | null {
                    const refName = kind === 'preview' ? 'previewHtmlHost' : 'diffHtmlHost';
                    const refs = this.$refs as Record<string, HTMLElement | HTMLElement[] | undefined>;
                    let host = refs[refName];
                    if (Array.isArray(host)) host = host[0];
                    if (host) return { host };

                    const dialogRoot = document.querySelector('.review-tool-review-management-dialog');
                    const selector = kind === 'preview' ? '.review-tool-preview-pre--html' : '.review-tool-diff-pre--html';
                    const fallbackInDialog = dialogRoot ? (dialogRoot.querySelector(selector) as HTMLElement | null) : null;
                    if (fallbackInDialog) return { host: fallbackInDialog };

                    const fallbackKey = kind === 'preview' ? '_previewFallbackHost' : '_diffFallbackHost';
                    let fallbackHost = (this as any)[fallbackKey] as HTMLElement | null;
                    if (!fallbackHost || !document.body.contains(fallbackHost)) {
                        const allBodies = Array.from(document.querySelectorAll('.cdx-dialog__body.cdx-scrollable-container')) as HTMLElement[];
                        const targetBody = dialogRoot ? (dialogRoot.querySelector('.cdx-dialog__body.cdx-scrollable-container') as HTMLElement | null) : null;
                        const bodyEl = targetBody || (allBodies.length ? allBodies[allBodies.length - 1] : null);
                        if (bodyEl) {
                            fallbackHost = document.createElement('div');
                            fallbackHost.className = 'review-tool-html-host review-tool-html-host--fallback review-tool-html-host--' + kind;
                            fallbackHost.style.padding = '16px';
                            fallbackHost.style.minHeight = '80px';
                            fallbackHost.style.display = kind === 'preview' ? '' : 'none';
                            bodyEl.appendChild(fallbackHost);
                            (this as any)[fallbackKey] = fallbackHost;
                        }
                    }
                    return { host: fallbackHost || null, usedFallback: !!fallbackHost };
                },
                setFallbackHostVisible(kind: 'preview' | 'diff', visible: boolean) {
                    const fallbackKey = kind === 'preview' ? '_previewFallbackHost' : '_diffFallbackHost';
                    const host = (this as any)[fallbackKey] as HTMLElement | null;
                    if (host) host.style.display = visible ? '' : 'none';
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
                    return createHeaderMarkup(state.convByVar({hant: '無具體評審項目', hans: '无具体评审项目'}), level);
                },
                preparePreviewContent() {
                    const { pageTitleToUse, sectionIdToUse } = this.getPendingReviewSectionInfo();
                    const level = this.submitUnderOpinionSubsection ? 4 : 3;
                    this.previewHtml = '';
                    this.previewWikitext = '';
                    this.pendingNewSectionText = '';
                    this.existingSectionText = '';

                    if (!this.submitUnderOpinionSubsection) {
                        const headers = this.buildHeadersForCriteria(level);
                        this.previewWikitext = headers;
                        parseWikitextToHtml(headers, pageTitleToUse).then((html: string) => {
                            this.previewHtml = html || '';
                            if (this.previewHtml && this.currentStep === 1) {
                                this.triggerContentHooks('preview');
                            }
                        }).catch((e: any) => {
                            console.error('[ReviewTool] parseWikitextToHtml failed', e);
                            this.previewHtml = '';
                        });
                        return;
                    }

                    const opinionHeaderTitle = `${state.userName}${state.convByVar({hant: ' 的意見', hans: ' 的意见'})}`;
                    const h4s = this.buildHeadersForCriteria(4);
                    const fallbackFragment = createHeaderMarkup(opinionHeaderTitle, 3) + h4s;
                    const renderPreview = (fragment: string, existingText: string, newText: string) => {
                        this.previewWikitext = fragment;
                        this.existingSectionText = existingText;
                        this.pendingNewSectionText = newText;
                        parseWikitextToHtml(fragment, pageTitleToUse).then((html: string) => {
                            this.previewHtml = html || '';
                            if (this.previewHtml && this.currentStep === 1) {
                                this.triggerContentHooks('preview');
                            }
                        }).catch((e: any) => {
                            console.error('[ReviewTool] parseWikitextToHtml failed', e);
                            this.previewHtml = '';
                        });
                    };

                    if (sectionIdToUse != null) {
                        getSectionWikitext(pageTitleToUse, sectionIdToUse).then((secW: string) => {
                            const secText = secW || '';
                            const insertion = this.computeOpinionInsertion(secText, h4s, opinionHeaderTitle);
                            renderPreview(insertion.previewFragment, secText, insertion.newSectionText);
                        }).catch((e: any) => {
                            console.error('[ReviewTool] getSectionWikitext failed', e);
                            renderPreview(fallbackFragment, '', fallbackFragment);
                        });
                    } else {
                        renderPreview(fallbackFragment, '', fallbackFragment);
                    }
                },
                prepareDiffContent() {
                    const { pageTitleToUse, sectionIdToUse } = this.getPendingReviewSectionInfo();
                    this.diffHtml = '';

                    if (!this.submitUnderOpinionSubsection) {
                        const headers = this.previewWikitext || this.buildHeadersForCriteria(3);
                        const runDiff = (oldText: string, newText: string) => {
                            compareWikitext(oldText || '', newText).then((dhtml: string) => {
                                this.diffHtml = dhtml || '';
                                if (this.diffHtml && this.currentStep === 2) {
                                    this.triggerContentHooks('diff');
                                }
                            }).catch((e: any) => {
                                console.error('[ReviewTool] compareWikitext failed', e);
                                this.diffHtml = '';
                            });
                        };

                        if (sectionIdToUse != null) {
                            getSectionWikitext(pageTitleToUse, sectionIdToUse).then((secW: string) => {
                                const current = secW || '';
                                this.existingSectionText = current;
                                runDiff(current, (current || '') + headers);
                            }).catch((e: any) => {
                                console.error('[ReviewTool] getSectionWikitext failed', e);
                                runDiff('', headers);
                            });
                        } else {
                            runDiff('', headers);
                        }
                        return;
                    }

                    const opinionHeaderTitle = `${state.userName}${state.convByVar({hant: ' 的意見', hans: ' 的意见'})}`;
                    const h4s = this.buildHeadersForCriteria(4);
                    const runOpinionDiff = (oldText: string, newText: string) => {
                        this.existingSectionText = oldText;
                        this.pendingNewSectionText = newText;
                        compareWikitext(oldText || '', newText).then((dhtml: string) => {
                            this.diffHtml = dhtml || '';
                            if (this.diffHtml && this.currentStep === 2) {
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

                    const fallbackFragment = createHeaderMarkup(opinionHeaderTitle, 3) + h4s;

                    if (sectionIdToUse != null) {
                        getSectionWikitext(pageTitleToUse, sectionIdToUse).then((secW: string) => {
                            const secText = secW || '';
                            const insertion = this.computeOpinionInsertion(secText, h4s, opinionHeaderTitle);
                            runOpinionDiff(secText, insertion.newSectionText);
                        }).catch((e: any) => {
                            console.error('[ReviewTool] getSectionWikitext failed', e);
                            runOpinionDiff('', fallbackFragment);
                        });
                    } else {
                        runOpinionDiff('', fallbackFragment);
                    }
                },
                computeOpinionInsertion(secText: string, h4s: string, opinionHeaderTitle: string) {
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
                            const insertPos = match.index + fullLine.length;
                            const newSectionText = secText.slice(0, insertPos) + '\n' + h4s + secText.slice(insertPos);
                            return { previewFragment: h4s, newSectionText };
                        }
                    }
                    const previewFragment = createHeaderMarkup(opinionHeaderTitle, 3) + h4s;
                    const newSectionText = secText + previewFragment;
                    return { previewFragment, newSectionText };
                },
                ensureCurrentStepContentHooks() {
                    this.$nextTick(() => {
                        if (this.currentStep === 1 && this.previewHtml) {
                            this.triggerContentHooks('preview');
                        } else if (this.currentStep === 2 && this.diffHtml) {
                            this.triggerContentHooks('diff');
                        } else {
                            this.setFallbackHostVisible('preview', false);
                            this.setFallbackHostVisible('diff', false);
                        }
                    });
                },
                afterServerHtmlInjected(targetEl: HTMLElement, html: string) {
                    if (!targetEl || !html) return;
                    try {
                        if (typeof mw !== 'undefined' && mw && mw.hook && typeof mw.hook === 'function') {
                            const $ = (window as any).jQuery;
                            mw.hook('wikipage.content').fire($ ? $(targetEl) : targetEl);
                        }
                    } catch (e) {
                        try { mw && mw.hook && mw.hook('wikipage.content').fire(targetEl); } catch (err) { /* ignore */ }
                    }
                    if (html.indexOf('class="diff') !== -1) {
                        try { mw && mw.loader && mw.loader.load && mw.loader.load('mediawiki.diff.styles'); } catch (e) { /* ignore */ }
                    }
                },
                getStepClass(step: number) {
                    return { 'review-tool-multistep-dialog__stepper__step--active': step <= this.currentStep };
                },
                onPrimaryAction() {
                    if (this.currentStep < 2) {
                        const nextStep = this.currentStep + 1;
                        if (nextStep === 1) {
                            this.preparePreviewContent();
                        } else if (nextStep === 2) {
                            this.prepareDiffContent();
                        }
                        this.currentStep = nextStep;
                        this.ensureCurrentStepContentHooks();
                        return;
                    }
                    this.submitReview();
                }, onDefaultAction() {
                    if (this.currentStep > 0) {
                        this.currentStep--;
                        this.ensureCurrentStepContentHooks();
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
                        const headers = Array.isArray(this.selectedCriteria) && this.selectedCriteria.length > 0
                            ? buildHeadersForCriteria(this.selectedCriteria, level)
                            : (this.criterion ? createHeaderMarkup(String(this.criterion), level) : createHeaderMarkup(state.convByVar({hant: '無具體評審項目', hans: '无具体评审项目'}), level));
                        appendTextToSection(pageTitleToUse, sectionIdToUse, headers, state.convByVar({hant: '使用 ReviewTool 新增評審項目', hans: '使用 ReviewTool 新增评审项目'}))
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
                    const h4s = (Array.isArray(this.selectedCriteria) && this.selectedCriteria.length > 0)
                        ? buildHeadersForCriteria(this.selectedCriteria, 4)
                        : (this.criterion ? createHeaderMarkup(String(this.criterion), 4) : createHeaderMarkup(state.convByVar({hant: '無具體評審項目', hans: '无具体评审项目'}), 4));

                    // Fetch the section wikitext to detect existing H3. Be tolerant of
                    // spacing and simple wiki markup when matching the H3 title.
                    getSectionWikitext(pageTitleToUse, sectionIdToUse).then((secWikitext: string) => {
                        // Find lines that look like H3 headings (three or more equals on each side)
                        const h3LineRe = /^\s*(={3,})\s*(.*?)\s*\1\s*$/gm;

                        // Normalize heading text: remove wiki formatting like '' or ''' and decode HTML entities
                        function normalizeHeadingText(s: string): string {
                            if (!s) return '';
                            // remove bold/italic wiki markup
                            s = s.replace(/'''+/g, '').replace(/''/g, '');
                            // decode HTML entities by using a temporary DOM element
                            try {
                                const txt = document.createElement('textarea');
                                txt.innerHTML = s;
                                s = txt.value;
                            } catch (e) { /* ignore in non-browser environments */ }
                            return s.replace(/\s+/g, ' ').trim();
                        }

                        const targetNorm = normalizeHeadingText(opinionHeaderTitle);
                        let match: RegExpExecArray | null;
                        let found = false;
                        while ((match = h3LineRe.exec(secWikitext)) !== null) {
                            const fullLine = match[0];
                            const inner = match[2];
                            if (normalizeHeadingText(inner) === targetNorm) {
                                // Insert H4s immediately after this matched heading line
                                const insertPos = match.index + fullLine.length;
                                const newSectionText = secWikitext.slice(0, insertPos) + '\n' + h4s + secWikitext.slice(insertPos);
                                replaceSectionText(pageTitleToUse, sectionIdToUse, newSectionText, state.convByVar({hant: '使用 ReviewTool 新增評審子項', hans: '使用 ReviewTool 新增评审子项'}))
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
                                found = true;
                                break;
                            }
                        }

                        if (!found) {
                            // Opinion H3 not found: append an H3 with the H4s to the section
                            const toAppend = createHeaderMarkup(opinionHeaderTitle, 3) + h4s;
                            appendTextToSection(pageTitleToUse, sectionIdToUse, toAppend, state.convByVar({hant: '使用 ReviewTool 新增評審項', hans: '使用 ReviewTool 新增评审项目'}))
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
                    }).catch((err: any) => {
                        console.error('[ReviewTool] getSectionWikitext failed', err);
                        const msg = state.convByVar({hant: '讀取章節內容失敗，無法新增子項。', hans: '读取章节内容失败，无法新增子项。'});
                        mw && mw.notify && mw.notify(msg, { type: 'error', title: '[ReviewTool]' });
                        alert(msg);
                        this.isSubmitting = false;
                    });
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
                        <div class="review-tool-multistep-dialog__stepper__label">{{ ( currentStep + 1 ) + ' of 3' }}</div>
                        <div class="review-tool-multistep-dialog__stepper__steps" aria-hidden>
                            <span v-for="step of [0,1,2]" :key="step" class="review-tool-multistep-dialog__stepper__step" :class="getStepClass(step)"></span>
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

                <!-- Step 1: Preview -->
                <div v-if="currentStep === 1" class="review-tool-preview">
                    <h3>{{ $options.i18n.previewHeading }}</h3>
                    <div
                        v-if="previewHtml"
                        class="review-tool-preview-pre review-tool-preview-pre--html"
                        ref="previewHtmlHost"
                        v-html="previewHtml"
                    ></div>
                    <pre class="review-tool-preview-pre" v-else>{{ selectedCriteria.length ? selectedCriteria.join('\\n') : (criterion || 'No specific criteria') }}</pre>
                </div>

                <!-- Step 2: Diff & Save -->
                <div v-if="currentStep === 2" class="review-tool-diff">
                    <h3>{{ $options.i18n.diffHeading }}</h3>
                    <div
                        v-if="diffHtml"
                        class="review-tool-diff-pre review-tool-diff-pre--html"
                        ref="diffHtmlHost"
                        v-html="diffHtml"
                    ></div>
                    <div v-else>
                        <p>Click "{{ $options.i18n.submit }}" to add the items to the discussion page.</p>
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
