import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import cesium from 'vite-plugin-cesium';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MOCK_DIR = path.resolve(HERE, '..', 'mock');

/**
 * A5-DATA owns ../mock. We must not move or copy it (OWNERSHIP.md), so the dev
 * server serves it read-only at /mock/* via middleware. Simplest approach that
 * works: no symlink, no copy, no publicDir juggling.
 */
function mockServer() {
  const types: Record<string, string> = {
    '.json': 'application/json; charset=utf-8',
    '.geojson': 'application/json; charset=utf-8',
    '.csv': 'text/csv; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
  };
  return {
    name: 'tokyopulse-mock-server',
    configureServer(server: any) {
      server.middlewares.use('/mock', (req: any, res: any, next: any) => {
        const rel = decodeURIComponent((req.url || '/').split('?')[0]);
        if (rel.includes('..')) return next();
        const file = path.join(MOCK_DIR, rel);
        if (!file.startsWith(MOCK_DIR) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
          res.statusCode = 404;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'mock not found', path: rel }));
          return;
        }
        res.statusCode = 200;
        res.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream');
        res.setHeader('Cache-Control', 'no-store');
        res.end(fs.readFileSync(file));
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), cesium(), mockServer()],
  server: {
    port: 5173,
    strictPort: true,
    host: '127.0.0.1',
    fs: { allow: [HERE, MOCK_DIR] },
  },
  build: { target: 'es2020', sourcemap: false },
});
