/* ===========================================================
   零依赖 WebSocket 服务端 (RFC 6455)
   -----------------------------------------------------------
   只实现业务需要的部分：
     · HTTP Upgrade 握手 + Sec-WebSocket-Accept
     · 解析客户端帧（必须带 mask）
     · 发送服务端帧（不 mask）
     · 支持文本帧、Ping/Pong、Close
     · 支持分片续帧、1MB 上限保护
   不依赖 ws / socket.io，避免 npm 安装，便于驿站现场离线部署。
   =========================================================== */
'use strict';

const crypto = require('crypto');
const { EventEmitter } = require('events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_PAYLOAD = 1024 * 1024; // 1MB

/* ---------- 握手 ---------- */
function acceptKey(key) {
  return crypto.createHash('sha1').update(key + GUID).digest('base64');
}

/* ---------- 帧编码（服务端 -> 客户端，不 mask） ---------- */
function encodeFrame(opcode, payloadBuf) {
  const len = payloadBuf.length;
  let header;

  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(len, 6);
  }
  header[0] = 0x80 | (opcode & 0x0f); // FIN + opcode
  return Buffer.concat([header, payloadBuf]);
}

/* ---------- 帧解码（客户端 -> 服务端，必须 mask） ---------- */
function decodeFrame(buf) {
  if (buf.length < 2) return null;
  const fin = (buf[0] & 0x80) !== 0;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f;
  let offset = 2;

  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2);
    offset = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    const hi = buf.readUInt32BE(2);
    const lo = buf.readUInt32BE(6);
    if (hi !== 0) return null; // 超过 4GB，拒绝
    len = lo;
    offset = 10;
  }

  if (len > MAX_PAYLOAD) {
    throw new Error('payload too large: ' + len);
  }

  let maskKey = null;
  if (masked) {
    if (buf.length < offset + 4) return null;
    maskKey = buf.slice(offset, offset + 4);
    offset += 4;
  }

  if (buf.length < offset + len) return null; // 数据未收全

  let payload = buf.slice(offset, offset + len);
  if (masked) {
    payload = Buffer.from(payload); // 复制，避免污染原 buffer
    for (let i = 0; i < payload.length; i++) {
      payload[i] ^= maskKey[i & 3];
    }
  }

  return {
    fin: fin,
    opcode: opcode,
    payload: payload,
    consumed: offset + len
  };
}

/* ===========================================================
   单条连接
   =========================================================== */
class WSConnection extends EventEmitter {
  constructor(socket, req) {
    super();
    this.socket = socket;
    this.req = req;
    this.alive = true;
    this.closed = false;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];      // 分片续帧
    this.fragmentOpcode = 0;
    this.remote = (req.socket && req.socket.remoteAddress) || 'unknown';
    this.role = 'guest';      // 由上层设置：b / c / device
    this.id = crypto.randomBytes(6).toString('hex');
    this.connectedAt = Date.now();

