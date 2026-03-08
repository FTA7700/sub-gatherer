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

const MANIFEST_SABS = {
  id: 'community.sabsubs',
  version: '1.2.0',
  name: 'SAB Subtitles',
  description: 'Bulgarian & English subtitles from subs.sab.bz',
  types: ['movie', 'series'],
  catalogs: [],
  resources: ['subtitles'],
  idPrefixes: ['tt'],
};

const MANIFEST_YAVKA = {
  id: 'community.yavkasubs',
  version: '1.0.0',
  name: 'Yavka Subtitles',
  description: 'Bulgarian subtitles from yavka.net',
  types: ['movie', 'series'],
  catalogs: [],
  resources: ['subtitles'],
  idPrefixes: ['tt'],
};

const MANIFEST_UNACS = {
  id: 'community.unacsubs',
  version: '1.2.0',
  name: 'UNACS Subtitles',
  description: 'Bulgarian & English subtitles from subsunacs.net',
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

function toUtf8Srt(buf) {
  // If already valid UTF-8 with Cyrillic, return as-is
  try {
    const s = buf.toString('utf8');
    if (!s.includes('\uFFFD')) return buf;
  } catch(e) {}
  // Convert Windows-1251 to UTF-8
  return Buffer.from(decodeWindows1251(buf), 'utf8');
}

// ─── Search subs.sab.bz ───────────────────────────────────────────────────────

async function searchSubtitles(imdbId, title, year, season, episode) {
  const queries = buildQueries(title, season, episode);
  const seen = new Set();
  const results = [];

  for (const query of queries) {
    const searchUrl = `${BASE_URL}/index.php?act=search&movie=${encodeURIComponent(query)}`;
    console.log(`[search] URL: ${searchUrl}`);

    let html;
    try {
      html = await fetchText(searchUrl);
      console.log(`[search] got ${html.length} bytes`);
    } catch (e) {
      console.error('[search] fetch error:', e.message);
      continue;
    }

    const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let rowMatch;

    while ((rowMatch = rowRe.exec(html)) !== null) {
      const row = rowMatch[1];

      const dlMatch = row.match(/act=download&(?:amp;)?attach_id=(\d+)/);
      if (!dlMatch) continue;
      const attachId = dlMatch[1];
      if (seen.has(attachId)) continue;
      seen.add(attachId);

      const titleMatch = row.match(/act=download[^"]*"[^>]*>([^<]+)/);
      const subTitle = titleMatch ? titleMatch[1].trim() : query;

      const lang = row.match(/English/i) ? 'eng' : 'bul';

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
  }

  console.log(`[search] parsed ${results.length} results`);

  if (imdbId && results.some(r => r.rowImdb === imdbId)) {
    return results.filter(r => r.rowImdb === imdbId);
  }

  // Fallback: filter by year if available (handles cases where IMDb ID not in row)
  if (year && results.length > 0) {
    const byYear = results.filter(r => r.subTitle && r.subTitle.includes(String(year)));
    if (byYear.length > 0) return byYear;
  }

  return results;
}

function buildQueries(title, season, episode) {
  // Build a simplified title — strip ": Part X", ": Chapter X", etc.
  const simplified = title.replace(/\s*:\s*(part|chapter|volume|vol\.?)\s+\w+/i, '').trim();
  const titles = simplified !== title ? [title, simplified] : [title];

  if (season && episode) {
    const s = String(season).padStart(2, '0');
    const e = String(episode).padStart(2, '0');
    const queries = [];
    for (const t of titles) {
      queries.push(`${t} ${s}x${e}`, `${t} S${s}E${e}`, `${t} Season ${season}`);
    }
    return [...new Set(queries)];
  }
  return [...new Set(titles)];
}

// ─── ZIP extraction ───────────────────────────────────────────────────────────

function extractSrtFromZip(zipBuf, season, episode) {
  const entries = parseZip(zipBuf);
  const srts = entries.filter(e => /\.(srt|sub)$/i.test(e.name));
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

function extractAllSrtsFromZip(zipBuf, season, episode) {
  const entries = parseZip(zipBuf);
  const srts = entries.filter(e => /\.(srt|sub)$/i.test(e.name));
  if (srts.length === 0) return [];
  if (!season || !episode) return srts;

  const s = String(season).padStart(2, '0');
  const e = String(episode).padStart(2, '0');
  // Strict patterns: episode must appear as E04 or 4x04 not followed by digit
  const patterns = [
    new RegExp('S' + s + 'E' + e + '(?:[^0-9]|$)', 'i'),
    new RegExp(season + 'x' + e + '(?:[^0-9]|$)', 'i'),
  ];

  const matched = srts.filter(f => patterns.some(p => p.test(f.name)));
  return matched.length > 0 ? matched : srts;
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

async function extractSrtFromRar(rarBuf, season, episode, depth = 0) {
  if (depth > 3) return null; // prevent infinite recursion
  try {
    const { createExtractorFromData } = require('node-unrar-js');
    const extractor = await createExtractorFromData({ data: rarBuf });
    const list = extractor.getFileList();
    const fileHeaders = [...list.fileHeaders];

    const srtHeaders = fileHeaders.filter(f => f.name.toLowerCase().endsWith('.srt'));
    const rarHeaders = fileHeaders.filter(f => f.name.toLowerCase().endsWith('.rar'));
    const zipHeaders = fileHeaders.filter(f => f.name.toLowerCase().endsWith('.zip'));

    console.log(`[rar:${depth}] srts: ${srtHeaders.length}, nested rars: ${rarHeaders.length}, nested zips: ${zipHeaders.length}`);

    // Direct SRTs found — pick best match
    if (srtHeaders.length > 0) {
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
        console.log(`[rar:${depth}] extracted: ${chosen.name}`);
        return Buffer.from(files[0].extraction);
      }
    }

    // No direct SRTs — recurse into nested RARs, best episode match first
    let sortedRarHeaders = rarHeaders;
    if (season && episode) {
      const s = String(season).padStart(2, '0');
      const e = String(episode).padStart(2, '0');
      const patterns = [
        new RegExp(`S${s}E${e}`, 'i'),
        new RegExp(`${season}x${e}`, 'i'),
      ];
      const matched = rarHeaders.filter(f => patterns.some(p => p.test(f.name)));
      const unmatched = rarHeaders.filter(f => !patterns.some(p => p.test(f.name)));
      sortedRarHeaders = [...matched, ...unmatched];
    }
    for (const rarHeader of sortedRarHeaders) {
      console.log(`[rar:${depth}] diving into nested rar: ${rarHeader.name}`);
      const extracted = extractor.extract({ files: [rarHeader.name] });
      const files = [...extracted.files];
      if (files.length && files[0].extraction) {
        const result = await extractSrtFromRar(Buffer.from(files[0].extraction), season, episode, depth + 1);
        if (result) return result;
      }
    }

    // Recurse into nested ZIPs
    for (const zipHeader of zipHeaders) {
      console.log(`[rar:${depth}] diving into nested zip: ${zipHeader.name}`);
      const extracted = extractor.extract({ files: [zipHeader.name] });
      const files = [...extracted.files];
      if (files.length && files[0].extraction) {
        const entry = extractSrtFromZip(Buffer.from(files[0].extraction), season, episode);
        if (entry) return entry.data;
      }
    }

  } catch (e) {
    console.error(`[rar:${depth}] extraction error: ${e.message}`);
  }
  return null;
}

async function extractAllSrtsFromRar(rarBuf, depth = 0) {
  if (depth > 3) return [];
  const results = [];
  try {
    const { createExtractorFromData } = require('node-unrar-js');
    const extractor = await createExtractorFromData({ data: rarBuf });
    const list = extractor.getFileList();
    const fileHeaders = [...list.fileHeaders];
    const srtHeaders = fileHeaders.filter(f => /\.(srt|sub)$/i.test(f.name));
    if (srtHeaders.length > 0) {
      for (const h of srtHeaders) {
        const extracted = extractor.extract({ files: [h.name] });
        const files = [...extracted.files];
        if (files.length && files[0].extraction) {
          results.push({ name: h.name, data: Buffer.from(files[0].extraction) });
        }
      }
      return results;
    }
    const rarHeaders = fileHeaders.filter(f => f.name.toLowerCase().endsWith('.rar'));
    for (const h of rarHeaders) {
      const extracted = extractor.extract({ files: [h.name] });
      const files = [...extracted.files];
      if (files.length && files[0].extraction) {
        const nested = await extractAllSrtsFromRar(Buffer.from(files[0].extraction), depth + 1);
        results.push(...nested);
      }
    }
    const zipHeaders = fileHeaders.filter(f => f.name.toLowerCase().endsWith('.zip'));
    for (const h of zipHeaders) {
      const extracted = extractor.extract({ files: [h.name] });
      const files = [...extracted.files];
      if (files.length && files[0].extraction) {
        const entries = parseZip(Buffer.from(files[0].extraction)).filter(e => /\.(srt|sub)$/i.test(e.name));
        results.push(...entries);
      }
    }
  } catch(e) {
    console.error(`[rar:all:${depth}] error: ${e.message}`);
  }
  return results;
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
        const result = { title: data.Title, year: data.Year ? parseInt(data.Year) : null };
        titleCache.set(imdbId, result);
        return result;
      }
    } catch (e) {
      console.log(`[omdb] error: ${e.message}`);
    }
  }

  // Fallback: scrape IMDb
  try {
    console.log(`[imdb] scraping title for ${imdbId}`);
    const html = await fetchText(`https://www.imdb.com/title/${imdbId}/`);
    const m = html.match(/<title>([^<]+?) \((\d{4})/);
    if (m) {
      const result = { title: m[1].trim(), year: parseInt(m[2]) };
      console.log(`[imdb] found: ${result.title} (${result.year})`);
      titleCache.set(imdbId, result);
      return result;
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
        const result = { title: raw, year: null };
        titleCache.set(imdbId, result);
        return result;
      }
    }
  } catch (e) {
    console.log(`[sabs] imdb search error: ${e.message}`);
  }

  console.log(`[title] failed for ${imdbId}`);
  return null;
}

// ─── subsunacs.net ────────────────────────────────────────────────────────────

const UNACS_BASE = 'https://subsunacs.net';
const YAVKA_BASE = 'https://yavka.net';
const BROWSERLESS_TOKEN = process.env.BROWSERLESS_TOKEN || '';

function fetchPost(urlStr, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const postData = Buffer.from(body, 'utf8');
    const options = {
      hostname: u.hostname,
      port: 443,
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:120.0) Gecko/20100101 Firefox/120.0',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': postData.length,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'bg,en;q=0.5',
        'Referer': UNACS_BASE + '/search.php',
        ...extraHeaders,
      },
    };
    const req = https.request(options, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const loc = res.headers.location.startsWith('http') ? res.headers.location : UNACS_BASE + res.headers.location;
        return fetchBuffer(loc).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ buffer: Buffer.concat(chunks), headers: res.headers }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.write(postData);
    req.end();
  });
}

