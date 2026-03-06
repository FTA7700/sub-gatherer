#!/usr/bin/env node
/**
 * Stremio Subtitle Addon — subs.sab.bz
 * Provides Bulgarian & English subtitles.
 * Handles both single .srt files and .zip season packs.
 */

const http = require('http');
const https = require('https');
const zlib = require('zlib');
const { URL } = require('url');

const PORT = process.env.PORT || 7000;
const BASE_URL = 'http://subs.sab.bz';

// ─── Manifest ────────────────────────────────────────────────────────────────

const MANIFEST = {
  id: 'community.sabsubs',
  version: '1.0.0',
  name: 'Sabs Subtitles',
  description: 'Bulgarian & English subtitles from subs.sab.bz',
  types: ['movie', 'series'],
  catalogs: [],
  resources: ['subtitles'],
  idPrefixes: ['tt'],
};

// ─── Minimal HTTP fetch (no dependencies) ────────────────────────────────────

function fetchBuffer(urlStr, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const lib = u.protocol === 'https:' ? https : http;
    const options = {
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; StremioAddon/1.0)',
        ...headers,
      },
    };
    const req = lib.get(options, (res) => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchBuffer(res.headers.location, headers).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ buffer: Buffer.concat(chunks), headers: res.headers }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

async function fetchText(urlStr) {
  const { buffer } = await fetchBuffer(urlStr);
  // Site uses Windows-1251 encoding
  return decodeWindows1251(buffer);
}

// Windows-1251 decoder (no TextDecoder needed in older Node)
function decodeWindows1251(buf) {
  // Map of Windows-1251 chars above 0x7F
  const map = '\u0402\u0403\u201A\u0453\u201E\u2026\u2020\u2021\u20AC\u2030\u0409\u2039\u040A\u040C\u040B\u040F\u0452\u2018\u2019\u201C\u201D\u2022\u2013\u2014\uFFFD\u2122\u0459\u203A\u045A\u045C\u045B\u045F\u00A0\u040E\u045E\u0408\u00A4\u0490\u00A6\u00A7\u0401\u00A9\u0404\u00AB\u00AC\u00AD\u00AE\u0407\u00B0\u00B1\u0406\u0456\u0491\u00B5\u00B6\u00B7\u0451\u2116\u0454\u00BB\u0458\u0405\u0455\u0457\u0410\u0411\u0412\u0413\u0414\u0415\u0416\u0417\u0418\u0419\u041A\u041B\u041C\u041D\u041E\u041F\u0420\u0421\u0422\u0423\u0424\u0425\u0426\u0427\u0428\u0429\u042A\u042B\u042C\u042D\u042E\u042F\u0430\u0431\u0432\u0433\u0434\u0435\u0436\u0437\u0438\u0439\u043A\u043B\u043C\u043D\u043E\u043F\u0440\u0441\u0442\u0443\u0444\u0445\u0446\u0447\u0448\u0449\u044A\u044B\u044C\u044D\u044E\u044F';
  let result = '';
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    result += b < 0x80 ? String.fromCharCode(b) : map[b - 0x80] || '?';
  }
  return result;
}

// ─── Minimal HTML parser helpers ─────────────────────────────────────────────

function extractLinks(html, pattern) {
  const results = [];
  const re = new RegExp(`href="([^"]*${pattern}[^"]*)"[^>]*>([^<]*)`, 'gi');
  let m;
  while ((m = re.exec(html)) !== null) {
    results.push({ href: m[1], text: m[2].trim() });
  }
  return results;
}

function extractAttr(html, attr) {
  const re = new RegExp(`${attr}=["']?([^"'\\s>]+)`, 'i');
  const m = html.match(re);
  return m ? m[1] : null;
}

// ─── Search subs.sab.bz ───────────────────────────────────────────────────────

