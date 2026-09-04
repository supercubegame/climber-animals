// A scanner, not a regex. Strips JS comments while KEEPING string literals,
// because the thing we are hunting (a CDN url in shipped code) hides in a string
// and a naive /\/\/.*$/ line-comment regex would swallow "https://..." and
// report a clean sweep. Both failure directions matter:
//   - url in a comment must NOT be flagged (false red)
//   - url in a string must BE flagged (false green, the dangerous one)
export function stripJsComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') { i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      out += c; i++;
      while (i < n) {
        if (src[i] === '\\') { out += src[i] + (src[i + 1] || ''); i += 2; continue; }
        out += src[i];
        if (src[i] === quote) { i++; break; }
        i++;
      }
      continue;
    }
    out += c; i++;
  }
  return out;
}

// Pulls the contents of every <script> element. Everything outside is markup and
// CSS, which we deliberately do not police for urls (a <style> url would be a
// different bug with a different assertion).
export function scriptBodies(html) {
  const bodies = [];
  const re = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) bodies.push(m[1]);
  return bodies;
}

export const FORBIDDEN_IN_SHIPPED_CODE = [
  { pattern: 'http://', why: 'remote resource; breaks offline double-click' },
  { pattern: 'https://', why: 'remote resource; breaks offline double-click' },
  { pattern: 'import ', why: 'ES module syntax is blocked by CORS over file://' },
  { pattern: 'import(', why: 'dynamic import is blocked by CORS over file://' },
  { pattern: 'require(', why: 'no CommonJS loader in a browser' },
  { pattern: 'type="module"', why: 'module scripts are blocked over file://' },
  { pattern: 'fetch(', why: 'file:// fetch is blocked; nothing should need it' },
];

export function scanShippedHtml(html) {
  const hits = [];
  const tagHits = FORBIDDEN_IN_SHIPPED_CODE.filter((f) => f.pattern === 'type="module"');
  for (const f of tagHits) if (html.includes(f.pattern)) hits.push({ ...f, where: 'markup' });
  const code = scriptBodies(html).map(stripJsComments).join('\n');
  for (const f of FORBIDDEN_IN_SHIPPED_CODE) {
    if (f.pattern === 'type="module"') continue;
    const at = code.indexOf(f.pattern);
    if (at >= 0) hits.push({ ...f, where: 'script', excerpt: code.slice(Math.max(0, at - 40), at + 40).replace(/\s+/g, ' ') });
  }
  return { hits, codeBytes: code.length, htmlBytes: html.length };
}
