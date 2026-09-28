import test from 'node:test';
import assert from 'node:assert/strict';
import { createProjection, renderToHtml, SourceIndex, selectionFromView, selectionFromSource } from '../../.cache/annotation-rnd/index.mjs';
import { headingAnchors } from './section-anchors.mjs';

const bytes = value => Buffer.byteLength(value, 'utf8');
const anchorFor = (source, selected) => {
  const start = source.indexOf(selected);
  assert.notEqual(start, -1);
  return { unit: 'utf8-byte', start: bytes(source.slice(0, start)), end: bytes(source.slice(0, start + selected.length)) };
};
const choose = (projection, quote) => {
  const start = projection.text.indexOf(quote);
  assert.notEqual(start, -1);
  return selectionFromView(projection, start, start + quote.length);
};

test('heading, paragraph, emphasis and piped links hide only recognized syntax', () => {
  const source = "==背景==\n第一句。第二句含'''重点'''和[[地球半径|平均半径]]。第三句。";
  const view = createProjection(source);
  assert.equal(view.text, '背景\n第一句。第二句含重点和平均半径。第三句。');
  assert.match(renderToHtml(view), /<h2 data-heading-start="0">/);
  assert.match(renderToHtml(view), /<strong>/);
  const selected = choose(view, '半径');
  // The target appears twice in wikitext; the visible label's exact position wins.
  const label = source.lastIndexOf('半径');
  assert.deepEqual(selected.anchor, { unit: 'utf8-byte', start: bytes(source.slice(0, label)), end: bytes(source.slice(0, label + 2)) });
});

test('heading navigation metadata converts API codepoints into exact UTF-8 source starts', () => {
  const source = '前😀\r\n== A &amp; B ==\r\n正文\r\n== A &amp; B ==';
  const starts = [source.indexOf('=='), source.lastIndexOf('== A')];
  const sections = starts.map((start, i) => ({ fromTitle: 'Page_name', codepointOffset: [...source.slice(0, start)].length, hLevel: 2, anchor: i ? 'A_&_B_2' : 'A_&_B' }));
  const anchors = headingAnchors(source, { title: 'Page name', tocdata: { sections: [...sections, { fromTitle: 'Template:Other', codepointOffset: 0, hLevel: 2, anchor: 'Generated' }, { fromTitle: 'Page_name', codepointOffset: null, hLevel: 2, anchor: 'Literal_HTML' }] } });
  assert.deepEqual(anchors, starts.map((start, i) => ({ unit: 'utf8-byte', start: bytes(source.slice(0, start)), level: 2, id: i ? 'A_&_B_2' : 'A_&_B' })));
  const projection = createProjection(source);
  const html = renderToHtml(projection);
  for (const anchor of anchors) assert.ok(html.includes(`data-heading-start="${anchor.start}"`));
  assert.equal(projection.source, source);
  assert.throws(() => headingAnchors(source, { title: 'Page name', tocdata: { sections: [{ ...sections[0], codepointOffset: 9999 }] } }), /outside the source/);
});

test('one sentence inside a long paragraph and repeated phrases get distinct coordinates', () => {
  const source = '第一句相同。第二句用于评注。第三句相同。第四句结束。\n\n第二句用于评注。';
  const view = createProjection(source);
  const first = choose(view, '第二句用于评注。');
  const last = view.text.lastIndexOf('第二句用于评注。');
  const second = selectionFromView(view, last, last + first.quote.length);
  assert.deepEqual(first.anchor, anchorFor(source, first.quote));
  assert.notEqual(first.anchor.start, second.anchor.start);
  assert.equal(selectionFromSource(view, second.anchor).quote, second.quote);
});

test('a selection across hidden markup returns readable quote and an exact enclosing source interval', () => {
  const source = "前'''重点'''与[[页面|标签]]后。";
  const selected = choose(createProjection(source), '重点与标签');
  assert.equal(selected.quote, '重点与标签');
  assert.equal(selected.sourceText, "重点'''与[[页面|标签");
  assert.equal(selected.adjusted, false);
});

test('CRLF is preserved in original coordinates while single line endings display as breaks', () => {
  const source = '甲😀\r\n乙[[頁|標籤]]\r\n\r\n尾';
  const view = createProjection(source);
  assert.equal(view.source, source);
  assert.equal(view.text, '甲😀\n乙標籤\n\n尾');
  assert.deepEqual(choose(view, '標籤').anchor, anchorFor(source, '標籤'));
  assert.deepEqual(choose(view, '尾').anchor, anchorFor(source, '尾'));
});

test('single source breaks stay single across multiline and inline templates, with blank lines marking paragraphs', () => {
  const source = '{{NoteTA\n|G1=unit\n}}\n{{Good article}}\n{{redirect|Earth}}\n\n{{Infobox\n|name=地球\n}}\n结尾';
  const view = createProjection(source);
  assert.equal(view.text, source);
  assert.deepEqual(view.blocks.filter(node => node.kind === 'element').map(node => node.flowBreak ?? null), [null, 'line', 'paragraph', 'line']);
  const selected = choose(view, '{{Good article}}\n{{redirect|Earth}}');
  assert.deepEqual(selected.anchor, anchorFor(source, '{{Good article}}\n{{redirect|Earth}}'));
  assert.equal(selectionFromSource(view, selected.anchor).quote, selected.quote);
  assert.deepEqual(choose(view, '结尾').anchor, anchorFor(source, '结尾'));
});