async function searchSubtitles(imdbId, title, season, episode) {
  const query = buildQuery(title, season, episode);
  const searchUrl = `${BASE_URL}/index.php?act=search&movie=${encodeURIComponent(query)}`;

  let html;
  try {
    html = await fetchText(searchUrl);
  } catch (e) {
    console.error('Fetch error:', e.message);
    return [];
  }

  // Parse table rows — each subtitle is a <tr> with download link
  const results = [];
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch;

  while ((rowMatch = rowRe.exec(html)) !== null) {
    const row = rowMatch[1];

    const dlMatch = row.match(/act=download&amp;attach_id=(\d+)/);
    if (!dlMatch) continue;
    const attachId = dlMatch[1];

    // Title text
    const titleMatch = row.match(/act=download[^"]*"[^>]*>([^<]+)/);
    const subTitle = titleMatch ? titleMatch[1].trim() : query;

    // Language
    const langMatch = row.match(/Български|Bulgarian/i)
      ? 'bul'
      : row.match(/English/i)
      ? 'eng'
      : 'und';

    // FPS
    const fpsMatch = row.match(/(\d{2,2}\.\d{3})/);
    const fps = fpsMatch ? fpsMatch[1] : '';

    // IMDb ID from row
    const imdbMatch = row.match(/imdb\.com\/title\/(tt\d+)/);
    const rowImdb = imdbMatch ? imdbMatch[1] : null;

    // SID for details page
    const sidMatch = row.match(/act=details&amp;sid=(\d+)/);
    const sid = sidMatch ? sidMatch[1] : null;

    results.push({
      title: subTitle,
      lang: langMatch,
      fps,
      attachId,
      sid,
      rowImdb,
      downloadUrl: `${BASE_URL}/index.php?act=download&attach_id=${attachId}`,
    });
  }

  // Prefer IMDb-matched results
  if (imdbId && results.some(r => r.rowImdb === imdbId)) {
    return results.filter(r => r.rowImdb === imdbId);
  }

  return results;
}

function buildQuery(title, season, episode) {
  if (season && episode) {
    const s = String(season).padStart(2, '0');
    const e = String(episode).padStart(2, '0');
    return `${title} S${s}E${e}`;
  }
  return title;
}

// ─── ZIP extraction ───────────────────────────────────────────────────────────

/**
 * Given a ZIP buffer, find the best matching .srt for a given episode.
 * Returns { filename, data: Buffer } or null.
 */
function extractSrtFromZip(zipBuf, season, episode) {
  // Minimal ZIP parser — reads central directory
  const entries = parseZip(zipBuf);

  // Filter to .srt files only
  const srts = entries.filter(e => e.name.toLowerCase().endsWith('.srt'));
  if (srts.length === 0) return null;

  // If only one SRT, return it regardless
  if (srts.length === 1) return srts[0];

  // If no episode info, return first SRT
  if (!season || !episode) return srts[0];

  const s = String(season).padStart(2, '0');
  const e = String(episode).padStart(2, '0');

  // Try to match S01E02 or 1x02 patterns
  const patterns = [
    new RegExp(`S${s}E${e}`, 'i'),
    new RegExp(`${season}x${e}`, 'i'),
    new RegExp(`\\.${e}\\.`, 'i'),
  ];

  for (const pat of patterns) {
    const match = srts.find(f => pat.test(f.name));
    if (match) return match;
  }

  // Fallback: return first SRT
  return srts[0];
}

function parseZip(buf) {
  const entries = [];
  // Find end of central directory signature: PK\x05\x06
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf[i] === 0x50 && buf[i+1] === 0x4b && buf[i+2] === 0x05 && buf[i+3] === 0x06) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) return entries;

  const cdOffset = buf.readUInt32LE(eocd + 16);
  const cdSize = buf.readUInt32LE(eocd + 12);
  let pos = cdOffset;

  while (pos < cdOffset + cdSize) {
    if (buf.readUInt32LE(pos) !== 0x02014b50) break; // central dir signature
    const compMethod = buf.readUInt16LE(pos + 10);
    const compSize = buf.readUInt32LE(pos + 20);
    const uncompSize = buf.readUInt32LE(pos + 24);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const localOffset = buf.readUInt32LE(pos + 42);
    const name = buf.slice(pos + 46, pos + 46 + nameLen).toString('utf8');

    pos += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith('/')) continue; // directory

    // Read local file header to get actual data offset
    const localPos = localOffset;
    if (buf.readUInt32LE(localPos) !== 0x04034b50) continue;
    const localNameLen = buf.readUInt16LE(localPos + 26);
    const localExtraLen = buf.readUInt16LE(localPos + 28);
    const dataStart = localPos + 30 + localNameLen + localExtraLen;

    const compData = buf.slice(dataStart, dataStart + compSize);

    let data;
    try {
      if (compMethod === 0) {
        data = compData; // stored
      } else if (compMethod === 8) {
        data = zlib.inflateRawSync(compData); // deflated
      } else {
        continue; // unsupported compression
      }
    } catch (_) {
      continue;
    }

    entries.push({ name, data });
  }

  return entries;
}

// ─── IMDb title lookup ────────────────────────────────────────────────────────

const titleCache = new Map();

