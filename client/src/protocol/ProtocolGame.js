'use strict';

/**
 * ProtocolGame - Tibia 8.60 Game Protocol Handler
 * 
 * Manages the complete game session:
 * - Connection to game server (with challenge/response)
 * - Packet dispatch to parsers
 * - Game state management
 * - Event emission for all game events
 * 
 * Emits events for every parsed opcode and high-level game events.
 */

const EventEmitter = require('events');
const { Connection, NetworkMessage } = require('../network');
const { ServerOpcodes, PROTOCOL_VERSION } = require('../constants');
const GameParse = require('./GameParse');
const GameSend = require('./GameSend');
const { Player, Creature, Position, GameMap, Container, Item } = require('../core');
const DatManager = require('../core/DatManager');
const { Logger } = require('../utils');

class ProtocolGame extends EventEmitter {
    /**
     * @param {object} options
     * @param {string} options.host - Game server host
     * @param {number} options.port - Game server port
     * @param {string} [options.rsaKey] - Custom RSA key (hex)
     * @param {string} [options.logLevel='info'] - Log level
     */
    constructor(options = {}) {
        super();
        this.host = options.host || '127.0.0.1';
        this.port = options.port || 7172;
        this.logger = new Logger('ProtocolGame');
        this.logger.setLevel(options.logLevel || 'info');

        // Network
        this.connection = new Connection({ host: this.host, port: this.port });
        if (options.rsaKey) {
            this.connection.setRsaKey(options.rsaKey);
        }

        // Game state
        this.player = new Player();
        this.map = new GameMap();
        this.knownCreatures = new Map();    // creatureId -> Creature
        this.containers = new Map();        // containerId -> Container
        this.channels = new Map();          // channelId -> { id, name }
        this.datManager = new DatManager();
        this.playerPosition = new Position();
        this.worldLight = { level: 0, color: 0 };
        this.isConnected = false;
        this.isLoggedIn = false;

        // Load DAT file for proper item parsing (extra byte, walkability, ground speed)
        this._loadDatFile();

        // Challenge response data
        this._challenge = null;
        this._account = '';
        this._character = '';
        this._password = '';

        // Parsers and senders
        this.parser = new GameParse(this);
        this.sender = new GameSend(this.connection);

        // Ping interval
        this._pingInterval = null;

        // Bind events
        this.connection.on('packet', (msg) => this._onPacket(msg));
        this.connection.on('error', (err) => {
            this.logger.error('Connection error:', err.message);
            this.emit('error', err);
        });
        this.connection.on('disconnected', () => {
            this._onDisconnect();
        });
    }

    // ============================================================
    // Connection management
    // ============================================================

    /**
     * Connect to game server and login
     * @param {string} account
     * @param {string} character
     * @param {string} password
     * @returns {Promise<void>}
     */
    async login(account, character, password) {
        this._account = account;
        this._character = character;
        this._password = password;

        this.logger.info(`Connecting to game server ${this.host}:${this.port}...`);

        await this.connection.connect();
        this.isConnected = true;
        this.logger.info('Connected, waiting for challenge...');

        // The game server sends a challenge packet first (0x1F)
        // We wait for it in _onPacket and then send the login
    }

    /**
     * Disconnect from game server
     */
    disconnect() {
        try {
            this.sender.sendLogout();
        } catch (e) {
            // May fail if already disconnected
        }

        this._stopPing();
        this.connection.disconnect();
        this.isConnected = false;
        this.isLoggedIn = false;
    }

    /**
     * Load item database for proper item parsing
     * @param {object} data - { stackable: number[], fluid: number[], splash: number[] }
     */
    loadItemDatabase(data) {
        this.datManager.loadDatabase(data);
    }