function filterUnacsResults(results, title, year, imdbId, season, episode) {
  // Priority 1: IMDb ID match
  if (imdbId) {
    const byImdb = results.filter(r => r.rowImdbId === imdbId);
    if (byImdb.length > 0) return byImdb;
  }

  // Priority 2: Episode in slug for series
  if (season && episode) {
    const e = String(episode).padStart(2, '0');
    const epPat = new RegExp(season + 'x' + e, 'i');
    const byEp = results.filter(r => epPat.test(r.subSlug));
    if (byEp.length > 0) return byEp;
  }

  // Priority 3: Title + year match
  const norm = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const normTitle = norm(title);
  const byTitle = results.filter(r => norm(r.subTitle).includes(normTitle));
  const base = byTitle.length > 0 ? byTitle : results;

  if (year) {
    const byYear = base.filter(r => r.rowYear === year);
    if (byYear.length > 0) return byYear;
  }
  return base;
}

async function searchUnacs(title, year, season, episode, imdbId = null) {
  const simplified = title.replace(/\s*:\s*(part|chapter|volume|vol\.?)\s+\w+/i, '').trim();
  const titlesToTry = (simplified !== title) ? [title, simplified] : [title];

  for (const searchTitle of titlesToTry) {
    let query = searchTitle;
    if (season && episode) {
      const e = String(episode).padStart(2, '0');
      query = searchTitle + ' ' + season + 'x' + e;
    }

    const yearParam = year ? String(year) : '0';
    const body = 'm=' + encodeURIComponent(query) + '&l=0&y=' + yearParam + '&t=Submit&action=+%D2%FA%F0%F1%E8+';
    console.log('[unacs] searching: "' + query + '"');

    let html;
    try {
      const { buffer } = await fetchPost(UNACS_BASE + '/search.php', body, { 'Referer': UNACS_BASE + '/index.php' });
      html = decodeWindows1251(buffer);
    } catch (e) {
      console.error('[unacs] search error:', e.message);
      continue;
    }

    const results = [];
    const seen = new Set();

    const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let rowMatch;
    while ((rowMatch = rowRe.exec(html)) !== null) {
      const row = rowMatch[1];

      const linkMatch = row.match(/href="\/subtitles\/([^/]+)-(\d+)\/"/i);
      if (!linkMatch) continue;

      const subSlugText = linkMatch[1];
      const subId = linkMatch[2];
      const subSlug = subSlugText + '-' + subId;
      if (seen.has(subId)) continue;
      seen.add(subId);

      const titleMatch = row.match(/href="\/subtitles\/[^"]+">([^<]+)<\/a>/i);
      const subTitle = titleMatch ? titleMatch[1].trim() : subSlug;

      // Language detection
      let lang = 'bul';
      if (/english|англ/i.test(row)) lang = 'eng';

      // IMDb ID extraction from image path
      const imdbMatch = row.match(/\/ii\/big\/(\d+)\.jpg/i);
      const rowImdbId = imdbMatch ? 'tt' + imdbMatch[1].replace(/^0+/, '').padStart(7, '0') : null;

      // Year extraction
      const yearMatch = subTitle.match(/(19|20)\d{2}/);
      const rowYear = yearMatch ? parseInt(yearMatch[0]) : null;

      results.push({ subId, subSlug, subTitle, lang, rowImdbId, rowYear });
    }

    console.log('[unacs] parsed ' + results.length + ' results');
    if (results.length === 0) continue;

    // Filter by IMDb ID, exact title, or loose match
    const filtered = filterUnacsResults(results, title, year, imdbId, season, episode);
    if (filtered.length > 0) return filtered;

    // Try simplified title filter too
    if (simplified !== title) {
      const filteredSimple = filterUnacsResults(results, simplified, year, imdbId, season, episode);
      if (filteredSimple.length > 0) return filteredSimple;
    }

    if (results.length > 0) return results.slice(0, 8);
  }
  return [];
}