test('trailing list newlines count once when determining the following paragraph gap', () => {
  for (const [separator, kind] of [['\n', 'line'], ['\r\n\r\n', 'paragraph']]) {
    const source = '* 列表项' + separator + '后文';
    const view = createProjection(source);
    const blocks = view.blocks.filter(node => node.kind === 'element');
    assert.equal(blocks[1].flowBreak, kind);
    assert.equal(view.text, '列表项' + (kind === 'line' ? '\n' : '\n\n') + '后文');
    assert.deepEqual(choose(view, '后文').anchor, anchorFor(source, '后文'));
  }
});

test('decoded entities have atomic source intervals and emoji cannot be split', () => {
  const source = '甲&amp;乙&#x1F600;丙&NotEqualTilde;丁😀';
  const view = createProjection(source);
  assert.equal(view.text, '甲&乙😀丙≂̸丁😀');
  assert.equal(choose(view, '&').sourceText, '&amp;');
  const position = view.text.indexOf('≂̸');
  const half = selectionFromView(view, position + 1, position + 2);
  assert.equal(half.quote, '≂̸');
  assert.equal(half.sourceText, '&NotEqualTilde;');
  assert.equal(half.adjusted, true);
  const emoji = view.text.lastIndexOf('😀');
  const split = selectionFromView(view, emoji + 1, emoji + 2);
  assert.equal(split.quote, '😀');
  assert.equal(split.sourceText, '😀');
  assert.equal(split.adjusted, true);
});

test('coordinate conversion rejects invalid bytes, surrogate halves and invalid anchors', () => {
  const index = new SourceIndex('甲😀\r\n乙');
  assert.equal(index.toByte(3), 7);
  assert.equal(index.toUtf16(7), 3);
  assert.throws(() => index.toByte(2), RangeError);
  assert.throws(() => index.toUtf16(4), RangeError);
  assert.throws(() => index.toByte(99), RangeError);
  assert.throws(() => createProjection('\ud800'), RangeError);
  assert.throws(() => selectionFromSource(createProjection('甲'), { unit: 'utf16', start: 0, end: 1 }), RangeError);
});

test('math remains exact raw code', () => {
  const constructs = [
    '<math>x^2 + y^2</math>',
  ];
  for (const source of constructs) {
    const view = createProjection(source);
    assert.equal(view.fallbacks.length, 1, source);
    assert.equal(view.text, source);
    assert.match(renderToHtml(view), /<(?:pre|code) data-raw-kind=/);
    assert.deepEqual(choose(view, source).anchor, { unit: 'utf8-byte', start: 0, end: bytes(source) });
  }
});

test('inline source remains within its sentence without synthetic block separators', () => {
  const source = '前文{{t|内容}}及<math>x</math><ref>引用</ref>后文。';
  const view = createProjection(source);
  assert.equal(view.text, '前文{{t|内容}}及<math>x</math>[1]后文。');
  assert.doesNotMatch(renderToHtml(view), /<pre|<div/);
  assert.equal(choose(view, '内容').sourceText, '内容');
  assert.equal(choose(view, view.text).sourceText, source);
});

test('template text formats links and emphasis while retaining template syntax and exact coordinates', () => {
  const source = "前{{例|text='''重点'''与[[页面|标签]]|nested={{内|😀}}}}后";
  const view = createProjection(source);
  assert.equal(view.text, '前{{例|text=重点与标签|nested={{内|😀}}}}后');
  assert.match(renderToHtml(view), /<strong>/);
  assert.match(renderToHtml(view), /<a data-target-url=/);
  assert.equal((renderToHtml(view).match(/data-template/g) ?? []).length, 2);
  assert.equal(choose(view, '重点与标签').sourceText, "重点'''与[[页面|标签");
  assert.deepEqual(choose(view, '标签').anchor, anchorFor(source, '标签'));
  assert.equal(choose(view, view.text).sourceText, source);
});

test('nowiki protects only its own text inside templates, including apparent closing braces', () => {
  const source = "{{外|<nowiki>}}[[原样]]'''原样'''{{内}}</nowiki>|[[页面|标签]]}}";
  const view = createProjection(source);
  assert.equal(view.text, "{{外|}}[[原样]]'''原样'''{{内}}|标签}}");
  const html = renderToHtml(view);
  assert.equal((html.match(/data-template/g) ?? []).length, 1);
  assert.equal((html.match(/<a /g) ?? []).length, 1);
  assert.doesNotMatch(html, /<strong>/);
  assert.deepEqual(choose(view, '[[原样]]').anchor, anchorFor(source, '[[原样]]'));
  assert.deepEqual(choose(view, '标签').anchor, anchorFor(source, '标签'));
});

test('multiline templates preserve source line breaks while formatting their text', () => {
  const source = "{{例\r\n|a='''重点'''\r\n|b=[[页|标签]]\r\n}}\n\n后文";
  const view = createProjection(source);
  assert.equal(view.text, '{{例\r\n|a=重点\r\n|b=标签\r\n}}\n\n后文');
  assert.match(renderToHtml(view), /<div data-template=/);
  assert.deepEqual(choose(view, '标签').anchor, anchorFor(source, '标签'));
  assert.deepEqual(choose(view, '后文').anchor, anchorFor(source, '后文'));
  // An inner template closing does not make an unclosed outer template complete.
  assert.equal(createProjection('{{outer|{{inner}}').fallbacks[0].reason, 'unclosed-template');
});