    /**
     * Attempt to load the Tibia .dat file for proper item parsing.
     * Searches for the decrypted DAT in the standard data directory.
     * @private
     */
    _loadDatFile() {
        const path = require('path');
        const fs = require('fs');

        // Search paths for the decrypted DAT file
        const searchPaths = [
            path.join(__dirname, '..', 'data', '860', 'Tibia_decrypted.dat'),
            path.join(__dirname, '..', 'data', '860', 'Tibia.dat'),
            path.join(__dirname, '..', '..', 'data', 'Tibia_decrypted.dat'),
            path.join(__dirname, '..', '..', 'data', 'Tibia.dat'),
        ];

        for (const datPath of searchPaths) {
            if (fs.existsSync(datPath)) {
                try {
                    // Check if file is encrypted (starts with "ENC")
                    const header = Buffer.alloc(4);
                    const fd = fs.openSync(datPath, 'r');
                    fs.readSync(fd, header, 0, 4, 0);
                    fs.closeSync(fd);

                    if (header.toString('ascii', 0, 3) === 'ENC') {
                        this.logger.debug(`Skipping encrypted DAT: ${datPath}`);
                        continue;
                    }

                    const result = this.datManager.loadFromDat(datPath);
                    this.logger.info(`DAT loaded: ${result.itemCount} items (${this.datManager.itemsWithExtra.size} with extra byte)`);
                    return;
                } catch (e) {
                    this.logger.warn(`Failed to load DAT from ${datPath}: ${e.message}`);
                }
            }
        }

        this.logger.warn('No Tibia.dat file found — map parsing will have limited accuracy');
    }

    // ============================================================
    // Packet dispatch
    // ============================================================

    /**
     * Handle incoming packet
     * @private
     */
    _onPacket(msg) {
        try {
            while (msg.hasMore()) {
                const opcode = msg.readU8();
                try {
                    this._dispatch(opcode, msg);
                } catch (dispatchErr) {
                    this.logger.error(`Error dispatching opcode 0x${opcode.toString(16).padStart(2, '0')}: ${dispatchErr.message}`);
                    this.logger.debug(dispatchErr.stack);
                    this.emit('parseError', { opcode, error: dispatchErr });
                    // Stop processing this packet to avoid desync
                    return;
                }
            }
        } catch (err) {
            this.logger.error(`Error reading packet: ${err.message}`);
            this.logger.debug(err.stack);
            this.emit('parseError', { opcode: null, error: err });
        }
    }

