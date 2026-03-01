'use strict';

/**
 * SessionManager - Manages multiple GameSessions concurrently
 * 
 * Responsibilities:
 * - Create/start/stop individual sessions
 * - Start all sessions in parallel
 * - Aggregate events from all sessions
 * - Provide lookup by session ID, character name, or label
 * - Ensure full isolation: each session has its own Game, Connection, Protocol, Map, etc.
 * 
 * @example
 * const manager = new SessionManager({
 *     host: 'sv.spirit-baiak.com',
 *     loginPort: 7171,
 *     gamePort: 7172,
 *     logLevel: 'info',
 * });
 * 
 * manager.addAccount({ account: 'acc1', password: 'pw1', character: 'Char1' });
 * manager.addAccount({ account: 'acc2', password: 'pw2', character: 'Char2' });
 * 
 * await manager.startAll();
 * 
 * // Get a specific session
 * const session = manager.getByCharacter('Char1');
 * session.getProtocol().sender.say('Hello!');
 */

const EventEmitter = require('events');
const GameSession = require('./GameSession');
const { Logger } = require('../utils');

class SessionManager extends EventEmitter {
    /**
     * @param {object} [defaults] - Default server settings shared by all sessions
     * @param {string} [defaults.host='127.0.0.1']
     * @param {number} [defaults.loginPort=7171]
     * @param {number} [defaults.gamePort=7172]
     * @param {string} [defaults.rsaKey]
     * @param {string} [defaults.logLevel='info']
     * @param {object} [defaults.reconnect]
     */
    constructor(defaults = {}) {
        super();
        this.defaults = defaults;

        /** @type {Map<number, GameSession>} sessionId → GameSession */
        this.sessions = new Map();

        this.logger = new Logger('SessionManager');
        this.logger.setLevel(defaults.logLevel || 'info');
    }

    /**
     * Add an account/character and create its isolated session
     * @param {object} accountConfig
     * @param {string} accountConfig.account - Account name
     * @param {string} accountConfig.password - Password
     * @param {string} accountConfig.character - Character name
     * @param {string} [accountConfig.label] - Human-friendly label
     * @param {object} [accountConfig.reconnect] - Override reconnect settings
     * @param {object} [accountConfig.server] - Override server settings (host, loginPort, gamePort)
     * @returns {GameSession} The created session
     */
    addAccount(accountConfig) {
        const serverOverride = accountConfig.server || {};
        const reconnectOverride = accountConfig.reconnect || this.defaults.reconnect || {};

        const session = new GameSession({
            account: accountConfig.account,
            password: accountConfig.password,
            character: accountConfig.character,
            label: accountConfig.label || accountConfig.character,
            host: serverOverride.host || this.defaults.host,
            loginPort: serverOverride.loginPort || this.defaults.loginPort,
            gamePort: serverOverride.gamePort || this.defaults.gamePort,
            rsaKey: serverOverride.rsaKey || this.defaults.rsaKey,
            logLevel: this.defaults.logLevel,
            reconnect: reconnectOverride,
        });

        // Forward session lifecycle events to the manager
        const lifecycleEvents = [
            'sessionStarted', 'sessionDisconnected', 'sessionStopped',
            'sessionError', 'sessionReconnectFailed', 'sessionEvent',
        ];
        for (const evt of lifecycleEvents) {
            session.on(evt, (data) => this.emit(evt, data));
        }

        this.sessions.set(session.id, session);
        this.logger.info(`Conta adicionada: ${session.character} (Session #${session.id})`);

        return session;
    }

    /**
     * Add multiple accounts at once
     * @param {Array<object>} accountConfigs
     * @returns {GameSession[]}
     */
    addAccounts(accountConfigs) {
        return accountConfigs.map(cfg => this.addAccount(cfg));
    }

    /**
     * Start a single session by ID
     * @param {number} sessionId
     * @returns {Promise<void>}
     */
    async startSession(sessionId) {
        const session = this.sessions.get(sessionId);
        if (!session) throw new Error(`Session ${sessionId} not found`);
        await session.start();
    }

    /**
     * Start ALL sessions concurrently (each login runs in parallel)
     * Uses Promise.allSettled so one failure doesn't block others.
     * @param {number} [delayBetween=1000] - Delay (ms) between starting each session to avoid server flood
     * @returns {Promise<Array<{sessionId: number, character: string, status: string, error?: string}>>}
     */
    async startAll(delayBetween = 1000) {
        const results = [];
        const sessionList = [...this.sessions.values()];

        this.logger.info(`Iniciando ${sessionList.length} sessão(ões)...`);

        for (let i = 0; i < sessionList.length; i++) {
            const session = sessionList[i];
            try {
                await session.start();
                results.push({ sessionId: session.id, character: session.character, status: 'ok' });
            } catch (err) {
                results.push({ sessionId: session.id, character: session.character, status: 'error', error: err.message });
            }

            // Delay before the next session to avoid flooding the server
            if (i < sessionList.length - 1 && delayBetween > 0) {
                await new Promise(r => setTimeout(r, delayBetween));
            }
        }

        const ok = results.filter(r => r.status === 'ok').length;
        const failed = results.filter(r => r.status === 'error').length;
        this.logger.info(`Resultado: ${ok} conectado(s), ${failed} falha(s)`);

        return results;
    }

    /**
     * Stop a single session by ID
     * @param {number} sessionId
     */
    stopSession(sessionId) {
        const session = this.sessions.get(sessionId);
        if (!session) throw new Error(`Session ${sessionId} not found`);
        session.stop();
    }

    /**
     * Stop ALL sessions
     */
    stopAll() {
        this.logger.info('Encerrando todas as sessões...');
        for (const session of this.sessions.values()) {
            session.stop();
        }
    }

    /**
     * Remove a session entirely
     * @param {number} sessionId
     */
    removeSession(sessionId) {
        const session = this.sessions.get(sessionId);
        if (session) {
            session.stop();
            session.removeAllListeners();
            this.sessions.delete(sessionId);
            this.logger.info(`Sessão #${sessionId} removida`);
        }
    }

    // ──────── Lookup helpers ────────

    /**
     * Get session by ID
     * @param {number} sessionId
     * @returns {GameSession|undefined}
     */
    getById(sessionId) {
        return this.sessions.get(sessionId);
    }

    /**
     * Get session by character name (case-insensitive)
     * @param {string} name
     * @returns {GameSession|undefined}
     */
    getByCharacter(name) {
        const lower = name.toLowerCase();
        for (const session of this.sessions.values()) {
            if (session.character.toLowerCase() === lower) return session;
        }
        return undefined;
    }

    /**
     * Get session by label
     * @param {string} label
     * @returns {GameSession|undefined}
     */
    getByLabel(label) {
        for (const session of this.sessions.values()) {
            if (session.label === label) return session;
        }
        return undefined;
    }

    /**
     * Get all sessions as an array
     * @returns {GameSession[]}
     */
    getAll() {
        return [...this.sessions.values()];
    }

    /**
     * Get running sessions only
     * @returns {GameSession[]}
     */
    getRunning() {
        return this.getAll().filter(s => s.isRunning);
    }

    /**
     * Get status summary of all sessions
     * @returns {Array<object>}
     */
    getStatusAll() {
        return this.getAll().map(s => s.getStatus());
    }

    /**
     * Total number of sessions
     * @returns {number}
     */
    get size() {
        return this.sessions.size;
    }
}

module.exports = SessionManager;
