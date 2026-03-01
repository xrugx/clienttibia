'use strict';

/**
 * WebDashboard - Painel Web com atualização em tempo real via WebSocket
 * 
 * Sem dependências externas - usa apenas módulos nativos do Node.js.
 * Serve uma página HTML e envia dados das sessões via WebSocket.
 */

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

class WebDashboard {
    /**
     * @param {import('../game/SessionManager')} sessionManager
     * @param {object} [options]
     * @param {number} [options.port=443] - Porta do servidor HTTPS
     * @param {string} [options.host='0.0.0.0'] - Host do servidor
     * @param {number} [options.refreshInterval=1000] - Intervalo de push (ms)
     * @param {object} [options.serverConfig] - { host, loginPort, gamePort }
     * @param {Array}  [options.accounts] - Array de accounts do config
     * @param {object} [options.ssl] - { cert, key, ca } caminhos dos certificados
     * @param {string} [options.domain] - Domínio do dashboard (ex: br.dragonspheres.com.br)
     */
    constructor(sessionManager, options = {}) {
        this.manager = sessionManager;
        this.port = options.port || 443;
        this.host = options.host || '0.0.0.0';
        this.refreshInterval = options.refreshInterval || 1000;
        this.serverConfig = options.serverConfig || {};
        this.accountsConfig = options.accounts || [];
        this.ssl = options.ssl || null;
        this.domain = options.domain || 'localhost';
        this.password = options.password || 'admin';
        this._server = null;
        this._httpRedirect = null;
        this._wsClients = new Set();
        this._sessions = new Map(); // token -> { createdAt }
        this._sessionMaxAge = 24 * 60 * 60 * 1000; // 24h
        this._timer = null;
        this._startTime = Date.now();
        // CPU tracking
        this._prevCpuInfo = this._getCpuTimes();
        this._cpuPercent = 0;
    }

    /**
     * Inicia o servidor HTTP + WebSocket
     */
    async start() {
        // Matar qualquer processo que já esteja usando a porta ANTES de criar o server
        await this._forceKillPort(this.port);
        if (this.port === 443) {
            await this._forceKillPort(80);
        }

        await this._createAndListen();

        // Redirect HTTP :80 → HTTPS :443
        if (this.ssl && this.port === 443) {
            this._startHttpRedirect();
        }

        // Push periódico de dados para todos os clientes WS
        this._timer = setInterval(() => {
            this._broadcast(this._buildPayload());
        }, this.refreshInterval);

        // Ping keepalive a cada 25s para manter conexões vivas
        this._pingTimer = setInterval(() => {
            for (const client of this._wsClients) {
                if (!client._wsAlive) {
                    client.destroy();
                    this._wsClients.delete(client);
                    continue;
                }
                client._wsAlive = false;
                try {
                    this._wsSendRaw(client, Buffer.alloc(0), 0x9);
                } catch (_) {
                    this._wsClients.delete(client);
                }
            }
        }, 25000);
    }

    /**
     * Cria o HTTP server e tenta ouvir na porta.
     * Se EADDRINUSE, mata o processo e retenta (até 3x).
     */
    async _createAndListen() {
        const MAX = 3;
        for (let attempt = 1; attempt <= MAX; attempt++) {
            try {
                await this._tryListen();
                return; // sucesso
            } catch (err) {
                if (err.code === 'EADDRINUSE' && attempt < MAX) {
                    console.log(`  ⚠ Porta ${this.port} em uso. Liberando... (tentativa ${attempt}/${MAX})`);
                    await this._forceKillPort(this.port);
                } else {
                    throw err;
                }
            }
        }
    }

