'use strict';

/**
 * Miner - Sistema automático de mineração
 * 
 * Verifica se existe uma pedra (stone) adjacente ao personagem (max 1 tile).
 * Se encontrar, pausa o CaveBot, usa a pick na pedra em loop com delay,
 * e quando a pedra desaparece ou o player se afasta, retoma o CaveBot.
 * 
 * Configurável:
 *   - stoneId: ID do sprite da pedra no mapa
 *   - pickId: ID do sprite da pick no inventário/container
 *   - mineDelay: delay (ms) entre cada uso da pick
 *   - enabled: ativar/desativar
 * 
 * Usage:
 *   const miner = new Miner(session, {
 *       stoneId: 3608,
 *       pickId: 3456,
 *       mineDelay: 1000,
 *       enabled: true,
 *   });
 *   miner.start();
 */

const EventEmitter = require('events');
const { Logger } = require('../utils');

class Miner extends EventEmitter {
    /**
     * @param {import('../game/GameSession')} session - Game session
     * @param {object} config - Miner configuration
     * @param {number} config.stoneId - Sprite ID da pedra no mapa
     * @param {number} config.pickId - Sprite ID da pick
     * @param {number} [config.mineDelay=1000] - Delay entre cada uso da pick (ms)
     * @param {boolean} [config.enabled=false] - Iniciar ativado
     * @param {number} [config.scanInterval=500] - Intervalo para escanear pedras (ms)
     */
    constructor(session, config = {}) {
        super();
        this.session = session;
        this.logger = new Logger(`Miner[${session.label}]`);
        this.logger.setLevel(session.serverConfig?.logLevel || 'info');

        // Config
        this.stoneId = config.stoneId || 0;
        this.pickId = config.pickId || 0;
        this.mineDelay = config.mineDelay ?? 1000;
        this.scanInterval = config.scanInterval ?? 500;

        // State
        this._enabled = false;
        this._mining = false;
        this._scanTimer = null;
        this._mineTimer = null;
        this._paused = false;          // Whether WE paused the cavebot
        this._currentStone = null;     // { pos: {x,y,z}, spriteId }
        this._openingBackpack = false;  // Whether we're waiting for backpack to open
        this._tileLogged = false;      // Whether we logged tile contents already
        this._pickLogged = false;      // Whether we logged pick location already
        this._mineLogged = false;      // Whether we logged mining action already

        // Bind listeners
        this._onMineTextMessage = this._onMineTextMessage.bind(this);
        this._onMagicEffect = this._onMagicEffect.bind(this);
        this._onDisconnect = this._onDisconnect.bind(this);
    }

    /**
     * Start the miner scanner
     */
    start() {
        if (this._enabled) return;

        if (!this.stoneId || !this.pickId) {
            this.logger.warn('Miner requer stoneId e pickId configurados');
            return;
        }

        this._enabled = true;
        this.logger.info(`Miner iniciado (stoneId=${this.stoneId}, pickId=${this.pickId}, delay=${this.mineDelay}ms)`);
        this.emit('started');

        // Listen for disconnection to auto-stop
        const conn = this.session.getConnection && this.session.getConnection();
        if (conn) conn.on('disconnected', this._onDisconnect);
        if (this.session.game) this.session.game.on('disconnected', this._onDisconnect);

        // Start periodic scan
        this._startScan();
    }

    /**
     * Stop the miner completely
     */
    stop() {
        this._enabled = false;

        // Remove disconnect listener
        const conn = this.session.getConnection && this.session.getConnection();
        if (conn) conn.removeListener('disconnected', this._onDisconnect);
        if (this.session.game) this.session.game.removeListener('disconnected', this._onDisconnect);

        this._stopMining();
        this._stopScan();
        this.logger.info('Miner parado');
        this.emit('stopped');
    }

    /**
     * Check if currently mining
     * @returns {boolean}
     */
    get isMining() {
        return this._mining;
    }

    /**
     * Get current status
     * @returns {object}
     */
    getStatus() {
        return {
            enabled: this._enabled,
            mining: this._mining,
            stoneId: this.stoneId,
            pickId: this.pickId,
            currentStone: this._currentStone,
        };
    }

    // ──────── Internal: Scanning ────────

    /**
     * Start the periodic scan for nearby stones
     * @private
     */
    _startScan() {
        this._stopScan();
        this._scanTimer = setInterval(() => {
            this._scanForStones();
        }, this.scanInterval);

        // Also do an immediate scan
        this._scanForStones();
    }

