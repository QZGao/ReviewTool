// List structures captured from MediaWiki action=parse for these synthetic inputs.
// See https://www.mediawiki.org/wiki/Help:Lists.
export const listCases = [
  {
    "name": "deep",
    "source": "#*#* Deep",
    "html": "<ol><li><ul><li><ol><li><ul><li>Deep</li></ul></li></ol></li></ul></li></ol>"
  },
  {
    "name": "jump",
    "source": "* A\n*** C\n* D",
    "html": "<ul><li>A\n<ul><li><ul><li>C</li></ul></li></ul></li>\n<li>D</li></ul>"
  },
  {
    "name": "mixed",
    "source": "# A\n#* B\n#*# C\n#*#* D",
    "html": "<ol><li>A\n<ul><li>B\n<ol><li>C\n<ul><li>D</li></ul></li></ol></li></ul></li></ol>"
  },
  {
    "name": "definition",
    "source": "; Term : Definition\n:; Subterm\n:: Subdefinition\n; Next\n: Last",
    "html": "<dl><dt>Term</dt>\n<dd>Definition\n<dl><dt>Subterm</dt>\n<dd>Subdefinition</dd></dl></dd></dl><dl><dt>Next</dt>\n<dd>Last</dd></dl>"
  },
  {
    "name": "indent",
    "source": ":# One\n:# Two\n:: More\n: End",
    "html": "<dl><dd><ol><li>One</li>\n<li>Two</li></ol>\n<dl><dd>More</dd></dl></dd>\n<dd>End</dd></dl>"
  },
  {
    "name": "parentSwitch",
    "source": ";* term child\n:* definition child",
    "html": "<dl><dt><ul><li>term child</li>\n<li>definition child</li></ul></dt></dl>"
  },
  {
    "name": "empty",
    "source": "*\n** Child\n* Next",
    "html": "<ul><li>\n<ul><li>Child</li></ul></li>\n<li>Next</li></ul>"
  },
  {
    "name": "semicolonRun",
    "source": ";; Nested term\n:: Nested definition",
    "html": "<dl><dt><dl><dt>Nested term</dt>\n<dd>Nested definition</dd></dl></dt></dl>"
  },
  {
    "name": "flat",
    "source": "; A\n: B\n; C\n: D",
    "html": "<dl><dt>A</dt>\n<dd>B</dd>\n<dt>C</dt>\n<dd>D</dd></dl>"
  },
  {
    "name": "nestedThenTerm",
    "source": ": A\n:: B\n; C",
    "html": "<dl><dd>A\n<dl><dd>B</dd></dl></dd></dl><dl><dt>C</dt></dl>"
  },
  {
    "name": "nestedSameParent",
    "source": "; A\n;: B\n; C",
    "html": "<dl><dt>A</dt></dl><dl><dt><dl><dd>B</dd></dl></dt></dl><dl><dt>C</dt></dl>"
  },
  {
    "name": "sameDepthSwitch",
    "source": ";; A\n:: B",
    "html": "<dl><dt><dl><dt>A</dt>\n<dd>B</dd></dl></dt></dl>"
  },
  {
    "name": "externalTerm",
    "source": "; [https://example.org A:B] : definition",
    "html": "<dl><dt><a rel=\"nofollow\" class=\"external text\" href=\"https://example.org\">A:B</a></dt>\n<dd>definition</dd></dl>"
  },
  {
    "name": "literalTerm",
    "source": "; <nowiki>A:B</nowiki> : definition",
    "html": "<dl><dt>A:B</dt>\n<dd>definition</dd></dl>"
  },
  {
    "name": "urlTerm",
    "source": "; https://example.org : definition",
    "html": "<dl><dt><a rel=\"nofollow\" class=\"external free\" href=\"https://example.org\">https://example.org</a></dt>\n<dd>definition</dd></dl>"
  },
  {
    "name": "colonSpacing",
    "source": "; A: B:C\n;D:E",
    "html": "<dl><dt>A</dt>\n<dd>B:C</dd>\n<dt>D</dt>\n<dd>E</dd></dl>"
  },
  {
    "name": "lineBreak",
    "source": "* A<br>B\n*: C\n* D",
    "html": "<ul><li>A<br>B\n<dl><dd>C</dd></dl></li>\n<li>D</li></ul>"
  }
];