    /**
     * Dispatch a single opcode to the appropriate parser
     * @private
     */
    _dispatch(opcode, msg) {
        switch (opcode) {
            // === Connection ===
            case ServerOpcodes.Challenge: // 0x1F
                this._handleChallenge(msg);
                break;

            case ServerOpcodes.SelfAppear: // 0x0A
                this._handleSelfAppear(msg);
                break;

            case ServerOpcodes.GMActions: // 0x0B
            {
                const data = this.parser.parseGMActions(msg);
                this.emit('gmActions', data);
                break;
            }

            case ServerOpcodes.ErrorMessage: // 0x14
            {
                const data = this.parser.parseErrorMessage(msg);
                this.logger.error('Server error:', data.message);
                this.emit('error', new Error(data.message));
                this.emit('loginError', data);
                break;
            }

            case ServerOpcodes.FYIMessage: // 0x15
            {
                const data = this.parser.parseFYIMessage(msg);
                this.logger.info('FYI:', data.message);
                this.emit('fyiMessage', data);
                break;
            }

            case ServerOpcodes.WaitingList: // 0x16
            {
                const data = this.parser.parseWaitingList(msg);
                this.logger.info('Waiting list:', data.message);
                this.emit('waitingList', data);
                break;
            }

            case ServerOpcodes.Ping: // 0x1E
                this.sender.sendPing();
                this.emit('ping');
                break;

            case ServerOpcodes.Death: // 0x28
            {
                this.parser.parseDeath();
                this.logger.info('Player died');
                this.emit('death');
                break;
            }

            // === Map ===
            case ServerOpcodes.FullMap: // 0x64
            {
                const data = this.parser.parseFullMap(msg);
                this.player.position = Position.from(this.playerPosition);
                this.emit('mapDescription', data);
                break;
            }

            case ServerOpcodes.MapTopRow: // 0x65
            {
                const data = this.parser.parseMapTopRow(msg);
                this.player.position = Position.from(this.playerPosition);
                this.emit('mapTopRow', data);
                break;
            }

            case ServerOpcodes.MapRightColumn: // 0x66
            {
                const data = this.parser.parseMapRightColumn(msg);
                this.player.position = Position.from(this.playerPosition);
                this.emit('mapRightColumn', data);
                break;
            }

            case ServerOpcodes.MapBottomRow: // 0x67
            {
                const data = this.parser.parseMapBottomRow(msg);
                this.player.position = Position.from(this.playerPosition);
                this.emit('mapBottomRow', data);
                break;
            }

            case ServerOpcodes.MapLeftColumn: // 0x68
            {
                const data = this.parser.parseMapLeftColumn(msg);
                this.player.position = Position.from(this.playerPosition);
                this.emit('mapLeftColumn', data);
                break;
            }

            case ServerOpcodes.UpdateTile: // 0x69
            {
                const data = this.parser.parseUpdateTile(msg);
                this.emit('updateTile', data);
                break;
            }

            case ServerOpcodes.AddThingToTile: // 0x6A
            {
                const data = this.parser.parseAddThingToTile(msg);
                this.emit('addThing', data);
                break;
            }

            case ServerOpcodes.UpdateThingOnTile: // 0x6B
            {
                const data = this.parser.parseUpdateThingOnTile(msg);
                this.emit('updateThing', data);
                break;
            }

            case ServerOpcodes.RemoveThingFromTile: // 0x6C
            {
                const data = this.parser.parseRemoveThingFromTile(msg);
                this.emit('removeThing', data);
                break;
            }

            case ServerOpcodes.MoveCreature: // 0x6D
            {
                const data = this.parser.parseMoveCreature(msg);
                this._handleMoveCreature(data);
                this.emit('moveCreature', data);
                break;
            }

            // === Containers ===
            case ServerOpcodes.OpenContainer: // 0x6E
            {
                const data = this.parser.parseOpenContainer(msg);
                this._handleOpenContainer(data);
                this.emit('openContainer', data);
                break;
            }

            case ServerOpcodes.CloseContainer: // 0x6F
            {
                const data = this.parser.parseCloseContainer(msg);
                this.containers.delete(data.containerId);
                this.emit('closeContainer', data);
                break;
            }

            case ServerOpcodes.AddContainerItem: // 0x70
            {
                const data = this.parser.parseAddContainerItem(msg);
                this._handleAddContainerItem(data);
                this.emit('addContainerItem', data);
                break;
            }

            case ServerOpcodes.UpdateContainerItem: // 0x71
            {
                const data = this.parser.parseUpdateContainerItem(msg);
                this._handleUpdateContainerItem(data);
                this.emit('updateContainerItem', data);
                break;
            }

            case ServerOpcodes.RemoveContainerItem: // 0x72
            {
                const data = this.parser.parseRemoveContainerItem(msg);
                this._handleRemoveContainerItem(data);
                this.emit('removeContainerItem', data);
                break;
            }

            // === Inventory ===
            case ServerOpcodes.SetInventory: // 0x78
            {
                const data = this.parser.parseSetInventory(msg);
                this.player.inventory.set(data.slot, data.item);
                this.emit('setInventory', data);
                break;
            }

            case ServerOpcodes.RemoveInventory: // 0x79
            {
                const data = this.parser.parseRemoveInventory(msg);
                this.player.inventory.delete(data.slot);
                this.emit('removeInventory', data);
                break;
            }

            // === NPC Trade ===
            case ServerOpcodes.OpenShop: // 0x7A
            {
                const data = this.parser.parseOpenShop(msg);
                this.emit('openShop', data);
                break;
            }

            case ServerOpcodes.ShopGoods: // 0x7B
            {
                const data = this.parser.parseShopGoods(msg);
                this.emit('shopGoods', data);
                break;
            }

            case ServerOpcodes.CloseShop: // 0x7C
            {
                this.parser.parseCloseShop();
                this.emit('closeShop');
                break;
            }

            // === Player Trade ===
            case ServerOpcodes.OwnTradeOffer: // 0x7D
            {
                const data = this.parser.parseOwnTradeOffer(msg);
                this.emit('ownTradeOffer', data);
                break;
            }

            case ServerOpcodes.CounterTradeOffer: // 0x7E
            {
                const data = this.parser.parseCounterTradeOffer(msg);
                this.emit('counterTradeOffer', data);
                break;
            }

            case ServerOpcodes.CloseTrade: // 0x7F
            {
                this.parser.parseCloseTrade();
                this.emit('closeTrade');
                break;
            }

            // === Environment ===
            case ServerOpcodes.WorldLight: // 0x82
            {
                const data = this.parser.parseWorldLight(msg);
                this.worldLight = data;
                this.emit('worldLight', data);
                break;
            }

            case ServerOpcodes.MagicEffect: // 0x83
            {
                const data = this.parser.parseMagicEffect(msg);
                this.emit('magicEffect', data);
                break;
            }

            case ServerOpcodes.AnimatedText: // 0x84
            {
                const data = this.parser.parseAnimatedText(msg);
                this.emit('animatedText', data);
                break;
            }

            case ServerOpcodes.DistanceEffect: // 0x85
            {
                const data = this.parser.parseDistanceEffect(msg);
                this.emit('distanceEffect', data);
                break;
            }

            case ServerOpcodes.CreatureSquare: // 0x86
            {
                const data = this.parser.parseCreatureSquare(msg);
                this.emit('creatureSquare', data);
                break;
            }

            // === Creature Updates ===
            case ServerOpcodes.CreatureHealth: // 0x8C
            {
                const data = this.parser.parseCreatureHealth(msg);
                this._updateCreature(data.creatureId, { healthPercent: data.healthPercent });
                this.emit('creatureHealth', data);
                break;
            }

            case ServerOpcodes.CreatureLight: // 0x8D
            {
                const data = this.parser.parseCreatureLight(msg);
                this._updateCreature(data.creatureId, { lightLevel: data.lightLevel, lightColor: data.lightColor });
                this.emit('creatureLight', data);
                break;
            }

            case ServerOpcodes.CreatureOutfit: // 0x8E
            {
                const data = this.parser.parseCreatureOutfit(msg);
                this._updateCreature(data.creatureId, { outfit: data.outfit });
                this.emit('creatureOutfit', data);
                break;
            }

            case ServerOpcodes.CreatureSpeed: // 0x8F
            {
                const data = this.parser.parseCreatureSpeed(msg);
                this._updateCreature(data.creatureId, { speed: data.speed });
                this.emit('creatureSpeed', data);
                break;
            }

            case ServerOpcodes.CreatureSkull: // 0x90
            {
                const data = this.parser.parseCreatureSkull(msg);
                this._updateCreature(data.creatureId, { skull: data.skull });
                this.emit('creatureSkull', data);
                break;
            }

            case ServerOpcodes.CreatureShield: // 0x91
            {
                const data = this.parser.parseCreatureShield(msg);
                this._updateCreature(data.creatureId, { shield: data.shield });
                this.emit('creatureShield', data);
                break;
            }

            case ServerOpcodes.CreatureWalkthrough: // 0x92
            {
                const data = this.parser.parseCreatureWalkthrough(msg);
                this._updateCreature(data.creatureId, { impassable: data.impassable });
                this.emit('creatureWalkthrough', data);
                break;
            }

            // === Text Windows ===
            case ServerOpcodes.EditTextWindow: // 0x96
            {
                const data = this.parser.parseEditTextWindow(msg);
                this.emit('editTextWindow', data);
                break;
            }

            case ServerOpcodes.EditHouseWindow: // 0x97
            {
                const data = this.parser.parseEditHouseWindow(msg);
                this.emit('editHouseWindow', data);
                break;
            }

            // === Player Data ===
            case ServerOpcodes.PlayerStats: // 0xA0
            {
                const data = this.parser.parsePlayerStats(msg);
                this._handlePlayerStats(data);
                this.emit('playerStats', data);
                break;
            }

            case ServerOpcodes.PlayerSkills: // 0xA1
            {
                const data = this.parser.parsePlayerSkills(msg);
                this.player.updateSkills(data.skills);
                this.emit('playerSkills', data);
                break;
            }

            case ServerOpcodes.PlayerIcons: // 0xA2
            {
                const data = this.parser.parsePlayerIcons(msg);
                this.player.icons = data.icons;
                this.emit('playerIcons', data);
                break;
            }

            case ServerOpcodes.CancelTarget: // 0xA3
            {
                const data = this.parser.parseCancelTarget(msg);
                this.player.attackingCreatureId = 0;
                this.player.followingCreatureId = 0;
                this.emit('cancelTarget', data);
                break;
            }

            // === Chat ===
            case ServerOpcodes.CreatureSpeak: // 0xAA
            {
                const data = this.parser.parseCreatureSpeak(msg);
                this.emit('creatureSpeak', data);
                break;
            }

            case ServerOpcodes.ChannelList: // 0xAB
            {
                const data = this.parser.parseChannelList(msg);
                this.emit('channelList', data);
                break;
            }

            case ServerOpcodes.OpenChannel: // 0xAC
            {
                const data = this.parser.parseOpenChannel(msg);
                this.channels.set(data.channelId, data);
                this.emit('openChannel', data);
                break;
            }

            case ServerOpcodes.OpenPrivateChannel: // 0xAD
            {
                const data = this.parser.parseOpenPrivateChannel(msg);
                this.emit('openPrivateChannel', data);
                break;
            }

            case ServerOpcodes.RuleViolationChannel: // 0xAE
            {
                const data = this.parser.parseRuleViolationChannel(msg);
                this.emit('ruleViolationChannel', data);
                break;
            }

            case ServerOpcodes.RemoveRuleViolation: // 0xAF
            {
                const data = this.parser.parseRemoveRuleViolation(msg);
                this.emit('removeRuleViolation', data);
                break;
            }

            case ServerOpcodes.CancelRuleViolation: // 0xB0
            {
                const data = this.parser.parseCancelRuleViolation(msg);
                this.emit('cancelRuleViolation', data);
                break;
            }

            case ServerOpcodes.LockRuleViolation: // 0xB1
            {
                this.parser.parseLockRuleViolation();
                this.emit('lockRuleViolation');
                break;
            }

            case ServerOpcodes.CreateOwnChannel: // 0xB2
            {
                const data = this.parser.parseCreateOwnChannel(msg);
                this.channels.set(data.channelId, data);
                this.emit('createOwnChannel', data);
                break;
            }

            case ServerOpcodes.CloseChannel: // 0xB3
            {
                const data = this.parser.parseCloseChannel(msg);
                this.channels.delete(data.channelId);
                this.emit('closeChannel', data);
                break;
            }

            case ServerOpcodes.TextMessage: // 0xB4
            {
                const data = this.parser.parseTextMessage(msg);
                this.logger.info(`[MSG:${data.type}] ${data.message}`);
                this.emit('textMessage', data);
                break;
            }

            case ServerOpcodes.CancelWalk: // 0xB5
            {
                const data = this.parser.parseCancelWalk(msg);
                this.emit('cancelWalk', data);
                break;
            }

            // === Floor changes ===
            case ServerOpcodes.FloorChangeUp: // 0xBE
            {
                const data = this.parser.parseFloorChangeUp(msg);
                this.player.position = Position.from(this.playerPosition);
                this.emit('floorChangeUp', data);
                break;
            }

            case ServerOpcodes.FloorChangeDown: // 0xBF
            {
                const data = this.parser.parseFloorChangeDown(msg);
                this.player.position = Position.from(this.playerPosition);
                this.emit('floorChangeDown', data);
                break;
            }

            // === Outfit ===
            case ServerOpcodes.OutfitWindow: // 0xC8
            {
                const data = this.parser.parseOutfitWindow(msg);
                this.emit('outfitWindow', data);
                break;
            }

            // === VIP ===
            case ServerOpcodes.VipEntry: // 0xD2
            {
                const data = this.parser.parseVipEntry(msg);
                this.player.vipList.set(data.id, { name: data.name, online: data.online });
                this.emit('vipEntry', data);
                break;
            }

            case ServerOpcodes.VipLogin: // 0xD3
            {
                const data = this.parser.parseVipLogin(msg);
                const vip = this.player.vipList.get(data.id);
                if (vip) vip.online = true;
                this.emit('vipLogin', data);
                break;
            }

            case ServerOpcodes.VipLogout: // 0xD4
            {
                const data = this.parser.parseVipLogout(msg);
                const vip = this.player.vipList.get(data.id);
                if (vip) vip.online = false;
                this.emit('vipLogout', data);
                break;
            }

            // === Tutorial ===
            case ServerOpcodes.TutorialHint: // 0xDC
            {
                const data = this.parser.parseTutorialHint(msg);
                this.emit('tutorialHint', data);
                break;
            }

            case ServerOpcodes.MapMarker: // 0xDD
            {
                const data = this.parser.parseMapMarker(msg);
                this.emit('mapMarker', data);
                break;
            }

            // === Quests ===
            case ServerOpcodes.QuestList: // 0xF0
            {
                const data = this.parser.parseQuestList(msg);
                this.emit('questList', data);
                break;
            }

            case ServerOpcodes.QuestInfo: // 0xF1
            {
                const data = this.parser.parseQuestInfo(msg);
                this.emit('questInfo', data);
                break;
            }

            // === Extended ===
            case ServerOpcodes.ExtendedOpcode: // 0x32
            {
                const data = this.parser.parseExtendedOpcode(msg);
                this.emit('extendedOpcode', data);
                break;
            }

            default:
                this.logger.warn(`Unknown game opcode: 0x${opcode.toString(16).padStart(2, '0')}`);
                this.emit('unknownOpcode', { opcode, remaining: msg.remaining() });
                // Skip remaining bytes in this packet to avoid desyncing
                return;
        }
    }