async function downloadUnacs(subSlug, season, episode) {
  const url = `${UNACS_BASE}/subtitles/${subSlug}/`;
  console.log(`[unacs] downloading ${url}`);

  const { buffer, headers } = await fetchBuffer(url, {
    'Referer': `${UNACS_BASE}/subtitles/${subSlug}/!`,
    'Accept': 'application/octet-stream,*/*',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:120.0) Gecko/20100101 Firefox/120.0',
  });

  const ct = (headers['content-type'] || '').toLowerCase();
  const cd = (headers['content-disposition'] || '').toLowerCase();

  // Detect format by magic bytes first, fall back to headers
  const magic4 = buffer.slice(0, 4);
  const isZipMagic = magic4[0] === 0x50 && magic4[1] === 0x4b;
  const isRarMagic = magic4[0] === 0x52 && magic4[1] === 0x61 && magic4[2] === 0x72 && magic4[3] === 0x21;
  const isRar = isRarMagic || cd.includes('.rar') || ct.includes('rar');
  const isZip = isZipMagic || cd.includes('.zip') || ct.includes('zip');

  console.log(`[unacs] ct: ${ct}, cd: ${cd}, isZip: ${isZip}, isRar: ${isRar}, size: ${buffer.length}`);

  if (isRar) {
    if (season && episode) {
      const data = await extractSrtFromRar(buffer, season, episode);
      return data ? [{ name: subSlug, data }] : [];
    }
    return await extractAllSrtsFromRar(buffer);
  }

  if (isZip) {
    const entries = parseZip(buffer).filter(e => /\.(srt|sub)$/i.test(e.name));
    if (entries.length) return entries;
    console.log(`[unacs] no srt found in zip`);
    return [];
  }

  // Maybe bare SRT
  const str = buffer.slice(0, 30).toString('latin1');
  if (/^\s*\d/.test(str) || str.includes('-->')) return [{ name: subSlug + '.srt', data: buffer }];

  return [];
}

