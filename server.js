const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;

// ========================================
// SECURITY CONFIGURATION
// ========================================
// Set this in Render.com environment variables
const AGENT_SECRET_KEY = process.env.AGENT_SECRET_KEY || 'demo-secret-change-in-production';
const AGENT_USERNAME = process.env.AGENT_USERNAME || 'Ellaite';
const AGENT_PASSWORD = process.env.AGENT_PASSWORD || 'Ellaite';
const SESSION_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const MAX_JOIN_ATTEMPTS = 5;
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',')
  : null; // null = allow all (for demo), set in production

// Store active sessions: { sessionCode: { client: ws, agent: ws, page: null, createdAt, expiresAt } }
const sessions = new Map();

// Rate limiting: { ip: { attempts: number, windowStart: timestamp } }
const rateLimits = new Map();

// Audit log (in production, send to proper logging service)
const auditLog = [];

// ========================================
// SECURITY FUNCTIONS
// ========================================

// Generate cryptographically secure session code
function generateSessionCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const randomBytes = crypto.randomBytes(6);
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(randomBytes[i] % chars.length);
  }
  // Ensure code isn't already in use
  if (sessions.has(code)) {
    return generateSessionCode();
  }
  return code;
}

// Validate agent secret key
function validateAgentKey(providedKey) {
  if (!providedKey || !AGENT_SECRET_KEY) return false;
  // Timing-safe comparison to prevent timing attacks
  try {
    return crypto.timingSafeEqual(
      Buffer.from(providedKey),
      Buffer.from(AGENT_SECRET_KEY)
    );
  } catch {
    return false;
  }
}

// Rate limiting check
function checkRateLimit(ip) {
  const now = Date.now();
  const record = rateLimits.get(ip);

  if (!record) {
    rateLimits.set(ip, { attempts: 1, windowStart: now });
    return { allowed: true, remaining: MAX_JOIN_ATTEMPTS - 1 };
  }

  // Reset window if expired
  if (now - record.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateLimits.set(ip, { attempts: 1, windowStart: now });
    return { allowed: true, remaining: MAX_JOIN_ATTEMPTS - 1 };
  }

  // Check if over limit
  if (record.attempts >= MAX_JOIN_ATTEMPTS) {
    const retryAfter = Math.ceil((record.windowStart + RATE_LIMIT_WINDOW_MS - now) / 1000);
    return { allowed: false, retryAfter };
  }

  record.attempts++;
  return { allowed: true, remaining: MAX_JOIN_ATTEMPTS - record.attempts };
}

// Audit logging
function logAudit(event, details) {
  const entry = {
    timestamp: new Date().toISOString(),
    event,
    ...details
  };
  auditLog.push(entry);
  console.log(`[AUDIT] ${entry.timestamp} | ${event} |`, JSON.stringify(details));

  // Keep only last 1000 entries in memory (in production, persist to database/service)
  if (auditLog.length > 1000) {
    auditLog.shift();
  }
}

// Get client IP (works with proxies like Render.com)
function getClientIP(ws, req) {
  if (req) {
    return req.headers['x-forwarded-for']?.split(',')[0]?.trim()
      || req.headers['x-real-ip']
      || req.socket?.remoteAddress
      || 'unknown';
  }
  return ws._socket?.remoteAddress || 'unknown';
}

// Clean up expired sessions
function cleanupExpiredSessions() {
  const now = Date.now();
  for (const [code, session] of sessions) {
    if (now > session.expiresAt) {
      logAudit('SESSION_EXPIRED', { code, duration: now - session.createdAt });

      if (session.client && session.client.readyState === WebSocket.OPEN) {
        session.client.send(JSON.stringify({ type: 'session-ended', reason: 'expired' }));
        session.client.close();
      }
      if (session.agent && session.agent.readyState === WebSocket.OPEN) {
        session.agent.send(JSON.stringify({ type: 'session-ended', reason: 'expired' }));
        session.agent.close();
      }
      sessions.delete(code);
    }
  }
}

// Run cleanup every minute
setInterval(cleanupExpiredSessions, 60000);

// Clean up old rate limit entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, record] of rateLimits) {
    if (now - record.windowStart > RATE_LIMIT_WINDOW_MS * 2) {
      rateLimits.delete(ip);
    }
  }
}, 300000);