    // ============================================================
    // Internal handlers
    // ============================================================

    /**
     * Handle challenge packet - send game login
     * @private
     */
    _handleChallenge(msg) {
        const challenge = this.parser.parseChallenge(msg);
        this._challenge = challenge;
        this.logger.info(`Received challenge: timestamp=${challenge.timestamp}, random=${challenge.random}`);

        // Build and send game login packet
        const loginMsg = this.sender.buildGameLogin(
            this._account,
            this._character,
            this._password,
            challenge
        );

        // Send as first message (no XTEA)
        this.connection.sendFirst(loginMsg);

        // Enable XTEA for subsequent communication
        const xteaKey = this.sender.getPendingXteaKey();
        if (xteaKey) {
            this.connection.enableXtea(xteaKey);
        }

        this.logger.info('Game login packet sent');
    }

    /**
     * Handle self appear (login successful)
     * @private
     */
    _handleSelfAppear(msg) {
        const data = this.parser.parseSelfAppear(msg);

        this.player.id = data.playerId;
        this.player.canReportBugs = data.canReportBugs;
        this.isLoggedIn = true;

        // Register self in known creatures
        this.knownCreatures.set(data.playerId, this.player);

        // Start ping keepalive
        this._startPing();

        this.logger.info(`Logged in! Player ID: ${data.playerId}`);
        this.emit('login', data);
    }

