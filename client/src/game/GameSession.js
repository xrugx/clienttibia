'use strict';

/**
 * GameSession - Isolated session wrapper for a single account/character
 * 
 * Each GameSession owns its own Game instance with fully isolated state:
 * - Independent Connection, Protocol, Map, Player, Containers
 * - Independent reconnection logic
 * - Unique session ID for identification
 * 
 * Multiple GameSessions can run concurrently without interference.
 */

const EventEmitter = require('events');
const Game = require('./Game');
const { Logger } = require('../utils');

let _sessionCounter = 0;

class GameSession extends EventEmitter {
    /**
     * @param {object} options
     * @param {string} options.account - Account name
     * @param {string} options.password - Account password
     * @param {string} options.character - Character name to login
     * @param {string} [options.host='127.0.0.1'] - Server host
     * @param {number} [options.loginPort=7171] - Login server port
     * @param {number} [options.gamePort=7172] - Game server port
     * @param {string} [options.rsaKey] - Custom RSA public key (hex)
     * @param {string} [options.logLevel='info'] - Log level
     * @param {object} [options.reconnect] - Reconnection settings
     * @param {boolean} [options.reconnect.enabled=false] - Enable auto-reconnect
     * @param {number} [options.reconnect.delay=3000] - Delay between attempts (ms)
     * @param {number} [options.reconnect.maxAttempts=5] - Max attempts (0 = infinite)
     * @param {string} [options.label] - Human-friendly label for logging
     */
    constructor(options = {}) {
        super();

        this.id = ++_sessionCounter;
        this.label = options.label || `Session-${this.id}`;

        // Credentials
        this.account = options.account;
        this.password = options.password;
        this.character = options.character;

        // Server config
        this.serverConfig = {
            host: options.host || '127.0.0.1',
            loginPort: options.loginPort || 7171,
            gamePort: options.gamePort || 7172,
            rsaKey: options.rsaKey || null,
            logLevel: options.logLevel || 'info',
        };

        // Reconnection config
        this.reconnect = {
            enabled: options.reconnect?.enabled ?? false,
            delay: options.reconnect?.delay ?? 3000,
            maxAttempts: options.reconnect?.maxAttempts ?? 5,
        };

        // Logger scoped to this session
        this.logger = new Logger(this.label);
        this.logger.setLevel(this.serverConfig.logLevel);

        // State
        /** @type {Game|null} */
        this.game = null;
        this.isRunning = false;
        this.connectedAt = null;
        this._reconnectAttempt = 0;
        this._stopped = false;
    }

    /**
     * Create a fresh, isolated Game instance for this session
     * @private
     * @returns {Game}
     */
    _createGame() {
        const game = new Game({
            host: this.serverConfig.host,
            loginPort: this.serverConfig.loginPort,
            gamePort: this.serverConfig.gamePort,
            rsaKey: this.serverConfig.rsaKey,
            logLevel: this.serverConfig.logLevel,
        });

        // Default error handler to prevent unhandled 'error' crashes
        game.on('error', (err) => {
            this.logger.error(`Game error: ${err.message}`);
            // Only forward if there are listeners; otherwise absorb to prevent crash
            if (this.listenerCount('error') > 0) {
                this.emit('error', err);
            }
            this.emit('sessionEvent', { sessionId: this.id, label: this.label, event: 'error', args: [err] });
        });

        // Forward all game events prefixed with session metadata
        const forwardEvent = (event) => {
            game.on(event, (...args) => {
                this.emit(event, ...args);
                // Also emit a generic 'sessionEvent' so SessionManager can listen
                this.emit('sessionEvent', { sessionId: this.id, label: this.label, event, args });
            });
        };

        const events = [
            'login', 'disconnected', 'loginError',
            'death', 'ping',
            'mapDescription', 'mapTopRow', 'mapRightColumn', 'mapBottomRow', 'mapLeftColumn',
            'updateTile', 'addThing', 'updateThing', 'removeThing', 'moveCreature',
            'openContainer', 'closeContainer', 'addContainerItem', 'updateContainerItem', 'removeContainerItem',
            'setInventory', 'removeInventory',
            'openShop', 'shopGoods', 'closeShop',
            'ownTradeOffer', 'counterTradeOffer', 'closeTrade',
            'worldLight', 'magicEffect', 'animatedText', 'distanceEffect', 'creatureSquare',
            'creatureHealth', 'creatureLight', 'creatureOutfit', 'creatureSpeed',
            'creatureSkull', 'creatureShield', 'creatureWalkthrough',
            'editTextWindow', 'editHouseWindow',
            'playerStats', 'playerSkills', 'playerIcons', 'cancelTarget',
            'creatureSpeak', 'channelList', 'openChannel', 'openPrivateChannel',
            'textMessage', 'cancelWalk',
            'floorChangeUp', 'floorChangeDown',
            'outfitWindow',
            'vipEntry', 'vipLogin', 'vipLogout',
            'tutorialHint', 'mapMarker',
            'questList', 'questInfo',
            'extendedOpcode',
        ];

        for (const event of events) {
            forwardEvent(event);
        }

        return game;
    }

