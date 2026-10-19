'use strict';

// RFC 6455 server (server/ws.js) against a raw net.Socket client and Node's global WebSocket.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const crypto = require('node:crypto');

const { acceptUpgrade, acceptKey, rejectUpgrade } = require('../ws');
const { waitFor } = require('./helpers');

/** Echo server: text "x" -> "echo:x", binary echoed as is. Records server-side close events. */
async function startEchoServer(opts = {}) {
  const closes = [];
  const conns = [];
  const server = http.createServer((req, res) => {
    res.writeHead(404);
    res.end();
  });
  server.on('upgrade', (req, socket, head) => {
    if (req.url === '/refuse') return rejectUpgrade(socket, 401, 'Jeton refusé.');
    const ws = acceptUpgrade(req, socket, head, { maxPayload: 1024 * 1024, pingMs: 0, ...opts });
    if (!ws) return;
    conns.push(ws);
    ws.on('message', (data, isBinary) => ws.send(isBinary ? data : `echo:${data}`));
    ws.on('close', (code, reason) => closes.push({ code, reason }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    port,
    closes,
    conns,
    close: () => new Promise((resolve) => {
      for (const ws of conns) ws.terminate();
      server.close(() => resolve());
      server.closeAllConnections();
    }),
  };
}

function maskedFrame(opcode, payload, { fin = true, mask = true, rsv = 0, lengthOverride } = {}) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload || '', 'utf8');
  const len = lengthOverride !== undefined ? lengthOverride : data.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0, len]);
  } else if (len <= 0xffff) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = (fin ? 0x80 : 0) | rsv | opcode;
  if (!mask) return Buffer.concat([header, data]);
  header[1] |= 0x80;
  const key = crypto.randomBytes(4);
  const masked = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i++) masked[i] = data[i] ^ key[i & 3];
  return Buffer.concat([header, key, masked]);
}

/** Parses unmasked server frames. */
function parseFrames(buf) {
  const frames = [];
  let off = 0;
  for (;;) {
    if (buf.length - off < 2) break;
    const b0 = buf[off];
    const b1 = buf[off + 1];
    let len = b1 & 0x7f;
    let p = off + 2;
    let lenBytes = 1;
    if (len === 126) {
      if (buf.length - p < 2) break;
      len = buf.readUInt16BE(p);
      p += 2;
      lenBytes = 3;
    } else if (len === 127) {
      if (buf.length - p < 8) break;
      len = Number(buf.readBigUInt64BE(p));
      p += 8;
      lenBytes = 9;
    }
    if (buf.length - p < len) break;
    frames.push({ fin: (b0 & 0x80) !== 0, opcode: b0 & 0x0f, masked: (b1 & 0x80) !== 0, lenBytes, payload: buf.subarray(p, p + len) });
    off = p + len;
  }
  return { frames, rest: buf.subarray(off) };
}

/** Raw client: performs the handshake and collects server frames. */
function rawClient(port, { path = '/', headers = {}, key = crypto.randomBytes(16).toString('base64') } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    const state = { socket, key, status: 0, headers: {}, frames: [], ended: false, rawResponse: '' };
    let buf = Buffer.alloc(0);
    let handshakeDone = false;
    socket.on('error', reject);
    socket.on('close', () => {
      state.ended = true;
      if (!handshakeDone) resolve(state);
    });
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!handshakeDone) {
        const idx = buf.indexOf('\r\n\r\n');
        if (idx === -1) return;
        const head = buf.subarray(0, idx).toString('latin1');
        state.rawResponse = buf.toString('utf8');
        const [statusLine, ...lines] = head.split('\r\n');
        state.status = Number(statusLine.split(' ')[1]);
        for (const l of lines) {
          const c = l.indexOf(':');
          state.headers[l.slice(0, c).trim().toLowerCase()] = l.slice(c + 1).trim();
        }
        buf = buf.subarray(idx + 4);
        handshakeDone = true;
        resolve(state);
      }
      const parsed = parseFrames(buf);
      state.frames.push(...parsed.frames);
      buf = parsed.rest;
    });
    const reqHeaders = {
      Host: `127.0.0.1:${port}`,
      Upgrade: 'websocket',
      Connection: 'Upgrade',
      'Sec-WebSocket-Key': key,
      'Sec-WebSocket-Version': '13',
      ...headers,
    };
    const lines = [`GET ${path} HTTP/1.1`];
    for (const [k, v] of Object.entries(reqHeaders)) if (v !== null) lines.push(`${k}: ${v}`);
    socket.write(lines.join('\r\n') + '\r\n\r\n');
  });
}