    /**
     * Handle player stats update
     * @private
     */
    _handlePlayerStats(data) {
        this.player.health = data.health;
        this.player.maxHealth = data.maxHealth;
        this.player.freeCapacity = data.freeCapacity;
        this.player.experience = data.experience;
        this.player.level = data.level;
        this.player.levelPercent = data.levelPercent;
        this.player.mana = data.mana;
        this.player.maxMana = data.maxMana;
        this.player.magicLevel = data.magicLevel;
        this.player.magicLevelPercent = data.magicLevelPercent;
        this.player.soul = data.soul;
        this.player.stamina = data.stamina;
    }

    /**
     * Handle creature movement
     * @private
     */
    _handleMoveCreature(data) {
        const fromTile = this.map.getTile(data.fromPos);
        if (fromTile) {
            const thing = fromTile.getThing(data.fromStackPos);
            if (thing) {
                fromTile.removeThing(data.fromStackPos);
                const toTile = this.map.getOrCreateTile(data.toPos);
                toTile.addThing(thing, 0);

                // Update creature position
                if (thing.position) {
                    thing.position = Position.from(data.toPos);
                }
            }
        }
    }

    /**
     * Handle open container
     * @private
     */
    _handleOpenContainer(data) {
        const container = new Container(data.containerId);
        container.itemId = data.itemId;
        container.name = data.name;
        container.capacity = data.capacity;
        container.hasParent = data.hasParent;
        container.items = data.items;
        this.containers.set(data.containerId, container);
    }