async function getTitleFromImdb(imdbId) {
  if (titleCache.has(imdbId)) return titleCache.get(imdbId);

  // Try OMDB free endpoint first
  try {
    const { buffer } = await fetchBuffer(
      `https://www.omdbapi.com/?i=${imdbId}&apikey=trilogy`
    );
    const data = JSON.parse(buffer.toString());
    if (data.Title) {
      titleCache.set(imdbId, data.Title);
      return data.Title;
    }
  } catch (_) {}

  // Fallback: scrape IMDb title tag
  try {
    const html = await fetchText(`https://www.imdb.com/title/${imdbId}/`);
    const m = html.match(/<title>([^<]+?) \(/);
    if (m) {
      const t = m[1].trim();
      titleCache.set(imdbId, t);
      return t;
    }
  } catch (_) {}

  return null;
}

// ─── Proxy endpoint — serves extracted SRT from a ZIP ────────────────────────

// In-memory cache: proxyKey -> SRT buffer
const srtCache = new Map();

async function buildSrtProxy(attachId, season, episode) {
  const key = `${attachId}-${season}-${episode}`;
  if (srtCache.has(key)) return key;

  const downloadUrl = `${BASE_URL}/index.php?act=download&attach_id=${attachId}`;
  const { buffer, headers } = await fetchBuffer(downloadUrl);

  const ct = (headers['content-type'] || '').toLowerCase();
  const cd = (headers['content-disposition'] || '').toLowerCase();
  const isZip = ct.includes('zip') || cd.includes('.zip') || cd.includes('zip');

  if (isZip) {
    const entry = extractSrtFromZip(buffer, season, episode);
    if (entry) {
      srtCache.set(key, entry.data);
      return key;
    }
    // Store first SRT found
    const entries = parseZip(buffer).filter(e => e.name.toLowerCase().endsWith('.srt'));
    if (entries.length) {
      srtCache.set(key, entries[0].data);
      return key;
    }
    return null;
  } else {
    // Direct SRT file
    srtCache.set(key, buffer);
    return key;
  }
}

// ─── Router ───────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);
  const path = u.pathname;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');

  // Manifest
  if (path === '/manifest.json') {
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify(MANIFEST));
  }

  // Proxy: serve cached SRT
  // GET /proxy/:key.srt
  const proxyMatch = path.match(/^\/proxy\/(.+)\.srt$/);
  if (proxyMatch) {
    const key = decodeURIComponent(proxyMatch[1]);
    const data = srtCache.get(key);
    if (!data) {
      res.writeHead(404);
      return res.end('Not found');
    }
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.end(data);
  }

  // Subtitles: /subtitles/:type/:id.json
  const subMatch = path.match(/^\/subtitles\/(\w+)\/(.+)\.json$/);
  if (subMatch) {
    const [, type, id] = subMatch;
    const parts = id.split(':');
    const imdbId = parts[0];
    const season = parts[1] ? parseInt(parts[1]) : null;
    const episode = parts[2] ? parseInt(parts[2]) : null;

    console.log(`[request] ${type} ${imdbId} S${season}E${episode}`);

    const title = await getTitleFromImdb(imdbId);
    if (!title) {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ subtitles: [] }));
    }

    console.log(`[title] "${title}"`);
    const subs = await searchSubtitles(imdbId, title, season, episode);
    console.log(`[found] ${subs.length} results`);

    // Build subtitle entries — detect ZIPs and proxy them
    const subtitles = [];
    for (const s of subs.slice(0, 10)) {
      try {
        const key = await buildSrtProxy(s.attachId, season, episode);
        if (!key) continue;

        const host = req.headers.host || `localhost:${PORT}`;
        const proxyUrl = `http://${host}/proxy/${encodeURIComponent(key)}.srt`;

        subtitles.push({
          id: `sabsub-${s.attachId}`,
          url: proxyUrl,
          lang: s.lang,
          name: `[sabs] ${s.title}${s.fps ? ` • ${s.fps}fps` : ''}`,
        });
      } catch (e) {
        console.error(`Error proxying ${s.attachId}:`, e.message);
      }
    }

    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ subtitles }));
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════════╗
║         Sabs Subtitles — Stremio Addon               ║
╠══════════════════════════════════════════════════════╣
║  Manifest: http://localhost:${PORT}/manifest.json       ║
║                                                      ║
║  Install in Stremio:                                 ║
║  Paste: http://localhost:${PORT}/manifest.json          ║
╚══════════════════════════════════════════════════════╝
`);
});
