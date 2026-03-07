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
  return decodeWindows1251(buffer);
}

// Windows-1251 decoder
function decodeWindows1251(buf) {
  const map = '\u0402\u0403\u201A\u0453\u201E\u2026\u2020\u2021\u20AC\u2030\u0409\u2039\u040A\u040C\u040B\u040F\u0452\u2018\u2019\u201C\u201D\u2022\u2013\u2014\uFFFD\u2122\u0459\u203A\u045A\u045C\u045B\u045F\u00A0\u040E\u045E\u0408\u00A4\u0490\u00A6\u00A7\u0401\u00A9\u0404\u00AB\u00AC\u00AD\u00AE\u0407\u00B0\u00B1\u0406\u0456\u0491\u00B5\u00B6\u00B7\u0451\u2116\u0454\u00BB\u0458\u0405\u0455\u0457\u0410\u0411\u0412\u0413\u0414\u0415\u0416\u0417\u0418\u0419\u041A\u041B\u041C\u041D\u041E\u041F\u0420\u0421\u0422\u0423\u0424\u0425\u0426\u0427\u0428\u0429\u042A\u042B\u042C\u042D\u042E\u042F\u0430\u0431\u0432\u0433\u0434\u0435\u0436\u0437\u0438\u0439\u043A\u043B\u043C\u043D\u043E\u043F\u0440\u0441\u0442\u0443\u0444\u0445\u0446\u0447\u0448\u0449\u044A\u044B\u044C\u044D\u044E\u044F';
  let result = '';
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    result += b < 0x80 ? String.fromCharCode(b) : map[b - 0x80] || '?';
  }
  return result;
}

// ─── Search subs.sab.bz ───────────────────────────────────────────────────────

async function searchSubtitles(imdbId, title, season, episode) {
  const query = buildQuery(title, season, episode);
  const searchUrl = `${BASE_URL}/index.php?act=search&movie=${encodeURIComponent(query)}`;
  console.log(`[search] URL: ${searchUrl}`);

  let html;
  try {
    html = await fetchText(searchUrl);
    console.log(`[search] got ${html.length} bytes`);
  } catch (e) {
    console.error('[search] fetch error:', e.message);
    return [];
  }

  const results = [];
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch;

  while ((rowMatch = rowRe.exec(html)) !== null) {
    const row = rowMatch[1];

    const dlMatch = row.match(/act=download&(?:amp;)?attach_id=(\d+)/);
    if (!dlMatch) continue;
    const attachId = dlMatch[1];

    const titleMatch = row.match(/act=download[^"]*"[^>]*>([^<]+)/);
    const subTitle = titleMatch ? titleMatch[1].trim() : query;

    const lang = row.match(/Български|Bulgarian/i)
      ? 'bul'
      : row.match(/English/i)
      ? 'eng'
      : 'und';
    console.log(`[lang] attachId=${attachId} lang=${lang} rowSnippet=${row.slice(0, 200).replace(/\s+/g, ' ')}`);

    const fpsMatch = row.match(/(\d{2}\.\d{3})/);
    const fps = fpsMatch ? fpsMatch[1] : '';

    const imdbMatch = row.match(/imdb\.com\/title\/(tt\d+)/);
    const rowImdb = imdbMatch ? imdbMatch[1] : null;

    const sidMatch = row.match(/act=details&(?:amp;)?sid=(\d+)/);
    const sid = sidMatch ? sidMatch[1] : null;

    results.push({
      title: subTitle,
      lang,
      fps,
      attachId,
      sid,
      rowImdb,
      downloadUrl: `${BASE_URL}/index.php?act=download&attach_id=${attachId}`,
    });
  }

  console.log(`[search] parsed ${results.length} results`);

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

function extractSrtFromZip(zipBuf, season, episode) {
  const entries = parseZip(zipBuf);
  const srts = entries.filter(e => e.name.toLowerCase().endsWith('.srt'));
  if (srts.length === 0) return null;
  if (srts.length === 1) return srts[0];
  if (!season || !episode) return srts[0];

  const s = String(season).padStart(2, '0');
  const e = String(episode).padStart(2, '0');

  const patterns = [
    new RegExp(`S${s}E${e}`, 'i'),
    new RegExp(`${season}x${e}`, 'i'),
    new RegExp(`\\.${e}\\.`, 'i'),
  ];

  for (const pat of patterns) {
    const match = srts.find(f => pat.test(f.name));
    if (match) return match;
  }

  return srts[0];
}

function parseZip(buf) {
  const entries = [];
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
    if (buf.readUInt32LE(pos) !== 0x02014b50) break;
    const compMethod = buf.readUInt16LE(pos + 10);
    const compSize = buf.readUInt32LE(pos + 20);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const localOffset = buf.readUInt32LE(pos + 42);
    const name = buf.slice(pos + 46, pos + 46 + nameLen).toString('utf8');

    pos += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith('/')) continue;

    const localPos = localOffset;
    if (buf.readUInt32LE(localPos) !== 0x04034b50) continue;
    const localNameLen = buf.readUInt16LE(localPos + 26);
    const localExtraLen = buf.readUInt16LE(localPos + 28);
    const dataStart = localPos + 30 + localNameLen + localExtraLen;
    const compData = buf.slice(dataStart, dataStart + compSize);

    let data;
    try {
      if (compMethod === 0) {
        data = compData;
      } else if (compMethod === 8) {
        data = zlib.inflateRawSync(compData);
      } else {
        continue;
      }
    } catch (_) {
      continue;
    }

    entries.push({ name, data });
  }

  return entries;
}

