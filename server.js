import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const HOST = '0.0.0.0';

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

app.use((req, res, next) => {
  const reqPath = req.path.toLowerCase();
  if (
    BLOCKED_FILES.has(reqPath) ||
    BLOCKED_PREFIXES.some((prefix) => reqPath === prefix || reqPath.startsWith(`${prefix}/`))
  ) {
    return res.status(404).send('Not found');
  }
  next();
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
