import state from "../state";
import { loadCodexAndVue, mountApp, removeDialogMount, registerCodexComponents, getMountedApp } from "../dialog";
import { findSectionInfoFromHeading, appendTextToSection, retrieveFullText, parseWikitextToHtml, compareWikitext } from "../api";
import { advanceDialogStep, regressDialogStep, triggerDialogContentHooks } from "./utils";

declare var mw: any;

/**
 * 創建檢查文筆對話框。
 */
function createCheckWritingDialog(): void {
    loadCodexAndVue().then(({Vue, Codex}: any) => {
        const app = Vue.createMwApp({
            i18n: {
                dialogTitle: state.convByVar({
                    hant: '檢查「',
                    hans: '检查「'
                }) + state.articleTitle + state.convByVar({hant: '」的文筆', hans: '」的文笔'}),
                save: state.convByVar({hant: '儲存', hans: '保存'}),
                saving: state.convByVar({hant: '儲存中…', hans: '保存中…'}),
                cancel: state.convByVar({hant: '取消', hans: '取消'}),
                addChapter: state.convByVar({hant: '新增章節', hans: '新增章节'}),
                removeChapter: state.convByVar({hant: '刪除章節', hans: '删除章节'}),
                addSuggestion: state.convByVar({hant: '新增意見', hans: '新增意见'}),
                removeSuggestion: state.convByVar({hant: '刪除意見', hans: '删除意见'}),
                chapterTitleLabel: state.convByVar({hant: '章節標題', hans: '章节标题'}),
                quoteLabel: state.convByVar({hant: '引用原文', hans: '引用原文'}),
                quotePlaceholder: state.convByVar({hant: '原文句子', hans: '原文句子'}),
                suggestionPlaceholder: state.convByVar({hant: '意見或建議', hans: '意见或建议'}),
                next: state.convByVar({hant: '下一步', hans: '下一步'}),
                previous: state.convByVar({hant: '上一步', hans: '上一步'}),
                previewHeading: state.convByVar({hant: '預覽', hans: '预览'}),
                diffHeading: state.convByVar({hant: '差異', hans: '差异'}),
                diffLoading: state.convByVar({hant: '差異載入中…', hans: '差异载入中…'}),
            }, data() {
                return {
                        open: true,
                        isSaving: false,
                        currentStep: 0,
                        chapters: [
                            { title: '', suggestions: [{ quote: '', suggestion: '' }] }
                        ],
                        previewWikitext: '',
                        previewHtml: '',
                        existingSectionText: '',
                        pendingNewSectionText: '',
                        diffHtml: '',
                        diffLines: [] as string[],
                };
            }, computed: {
                primaryAction() {
                    // Next / Save depending on step
                    if (this.currentStep < 2) {
                        return { label: this.$options.i18n.next || 'Next', actionType: 'primary', disabled: false };
                    }
                    return { label: this.isSaving ? this.$options.i18n.saving : this.$options.i18n.save, actionType: 'progressive', disabled: this.isSaving };
                }, defaultAction() {
                    if (this.currentStep > 0) return { label: this.$options.i18n.previous || 'Previous' };
                    return { label: this.$options.i18n.cancel };
                }
            }, methods: {
                triggerContentHooks(kind: 'preview' | 'diff') {
                    triggerDialogContentHooks(this, kind);
                },
                getPendingCheckWritingSectionInfo() {
                    const headingEl: Element | null = (state as any).pendingReviewHeading || null;
                    const sec = findSectionInfoFromHeading(headingEl as Element | null);
                    const pageTitleToUse = sec && sec.pageTitle ? sec.pageTitle : (state.articleTitle || '');
                    const sectionIdToUse = typeof (sec && (sec as any).sectionId) === 'number'
                        ? (sec as any).sectionId
                        : (sec && sec.sectionId != null ? sec.sectionId : null);
                    return { headingEl, sec, pageTitleToUse, sectionIdToUse };
                },
                getStepClass(step: number) {
                    return { 'review-tool-multistep-dialog__stepper__step--active': step <= this.currentStep };
                },
                preparePreviewContent() {
                    const { pageTitleToUse, sectionIdToUse } = this.getPendingCheckWritingSectionInfo();
                    this.previewHtml = '';
                    this.previewWikitext = '';
                    this.pendingNewSectionText = '';
                    this.existingSectionText = '';
                    this.diffHtml = '';
                    this.diffLines = [];

                    const bundle = this.buildPreviewBundle();
                    if (!bundle) {
                        return;
                    }
                    const { previewFragment, appendSuffix } = bundle;
                    this.previewWikitext = previewFragment;

                    const renderPreview = (existingText: string) => {
                        const baseline = existingText || '';
                        this.existingSectionText = baseline;
                        this.pendingNewSectionText = baseline + appendSuffix;
                        parseWikitextToHtml(previewFragment, pageTitleToUse).then((html: string) => {
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
                        retrieveFullText(pageTitleToUse, sectionIdToUse).then(({ text }) => {
                            renderPreview(text || '');
                        }).catch((err: any) => {
                            console.error('[ReviewTool] retrieveFullText failed', err);
                            renderPreview('');
                        });
                    } else {
                        renderPreview('');
                    }
                },
                prepareDiffContent() {
                    const { pageTitleToUse, sectionIdToUse } = this.getPendingCheckWritingSectionInfo();
                    this.diffHtml = '';
                    this.diffLines = [];

                    const bundle = this.buildPreviewBundle();
                    if (!bundle) {
                        return;
                    }
                    const { previewFragment, appendSuffix } = bundle;
                    this.previewWikitext = previewFragment;

                    const runDiff = (existingText: string) => {
                        const baseline = existingText || '';
                        const newSectionText = baseline + appendSuffix;
                        this.existingSectionText = baseline;
                        this.pendingNewSectionText = newSectionText;
                        compareWikitext(baseline, newSectionText).then((diffHtml: string) => {
                            this.diffHtml = diffHtml || '';
                            if (this.diffHtml && this.currentStep === 2) {
                                this.triggerContentHooks('diff');
                            } else {
                                this.diffLines = this.buildDiffLines(baseline, appendSuffix);
                            }
                        }).catch((err: any) => {
                            console.error('[ReviewTool] compareWikitext failed', err);
                            this.diffHtml = '';
                            this.diffLines = this.buildDiffLines(baseline, appendSuffix);
                        });
                    };

                    if (
                        this.pendingNewSectionText &&
                        typeof this.existingSectionText === 'string' &&
                        this.pendingNewSectionText === this.existingSectionText + appendSuffix
                    ) {
                        runDiff(this.existingSectionText);
                        return;
                    }

                    if (sectionIdToUse != null) {
                        retrieveFullText(pageTitleToUse, sectionIdToUse).then(({ text }) => {
                            runDiff(text || '');
                        }).catch((err: any) => {
                            console.error('[ReviewTool] retrieveFullText failed', err);
                            runDiff('');
                        });
                    } else {
                        runDiff('');
                    }
                },
                onPrimaryAction() {
                    if (advanceDialogStep(this, {
                        onEnterPreviewStep: this.preparePreviewContent,
                        onEnterDiffStep: this.prepareDiffContent,
                    })) {
                        return;
                    }
                    this.saveCheckWriting();
                }, onDefaultAction() {
                    if (regressDialogStep(this)) {
                        return;
                    }
                    this.closeDialog();
                }, onUpdateOpen(newValue: any) {
                    if (!newValue) {
                        this.closeDialog();
                    }
                }, closeDialog() {
                    this.open = false;
                    setTimeout(() => {
                        removeDialogMount();
                    }, 300);
                },
                buildPreviewBundle(): { previewFragment: string; appendSuffix: string } | null {
                    const fragment = this.buildWikitext().trim();
                    if (!fragment) {
                        return null;
                    }
                    const appendSuffix = `\n\n${fragment}`;
                    return { previewFragment: fragment, appendSuffix };
                },
                buildWikitext() {
                    let wikitext = '';
                    for (const ch of this.chapters) {
                        const title = (ch.title || '').trim();
                        wikitext += "'''" + title + "'''\n";
                        for (const s of (ch.suggestions || [])) {
                            const quote = (s.quote || '').trim();
                            const suggestion = (s.suggestion || '').trim();
                            wikitext += `* {{rvw|1=${quote}}} —— ${suggestion}\n`;
                        }
                        wikitext += '--~~~~\n\n';
                    }
                    return wikitext;
                },
                buildDiffLines(oldText: string, appendedFragment: string) {
                    const oldLines = (oldText || '').split(/\r?\n/);
                    const appendedOnly = (appendedFragment || '').replace(/^\s*\n+/, '');
                    const newLines = appendedOnly.split(/\r?\n/);
                    const out: string[] = [];
                    // Show existing section then the appended lines prefixed with +
                    out.push('--- Existing section ---');
                    out.push(...oldLines.map(l => '  ' + l));
                    out.push('');
                    out.push('+++ New content to append +++');
                    out.push(...newLines.map(l => '+ ' + l));
                    return out;
                },
                saveCheckWriting() {
                    this.isSaving = true;
                    const { sec, pageTitleToUse, sectionIdToUse } = this.getPendingCheckWritingSectionInfo();
                    if (!sec || sectionIdToUse == null) {
                        const msg = state.convByVar({hant: '無法識別文筆章節編號，請在討論頁的文筆章節附近點擊「檢查文筆」。', hans: '无法识别文笔章节编号，请在讨论页的文笔章节附近点击“检查文笔”。'});
                        mw && mw.notify && mw.notify(msg, { type: 'error', title: '[ReviewTool]' });
                        alert(msg);
                        this.isSaving = false;
                        return;
                    }

                    const bundle = this.buildPreviewBundle();
                    if (!bundle) {
                        const msg = state.convByVar({hant: '請先輸入文筆建議內容，再嘗試儲存。', hans: '请先输入文笔建议内容，再尝试保存。'});
                        mw && mw.notify && mw.notify(msg, { type: 'error', title: '[ReviewTool]' });
                        alert(msg);
                        this.isSaving = false;
                        return;
                    }

                    appendTextToSection(
                        pageTitleToUse,
                        sectionIdToUse as number,
                        bundle.appendSuffix,
                        state.convByVar({hant: '新增文筆建議', hans: '新增文笔建议'})
                    )
                        .then((resp: any) => {
                            mw && mw.notify && mw.notify(state.convByVar({hant: '已成功新增文筆建議。', hans: '已成功新增文笔建议。'}), { tag: 'review-tool' });
                            this.isSaving = false;
                            this.open = false;
                            (state as any).pendingReviewHeading = null;
                            setTimeout(() => { removeDialogMount(); }, 200);
                        })
                        .catch((err: any) => {
                            console.error('[ReviewTool] appendTextToSection failed', err);
                            const msg = state.convByVar({hant: '新增文筆建議失敗，請稍後再試。', hans: '新增文笔建议失败，请稍后再试。'});
                            mw && mw.notify && mw.notify(msg, { type: 'error', title: '[ReviewTool]' });
                            alert(msg);
                            this.isSaving = false;
                        });
                }, addChapter() {
                    this.chapters.push({ title: '', suggestions: [{ quote: '', suggestion: '' }] });
                }, removeChapter(idx: number) {
                    if (this.chapters.length <= 1) {
                        return;
                    }
                    this.chapters.splice(idx, 1);
                }, addSuggestion(chIdx: number) {
                    this.chapters[chIdx].suggestions.push({ quote: '', suggestion: '' });
                }, removeSuggestion(chIdx: number, sIdx: number) {
                    const suggestions = this.chapters[chIdx].suggestions;
                    if (suggestions.length <= 1) {
                        return;
                    }
                    suggestions.splice(sIdx, 1);
                },
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
                class="review-tool-dialog review-tool-check-writing-dialog review-tool-multistep-dialog"
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
                                        <cdx-button size="small" class="cdx-button--icon-only" :aria-label="$options.i18n.removeSuggestion" :disabled="ch.suggestions.length <= 1" @click.prevent="removeSuggestion(chIdx, sIdx)">
                                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" aria-hidden="true" focusable="false" width="16" height="16"><path d="M3 6h18v2H3V6zm2 3h14l-1 11H6L5 9zm3-6h6l1 2H7l1-2z"/></svg>
                                        </cdx-button>
                                    </div>
                                </div>
                            </div>

                        </div>

                        <div class="row-controls">
							<div class="suggestion-add">
								<cdx-button size="small" @click.prevent="addSuggestion(chIdx)">
									<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" aria-hidden="true" focusable="false" width="16" height="16" style="margin-right:6px"><path d="M11 11V6h2v5h5v2h-5v5h-2v-5H6v-2z"/></svg>
									{{ $options.i18n.addSuggestion }}
								</cdx-button>
							</div>

							<div class="chapter-controls">
								<cdx-button v-if="chIdx === chapters.length - 1" size="small" @click.prevent="addChapter">
									<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" aria-hidden="true" focusable="false" width="16" height="16" style="margin-right:6px"><path d="M11 11V6h2v5h5v2h-5v5h-2v-5H6v-2z"/></svg>
									{{ $options.i18n.addChapter }}
								</cdx-button>
								<cdx-button size="small" :disabled="chapters.length <= 1" @click.prevent="removeChapter(chIdx)">
									<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" aria-hidden="true" focusable="false" width="16" height="16" style="margin-right:6px"><path d="M3 6h18v2H3V6zm2 3h14l-1 11H6L5 9zm3-6h6l1 2H7l1-2z"/></svg>
									{{ $options.i18n.removeChapter }}
								</cdx-button>
							</div>
                        </div>
                    </div>
                </div>

                <!-- Step 1: Preview -->
                <div v-else-if="currentStep === 1" class="review-tool-preview">
                    <h3>{{ $options.i18n.previewHeading }}</h3>
                    <div
                        v-if="previewHtml"
                        class="review-tool-preview-pre review-tool-preview-pre--html"
                        ref="previewHtmlHost"
                        v-html="previewHtml"
                    ></div>
                    <pre class="review-tool-preview-pre" v-else>{{ previewWikitext }}</pre>
                </div>

                <!-- Step 2: Diff & Save -->
                <div v-else-if="currentStep === 2" class="review-tool-diff">
                    <h3>{{ $options.i18n.diffHeading }}</h3>
                    <div
                        v-if="diffHtml"
                        class="review-tool-diff-pre review-tool-diff-pre--html"
                        ref="diffHtmlHost"
                        v-html="diffHtml"
                    ></div>
                    <div v-else>
                        <p>{{ $options.i18n.diffLoading }}</p>
                        <pre class="review-tool-diff-pre">{{ diffLines.join('\\n') }}</pre>
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
 * 打開檢查文筆對話框。
 */
export function openCheckWritingDialog(): void {
    if (getMountedApp()) removeDialogMount();
    createCheckWritingDialog();
}