// Simple static file server
const server = http.createServer((req, res) => {
  let filePath;

  if (req.url === '/' || req.url === '/client' || req.url === '/client/') {
    filePath = path.join(__dirname, 'client', 'index.html');
  } else if (req.url === '/agent' || req.url === '/agent/') {
    filePath = path.join(__dirname, 'agent', 'index.html');
  } else if (req.url === '/ai-agent' || req.url === '/ai-agent/') {
    filePath = path.join(__dirname, 'ai-agent', 'index.html');
  } else {
    res.writeHead(404);
    res.end('Not Found');
    return;
  }

  fs.readFile(filePath, 'utf8', (err, content) => {
    if (err) {
      res.writeHead(500);
      res.end('Error loading page');
      return;
    }

    // Inject environment variables into agent page
    if (filePath.includes('agent')) {
      content = content.replace(
        "const VALID_USERNAME = 'Ellaite';",
        `const VALID_USERNAME = '${AGENT_USERNAME}';`
      );
      content = content.replace(
        "const VALID_PASSWORD = 'Ellaite';",
        `const VALID_PASSWORD = '${AGENT_PASSWORD}';`
      );
      content = content.replace(
        "const AGENT_SECRET_KEY = 'demo-secret-change-in-production';",
        `const AGENT_SECRET_KEY = '${AGENT_SECRET_KEY}';`
      );
    }

    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(content);
  });
});

// WebSocket server with origin validation
const wss = new WebSocket.Server({
  server,
  verifyClient: (info, callback) => {
    const origin = info.origin || info.req.headers.origin;
    const ip = getClientIP(null, info.req);

    // If ALLOWED_ORIGINS is set, validate origin
    if (ALLOWED_ORIGINS && ALLOWED_ORIGINS.length > 0) {
      const isAllowed = ALLOWED_ORIGINS.some(allowed =>
        origin && (origin === allowed || origin.endsWith(allowed))
      );
      if (!isAllowed) {
        logAudit('CONNECTION_REJECTED', { ip, origin, reason: 'invalid_origin' });
        callback(false, 403, 'Forbidden');
        return;
      }
    }

    callback(true);
  }
});

wss.on('connection', (ws, req) => {
  let currentSession = null;
  let role = null;
  const clientIP = getClientIP(ws, req);

  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data);

      switch (message.type) {
        case 'create-session':
          // Client wants to create a new session
          const code = generateSessionCode();
          const now = Date.now();
          sessions.set(code, {
            client: ws,
            agent: null,
            page: null,
            cursor: null,
            createdAt: now,
            expiresAt: now + SESSION_TIMEOUT_MS,
            clientIP: clientIP
          });
          currentSession = code;
          role = 'client';
          ws.send(JSON.stringify({ type: 'session-created', code }));
          logAudit('SESSION_CREATED', { code, clientIP });
          break;

        case 'join-session':
          // ========================================
          // AGENT AUTHENTICATION & RATE LIMITING
          // ========================================

          // 1. Check rate limit
          const rateCheck = checkRateLimit(clientIP);
          if (!rateCheck.allowed) {
            ws.send(JSON.stringify({
              type: 'error',
              message: `Too many attempts. Try again in ${rateCheck.retryAfter} seconds.`
            }));
            logAudit('RATE_LIMITED', { clientIP, code: message.code });
            break;
          }

          // 2. Validate agent secret key
          if (!validateAgentKey(message.agentKey)) {
            ws.send(JSON.stringify({
              type: 'error',
              message: 'Invalid agent credentials'
            }));
            logAudit('AUTH_FAILED', {
              clientIP,
              code: message.code,
              reason: 'invalid_agent_key'
            });
            break;
          }

          // 3. Check if session exists
          const session = sessions.get(message.code);
          if (!session || !session.client) {
            ws.send(JSON.stringify({
              type: 'error',
              message: 'Session not found or expired'
            }));
            logAudit('JOIN_FAILED', {
              clientIP,
              code: message.code,
              reason: 'session_not_found'
            });
            break;
          }

          // 4. Check if session already has an agent
          if (session.agent && session.agent.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
              type: 'error',
              message: 'Session already has an agent connected'
            }));
            logAudit('JOIN_FAILED', {
              clientIP,
              code: message.code,
              reason: 'agent_already_connected'
            });
            break;
          }

          // 5. Success - join the session
          session.agent = ws;
          session.agentIP = clientIP;
          session.agentJoinedAt = Date.now();
          currentSession = message.code;
          role = 'agent';

          ws.send(JSON.stringify({ type: 'session-joined', code: message.code }));

          // Send the current page state if available
          if (session.page) {
            ws.send(JSON.stringify({ type: 'full-page', html: session.page, passwordLength: session.passwordLength || 0 }));
          }

          // Notify client that agent joined
          session.client.send(JSON.stringify({ type: 'agent-joined' }));

          logAudit('AGENT_JOINED', {
            code: message.code,
            agentIP: clientIP,
            clientIP: session.clientIP
          });
          break;

        case 'full-page':
          // Client sending full page HTML
          if (currentSession && role === 'client') {
            const sess = sessions.get(currentSession);
            if (sess) {
              sess.page = message.html;
              sess.passwordLength = message.passwordLength || 0;
              if (sess.agent && sess.agent.readyState === WebSocket.OPEN) {
                sess.agent.send(JSON.stringify({ type: 'full-page', html: message.html, passwordLength: sess.passwordLength }));
              }
            }
          }
          break;

        case 'cursor-move':
          // Client sending cursor position
          if (currentSession && role === 'client') {
            const sess = sessions.get(currentSession);
            if (sess) {
              sess.cursor = { x: message.x, y: message.y };
              if (sess.agent && sess.agent.readyState === WebSocket.OPEN) {
                sess.agent.send(JSON.stringify({
                  type: 'cursor-move',
                  x: message.x,
                  y: message.y
                }));
              }
            }
          }
          break;

        case 'voice-message':
          // Client sending voice transcript to agent
          if (currentSession && role === 'client') {
            const sess = sessions.get(currentSession);
            if (sess && sess.agent && sess.agent.readyState === WebSocket.OPEN) {
              sess.agent.send(JSON.stringify({
                type: 'voice-message',
                text: message.text
              }));
            }
          }
          break;

        case 'ai-response':
          // Agent sending AI response to client
          if (currentSession && role === 'agent') {
            const sess = sessions.get(currentSession);
            if (sess && sess.client && sess.client.readyState === WebSocket.OPEN) {
              sess.client.send(JSON.stringify({
                type: 'ai-response',
                text: message.text
              }));
            }
          }
          break;

        case 'end-session':
          if (currentSession) {
            const sess = sessions.get(currentSession);
            if (sess) {
              if (sess.client && sess.client.readyState === WebSocket.OPEN) {
                sess.client.send(JSON.stringify({ type: 'session-ended' }));
              }
              if (sess.agent && sess.agent.readyState === WebSocket.OPEN) {
                sess.agent.send(JSON.stringify({ type: 'session-ended' }));
              }
              sessions.delete(currentSession);
              console.log(`[${new Date().toLocaleTimeString()}] Session ended: ${currentSession}`);
            }
          }
          break;
      }
    } catch (err) {
      console.error('Error processing message:', err);
    }
  });

  ws.on('close', () => {
    if (currentSession) {
      const session = sessions.get(currentSession);
      if (session) {
        if (role === 'client') {
          if (session.agent && session.agent.readyState === WebSocket.OPEN) {
            session.agent.send(JSON.stringify({ type: 'client-disconnected' }));
          }
          sessions.delete(currentSession);
          console.log(`[${new Date().toLocaleTimeString()}] Client disconnected, session removed: ${currentSession}`);
        } else if (role === 'agent') {
          session.agent = null;
          if (session.client && session.client.readyState === WebSocket.OPEN) {
            session.client.send(JSON.stringify({ type: 'agent-disconnected' }));
          }
          console.log(`[${new Date().toLocaleTimeString()}] Agent disconnected from session: ${currentSession}`);
        }
      }
    }
  });
});

