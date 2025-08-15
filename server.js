const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const net = require('net');
const path = require('path');

const PORT = process.env.PORT || 8080;
const ALLOW_ANY = process.env.ALLOW_ANY === '1';
const ALLOW_HOSTS = (process.env.ALLOW_HOSTS || '').split(',').map(s => s.trim()).filter(Boolean);
const MIN_PORT = parseInt(process.env.MIN_PORT || '1', 10);
const MAX_PORT = parseInt(process.env.MAX_PORT || '65535', 10);
const IDLE_TIMEOUT_MS = parseInt(process.env.IDLE_TIMEOUT_MS || '300000', 10);
const MAX_CONN = parseInt(process.env.MAX_CONN || '50', 10);

let currentConns = 0;

function isPrivateIPv4(ip) {
  if (/^10\./.test(ip)) return true;
  if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(ip)) return true;
  if (/^192\.168\./.test(ip)) return true;
  return false;
}

function isLoopbackOrSensitive(ip) {
  if (/^127\./.test(ip)) return true;
  if (ip === '0.0.0.0') return true;
  if (/^169\.254\.169\.254$/.test(ip)) return true;
  return false;
}

function hostAllowed(host) {
  if (ALLOW_ANY) return !isLoopbackOrSensitive(host);
  if (isPrivateIPv4(host) && !isLoopbackOrSensitive(host)) return true;
  if (ALLOW_HOSTS.includes(host)) return true;
  return false;
}

function portAllowed(port) {
  return Number.isInteger(port) && port >= MIN_PORT && port <= MAX_PORT;
}

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });

app.use(express.static(path.join(__dirname, 'public')));

wss.on('connection', (ws, req) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const host = url.searchParams.get('host') || '';
    const port = parseInt(url.searchParams.get('port') || '', 10);

    if (!host || !portAllowed(port) || !hostAllowed(host)) {
      ws.send(JSON.stringify({ type: 'error', message: 'Host/port not allowed.' }));
      ws.close();
      return;
    }

    if (currentConns >= MAX_CONN) {
      ws.send(JSON.stringify({ type: 'error', message: 'Server busy.' }));
      ws.close();
      return;
    }

    const tcp = net.createConnection({ host, port });
    currentConns++;

    let idleTimer = setTimeout(() => {
      ws.send(JSON.stringify({ type: 'info', message: 'Idle timeout.' }));
      ws.close();
      tcp.destroy();
    }, IDLE_TIMEOUT_MS);

    function resetIdle() {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        ws.send(JSON.stringify({ type: 'info', message: 'Idle timeout.' }));
        ws.close();
        tcp.destroy();
      }, IDLE_TIMEOUT_MS);
    }

    tcp.on('connect', () => {
      ws.send(JSON.stringify({ type: 'status', message: `Connected to ${host}:${port}` }));
    });

    tcp.on('data', chunk => {
      ws.send(JSON.stringify({ type: 'data', direction: 'in', base64: chunk.toString('base64') }));
      resetIdle();
    });

    tcp.on('end', () => {
      ws.send(JSON.stringify({ type: 'status', message: 'Remote closed.' }));
      ws.close();
    });

    tcp.on('error', err => {
      ws.send(JSON.stringify({ type: 'error', message: `TCP error: ${err.message}` }));
      ws.close();
    });

    ws.on('message', msg => {
      resetIdle();
      try {
        const payload = JSON.parse(msg.toString());
        if (payload.type === 'send') {
          if (payload.mode === 'text') tcp.write(payload.text || '');
          else if (payload.mode === 'hex') {
            const cleaned = (payload.hex || '').replace(/[\s:]/g, '');
            tcp.write(Buffer.from(cleaned, 'hex'));
          } else if (payload.mode === 'base64') {
            tcp.write(Buffer.from(payload.base64 || '', 'base64'));
          }
        }
      } catch (e) {
        ws.send(JSON.stringify({ type: 'error', message: `Bad message: ${e.message}` }));
      }
    });

    ws.on('close', () => {
      clearTimeout(idleTimer);
      tcp.destroy();
      currentConns--;
    });

    ws.on('error', () => {
      clearTimeout(idleTimer);
      tcp.destroy();
      currentConns--;
    });

  } catch (e) {
    ws.send(JSON.stringify({ type: 'error', message: e.message }));
    ws.close();
  }
});

server.listen(PORT, () => {
  console.log(`web-netcat running on http://localhost:${PORT}`);
});