    /**
     * Handle add container item
     * @private
     */
    _handleAddContainerItem(data) {
        const container = this.containers.get(data.containerId);
        if (container) {
            container.addItem(data.item);
        }
    }

    /**
     * Handle update container item
     * @private
     */
    _handleUpdateContainerItem(data) {
        const container = this.containers.get(data.containerId);
        if (container) {
            container.updateItem(data.slot, data.item);
        }
    }

    /**
     * Handle remove container item
     * @private
     */
    _handleRemoveContainerItem(data) {
        const container = this.containers.get(data.containerId);
        if (container) {
            container.removeItem(data.slot);
        }
    }

    /**
     * Update a known creature's properties
     * @private
     */
    _updateCreature(creatureId, data) {
        const creature = this.knownCreatures.get(creatureId);
        if (creature) {
            creature.update(data);
        }
    }

    /**
     * Handle disconnection
     * @private
     */
    _onDisconnect() {
        this._stopPing();
        this.isConnected = false;
        this.isLoggedIn = false;
        this.logger.info('Disconnected from game server');
        this.emit('disconnected');
    }

    /**
     * Start ping keepalive timer
     * @private
     */
    _startPing() {
        this._stopPing();
        this._pingInterval = setInterval(() => {
            if (this.isConnected) {
                try {
                    this.sender.sendPing();
                } catch (e) {
                    this.logger.error('Ping failed:', e.message);
                }
            }
        }, 5000); // Every 5 seconds
    }

