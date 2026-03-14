const express = require('express');
const https = require('https');
const NodeCache = require('node-cache');

const app = express();
const cache = new NodeCache({ stdTTL: 3600 }); // 1 saatlik cache

const PORT = process.env.PORT || 7000;
const TOKEN = process.env.DIZPAL_TOKEN || '9iQNC5HQwPlaFuJDkhncJ5XTJ8feGXOJatAA';
const API_BASE = 'ydfvfdizipanel.ru';

// ─── Manifest ────────────────────────────────────────────────────────────────

const MANIFEST = {
  id: 'com.dizipalorijinal.addon',
  version: '1.0.0',
  name: '🇹🇷 DiziPal Orijinal',
  description: 'Türkçe dublaj diziler — DiziPal Orijinal kaynağından',
  logo: 'https://www.google.com/s2/favicons?domain=dizipal1542.com&sz=128',
  resources: ['catalog', 'meta', 'stream'],
  types: ['series'],
  catalogs: [
    {
      type: 'series',
      id: 'dizipalorijinal',
      name: '🇹🇷 Türkçe Dublaj Diziler',
      extra: [{ name: 'search', isRequired: false }],
    },
  ],
  idPrefixes: ['tt'],
  behaviorHints: { adult: false, configurable: false },
};

// ─── API yardımcı fonksiyonu ──────────────────────────────────────────────────

function apiGet(path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: API_BASE,
      path,
      headers: {
        'Accept': 'application/json',
        'Accept-Encoding': 'identity',
      },
    };
    https.get(options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('JSON parse hatası')); }
      });
    }).on('error', reject);
  });
}

// ─── Tüm bölümleri çek ve cache'le ─────────────────────────────────────────

async function fetchAllEpisodes() {
  const cacheKey = 'all_episodes';
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  console.log('[API] Bölümler yükleniyor...');

  // Önce toplam sayfa sayısını öğren
  const first = await apiGet(`/public/api/media/seriesEpisodesAll/${TOKEN}?page=1`);
  const totalPages = first.last_page;
  const allEpisodes = [...first.data];

  // Paralel olarak tüm sayfaları çek (10'ar 10'ar)
  const BATCH = 10;
  for (let start = 2; start <= totalPages; start += BATCH) {
    const end = Math.min(start + BATCH - 1, totalPages);
    const pages = [];
    for (let p = start; p <= end; p++) pages.push(p);

    const results = await Promise.all(
      pages.map(p => apiGet(`/public/api/media/seriesEpisodesAll/${TOKEN}?page=${p}`))
    );
    results.forEach(r => { if (r.data) allEpisodes.push(...r.data); });

    if (start % 100 === 2) {
      console.log(`[API] Sayfa ${end}/${totalPages} yüklendi...`);
    }
  }

  console.log(`[API] Toplam ${allEpisodes.length} bölüm yüklendi.`);
  cache.set(cacheKey, allEpisodes);
  return allEpisodes;
}

// ─── Dizileri unique ID'ye göre grupla ──────────────────────────────────────

function groupBySeries(episodes) {
  const seriesMap = new Map();
  for (const ep of episodes) {
    if (!seriesMap.has(ep.id)) {
      seriesMap.set(ep.id, {
        id: ep.id,
        imdb_id: ep.imdb_external_id,
        name: ep.name,
        poster: ep.poster_path,
        genre: ep.genre_name,
        episodes: [],
      });
    }
    seriesMap.get(ep.id).episodes.push(ep);
  }
  return seriesMap;
}

// ─── Startup: arka planda veriyi yükle ──────────────────────────────────────

let dataReady = false;
let seriesMap = new Map();

async function loadData() {
  try {
    const episodes = await fetchAllEpisodes();
    seriesMap = groupBySeries(episodes);
    dataReady = true;
    console.log(`[Hazır] ${seriesMap.size} dizi yüklendi.`);
  } catch (e) {
    console.error('[Hata] Veri yüklenemedi:', e.message);
    setTimeout(loadData, 30000); // 30 saniye sonra tekrar dene
  }
}

loadData();

// ─── CORS ────────────────────────────────────────────────────────────────────

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  next();
});

// ─── Routes ──────────────────────────────────────────────────────────────────

app.get('/', (req, res) => res.redirect('/manifest.json'));

app.get('/manifest.json', (req, res) => {
  res.json(MANIFEST);
});

