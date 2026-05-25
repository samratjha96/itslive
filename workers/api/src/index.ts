import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env } from './types';
import authRouter from './routes/auth';
import sitesRouter from './routes/sites';
import accountRouter from './routes/account';

const app = new Hono<{ Bindings: Env }>();

app.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'X-API-Key', 'X-Cache-TTL'],
}));

app.get('/', c => c.json({ name: 'ItsLive API', version: '1.0.0', status: 'ok' }));

// Auth routes: /signup  /verify  /keys/rotate
app.route('/', authRouter);

// Site routes: /sites  /sites/:name  /sites/:name/access  etc.
app.route('/sites', sitesRouter);

// Account routes: /usage  /account
app.route('/', accountRouter);

app.notFound(c => c.json({ error: { code: 'NOT_FOUND', message: 'Endpoint not found.' } }, 404));

app.onError((err, c) => {
  console.error(err);
  if (err.message === 'SLUG_GENERATION_FAILED') {
    return c.json({ error: { code: 'SLUG_GENERATION_FAILED', message: 'Could not generate a unique site name. Please try again.' } }, 503);
  }
  return c.json({ error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.' } }, 500);
});

export default app;
