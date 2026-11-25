import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';
import nodemailer from 'nodemailer';

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

app.use(express.json({ limit: '5mb' }));

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
const META_MODELS = ['gemini-4-hydrogen', 'gemini-3.1-flash-lite'];

function normSongKey(str) {
  return String(str || '')
    .toUpperCase()
    .replace(/[^A-Z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Curated 100%-verified Bollywood film classics (Title -> Credits)
const BOLLYWOOD_VERIFIED_SONGS = {
  'LAG JA GALE': { orig: 'Lata Mangeshkar', comp: 'Madan Mohan', lyr: 'Raja Mehdi Ali Khan', mov: 'Woh Kaun Thi?', yr: '1964', act: 'Sadhana, Manoj Kumar' },
  'CHURA LIYA HAI TUMNE JO DIL KO': { orig: 'Asha Bhosle, Mohammed Rafi', comp: 'R. D. Burman', lyr: 'Majrooh Sultanpuri', mov: 'Yaadon Ki Baaraat', yr: '1973', act: 'Zeenat Aman, Vijay Arora' },
  'MERE SAPNO KI RANI': { orig: 'Kishore Kumar', comp: 'S. D. Burman', lyr: 'Anand Bakshi', mov: 'Aradhana', yr: '1969', act: 'Rajesh Khanna, Sharmila Tagore' },
  'ROOP TERA MASTANA': { orig: 'Kishore Kumar', comp: 'S. D. Burman', lyr: 'Anand Bakshi', mov: 'Aradhana', yr: '1969', act: 'Rajesh Khanna, Sharmila Tagore' },
  'KORA KAGAZ THA YEH MAN MERA': { orig: 'Kishore Kumar, Lata Mangeshkar', comp: 'S. D. Burman', lyr: 'Anand Bakshi', mov: 'Aradhana', yr: '1969', act: 'Rajesh Khanna, Sharmila Tagore' },
  'PAL PAL DIL KE PAAS': { orig: 'Kishore Kumar', comp: 'Kalyanji-Anandji', lyr: 'Rajendra Krishan', mov: 'Blackmail', yr: '1973', act: 'Dharmendra, Raakhee' },
  'O MERE DIL KE CHAIN': { orig: 'Kishore Kumar', comp: 'R. D. Burman', lyr: 'Majrooh Sultanpuri', mov: 'Mere Jeevan Saathi', yr: '1972', act: 'Rajesh Khanna, Tanuja' },
  'YEH SHAAM MASTANI': { orig: 'Kishore Kumar', comp: 'R. D. Burman', lyr: 'Anand Bakshi', mov: 'Kati Patang', yr: '1971', act: 'Rajesh Khanna, Asha Parekh' },
  'PYAR DIWANA HOTA HAI': { orig: 'Kishore Kumar', comp: 'R. D. Burman', lyr: 'Anand Bakshi', mov: 'Kati Patang', yr: '1971', act: 'Rajesh Khanna, Asha Parekh' },
  'ZINDAGI EK SAFAR HAI SUHANA': { orig: 'Kishore Kumar', comp: 'Shankar Jaikishan', lyr: 'Hasrat Jaipuri', mov: 'Andaz', yr: '1971', act: 'Rajesh Khanna, Hema Malini' },
  'GULABI AANKHEN': { orig: 'Mohammed Rafi', comp: 'R. D. Burman', lyr: 'Anand Bakshi', mov: 'The Train', yr: '1970', act: 'Rajesh Khanna, Nanda' },
  'CHAUDHVIN KA CHAND HO': { orig: 'Mohammed Rafi', comp: 'Ravi', lyr: 'Shakeel Badayuni', mov: 'Chaudhvin Ka Chand', yr: '1960', act: 'Guru Dutt, Waheeda Rehman' },
  'BAHARON PHOOL BARSAO': { orig: 'Mohammed Rafi', comp: 'Shankar Jaikishan', lyr: 'Hasrat Jaipuri', mov: 'Suraj', yr: '1966', act: 'Rajendra Kumar, Vyjayanthimala' },
  'LIKHE JO KHAT TUJHE': { orig: 'Mohammed Rafi', comp: 'Shankar Jaikishan', lyr: 'Neeraj', mov: 'Kanyadaan', yr: '1968', act: 'Shashi Kapoor, Asha Parekh' },
  'KYA HUA TERA WADA': { orig: 'Mohammed Rafi, Sushma Shrestha', comp: 'R. D. Burman', lyr: 'Majrooh Sultanpuri', mov: 'Hum Kisise Kum Naheen', yr: '1977', act: 'Rishi Kapoor, Kajal Kiran' },
  'EHSAAN TERA HOGA MUJH PAR': { orig: 'Mohammed Rafi', comp: 'Shankar Jaikishan', lyr: 'Hasrat Jaipuri', mov: 'Junglee', yr: '1961', act: 'Shammi Kapoor, Saira Banu' },
  'KHOYA KHOYA CHAND': { orig: 'Mohammed Rafi', comp: 'S. D. Burman', lyr: 'Shailendra', mov: 'Kala Bazar', yr: '1960', act: 'Dev Anand, Waheeda Rehman' },
  'PUKARTA CHALA HOON MAIN': { orig: 'Mohammed Rafi', comp: 'O. P. Nayyar', lyr: 'Majrooh Sultanpuri', mov: 'Mere Sanam', yr: '1965', act: 'Biswajit, Asha Parekh' },
  'ABHI NA JAO CHHOD KAR': { orig: 'Mohammed Rafi, Asha Bhosle', comp: 'Jaidev', lyr: 'Sahir Ludhianvi', mov: 'Hum Dono', yr: '1961', act: 'Dev Anand, Sadhana' },
  'YEH RAATEN YEH MAUSAM': { orig: 'Kishore Kumar, Asha Bhosle', comp: 'Ravi', lyr: 'Shailendra', mov: 'Dilli Ka Thug', yr: '1958', act: 'Kishore Kumar, Nutan' },
  'EK PYAR KA NAGMA HAI': { orig: 'Lata Mangeshkar, Mukesh', comp: 'Laxmikant-Pyarelal', lyr: 'Santosh Anand', mov: 'Shor', yr: '1972', act: 'Manoj Kumar, Nanda' },
  'AJEEB DASTAN HAI YEH': { orig: 'Lata Mangeshkar', comp: 'Shankar Jaikishan', lyr: 'Shailendra', mov: 'Dil Apna Aur Preet Parai', yr: '1960', act: 'Meena Kumari, Raaj Kumar' },
  'KABHI KABHI MERE DIL MEIN': { orig: 'Mukesh, Lata Mangeshkar', comp: 'Khayyam', lyr: 'Sahir Ludhianvi', mov: 'Kabhie Kabhie', yr: '1976', act: 'Amitabh Bachchan, Raakhee' },
  'TERE CHEHRE SE NAZAR NAHIN HATATI': { orig: 'Kishore Kumar, Lata Mangeshkar', comp: 'Khayyam', lyr: 'Sahir Ludhianvi', mov: 'Kabhie Kabhie', yr: '1976', act: 'Rishi Kapoor, Neetu Singh' },
  'KAHIN DOOR JAB DIN DHAL JAYE': { orig: 'Mukesh', comp: 'Salil Chowdhury', lyr: 'Yogesh', mov: 'Anand', yr: '1971', act: 'Rajesh Khanna, Amitabh Bachchan' },
  'ZINDAGI KAISI HAI PAHELI': { orig: 'Manna Dey', comp: 'Salil Chowdhury', lyr: 'Yogesh', mov: 'Anand', yr: '1971', act: 'Rajesh Khanna' },
  'CHANDAN SA BADAN': { orig: 'Mukesh', comp: 'Kalyanji-Anandji', lyr: 'Indeevar', mov: 'Saraswatichandra', yr: '1968', act: 'Manish, Nutan' },
  'AE MERI ZOHRA JABEEN': { orig: 'Manna Dey', comp: 'Ravi', lyr: 'Sahir Ludhianvi', mov: 'Waqt', yr: '1965', act: 'Balraj Sahni, Achala Sachdev' },
  'MERE NAINA SAWAN BHADON': { orig: 'Kishore Kumar', comp: 'R. D. Burman', lyr: 'Anand Bakshi', mov: 'Mehbooba', yr: '1976', act: 'Rajesh Khanna, Hema Malini' },
  'TERE SANG PYAR MAIN NAHIN TODNA': { orig: 'Lata Mangeshkar', comp: 'Laxmikant-Pyarelal', lyr: 'Verma Malik', mov: 'Nagin', yr: '1976', act: 'Reena Roy, Jeetendra' },
  'AAYE HO MERI ZINDAGI MEIN': { orig: 'Udit Narayan', comp: 'Nadeem-Shravan', lyr: 'Sameer', mov: 'Raja Hindustani', yr: '1996', act: 'Aamir Khan, Karisma Kapoor' },
  'DIL DIYA HAI JAAN BHI DENGE': { orig: 'Mohammed Aziz, Kavita Krishnamurthy', comp: 'Laxmikant-Pyarelal', lyr: 'Anand Bakshi', mov: 'Karma', yr: '1986', act: 'Dilip Kumar, Nutan' },
  'JAADU HAI NASHA HAI': { orig: 'Shreya Ghoshal', comp: 'M. M. Keeravani', lyr: 'Neelesh Misra', mov: 'Jism', yr: '2003', act: 'Bipasha Basu, John Abraham' },
  'O MEHBOOBA': { orig: 'Mukesh', comp: 'Shankar Jaikishan', lyr: 'Hasrat Jaipuri', mov: 'Sangam', yr: '1964', act: 'Raj Kapoor, Vyjayanthimala' },
  'NEELE NEELE AMBAR PAR': { orig: 'Kishore Kumar', comp: 'Kalyanji-Anandji', lyr: 'Indeevar', mov: 'Kalaakaar', yr: '1983', act: 'Kunal Goswami, Sridevi' },
  'TUJHSE NARAZ NAHIN ZINDAGI': { orig: 'Anup Ghoshal, Lata Mangeshkar', comp: 'R. D. Burman', lyr: 'Gulzar', mov: 'Masoom', yr: '1983', act: 'Naseeruddin Shah, Shabana Azmi' },
  'TERE BINA ZINDAGI SE': { orig: 'Lata Mangeshkar, Kishore Kumar', comp: 'R. D. Burman', lyr: 'Gulzar', mov: 'Aandhi', yr: '1975', act: 'Sanjeev Kumar, Suchitra Sen' },
  'CHOOKAR MERE MAN KO': { orig: 'Kishore Kumar', comp: 'Rajesh Roshan', lyr: 'Anjaan', mov: 'Yaarana', yr: '1981', act: 'Amitabh Bachchan, Neetu Singh' },
  'MERE MEHBOOB QAYAMAT HOGI': { orig: 'Kishore Kumar', comp: 'Laxmikant-Pyarelal', lyr: 'Anand Bakshi', mov: 'Mr. X in Bombay', yr: '1964', act: 'Kishore Kumar, Kumkum' },
  'RIMJHIM GIRE SAWAN': { orig: 'Kishore Kumar, Lata Mangeshkar', comp: 'R. D. Burman', lyr: 'Yogesh', mov: 'Manzil', yr: '1979', act: 'Amitabh Bachchan, Moushumi Chatterjee' },
  'YEH DOSTI HUM NAHIN TODENGE': { orig: 'Kishore Kumar, Manna Dey', comp: 'R. D. Burman', lyr: 'Anand Bakshi', mov: 'Sholay', yr: '1975', act: 'Amitabh Bachchan, Dharmendra' },
  'KUCH TOH LOG KAHENGE': { orig: 'Kishore Kumar', comp: 'R. D. Burman', lyr: 'Anand Bakshi', mov: 'Amar Prem', yr: '1972', act: 'Rajesh Khanna, Sharmila Tagore' },
  'CHINGARI KOI BHADKE': { orig: 'Kishore Kumar', comp: 'R. D. Burman', lyr: 'Anand Bakshi', mov: 'Amar Prem', yr: '1972', act: 'Rajesh Khanna, Sharmila Tagore' },
  'HOTHON SE CHHU LO TUM': { orig: 'Jagjit Singh', comp: 'Jagjit Singh', lyr: 'Indeevar', mov: 'Prem Geet', yr: '1981', act: 'Raj Babbar, Anita Raj' },
  'TUM ITNA JO MUSKURA RAHE HO': { orig: 'Jagjit Singh', comp: 'Jagjit Singh', lyr: 'Kaifi Azmi', mov: 'Arth', yr: '1982', act: 'Kulbhushan Kharbanda, Shabana Azmi' },
  'AAP KI NAZRON NE SAMJHA': { orig: 'Lata Mangeshkar', comp: 'Madan Mohan', lyr: 'Raja Mehdi Ali Khan', mov: 'Anpadh', yr: '1962', act: 'Mala Sinha, Dharmendra' },
  'AAJ PHIR JEENE KI TAMANNA HAI': { orig: 'Lata Mangeshkar', comp: 'S. D. Burman', lyr: 'Shailendra', mov: 'Guide', yr: '1965', act: 'Waheeda Rehman, Dev Anand' },
  'GAATA RAHE MERA DIL': { orig: 'Kishore Kumar, Lata Mangeshkar', comp: 'S. D. Burman', lyr: 'Shailendra', mov: 'Guide', yr: '1965', act: 'Dev Anand, Waheeda Rehman' },
  'TERE MERE MILAN KI YEH RAINA': { orig: 'Kishore Kumar, Lata Mangeshkar', comp: 'S. D. Burman', lyr: 'Majrooh Sultanpuri', mov: 'Abhimaan', yr: '1973', act: 'Amitabh Bachchan, Jaya Bachchan' },
  'EK LADKI BHEEGI BHAAGI SI': { orig: 'Kishore Kumar', comp: 'S. D. Burman', lyr: 'Majrooh Sultanpuri', mov: 'Chalti Ka Naam Gaadi', yr: '1958', act: 'Kishore Kumar, Madhubala' },
  'HAAL KAISA HAI JANAB KA': { orig: 'Kishore Kumar, Asha Bhosle', comp: 'S. D. Burman', lyr: 'Majrooh Sultanpuri', mov: 'Chalti Ka Naam Gaadi', yr: '1958', act: 'Kishore Kumar, Madhubala' },
  'CHHOD DO AANCHAL': { orig: 'Kishore Kumar, Asha Bhosle', comp: 'S. D. Burman', lyr: 'Majrooh Sultanpuri', mov: 'Paying Guest', yr: '1957', act: 'Dev Anand, Nutan' },
  'EK AJNABEE HASEENA SE': { orig: 'Kishore Kumar', comp: 'R. D. Burman', lyr: 'Anand Bakshi', mov: 'Ajnabee', yr: '1974', act: 'Rajesh Khanna, Zeenat Aman' },
  'DEKHA EK KHWAB': { orig: 'Kishore Kumar, Lata Mangeshkar', comp: 'Shiv-Hari', lyr: 'Javed Akhtar', mov: 'Silsila', yr: '1981', act: 'Amitabh Bachchan, Rekha' },
  'HAMEIN TUMSE PYAR KITNA': { orig: 'Kishore Kumar', comp: 'R. D. Burman', lyr: 'Majrooh Sultanpuri', mov: 'Kudrat', yr: '1981', act: 'Rajesh Khanna, Hema Malini' },
  'SAGAR KINARE': { orig: 'Kishore Kumar, Lata Mangeshkar', comp: 'R. D. Burman', lyr: 'Javed Akhtar', mov: 'Saagar', yr: '1985', act: 'Rishi Kapoor, Dimple Kapadia' },
  'AANE WALA PAL': { orig: 'Kishore Kumar', comp: 'R. D. Burman', lyr: 'Gulzar', mov: 'Gol Maal', yr: '1979', act: 'Amol Palekar, Bindiya Goswami' },
  'MUSAFIR HOON YAARON': { orig: 'Kishore Kumar', comp: 'R. D. Burman', lyr: 'Gulzar', mov: 'Parichay', yr: '1972', act: 'Jeetendra, Jaya Bhaduri' },
  'PEHLA NASHA': { orig: 'Udit Narayan, Sadhana Sargam', comp: 'Jatin-Lalit', lyr: 'Majrooh Sultanpuri', mov: 'Jo Jeeta Wohi Sikandar', yr: '1992', act: 'Aamir Khan, Ayesha Jhulka' },
  'TUJHE DEKHA TOH': { orig: 'Kumar Sanu, Lata Mangeshkar', comp: 'Jatin-Lalit', lyr: 'Anand Bakshi', mov: 'Dilwale Dulhania Le Jayenge', yr: '1995', act: 'Shah Rukh Khan, Kajol' },
  'KAL HO NAA HO': { orig: 'Sonu Nigam', comp: 'Shankar-Ehsaan-Loy', lyr: 'Javed Akhtar', mov: 'Kal Ho Naa Ho', yr: '2003', act: 'Shah Rukh Khan, Preity Zinta, Saif Ali Khan' },
  'TUM HI HO': { orig: 'Arijit Singh', comp: 'Mithoon', lyr: 'Mithoon', mov: 'Aashiqui 2', yr: '2013', act: 'Aditya Roy Kapur, Shraddha Kapoor' },
  'CHANNA MEREYA': { orig: 'Arijit Singh', comp: 'Pritam', lyr: 'Amitabh Bhattacharya', mov: 'Ae Dil Hai Mushkil', yr: '2016', act: 'Ranbir Kapoor, Anushka Sharma' },
  'AGAR TUM SAATH HO': { orig: 'Alka Yagnik, Arijit Singh', comp: 'A. R. Rahman', lyr: 'Irshad Kamil', mov: 'Tamasha', yr: '2015', act: 'Ranbir Kapoor, Deepika Padukone' },
  'KESARIYA': { orig: 'Arijit Singh', comp: 'Pritam', lyr: 'Amitabh Bhattacharya', mov: 'Brahmāstra', yr: '2022', act: 'Ranbir Kapoor, Alia Bhatt' },
  'TUJH MEIN RAB DIKHTA HAI': { orig: 'Roop Kumar Rathod', comp: 'Salim-Sulaiman', lyr: 'Jaideep Sahni', mov: 'Rab Ne Bana Di Jodi', yr: '2008', act: 'Shah Rukh Khan, Anushka Sharma' },
};

function lookupVerifiedBollywoodSong(songTitle, movieHint = '') {
  const key = normSongKey(songTitle);
  if (!key) return null;
  if (BOLLYWOOD_VERIFIED_SONGS[key]) {
    const hit = BOLLYWOOD_VERIFIED_SONGS[key];
    if (!movieHint || normSongKey(hit.mov).includes(normSongKey(movieHint))) {
      return { ...hit };
    }
  }
  const compact = key.replace(/\s+/g, '');
  for (const [k, v] of Object.entries(BOLLYWOOD_VERIFIED_SONGS)) {
    const kc = k.replace(/\s+/g, '');
    if (kc === compact || (compact.length >= 10 && (kc.startsWith(compact) || compact.startsWith(kc)))) {
      if (!movieHint || normSongKey(v.mov).includes(normSongKey(movieHint))) {
        return { ...v };
      }
    }
  }
  return null;
}

function parseJsonObjectLoose(rawText) {
  const text = String(rawText || '').trim();
  if (!text) return {};
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch (_) {
    const first = cleaned.indexOf('{');
    const last = cleaned.lastIndexOf('}');
    if (first !== -1 && last > first) {
      return JSON.parse(cleaned.slice(first, last + 1));
    }
    throw new Error('Could not parse AI metadata JSON response.');
  }
}

function parseRetryDelaySeconds(err) {
  const msg = String(err?.message || '');
  const mSec = msg.match(/"retryDelay"\s*:\s*"(\d+)s"/i) || msg.match(/retry in\s+(\d+(?:\.\d+)?)s/i);
  if (mSec) return Math.max(5, Math.ceil(parseFloat(mSec[1])));
  const mHr = msg.match(/retry in\s+(\d+)h(\d+)m/i);
  if (mHr) return Math.max(60, Number(mHr[1]) * 3600 + Number(mHr[2]) * 60);
  return 45;
}

async function fetchSongMetaFromGemini(ai, songTitle, movieHint = '') {
  const hintLine = movieHint ? `\nMovie hint provided by user: "${movieHint}".` : '';
  const prompt = `Find and verify the exact original Hindi Bollywood movie discography credits for the song titled: "${songTitle}".${hintLine}

STRICT RULES:
1. Search ONLY Hindi Bollywood movies (original film soundtrack release — NOT remixes, NOT cover versions, NOT compilation albums like "Best of Kishore Kumar", NOT TV serials).
2. Verify every single field carefully using web search before answering:
   - orig: Original playback singer(s) of the film song (comma-separated, Title Case)
   - comp: Music composer / music director(s) (e.g. "R. D. Burman", "Laxmikant-Pyarelal", "Shankar Jaikishan", "Pritam")
   - lyr: Lyricist(s) (e.g. "Anand Bakshi", "Majrooh Sultanpuri", "Gulzar", "Sahir Ludhianvi")
   - mov: Exact Bollywood movie name
   - yr: Exact 4-digit film release year (e.g. "1973")
   - act: Lead actor(s) picturized in the song (comma-separated, Title Case)
3. NEVER guess or fabricate any credit. If you cannot verify a field with high confidence from a real Bollywood movie soundtrack, return "" for that field.
4. Return ONLY a raw JSON object with keys: orig, comp, lyr, mov, yr, act (no markdown, no explanation).`;

  const responseSchema = {
    type: Type.OBJECT,
    properties: {
      orig: { type: Type.STRING, description: 'Original Bollywood playback singer(s), comma-separated.' },
      comp: { type: Type.STRING, description: 'Bollywood music composer / director(s).' },
      lyr: { type: Type.STRING, description: 'Bollywood lyricist(s).' },
      mov: { type: Type.STRING, description: 'Exact Bollywood Hindi movie name.' },
      yr: { type: Type.STRING, description: '4-digit film release year, or "" if unknown.' },
      act: { type: Type.STRING, description: 'Lead actor(s) featured in the song.' },
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
          'You are a strict Hindi Bollywood film music archivist. You ONLY return verified original Bollywood movie soundtrack metadata. Never guess or hallucinate credits; return "" for anything unverified. Respond strictly with valid JSON containing keys orig, comp, lyr, mov, yr, act.',
      };
      if (model === 'gemini-4-hydrogen') {
        config.tools = [{ googleSearch: {} }];
        config.thinkingConfig = { thinkingLevel: ThinkingLevel.LOW };
      } else {
        config.responseMimeType = 'application/json';
        config.responseSchema = responseSchema;
        config.thinkingConfig = { thinkingLevel: ThinkingLevel.LOW };
      }

      const response = await ai.models.generateContent({
        model,
        contents: prompt,
        config,
      });

      const parsed = parseJsonObjectLoose(response.text ?? '{}');
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
      if (status >= 500 || status === 404 || status === 400) {
        console.warn(`Gemini ${model} failed (${status}); trying fallback if available.`);
        continue;
      }
      throw err;
    }
  }

  if (minCooldownSec != null) {
    const rateErr = new Error(
      minCooldownSec > 120
        ? `Free-tier daily AI limit reached. Try again later or attach a billing-enabled API key in Settings > Secrets.`
        : `AI rate limit reached. Please try again in ~${minCooldownSec} seconds.`
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
  const movieHint =
    typeof req.body?.movieHint === 'string'
      ? req.body.movieHint.trim()
      : typeof req.query?.movieHint === 'string'
        ? req.query.movieHint.trim()
        : '';
  const forceRefresh = req.body?.force === true || req.query?.force === '1' || req.query?.force === 'true';
  if (!rawTitle) {
    return res.status(400).json({ error: 'Please enter a song title first.' });
  }

  // 1. Check curated 100%-verified Bollywood classic database first
  const curated = lookupVerifiedBollywoodSong(rawTitle, movieHint);
  if (curated) {
    return res.json({ meta: curated, source: 'bollywood-verified' });
  }

  const cacheKey = `${normSongKey(rawTitle)}__${normSongKey(movieHint)}`;
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
      promise = fetchSongMetaFromGemini(ai, rawTitle, movieHint).finally(() => {
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
    return res.json({ meta: result.meta, source: result.model });
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

const SUPERADMIN_EMAIL = 'musicsnsounds@gmail.com';

function createMailTransporter() {
  const user = process.env.SMTP_USER || process.env.GMAIL_USER || '';
  const pass = process.env.SMTP_PASS || process.env.GMAIL_APP_PASSWORD || '';
  if (!user || !pass) return null;
  const host = process.env.SMTP_HOST || 'smtp.gmail.com';
  const port = Number(process.env.SMTP_PORT) || 465;
  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  });
}

app.post('/api/email-backup', async (req, res) => {
  const { fileName, jsonContent, date, host, theme, songCount, sotdSummary } = req.body || {};
  if (!fileName || typeof jsonContent !== 'string' || !jsonContent.trim()) {
    return res.status(400).json({ ok: false, error: 'Missing backup file content.' });
  }
  const transporter = createMailTransporter();
  if (!transporter) {
    return res.json({
      ok: false,
      configured: false,
      recipient: SUPERADMIN_EMAIL,
      message: 'SMTP credentials not configured on server.',
    });
  }
  try {
    const fromAddr = process.env.SMTP_FROM || process.env.SMTP_USER || process.env.GMAIL_USER;
    const safeName = String(fileName).replace(/[^a-zA-Z0-9._-]/g, '_');
    const subject = `Sing From Home Backup — ${date || 'Live Session'}${host ? ` (Host: ${host})` : ''}`;
    const bodyLines = [
      `Sing From Home — Automatic Session Backup`,
      `Date: ${date || '-'}`,
      `Host: ${host || '-'}`,
      `Theme: ${theme || '-'}`,
      `Songs Performed: ${Number(songCount) || 0}`,
      sotdSummary ? `SOTD: ${sotdSummary}` : '',
      ``,
      `The complete Master Backup JSON (${safeName}) is attached to this email.`,
    ].filter(Boolean);

    await transporter.sendMail({
      from: fromAddr,
      to: SUPERADMIN_EMAIL,
      subject,
      text: bodyLines.join('\n'),
      attachments: [
        {
          filename: safeName,
          content: jsonContent,
          contentType: 'application/json',
        },
      ],
    });
    return res.json({ ok: true, configured: true, recipient: SUPERADMIN_EMAIL, fileName: safeName });
  } catch (err) {
    console.error('Backup email error:', err?.message || err);
    return res.status(502).json({
      ok: false,
      configured: true,
      recipient: SUPERADMIN_EMAIL,
      error: err?.message || 'Failed to send backup email.',
    });
  }
});

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