// ─── RAR extraction via node-unrar-js ────────────────────────────────────────

async function extractSrtFromRar(rarBuf, season, episode) {
  try {
    const { createExtractorFromData } = require('node-unrar-js');
    const extractor = await createExtractorFromData({ data: rarBuf });
    const list = extractor.getFileList();
    const fileHeaders = [...list.fileHeaders];
    const srtHeaders = fileHeaders.filter(f => f.name.toLowerCase().endsWith('.srt'));
    console.log(`[rar] found srts: ${srtHeaders.map(f => f.name).join(', ')}`);

    if (srtHeaders.length === 0) return null;

    let chosen = srtHeaders[0];
    if (season && episode && srtHeaders.length > 1) {
      const s = String(season).padStart(2, '0');
      const e = String(episode).padStart(2, '0');
      const patterns = [
        new RegExp(`S${s}E${e}`, 'i'),
        new RegExp(`${season}x${e}`, 'i'),
      ];
      for (const pat of patterns) {
        const match = srtHeaders.find(f => pat.test(f.name));
        if (match) { chosen = match; break; }
      }
    }

    const extracted = extractor.extract({ files: [chosen.name] });
    const files = [...extracted.files];
    if (files.length && files[0].extraction) {
      console.log(`[rar] extracted: ${chosen.name}`);
      return Buffer.from(files[0].extraction);
    }
  } catch (e) {
    console.error(`[rar] extraction error: ${e.message}`);
  }
  return null;
}

const titleCache = new Map();