test('tsl and translink use their documented target and display defaults', () => {
  const cases = [
    ['{{tsl|en|MooTools}}', 'MooTools', 'MooTools'],
    ['{{tsl|en|Water|水}}', '水', 'Water'],
    ['{{tsl|en|Water|水|一氧化二氢}}', '一氧化二氢', 'Water'],
    ['{{Translink|en|pr (Unix)||pr}}', 'pr', 'pr_(Unix)'],
    ['{{tsl|en|Water|水|}}', '水', 'Water'],
  ];
  for (const [source, label, target] of cases) {
    const view = createProjection('前' + source + '后');
    assert.equal(view.text, '前' + label + '后');
    assert.match(renderToHtml(view), new RegExp(`data-target-url="https://en.wikipedia.org/wiki/${encodeURIComponent(target).replace(/[()]/g, '\\$&')}"`));
    assert.equal(choose(view, label).sourceText, label);
    assert.equal(choose(view, view.text).sourceText, '前' + source + '后');
  }
});

test('language link helpers and verified short aliases honor display parameters', () => {
  for (const name of ['link-en', 'link-ja', 'link-zh-yue', 'le', 'lj', 'ld', 'lk', 'lvi', 'ly', 'Template:Link-en']) {
    const source = `{{${name}|页面|Foreign page|显示文字}}`;
    const view = createProjection(source);
    assert.equal(view.text, '显示文字');
    assert.match(renderToHtml(view), /data-target-url="https:\/\/zh.wikipedia.org\/wiki\/%E9%A1%B5%E9%9D%A2"/);
    assert.deepEqual(choose(view, view.text).anchor, anchorFor(source, '显示文字'));
  }
  const source = '{{le|页面|Foreign|忽略|d=显示}}';
  assert.equal(createProjection(source).text, '显示');
  assert.equal(createProjection('{{le|页面|Foreign|忽略|d=}}').text, '页面');
  assert.equal(createProjection('{{link-en|页面}}').text, '页面');
});

test('numbered arguments, whitespace and repeated labels preserve the chosen parameter position', () => {
  const source = '😀{{tsl\r\n|4= 标签 \r\n|2=标签\r\n|1=en\r\n|3=页面\r\n}}后';
  const view = createProjection(source);
  assert.equal(view.text, '😀标签后');
  assert.deepEqual(choose(view, '标签').anchor, anchorFor(source, '标签'));
  const repeated = '{{le|标签|Foreign|标签}}';
  const selected = choose(createProjection(repeated), '标签');
  const last = repeated.lastIndexOf('标签');
  assert.deepEqual(selected.anchor, { unit: 'utf8-byte', start: bytes(repeated.slice(0, last)), end: bytes(repeated.slice(0, last + 2)) });
});

test('link template labels format text and protect nowiki delimiters without losing anchors', () => {
  const source = "甲{{tsl|en|Water|水|'''重点'''<nowiki>|=}}</nowiki>&amp;😀}}乙";
  const view = createProjection(source);
  assert.equal(view.text, '甲重点|=}}&😀乙');
  assert.match(renderToHtml(view), /<a [^>]+><strong>/);
  assert.deepEqual(choose(view, '|=}}').anchor, anchorFor(source, '|=}}'));
  assert.equal(choose(view, '&').sourceText, '&amp;');
  const nested = createProjection('{{例|{{tsl|en|Water|水}}}}');
  assert.equal(nested.text, '{{例|水}}');
  assert.equal(createProjection('<nowiki>{{tsl|en|Water|水}}</nowiki>').text, '{{tsl|en|Water|水}}');
});

test('whole-link source anchors include hidden syntax while label text keeps its narrower anchor', () => {
  for (const snippet of ['[[页面|标签]]', '{{tsl|en|Water|水|标签}}', '[https://example.org 标签]']) {
    const source = '前' + snippet + '后';
    const view = createProjection(source);
    const full = selectionFromSource(view, anchorFor(source, snippet));
    assert.equal(full.quote, '标签');
    assert.equal(full.sourceText, snippet);
    assert.equal(full.adjusted, false);
    assert.equal(choose(view, '标签').sourceText, '标签');
  }
});

test('numbered, bare, relative and protocol-specific external links retain exact source slices', () => {
  const source = '前[https://example.org] [https://example.org Label] https://example.org/path. [//example.org Relative] [mailto:a@example.org Email] [ftp://example.org/file]后';
  const view = createProjection(source);
  assert.equal(view.text, '前[1] Label https://example.org/path. Relative Email [2]后');
  assert.equal(choose(view, '[1]').sourceText, '[https://example.org]');
  assert.equal(choose(view, '[2]').sourceText, '[ftp://example.org/file]');
  assert.deepEqual(choose(view, 'Email').anchor, anchorFor(source, 'Email'));
  assert.equal(selectionFromSource(view, anchorFor(source, '[//example.org Relative]')).sourceText, '[//example.org Relative]');
  assert.equal(createProjection('<nowiki>https://example.org</nowiki>').runs.length, 1);
  assert.doesNotMatch(renderToHtml(createProjection('[javascript:alert(1) label]')), /data-inspect="link"/);
});

