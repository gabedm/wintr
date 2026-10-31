import { defaultTreeAdapter as tree, html, parse, type DefaultTreeAdapterTypes as T } from 'parse5';
import { describe, expect, it } from 'vitest';
import { sanitizeSuggestions, SUGGESTIONS_CSP, suggestionsDocument } from '../src/server/catalogue-format.js';
import { validateSuggestionImage, validateSuggestionLink } from '../src/server/destinations.js';
import { SUGGESTIONS_LIMITS } from '../src/server/suggestions-html.js';

// Search Suggestions sanitiser evidence. Every unit here is invented; nothing is
// copied from a real provider response. Results are judged on the DOM obtained by
// parsing the exact served document with a WHATWG parser and scripting disabled
// (as in the CSP sandbox), not on serializer-specific strings. That parser is a
// model of the browser, not a browser: real-browser reproduction stays separate.

const { NS } = html;
const GOOGLE = 'https://www.google.com/search?q=1';

interface Node {
  readonly ns: string;
  readonly tag: string;
  readonly attrs: readonly T.Element['attrs'][number][];
  readonly attr: (name: string) => string | undefined;
}

function served(body: string): { body: T.Element; elements: Node[] } {
  const doc = parse(suggestionsDocument(body), { scriptingEnabled: false });
  const root = doc.childNodes.find((n): n is T.Element => tree.isElementNode(n) && n.tagName === 'html')!;
  const el = root.childNodes.find((n): n is T.Element => tree.isElementNode(n) && n.tagName === 'body')!;
  const elements: Node[] = [];
  const walk = (p: T.ParentNode) => {
    for (const c of p.childNodes) {
      if (!tree.isElementNode(c)) continue;
      elements.push({ ns: c.namespaceURI, tag: c.tagName, attrs: c.attrs, attr: (n) => c.attrs.find((a) => !a.namespace && a.name === n)?.value });
      walk(tree.getTagName(c) === 'template' ? (c as T.Template).content : c);
    }
  };
  walk(el);
  return { body: el, elements };
}

/** Destinations a listener could actually navigate to inside the served unit. */
const destinations = (out: string) =>
  served(out)
    .elements.filter((e) => e.attr('href') !== undefined || e.attrs.some((a) => a.name === 'href'))
    .map((e) => e.attr('href') ?? '(namespaced)');

// Independent oracle (deliberately not the implementation's tables).
const STATIC_HTML = new Set(['div', 'span', 'p', 'br', 'wbr', 'hr', 'b', 'strong', 'i', 'em', 'u', 's', 'small', 'sub', 'sup', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'section', 'header', 'footer', 'a', 'img', 'style']);
const STATIC_SVG = new Set(['svg', 'g', 'path', 'circle', 'ellipse', 'rect', 'line', 'polyline', 'polygon', 'defs', 'linearGradient', 'radialGradient', 'stop', 'clipPath']);
const ACTIVE_ATTR = /^(on.*|srcdoc|srcset|ping|action|formaction|form|data|poster|background|usemap|ismap|download|referrerpolicy|xmlns.*|http-equiv|content|codebase|archive|lowsrc|dynsrc|longdesc|attributename|values|to|from|by|begin|popovertarget|commandfor)$/i;