    socket.setNoDelay(true);
    socket.on('data', (d) => this._onData(d));
    socket.on('error', () => this._destroy());
    socket.on('close', () => this._destroy());
    socket.on('end', () => this._destroy());
  }

  _onData(chunk) {
    if (this.closed) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);

    // 循环解析所有完整帧
    let guard = 0;
    while (this.buffer.length >= 2 && guard++ < 200) {
      let frame;
      try {
        frame = decodeFrame(this.buffer);
      } catch (e) {
        this.close(1009, 'frame too large');
        return;
      }
      if (!frame) break; // 数据不完整，等待更多

      this.buffer = this.buffer.slice(frame.consumed);
      this._handleFrame(frame);
    }
  }

  _handleFrame(frame) {
    const op = frame.opcode;

    // 控制帧
    if (op === 0x8) {            // Close
      this.close(1000, 'bye');
      return;
    }
    if (op === 0x9) {            // Ping -> Pong
      this._sendRaw(0xA, frame.payload);
      return;
    }
    if (op === 0xA) {            // Pong
      this.alive = true;
      return;
    }

    // 数据帧
    if (op === 0x1 || op === 0x2) {
      if (!frame.fin) {
        this.fragments = [frame.payload];
        this.fragmentOpcode = op;
        return;
      }
      this._deliver(op, frame.payload);
      return;
    }
    if (op === 0x0) {            // 续帧
      if (!this.fragments.length) return;
      this.fragments.push(frame.payload);
      const total = this.fragments.reduce((a, b) => a + b.length, 0);
      if (total > MAX_PAYLOAD) { this.close(1009, 'too large'); return; }
      if (frame.fin) {
        const full = Buffer.concat(this.fragments);
        const fop = this.fragmentOpcode;
        this.fragments = [];
        this.fragmentOpcode = 0;
        this._deliver(fop, full);
      }
      return;
    }
  }

  _deliver(opcode, payload) {
    this.alive = true;
    if (opcode === 0x1) {
      const text = payload.toString('utf8');
      let msg;
      try {
        msg = JSON.parse(text);
      } catch (e) {
        this.emit('error-msg', { raw: text, reason: 'invalid json' });
        return;
      }
      this.emit('message', msg);
    } else {
      this.emit('binary', payload);
    }
  }

  _sendRaw(opcode, payloadBuf) {
    if (this.closed) return;
    try {
      this.socket.write(encodeFrame(opcode, payloadBuf));
    } catch (e) {
      this._destroy();
    }
  }

  send(obj) {
    if (this.closed) return false;
    try {
      const json = typeof obj === 'string' ? obj : JSON.stringify(obj);
      this._sendRaw(0x1, Buffer.from(json, 'utf8'));
      return true;
    } catch (e) {
      this._destroy();
      return false;
    }
  }

  ping() {
    this.alive = false;
    this._sendRaw(0x9, Buffer.alloc(0));
  }

  close(code = 1000, reason = '') {
    if (this.closed) return;
    const buf = Buffer.alloc(2 + Buffer.byteLength(reason));
    buf.writeUInt16BE(code, 0);
    buf.write(reason, 2, 'utf8');
    this._sendRaw(0x8, buf);
    setTimeout(() => this._destroy(), 30);
  }

  _destroy() {
    if (this.closed) return;
    this.closed = true;
    this.alive = false;
    try { this.socket.destroy(); } catch (e) {}
    this.emit('close');
  }
}

/* ===========================================================
   WebSocket 服务（挂到 http server 上）
   =========================================================== */
class WSServer extends EventEmitter {
  constructor(httpServer, options = {}) {
    super();
    this.clients = new Set();
    this.path = options.path || '/ws';

    httpServer.on('upgrade', (req, socket, head) => {
      this._handleUpgrade(req, socket, head);
    });

    // 心跳：30 秒探活一次，两次无响应即断开
    this.heartbeat = setInterval(() => {
      this.clients.forEach((c) => {
        if (!c.alive) { c._destroy(); return; }
        c.ping();
      });
    }, 30000);
    if (this.heartbeat.unref) this.heartbeat.unref();
  }

  _handleUpgrade(req, socket, head) {
    const url = req.url.split('?')[0];

    if (url !== this.path) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }

    const key = req.headers['sec-websocket-key'];
    const upgrade = (req.headers['upgrade'] || '').toLowerCase();

    if (upgrade !== 'websocket' || !key) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }

    const accept = acceptKey(key);
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      'Sec-WebSocket-Accept: ' + accept + '\r\n' +
      '\r\n'
    );

    const conn = new WSConnection(socket, req);
    this.clients.add(conn);

    conn.on('close', () => {
      this.clients.delete(conn);
      this.emit('disconnect', conn);
    });

    conn.on('message', (msg) => this.emit('message', conn, msg));
    conn.on('error-msg', (info) => this.emit('badmsg', conn, info));

    if (head && head.length) conn._onData(head);

    this.emit('connect', conn);
  }

  broadcast(obj, filter) {
    let n = 0;
    this.clients.forEach((c) => {
      if (filter && !filter(c)) return;
      if (c.send(obj)) n++;
    });
    return n;
  }

  count() { return this.clients.size; }

  close() {
    clearInterval(this.heartbeat);
    this.clients.forEach((c) => c.close(1001, 'server shutdown'));
    this.clients.clear();
  }
}

module.exports = { WSServer, WSConnection, encodeFrame, decodeFrame, acceptKey };