    /**
     * Stop scanning
     * @private
     */
    _stopScan() {
        if (this._scanTimer) {
            clearInterval(this._scanTimer);
            this._scanTimer = null;
        }
    }

    /**
     * Scan tiles adjacent to the player for a stone
     * @private
     */
    _scanForStones() {
        if (!this._enabled || !this.session.isRunning) return;

        const player = this.session.getPlayer();
        const map = this.session.getMap();
        if (!player?.position || !map) return;

        const pos = player.position;

        // If currently mining, check if the stone still exists
        if (this._mining && this._currentStone) {
            const stoneStillExists = this._checkStoneAt(map, this._currentStone.pos);
            const playerDist = Math.max(
                Math.abs(pos.x - this._currentStone.pos.x),
                Math.abs(pos.y - this._currentStone.pos.y)
            );
            const sameFloor = pos.z === this._currentStone.pos.z;

            if (!stoneStillExists || playerDist > 1 || !sameFloor) {
                // Stone gone or player moved away — stop mining and resume waypoints
                const reason = !stoneStillExists ? 'pedra removida' :
                    !sameFloor ? 'andar diferente' : 'player se afastou';
                this.logger.info(`Parando mineração: ${reason}`);
                this._stopMining();
                this._resumeCaveBot();
                return;
            }

            // Still mining, stone still there — ensure CaveBot stays paused
            // (handles case where CaveBot started after mining began)
            this._pauseCaveBot();
            return;
        }

        // Not mining — scan for nearby stones
        const stone = this._findNearbyStone(map, pos);
        if (stone) {
            this.logger.info(`Pedra encontrada em (${stone.pos.x},${stone.pos.y},${stone.pos.z})`);
            this._currentStone = stone;
            this._pauseCaveBot();
            this._startMining();
        }
    }

