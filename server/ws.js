'use strict';

// Minimal, zero-dependency WebSocket server side (RFC 6455) for the integrated terminal
// (docs/TERMINAL.md section 5). Scope: text/binary messages, masked client frames,
// fragmentation, 7/16/64-bit lengths with a payload cap, ping/pong keepalive and the
// closing handshake. No extensions (permessage-deflate is never negotiated) and no subprotocols.
//
// Usage (inside an http.Server 'upgrade' listener, after the caller's own auth checks):
//   const ws = acceptUpgrade(req, socket, head);   // null when the handshake was rejected
//   if (ws) ws.on('message', (text) => …);

const crypto = require('node:crypto');
const http = require('node:http');
const { EventEmitter } = require('node:events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const DEFAULT_MAX_PAYLOAD = 1024 * 1024;
const DEFAULT_PING_MS = 30000;
const CLOSE_TIMEOUT_MS = 2000;

const OP_CONTINUATION = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

/** Sec-WebSocket-Accept value for a client key. */
function acceptKey(key) {
  return crypto.createHash('sha1').update(String(key) + GUID).digest('base64');
}

function headerTokens(value) {
  return String(value || '')
    .toLowerCase()
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** True when the request asks for a WebSocket upgrade (whatever its validity). */
function isWebSocketUpgrade(req) {
  return headerTokens(req.headers.upgrade).includes('websocket');
}

/**
 * Writes a plain HTTP error response on a raw upgrade socket and destroys it.
 * @param {import('node:net').Socket} socket
 * @param {number} status
 * @param {string} message French message (sent as JSON { ok:false, error })
 * @param {object} [headers]
 */
function rejectUpgrade(socket, status, message, headers) {
  if (!socket || socket.destroyed) return;
  const body = JSON.stringify({ ok: false, error: message });
  const lines = [
    `HTTP/1.1 ${status} ${http.STATUS_CODES[status] || 'Error'}`,
    'Content-Type: application/json; charset=utf-8',
    `Content-Length: ${Buffer.byteLength(body)}`,
    'Cache-Control: no-store',
    'X-Content-Type-Options: nosniff',
    'Connection: close',
  ];
  for (const [k, v] of Object.entries(headers || {})) lines.push(`${k}: ${v}`);
  try {
    socket.end(lines.join('\r\n') + '\r\n\r\n' + body);
  } catch {
    /* socket already gone */
  }
  // Make sure a client that keeps the connection open cannot hold it.
  setTimeout(() => socket.destroy(), 1000).unref();
}

/** Close codes a peer may legitimately send (RFC 6455 section 7.4). */
function validCloseCode(code) {
  return (code >= 1000 && code <= 1003) || (code >= 1007 && code <= 1014) || (code >= 3000 && code <= 4999);
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

function decodeUtf8(buf) {
  try {
    return { ok: true, text: utf8.decode(buf) };
  } catch {
    return { ok: false, text: '' };
  }
}

/** Builds one unmasked server frame. */
function encodeFrame(opcode, payload, fin = true) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.allocUnsafe(2);
    header[1] = len;
  } else if (len <= 0xffff) {
    header = Buffer.allocUnsafe(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = (fin ? 0x80 : 0) | opcode;
  return Buffer.concat([header, payload]);
}

/** A server-side WebSocket connection. Events: 'message' (data, isBinary), 'pong', 'close' (code, reason). */
class WebSocketConnection extends EventEmitter {
  /**
   * @param {import('node:net').Socket} socket upgraded socket (handshake already answered)
   * @param {Buffer} [head] bytes received after the HTTP headers
   * @param {{maxPayload?: number, pingMs?: number}} [opts]
   */
  constructor(socket, head, opts = {}) {
    super();
    this.socket = socket;
    this.maxPayload = opts.maxPayload || DEFAULT_MAX_PAYLOAD;
    this.pingMs = opts.pingMs === 0 ? 0 : opts.pingMs || DEFAULT_PING_MS;
    this.readyState = OPEN;
    this.buffer = Buffer.alloc(0);
    this.fragments = null; // { opcode, parts: Buffer[], size }
    this.closeSent = false;
    this.closeEmitted = false;
    this.closeTimer = null;
    this.awaitingPong = false;
    this.pingTimer = null;

    socket.setNoDelay(true);
    socket.setTimeout(0);
    socket.setKeepAlive(true, 30000);
    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('end', () => this._finish(1006, '', true));
    socket.on('close', () => this._finish(1006, '', false));
    socket.on('error', () => this._finish(1006, '', false));

    if (this.pingMs > 0) {
      this.pingTimer = setInterval(() => this._keepalive(), this.pingMs);
      this.pingTimer.unref();
    }
    if (head && head.length) this._onData(head);
  }

  /** Bytes queued on the socket and not yet flushed to the kernel. */
  get bufferedAmount() {
    return this.socket.writableLength;
  }

  /**
   * Sends a text (string) or binary (Buffer) message.
   * @returns {boolean} false when the connection is not open
   */
  send(data) {
    if (this.readyState !== OPEN) return false;
    const isText = typeof data === 'string';
    const payload = isText ? Buffer.from(data, 'utf8') : Buffer.from(data);
    return this._write(encodeFrame(isText ? OP_TEXT : OP_BINARY, payload));
  }

  /** Sends a ping (payload ≤ 125 bytes). */
  ping(data) {
    if (this.readyState !== OPEN) return false;
    const payload = data ? Buffer.from(data).subarray(0, 125) : Buffer.alloc(0);
    return this._write(encodeFrame(OP_PING, payload));
  }

  /** Starts the closing handshake. */
  close(code = 1000, reason = '') {
    if (this.readyState === CLOSED) return;
    if (!this.closeSent) this._sendClose(code, reason);
    if (this.readyState === OPEN) this.readyState = CLOSING;
    if (!this.closeTimer) {
      this.closeTimer = setTimeout(() => this.terminate(), CLOSE_TIMEOUT_MS);
      this.closeTimer.unref();
    }
  }

  /** Destroys the connection immediately. */
  terminate() {
    this._finish(1006, '', false);
  }

  // ---------------------------------------------------------------- internals

  _write(buf) {
    if (this.socket.destroyed) return false;
    try {
      this.socket.write(buf);
      return true;
    } catch {
      return false;
    }
  }

  _sendClose(code, reason) {
    this.closeSent = true;
    let payload = Buffer.alloc(0);
    if (code !== undefined && code !== null && code !== 1005) {
      const r = Buffer.from(String(reason || ''), 'utf8').subarray(0, 123);
      payload = Buffer.alloc(2 + r.length);
      payload.writeUInt16BE(code, 0);
      r.copy(payload, 2);
    }
    this._write(encodeFrame(OP_CLOSE, payload));
  }

  _keepalive() {
    if (this.readyState !== OPEN) return;
    if (this.awaitingPong) {
      // The peer missed a whole ping interval: the connection is dead.
      this.terminate();
      return;
    }
    this.awaitingPong = true;
    this.ping();
  }

  /** Protocol error: send a close frame with `code` and drop the connection. */
  _fail(code, reason) {
    if (this.readyState === CLOSED) return;
    if (!this.closeSent) this._sendClose(code, reason);
    this._finish(code, reason, true);
  }

  /**
   * Final state: emits 'close' once. Graceful endings flush pending frames (close frame) with
   * socket.end() before destroying the socket; terminate() destroys it right away.
   */
  _finish(code, reason, graceful) {
    if (this.closeTimer) clearTimeout(this.closeTimer);
    this.closeTimer = null;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    this.readyState = CLOSED;
    this.buffer = Buffer.alloc(0);
    this.fragments = null;
    const socket = this.socket;
    if (!socket.destroyed) {
      if (graceful) {
        if (!socket.writableEnded) {
          try {
            socket.end();
          } catch {
            /* ignore */
          }
        }
        setTimeout(() => socket.destroy(), 500).unref();
      } else {
        socket.destroy();
      }
    }
    if (!this.closeEmitted) {
      this.closeEmitted = true;
      this.emit('close', code, reason);
    }
  }

  _onData(chunk) {
    if (this.readyState === CLOSED) return;
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    while (this.readyState !== CLOSED) {
      const consumed = this._parseFrame();
      if (consumed <= 0) break;
    }
  }

  /** Parses one frame from the buffer. Returns the bytes consumed (0 = need more data). */
  _parseFrame() {
    const buf = this.buffer;
    if (buf.length < 2) return 0;
    const b0 = buf[0];
    const b1 = buf[1];
    const fin = (b0 & 0x80) !== 0;
    const rsv = b0 & 0x70;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let offset = 2;

    if (rsv !== 0) {
      this._fail(1002, 'Bits réservés non nuls');
      return -1;
    }
    if (!masked) {
      this._fail(1002, 'Trame client non masquée');
      return -1;
    }
    const isControl = (opcode & 0x8) !== 0;
    if (![OP_CONTINUATION, OP_TEXT, OP_BINARY, OP_CLOSE, OP_PING, OP_PONG].includes(opcode)) {
      this._fail(1002, 'Opcode inconnu');
      return -1;
    }
    if (isControl && (!fin || len > 125)) {
      this._fail(1002, 'Trame de contrôle invalide');
      return -1;
    }

    if (len === 126) {
      if (buf.length < offset + 2) return 0;
      len = buf.readUInt16BE(offset);
      offset += 2;
    } else if (len === 127) {
      if (buf.length < offset + 8) return 0;
      const big = buf.readBigUInt64BE(offset);
      offset += 8;
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) {
        this._fail(1009, 'Message trop volumineux');
        return -1;
      }
      len = Number(big);
    }

    // Enforce the cap before buffering the payload (fragments count towards the whole message).
    const pending = this.fragments && !isControl ? this.fragments.size : 0;
    if (len + pending > this.maxPayload) {
      this._fail(1009, 'Message trop volumineux');
      return -1;
    }

    if (buf.length < offset + 4 + len) return 0;
    const mask = buf.subarray(offset, offset + 4);
    offset += 4;
    const payload = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i++) payload[i] = buf[offset + i] ^ mask[i & 3];
    offset += len;
    this.buffer = buf.subarray(offset);

    this._handleFrame(fin, opcode, payload);
    return offset;
  }

  _handleFrame(fin, opcode, payload) {
    switch (opcode) {
      case OP_TEXT:
      case OP_BINARY:
        if (this.fragments) {
          this._fail(1002, 'Nouveau message avant la fin du précédent');
          return;
        }
        if (fin) this._deliver(opcode, payload);
        else this.fragments = { opcode, parts: [payload], size: payload.length };
        return;
      case OP_CONTINUATION:
        if (!this.fragments) {
          this._fail(1002, 'Fragment de continuation inattendu');
          return;
        }
        this.fragments.parts.push(payload);
        this.fragments.size += payload.length;
        if (fin) {
          const { opcode: op, parts } = this.fragments;
          this.fragments = null;
          this._deliver(op, Buffer.concat(parts));
        }
        return;
      case OP_PING:
        if (this.readyState === OPEN) this._write(encodeFrame(OP_PONG, payload));
        return;
      case OP_PONG:
        this.awaitingPong = false;
        this.emit('pong', payload);
        return;
      case OP_CLOSE:
        this._onClose(payload);
        return;
      default:
        this._fail(1002, 'Opcode inconnu');
    }
  }

  _deliver(opcode, payload) {
    if (this.readyState !== OPEN) return; // data after our close frame is discarded
    if (opcode === OP_TEXT) {
      const decoded = decodeUtf8(payload);
      if (!decoded.ok) {
        this._fail(1007, 'Texte UTF-8 invalide');
        return;
      }
      this.emit('message', decoded.text, false);
    } else {
      this.emit('message', payload, true);
    }
  }

  _onClose(payload) {
    let code = 1005;
    let reason = '';
    if (payload.length === 1) {
      this._fail(1002, 'Trame de fermeture invalide');
      return;
    }
    if (payload.length >= 2) {
      code = payload.readUInt16BE(0);
      if (!validCloseCode(code)) {
        this._fail(1002, 'Code de fermeture invalide');
        return;
      }
      const decoded = decodeUtf8(payload.subarray(2));
      if (!decoded.ok) {
        this._fail(1007, 'Raison de fermeture invalide');
        return;
      }
      reason = decoded.text;
    }
    if (!this.closeSent) this._sendClose(code === 1005 ? 1000 : code, '');
    this._finish(code, reason, true);
  }
}

/**
 * Validates the opening handshake and answers it. Writes 400/426 and returns null when invalid.
 * Authentication (Host, Origin, token) is the caller's job and must happen BEFORE this call.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:net').Socket} socket
 * @param {Buffer} head
 * @param {{maxPayload?: number, pingMs?: number}} [opts]
 * @returns {WebSocketConnection|null}
 */
function acceptUpgrade(req, socket, head, opts) {
  if (req.method !== 'GET') {
    rejectUpgrade(socket, 405, 'Méthode non autorisée.', { Allow: 'GET' });
    return null;
  }
  const [major, minor] = String(req.httpVersion || '1.0').split('.').map(Number);
  if (major < 1 || (major === 1 && minor < 1)) {
    rejectUpgrade(socket, 400, 'HTTP/1.1 requis pour un WebSocket.');
    return null;
  }
  if (!isWebSocketUpgrade(req) || !headerTokens(req.headers.connection).includes('upgrade')) {
    rejectUpgrade(socket, 400, 'En-têtes de mise à niveau WebSocket manquants.');
    return null;
  }
  if (String(req.headers['sec-websocket-version'] || '').trim() !== '13') {
    rejectUpgrade(socket, 426, 'Version de WebSocket non prise en charge (13 attendue).', { 'Sec-WebSocket-Version': '13' });
    return null;
  }
  const key = String(req.headers['sec-websocket-key'] || '').trim();
  let decodedKey = null;
  if (/^[A-Za-z0-9+/]{22}==$/.test(key)) decodedKey = Buffer.from(key, 'base64');
  if (!decodedKey || decodedKey.length !== 16) {
    rejectUpgrade(socket, 400, 'Clé Sec-WebSocket-Key invalide.');
    return null;
  }
  if (socket.destroyed) return null;
  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${acceptKey(key)}`,
    '',
    '',
  ].join('\r\n'));
  return new WebSocketConnection(socket, head, opts);
}

module.exports = {
  acceptUpgrade,
  acceptKey,
  rejectUpgrade,
  isWebSocketUpgrade,
  encodeFrame,
  WebSocketConnection,
  CONNECTING,
  OPEN,
  CLOSING,
  CLOSED,
  DEFAULT_MAX_PAYLOAD,
};