// ─── Proxy endpoint ───────────────────────────────────────────────────────────

const srtCache = new Map();

async function buildSrtProxies(attachId, season, episode) {
  const baseKey = `${attachId}-${season}-${episode}`;
  // Check if already cached
  const cachedKeys = [...srtCache.keys()].filter(k => k === baseKey || k.startsWith(baseKey + '-i'));
  if (cachedKeys.length > 0) return cachedKeys;

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

  const keys = [];
  if (isZip) {
    const entries = extractAllSrtsFromZip(buffer, season, episode);
    for (let i = 0; i < entries.length; i++) {
      const key = entries.length === 1 ? baseKey : `${baseKey}-i${i}`;
      console.log(`[proxy] extracted srt: ${entries[i].name}`);
      srtCache.set(key, toUtf8Srt(entries[i].data));
      keys.push(key);
    }
  } else if (isRar) {
    try {
      const srtData = await extractSrtFromRar(buffer, season, episode);
      if (srtData) {
        srtCache.set(baseKey, toUtf8Srt(srtData));
        keys.push(baseKey);
      }
    } catch (e) {
      console.error(`[proxy] rar extraction error: ${e.message}`);
    }
  } else {
    srtCache.set(baseKey, toUtf8Srt(buffer));
    keys.push(baseKey);
  }
  return keys;
}