    /**
     * Stop ping timer
     * @private
     */
    _stopPing() {
        if (this._pingInterval) {
            clearInterval(this._pingInterval);
            this._pingInterval = null;
        }
    }

    // ============================================================
    // Public convenience methods (delegated to GameSend)
    // ============================================================

    /** Walk north */
    walkNorth() { this.sender.sendWalkNorth(); }
    /** Walk east */
    walkEast() { this.sender.sendWalkEast(); }
    /** Walk south */
    walkSouth() { this.sender.sendWalkSouth(); }
    /** Walk west */
    walkWest() { this.sender.sendWalkWest(); }
    /** Walk northeast */
    walkNorthEast() { this.sender.sendWalkNorthEast(); }
    /** Walk southeast */
    walkSouthEast() { this.sender.sendWalkSouthEast(); }
    /** Walk southwest */
    walkSouthWest() { this.sender.sendWalkSouthWest(); }
    /** Walk northwest */
    walkNorthWest() { this.sender.sendWalkNorthWest(); }
    /** Stop walking */
    stopWalk() { this.sender.sendStopAutoWalk(); }
    /** Turn north */
    turnNorth() { this.sender.sendTurnNorth(); }
    /** Turn east */
    turnEast() { this.sender.sendTurnEast(); }
    /** Turn south */
    turnSouth() { this.sender.sendTurnSouth(); }
    /** Turn west */
    turnWest() { this.sender.sendTurnWest(); }
    /** Say something */
    say(message) { this.sender.sendSay(1, message); }
    /** Whisper */
    whisper(message) { this.sender.sendSay(2, message); }
    /** Yell */
    yell(message) { this.sender.sendSay(3, message); }
    /** Send private message */
    privateMessage(name, message) { this.sender.sendSay(6, message, name); }
    /** Send channel message */
    channelMessage(channelId, message) { this.sender.sendSay(7, message, null, channelId); }
    /** Attack creature */
    attack(creatureId) { this.sender.sendAttack(creatureId); }
    /** Follow creature */
    follow(creatureId) { this.sender.sendFollow(creatureId); }
    /** Cancel attack/follow */
    cancelAttack() { this.sender.sendCancelAttackAndFollow(); }
    /** Logout */
    logout() { this.sender.sendLogout(); }

    /**
     * Use item at position
     * @param {object} pos - {x, y, z}
     * @param {number} spriteId - Item sprite ID
     * @param {number} stackPos - Stack position
     */
    useItem(pos, spriteId, stackPos) { this.sender.sendUseItem(pos, spriteId, stackPos); }

    /**
     * Use item on target
     */
    useItemOn(fromPos, fromId, fromStack, toPos, toId, toStack) {
        this.sender.sendUseItemEx(fromPos, fromId, fromStack, toPos, toId, toStack);
    }

    /**
     * Move item
     */
    moveItem(from, spriteId, fromStack, to, count) {
        this.sender.sendMoveItem(from, spriteId, fromStack, to, count);
    }

    /**
     * Look at position
     */
    look(pos, spriteId, stackPos) { this.sender.sendLook(pos, spriteId, stackPos); }

    /**
     * Change fight mode
     * @param {number} fight - 1=attack, 2=balanced, 3=defense
     * @param {number} chase - 0=stand, 1=chase
     * @param {number} secure - 0=off, 1=on
     */
    setFightModes(fight, chase, secure) {
        this.player.fightMode = fight;
        this.player.chaseMode = chase;
        this.player.secureMode = secure;
        this.sender.sendChangeFightModes(fight, chase, secure);
    }
}

module.exports = ProtocolGame;