test('empty pipe tricks remain source because the revision parser does not perform save-time expansion', () => {
  const source = '[[Help:Page|]] [[Page (topic)|]]';
  assert.equal(createProjection(source).text, source);
});

test('unrecognized templates and unresolved targets keep their source presentation', () => {
  for (const source of ['{{lang-en|Water}}', '{{legend|red|水}}', '{{longitem|水}}', '{{lc|水|Water}}', '{{link-wd|水|Q283}}', '{{link-wikidata|水|Q283}}', '{{tsl|en}}', '{{tsl|en|Water|水|显示|unknown=说明}}', '{{tsl|en|{{未知|水}}|水}}']) {
    assert.equal(createProjection(source).text, source);
  }
  // Nested links would produce invalid HTML; retain the template form instead.
  const view = createProjection('{{tsl|en|Water|水|[[页面|标签]]}}');
  assert.equal(view.text, '{{tsl|en|Water|水|标签}}');
  assert.equal((renderToHtml(view).match(/<a /g) ?? []).length, 1);
});

test('literal closing markers inside protected syntax do not prematurely terminate constructs', () => {
  const table = '{|\n<!-- |} is not the end -->\n| <nowiki>|}</nowiki>\n|}';
  assert.equal(createProjection(table).fallbacks.length, 1);
  assert.equal(createProjection(table).text, '{|\n<!-- |} is not the end -->\n| |}\n|}');
  assert.equal(choose(createProjection(table), createProjection(table).text).sourceText, table);
  const link = '[[页面|甲<nowiki>]]</nowiki>乙]]';
  assert.equal(createProjection(link).text, '甲]]乙');
  const conversion = '-{zh-hans:甲<!-- }- -->;zh-hant:乙}-';
  assert.equal(createProjection(conversion).fallbacks[0].reason, 'comment');
  assert.equal(createProjection(conversion).text, conversion);
});

test('a conversion flag inside a table is not mistaken for a nested table opener', () => {
  const table = '{| class="wikitable"\n| -{|zh-hans:甲;zh-hant:乙}-\n|}';
  const source = table + '\n\n后文保持可选。';
  const view = createProjection(source);
  assert.deepEqual(view.fallbacks, []);
  assert.match(renderToHtml(view), /data-source-kind="conversion"/);
  assert.equal(view.text, table + '\n\n后文保持可选。');
  assert.deepEqual(choose(view, '后文保持可选。').anchor, anchorFor(source, '后文保持可选。'));
});

test('conversion blocks parse inline content and both file captions while preserving variant syntax', () => {
  const source = '-{|zh-hans:[[File:A.svg|thumb|甲[[页|标签]]]];zh-hant:[[File:B.svg|thumb|乙[[頁|標籤]]]]}-';
  const view = createProjection(source);
  assert.equal(view.text, '-{|zh-hans:[[File:A.svg|thumb|甲标签]];zh-hant:[[File:B.svg|thumb|乙標籤]]}-');
  assert.equal((renderToHtml(view).match(/data-file-caption/g) ?? []).length, 2);
  assert.deepEqual(choose(view, '标签').anchor, anchorFor(source, '标签'));
  assert.deepEqual(choose(view, '標籤').anchor, anchorFor(source, '標籤'));
  assert.equal(choose(view, view.text).sourceText, source);
  const multiline = '-{zh-hans:[[页|甲]];\nzh-hant:[[頁|乙]]\n;zh-hk:[[頁|丙]]}-';
  assert.equal(createProjection(multiline).text, '-{zh-hans:甲;\nzh-hant:乙\n;zh-hk:丙}-');
  assert.doesNotMatch(renderToHtml(createProjection(multiline)), /<dl>/);
});

test('conversion boundaries respect protected text and nested source, with unclosed input kept raw', () => {
  const source = '-{zh-hans:{{例|<nowiki>}-</nowiki>}};zh-hant:乙}-';
  const view = createProjection(source);
  assert.equal(view.text, '-{zh-hans:{{例|}-}};zh-hant:乙}-');
  assert.equal(choose(view, view.text).sourceText, source);
  assert.equal(createProjection('-{zh-hans:甲').fallbacks[0].reason, 'unclosed-language-conversion');
  assert.equal(createProjection('<nowiki>-{zh-hans:[[页]]}-</nowiki>').text, '-{zh-hans:[[页]]}-');
});

test('reference names and numbers are atomic markers covering their exact source', () => {
  const refs = ['<ref>匿名😀</ref>', '<ref name="a&amp;b">内容</ref>', '<ref name=a/>', '<ref>第二条</ref>'];
  const source = '前' + refs.join('与') + '后';
  const view = createProjection(source);
  assert.equal(view.text, '前[1]与[a&b]与[a]与[2]后');
  for (const [index, label] of ['[1]', '[a&b]', '[a]', '[2]'].entries()) {
    const selected = choose(view, label);
    assert.equal(selected.sourceText, refs[index]);
    assert.deepEqual(selected.anchor, anchorFor(source, refs[index]));
    assert.equal(selectionFromSource(view, selected.anchor).quote, label);
  }
  const partial = choose(view, 'a&b');
  assert.equal(partial.quote, '[a&b]');
  assert.equal(partial.adjusted, true);
  assert.deepEqual(choose(view, '后').anchor, anchorFor(source, '后'));
});

