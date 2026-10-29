/**
 * Probe candidate Sci-Hub mirrors the way the plugin does it:
 * same 4 URL patterns, same fetch, then verify the PDF really downloads.
 * Usage: node probe-mirrors.mjs [doi]
 */
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const CANDIDATES = [
  'https://sci-hub.se',
  'https://sci-hub.st',
  'https://sci-hub.ru',
  'https://sci-hub.ren',
  'https://sci-hub.ee',
  'https://sci-hub.wf',
  'https://sci-hub.box',
  'https://sci-hub.usualwant.com',
  'https://sci-hub.mksa.top',
  'https://sci-hub.pub',
  'https://sci-hub.help',
  'https://sci-hub.ink',
  'https://sci-hub.li',
  'https://sci-hub.tf',
  'https://sci-hub.cat',
  'https://sci-hub.ist',
  'https://sci-hub.tw',
  'https://sci-hub.io',
  'https://sci-hub.work',
  'https://sci-hub.in',
  'https://sci-hub.al',
  'https://sci-hub.tech',
  'https://sci-hub.3800808.xyz',
  'https://sci-hub.nsm.plus',
];

const doi = process.argv[2] || '10.1038/nature12373';

function findPdfUrl(html, pageUrl) {
  const patterns = [
    /<embed[^>]+src\s*=\s*["']([^"']+)["']/i,
    /<iframe[^>]+src\s*=\s*["']([^"']+\.pdf[^"']*)["']/i,
    /location\.href\s*=\s*['"]([^'"]+\.pdf[^'"]*)['"]/i,
    /["'](https?:\/\/[^"']+\.pdf[^"']*)["']/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(html);
    if (!match) continue;
    const cleaned = match[1].replace(/\\\//g, '/').replace(/&amp;/g, '&').replace(/#.*$/, '').trim();
    if (!cleaned || cleaned.startsWith('data:')) continue;
    try {
      return new URL(cleaned, pageUrl).href;
    } catch {
      /* next */
    }
  }
  return null;
}

async function get(url, extra = {}, timeoutMs = 20000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: ac.signal,
      headers: { 'user-agent': UA, accept: '*/*', ...extra },
    });
    const buf = Buffer.from(await res.arrayBuffer());
    return { res, buf };
  } finally {
    clearTimeout(timer);
  }
}

async function probe(host) {
  const started = Date.now();
  try {
    const { res, buf } = await get(`${host}/${doi}`);
    const html = buf.toString('utf8');
    const pageMs = Date.now() - started;
    if (res.status >= 400) return { host, pageMs, dead: `HTTP ${res.status}` };
    const pdfUrl = findPdfUrl(html, res.url);
    if (!pdfUrl) {
      const challenge = /turnstile|ddos-guard|checking your browser|are you (a )?robot/i.test(html);
      return { host, pageMs, dead: `${challenge ? 'challenge' : 'no pdf link'} (${buf.length}B)` };
    }
    const pdf = await get(pdfUrl, { referer: `${host}/${doi}`, accept: 'application/pdf,*/*' }, 60000);
    const isPdf = pdf.buf.subarray(0, 5).toString('latin1') === '%PDF-';
    return {
      host,
      pageMs,
      totalMs: Date.now() - started,
      pdfUrl,
      ok: isPdf,
      bytes: pdf.buf.length,
      dead: isPdf ? null : `download not a PDF (HTTP ${pdf.res.status}, ${pdf.buf.length}B)`,
    };
  } catch (error) {
    return { host, pageMs: Date.now() - started, dead: error.cause ? error.cause.code || error.message : error.message };
  }
}

const results = await Promise.all(CANDIDATES.map(probe));
results.sort((a, b) => Number(Boolean(b.ok)) - Number(Boolean(a.ok)) || (a.totalMs || 1e9) - (b.totalMs || 1e9));

const live = [];
for (const r of results) {
  if (r.ok) {
    live.push(r.host);
    console.log(`OK   ${r.host.padEnd(30)} page ${String(r.pageMs).padStart(5)}ms  total ${String(r.totalMs).padStart(5)}ms  ${r.bytes}B`);
  } else {
    console.log(`--   ${r.host.padEnd(30)} ${String(r.pageMs).padStart(5)}ms  ${r.dead}`);
  }
}
console.log('\nlive:', JSON.stringify(live, null, 2));