    /**
     * Start this session (login the character)
     * @returns {Promise<void>}
     */
    async start() {
        if (this.isRunning) {
            this.logger.warn('Session already running');
            return;
        }

        this._stopped = false;
        this._reconnectAttempt = 0;
        await this._connect();
    }

    /**
     * Internal connect routine
     * @private
     */
    async _connect() {
        // Always create a brand-new Game instance to ensure full isolation
        this.game = this._createGame();

        // Wire up disconnect handler for reconnection
        this.game.on('disconnected', () => {
            this.isRunning = false;
            this.connectedAt = null;
            this.logger.warn(`${this.character} desconectado.`);
            this.emit('sessionDisconnected', { sessionId: this.id, label: this.label, character: this.character });

            if (!this._stopped && this.reconnect.enabled) {
                this._handleReconnect();
            }
        });

        try {
            this.logger.info(`Conectando ${this.character} em ${this.serverConfig.host}:${this.serverConfig.loginPort}...`);
            await this.game.login(this.account, this.password, this.character);
            this.isRunning = true;
            this.connectedAt = Date.now();
            this._reconnectAttempt = 0;
            this.logger.info(`${this.character} logado com sucesso!`);
            this.emit('sessionStarted', { sessionId: this.id, label: this.label, character: this.character });
        } catch (err) {
            this.logger.error(`Falha no login de ${this.character}: ${err.message}`);
            this.emit('sessionError', { sessionId: this.id, label: this.label, character: this.character, error: err });
            throw err;
        }
    }

    /**
     * Handle automatic reconnection
     * @private
     */
    async _handleReconnect() {
        const max = this.reconnect.maxAttempts;
        if (max > 0 && this._reconnectAttempt >= max) {
            this.logger.error(`Reconexão de ${this.character} falhou após ${max} tentativas.`);
            this.emit('sessionReconnectFailed', { sessionId: this.id, label: this.label, character: this.character });
            return;
        }

        this._reconnectAttempt++;
        const attempt = this._reconnectAttempt;
        this.logger.info(`Reconectando ${this.character} em ${this.reconnect.delay}ms (tentativa ${attempt}${max > 0 ? '/' + max : ''})...`);

        await new Promise(r => setTimeout(r, this.reconnect.delay));

        if (this._stopped) return;

        try {
            await this._connect();
        } catch (err) {
            this.logger.error(`Reconexão de ${this.character} falhou: ${err.message}`);
            // _connect failure doesn't re-trigger reconnect automatically,
            // but the next disconnect event will if reconnect is enabled
            if (!this._stopped && this.reconnect.enabled) {
                this._handleReconnect();
            }
        }
    }

    /**
     * Stop this session (disconnect and disable reconnection)
     */
    stop() {
        this._stopped = true;
        this.isRunning = false;
        if (this.game) {
            this.game.disconnect();
            this.game.removeAllListeners();
            this.game = null;
        }
        this.logger.info(`Sessão ${this.character} encerrada.`);
        this.emit('sessionStopped', { sessionId: this.id, label: this.label, character: this.character });
    }

    /**
     * Get the Player object for this session
     * @returns {import('../core/Player')|null}
     */
    getPlayer() {
        return this.game ? this.game.getPlayer() : null;
    }

    /**
     * Get the authoritative player position.
     * Falls back to the protocol-level playerPosition which is always
     * updated (even when map tile parsing fails).
     * @returns {import('../core/Position')|null}
     */
    getPlayerPosition() {
        const player = this.getPlayer();
        if (player?.position && (player.position.x !== 0 || player.position.y !== 0)) {
            return player.position;
        }
        // Fallback: ProtocolGame.playerPosition is updated by GameParse even on parse errors
        const proto = this.game?.protocol;
        if (proto?.playerPosition && (proto.playerPosition.x !== 0 || proto.playerPosition.y !== 0)) {
            const Position = require('../core/Position');
            return Position.from(proto.playerPosition);
        }
        return player?.position || null;
    }

    /**
     * Get the GameMap for this session
     * @returns {import('../core/Map').GameMap|null}
     */
    getMap() {
        return this.game ? this.game.getMap() : null;
    }

    /**
     * Get open containers for this session
     * @returns {Map|null}
     */
    getContainers() {
        return this.game ? this.game.getContainers() : null;
    }

    /**
     * Get the ProtocolGame sender for this session (to send actions)
     * @returns {import('../protocol/GameSend')|null}
     */
    getSender() {
        return this.game?.protocol?.sender || null;
    }

    /**
     * Get the ProtocolGame for this session
     * @returns {import('../protocol/ProtocolGame')|null}
     */
    getProtocol() {
        return this.game?.protocol || null;
    }

    /**
     * Quick status summary
     * @returns {object}
     */
    getStatus() {
        const player = this.getPlayer();
        return {
            sessionId: this.id,
            label: this.label,
            character: this.character,
            account: this.account,
            isRunning: this.isRunning,
            health: player?.health ?? 0,
            maxHealth: player?.maxHealth ?? 0,
            mana: player?.mana ?? 0,
            maxMana: player?.maxMana ?? 0,
            position: player?.position ?? null,
        };
    }
}

module.exports = GameSession;