    /**
     * Find a stone within 1 tile of the player position
     * @private
     * @param {import('../core/Map')} map
     * @param {{x:number,y:number,z:number}} playerPos
     * @returns {{pos:{x:number,y:number,z:number}, stackPos:number, spriteId:number}|null}
     */
    _findNearbyStone(map, playerPos) {
        // Check all 8 adjacent tiles
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                if (dx === 0 && dy === 0) continue; // Skip player's own tile
                const checkPos = {
                    x: playerPos.x + dx,
                    y: playerPos.y + dy,
                    z: playerPos.z,
                };

                const tile = map.getTile(checkPos);
                if (!tile) continue;

                for (let i = 0; i < tile.things.length; i++) {
                    const thing = tile.things[i];
                    if (thing && thing.id === this.stoneId) {
                        return {
                            pos: { x: checkPos.x, y: checkPos.y, z: checkPos.z },
                            spriteId: thing.id,
                        };
                    }
                }
            }
        }

        return null;
    }

    /**
     * Check if a stone still exists at a specific position
     * @private
     * @param {import('../core/Map')} map
     * @param {{x:number,y:number,z:number}} stonePos
     * @returns {boolean}
     */
    _checkStoneAt(map, stonePos) {
        const tile = map.getTile(stonePos);
        if (!tile) return false;

        for (const thing of tile.things) {
            if (thing && thing.id === this.stoneId) {
                return true;
            }
        }
        return false;
    }

    // ──────── Internal: Mining ────────

    /**
     * Start the mining loop (use pick on stone repeatedly)
     * @private
     */
    _startMining() {
        if (this._mining) return;
        this._mining = true;
        this._tileLogged = false;
        this.logger.info('Iniciando mineração...');
        this.emit('miningStarted', { stone: this._currentStone });

        // Ensure pick is accessible (may need to open backpack first)
        this._ensurePickAndMine();
    }

    /**
     * Stop the mining loop
     * @private
     */
    _stopMining() {
        this._mining = false;
        this._currentStone = null;
        this._tileLogged = false;
        this._pickLogged = false;
        this._mineLogged = false;

        if (this._mineTimer) {
            clearTimeout(this._mineTimer);
            this._mineTimer = null;
        }

        this._detachMineListeners();
        this.emit('miningStopped');
    }

    /**
     * Ensure the pick is accessible, opening backpack if needed, then start mining.
     * @private
     * @param {number} [attempt=0]
     */
    _ensurePickAndMine(attempt = 0) {
        if (!this._mining || !this._enabled || !this._currentStone) return;
        if (!this.session.isRunning) {
            this.logger.warn('Sessão desconectada, cancelando mineração');
            this._stopMining();
            return;
        }

        const pickInfo = this._findPick();
        if (pickInfo) {
            // Pick found, start mining loop
            this._usePick();
            return;
        }

        // Pick not found — try opening the backpack
        if (attempt < 3) {
            const containers = this.session.getContainers();
            const hasOpenContainers = containers && containers.size > 0;

            if (!hasOpenContainers) {
                console.log('[Inventário] Pick não encontrada, abrindo backpack...');
                this._openBackpack(() => {
                    // After backpack opens, try again
                    this._ensurePickAndMine(attempt + 1);
                });
                return;
            }

            // Containers are open but pick still not found — maybe inside a sub-container
            // Try opening inner containers that might contain the pick
            if (containers) {
                for (const [cid, container] of containers) {
                    for (let i = 0; i < container.items.length; i++) {
                        const item = container.items[i];
                        // Check if this item could be a container (backpack/bag) by trying to open it
                        // We skip if it's the pick itself or items we already checked
                        if (item && item.id !== this.pickId && this._couldBeContainer(item)) {
                            console.log(`[Inventário] Abrindo sub-container (id=${item.id}) no slot ${i}...`);
                            this._openContainerItem(cid, i, item.id, () => {
                                this._ensurePickAndMine(attempt + 1);
                            });
                            return;
                        }
                    }
                }
            }

            // No more containers to open, give up
            this._logAllItems();
            this.logger.warn(`Pick (id=${this.pickId}) não encontrada após abrir containers`);
            this._stopMining();
            this._resumeCaveBot();
        } else {
            this._logAllItems();
            this.logger.warn(`Pick (id=${this.pickId}) não encontrada após ${attempt} tentativas`);
            this._stopMining();
            this._resumeCaveBot();
        }
    }

    /**
     * Open the backpack (inventory slot 3) and wait for container to appear.
     * @private
     * @param {function} callback - Called when container opens or timeout
     */
    _openBackpack(callback) {
        if (this._openingBackpack) return;
        this._openingBackpack = true;

        const sender = this.session.getSender();
        const player = this.session.getPlayer();
        if (!sender || !player) {
            this._openingBackpack = false;
            callback();
            return;
        }

        // Get backpack item from slot 3
        const backpackItem = player.inventory.get(3); // SLOT_BACKPACK = 3
        if (!backpackItem) {
            this.logger.warn('Nenhuma backpack equipada no slot 3');
            this._openingBackpack = false;
            callback();
            return;
        }

        // Listen for openContainer event
        const game = this.session.game;
        const timeout = setTimeout(() => {
            game.removeListener('openContainer', onOpen);
            this._openingBackpack = false;
            this.logger.debug('Timeout aguardando abertura da backpack');
            callback();
        }, 3000);

        const onOpen = (data) => {
            clearTimeout(timeout);
            game.removeListener('openContainer', onOpen);
            this._openingBackpack = false;
            console.log(`[Inventário] Backpack aberta!`);
            // Log contents so user can verify pick ID
            setTimeout(() => {
                const containers = this.session.getContainers();
                if (containers) {
                    for (const [cid, container] of containers) {
                        const items = container.items.map((it, i) => `[${i}] id=${it.id} count=${it.count || 1}`).join(', ');
                        console.log(`[Inventário] Container #${cid} "${container.name}": ${items}`);
                    }
                }
                callback();
            }, 200);
        };

        game.on('openContainer', onOpen);

        // Check connection before sending
        if (!this.session.isRunning) {
            clearTimeout(timeout);
            game.removeListener('openContainer', onOpen);
            this._openingBackpack = false;
            this.logger.warn('Sessão desconectada, cancelando abertura da backpack');
            this._stopMining();
            return;
        }

        // Send UseItem on backpack slot: pos={0xFFFF, SLOT_BACKPACK, 0}
        this.logger.debug(`Enviando UseItem na backpack (id=${backpackItem.id}, slot=3)`);
        sender.sendUseItem(
            { x: 0xFFFF, y: 3, z: 0 }, // inventory slot 3 = backpack
            backpackItem.id,             // sprite ID
            0,                           // stackPos
            0                            // index
        );
    }

    /**
     * Open a container item inside an already-open container.
     * @private
     * @param {number} containerId - Parent container ID
     * @param {number} slot - Slot within the parent container
     * @param {number} itemId - Sprite ID of the item to open
     * @param {function} callback - Called when sub-container opens or timeout
     */
    _openContainerItem(containerId, slot, itemId, callback) {
        const sender = this.session.getSender();
        const game = this.session.game;
        if (!sender || !game) {
            callback();
            return;
        }

        const timeout = setTimeout(() => {
            game.removeListener('openContainer', onOpen);
            callback();
        }, 3000);

        const onOpen = () => {
            clearTimeout(timeout);
            game.removeListener('openContainer', onOpen);
            setTimeout(() => callback(), 200);
        };

        game.on('openContainer', onOpen);

        // Check connection before sending
        if (!this.session.isRunning) {
            clearTimeout(timeout);
            game.removeListener('openContainer', onOpen);
            this.logger.warn('Sessão desconectada, cancelando abertura de sub-container');
            this._stopMining();
            return;
        }

        sender.sendUseItem(
            { x: 0xFFFF, y: 64 + containerId, z: slot },
            itemId,
            slot,
            0
        );
    }

    /**
     * Simple heuristic: an item might be a container if its ID matches common
     * backpack/bag/chest item ranges. Since we don't have full DAT flags,
     * we check a range of known container IDs (Tibia 8.60).
     * @private
     * @param {object} item
     * @returns {boolean}
     */
    _couldBeContainer(item) {
        if (!item) return false;
        // Common container IDs in Tibia 8.60: bags, backpacks, chests etc.
        // Backpacks: ~1987-1998, 2000-2002, 2854, 5949, 7342, etc.
        // This is a rough check — the item count is usually 0 or not stackable
        const knownContainers = [
            1987, 1988, 1989, 1990, 1991, 1992, 1993, 1994, 1995, 1996, 1997, 1998,
            1999, 2000, 2001, 2002, 2003, 2854, 2855, 2856, 2857, 2858,
            5949, 5801, 7342, 7343, 9774, 9775,
        ];
        return knownContainers.includes(item.id);
    }

    /**
     * Use the pick on the current stone.
     * Gets the real stackPos of the stone from the tile's things array.
     * The server sends a magicEffect when the mining succeeds.
     * 
     * Packet format (matching original otclient):
     *   fromPos      = pick position (inventory or container)
     *   fromSpriteId = pick sprite ID
     *   fromStackPos = pick's stack position (slot in container, or 0 for inventory)
     *   toPos        = stone map position
     *   toSpriteId   = stone sprite ID
     *   toStackPos   = stone's stack position in the tile
     * @private
     */
    _usePick() {
        if (!this._mining || !this._enabled || !this._currentStone) return;
        if (!this.session.isRunning) {
            this.logger.warn('Sessão desconectada, cancelando mineração');
            this._stopMining();
            return;
        }

        const sender = this.session.getSender();
        if (!sender) {
            this.logger.warn('Sem sender disponível para usar pick');
            this._stopMining();
            this._resumeCaveBot();
            return;
        }

        // Find the pick in inventory or containers
        const pickInfo = this._findPick();
        if (!pickInfo) {
            this.logger.debug('Pick não encontrada durante loop, tentando reabrir containers...');
            this._ensurePickAndMine(0);
            return;
        }

        // Get the stone's real stackPos from the tile
        const map = this.session.getMap();
        if (!map) {
            this.logger.warn('Mapa não disponível');
            this._stopMining();
            this._resumeCaveBot();
            return;
        }

        const tile = map.getTile(this._currentStone.pos);
        if (!tile) {
            this.logger.info('Tile não encontrado, parando mineração');
            this._stopMining();
            this._resumeCaveBot();
            return;
        }

        // Log full tile contents once for debugging
        if (!this._tileLogged) {
            const tileInfo = tile.things.map((t, i) =>
                `  [stack=${i}] id=${t.id} count=${t.count || 1}${t.isGround ? ' (ground)' : ''}`
            ).join('\n');
            this.logger.info(`Tile (${this._currentStone.pos.x},${this._currentStone.pos.y},${this._currentStone.pos.z}) conteúdo:\n${tileInfo}`);
            this._tileLogged = true;
        }

        // Find the stone's actual stackPos in the tile
        let stoneStackPos = -1;
        for (let i = 0; i < tile.things.length; i++) {
            if (tile.things[i] && tile.things[i].id === this.stoneId) {
                stoneStackPos = i;
                break;
            }
        }

        if (stoneStackPos === -1) {
            this.logger.info('Pedra desapareceu do tile, parando mineração');
            this._stopMining();
            this._resumeCaveBot();
            return;
        }

        // Attach listeners for effect detection
        this._attachMineListeners();

        if (!this._mineLogged) {
            const pickLocation = pickInfo.pos.y >= 64
                ? `container #${pickInfo.pos.y - 64} slot [${pickInfo.stackPos}]`
                : `inventário slot ${pickInfo.pos.y}`;
            console.log(`[Mineração] Usando pick (id=${pickInfo.spriteId}) de ${pickLocation} na pedra (${this._currentStone.pos.x},${this._currentStone.pos.y},${this._currentStone.pos.z}) stackPos=${stoneStackPos}`);
            this._mineLogged = true;
        }

        try {
            // Original otclient sends: pos, itemId, item->getStackPos(), toPos, toId, toStackPos
            // pickInfo.stackPos = slot index within container (or 0 for inventory)
            sender.sendUseItemEx(
                pickInfo.pos,               // fromPos (inventory/container position)
                pickInfo.spriteId,          // fromSpriteId (pick sprite)
                pickInfo.stackPos,          // fromStackPos (pick's slot in container)
                this._currentStone.pos,     // toPos (stone map position)
                this.stoneId,               // toSpriteId (stone sprite)
                stoneStackPos               // toStackPos (stone's index in tile)
            );
        } catch (err) {
            this.logger.error(`Erro ao usar pick: ${err}`);
        }

        // Schedule next mining attempt after mineDelay
        this._mineTimer = setTimeout(() => {
            this._mineTimer = null;
            this._usePick();
        }, this.mineDelay);
    }

    /**
     * Attach textMessage + magicEffect listeners while mining.
     * @private
     */
    _attachMineListeners() {
        const game = this.session.game;
        if (!game) return;
        // Avoid double-attaching
        game.removeListener('textMessage', this._onMineTextMessage);
        game.removeListener('magicEffect', this._onMagicEffect);
        game.on('textMessage', this._onMineTextMessage);
        game.on('magicEffect', this._onMagicEffect);
    }

    /**
     * Handle disconnection — stop miner cleanly.
     * @private
     */
    _onDisconnect() {
        this.logger.warn('Conexão perdida, parando miner automaticamente');
        this.stop();
    }

    /**
     * Detach mining listeners.
     * @private
     */
    _detachMineListeners() {
        const game = this.session.game;
        if (!game) return;
        game.removeListener('textMessage', this._onMineTextMessage);
        game.removeListener('magicEffect', this._onMagicEffect);
    }

    /**
     * Handle magicEffect — detect effects at the stone position.
     * When the server sends an effect on the stone tile, mining succeeded.
     * @private
     */
    _onMagicEffect(data) {
        if (!this._mining || !this._currentStone) return;
        if (!data || !data.position) return;

        const stonePos = this._currentStone.pos;
        if (data.position.x === stonePos.x &&
            data.position.y === stonePos.y &&
            data.position.z === stonePos.z) {
            this.logger.info(`✔ Effect id=${data.effectId} recebido na pedra (${stonePos.x},${stonePos.y},${stonePos.z})! Mineração funcionando!`);
            this.emit('mineSuccess', { effectId: data.effectId, position: data.position });
        }
    }

    /**
     * Handle text messages during mining — detect "You cannot use this object".
     * This just means the current stackPos was wrong, cycling will handle it.
     * @private
     */
    _onMineTextMessage(data) {
        if (!this._mining) return;
        if (!data || !data.message) return;

        const msg = data.message.toLowerCase();
        if (msg.includes('you cannot use this object') || msg.includes('cannot use that object')) {
            // Wrong stackPos — cycling will try the next one, no need to stop
            this.logger.debug(`stackPos errado, próximo tentativa: ${this._currentStackPos}`);
        }
    }

    /**
     * Find the pick in player's inventory slots or open containers.
     * Returns position info in Tibia protocol format:
     *   - Inventory: { x: 0xFFFF, y: SLOT, z: 0 }
     *   - Container: { x: 0xFFFF, y: (64 + containerId), z: 0 }, stackPos = slot within container
     * 
     * @private
     * @returns {{ pos: {x:number,y:number,z:number}, stackPos: number, spriteId: number }|null}
     */
    _findPick() {
        const player = this.session.getPlayer();
        if (!player) return null;

        const slotNames = { 1: 'Head', 2: 'Necklace', 3: 'Backpack', 4: 'Armor', 5: 'Right', 6: 'Left', 7: 'Legs', 8: 'Feet', 9: 'Ring', 10: 'Ammo' };

        // 1. Check inventory slots (1-10)
        for (const [slot, item] of player.inventory) {
            if (item && item.id === this.pickId) {
                if (!this._pickLogged) {
                    console.log(`[Inventário] ✔ Pick encontrada no inventário slot ${slot} (${slotNames[slot] || '?'}) — id=${item.id}`);
                    this._pickLogged = true;
                }
                return {
                    pos: { x: 0xFFFF, y: slot, z: 0 },
                    stackPos: 0,
                    spriteId: item.id,
                };
            }
        }

        // 2. Check open containers
        const containers = this.session.getContainers();
        if (containers) {
            for (const [cid, container] of containers) {
                for (let i = 0; i < container.items.length; i++) {
                    const item = container.items[i];
                    if (item && item.id === this.pickId) {
                        if (!this._pickLogged) {
                            console.log(`[Inventário] ✔ Pick encontrada no Container #${cid} "${container.name}" slot [${i}] — id=${item.id}`);
                            this._pickLogged = true;
                        }
                        return {
                            pos: { x: 0xFFFF, y: 64 + cid, z: i },
                            stackPos: i,
                            spriteId: item.id,
                        };
                    }
                }
            }
        }

        this._pickLogged = false;
        console.log(`[Inventário] ✘ Pick (id=${this.pickId}) não encontrada em nenhum slot ou container`);
        return null;
    }

    // ──────── Internal: CaveBot Integration ────────

    /**
     * Pause the CaveBot waypoints
     * @private
     */
    _pauseCaveBot() {
        const cavebot = this.session.cavebot;
        if (cavebot && cavebot._enabled && !cavebot._paused) {
            this.logger.info('Pausando CaveBot para minerar...');
            cavebot.pause();
            this._paused = true;
            this.emit('cavebotPaused');
        }
    }

    /**
     * Resume the CaveBot waypoints, restarting from waypoint 0.
     * After mining, the player may be in a different position, so we
     * restart the full waypoint cycle to avoid navigation issues.
     * @private
     */
    _resumeCaveBot() {
        if (!this._paused) return;
        this._paused = false;

        const cavebot = this.session.cavebot;
        if (cavebot && cavebot._enabled) {
            this.logger.info('Retomando CaveBot do waypoint 0 (pós-mineração)...');
            cavebot.resume({ resetWaypoint: true });
            this.emit('cavebotResumed');
        }
    }

    /**
     * Log all items in inventory and containers (debug helper to find correct IDs)
     * @private
     */
    _logAllItems() {
        const player = this.session.getPlayer();
        if (!player) return;

        const slotNames = { 1: 'Head', 2: 'Necklace', 3: 'Backpack', 4: 'Armor', 5: 'Right', 6: 'Left', 7: 'Legs', 8: 'Feet', 9: 'Ring', 10: 'Ammo' };
        const invItems = [];
        for (const [slot, item] of player.inventory) {
            if (item) {
                invItems.push(`  Slot ${slot} (${slotNames[slot] || '?'}): id=${item.id}, count=${item.count || 1}`);
            }
        }
        if (invItems.length > 0) {
            console.log(`[Inventário] Itens no inventário:\n${invItems.join('\n')}`);
        } else {
            console.log('[Inventário] Inventário vazio (nenhum slot equipado)');
        }

        const containers = this.session.getContainers();
        if (containers && containers.size > 0) {
            for (const [cid, container] of containers) {
                const cItems = container.items.map((item, i) =>
                    `  [${i}] id=${item.id}, count=${item.count || 1}`
                ).join('\n');
                console.log(`[Inventário] Container #${cid} "${container.name}" (${container.items.length} itens):\n${cItems}`);
            }
        } else {
            console.log('[Inventário] Nenhum container aberto');
        }
    }
}

module.exports = Miner;
