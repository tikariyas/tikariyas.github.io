import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const HOST = '0.0.0.0';

function getGeminiClient() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

const BLOCKED_PREFIXES = ['/node_modules', '/.git', '/.aistudio'];
const BLOCKED_FILES = new Set([
  '/server.js',
  '/package.json',
  '/package-lock.json',
  '/metadata.json',
  '/.env',
  '/.env.local',
  '/.env.example',
]);

app.use(express.json({ limit: '256kb' }));

app.use((req, res, next) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
  const reqPath = req.path.toLowerCase();
  if (
    BLOCKED_FILES.has(reqPath) ||
    BLOCKED_PREFIXES.some((prefix) => reqPath === prefix || reqPath.startsWith(`${prefix}/`))
  ) {
    return res.status(404).send('Not found');
  }
  next();
});

const META_CACHE = new Map();
const INFLIGHT_META = new Map();
const MODEL_COOLDOWN_UNTIL = new Map();
const META_MODELS = ['gemini-3.1-flash-lite', 'gemini-4-hydrogen'];

function parseRetryDelaySeconds(err) {
  const msg = String(err?.message || '');
  const mSec = msg.match(/"retryDelay"\s*:\s*"(\d+)s"/i) || msg.match(/retry in\s+(\d+(?:\.\d+)?)s/i);
  if (mSec) return Math.max(5, Math.ceil(parseFloat(mSec[1])));
  const mHr = msg.match(/retry in\s+(\d+)h(\d+)m/i);
  if (mHr) return Math.max(60, Number(mHr[1]) * 3600 + Number(mHr[2]) * 60);
  return 45;
}

async function fetchSongMetaFromGemini(ai, songTitle) {
  const prompt = `Provide accurate discography metadata for the song titled: "${songTitle}".
If this is an Indian film (Hindi/Bollywood, Marathi, Bengali, Tamil, Telugu, etc.), ghazal, bhajan, or popular song, fill every known field cleanly in Title Case.
Return an empty string "" for any field you are not confident about. For yr, return only a 4-digit year (e.g. "1975") or "".`;

  const responseSchema = {
    type: Type.OBJECT,
    properties: {
      orig: {
        type: Type.STRING,
        description: 'Original playback singer(s), comma-separated (e.g. Kishore Kumar, Lata Mangeshkar).',
      },
      comp: {
        type: Type.STRING,
        description: 'Music composer / director(s) (e.g. R. D. Burman, Shankar Jaikishan).',
      },
      lyr: {
        type: Type.STRING,
        description: 'Lyricist(s) (e.g. Anand Bakshi, Majrooh Sultanpuri).',
      },
      mov: {
        type: Type.STRING,
        description: 'Movie or album name (e.g. Sholay, Anari).',
      },
      yr: {
        type: Type.STRING,
        description: '4-digit releasing year (e.g. 1975), or empty string if unknown.',
      },
      act: {
        type: Type.STRING,
        description: 'Lead actor / star(s) featured in the song (e.g. Rajesh Khanna, Amitabh Bachchan).',
      },
    },
    required: ['orig', 'comp', 'lyr', 'mov', 'yr', 'act'],
  };

  let lastErr = null;
  let minCooldownSec = null;

  for (const model of META_MODELS) {
    const until = MODEL_COOLDOWN_UNTIL.get(model) || 0;
    const now = Date.now();
    if (until > now) {
      const rem = Math.ceil((until - now) / 1000);
      minCooldownSec = minCooldownSec == null ? rem : Math.min(minCooldownSec, rem);
      continue;
    }

    try {
      const config = {
        systemInstruction:
          'You are a music archivist specializing in Indian film songs (classic and modern Bollywood, regional cinema, ghazals, devotional songs) and global popular songs. Return accurate, concise JSON metadata without extra commentary.',
        responseMimeType: 'application/json',
        responseSchema,
      };
      if (model === 'gemini-3.1-flash-lite') {
        config.thinkingConfig = { thinkingLevel: ThinkingLevel.MINIMAL };
      } else {
        config.thinkingConfig = { thinkingLevel: ThinkingLevel.LOW };
      }

      const response = await ai.models.generateContent({
        model,
        contents: prompt,
        config,
      });

      const raw = (response.text ?? '{}').trim();
      const parsed = JSON.parse(raw);
      const yrClean = String(parsed.yr ?? '').replace(/[^\d]/g, '').slice(0, 4);
      return {
        meta: {
          orig: String(parsed.orig ?? '').trim(),
          comp: String(parsed.comp ?? '').trim(),
          lyr: String(parsed.lyr ?? '').trim(),
          mov: String(parsed.mov ?? '').trim(),
          yr: yrClean.length === 4 ? yrClean : '',
          act: String(parsed.act ?? '').trim(),
        },
        model,
      };
    } catch (err) {
      lastErr = err;
      const status = err?.status || err?.statusCode || 0;
      if (status === 429) {
        const delaySec = parseRetryDelaySeconds(err);
        MODEL_COOLDOWN_UNTIL.set(model, Date.now() + delaySec * 1000);
        minCooldownSec = minCooldownSec == null ? delaySec : Math.min(minCooldownSec, delaySec);
        console.warn(`Gemini ${model} rate-limited (cooldown ${delaySec}s); trying fallback if available.`);
        continue;
      }
      if (status >= 500 || status === 404) {
        console.warn(`Gemini ${model} unavailable (${status}); trying fallback if available.`);
        continue;
      }
      throw err;
    }
  }

  if (minCooldownSec != null) {
    const rateErr = new Error(
      minCooldownSec > 120
        ? `Free-tier daily AI limit reached. Try again later or attach a billing-enabled API key in Settings > Secrets.`
        : `AI rate limit reached. Please try again in ~${minCooldownSec} seconds (or use a billing-enabled key in Settings > Secrets for higher quota).`
    );
    rateErr.status = 429;
    rateErr.retryAfterSec = minCooldownSec;
    throw rateErr;
  }

  throw lastErr || new Error('Failed to fetch song metadata from AI.');
}

