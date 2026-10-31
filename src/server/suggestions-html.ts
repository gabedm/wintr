import { defaultTreeAdapter as tree, html, parse, serialize, type DefaultTreeAdapterTypes as T } from 'parse5';
import { validateSuggestionImage, validateSuggestionLink } from './destinations.js';

// Search Suggestions unit sanitiser (synthetically tested, not live-verified).
// The provider unit is parsed with a WHATWG-conformant HTML parser exactly as
// the isolated route serves it (inside `suggestionsDocument`, scripting disabled
// as in the CSP sandbox), so duplicate, unquoted, slash-separated, entity-encoded
// and mixed-case attributes mean what a browser takes them to mean. A fresh tree
// is then rebuilt from an allowlist (nothing unknown is copied), serialised, and
// accepted only when re-parsing that output yields a tree the allowlist leaves
// untouched. The route's sandbox/CSP remain defence in depth; CSS (inline styles
// and <style>) is kept for native presentation and is governed by that CSP.

export const SUGGESTIONS_LIMITS = { inputBytes: 64 * 1024, outputBytes: 256 * 1024, depth: 40, passes: 3 } as const;

/** The exact document served by the isolated Suggestions route; the sanitiser parses in this same context. */
export const suggestionsDocument = (body: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"></head><body>${body}</body></html>`;

const { NS } = html;
type Attr = { name: string; value: string };

const GLOBAL_ATTRS = new Set(['class', 'id', 'title', 'dir', 'lang', 'role', 'style']);
const ARIA = /^aria-[a-z]+$/;
const NONE: ReadonlySet<string> = new Set();
/** Static HTML elements kept, with their extra plain attributes. `a` href/target/rel and `img` src are rebuilt, never copied. */
const HTML_KEEP = new Map<string, ReadonlySet<string>>([
  ...['div', 'span', 'p', 'br', 'wbr', 'hr', 'b', 'strong', 'i', 'em', 'u', 's', 'small', 'sub', 'sup', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'section', 'header', 'footer', 'a', 'style'].map(
    (t) => [t, NONE] as const,
  ),
  ['img', new Set(['alt', 'width', 'height'])],
]);
/** Attributes only ever written by the sanitiser itself, from validated values. */
const REBUILT = new Map<string, ReadonlySet<string>>([
  ['a', new Set(['href', 'target', 'rel'])],
  ['img', new Set(['src'])],
]);
/** HTML elements removed with their whole content: active, navigating, embedding, form, media and raw-text elements. Other unknown elements are unwrapped. */
const HTML_DROP = new Set([
  'script', 'template', 'noscript', 'noembed', 'noframes', 'xmp', 'plaintext', 'textarea', 'title', 'iframe', 'frame', 'frameset', 'object', 'embed',
  'applet', 'param', 'form', 'input', 'button', 'select', 'option', 'optgroup', 'datalist', 'output', 'label', 'fieldset', 'legend', 'meta', 'base',
  'link', 'area', 'map', 'audio', 'video', 'source', 'track', 'picture', 'canvas', 'portal', 'fencedframe', 'dialog', 'slot',
]);
/**
 * Static SVG shapes for the provider logo. No links, `use`, images, text,
 * `style`, `foreignObject`/`desc`/`title` integration points, filters, or
 * animation/`set` (which can rewrite attributes after parsing).
 */
const SVG_KEEP = new Set(['g', 'path', 'circle', 'ellipse', 'rect', 'line', 'polyline', 'polygon', 'defs', 'linearGradient', 'radialGradient', 'stop', 'clipPath']);
const SVG_ATTRS = new Set([
  'class', 'id', 'style', 'role', 'width', 'height', 'viewBox', 'preserveAspectRatio', 'fill', 'fill-rule', 'fill-opacity', 'clip-rule', 'clip-path', 'd',
  'cx', 'cy', 'r', 'rx', 'ry', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'fx', 'fy', 'points', 'transform', 'stroke', 'stroke-width', 'stroke-linecap',
  'stroke-linejoin', 'stroke-miterlimit', 'stroke-opacity', 'stroke-dasharray', 'stroke-dashoffset', 'opacity', 'offset', 'stop-color', 'stop-opacity',
  'gradientUnits', 'gradientTransform', 'clipPathUnits',
]);
/** An SVG presentation value may reference only a fragment-local paint server or clip path. */
const LOCAL_REF = /url\(\s*(["']?)#[A-Za-z_][\w.-]*\1\s*\)/gi;
const svgValueOk = (name: string, value: string) => name === 'id' || name === 'class' || name === 'style' || !/url|\\/i.test(value.replace(LOCAL_REF, ''));

class Unsafe extends Error {}

interface Pass {
  readonly html: string | null;
  /** True when the allowlist removed or rewrote anything in the parsed tree. */
  readonly changed: boolean;
}

function sanitizePass(input: string): Pass {
  const doc = parse(suggestionsDocument(input), { scriptingEnabled: false });
  const root = doc.childNodes.find((n): n is T.Element => tree.isElementNode(n) && n.tagName === 'html');
  const body = root?.childNodes.find((n): n is T.Element => tree.isElementNode(n) && n.tagName === 'body');
  if (!body) return { html: null, changed: true };
  let changed = false;
  const plain = (attrs: readonly T.Element['attrs'][number][], keep: (a: Attr) => boolean): Attr[] => {
    const out: Attr[] = [];
    for (const a of attrs) {
      if (!a.namespace && keep(a)) out.push({ name: a.name, value: a.value });
      else changed = true;
    }
    return out;
  };
  const htmlAttrs = (el: T.Element, extra: ReadonlySet<string>): Attr[] => {
    if (el.tagName === 'style') return plain(el.attrs, () => false);
    const own = REBUILT.get(el.tagName) ?? NONE;
    const attrs = plain(el.attrs, (a) => GLOBAL_ATTRS.has(a.name) || ARIA.test(a.name) || extra.has(a.name) || own.has(a.name)).filter((a) => !own.has(a.name));
    const value = (name: string) => el.attrs.find((a) => !a.namespace && a.name === name)?.value;
    const forced: Attr[] = [];
    if (el.tagName === 'a') {
      const href = validateSuggestionLink(value('href'));
      if (href) forced.push({ name: 'href', value: href }, { name: 'target', value: '_blank' }, { name: 'rel', value: 'noopener noreferrer' });
    } else if (el.tagName === 'img') {
      const src = validateSuggestionImage(value('src'));
      if (src) forced.push({ name: 'src', value: src });
    }
    // Rebuilt attributes are never copied; they are a change unless the parsed input already had exactly them.
    for (const name of own) if (value(name) !== forced.find((f) => f.name === name)?.value) changed = true;
    return [...attrs, ...forced];
  };

  const copyChildren = (src: T.ParentNode, dst: T.ParentNode, context: html.NS, depth: number): void => {
    if (depth > SUGGESTIONS_LIMITS.depth) throw new Unsafe();
    for (const node of src.childNodes) {
      if (tree.isTextNode(node)) {
        tree.insertText(dst, node.value);
        continue;
      }
      if (!tree.isElementNode(node)) {
        changed = true; // comments never survive
        continue;
      }
      if (node.namespaceURI === NS.HTML) {
        const extra = HTML_KEEP.get(node.tagName);
        if (context !== NS.HTML || HTML_DROP.has(node.tagName)) {
          changed = true;
        } else if (!extra) {
          changed = true;
          copyChildren(node, dst, context, depth + 1);
        } else {
          const copy = tree.createElement(node.tagName, NS.HTML, htmlAttrs(node, extra));
          tree.appendChild(dst, copy);
          if (node.tagName === 'style') {
            for (const c of node.childNodes) if (tree.isTextNode(c)) tree.insertText(copy, c.value);
          } else {
            copyChildren(node, copy, NS.HTML, depth + 1);
          }
        }
      } else if (node.namespaceURI === NS.SVG && (context === NS.HTML ? node.tagName === 'svg' : SVG_KEEP.has(node.tagName))) {
        const copy = tree.createElement(node.tagName, NS.SVG, plain(node.attrs, (a) => (SVG_ATTRS.has(a.name) || ARIA.test(a.name)) && svgValueOk(a.name, a.value)));
        tree.appendChild(dst, copy);
        copyChildren(node, copy, NS.SVG, depth + 1);
      } else {
        // MathML and every other SVG element (links, animation, integration points) go whole.
        changed = true;
      }
    }
  };

  const out = tree.createDocumentFragment();
  try {
    copyChildren(body, out, NS.HTML, 0);
  } catch (err) {
    if (err instanceof Unsafe) return { html: null, changed: true };
    throw err;
  }
  const serialised = serialize(out, { scriptingEnabled: false });
  return { html: Buffer.byteLength(serialised) <= SUGGESTIONS_LIMITS.outputBytes ? serialised : null, changed };
}

function sanitizeWithin(input: string, inputBytes: number): string | null {
  if (typeof input !== 'string' || Buffer.byteLength(input) > inputBytes) return null;
  let current = sanitizePass(input).html;
  for (let i = 0; current !== null && i < SUGGESTIONS_LIMITS.passes; i++) {
    const again = sanitizePass(current);
    if (!again.changed && again.html === current) return current;
    current = again.html;
  }
  return null;
}

/**
 * Sanitised provider Search Suggestions unit (raw provider input, at most
 * `inputBytes`), or null when it cannot be presented safely within bounds (too
 * large, too deep, or not stable under the browser's parse). Only
 * `https://www.google.com/search` anchors navigate, always with
 * target="_blank" rel="noopener noreferrer"; any other anchor keeps its text
 * but has no destination. No network or DOM execution happens here.
 */
export const sanitizeSuggestions = (input: string): string | null => sanitizeWithin(input, SUGGESTIONS_LIMITS.inputBytes);

/**
 * The same current policy applied to an already stored unit at delivery. Stored
 * provenance (including units stored under an earlier sanitiser) is not trusted:
 * the unit is rebuilt again. Its bound is the sanitiser's own output bound (the
 * stored-record limit), so a legitimate expanded canonical unit above the raw
 * provider input bound still passes, and a current unit is returned unchanged.
 */
export const sanitizeStoredSuggestions = (stored: string): string | null => sanitizeWithin(stored, SUGGESTIONS_LIMITS.outputBytes);

/**
 * Current presentation verdict for a panel's stored unit, shared by the safe
 * projection and the frame route. `absent`: none was stored (no native Search
 * grounding needed one). `unavailable`: a unit was stored (including an empty
 * one) but cannot be presented under the current policy, so the result it
 * belongs to must not be shown as complete. Derived on every read; the stored
 * record is never rewritten.
 */
export type StoredSuggestions = { readonly kind: 'absent' } | { readonly kind: 'presentable'; readonly html: string } | { readonly kind: 'unavailable' };

export function storedSuggestionsVerdict(stored: string | null): StoredSuggestions {
  if (stored === null) return { kind: 'absent' };
  const html = sanitizeStoredSuggestions(stored);
  return html ? { kind: 'presentable', html } : { kind: 'unavailable' };
}