    /**
     * Cria um novo server e retorna Promise que resolve quando estiver ouvindo.
     */
    _tryListen() {
        return new Promise((resolve, reject) => {
            // Sempre criar um server novo (o anterior fica em estado de erro)
            if (this._server) {
                try { this._server.close(); } catch (_) {}
            }

            const handler = (req, res) => this._handleHTTP(req, res);

            if (this.ssl) {
                // ═══ HTTPS com certificados SSL ═══
                const sslOptions = {
                    cert: fs.readFileSync(this.ssl.cert),
                    key: fs.readFileSync(this.ssl.key),
                };
                if (this.ssl.ca) {
                    sslOptions.ca = fs.readFileSync(this.ssl.ca);
                }
                this._server = https.createServer(sslOptions, handler);
            } else {
                // Fallback HTTP (dev local)
                this._server = http.createServer(handler);
            }

            this._server.on('upgrade', (req, socket, head) => {
                this._handleWebSocketUpgrade(req, socket, head);
            });

            const onError = (err) => {
                this._server.removeListener('error', onError);
                reject(err);
            };
            this._server.on('error', onError);

            const protocol = this.ssl ? 'https' : 'http';
            this._server.listen(this.port, this.host, () => {
                this._server.removeListener('error', onError);
                if (this.ssl) {
                    console.log(`\n  ✦ Dashboard HTTPS rodando em: https://${this.domain}\n`);
                } else {
                    console.log(`\n  ✦ Dashboard Web rodando em: http://localhost:${this.port}\n`);
                }
                resolve();
            });
        });
    }

    /**
     * Inicia servidor HTTP na porta 80 que redireciona tudo para HTTPS
     */
    _startHttpRedirect() {
        this._httpRedirect = http.createServer((req, res) => {
            const host = req.headers.host?.replace(/:.*/, '') || this.domain;
            res.writeHead(301, { Location: `https://${host}${req.url}` });
            res.end();
        });
        this._httpRedirect.listen(80, this.host, () => {
            console.log(`  ↳ Redirect HTTP :80 → HTTPS :443 ativo`);
        });
        this._httpRedirect.on('error', (err) => {
            console.log(`  ⚠ Redirect HTTP :80 falhou: ${err.message}`);
        });
    }

    /**
     * Mata qualquer processo que esteja usando a porta especificada
     */
    async _forceKillPort(port) {
        const myPid = String(process.pid);
        const pids = new Set();

        // Tentar vários métodos para encontrar PIDs na porta
        for (const cmd of [
            `lsof -t -i:${port}`,
            `fuser ${port}/tcp`,
            `ss -tlnp sport = :${port} | grep -oP 'pid=\\K[0-9]+'`,
        ]) {
            try {
                const out = execSync(`${cmd} 2>/dev/null || true`, {
                    encoding: 'utf-8', timeout: 3000,
                }).trim();
                if (out) {
                    out.split(/[\s,]+/).forEach(p => {
                        const n = p.replace(/[^0-9]/g, '');
                        if (n && n !== myPid) pids.add(n);
                    });
                }
            } catch (_) {}
        }

        if (pids.size === 0) return;

        console.log(`  → Matando processo(s) na porta ${port}: PID ${[...pids].join(', ')}`);
        for (const pid of pids) {
            try { execSync(`kill -9 ${pid} 2>/dev/null || true`, { timeout: 3000 }); } catch (_) {}
        }

        // Esperar a porta ser liberada (até 3s)
        for (let i = 0; i < 6; i++) {
            await new Promise(r => setTimeout(r, 500));
            try {
                const check = execSync(
                    `lsof -t -i:${port} 2>/dev/null || true`,
                    { encoding: 'utf-8', timeout: 2000 }
                ).trim().replace(/[^0-9]/g, '');
                if (!check || check === myPid) {
                    console.log(`  ✔ Porta ${port} liberada.`);
                    return;
                }
            } catch (_) {
                console.log(`  ✔ Porta ${port} liberada.`);
                return;
            }
        }
        console.log(`  ⚠ Porta ${port} pode ainda estar em uso, tentando mesmo assim...`);
    }

    /**
     * Para o servidor
     */
    stop() {
        if (this._timer) {
            clearInterval(this._timer);
            this._timer = null;
        }
        if (this._pingTimer) {
            clearInterval(this._pingTimer);
            this._pingTimer = null;
        }
        for (const client of this._wsClients) {
            try { client.destroy(); } catch (_) {}
        }
        this._wsClients.clear();
        if (this._server) {
            this._server.close();
            this._server = null;
        }
        if (this._httpRedirect) {
            this._httpRedirect.close();
            this._httpRedirect = null;
        }
    }

