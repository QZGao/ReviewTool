import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { root } from './launch.mjs';

let browser;
const bundle = path.join(root, `.cache/talk-page-test-${process.pid}.js`);

before(async () => {
  await mkdir(path.dirname(bundle), { recursive: true });
  await build({
    stdin: {
      contents: `
        import { addTalkPageReviewToolButtonsToDOM } from './src/dom/talk_page.ts';
        import state from './src/state.ts';
        window.talkPageTest = { addTalkPageReviewToolButtonsToDOM, state };
      `,
      resolveDir: root,
    },
    outfile: bundle,
    bundle: true,
    format: 'iife',
    platform: 'browser',
    plugins: [{
      name: 'dialog-stubs',
      setup(builder) {
        builder.onResolve({ filter: /dialogs\/(review_management|check_writing)$/ }, args => ({ path: args.path.endsWith('review_management') ? 'review' : 'writing', namespace: 'dialog-stub' }));
        builder.onLoad({ filter: /.*/, namespace: 'dialog-stub' }, args => ({
          contents: args.path === 'review'
            ? `export function openReviewManagementDialog() { window.openedReviewToolDialog = 'review'; }`
            : `export function openCheckWritingDialog() { window.openedReviewToolDialog = 'writing'; }`,
        }));
      },
    }],
  });
  browser = await chromium.launch({ headless: true, ...(existsSync('/Applications/Google Chrome.app') ? { channel: 'chrome' } : {}) });
});

after(async () => {
  await browser?.close();
  await unlink(bundle).catch(() => {});
});

async function verifyPage({ pageTitle, namespace, sectionTitle, expectedArticle, expectedAssessment }) {
  const page = await browser.newPage();
  try {
    await page.setContent(`<main id="mw-content-text"><div class="mw-parser-output">
      <div class="mw-heading mw-heading2"><h2 id="${sectionTitle}">${sectionTitle}</h2><span class="mw-editsection"></span></div>
      <div class="mw-heading mw-heading3"><h3 id="文筆">文筆</h3><span class="mw-editsection"></span></div>
    </div></main>`);
    await page.evaluate(pageTitle => {
      window.mw = {
        config: { get: key => key === 'wgUserName' ? 'Example' : undefined },
        Title: { newFromText: title => ({
          isTalkPage: () => /^(?:Talk|[^:]+_talk):/.test(title),
          getSubjectPage: () => ({ getPrefixedText: () => title.replace(/^(?:Talk|[^:]+_talk):/, '') }),
        }) },
      };
      window.testPageTitle = pageTitle;
    }, pageTitle);
    await page.addScriptTag({ path: bundle });
    await page.evaluate(({ namespace, pageTitle }) => talkPageTest.addTalkPageReviewToolButtonsToDOM(namespace, pageTitle), { namespace, pageTitle });

    const heading = page.locator('.mw-heading2');
    await heading.getByRole('link', { name: '管理評審' }).click();
    assert.deepEqual(await page.evaluate(() => ({
      article: talkPageTest.state.articleTitle,
      assessment: talkPageTest.state.assessmentType,
      dialog: window.openedReviewToolDialog,
    })), { article: expectedArticle, assessment: expectedAssessment, dialog: 'review' });

    await heading.getByRole('link', { name: '檢查文筆' }).click();
    assert.deepEqual(await page.evaluate(() => ({
      article: talkPageTest.state.articleTitle,
      assessment: talkPageTest.state.assessmentType,
      dialog: window.openedReviewToolDialog,
    })), { article: expectedArticle, assessment: expectedAssessment, dialog: 'writing' });
    assert.equal(await page.locator('.mw-heading3').getByRole('link', { name: '檢查文筆' }).count(), 1);
  } finally {
    await page.close();
  }
}

test('assessment pages infer their type from the page while retaining the candidate section as the article', async () => {
  for (const [pageTitle, assessment] of [
    ['Wikipedia:優良條目評選', 'good'],
    ['Wikipedia:典范条目评选', 'featured'],
    ['Wikipedia:特色列表评选', 'featured_list'],
  ]) {
    await verifyPage({ pageTitle, namespace: 4, sectionTitle: '候选条目', expectedArticle: '候选条目', expectedAssessment: assessment });
  }
});

test('talk pages continue to infer the type from the review section and retain the subject title', async () => {
  await verifyPage({ pageTitle: 'Talk:候选条目', namespace: 1, sectionTitle: '優良條目評審', expectedArticle: '候选条目', expectedAssessment: 'good' });
});
