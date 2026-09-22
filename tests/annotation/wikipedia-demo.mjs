import * as annotation from '/annotation.mjs';

const key = document.documentElement.dataset.reviewtoolArticle;
const revisionId = Number(document.documentElement.dataset.reviewtoolRevision);
const content = document.getElementById('mw-content-text');
const original = content?.querySelector(':scope > .mw-parser-output');
const toolbar = document.createElement('section');
toolbar.className = 'annotation-page-tools';
toolbar.setAttribute('aria-label', 'Local annotation view controls');
toolbar.innerHTML = `<div class="annotation-page-actions">
  <label>Local article <select id="annotation-page-article" aria-label="Local article"></select></label>
  <label>Theme <select id="annotation-page-theme" aria-label="Theme"><option value="light">Light</option><option value="dark">Dark</option><option value="auto">Automatic</option></select></label>
  <button id="annotation-page-toggle" type="button" disabled>Loading…</button>
  <span id="annotation-page-status" role="status"></span>
  </div>
  <details id="annotation-page-selection"><summary>Selection inspector</summary>
    <p id="annotation-page-quote">Select text inside Annotation View.</p>
    <pre id="annotation-page-anchor"></pre><pre id="annotation-page-source"></pre>
    <button id="annotation-page-restore" type="button" disabled>Restore selection</button>
  </details>`;
if (content) content.before(toolbar);
else document.body.prepend(toolbar);
const $ = id => document.getElementById('annotation-page-' + id);
const themes = { light: 'day', dark: 'night', auto: 'os' };
function setTheme(theme) {
  if (!Object.hasOwn(themes, theme)) theme = 'light';
  document.documentElement.classList.remove(...Object.values(themes).map(value => 'skin-theme-clientpref-' + value));
  document.documentElement.classList.add('skin-theme-clientpref-' + themes[theme]);
  $('theme').value = theme;
  const url = new URL(location.href); url.searchParams.set('theme', theme); history.replaceState(null, '', url);
}
const initialTheme = Object.entries(themes).find(([, value]) => document.documentElement.classList.contains('skin-theme-clientpref-' + value))?.[0] ?? 'light';
setTheme(new URL(location.href).searchParams.get('theme') ?? initialTheme);
$('theme').addEventListener('change', () => setTheme($('theme').value));
let fixture, projection, mount = null, selected = null, highlights = [];
function updateStatus() {
  $('status').textContent = `${fixture.title} · revision ${revisionId} · ${mount ? 'Annotation View' : 'Original article'} · ${highlights.length} highlights (this session)`;
}
function show(selection) {
  selected = selection;
  $('quote').textContent = selection?.quote ?? 'Select text inside Annotation View.';
  $('anchor').textContent = selection ? JSON.stringify(selection.anchor, null, 2) : '';
  $('source').textContent = selection?.sourceText ?? '';
  $('restore').disabled = !selection;
}
function setEnabled(enabled) {
  if (!projection) return;
  if (enabled && !mount) mount = annotation.mountWikipediaAnnotation(document, projection, {
    onSelectionChange: show, headingAnchors: fixture.headingAnchors,
    highlighting: { initial: highlights, onChange: snapshot => { highlights = snapshot; updateStatus(); } },
  });
  else if (!enabled && mount) { mount.destroy(); mount = null; show(null); }
  $('toggle').textContent = mount ? 'Show original article' : 'Show Annotation View';
  $('toggle').setAttribute('aria-pressed', String(Boolean(mount)));
  updateStatus();
  const url = new URL(location.href);
  if (mount) url.searchParams.delete('view'); else url.searchParams.set('view', 'original');
  history.replaceState(null, '', url);
}
$('toggle').addEventListener('click', () => setEnabled(!mount));
$('article').addEventListener('change', () => { location.href = '/?' + new URLSearchParams({ article: $('article').value, theme: $('theme').value }); });
$('restore').addEventListener('mousedown', event => event.preventDefault());
$('restore').addEventListener('click', () => {
  const range = selected && mount?.view.restoreRange(selected.anchor);
  if (range) { const native = getSelection(); native.removeAllRanges(); native.addRange(range); }
});
try {
  if (!original) throw new Error('The downloaded page has no article parser-output root.');
  const [data, articles] = await Promise.all([
    fetch('/articles/' + key + '.json').then(response => { if (!response.ok) throw new Error('Run npm run prepare:annotation-pages.'); return response.json(); }),
    fetch('/articles.json').then(response => response.json()),
  ]);
  if (data.revisionId !== revisionId) throw new Error('Page HTML and source revisions do not match.');
  fixture = data;
  for (const article of articles) {
    const option = document.createElement('option'); option.value = article.key; option.textContent = article.title; $('article').append(option);
  }
  $('article').value = key;
  projection = annotation.createProjection(fixture.wikitext);
  setEnabled(new URL(location.href).searchParams.get('view') !== 'original');
  $('toggle').disabled = false;
  window.annotationPageLab = { annotation, fixture, original, projection, setEnabled, setTheme, get mount() { return mount; }, get view() { return mount?.view ?? null; } };
} catch (error) { $('status').textContent = error.message; toolbar.dataset.error = ''; }

window.addEventListener('pagehide', () => mount?.destroy(), { once: true });