    // ─── HTTP Handler ───────────────────────────────────────────
    /**
     * Gera um token de sessão aleatório
     */
    _generateToken() {
        return crypto.randomBytes(32).toString('hex');
    }

    /**
     * Verifica se o token de sessão é válido
     */
    _isAuthenticated(req) {
        const cookies = this._parseCookies(req);
        const token = cookies['dash_token'];
        if (!token) return false;
        const session = this._sessions.get(token);
        if (!session) return false;
        if (Date.now() - session.createdAt > this._sessionMaxAge) {
            this._sessions.delete(token);
            return false;
        }
        return true;
    }

    /**
     * Parse cookies do request
     */
    _parseCookies(req) {
        const cookies = {};
        const header = req.headers.cookie;
        if (!header) return cookies;
        header.split(';').forEach(part => {
            const [k, ...v] = part.trim().split('=');
            cookies[k.trim()] = v.join('=').trim();
        });
        return cookies;
    }

    /**
     * Lê o body de um POST request
     */
    _readBody(req) {
        return new Promise((resolve) => {
            let body = '';
            req.on('data', chunk => { body += chunk; });
            req.on('end', () => resolve(body));
        });
    }

    async _handleHTTP(req, res) {
        // CORS
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

        // Preflight
        if (req.method === 'OPTIONS') {
            res.writeHead(204);
            res.end();
            return;
        }

        // ─── Login endpoint (sem auth) ───
        if (req.url === '/api/login' && req.method === 'POST') {
            const body = await this._readBody(req);
            try {
                const { password } = JSON.parse(body);
                if (password === this.password) {
                    const token = this._generateToken();
                    this._sessions.set(token, { createdAt: Date.now() });
                    const secure = this.ssl ? '; Secure' : '';
                    res.writeHead(200, {
                        'Content-Type': 'application/json',
                        'Set-Cookie': `dash_token=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400${secure}`
                    });
                    res.end(JSON.stringify({ ok: true }));
                } else {
                    res.writeHead(401, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: false, error: 'Senha incorreta' }));
                }
            } catch (_) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: 'Requisição inválida' }));
            }
            return;
        }

        // ─── Logout endpoint ───
        if (req.url === '/api/logout') {
            const cookies = this._parseCookies(req);
            const token = cookies['dash_token'];
            if (token) this._sessions.delete(token);
            const secure = this.ssl ? '; Secure' : '';
            res.writeHead(200, {
                'Content-Type': 'application/json',
                'Set-Cookie': `dash_token=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`
            });
            res.end(JSON.stringify({ ok: true }));
            return;
        }

        if (req.url === '/favicon.ico') {
            res.writeHead(204);
            res.end();
            return;
        }

        // ─── Todas as outras rotas precisam de auth ───
        if (!this._isAuthenticated(req)) {
            // Servir a página HTML (que tem a tela de login embutida)
            if (req.url === '/' || req.url === '/index.html') {
                const htmlPath = path.join(__dirname, '..', 'web', 'dashboard.html');
                fs.readFile(htmlPath, 'utf8', (err, data) => {
                    if (err) {
                        res.writeHead(500);
                        res.end('Erro ao carregar dashboard');
                        return;
                    }
                    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                    res.end(data);
                });
                return;
            }
            // API sem auth → 401
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Não autenticado' }));
            return;
        }

        // ─── Rotas autenticadas ───
        if (req.url === '/' || req.url === '/index.html') {
            const htmlPath = path.join(__dirname, '..', 'web', 'dashboard.html');
            fs.readFile(htmlPath, 'utf8', (err, data) => {
                if (err) {
                    res.writeHead(500);
                    res.end('Erro ao carregar dashboard');
                    return;
                }
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(data);
            });
        } else if (req.url === '/api/auth-check') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ authenticated: true }));
        } else if (req.url === '/api/status') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(this._buildPayload()));
        } else if (req.url === '/api/ws-check') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ws: true }));

        // ─── Config API: Get accounts ───
        } else if (req.url === '/api/accounts' && req.method === 'GET') {
            const cfg = global.__getConfig ? global.__getConfig() : {};
            const accounts = (cfg.accounts || []).map(a => ({
                name: a.name,
                characters: a.characters || [],
            }));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, accounts }));

        // ─── Config API: Add account ───
        } else if (req.url === '/api/accounts' && req.method === 'POST') {
            try {
                const body = JSON.parse(await this._readBody(req));
                if (!body.name || !body.password) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: false, error: 'Nome e senha são obrigatórios' }));
                    return;
                }
                const cfg = global.__getConfig ? global.__getConfig() : {};
                const exists = (cfg.accounts || []).find(a => a.name === body.name);
                if (exists) {
                    res.writeHead(409, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: false, error: 'Conta já existe' }));
                    return;
                }
                if (!cfg.accounts) cfg.accounts = [];
                cfg.accounts.push({
                    name: body.name,
                    password: body.password,
                    characters: body.characters || [],
                });
                if (global.__saveConfig) global.__saveConfig(cfg);
                this.accountsConfig = cfg.accounts;
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true }));
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: 'JSON inválido' }));
            }

        // ─── Config API: Update account ───
        } else if (req.url.startsWith('/api/accounts/') && req.method === 'PUT') {
            try {
                const accName = decodeURIComponent(req.url.split('/api/accounts/')[1]);
                const body = JSON.parse(await this._readBody(req));
                const cfg = global.__getConfig ? global.__getConfig() : {};
                const acc = (cfg.accounts || []).find(a => a.name === accName);
                if (!acc) {
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: false, error: 'Conta não encontrada' }));
                    return;
                }

                const oldChars = [...(acc.characters || [])];

                if (body.password !== undefined) acc.password = body.password;
                if (body.characters !== undefined) acc.characters = body.characters;
                if (body.name !== undefined && body.name !== accName) {
                    acc.name = body.name;
                }
                if (global.__saveConfig) global.__saveConfig(cfg);
                this.accountsConfig = cfg.accounts;

                // Remove sessions for characters that were removed from the account
                if (body.characters !== undefined) {
                    const removedChars = oldChars.filter(c => !body.characters.includes(c));
                    for (const charName of removedChars) {
                        const session = this.manager.getByCharacter(charName);
                        if (session) this.manager.removeSession(session.id);
                    }
                }

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true }));
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: 'JSON inválido' }));
            }

        // ─── Config API: Delete account ───
        } else if (req.url.startsWith('/api/accounts/') && req.method === 'DELETE') {
            try {
                const accName = decodeURIComponent(req.url.split('/api/accounts/')[1]);
                const cfg = global.__getConfig ? global.__getConfig() : {};
                const idx = (cfg.accounts || []).findIndex(a => a.name === accName);
                if (idx === -1) {
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: false, error: 'Conta não encontrada' }));
                    return;
                }
                cfg.accounts.splice(idx, 1);
                if (global.__saveConfig) global.__saveConfig(cfg);
                this.accountsConfig = cfg.accounts;

                // Stop and remove all sessions belonging to this account
                const sessionsToRemove = this.manager.getAll().filter(s => s.account === accName);
                for (const session of sessionsToRemove) {
                    this.manager.removeSession(session.id);
                }

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, removed: sessionsToRemove.length }));
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: 'Erro interno' }));
            }

        // ─── Session Control: Disconnect a character ───
        } else if (req.url.match(/^\/api\/session\/\d+\/disconnect$/) && req.method === 'POST') {
            try {
                const sessionId = parseInt(req.url.split('/')[3]);
                const session = this.manager.getById(sessionId);
                if (!session) {
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: false, error: 'Sessão não encontrada' }));
                    return;
                }
                if (!session.isRunning) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: false, error: 'Personagem já está desconectado' }));
                    return;
                }
                // Use global handler if available (stops bots + session)
                if (global.__disconnectCharacter) {
                    global.__disconnectCharacter(sessionId);
                } else {
                    session.stop();
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, message: `${session.character} desconectado` }));
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: e.message }));
            }

        // ─── Session Control: Connect a character ───
        } else if (req.url.match(/^\/api\/session\/\d+\/connect$/) && req.method === 'POST') {
            try {
                const sessionId = parseInt(req.url.split('/')[3]);
                const session = this.manager.getById(sessionId);
                if (!session) {
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: false, error: 'Sessão não encontrada' }));
                    return;
                }
                if (session.isRunning) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: false, error: 'Personagem já está conectado' }));
                    return;
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, message: `Conectando ${session.character}...` }));
                // Connect async after response
                setTimeout(async () => {
                    try {
                        if (global.__connectCharacter) {
                            await global.__connectCharacter(sessionId);
                        } else {
                            await session.start();
                        }
                    } catch (_) {}
                }, 200);
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: e.message }));
            }

        // ─── Restart all sessions ───
        } else if (req.url === '/api/restart' && req.method === 'POST') {
            try {
                if (!global.__restartAll) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: false, error: 'Restart não disponível' }));
                    return;
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, message: 'Reiniciando todos os personagens...' }));
                // Run restart async after response
                setTimeout(() => { global.__restartAll().catch(() => {}); }, 200);
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: e.message }));
            }

        // ─── Walk All: move all online characters in a direction ───
        } else if (req.url === '/api/walk-all' && req.method === 'POST') {
            try {
                const body = JSON.parse(await this._readBody(req));
                const direction = (body.direction || 'west').toLowerCase();
                const validDirs = ['north','south','east','west','northeast','northwest','southeast','southwest'];
                if (!validDirs.includes(direction)) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: false, error: 'Direção inválida. Use: ' + validDirs.join(', ') }));
                    return;
                }
                if (global.__walkAll) {
                    const result = global.__walkAll(direction);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: true, message: `Todos andaram para ${direction}`, moved: result.moved, total: result.total }));
                } else {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: false, error: 'Função walkAll não disponível' }));
                }
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: e.message }));
            }

        // ─── Global AutoChat: Get status ───
        } else if (req.url === '/api/global-autochat' && req.method === 'GET') {
            if (global.__globalAutoChatStatus) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, ...global.__globalAutoChatStatus() }));
            } else {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: 'Não disponível' }));
            }

        // ─── Global AutoChat: Start / Update ───
        } else if (req.url === '/api/global-autochat/start' && req.method === 'POST') {
            try {
                const body = JSON.parse(await this._readBody(req));
                if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: false, error: 'Informe ao menos uma mensagem' }));
                    return;
                }
                if (global.__globalAutoChatStart) {
                    const result = global.__globalAutoChatStart(body);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: true, message: 'Auto-chat global ativado', started: result.started }));
                } else {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: false, error: 'Função não disponível' }));
                }
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: e.message }));
            }

        // ─── Global AutoChat: Stop ───
        } else if (req.url === '/api/global-autochat/stop' && req.method === 'POST') {
            if (global.__globalAutoChatStop) {
                const result = global.__globalAutoChatStop();
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, message: 'Auto-chat global parado', stopped: result.stopped }));
            } else {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: 'Função não disponível' }));
            }

        } else {
            res.writeHead(404);
            res.end('Not Found');
        }
    }

    // ─── WebSocket (RFC 6455, sem deps) ──────────────────────────
    _handleWebSocketUpgrade(req, socket, head) {
        const key = req.headers['sec-websocket-key'];
        if (!key) {
            socket.destroy();
            return;
        }

        const acceptKey = crypto
            .createHash('sha1')
            .update(key + '258EAFA5-E914-47DA-95CA-5AB5DC11AD70')
            .digest('base64');

        const response = [
            'HTTP/1.1 101 Switching Protocols',
            'Upgrade: websocket',
            'Connection: Upgrade',
            `Sec-WebSocket-Accept: ${acceptKey}`,
            '',
            '',
        ].join('\r\n');

        socket.write(response);

        socket.setNoDelay(true);
        socket.setKeepAlive(true, 30000);
        socket._wsAlive = true;

        this._wsClients.add(socket);

        // Enviar dados iniciais após pequeno delay para garantir handshake
        setTimeout(() => {
            try {
                this._wsSend(socket, this._buildPayload());
            } catch (_) {}
        }, 100);

        socket.on('data', (buf) => {
            try {
                this._processWSData(socket, buf);
            } catch (_) {}
        });

        socket.on('close', () => {
            this._wsClients.delete(socket);
        });

        socket.on('error', () => {
            this._wsClients.delete(socket);
        });
    }

    _processWSData(socket, buf) {
        let offset = 0;
        while (offset < buf.length) {
            if (offset + 2 > buf.length) break;
            const frame = this._decodeWSFrame(buf.slice(offset));
            if (!frame) break;

            socket._wsAlive = true;

            if (frame.opcode === 0x9) {
                // Ping → Pong
                this._wsSendRaw(socket, frame.payload, 0xA);
            } else if (frame.opcode === 0xA) {
                // Pong - ok
            } else if (frame.opcode === 0x8) {
                // Close
                try { this._wsSendRaw(socket, Buffer.alloc(0), 0x8); } catch(_) {}
                socket.destroy();
                return;
            }

            offset += frame.totalLength;
        }
    }

    _wsSend(socket, data) {
        const json = JSON.stringify(data);
        const buf = Buffer.from(json, 'utf8');
        this._wsSendRaw(socket, buf, 0x1); // text frame
    }

    _wsSendRaw(socket, payload, opcode) {
        const len = payload.length;
        let header;

        if (len < 126) {
            header = Buffer.alloc(2);
            header[0] = 0x80 | opcode;
            header[1] = len;
        } else if (len < 65536) {
            header = Buffer.alloc(4);
            header[0] = 0x80 | opcode;
            header[1] = 126;
            header.writeUInt16BE(len, 2);
        } else {
            header = Buffer.alloc(10);
            header[0] = 0x80 | opcode;
            header[1] = 127;
            header.writeBigUInt64BE(BigInt(len), 2);
        }

        try {
            socket.write(Buffer.concat([header, payload]));
        } catch (_) {
            this._wsClients.delete(socket);
        }
    }

    _decodeWSFrame(buf) {
        if (buf.length < 2) return null;
        const opcode = buf[0] & 0x0F;
        const masked = (buf[1] & 0x80) !== 0;
        let payloadLen = buf[1] & 0x7F;
        let offset = 2;

        if (payloadLen === 126) {
            if (buf.length < 4) return null;
            payloadLen = buf.readUInt16BE(2);
            offset = 4;
        } else if (payloadLen === 127) {
            if (buf.length < 10) return null;
            payloadLen = Number(buf.readBigUInt64BE(2));
            offset = 10;
        }

        if (masked) {
            if (buf.length < offset + 4) return null;
            offset += 4;
        }

        const totalLength = offset + payloadLen;
        if (buf.length < totalLength) return null;

        const payload = Buffer.alloc(payloadLen);
        if (masked) {
            const mask = buf.slice(offset - 4, offset);
            for (let i = 0; i < payloadLen; i++) {
                payload[i] = buf[offset + i] ^ mask[i % 4];
            }
        } else {
            buf.copy(payload, 0, offset, offset + payloadLen);
        }

        return { opcode, payload, totalLength };
    }

    _broadcast(data) {
        for (const client of this._wsClients) {
            try {
                this._wsSend(client, data);
            } catch (_) {
                this._wsClients.delete(client);
            }
        }
    }

    // ─── Build Payload ──────────────────────────────────────────
    _buildPayload() {
        const sessions = this.manager.getAll();
        const uptime = Date.now() - this._startTime;

        // System stats
        this._updateCpuPercent();
        const systemStats = this._getSystemStats();

        const accounts = {};
        // Inicializar com config
        for (const acc of this.accountsConfig) {
            accounts[acc.name] = [];
        }

        for (const session of sessions) {
            const accName = session.account || 'desconhecida';
            if (!accounts[accName]) accounts[accName] = [];

            const player = session.getPlayer();
            const pos = session.getPlayerPosition();

            accounts[accName].push({
                id: session.id,
                character: session.character,
                isRunning: session.isRunning,
                connectedAt: session.connectedAt || null,
                level: player?.level || null,
                experience: player?.experience || 0,
                position: pos ? { x: pos.x, y: pos.y, z: pos.z } : null,
                hasCavebot: !!session.cavebot,
                cavebotActive: !!(session.cavebot && session.cavebot._enabled && !session.cavebot._paused),
                hasMiner: !!session.miner,
                minerActive: !!(session.miner && session.miner.isMining),
                money: session.autoCommand ? {
                    balance: session.autoCommand.data.balance,
                    moneyInHand: session.autoCommand.data.moneyInHand,
                    total: session.autoCommand.data.total,
                    totalSent: session.autoCommand.transfers.totalSent,
                    transferCount: session.autoCommand.transfers.count,
                    lastTransfers: session.autoCommand.transfers.history.slice(-5),
                    firstTransferAt: session.autoCommand.transfers.history.length > 0 ? session.autoCommand.transfers.history[0].timestamp : null,
                } : null,
            });
        }

        // Calcular totais de dinheiro
        let moneyTotalSent = 0;
        let moneyTransferCount = 0;
        for (const session of sessions) {
            if (session.autoCommand) {
                moneyTotalSent += session.autoCommand.transfers.totalSent || 0;
                moneyTransferCount += session.autoCommand.transfers.count || 0;
            }
        }

        return {
            type: 'update',
            timestamp: Date.now(),
            uptime,
            server: {
                host: this.serverConfig.host || '???',
                loginPort: this.serverConfig.loginPort || 0,
                gamePort: this.serverConfig.gamePort || 0,
            },
            system: systemStats,
            accounts,
            totals: {
                accounts: Object.keys(accounts).length,
                accountsOnline: Object.values(accounts).filter(chars => chars.some(c => c.isRunning)).length,
                characters: sessions.length,
                charactersOnline: sessions.filter(s => s.isRunning).length,
                moneyTotalSent,
                moneyTransferCount,
            },
            globalAutoChat: global.__globalAutoChatStatus ? global.__globalAutoChatStatus() : null,
        };
    }

    // ─── System Stats ───────────────────────────────────────────
    /**
     * Lê os tempos totais de CPU de /proc/stat (Linux)
     */
    _getCpuTimes() {
        try {
            const cpus = os.cpus();
            let totalIdle = 0, totalTick = 0;
            for (const cpu of cpus) {
                const t = cpu.times;
                totalIdle += t.idle;
                totalTick += t.user + t.nice + t.sys + t.idle + t.irq;
            }
            return { idle: totalIdle, total: totalTick };
        } catch (_) {
            return { idle: 0, total: 0 };
        }
    }

    /**
     * Calcula a % de uso de CPU comparando com a leitura anterior
     */
    _updateCpuPercent() {
        const now = this._getCpuTimes();
        const prev = this._prevCpuInfo;
        const idleDiff = now.idle - prev.idle;
        const totalDiff = now.total - prev.total;
        this._cpuPercent = totalDiff > 0
            ? Math.round((1 - idleDiff / totalDiff) * 1000) / 10
            : 0;
        this._prevCpuInfo = now;
    }

    /**
     * Retorna stats do sistema: CPU%, RAM%, totais
     */
    _getSystemStats() {
        const totalMem = os.totalmem();
        const freeMem = os.freemem();
        const usedMem = totalMem - freeMem;
        const memPercent = Math.round((usedMem / totalMem) * 1000) / 10;

        return {
            cpuPercent: this._cpuPercent,
            memPercent,
            memUsedMB: Math.round(usedMem / 1048576),
            memTotalMB: Math.round(totalMem / 1048576),
            cpuCores: os.cpus().length,
            platform: os.platform(),
            hostname: os.hostname(),
        };
    }
}

module.exports = WebDashboard;