test('reference definitions collapse in references containers and template refs parameters', () => {
  const source = '<references><ref name="a">A</ref><ref name="b">B</ref></references>\n\n{{reflist|refs=<ref name=c>C</ref>}}';
  const view = createProjection(source);
  assert.equal(view.text, '<references>[a][b]</references>\n\n{{reflist|refs=[c]}}');
  assert.equal(choose(view, '[b]').sourceText, '<ref name="b">B</ref>');
  assert.equal(choose(view, '[c]').sourceText, '<ref name=c>C</ref>');
  const literal = '<ref><nowiki></ref></nowiki>真实内容</ref>';
  assert.equal(createProjection(literal).text, '[1]');
  assert.equal(choose(createProjection(literal), '[1]').sourceText, literal);
  assert.equal(createProjection('<nowiki><ref>原样</ref></nowiki>').text, '<ref>原样</ref>');
});

test('r templates collapse named references and keep a multi-reference invocation atomic', () => {
  const templates = ['{{r|黄龙篇}}', '{{r|大众标准化|谢富来}}', '{{ R |1=甲&amp;乙|2=乙😀}}'];
  const source = '前' + templates.join('与') + '<ref>匿名</ref>后';
  const view = createProjection(source);
  assert.equal(view.text, '前[黄龙篇]与[大众标准化][谢富来]与[甲&乙][乙😀][1]后');
  for (const [index, label] of ['[黄龙篇]', '[大众标准化][谢富来]', '[甲&乙][乙😀]'].entries()) {
    const selected = choose(view, label);
    assert.deepEqual(selected.anchor, anchorFor(source, templates[index]));
    assert.equal(selected.sourceText, templates[index]);
    assert.equal(selectionFromSource(view, selected.anchor).quote, label);
  }
  const partial = choose(view, '谢富来');
  assert.equal(partial.quote, '[大众标准化][谢富来]');
  assert.equal(partial.adjusted, true);
  assert.deepEqual(partial.anchor, anchorFor(source, templates[1]));
  assert.deepEqual(choose(view, '后').anchor, anchorFor(source, '后'));
});

test('r template names, explicit indices, groups and page aliases preserve the whole source', () => {
  const cases = [
    ['{{模板:R|书一|书二|group=注|page1=20|page2=5–12}}', '[书一]:20[书二]:5–12'],
    ['{{Template:r|2=乙|1=甲|grp=n|pp=2–3}}', '[甲]:2–3[乙]'],
    ['{{r|甲|乙|g=n|1p=5|2pp=8–9}}', '[甲]:5[乙]:8–9'],
    ['{{r|甲|name=替代|name1=首选|n2=乙|p1=6|pages2=7–8}}', '[首选]:6[乙]:7–8'],
    ['{{r|1=旧|1=新|p=9}}', '[新]:9'],
    ['{{r|甲|}}', '[甲]'],
    ['{{r|n=甲|p=封面}}', '[甲]:封面'],
    ['{{r|a|b|c|d|e|f|g|h|i}}', '[a][b][c][d][e][f][g][h][i]'],
  ];
  for (const [source, expected] of cases) {
    const view = createProjection(source);
    assert.equal(view.text, expected, source);
    assert.equal(choose(view, expected).sourceText, source);
    assert.deepEqual(choose(view, expected).anchor, anchorFor(source, source));
  }
});

test('unsupported r forms remain source-visible and nowiki prevents r interpretation', () => {
  for (const source of ['{{r}}', '{{r|}}', '{{r|2=乙}}', '{{r|甲||丙}}', '{{r|甲|未知=乙}}', '{{r|{{名字|甲}}}}', '{{r|甲|page={{页码|1}}}}', '{{r|甲|p=1|pp=2}}', '{{r|甲|乙|丙|丁|戊|己|庚|辛|壬|癸}}', '{{r|甲|quote=引文}}', '{{r|甲']) {
    assert.ok(createProjection(source).text.startsWith('{{r'), source);
    assert.doesNotMatch(renderToHtml(createProjection(source)), /data-inspect="reference"/, source);
  }
  assert.equal(createProjection('<nowiki>{{r|甲|乙}}</nowiki>').text, '{{r|甲|乙}}');
  const source = '{{外|text={{r|甲}}}}\n\n{|\n|{{r|乙}}\n|}\n\n[[File:A.png|thumb|说明{{r|丙}}]]';
  const view = createProjection(source);
  for (const name of ['甲', '乙', '丙']) assert.equal(choose(view, `[${name}]`).sourceText, `{{r|${name}}}`);
});

