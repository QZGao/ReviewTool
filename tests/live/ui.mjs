import assert from 'node:assert/strict';

export async function waitForAnnotation(page) {
  await page.waitForFunction(() => document.querySelector('#ca-annotate a')?.getAttribute('aria-busy') === 'false'
    && Boolean(document.querySelector('.annotation-document') || document.querySelector('.mw-notification-type-error')), undefined, { timeout: 60000 });
  assert.equal(await page.locator('.annotation-document').count(), 1, await page.locator('.mw-notification').allTextContents());
}

/** Observe submitted work in the local journal, without adding test controls to the product. */
export async function waitForSaved(page, expectedContent) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const complete = await page.evaluate(async expectedContent => {
    const wiki = await new Promise((resolve, reject) => {
      const request = indexedDB.open('reviewtool-dry-run-v1', 2);
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    let saved;
    try {
      saved = await new Promise((resolve, reject) => {
      const title = `Wikipedia:ReviewTool/data/${mw.config.get('wgRevisionId')}.json`;
        const request = wiki.transaction('pages').objectStore('pages').get(title);
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      });
    } finally { wiki.close(); }
    if (!saved?.content.includes(expectedContent)) return false;
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('reviewtool-annotation-records-v1', 1);
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    try {
      const pending = await new Promise((resolve, reject) => {
        const request = db.transaction('outbox').objectStore('outbox').getAll();
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      });
      return pending.length === 0;
    } finally { db.close(); }
    }, expectedContent);
    if (complete) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.fail("The expected annotation content was not saved within 15 seconds.");
}

export async function clickExport(page) {
  assert.equal(await page.locator('#p-cactions #ca-reviewtool-export').count(), 1);
  if (!await page.locator('#ca-reviewtool-export a').isVisible()) await page.locator('#vector-page-tools-dropdown-checkbox').check();
  await page.locator('#ca-reviewtool-export a').click();
}