function expectSafe(out: string | null): asserts out is string {
  expect(out).not.toBeNull();
  const { body, elements } = served(out!);
  expect(body.attrs).toEqual([]);
  for (const e of elements) {
    expect(e.ns === NS.HTML ? STATIC_HTML.has(e.tag) : e.ns === NS.SVG && STATIC_SVG.has(e.tag), `${e.ns} ${e.tag}`).toBe(true);
    for (const a of e.attrs) {
      expect(a.namespace, `${e.tag} ${a.name}`).toBeUndefined();
      expect(a.name, `${e.tag} ${a.name}`).not.toMatch(ACTIVE_ATTR);
      if (a.name === 'href' || a.name === 'target' || a.name === 'rel') expect(e.ns === NS.HTML && e.tag === 'a').toBe(true);
      if (a.name === 'src') expect(e.ns === NS.HTML && e.tag === 'img' && validateSuggestionImage(a.value) === a.value).toBe(true);
      if (e.ns === NS.SVG && !['id', 'class', 'style'].includes(a.name)) expect(a.value.replace(/url\(\s*(["']?)#[\w.-]+\1\s*\)/g, '')).not.toMatch(/url|\\/i);
    }
    if (e.tag === 'a') {
      const href = e.attr('href');
      if (href === undefined) expect([e.attr('target'), e.attr('rel')]).toEqual([undefined, undefined]);
      else expect([validateSuggestionLink(href), e.attr('target'), e.attr('rel')]).toEqual([href, '_blank', 'noopener noreferrer']);
    }
  }
  // The browser's parse of the output is already what the allowlist accepts.
  expect(sanitizeSuggestions(out!)).toBe(out);
}

describe('Search Suggestions sanitiser: slash-separated attribute bypass', () => {
  it('fails closed on the confirmed payload: no destination, no target, text kept', () => {
    const out = sanitizeSuggestions('<a/href="https://example.invalid/"/target="_blank">Synthetic link</a>');
    expectSafe(out);
    expect(destinations(out)).toEqual([]);
    const [a] = served(out).elements;
    expect([a!.tag, a!.attrs]).toEqual(['a', []]);
    expect(out).toContain('Synthetic link');
  });

  it('a slash-separated Google link keeps its destination with exactly forced target/rel', () => {
    const out = sanitizeSuggestions(`<a/class="chip"/href="${GOOGLE}"/target="_top"/rel="opener">q</a>`);
    expectSafe(out);
    expect(destinations(out)).toEqual([GOOGLE]);
    const [a] = served(out).elements;
    expect(a!.attr('class')).toBe('chip');
  });
});

describe('Search Suggestions sanitiser: native unit preservation', () => {
  const STYLE =
    '<style>.container{align-items:center;border-radius:8px;display:flex;font-family:sans-serif}.carousel > .chip{display:inline-block;border:solid 1px;border-radius:16px;padding:5px 16px;text-decoration:none}' +
    '@media (prefers-color-scheme: dark){.container{background-color:#1f1f1f}.logo-light{display:none}}.gradient{position:absolute;background:linear-gradient(90deg,#fafafa 15%,#fafafa00 100%)}</style>';
  const logo = (xmlns: string) =>
    `<svg class="logo-light" width="18" height="18" viewBox="9 9 35 35" fill="none"${xmlns} aria-hidden="true"><path fill-rule="evenodd" clip-rule="evenodd" d="M10 10H40V40H10Z" fill="#4285F4"></path>` +
    '<circle cx="24" cy="24" r="8" fill="url(#invented-g)"></circle><defs><linearGradient id="invented-g" x1="0" y1="0" x2="1" y2="1" gradientUnits="objectBoundingBox">' +
    '<stop offset="0" stop-color="#34A853"></stop><stop offset="1" stop-color="#FBBC05" stop-opacity="0.5"></stop></linearGradient></defs></svg>';
  const chip = (q: string, forced: string) => `<a class="chip" href="https://www.google.com/search?q=${q}&amp;client=invented"${forced}>${q.replace(/\+/g, ' ')} &amp; more</a>`;
  const unit = (xmlns: string, forced: string) =>
    `${STYLE}<div class="container" style="padding:8px 12px"><div class="headline">${logo(xmlns)}<img class="mark" alt="" width="12" src="https://www.gstatic.com/invented/mark.png">` +
    `<div class="gradient-container"><div class="gradient"></div></div></div><div class="carousel" role="list">${chip('invented+one', forced)}${chip('invented+two', forced)}</div></div>`;

  it('keeps the complete unit (style text, classes, inline styles, SVG logo, static image, chips) and only forces link target/rel', () => {
    const out = sanitizeSuggestions(unit(' xmlns="http://www.w3.org/2000/svg"', ''));
    expectSafe(out);
    expect(out).toBe(unit('', ' target="_blank" rel="noopener noreferrer"'));
    expect(destinations(out)).toEqual(['https://www.google.com/search?q=invented+one&client=invented', 'https://www.google.com/search?q=invented+two&client=invented']);
  });

  it('keeps the existing synthetic fixture whole', () => {
    const fixture = '<div class="fixture"><span>Synthetic Search Suggestions (fixture, not from Google)</span></div>';
    expect(sanitizeSuggestions(fixture)).toBe(fixture);
  });
});

describe('Search Suggestions sanitiser: attribute syntax agrees with the HTML parser', () => {
  const cases: [string, string, string[]][] = [
    ['unquoted, upper-case attributes', '<A HREF=https://example.invalid/ TARGET=_top>x</A>', []],
    ['unquoted valid link', `<a href=${GOOGLE} target=_top>x</a>`, [GOOGLE]],
    ['no whitespace between attributes', `<a href="${GOOGLE}"onclick="steal()"target="_top">x</a>`, [GOOGLE]],
    ['first duplicate wins (unsafe first)', `<a href="https://example.invalid/" href="${GOOGLE}">x</a>`, []],
    ['first duplicate wins (safe first)', `<a href="${GOOGLE}" HREF="https://example.invalid/" target="_blank" target="_top">x</a>`, [GOOGLE]],
    ['entity-encoded scheme of an unsafe link', '<a href="&#x68;ttps://example.invalid/">x</a>', []],
    ['named entity in a safe link decodes as the browser does', '<a href="https&colon;//www.google.com/search?q=1">x</a>', [GOOGLE]],
    // In attributes a legacy reference followed by "=" stays literal (a regex "&amp;" decoder would disagree).
    ['legacy entity without semicolon in the query', '<a href="https://www.google.com/search?q=1&amp=2">x</a>', ['https://www.google.com/search?q=1&amp=2']],
    ['javascript via entity', '<a href="javascript&colon;alert(1)">x</a>', []],
    ['javascript split by a tab entity', '<a href="java&#9;script:alert(1)">x</a>', []],
    ['leading whitespace is refused rather than trimmed', `<a href="  ${GOOGLE}">x</a>`, []],
    ['upper-case scheme and host are refused', '<a href="HTTPS://WWW.GOOGLE.COM/search?q=1">x</a>', []],
    ['protocol-relative Google', '<a href="//www.google.com/search?q=1">x</a>', []],
    ['protocol-relative other host', '<a href="//example.invalid/search">x</a>', []],
    ['userinfo hiding another host', '<a href="https://www.google.com@example.invalid/search?q=1">x</a>', []],
    ['userinfo on Google', '<a href="https://user@www.google.com/search?q=1">x</a>', []],
    ['non-default port', '<a href="https://www.google.com:8443/search?q=1">x</a>', []],
    ['default port normalises to the canonical URL', '<a href="https://www.google.com:443/search?q=1">x</a>', [GOOGLE]],
    ['backslash host confusion', '<a href="https://example.invalid\\@www.google.com/search?q=1">x</a>', []],
    ['backslash scheme', '<a href="https:\\\\www.google.com/search?q=1">x</a>', []],
    ['http', '<a href="http://www.google.com/search?q=1">x</a>', []],
    ['look-alike host', '<a href="https://www.google.com.example.invalid/search?q=1">x</a>', []],
    ['trailing-dot host', '<a href="https://www.google.com./search?q=1">x</a>', []],
    ['Google redirector path', '<a href="https://www.google.com/url?q=https://example.invalid/">x</a>', []],
    ['fragment', '<a href="https://www.google.com/search?q=1#x">x</a>', []],
    ['NUL in an attribute name', `<a href="${GOOGLE}"\u0000onclick="steal()">x</a>`, [GOOGLE]],
    ['attribute name starting with =', '<a =href="https://example.invalid/">x</a>', []],
    ['active anchor attributes are dropped', `<a href="${GOOGLE}" ping="https://example.invalid/p" download referrerpolicy="unsafe-url" rel="opener" target="_top">x</a>`, [GOOGLE]],
    ['unterminated attribute swallows the tag (EOF drops it)', '<a href="https://example.invalid/>never closed', []],
  ];
  for (const [name, input, expected] of cases) {
    it(name, () => {
      const out = sanitizeSuggestions(input);
      expectSafe(out);
      expect(destinations(out)).toEqual(expected);
    });
  }
});

describe('Search Suggestions sanitiser: alternate navigation, active and foreign content', () => {
  const hostile: [string, string][] = [
    ['area/map', '<img src="https://www.gstatic.com/x.png" usemap="#m"><map name="m"><area href="https://example.invalid/" shape="default"></map>'],
    ['meta refresh, base, link', '<meta http-equiv="refresh" content="0;url=https://example.invalid/"><base href="https://example.invalid/"><link rel="prefetch" href="https://example.invalid/">'],
    ['forms and formaction', '<form action="https://example.invalid/"><button formaction="https://example.invalid/">go</button><input type="image" src="https://www.gstatic.com/x.png" formaction="https://example.invalid/"></form><button form="f" formaction="https://example.invalid/">x</button>'],
    ['frames and embeds', '<iframe srcdoc="<a href=https://example.invalid/>x</a>"></iframe><frame src="https://example.invalid/"><object data="https://example.invalid/"></object><embed src="https://example.invalid/"><portal src="https://example.invalid/"></portal>'],
    ['media and responsive images', '<video poster="https://example.invalid/p.png"><source src="https://example.invalid/v"></video><audio src="https://example.invalid/a"></audio><img src="https://example.invalid/i.png" srcset="https://example.invalid/2x.png 2x"><img src="//www.gstatic.com/x.png">'],
    ['SVG link (plain href)', '<svg><a href="https://example.invalid/"><rect width="9" height="9"></rect></a></svg>'],
    ['SVG link (xlink:href)', '<svg><a xlink:href="https://example.invalid/"><text>x</text></a></svg>'],
    ['SVG use/image/feImage', '<svg><use href="https://example.invalid/s.svg#a"></use><image href="https://example.invalid/i.png"></image><filter><feImage href="https://example.invalid/i.png"></feImage></filter></svg>'],
    ['SVG animation rewriting a link', `<svg><a><animate attributeName="href" values="https://example.invalid/"></animate><rect></rect></a></svg><a href="${GOOGLE}"><svg><set attributeName="href" to="https://example.invalid/"></set></svg>q</a>`],
    ['SVG set on xlink:href and discard', '<svg><set attributeName="xlink:href" to="https://example.invalid/"></set><discard></discard><animateMotion></animateMotion><animateTransform></animateTransform></svg>'],
    ['SVG foreignObject and integration points', '<svg><foreignObject><a href="https://example.invalid/">x</a></foreignObject><desc><a href="https://example.invalid/">x</a></desc><title><a href="https://example.invalid/">x</a></title></svg>'],
    ['external SVG paint/clip references', '<svg><path fill="url(https://example.invalid/p.svg#a)" clip-path="url( \'https://example.invalid/#c\' )" stroke="u\\rl(https://example.invalid/)" d="M0 0"></path></svg>'],
    ['MathML links', '<math href="https://example.invalid/"><mi href="https://example.invalid/">x</mi><mtext><a href="https://example.invalid/">x</a></mtext></math>'],
    ['event handlers everywhere', '<div onclick="steal()" onmouseover="steal()"><img src="https://www.gstatic.com/x.png" onerror="steal()"><svg onload="steal()"><path onclick="steal()"></path></svg></div>'],
    ['script and template', '<script>steal()</script><template><a href="https://example.invalid/">x</a></template>'],
    ['body/html attribute merging', '</body><body onload="steal()"><html onclick="steal()"><a href="https://example.invalid/">after body</a>'],
    ['dialog, popover and command targets', '<dialog open><a href="https://example.invalid/">x</a></dialog><div popovertarget="x" commandfor="x">y</div>'],
  ];
  for (const [name, input] of hostile) {
    it(name, () => {
      const out = sanitizeSuggestions(input);
      expectSafe(out);
      expect(destinations(out).filter((d) => d !== GOOGLE)).toEqual([]);
    });
  }

  it('images: only the exact host the CSP allows, canonicalised; naked, userinfo, port and look-alike hosts are refused', () => {
    expect(SUGGESTIONS_CSP).toContain('img-src https://www.gstatic.com data:');
    const ok = 'https://www.gstatic.com/invented/logo.png';
    for (const [raw, expected] of [
      [ok, ok],
      ['https://www.gstatic.com:443/invented/logo.png', ok],
      ['https://WWW.GSTATIC.COM/invented/logo.png', ok],
      ['https://www%2egstatic.com/invented/logo.png', ok], // the URL parser decodes the host as the browser does; the canonical host is emitted
      ['https://gstatic.com/invented/logo.png', null],
      ['https://www.gstatic.com.example.invalid/x.png', null],
      ['https://www.gstatic.com./x.png', null],
      ['https://user@www.gstatic.com/x.png', null],
      ['https://www.gstatic.com@example.invalid/x.png', null],
      ['https://www.gstatic.com:8443/x.png', null],
      ['http://www.gstatic.com/x.png', null],
      ['//www.gstatic.com/x.png', null],
      ['https://www.gstatic.com\\@example.invalid/x.png', null],
      ['https://www.gstatic.com/x.png#f', null],
    ] as const) {
      expect(validateSuggestionImage(raw), raw).toBe(expected);
      const out = sanitizeSuggestions(`<img alt="" src="${raw}">`);
      expectSafe(out);
      expect(served(out).elements[0]!.attr('src'), raw).toBe(expected ?? undefined);
    }
  });

  it('keeps the gstatic image but none of its active attributes', () => {
    const out = sanitizeSuggestions('<img src="https://www.gstatic.com/x.png" usemap="#m" ismap>');
    expectSafe(out);
    expect(served(out).elements.map((e) => [e.tag, e.attrs.map((a) => a.name)])).toEqual([['img', ['src']]]);
  });
});

describe('Search Suggestions sanitiser: parser state and mutation payloads', () => {
  const payloads: [string, string][] = [
    // Scripting is disabled in the sandbox, so noscript content is markup, not text.
    ['noscript title breakout', '<noscript><p title="</noscript><img src=x onerror=steal()>"></noscript>'],
    ['SVG style namespace confusion', '<svg></p><style><a id="</style><img src=1 onerror=steal()>">'],
    ['MathML/table/mglyph style confusion', '<math><mtext><table><mglyph><style><!--</style><img title="--&gt;&lt;/mglyph&gt;&lt;img src=1 onerror=steal()&gt;">'],
    ['form/math mutation', '<form><math><mtext></form><form><mglyph><style></math><img src onerror=steal()>'],
    ['comment confusion', '<!--><a href="https://example.invalid/">--><!--!><a href="https://example.invalid/">x</a>--!><a href="https://example.invalid/">y</a>'],
    ['raw-text elements', '<xmp><a href="https://example.invalid/"></xmp><textarea><a href="https://example.invalid/"></textarea><title><a href="https://example.invalid/"></title><noembed><a href="https://example.invalid/"></noembed>'],
    ['plaintext swallows the rest of the served document', '<plaintext><a href="https://example.invalid/">'],
    ['nested anchors via table cells regroup on reparse', `<a href="${GOOGLE}"><table><tr><td><a href="https://example.invalid/">inner</a></td></tr></table>outer</a>`],
    ['nested paragraphs via table cells', '<p><table><tr><td><p>x<a/href="https://example.invalid/">y</a></td></tr></table></p>'],
    ['unclosed select/template eat the wrapper', '<select><option><a href="https://example.invalid/">x</a>'],
    ['style text that looks like markup stays CSS', '<style>/*</style><a href="https://example.invalid/">*/.a{}</style>'],
  ];
  for (const [name, input] of payloads) {
    it(name, () => {
      const out = sanitizeSuggestions(input);
      expectSafe(out);
      expect(destinations(out).filter((d) => d !== GOOGLE)).toEqual([]);
    });
  }
});

describe('Search Suggestions sanitiser: bounds', () => {
  it('refuses oversized input, excessive nesting and output expansion beyond the stored bound', () => {
    expect(sanitizeSuggestions('x'.repeat(SUGGESTIONS_LIMITS.inputBytes + 1))).toBeNull();
    expect(sanitizeSuggestions('<div>'.repeat(SUGGESTIONS_LIMITS.depth + 2) + 'deep')).toBeNull();
    expect(sanitizeSuggestions('<div>'.repeat(SUGGESTIONS_LIMITS.depth) + 'deep')).toContain('deep');
    expect(sanitizeSuggestions('&'.repeat(60 * 1024))).toBeNull();
    // Deep unknown wrappers are bounded too (they are walked even though they are unwrapped).
    expect(sanitizeSuggestions('<x-a>'.repeat(10_000))).toBeNull();
  });
});
