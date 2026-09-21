require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');

const isProd = process.env.NODE_ENV === 'production';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. Copy .env.example to .env and paste your Neon connection string.');
  process.exit(1);
}
if (!process.env.JWT_SECRET) {
  if (isProd) {
    console.error('JWT_SECRET must be set in production.');
    process.exit(1);
  }
  process.env.JWT_SECRET = crypto.randomBytes(32).toString('hex');
  console.warn('[auth] JWT_SECRET not set; using a temporary one (logins will reset on restart).');
}

const { migrate } = require('./db/migrate');
const { ensureSuperAdmin } = require('./src/bootstrap');
const { HttpError } = require('./src/util');

const app = express();
app.set('trust proxy', 1); // behind Render's proxy: needed for correct client IPs in rate limits

app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      'img-src': ["'self'", 'data:', 'https:'],  // candidate photos come from any https host
      'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      'font-src': ["'self'", 'https://fonts.gstatic.com'],
      'upgrade-insecure-requests': isProd ? [] : null,
    },
  },
}));
app.use(express.json({ limit: '100kb' }));

app.get('/health', (req, res) => res.json({ ok: true }));

app.use('/api/auth', require('./src/routes/auth'));
app.use('/api/super', require('./src/routes/super'));
app.use('/api/manage', require('./src/routes/manage'));
app.use('/api/public', require('./src/routes/public'));
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

// Static pages
const pub = path.join(__dirname, 'public');
app.use(express.static(pub, { extensions: ['html'] }));
app.get('/e/:slug', (req, res) => res.sendFile(path.join(pub, 'election.html')));
app.get('/manage/:id', (req, res) => res.sendFile(path.join(pub, 'manage.html')));

app.use((req, res) => res.status(404).sendFile(path.join(pub, '404.html')));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON.' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request too large.' });
  console.error('[error]', err);
  res.status(500).json({ error: 'Something went wrong on our side. Please try again.' });
});

const PORT = process.env.PORT || 3000;

(async () => {
  try {
    await migrate();
    await ensureSuperAdmin();
    app.listen(PORT, () => console.log(`Elections server running on port ${PORT}`));
  } catch (err) {
    console.error('Startup failed:', err.message);
    process.exit(1);
  }
})();