test('rp locators and verified Page/RP aliases preserve source and do not allocate reference numbers', () => {
  const cases = [
    ['{{rp|51}}', ':51'],
    ['{{RP|60–61}}', ':60–61'],
    ['{{Page|8, 31}}', ':8, 31'],
    ['{{模板:Page|page=156}}', ':156'],
    ['{{Template:Rp|pp=12–15|loc=§8.5}}', ':12–15, §8.5'],
    ['{{rp|at=书脊}}', ':书脊'],
    ['{{rp|pages=12–15|p=13}}', ':12–15, [13]'],
    ['{{rp|p=25|style=AMA}}', '(p. 25)'],
    ['{{rp|pp=25–26|style=ama|nopp=yes}}', '(25–26)'],
    ['{{rp|1=8|1=9|quote=原句}}', ':9'],
  ];
  for (const [invocation, label] of cases) {
    const source = '<ref>一</ref>' + invocation + '<ref>二</ref>';
    const view = createProjection(source);
    assert.equal(view.text, '[1]' + label + '[2]');
    const selected = choose(view, label);
    assert.deepEqual(selected.anchor, anchorFor(source, invocation));
    assert.equal(selected.sourceText, invocation);
    assert.equal(selectionFromSource(view, selected.anchor).quote, label);
  }
});

test('sfn and its verified alias display an atomic short citation with source-backed authors and locators', () => {
  const cases = [
    ['{{sfn|Smith|2006|p=25}}', '[Smith 2006:25]'],
    ['{{Sfn|Smith|Jones|Brown|Black|2006|pp=25–26}}', '[Smith Jones Brown Black 2006:25–26]'],
    ['{{Shortened footnote template|Wallace|1993a|loc=§8.5}}', '[Wallace 1993a:§8.5]'],
    ['{{模板:Shortened_footnote_template|张|2006|page=42}}', '[张 2006:42]'],
    ['{{sfn|1=Smith|2=2006|p=25|pages=25–27|loc=Fig. 2|ref=none|ps=Additional comment}}', '[Smith 2006:25, Fig. 2]'],
    ['{{sfn|机构&amp;作者|n.d.|postscript=none}}', '[机构&作者 n.d.]'],
  ];
  for (const [source, label] of cases) {
    const view = createProjection(source);
    assert.equal(view.text, label);
    assert.deepEqual(choose(view, label).anchor, anchorFor(source, source));
    const partial = choose(view, label.slice(1, -1));
    assert.equal(partial.sourceText, source);
    assert.equal(partial.quote, label);
    assert.equal(partial.adjusted, true);
  }
  for (const source of ['{{rp}}', '{{rp|}}', '{{rp|needed=1}}', '{{rp|{{页码}}}}', '{{sfn|}}', '{{sfn|Smith||2006}}', '{{sfn|Smith|2006|p={{page}}}}', '{{sfnref|Smith|2006}}', '{{sfnp|Smith|2006}}']) {
    assert.ok(createProjection(source).text.startsWith('{{'), source);
    assert.doesNotMatch(renderToHtml(createProjection(source)), /data-inspect="reference"/, source);
  }
  assert.equal(createProjection('<nowiki>{{rp|51}}{{sfn|Smith|2006}}</nowiki>').text, '{{rp|51}}{{sfn|Smith|2006}}');
});

test('file captions render links, emphasis and references while options remain source', () => {
  const source = "前[[File:A.png|thumb|alt=[[Raw|alt text]]|A '''bold''' [[Earth|planet]]<ref name=r>{{cite|title=Title|url=https://example.org}}</ref>|right|200px]]后";
  const view = createProjection(source);
  assert.equal(view.text, '前[[File:A.png|thumb|alt=[[Raw|alt text]]|A bold planet[r]|right|200px]]后');
  assert.deepEqual(choose(view, 'planet').anchor, anchorFor(source, 'planet'));
  assert.deepEqual(choose(view, 'bold').anchor, anchorFor(source, 'bold'));
  assert.equal(choose(view, '[r]').sourceText, '<ref name=r>{{cite|title=Title|url=https://example.org}}</ref>');
  assert.equal(choose(view, view.text).sourceText, source);
  assert.match(renderToHtml(view), /data-file-caption/);
  assert.match(renderToHtml(view), /<strong>/);
  assert.equal((renderToHtml(view).match(/data-inspect="link"/g) ?? []).length, 1);
});

test('caption detection uses top-level fields and the last non-option, including Chinese aliases', () => {
  const source = '[[文件:A.png|縮圖|第一個[[旧頁|旧标签]]|<nowiki>literal|pipe</nowiki>与{{tsl|en|Earth|地球}}|置中|替代=原样|250像素]]';
  const view = createProjection(source);
  assert.equal(view.text, '[[文件:A.png|縮圖|第一個[[旧頁|旧标签]]|literal|pipe与地球|置中|替代=原样|250像素]]');
  assert.deepEqual(choose(view, 'literal|pipe').anchor, anchorFor(source, 'literal|pipe'));
  assert.deepEqual(choose(view, '地球').anchor, anchorFor(source, '地球'));
  assert.equal(choose(view, view.text).sourceText, source);
  for (const source of ['[[File:A.png|thumb|alt=[[页|保持原样]]]]', '[[File:A.png|thumb|link=https://example.org|200px]]', '[[File:A.png|thumb|[[页|old caption]]|]]']) {
    assert.equal(createProjection(source).text, source);
    assert.doesNotMatch(renderToHtml(createProjection(source)), /data-file-caption/);
  }
});