app.use('/api', (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

async function handleSongMetadataRequest(req, res) {
  const rawTitle =
    typeof req.body?.songTitle === 'string'
      ? req.body.songTitle.trim()
      : typeof req.query?.songTitle === 'string'
        ? req.query.songTitle.trim()
        : '';
  const forceRefresh = req.body?.force === true || req.query?.force === '1' || req.query?.force === 'true';
  if (!rawTitle) {
    return res.status(400).json({ error: 'Please enter a song title first.' });
  }

  const cacheKey = rawTitle.toUpperCase();
  if (!forceRefresh && META_CACHE.has(cacheKey)) {
    return res.json({ meta: META_CACHE.get(cacheKey), cached: true });
  }

  const ai = getGeminiClient();
  if (!ai) {
    return res.status(503).json({
      error: 'AI metadata service is not configured. Please check GEMINI_API_KEY in Settings > Secrets.',
    });
  }

  try {
    let promise = !forceRefresh ? INFLIGHT_META.get(cacheKey) : null;
    if (!promise) {
      promise = fetchSongMetaFromGemini(ai, rawTitle).finally(() => {
        if (INFLIGHT_META.get(cacheKey) === promise) INFLIGHT_META.delete(cacheKey);
      });
      INFLIGHT_META.set(cacheKey, promise);
    }

    const result = await promise;
    if (result?.meta && Object.values(result.meta).some((v) => String(v || '').trim())) {
      if (META_CACHE.size > 1000) {
        const firstKey = META_CACHE.keys().next().value;
        META_CACHE.delete(firstKey);
      }
      META_CACHE.set(cacheKey, result.meta);
    }
    return res.json({ meta: result.meta });
  } catch (err) {
    const status = err?.status || err?.statusCode;
    if (status === 429) {
      return res.status(429).json({
        error: err.message || 'AI rate limit reached. Please try again in a moment.',
        retryAfterSec: err.retryAfterSec || 45,
      });
    }
    console.error('Gemini song-metadata error:', err?.message || err);
    if (status === 400 || status === 403) {
      return res.status(status).json({
        error: 'AI API key error. Please check your key in Settings > Secrets.',
      });
    }
    return res.status(502).json({
      error: err?.message || 'Failed to fetch song metadata from AI.',
    });
  }
}

app.post('/api/song-metadata', handleSongMetadataRequest);
app.get('/api/song-metadata', handleSongMetadataRequest);

app.use(
  '/.well-known',
  express.static(path.join(__dirname, '.well-known'), { dotfiles: 'allow' })
);
app.use(express.static(__dirname, { index: 'index.html', extensions: ['html'] }));

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, HOST, () => {
  console.log(`Sing From Home server running at http://${HOST}:${PORT}`);
});