function closeCode(frame) {
  return frame.payload.length >= 2 ? frame.payload.readUInt16BE(0) : 1005;
}

test('ws: Sec-WebSocket-Accept follows RFC 6455 (sample key)', () => {
  assert.equal(acceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
});

test('ws: handshake guards', async (t) => {
  const srv = await startEchoServer();
  t.after(() => srv.close());
  const ok = await rawClient(srv.port);
  assert.equal(ok.status, 101);
  assert.equal(ok.headers.upgrade.toLowerCase(), 'websocket');
  assert.equal(ok.headers['sec-websocket-accept'], acceptKey(ok.key));
  ok.socket.destroy();

  const noKey = await rawClient(srv.port, { headers: { 'Sec-WebSocket-Key': null } });
  assert.equal(noKey.status, 400);
  const badKey = await rawClient(srv.port, { key: 'trop-court' });
  assert.equal(badKey.status, 400);
  const version = await rawClient(srv.port, { headers: { 'Sec-WebSocket-Version': '8' } });
  assert.equal(version.status, 426);
  assert.equal(version.headers['sec-websocket-version'], '13');
  const noUpgradeToken = await rawClient(srv.port, { headers: { Connection: 'keep-alive, Upgrade', Upgrade: 'h2c, websocket' } });
  assert.equal(noUpgradeToken.status, 101, 'token lists are accepted');
  noUpgradeToken.socket.destroy();
  const refused = await rawClient(srv.port, { path: '/refuse' });
  assert.equal(refused.status, 401);
  assert.match(refused.rawResponse, /Jeton refusé/);
});

test('ws: masked frames, 7/16/64-bit lengths, fragmentation, ping/pong', async (t) => {
  const srv = await startEchoServer();
  t.after(() => srv.close());
  const c = await rawClient(srv.port);
  assert.equal(c.status, 101);

  c.socket.write(maskedFrame(0x1, 'salut é'));
  await waitFor(() => c.frames.length >= 1, 3000, 'small echo');
  assert.equal(c.frames[0].opcode, 0x1);
  assert.equal(c.frames[0].masked, false, 'server frames are never masked');
  assert.equal(c.frames[0].payload.toString('utf8'), 'echo:salut é');

  const medium = 'm'.repeat(300);
  c.socket.write(maskedFrame(0x1, medium));
  await waitFor(() => c.frames.length >= 2, 3000, '16-bit echo');
  assert.equal(c.frames[1].lenBytes, 3, '16-bit length on the way back');
  assert.equal(c.frames[1].payload.toString(), `echo:${medium}`);

  const big = crypto.randomBytes(70000);
  c.socket.write(maskedFrame(0x2, big));
  await waitFor(() => c.frames.length >= 3, 3000, '64-bit echo');
  assert.equal(c.frames[2].lenBytes, 9, '64-bit length on the way back');
  assert.equal(c.frames[2].opcode, 0x2);
  assert.ok(c.frames[2].payload.equals(big));

  // Text split in three fragments with a ping in the middle (control frames may interleave).
  c.socket.write(Buffer.concat([
    maskedFrame(0x1, 'un-', { fin: false }),
    maskedFrame(0x0, 'deux-', { fin: false }),
    maskedFrame(0x9, 'battement'),
    maskedFrame(0x0, 'trois', { fin: true }),
  ]));
  await waitFor(() => c.frames.length >= 5, 3000, 'pong + reassembled echo');
  assert.equal(c.frames[3].opcode, 0xa);
  assert.equal(c.frames[3].payload.toString(), 'battement');
  assert.equal(c.frames[4].payload.toString(), 'echo:un-deux-trois');

  // A UTF-8 character split across two fragments is reassembled before decoding.
  const euro = Buffer.from('€', 'utf8');
  c.socket.write(Buffer.concat([maskedFrame(0x1, euro.subarray(0, 1), { fin: false }), maskedFrame(0x0, euro.subarray(1))]));
  await waitFor(() => c.frames.length >= 6, 3000, 'split utf-8');
  assert.equal(c.frames[5].payload.toString(), 'echo:€');

  // Byte-by-byte delivery of one frame.
  const slow = maskedFrame(0x1, 'goutte à goutte');
  for (const byte of slow) c.socket.write(Buffer.from([byte]));
  await waitFor(() => c.frames.length >= 7, 3000, 'byte-by-byte frame');
  assert.equal(c.frames[6].payload.toString(), 'echo:goutte à goutte');

  // Closing handshake initiated by the client.
  const reason = Buffer.from('au revoir');
  const closePayload = Buffer.concat([Buffer.from([0x03, 0xe8]), reason]);
  c.socket.write(maskedFrame(0x8, closePayload));
  await waitFor(() => c.frames.some((f) => f.opcode === 0x8), 3000, 'close reply');
  assert.equal(closeCode(c.frames.find((f) => f.opcode === 0x8)), 1000);
  await waitFor(() => srv.closes.length === 1, 3000, 'server close event');
  assert.deepEqual(srv.closes[0], { code: 1000, reason: 'au revoir' });
  await waitFor(() => c.ended, 3000, 'socket closed');
});

test('ws: protocol violations close the connection with the right code', async (t) => {
  const srv = await startEchoServer();
  t.after(() => srv.close());
  const cases = [
    ['unmasked client frame', maskedFrame(0x1, 'nu', { mask: false }), 1002],
    ['reserved bits', maskedFrame(0x1, 'rsv', { rsv: 0x40 }), 1002],
    ['unknown opcode', maskedFrame(0x3, 'x'), 1002],
    ['continuation without a start', maskedFrame(0x0, 'x'), 1002],
    ['fragmented control frame', maskedFrame(0x9, 'x', { fin: false }), 1002],
    ['control frame > 125 bytes', maskedFrame(0x9, 'p'.repeat(126)), 1002],
    ['invalid UTF-8 text', maskedFrame(0x1, Buffer.from([0xc3, 0x28])), 1007],
    ['invalid close code', maskedFrame(0x8, Buffer.from([0x03, 0xed])), 1002],
    ['message over 1 MB (rejected from the header)', maskedFrame(0x2, Buffer.alloc(0), { lengthOverride: 1024 * 1024 + 1 }).subarray(0, 14), 1009],
  ];
  for (const [label, bytes, expected] of cases) {
    const c = await rawClient(srv.port);
    c.socket.write(bytes);
    await waitFor(() => c.frames.some((f) => f.opcode === 0x8), 3000, `close frame (${label})`);
    assert.equal(closeCode(c.frames.find((f) => f.opcode === 0x8)), expected, label);
    await waitFor(() => c.ended, 3000, `socket closed (${label})`);
  }
  // Fragments adding up to more than 1 MB.
  const c = await rawClient(srv.port);
  c.socket.write(maskedFrame(0x2, Buffer.alloc(600 * 1024), { fin: false }));
  c.socket.write(maskedFrame(0x0, Buffer.alloc(600 * 1024), { fin: true }));
  await waitFor(() => c.frames.some((f) => f.opcode === 0x8), 3000, 'close frame (fragments over 1 MB)');
  assert.equal(closeCode(c.frames.find((f) => f.opcode === 0x8)), 1009);
  // Exactly 1 MB is accepted.
  const d = await rawClient(srv.port);
  d.socket.write(maskedFrame(0x2, Buffer.alloc(1024 * 1024, 7)));
  await waitFor(() => d.frames.length >= 1, 5000, '1 MB echo');
  assert.equal(d.frames[0].payload.length, 1024 * 1024);
  d.socket.destroy();
});

test('ws: keepalive drops a peer that never answers pings', async (t) => {
  const srv = await startEchoServer({ pingMs: 60 });
  t.after(() => srv.close());
  const c = await rawClient(srv.port);
  await waitFor(() => c.frames.some((f) => f.opcode === 0x9), 2000, 'server ping');
  await waitFor(() => c.ended, 2000, 'dead peer dropped');
  assert.equal(srv.closes[0].code, 1006);
});

test('ws: works with the WebSocket client built into Node', { skip: typeof WebSocket !== 'function' }, async (t) => {
  const srv = await startEchoServer({ pingMs: 50 });
  t.after(() => srv.close());
  const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/`);
  const messages = [];
  let closed = null;
  ws.addEventListener('message', (e) => messages.push(e.data));
  ws.addEventListener('close', (e) => {
    closed = { code: e.code, reason: e.reason };
  });
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', reject);
  });
  ws.send('bonjour 👋');
  ws.send('x'.repeat(100000));
  await waitFor(() => messages.length >= 2, 3000, 'echoes');
  assert.equal(messages[0], 'echo:bonjour 👋');
  assert.equal(messages[1].length, 100005);
  // Pings are answered by the client automatically: still open after several intervals.
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(ws.readyState, WebSocket.OPEN);
  // Server-initiated close.
  srv.conns[0].close(4000, 'fin du test');
  await waitFor(() => closed, 3000, 'client close event');
  assert.equal(closed.code, 4000);
  assert.equal(closed.reason, 'fin du test');
  await waitFor(() => srv.closes.length === 1, 3000, 'server close event');
  assert.equal(srv.closes[0].code, 4000);
});