test('caption delimiters inside protected source are not field boundaries, and block captions retain source', () => {
  const source = '[[File:A.png|thumb|<nowiki>]]|</nowiki>[[页|标签]]]]';
  const view = createProjection(source);
  assert.equal(view.text, '[[File:A.png|thumb|]]|标签]]');
  assert.deepEqual(choose(view, '标签').anchor, anchorFor(source, '标签'));
  const raw = '[[File:A.png|thumb|<div>[[页|标签]]</div>]]';
  assert.equal(createProjection(raw).text, raw);
});

test('table source retains structure while parsing cell links, emphasis, references and nested tables', () => {
  const source = "{| class=wikitable\r\n! 列\r\n|-\r\n| '''重点''' || [[页面|标签]]<ref name=r>引用</ref>\r\n|\r\n{|\r\n| {{tsl|en|Water|水}}\r\n|}\r\n|}";
  const view = createProjection(source);
  assert.equal(view.text, '{| class=wikitable\r\n! 列\r\n|-\r\n| 重点 || 标签[r]\r\n|\r\n{|\r\n| 水\r\n|}\r\n|}');
  assert.match(renderToHtml(view), /<strong>/);
  assert.deepEqual(choose(view, '标签').anchor, anchorFor(source, '标签'));
  assert.equal(choose(view, '[r]').sourceText, '<ref name=r>引用</ref>');
  assert.equal(choose(view, view.text).sourceText, source);
  const htmlTable = '<table class="x"><tr><td>[[页|字]]<ref>引用</ref></td></tr></table>';
  assert.equal(createProjection(htmlTable).text, '<table class="x"><tr><td>字[1]</td></tr></table>');
});

test('nowiki, superscripts and escaped characters preserve meaningful content', () => {
  const view = createProjection('面积 m<sup>2</sup>，<nowiki>[[原样]] &amp;</nowiki>。');
  assert.equal(view.text, '面积 m2，[[原样]] &。');
  assert.match(renderToHtml(view), /<sup>/);
  assert.equal(choose(view, '2').sourceText, '2');
  assert.equal(choose(view, '[[原样]]').sourceText, '[[原样]]');
});

test('semantic HTML formatting retains text positions while generic span and div remain source', () => {
  const source = '前<small>小字</small><u>下划线</u><del>删除</del><ins>加入</ins>后';
  const view = createProjection(source);
  assert.equal(view.text, '前小字下划线删除加入后');
  for (const selected of ['小字', '下划线', '删除', '加入']) assert.deepEqual(choose(view, selected).anchor, anchorFor(source, selected));
  assert.match(renderToHtml(view), /<small>/);
  const untouched = '<span style="font-size:smaller">[[页面|标签]]</span>\n\n<div>[[页面|标签]]</div>';
  assert.equal(createProjection(untouched).text, untouched);
});

test('horizontal rules and grouped preformatted lines preserve source coverage and formatting', () => {
  const source = "前文\n----\n后文\n\n code '''bold'''\r\n next &amp;\r\n\r\n尾文";
  const view = createProjection(source);
  assert.equal(view.text, '前文\n后文\n\ncode bold\r\nnext &\r\n\n尾文');
  assert.match(renderToHtml(view), /<hr\b/);
  assert.equal((renderToHtml(view).match(/<pre\b/g) ?? []).length, 1);
  assert.deepEqual(choose(view, 'bold').anchor, anchorFor(source, 'bold'));
  assert.deepEqual(choose(view, '尾文').anchor, anchorFor(source, '尾文'));
});

test('blockquotes, literal pre blocks and empty nowiki preserve original source coordinates', () => {
  const source = "<blockquote>第一段。\n\n第二段含[[页|标签]]。</blockquote>\n\n<pre>'''literal''' &amp;</pre>\n\n甲<nowiki/>乙";
  const view = createProjection(source);
  assert.match(renderToHtml(view), /<blockquote><p>/);
  assert.ok(view.text.startsWith('第一段。\n\n第二段含标签。'));
  assert.ok(view.text.includes("'''literal''' &"));
  assert.deepEqual(choose(view, '标签').anchor, anchorFor(source, '标签'));
  assert.equal(choose(view, '甲乙').sourceText, '甲<nowiki/>乙');
});

test('nested lists preserve hierarchy, readable separators and exact source positions', () => {
  const source = "* 第一项\r\n** 子项[[页面|标签]]\r\n*** 第三级😀\r\n** 第二子项\r\n* 第二项\r\n\r\n# 编号\r\n## 嵌套编号";
  const view = createProjection(source);
  assert.match(renderToHtml(view), /<ul><li>/);
  assert.match(renderToHtml(view), /<ol><li>/);
  assert.equal(view.text, '第一项\n子项标签\n第三级😀\n第二子项\n第二项\n\n编号\n嵌套编号');
  assert.equal(view.fallbacks.length, 0);
  assert.deepEqual(choose(view, '第三级😀').anchor, anchorFor(source, '第三级😀'));
  assert.deepEqual(choose(view, '标签').anchor, anchorFor(source, '标签'));
  assert.equal(choose(view, '第二项').sourceText, '第二项');
  assert.equal(choose(view, '第一项\n子项标签').sourceText, '第一项\r\n** 子项[[页面|标签');
});

