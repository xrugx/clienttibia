'use strict';

/**
 * Game - High-level game state and session manager
 * 
 * Orchestrates the login flow and game session:
 * 1. Connect to login server → get character list
 * 2. Connect to game server with selected character
 * 3. Manage game state and expose high-level API
 */

const EventEmitter = require('events');
const { ProtocolLogin, ProtocolGame } = require('../protocol');
const { Logger } = require('../utils');

class Game extends EventEmitter {
    /**
     * @param {object} options
     * @param {string} [options.host='127.0.0.1'] - Server host
     * @param {number} [options.loginPort=7171] - Login server port
     * @param {number} [options.gamePort=7172] - Game server port
     * @param {string} [options.rsaKey] - Custom RSA key (hex)
     * @param {string} [options.logLevel='info'] - Log level
     */
    constructor(options = {}) {
        super();
        this.options = {
            host: options.host || '127.0.0.1',
            loginPort: options.loginPort || 7171,
            gamePort: options.gamePort || 7172,
            rsaKey: options.rsaKey || null,
            logLevel: options.logLevel || 'info'
        };

        this.logger = new Logger('Game');
        this.logger.setLevel(this.options.logLevel);

        /** @type {ProtocolGame} */
        this.protocol = null;

        // Login result
        this.motd = '';
        this.characters = [];
        this.premiumDays = 0;

        // State
        this.isLoggedIn = false;
    }

    /**
     * Connect to login server and retrieve character list
     * @param {string} account
     * @param {string} password
     * @returns {Promise<{motd: string, characters: Array, premiumDays: number}>}
     */
    async getCharacterList(account, password) {
        const loginProtocol = new ProtocolLogin({
            host: this.options.host,
            port: this.options.loginPort,
            rsaKey: this.options.rsaKey
        });

        const result = await loginProtocol.login(account, password);
        this.motd = result.motd;
        this.characters = result.characters;
        this.premiumDays = result.premiumDays;

        return result;
    }

    /**
     * Login to game server with a specific character
     * @param {string} account
     * @param {string} password
     * @param {string} characterName
     * @param {string} [gameHost] - Override game host (from character list)
     * @param {number} [gamePort] - Override game port (from character list)
     * @returns {Promise<ProtocolGame>}
     */
    async loginToGame(account, password, characterName, gameHost, gamePort) {
        const host = gameHost || this.options.host;
        const port = gamePort || this.options.gamePort;

        this.protocol = new ProtocolGame({
            host: host,
            port: port,
            rsaKey: this.options.rsaKey,
            logLevel: this.options.logLevel
        });

        // Forward all events
        this._forwardEvents();

        // Wait for login success
        return new Promise(async (resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error('Login timeout (15s)'));
            }, 15000);

            this.protocol.once('login', (data) => {
                clearTimeout(timeout);
                this.isLoggedIn = true;
                this.logger.info(`Logged in as ${characterName} (ID: ${data.playerId})`);
                resolve(this.protocol);
            });

            this.protocol.once('error', (err) => {
                clearTimeout(timeout);
                reject(err);
            });

            this.protocol.once('loginError', (data) => {
                clearTimeout(timeout);
                reject(new Error(data.message));
            });

            try {
                await this.protocol.login(account, characterName, password);
            } catch (err) {
                clearTimeout(timeout);
                reject(err);
            }
        });
    }

    /**
     * Full login flow: login server → select character → game server
     * @param {string} account
     * @param {string} password
     * @param {string|number} characterNameOrIndex - Character name or index (0-based)
     * @returns {Promise<ProtocolGame>}
     */
    async login(account, password, characterNameOrIndex) {
        this.logger.info('Starting login flow...');

        // Step 1: Get character list
        const charList = await this.getCharacterList(account, password);

        if (charList.characters.length === 0) {
            throw new Error('No characters found on account');
        }

        // Step 2: Select character
        let character;
        if (typeof characterNameOrIndex === 'number') {
            character = charList.characters[characterNameOrIndex];
        } else {
            character = charList.characters.find(c =>
                c.name.toLowerCase() === characterNameOrIndex.toLowerCase()
            );
        }

        if (!character) {
            throw new Error(`Character "${characterNameOrIndex}" not found. Available: ${charList.characters.map(c => c.name).join(', ')}`);
        }

        this.logger.info(`Selected character: ${character.name} @ ${character.world} (${character.ip}:${character.port})`);

        // Step 3: Connect to game server
        return this.loginToGame(
            account,
            password,
            character.name,
            character.ip,
            character.port
        );
    }

    /**
     * Forward all ProtocolGame events
     * @private
     */
    _forwardEvents() {
        if (!this.protocol) return;

        // Handle 'error' separately to prevent unhandled crashes
        this.protocol.on('error', (err) => {
            this.logger.error(`Protocol error: ${err.message}`);
            if (this.listenerCount('error') > 0) {
                this.emit('error', err);
            }
        });

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
            'extendedOpcode'
        ];

        for (const event of events) {
            this.protocol.on(event, (...args) => this.emit(event, ...args));
        }
    }

    /**
     * Get the player object
     * @returns {Player|null}
     */
    getPlayer() {
        return this.protocol ? this.protocol.player : null;
    }

    /**
     * Get the authoritative player position.
     * Falls back to protocol-level playerPosition which is always updated
     * even when tile parsing fails (e.g. DatManager not loaded).
     * @returns {Position|null}
     */
    getPlayerPosition() {
        if (!this.protocol) return null;
        const player = this.protocol.player;
        if (player?.position && (player.position.x !== 0 || player.position.y !== 0)) {
            return player.position;
        }
        // Fallback to the protocol parser's always-updated position
        if (this.protocol.playerPosition && (this.protocol.playerPosition.x !== 0 || this.protocol.playerPosition.y !== 0)) {
            const { Position } = require('../core');
            return Position.from(this.protocol.playerPosition);
        }
        return player?.position || null;
    }

    /**
     * Get the game map
     * @returns {GameMap|null}
     */
    getMap() {
        return this.protocol ? this.protocol.map : null;
    }

    /**
     * Get open containers
     * @returns {Map|null}
     */
    getContainers() {
        return this.protocol ? this.protocol.containers : null;
    }

    /**
     * Disconnect from game
     */
    disconnect() {
        if (this.protocol) {
            this.protocol.disconnect();
        }
        this.isLoggedIn = false;
    }
}

module.exports = Game;