server.listen(PORT, () => {
  const isDefaultKey = AGENT_SECRET_KEY === 'demo-secret-change-in-production';

  console.log(`
╔══════════════════════════════════════════════════════════════════╗
║                                                                  ║
║           CIBC CO-BROWSE DEMO - SERVER RUNNING                   ║
║                                                                  ║
╠══════════════════════════════════════════════════════════════════╣
║                                                                  ║
║   Client Page (CIBC Password Reset):                             ║
║   → http://localhost:${PORT}/                                        ║
║                                                                  ║
║   Human Agent Dashboard:                                         ║
║   → http://localhost:${PORT}/agent                                   ║
║                                                                  ║
║   AI Voice Assistant:                                            ║
║   → http://localhost:${PORT}/ai-agent                                ║
║                                                                  ║
╠══════════════════════════════════════════════════════════════════╣
║                                                                  ║
║   SECURITY SETTINGS:                                             ║
║   ${isDefaultKey ? '⚠️  USING DEFAULT AGENT KEY (set AGENT_SECRET_KEY env var)' : '✅ Agent secret key configured'}      ║
║   • Session timeout: ${SESSION_TIMEOUT_MS / 60000} minutes                                ║
║   • Rate limit: ${MAX_JOIN_ATTEMPTS} attempts per ${RATE_LIMIT_WINDOW_MS / 1000} seconds                          ║
║   • Agent key: ${isDefaultKey ? 'demo-secret-change-in-production' : '********'}             ║
║   • Agent login: ${AGENT_USERNAME} / ********                              ║
║                                                                  ║
╠══════════════════════════════════════════════════════════════════╣
║                                                                  ║
║   HOW TO TEST:                                                   ║
║                                                                  ║
║   1. Open http://localhost:${PORT}/ in Tab 1 (Client)                ║
║   2. Open http://localhost:${PORT}/agent in Tab 2 (Agent)            ║
║   3. Client: Click "Share My Screen" → "Start Screen Share"      ║
║   4. Agent: Enter session code + agent key                       ║
║   5. For AI assistant, also enter your Gemini API key            ║
║                                                                  ║
╚══════════════════════════════════════════════════════════════════╝
  `);
});