test('list type changes and shallower siblings keep children under the correct parent', () => {
  const source = '* 父项\n** 子项\n*# 编号子项\n* 第二父项\n** 第二子项\n# 新编号列表\n#* 子项目';
  const view = createProjection(source);
  const roots = view.blocks.filter(node => node.kind === 'element');
  assert.deepEqual(roots.map(node => node.tag), ['ul', 'ol']);
  assert.deepEqual(roots[0].children.map(node => node.tag), ['li', 'li']);
  assert.deepEqual(roots[0].children[0].children.filter(node => node.kind === 'element').map(node => node.tag), ['ul', 'ol']);
  assert.equal(view.text, '父项\n子项\n编号子项\n第二父项\n第二子项\n新编号列表\n子项目');
  assert.equal(view.fallbacks.length, 0);
});

test('leading and skipped list levels create containing items without consuming following prose', () => {
  for (const source of ['** 无父项\n\n后文', '* 父项\n*** 跳级\n\n后文']) {
    const view = createProjection(source);
    assert.equal(view.fallbacks.length, 0);
    assert.deepEqual(choose(view, '后文').anchor, anchorFor(source, '后文'));
    assert.ok(!view.text.includes('*'));
  }
});

test('all four list markers combine with source-mapped definition terms and indentation', () => {
  const source = '# 编号\r\n#* 项目\r\n#*# 编号子项\r\n#*#* 深层\r\n#*#*; [[Help:Page|术语]] : 定义😀\r\n#*#*: 第二个定义\r\n\r\n:: 缩进';
  const view = createProjection(source);
  assert.equal(view.fallbacks.length, 0);
  assert.equal(view.text, '编号\n项目\n编号子项\n深层\n术语\n定义😀\n第二个定义\n\n缩进');
  assert.deepEqual(choose(view, '术语').anchor, anchorFor(source, '术语'));
  assert.deepEqual(choose(view, '定义😀').anchor, anchorFor(source, '定义😀'));
  assert.deepEqual(choose(view, '缩进').anchor, anchorFor(source, '缩进'));
  assert.match(renderToHtml(view), /<dl><dt>/);
  assert.match(renderToHtml(view), /<dd>/);
});

test('list syntax inside template and table source is parsed without losing surrounding source newlines', () => {
  const source = '{{flatlist|\n* First\n** [[页|Child]]\n* Last\n}}\n\n{|\n|\n# Number\n#: Detail\n|}';
  const view = createProjection(source);
  assert.equal(view.text, '{{flatlist|\nFirst\nChild\nLast\n}}\n\n{|\n|\nNumber\nDetail\n|}');
  assert.match(renderToHtml(view), /data-template=""[^>]*>[\s\S]*<ul>/);
  assert.deepEqual(choose(view, 'Child').anchor, anchorFor(source, 'Child'));
  assert.equal(choose(view, view.text).sourceText, source);
});

test('definition separators skip protected colons and list line breaks remain source-mapped', () => {
  const source = '; [https://example.org A:B] <nowiki>C:D</nowiki> : 说明\n: 第一行<br />第二行';
  const view = createProjection(source);
  assert.equal(view.text, 'A:B C:D\n说明\n第一行\n第二行');
  assert.deepEqual(choose(view, 'C:D').anchor, anchorFor(source, 'C:D'));
  assert.deepEqual(choose(view, '第二行').anchor, anchorFor(source, '第二行'));
  assert.equal(choose(view, '第一行\n第二行').sourceText, '第一行<br />第二行');
});

test('source is inert, even when it contains scripts, malicious attributes or unsafe links', () => {
  const source = '<script>window.pwned=1</script>\n<img src=x onerror="alert(1)">\n[javascript:alert(1) text]';
  const html = renderToHtml(createProjection(source));
  assert.doesNotMatch(html, /<script>|<img |href="javascript:/);
  assert.match(html, /&lt;script&gt;/);
  assert.throws(() => createProjection('text', { wikiBaseUrl: 'javascript:alert(1)' }), TypeError);
});

test('unsupported and unclosed constructs keep every original character', () => {
  for (const source of ['前{{未闭合\n\n后', "''未闭合", '[[未闭合', '<math>未闭合', '{|\n未闭合', '-{未闭合', '<!--未闭合']) {
    const view = createProjection(source);
    assert.equal(view.source, source);
    assert.ok(view.fallbacks.length > 0, source);
    assert.equal(choose(view, view.text).sourceText, source);
  }
});

test('hidden-only anchors and virtual separators have no fabricated text target', () => {
  const view = createProjection("'''词'''\n\n下一段");
  assert.equal(selectionFromSource(view, { unit: 'utf8-byte', start: 0, end: 3 }), null);
  assert.equal(selectionFromView(view, 1, 3), null);
});

test('all selectable Unicode scalar spans restore deterministically without altering source', () => {
  const source = "==标题==\r\n甲😀与'''乙'''、[[頁|标籤]] &amp;。\n\n<math>x</math>";
  const view = createProjection(source);
  let at = 0;
  for (const scalar of view.text) {
    const selection = selectionFromView(view, at, at + scalar.length);
    if (selection) {
      const restored = selectionFromSource(view, selection.anchor);
      assert.deepEqual(restored.anchor, selection.anchor);
      assert.equal(restored.quote, selection.quote);
    }
    at += scalar.length;
  }
  assert.equal(view.source, source);
  assert.ok(Object.isFrozen(view) && Object.isFrozen(view.runs[0]));
});