async function getTitleFromImdb(imdbId) {
  if (titleCache.has(imdbId)) return titleCache.get(imdbId);

  // Try multiple OMDB keys
  const omdbKeys = ['trilogy', 'thewdb', 'b9bd48a6'];
  for (const key of omdbKeys) {
    try {
      console.log(`[omdb] trying key ${key} for ${imdbId}`);
      const { buffer } = await fetchBuffer(`https://www.omdbapi.com/?i=${imdbId}&apikey=${key}`);
      const data = JSON.parse(buffer.toString());
      console.log(`[omdb] response: ${JSON.stringify(data).slice(0, 120)}`);
      if (data.Title) {
        titleCache.set(imdbId, data.Title);
        return data.Title;
      }
    } catch (e) {
      console.log(`[omdb] error: ${e.message}`);
    }
  }

  // Fallback: scrape IMDb
  try {
    console.log(`[imdb] scraping title for ${imdbId}`);
    const html = await fetchText(`https://www.imdb.com/title/${imdbId}/`);
    const m = html.match(/<title>([^<]+?) \(/);
    if (m) {
      const t = m[1].trim();
      console.log(`[imdb] found: ${t}`);
      titleCache.set(imdbId, t);
      return t;
    }
  } catch (e) {
    console.log(`[imdb] error: ${e.message}`);
  }

  // Last resort: search sabs directly by imdb id
  try {
    console.log(`[sabs] searching by imdb id ${imdbId}`);
    const html = await fetchText(`${BASE_URL}/index.php?act=search&movie=${imdbId}`);
    const titleMatch = html.match(/act=download[^"]*"[^>]*>([^<]+)/);
    if (titleMatch) {
      const raw = titleMatch[1].trim()
        .replace(/\s*-\s*S\d+E\d+.*$/i, '')
        .replace(/\s*\(\d{4}\).*$/, '')
        .trim();
      console.log(`[sabs] extracted title: ${raw}`);
      if (raw) {
        titleCache.set(imdbId, raw);
        return raw;
      }
    }
  } catch (e) {
    console.log(`[sabs] imdb search error: ${e.message}`);
  }

  console.log(`[title] failed for ${imdbId}`);
  return null;
}

// ─── Proxy endpoint ───────────────────────────────────────────────────────────

const srtCache = new Map();

async function buildSrtProxy(attachId, season, episode) {
  const key = `${attachId}-${season}-${episode}`;
  if (srtCache.has(key)) return key;

  const downloadUrl = `${BASE_URL}/index.php?act=download&attach_id=${attachId}`;
  console.log(`[proxy] downloading ${downloadUrl}`);
  const { buffer, headers } = await fetchBuffer(downloadUrl, {
    'Referer': BASE_URL,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'bg,en;q=0.5',
  });

  const ct = (headers['content-type'] || '').toLowerCase();
  const cd = (headers['content-disposition'] || '').toLowerCase();
  const isZip = ct.includes('zip') || cd.includes('.zip');
  const isRar = cd.includes('.rar') || ct.includes('rar');
  console.log(`[proxy] content-type: ${ct}, content-disposition: ${cd}, isZip: ${isZip}, isRar: ${isRar}`);

  if (isZip) {
    const entry = extractSrtFromZip(buffer, season, episode);
    if (entry) {
      console.log(`[proxy] extracted srt: ${entry.name}`);
      srtCache.set(key, entry.data);
      return key;
    }
    const entries = parseZip(buffer).filter(e => e.name.toLowerCase().endsWith('.srt'));
    if (entries.length) {
      srtCache.set(key, entries[0].data);
      return key;
    }
    return null;
  } else if (isRar) {
    try {
      const srtData = await extractSrtFromRar(buffer, season, episode);
      if (srtData) {
        srtCache.set(key, srtData);
        return key;
      }
    } catch (e) {
      console.error(`[proxy] rar extraction error: ${e.message}`);
    }
    return null;
  } else {
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

  if (path === '/manifest.json') {
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify(MANIFEST));
  }

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

  const subMatch = path.match(/^\/subtitles\/(\w+)\/(.+)\.json$/);
  if (subMatch) {
    const [, type, id] = subMatch;
    const parts = id.split(':');
    const imdbId = parts[0].split('/')[0];
    const season = parts[1] ? parseInt(parts[1]) : null;
    const episode = parts[2] ? parseInt(parts[2]) : null;

    console.log(`[request] ${type} ${imdbId} S${season}E${episode}`);

    const title = await getTitleFromImdb(imdbId);
    if (!title) {
      console.log(`[request] no title found, returning empty`);
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ subtitles: [] }));
    }

    console.log(`[title] "${title}"`);
    const subs = await searchSubtitles(imdbId, title, season, episode);
    console.log(`[found] ${subs.length} results`);

    const subtitles = [];
    for (const s of subs.slice(0, 10)) {
      try {
        const key = await buildSrtProxy(s.attachId, season, episode);
        if (!key) continue;

        const host = req.headers.host || `localhost:${PORT}`;
        const proxyUrl = `https://${host}/proxy/${encodeURIComponent(key)}.srt`;

        subtitles.push({
          id: `sabsub-${s.attachId}`,
          url: proxyUrl,
          lang: s.lang,
          name: `[sabs] ${s.title}${s.fps ? ` • ${s.fps}fps` : ''}`,
        });
      } catch (e) {
        console.error(`[proxy] error for ${s.attachId}:`, e.message);
      }
    }

    console.log(`[response] ${subtitles.length} subtitles`);
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
║  Paste: https://sub-gatherer.onrender.com/manifest.json ║
╚══════════════════════════════════════════════════════╝
`);
});
