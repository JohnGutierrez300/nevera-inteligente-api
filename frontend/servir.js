'use strict';

const http = require('node:http');
const path = require('node:path');
const { readFile } = require('node:fs/promises');

const address = '127.0.0.1';
const port = Number(process.env.FRONTEND_PORT || 4173);
const apiPort = Number(process.env.API_PORT || 3000);
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/dashboard.js', ['dashboard.js', 'text/javascript; charset=utf-8']]
]);

function proxyApi(request, response) {
  const upstream = http.request({
    hostname: address,
    port: apiPort,
    path: request.url,
    method: request.method,
    headers: request.headers
  }, result => {
    response.writeHead(result.statusCode, result.headers);
    result.pipe(response);
  });
  upstream.setTimeout(60000, () => upstream.destroy());
  upstream.on('error', () => {
    if (response.headersSent) return response.destroy();
    response.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ success: false, message: 'La API local no está disponible.', data: null }));
  });
  response.on('close', () => { if (!response.writableFinished) upstream.destroy(); });
  request.pipe(upstream);
}

const server = http.createServer(async (request, response) => {
  if (request.url.startsWith('/api/')) {
    proxyApi(request, response);
    return;
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD' }).end();
    return;
  }

  const asset = assets.get(request.url.split('?')[0]);
  if (!asset) {
    response.writeHead(404).end();
    return;
  }

  const [name, type] = asset;
  try {
    const content = await readFile(path.join(__dirname, 'dist', name));
    response.writeHead(200, { 'Content-Type': type, 'Content-Length': content.length });
    response.end(request.method === 'HEAD' ? undefined : content);
  } catch {
    response.writeHead(500).end('No se pudo cargar el archivo.');
  }
});

server.on('error', error => {
  console.error(error.code === 'EADDRINUSE' ? `El puerto ${port} está ocupado.` : error.message);
  process.exitCode = 1;
});

server.listen(port, address, () => {
  console.log(`Nevera Inteligente disponible en http://${address}:${port}`);
});
