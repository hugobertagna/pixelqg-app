'use strict';

// Shared helpers for the PixelQG test-suite (not a test file itself).

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const FAKE_CLAUDE = path.join(__dirname, 'fake-claude.js');
const FIXTURE = path.join(__dirname, 'fixtures', 'sample-stream.jsonl');

function tmpDir(prefix = 'pixelqg-app-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Creates a throw-away public/ directory with an index.html holding the token placeholder. */
function makePublicDir() {
  const dir = tmpDir('pixelqg-app-public-');
  fs.writeFileSync(
    path.join(dir, 'index.html'),
    '<!doctype html><html><head><meta name="hq-token" content="__HQ_TOKEN__"></head><body>QG __HQ_TOKEN__</body></html>'
  );
  fs.mkdirSync(path.join(dir, 'js'));
  fs.writeFileSync(path.join(dir, 'js', 'app.js'), 'window.APP_OK = true;\n');
  fs.writeFileSync(path.join(dir, 'style.css'), 'body { color: red; }\n');
  fs.writeFileSync(path.join(dir, 'notes.xyz'), 'secret-ish');
  return dir;
}

/**
 * Minimal HTTP client with full header control.
 * @returns {Promise<{status: number, headers: object, text: string, json: any}>}
 */
function request(port, opts = {}) {
  const { method = 'GET', path: reqPath = '/', headers = {}, body, rawBody } = opts;
  return new Promise((resolve, reject) => {
    const finalHeaders = { Host: `127.0.0.1:${port}`, ...headers };
    let payload = null;
    if (rawBody !== undefined) {
      payload = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody));
    } else if (body !== undefined) {
      payload = Buffer.from(JSON.stringify(body));
      if (!Object.keys(finalHeaders).some((h) => h.toLowerCase() === 'content-type')) {
        finalHeaders['Content-Type'] = 'application/json';
      }
    }
    if (payload) finalHeaders['Content-Length'] = payload.length;
    const req = http.request({ host: '127.0.0.1', port, method, path: reqPath, headers: finalHeaders, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
      res.on('error', reject);
    });
    req.on('error', (err) => {
      // The server may close the socket right after an early error response.
      if (err.code === 'ECONNRESET' || err.code === 'EPIPE') resolve({ status: 0, headers: {}, text: '', json: null, error: err });
      else reject(err);
    });
    if (payload) req.write(payload);
    req.end();
  });
}

/** Polls a predicate until it returns a truthy value. */
async function waitFor(predicate, timeoutMs = 10000, label = 'condition') {
  const start = Date.now();
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`Délai dépassé en attendant : ${label}`);
    await new Promise((r) => setTimeout(r, 15));
  }
}

/** Connects to /api/events and records parsed events { event, data, at }. */
function sseConnect(port, token) {
  const events = [];
  let req;
  let response;
  const ready = new Promise((resolve, reject) => {
    req = http.request({
      host: '127.0.0.1',
      port,
      method: 'GET',
      path: `/api/events?token=${encodeURIComponent(token)}`,
      headers: { Host: `127.0.0.1:${port}`, Accept: 'text/event-stream' },
      agent: false,
    }, (res) => {
      response = res;
      let buffer = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buffer += chunk;
        let idx;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const block = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          let event = 'message';
          const data = [];
          for (const line of block.split('\n')) {
            if (line.startsWith(':')) continue;
            if (line.startsWith('event:')) event = line.slice(6).trim();
            else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
          }
          if (!data.length) continue;
          let parsed;
          try {
            parsed = JSON.parse(data.join('\n'));
          } catch {
            parsed = data.join('\n');
          }
          events.push({ event, data: parsed, at: Date.now() });
        }
      });
      resolve(res);
    });
    req.on('error', reject);
    req.end();
  });
  return {
    events,
    ready,
    get status() {
      return response ? response.statusCode : 0;
    },
    get headers() {
      return response ? response.headers : {};
    },
    close() {
      try {
        req.destroy();
      } catch {
        /* ignore */
      }
    },
  };
}

function readFixture() {
  return fs.readFileSync(FIXTURE, 'utf8').split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l));
}

module.exports = { FAKE_CLAUDE, FIXTURE, tmpDir, makePublicDir, request, waitFor, sseConnect, readFixture };