// Catalog — sayfalama + arama
app.get('/catalog/:type/:id/:extra?.json', async (req, res) => {
  const { type, id } = req.params;
  if (type !== 'series' || id !== 'dizipalorijinal') {
    return res.json({ metas: [] });
  }

  if (!dataReady) {
    return res.json({ metas: [] });
  }

  // Extra parametreleri parse et
  let search = null;
  let skip = 0;
  if (req.params.extra) {
    const extra = decodeURIComponent(req.params.extra);
    const searchMatch = extra.match(/search=([^&]+)/);
    const skipMatch = extra.match(/skip=(\d+)/);
    if (searchMatch) search = decodeURIComponent(searchMatch[1]).toLowerCase();
    if (skipMatch) skip = parseInt(skipMatch[1]);
  }

  let series = [...seriesMap.values()];

  // Arama filtresi
  if (search) {
    series = series.filter(s => s.name.toLowerCase().includes(search));
  }

  // Sayfalama (Stremio 100'er 100'er ister)
  const PAGE_SIZE = 100;
  const page = series.slice(skip, skip + PAGE_SIZE);

  const metas = page.map(s => ({
    id: s.imdb_id,
    type: 'series',
    name: s.name,
    poster: s.poster,
    genres: s.genre ? [s.genre] : [],
    description: `🇹🇷 Türkçe Dublaj | ${s.episodes.length} bölüm`,
  }));

  res.json({ metas });
});

// Meta — dizi detayı ve bölüm listesi
app.get('/meta/:type/:id.json', async (req, res) => {
  const { type, id } = req.params;
  if (type !== 'series') return res.json({ meta: null });

  if (!dataReady) return res.json({ meta: null });

  // IMDb ID ile dizi bul
  const series = [...seriesMap.values()].find(s => s.imdb_id === id);
  if (!series) return res.json({ meta: null });

  // Bölümleri season ve episode numarasına göre sırala
  const sorted = [...series.episodes].sort((a, b) => {
    if (a.season_number !== b.season_number) return a.season_number - b.season_number;
    return a.episode_number - b.episode_number;
  });

  const videos = sorted.map(ep => ({
    id: `${id}:${ep.season_number}:${ep.episode_number}`,
    title: ep.episode_name || `${ep.seasons_name} ${ep.episode_number}. Bölüm`,
    season: ep.season_number,
    episode: ep.episode_number,
    thumbnail: ep.still_path || ep.poster_path,
    released: new Date(0).toISOString(),
  }));

  const meta = {
    id,
    type: 'series',
    name: series.name,
    poster: series.poster,
    genres: series.genre ? [series.genre] : [],
    description: `🇹🇷 Türkçe Dublaj\n${series.episodes.length} bölüm`,
    videos,
  };

  res.json({ meta });
});

// Stream — bölüm linkleri
app.get('/stream/:type/:id.json', async (req, res) => {
  const { type, id } = req.params;
  if (type !== 'series') return res.json({ streams: [] });

  if (!dataReady) return res.json({ streams: [] });

  // id formatı: tt1234567:1:3 (imdb:season:episode)
  const parts = id.split(':');
  if (parts.length < 3) return res.json({ streams: [] });

  const imdbId = parts[0];
  const season = parseInt(parts[1]);
  const episode = parseInt(parts[2]);

  const series = [...seriesMap.values()].find(s => s.imdb_id === imdbId);
  if (!series) return res.json({ streams: [] });

  const ep = series.episodes.find(
    e => e.season_number === season && e.episode_number === episode
  );
  if (!ep) return res.json({ streams: [] });

  const streams = [];

  // Direkt indir linki (Mediafire vb.)
  if (ep.link && ep.embed === 0 && ep.hls === 0) {
    streams.push({
      name: '🇹🇷 DiziPal',
      title: `${ep.server} — ${ep.episode_name || ''}`,
      externalUrl: ep.link,
      behaviorHints: { notWebReady: true },
    });
  }

  // HLS stream
  if (ep.hls === 1 && ep.link) {
    streams.push({
      name: '🇹🇷 DiziPal',
      title: `📺 HLS — ${ep.episode_name || ''}`,
      url: ep.link,
    });
  }

  // Embed linki
  if (ep.embed === 1 && ep.link) {
    streams.push({
      name: '🇹🇷 DiziPal',
      title: `▶️ Oynat — ${ep.episode_name || ''}`,
      externalUrl: ep.link,
    });
  }

  res.json({ streams });
});

// Durum sayfası
app.get('/status', (req, res) => {
  res.json({
    ready: dataReady,
    series: seriesMap.size,
    episodes: [...seriesMap.values()].reduce((acc, s) => acc + s.episodes.length, 0),
  });
});

// ─── Sunucu ──────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n🇹🇷 DiziPal Orijinal Addon`);
  console.log(`📡 http://localhost:${PORT}/manifest.json`);
  console.log(`⏳ Veri yükleniyor, lütfen bekleyin...\n`);
});