// ─── Yavka.net via Browserless ───────────────────────────────────────────────

function browserlessPost(urlPath, body, isJson, timeoutMs = 45000) {
  if (!BROWSERLESS_TOKEN) throw new Error('No browserless token configured');
  const postData = Buffer.from(isJson ? JSON.stringify(body) : body);
  return new Promise((resolve, reject) => {
    const u = new URL('https://production-sfo.browserless.io' + urlPath + '?token=' + BROWSERLESS_TOKEN);
    const req = https.request({
      hostname: u.hostname, port: 443,
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'Content-Type': isJson ? 'application/json' : 'application/javascript',
        'Content-Length': postData.length,
      },
    }, (res) => {
      const chunks = [];
      console.log('[browserless]', urlPath, 'HTTP status:', res.statusCode);
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        resolve({ status: res.statusCode, raw, text: raw.toString('utf8') });
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('Browserless timeout')); });
    req.write(postData);
    req.end();
  });
}

async function searchYavka(imdbId, title, season, episode) {
  try {
    // Use subtitles.php with IMDb ID for both movies and series
    let searchUrl = YAVKA_BASE + '/subtitles.php?s=&i=' + imdbId + '&l=';
    if (season && episode) {
      const e = String(episode).padStart(2, '0');
      searchUrl += '&e=' + season + 'x' + e;
    }
    console.log('[yavka] searching:', searchUrl);

    // POST search form via BQL (stealth handles Cloudflare)
    const postBody = 'sea=' + encodeURIComponent(title) + '&i=' + imdbId + '&l=BG&y=&c=&u=&g=&cf-turnstile-response=&search=%EF%80%82+%D0%A2%D1%8A%D1%80%D1%81%D0%B5%D0%BD%D0%B5';
    const bql = { query: `mutation SearchYavka {\n        goto(url: "https://yavka.net/search", waitUntil: networkIdle) { status }\n        evaluate(content: """\n          (async () => {\n            const r = await fetch('https://yavka.net/search', {\n              method: 'POST',\n              headers: { 'Content-Type': 'application/x-www-form-urlencoded' },\n              body: '${postBody}',\n              credentials: 'include'\n            });\n            return await r.text();\n          })()\n        """) { value }\n      }` };
    const { status, text } = await browserlessPost('/stealth/bql', bql, true, 40000);
    console.log('[yavka] BQL search status:', status, 'response len:', text.length);
    if (status !== 200) { console.log('[yavka] BQL search failed:', text.slice(0, 300)); return []; }
    let bqlResult;
    try { bqlResult = JSON.parse(text); } catch(e) { console.log('[yavka] BQL parse error:', text.slice(0, 200)); return []; }
    const html = bqlResult && bqlResult.data && bqlResult.data.evaluate && bqlResult.data.evaluate.value || '';
    console.log('[yavka] html length:', html.length, html ? 'snippet: ' + html.slice(0, 200).replace(/\s+/g, ' ') : '(empty)');
    if (!html) { console.log('[yavka] empty html from BQL:', JSON.stringify(bqlResult).slice(0, 400)); return []; }

    const results = [];
    const seen = new Set();
    // Only parse links inside the subtitles results table, not the sidebar
    const tableMatch = html.match(/<table[^>]*class="[^"]*subtitles[^"]*"[^>]*>([\s\S]*?)<\/table>/i);
    const searchArea = tableMatch ? tableMatch[1] : html;
    const linkRe = /href="\/subs\/(\d+)\/BG[^"]*"/gi;
    let m;
    while ((m = linkRe.exec(searchArea)) !== null) {
      const subId = m[1];
      if (seen.has(subId)) continue;
      seen.add(subId);
      const start = Math.max(0, m.index - 500);
      const snippet = searchArea.slice(start, m.index + 500);
      const titleMatch = snippet.match(/tooltiptitle="([^"]+)"/i) || snippet.match(/>([^<]{5,60})<\/a>/i);
      const subTitle = titleMatch ? titleMatch[1].trim() : ('Yavka #' + subId);
      // Also capture the full row text for episode matching
      const rowText = snippet;
      results.push({ subId, subTitle, rowText, downloadPath: '/subs/' + subId + '/BG/' });
    }
    console.log('[yavka] parsed', results.length, 'results');
    if (results.length > 0) {
      console.log('[yavka] titles:', results.map(r => r.subTitle).join(' | '));
      console.log('[yavka] row classes:', results.map(r => (r.rowText.match(/class="([^"]*season[^"]*)"/i) || [])[1] || '?').join(' | '));
      console.log('[yavka] row0:', results[0].rowText.replace(/\s+/g, ' ').slice(0, 800));
      if (results[1]) console.log('[yavka] row1:', results[1].rowText.replace(/\s+/g, ' ').slice(0, 800));
    }

    // For series: filter results by episode if we have S/E info
    if (season && episode && results.length > 1) {
      const s = String(season).padStart(2, '0');
      const e = String(episode).padStart(2, '0');
      const epPat = new RegExp('s' + s + 'e' + e + '|' + season + 'x' + e, 'i');
      const filtered = results.filter(r => epPat.test(r.subTitle) || epPat.test(r.rowText));
      if (filtered.length > 0) {
        console.log('[yavka] episode filtered to', filtered.length, 'results');
        return filtered;
      }
    }

    return results;
  } catch(e) {
    console.error('[yavka] search error:', e.message);
    return [];
  }
}

