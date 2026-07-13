/* eslint-disable no-process-env */

import http from 'node:http';
import { styleText } from 'node:util';

import serve from 'serve-handler';

import { createPostgisOsmApi } from '../server/postgis_osm_api.js';

const port = Number.parseInt(process.env.PORT || '8080', 10);
const host = process.env.HOST || '0.0.0.0';
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error(`Invalid PORT value: ${process.env.PORT}`);
}

if (process.env.NODE_ENV !== 'production') {
  const [{ glob }, { watch }, { buildCSS }] = await Promise.all([
    import('node:fs/promises'),
    import('chokidar'),
    import('./build_css.js')
  ]);

  watch(await Array.fromAsync(glob('css/**/*.css')), {
    ignoreInitial: false
  }).on('all', () => {
    buildCSS();
  });
}

const osmApi = createPostgisOsmApi();
await osmApi.init();

const server = http.createServer(async (request, response) => {
  if (await osmApi.handle(request, response)) return;

  await serve(request, response, {
    cleanUrls: false,
    rewrites: [{
      source: '/',
      destination: '/index.html'
    }],
    symlinks: true,
    headers: [{
      source: '**',
      headers: [{
        key : 'Cache-Control',
        value : 'no-cache'
      }]
    }]
  });
});

server.listen(port, host, () => {
  /* eslint-disable no-console */
  console.log(styleText('yellow', `Goong editor listening on http://${host}:${port}`));
});

async function shutdown() {
  server.close();
  await osmApi.close();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
