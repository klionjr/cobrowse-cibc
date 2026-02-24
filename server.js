const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const PORT = process.env.PORT || 3000;

// Store active sessions: { sessionCode: { client: ws, agent: ws, page: null } }
const sessions = new Map();

// Generate a simple 6-character session code
function generateSessionCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

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

  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(500);
      res.end('Error loading page');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(content);
  });
});

// WebSocket server
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  let currentSession = null;
  let role = null;

  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data);

      switch (message.type) {
        case 'create-session':
          // Client wants to create a new session
          const code = generateSessionCode();
          sessions.set(code, { client: ws, agent: null, page: null, cursor: null });
          currentSession = code;
          role = 'client';
          ws.send(JSON.stringify({ type: 'session-created', code }));
          console.log(`[${new Date().toLocaleTimeString()}] Session created: ${code}`);
          break;

        case 'join-session':
          // Agent wants to join a session
          const session = sessions.get(message.code);
          if (session && session.client) {
            session.agent = ws;
            currentSession = message.code;
            role = 'agent';
            ws.send(JSON.stringify({ type: 'session-joined', code: message.code }));

            // Send the current page state if available
            if (session.page) {
              ws.send(JSON.stringify({ type: 'full-page', html: session.page }));
            }

            // Notify client that agent joined
            session.client.send(JSON.stringify({ type: 'agent-joined' }));
            console.log(`[${new Date().toLocaleTimeString()}] Agent joined session: ${message.code}`);
          } else {
            ws.send(JSON.stringify({ type: 'error', message: 'Session not found or expired' }));
          }
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
║   AI Voice Assistant (NEW!):                                     ║
║   → http://localhost:${PORT}/ai-agent                                ║
║                                                                  ║
╠══════════════════════════════════════════════════════════════════╣
║                                                                  ║
║   HOW TO TEST AI ASSISTANT:                                      ║
║                                                                  ║
║   1. Open http://localhost:${PORT}/ in Tab 1 (Client)                ║
║   2. Open http://localhost:${PORT}/ai-agent in Tab 2 (AI)            ║
║   3. On Client: Click "Share My Screen" button                   ║
║   4. On Client: Click "Start Screen Share" - note the code       ║
║   5. On AI Agent: Enter code + your Gemini API key               ║
║   6. Click microphone and speak - AI sees your screen!           ║
║                                                                  ║
╚══════════════════════════════════════════════════════════════════╝
  `);
});