async function downloadYavka(downloadPath) {
  try {
    const pageUrl = YAVKA_BASE + downloadPath.replace(/\/$/, '');
    const postUrl = YAVKA_BASE + downloadPath;
    console.log('[yavka] downloading via BrowserQL:', pageUrl);

    // BrowserQL: navigate with stealth, solve Cloudflare Turnstile, fetch the file
    const bql = {
      query: `mutation DownloadSub {
        goto(url: "${pageUrl}", waitUntil: networkIdle) { status }
        evaluate(content: """
          (async () => {
            const form = document.querySelector('form');
            const params = new URLSearchParams();
            if (form) {
              for (const [k, v] of new FormData(form).entries()) params.append(k, v);
            }
            params.set('lng', 'BG');
            const r = await fetch('${postUrl}', {
              method: 'POST',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              body: params.toString(),
              credentials: 'include'
            });
            const ab = await r.arrayBuffer();
            const bytes = Array.from(new Uint8Array(ab));
            const ct = r.headers.get('content-type') || '';
            const cd = r.headers.get('content-disposition') || '';
            return JSON.stringify({ bytes, ct, cd });
          })()
        """) { value }
      }`
    };

    const { status, text } = await browserlessPost('/stealth/bql', bql, true, 60000);
    if (status !== 200) { console.log('[yavka] BQL failed, status:', status, text.slice(0, 300)); return null; }

    let bqlResult;
    try { bqlResult = JSON.parse(text); } catch(e) { console.log('[yavka] BQL parse error:', text.slice(0, 300)); return null; }

    const evalValue = bqlResult && bqlResult.data && bqlResult.data.evaluate && bqlResult.data.evaluate.value;
    if (!evalValue) { console.log('[yavka] BQL no evaluate value:', text.slice(0, 500)); return null; }

    let payload;
    try { payload = JSON.parse(evalValue); } catch(e) { console.log('[yavka] payload parse error:', String(evalValue).slice(0, 200)); return null; }

    if (!payload.bytes || !payload.bytes.length) { console.log('[yavka] empty bytes'); return null; }

    const buffer = Buffer.from(payload.bytes);
    console.log('[yavka] got', buffer.length, 'bytes, ct=' + payload.ct);

    const magic4 = buffer.slice(0, 4);
    const isZip = magic4[0] === 0x50 && magic4[1] === 0x4b;
    const isRar = magic4[0] === 0x52 && magic4[1] === 0x61 && magic4[2] === 0x72 && magic4[3] === 0x21;

    if (isRar) return await extractSrtFromRar(buffer, null, null);
    if (isZip) {
      const entry = extractSrtFromZip(buffer, null, null);
      return entry ? entry.data : null;
    }
    const str = buffer.slice(0, 30).toString('latin1');
    if (/^\s*\d/.test(str) || str.includes('-->')) return buffer;
    return null;
  } catch(e) {
    console.error('[yavka] download error:', e.message);
    return null;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function parseRequest(id) {
  const decodedId = decodeURIComponent(id);
  const parts = decodedId.split(':');
  const imdbId = parts[0].split('/')[0];
  const season = parts[1] ? parseInt(parts[1]) : null;
  const episode = parts[2] ? parseInt(parts[2]) : null;
  return { imdbId, season, episode };
}

// ─── Router ───────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);
  const path = u.pathname;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');

  // Manifests
  if (path === '/sabs/manifest.json') {
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify(MANIFEST_SABS));
  }
  if (path === '/unacs/manifest.json') {
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify(MANIFEST_UNACS));
  }
  if (path === '/yavka/manifest.json') {
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify(MANIFEST_YAVKA));
  }
  // Legacy route
  if (path === '/manifest.json') {
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify(MANIFEST_SABS));
  }

  // Proxy
  const proxyMatch = path.match(/^\/proxy\/(.+)\.srt$/);
  if (proxyMatch) {
    const key = decodeURIComponent(proxyMatch[1]);
    let data = srtCache.get(key);
    if (!data && key.startsWith('yavka__')) {
      const subId = key.split('__')[1];
      console.log(`[proxy] cache miss, re-downloading yavka: ${subId}`);
      try {
        const d = await downloadYavka(`/subs/${subId}/BG/`);
        if (d) { data = toUtf8Srt(d); srtCache.set(key, data); }
      } catch(e) { console.error('[proxy] yavka re-download failed:', e.message); }
    }
    if (!data && key.startsWith('unacs__')) {
      const parts = key.split('__');
      const subSlug = parts[1];
      const season = parts[2] !== 'n' ? parseInt(parts[2]) : null;
      const episode = parts[3] !== 'n' ? parseInt(parts[3]) : null;
      const entryIdx = parts[4] !== undefined ? parseInt(parts[4]) : null;
      console.log(`[proxy] cache miss, re-downloading unacs: ${subSlug}`);
      try {
        const entries = await downloadUnacs(subSlug, season, episode);
        if (entries.length) {
          const entry = entryIdx !== null ? entries[entryIdx] : entries[0];
          if (entry) { data = entry.data; srtCache.set(key, toUtf8Srt(data)); }
        }
      } catch (e) {
        console.error('[proxy] unacs re-download failed:', e.message);
      }
    }
    if (!data) {
      res.writeHead(404);
      return res.end('Not found');
    }
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.end(data);
  }

  // SAB subtitles
  const sabsMatch = path.match(/^\/sabs\/subtitles\/(\w+)\/(.+)\.json$/);
  if (sabsMatch) {
    const [, type, id] = sabsMatch;
    const { imdbId, season, episode } = parseRequest(id);
    console.log(`[sabs request] ${type} ${imdbId} S${season}E${episode}`);

    const titleInfo = await getTitleFromImdb(imdbId);
    if (!titleInfo) return res.end(JSON.stringify({ subtitles: [] }));
    const { title, year } = titleInfo;
    console.log(`[title] "${title}" (${year})`);

    const sabsResults = await searchSubtitles(imdbId, title, year, season, episode).catch(e => { console.error('[sabs] search failed:', e.message); return []; });
    console.log(`[sabs found] ${sabsResults.length}`);

    const host = req.headers.host || `localhost:${PORT}`;
    const subtitles = [];
    for (const s of sabsResults.slice(0, 8)) {
      if (subtitles.length >= 10) break;
      try {
        const keys = await buildSrtProxies(s.attachId, season, episode);
        for (let i = 0; i < keys.length; i++) {
          const srtName = s.title + (s.fps ? ` • ${s.fps}fps` : '') + (keys.length > 1 ? ` [${i+1}]` : '');
          subtitles.push({
            id: `sabsub-${s.attachId}-${i}`,
            url: `https://${host}/proxy/${encodeURIComponent(keys[i])}.srt`,
            lang: s.lang,
            name: srtName,
          });
          if (subtitles.length >= 10) break;
        }
      } catch (e) {
        console.error(`[sabs proxy] error for ${s.attachId}:`, e.message);
      }
    }
    console.log(`[sabs response] ${subtitles.length} subtitles`);
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ subtitles }));
  }

  // UNACS subtitles
  const unacsMatch = path.match(/^\/unacs\/subtitles\/(\w+)\/(.+)\.json$/);
  if (unacsMatch) {
    const [, type, id] = unacsMatch;
    const { imdbId, season, episode } = parseRequest(id);
    console.log(`[unacs request] ${type} ${imdbId} S${season}E${episode}`);

    const titleInfo = await getTitleFromImdb(imdbId);
    if (!titleInfo) return res.end(JSON.stringify({ subtitles: [] }));
    const { title, year } = titleInfo;
    console.log(`[title] "${title}" (${year})`);

    const unacsResults = await searchUnacs(title, year, season, episode, imdbId).catch(e => { console.error('[unacs] search failed:', e.message); return []; });
    console.log(`[unacs found] ${unacsResults.length}`);

    const host = req.headers.host || `localhost:${PORT}`;
    const subtitles = [];
    for (const s of unacsResults.slice(0, 8)) {
      if (subtitles.length >= 10) break;
      try {
        const baseKey = `unacs__${s.subSlug}__${season ?? 'n'}__${episode ?? 'n'}`;
        const cachedKeys = [...srtCache.keys()].filter(k => k.startsWith(baseKey));
        if (cachedKeys.length > 0) {
          for (const k of cachedKeys) {
            subtitles.push({ id: `unacs-${s.subId}-${k}`, url: `https://${host}/proxy/${encodeURIComponent(k)}.srt`, lang: s.lang, name: s.subTitle });
          }
          continue;
        }
        const entries = await downloadUnacs(s.subSlug, season, episode);
        if (!entries.length) continue;
        for (let i = 0; i < entries.length; i++) {
          const key = entries.length === 1 ? baseKey : `${baseKey}__${i}`;
          srtCache.set(key, toUtf8Srt(entries[i].data));
          const srtName = entries[i].name.split('/').pop().replace(/\.(srt|sub)$/i, '');
          subtitles.push({ id: `unacs-${s.subId}-${i}`, url: `https://${host}/proxy/${encodeURIComponent(key)}.srt`, lang: s.lang, name: srtName || s.subTitle });
          if (subtitles.length >= 10) break;
        }
      } catch (e) {
        console.error(`[unacs proxy] error for ${s.subSlug}:`, e.message);
      }
    }
    console.log(`[unacs response] ${subtitles.length} subtitles`);
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ subtitles }));
  }

  // Yavka subtitles
  const yavkaMatch = path.match(/^\/yavka\/subtitles\/(\w+)\/(.+)\.json$/);
  if (yavkaMatch) {
    const [, type, id] = yavkaMatch;
    const { imdbId, season, episode } = parseRequest(id);
    console.log(`[yavka request] ${type} ${imdbId} S${season}E${episode}`);

    const titleInfo = await getTitleFromImdb(imdbId);
    if (!titleInfo) return res.end(JSON.stringify({ subtitles: [] }));
    const { title } = titleInfo;
    console.log(`[title] "${title}"`);

    const yavkaResults = await searchYavka(imdbId, title, season, episode).catch(e => { console.error('[yavka] search failed:', e.message); return []; });
    console.log(`[yavka found] ${yavkaResults.length}`);

    const host = req.headers.host || `localhost:${PORT}`;
    const subtitles = [];
    for (const s of yavkaResults.slice(0, 8)) {
      try {
        const key = `yavka__${s.subId}`;
        if (!srtCache.has(key)) {
          const data = await downloadYavka(s.downloadPath);
          if (!data) continue;
          srtCache.set(key, toUtf8Srt(data));
        }
        subtitles.push({
          id: `yavka-${s.subId}`,
          url: `https://${host}/proxy/${encodeURIComponent(key)}.srt`,
          lang: 'bul',
          name: s.subTitle,
        });
      } catch(e) {
        console.error(`[yavka proxy] error for ${s.subId}:`, e.message);
      }
    }
    console.log(`[yavka response] ${subtitles.length} subtitles`);
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ subtitles }));
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════════╗
║         BG Subtitles — Stremio Addon                 ║
╠══════════════════════════════════════════════════════╣
║  SAB:   https://sub-gatherer.onrender.com/sabs/manifest.json  ║
║  UNACS: https://sub-gatherer.onrender.com/unacs/manifest.json ║
║  YAVKA: https://sub-gatherer.onrender.com/yavka/manifest.json ║
╚══════════════════════════════════════════════════════╝
`);
});
