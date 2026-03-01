'use strict';

/**
 * CaveBot - Automated waypoint-walking system
 * 
 * Follows a list of waypoints in order, looping back to the first when done.
 * Uses the Walker module for safe pathfinding and movement.
 * 
 * Matches the original OTClient cavebot walking behavior:
 * - Goto waypoints: walk to position using A* pathfinding
 * - Loops: cycles through all waypoints continuously
 * - Skips blocked waypoints after retries (optional)
 * - Pauses when player is dead or disconnected
 * - Delay between waypoints to avoid flooding the server
 * 
 * Usage:
 *   const cavebot = new CaveBot(session, {
 *       waypoints: [ { x: 100, y: 200, z: 7 }, { x: 110, y: 200, z: 7 } ],
 *       enabled: true,
 *   });
 *   cavebot.start();
 *   cavebot.stop();
 */

const EventEmitter = require('events');
const Walker = require('./Walker');
const NpcTrader = require('./NpcTrader');
const { Logger } = require('../utils');

class CaveBot extends EventEmitter {
    /**
     * @param {import('../game/GameSession')} session - Game session
     * @param {object} config - CaveBot configuration
     * @param {Array<{x:number,y:number,z:number,label?:string}>} config.waypoints - Waypoint list
     * @param {boolean} [config.enabled=false] - Start enabled
     * @param {number} [config.waypointDelay=500] - Delay (ms) between waypoints
     * @param {boolean} [config.loop=true] - Loop waypoints
     * @param {boolean} [config.skipBlocked=true] - Skip unreachable waypoints after retries
     * @param {number} [config.maxRetries=3] - Max retries before skipping a waypoint
     * @param {object} [config.walker] - Walker options (walkDelay, ignoreCreatures, etc.)
     */
    constructor(session, config = {}) {
        super();
        this.session = session;
        this.logger = new Logger(`CaveBot[${session.label}]`);
        this.logger.setLevel(session.serverConfig?.logLevel || 'info');

        // Config
        this.waypoints = (config.waypoints || []).map((wp, i) => ({
            x: wp.x,
            y: wp.y,
            z: wp.z,
            label: wp.label || `WP-${i + 1}`,
            type: wp.type || 'walk', // 'walk', 'buy', 'say'
            forceWalk: wp.forceWalk || false, // ignore obstacles
            // Auxiliary coordinate: used for portals/teleports.
            // After auxCoordDelay ms of starting walk, destination switches to auxCoord for verification.
            auxCoord: wp.auxCoord || null, // { x, y, z }
            auxCoordDelay: wp.auxCoordDelay ?? null, // delay in ms before switching (default: 5000)
            // Buy-specific fields
            npcName: wp.npcName || null,
            itemId: wp.itemId || null,
            itemName: wp.itemName || null,
            buyQuantity: wp.buyQuantity || 1,
            minQuantity: wp.minQuantity || null,
            ignoreCapacity: wp.ignoreCapacity || false,
            buyWithBackpack: wp.buyWithBackpack || false,
            sayMessages: wp.sayMessages || null,
            talkDelay: wp.talkDelay || null,
            // Say-specific fields
            message: wp.message || null,
            messageType: wp.messageType || 1, // SPEAK_SAY
        }));
        this.loop = config.loop !== false;
        this.skipBlocked = config.skipBlocked !== false;
        this.maxRetries = config.maxRetries || 3;
        this.waypointDelay = config.waypointDelay ?? 500;

        // Walker
        this.walker = new Walker(session, config.walker || {});

        // NPC Trader
        this.npcTrader = new NpcTrader(session, config.npcTrader || {});

        // State
        this._enabled = false;
        this._running = false;
        this._currentWpIndex = 0;
        this._stopped = false;
        this._paused = false;
        this._loopTimeout = null;

        // Forward walker events
        this.walker.on('pathFound', (d) => this.emit('pathFound', { waypoint: this._currentWpLabel(), ...d }));
        this.walker.on('arrived', (d) => this.emit('waypointReached', { waypoint: this._currentWpLabel(), position: d }));
        this.walker.on('walkFailed', (d) => this.emit('walkFailed', { waypoint: this._currentWpLabel(), ...d }));
        this.walker.on('step', (d) => this.emit('step', d));
        this.walker.on('walkCancelled', () => this.emit('walkCancelled', { waypoint: this._currentWpLabel() }));

        // Listen for session events
        this.session.on('death', () => this._onDeath());
        this.session.on('sessionDisconnected', () => this._onDisconnected());
        this.session.on('sessionStarted', () => this._onReconnected());

        if (config.enabled) {
            // Auto-start after a short delay to let login complete
            setTimeout(() => this.start(), 2000);
        }
    }

    /**
     * Start the cavebot
     */
    start() {
        if (this._enabled) return;
        if (this.waypoints.length === 0) {
            this.logger.warn('Nenhum waypoint configurado');
            return;
        }

        this._enabled = true;
        this._stopped = false;
        this._paused = false;
        this._currentWpIndex = 0;

        this.logger.info(`CaveBot iniciado com ${this.waypoints.length} waypoint(s)`);
        this.emit('started', { waypoints: this.waypoints.length });

        // Verificar Miner antes de iniciar waypoints
        if (this.session.miner && this.session.miner._enabled) {
            this.logger.debug('Verificando Miner antes de iniciar waypoints...');
            this.session.miner._scanForStones();
            if (this.session.miner.isMining) {
                this.logger.info('Miner encontrou pedra adjacente, CaveBot aguardando...');
                this.pause();
                return;
            }
        }

        this._processNextWaypoint();
    }

    /**
     * Stop the cavebot completely
     */
    stop() {
        this._enabled = false;
        this._stopped = true;
        this._running = false;
        this.walker.stop();

        if (this._loopTimeout) {
            clearTimeout(this._loopTimeout);
            this._loopTimeout = null;
        }

        this.logger.info('CaveBot parado');
        this.emit('stopped');
    }

    /**
     * Pause (can be resumed)
     */
    pause() {
        if (!this._enabled) return;
        this._paused = true;
        this.walker.stop();

        // Clear any pending waypoint loop timeout
        if (this._loopTimeout) {
            clearTimeout(this._loopTimeout);
            this._loopTimeout = null;
        }

        this.logger.info('CaveBot pausado');
        this.emit('paused');
    }

    /**
     * Resume from pause
     * @param {object} [options]
     * @param {boolean} [options.resetWaypoint=false] - Reset to first waypoint before resuming
     */
    resume(options = {}) {
        if (!this._enabled || !this._paused) return;

        // Don't resume if the Miner is still actively mining
        if (this.session.miner && this.session.miner.isMining) {
            this.logger.debug('Miner ainda está minerando, CaveBot permanece pausado');
            return;
        }

        // Reset to first waypoint if requested (e.g. after Miner finishes)
        if (options.resetWaypoint) {
            this.logger.info('Reiniciando waypoints do início (index 0)');
            this._currentWpIndex = 0;
        }

        this._paused = false;
        this.logger.info('CaveBot retomado');
        this.emit('resumed');
        this._processNextWaypoint();
    }

    /**
     * Reset to the first waypoint. Can be called while running or paused.
     */
    resetToStart() {
        this._currentWpIndex = 0;
        this.logger.info('Waypoints reiniciados para o início (index 0)');
        this.emit('waypointReset');
    }

    /**
     * Get current status
     * @returns {object}
     */
    getStatus() {
        return {
            enabled: this._enabled,
            paused: this._paused,
            running: this._running,
            currentWaypoint: this._currentWpIndex,
            currentLabel: this._currentWpLabel(),
            totalWaypoints: this.waypoints.length,
            isWalking: this.walker.isWalking,
        };
    }

    /**
     * Update waypoints at runtime
     * @param {Array<{x:number,y:number,z:number,label?:string}>} waypoints
     */
    setWaypoints(waypoints) {
        this.waypoints = waypoints.map((wp, i) => ({
            x: wp.x,
            y: wp.y,
            z: wp.z,
            label: wp.label || `WP-${i + 1}`,
            type: wp.type || 'walk',
            forceWalk: wp.forceWalk || false,
            auxCoord: wp.auxCoord || null,
            auxCoordDelay: wp.auxCoordDelay ?? null,
            npcName: wp.npcName || null,
            itemId: wp.itemId || null,
            itemName: wp.itemName || null,
            buyQuantity: wp.buyQuantity || 1,
            minQuantity: wp.minQuantity || null,
            ignoreCapacity: wp.ignoreCapacity || false,
            buyWithBackpack: wp.buyWithBackpack || false,
            sayMessages: wp.sayMessages || null,
            talkDelay: wp.talkDelay || null,
            message: wp.message || null,
            messageType: wp.messageType || 1,
        }));
        this._currentWpIndex = 0;
        this.logger.info(`Waypoints atualizados: ${this.waypoints.length} waypoint(s)`);
    }

    // ──────── Internal ────────

    /**
     * Process the current waypoint
     * @private
     */
    async _processNextWaypoint() {
        if (this._stopped || !this._enabled || this._paused) return;

        // Forçar scan do Miner antes de tentar andar para o próximo waypoint
        if (this.session.miner && this.session.miner._enabled && !this.session.miner.isMining) {
            this.session.miner._scanForStones();
        }

        // If the Miner is actively mining, pause CaveBot to avoid conflicts
        if (this.session.miner && this.session.miner.isMining) {
            this.logger.debug('Miner está minerando, pausando CaveBot...');
            this.pause();
            return;
        }

        if (this.waypoints.length === 0) {
            this.stop();
            return;
        }

        // Check session is running
        if (!this.session.isRunning) {
            this.logger.debug('Session not running, waiting...');
            return;
        }

        const wp = this.waypoints[this._currentWpIndex];
        if (!wp) {
            if (this.loop) {
                this._currentWpIndex = 0;
                this._processNextWaypoint();
            } else {
                this.logger.info('Todos os waypoints concluídos');
                this.emit('completed');
                this.stop();
            }
            return;
        }

        this._running = true;
        const wpType = wp.type || 'walk';
        this.logger.info(`[${wpType.toUpperCase()}] ${wp.label} (${wp.x}, ${wp.y}, ${wp.z}) [${this._currentWpIndex + 1}/${this.waypoints.length}]`);
        this.emit('walkingTo', { index: this._currentWpIndex, waypoint: wp, type: wpType });

        // Pre-check: skip waypoints on a different floor (layer) immediately.
        // Floor checks apply regardless of forceWalk — normal movement cannot cross floors.
        let skipWalk = false;
        let skipDueToFloor = false;
        const player = this.session.getPlayer();
        if (player?.position) {
            const pos = player.position;
            const differentFloor = pos.z !== wp.z;
            if (differentFloor) {
                this.logger.debug(`Ignorando ${wp.label} — andar diferente (z: ${pos.z} vs ${wp.z})`);
                skipWalk = true;
                skipDueToFloor = true;
            } else if (!wp.forceWalk) {
                const maxDist = this.walker.pathfinderOptions?.maxDistance || 50;
                const dist = Math.max(Math.abs(pos.x - wp.x), Math.abs(pos.y - wp.y));
                if (dist > maxDist) {
                    this.logger.warn(`Pulando ${wp.label} — fora de alcance: muito longe (dist=${dist}, max=${maxDist})`);
                    skipWalk = true;
                }
            }
        }

        // Step 1: Walk to the waypoint position (for all types)
        let arrived = false;
        let retries = 0;

        while (!skipWalk && retries <= this.maxRetries && !arrived && !this._stopped && !this._paused) {
            try {
                arrived = await this.walker.walkTo(wp, 0, { forceWalk: wp.forceWalk, auxCoord: wp.auxCoord, auxCoordDelay: wp.auxCoordDelay });
            } catch (err) {
                this.logger.error(`Erro ao caminhar: ${err.message}`);
            }

            if (!arrived && !this._stopped && !this._paused) {
                retries++;
                if (retries <= this.maxRetries) {
                    this.logger.debug(`Tentativa ${retries}/${this.maxRetries} para ${wp.label}`);
                    await this._delay(1000);
                }
            }
        }

        this._running = false;

        if (this._stopped || this._paused) return;

        if (arrived) {
            this.logger.info(`Chegou em ${wp.label}`);
        } else if (skipDueToFloor) {
            this.logger.debug(`Ignorando ${wp.label} — camada diferente`);
            this.emit('waypointSkipped', { index: this._currentWpIndex, waypoint: wp, reason: 'differentFloor' });
        } else if (this.skipBlocked) {
            this.logger.warn(`Pulando ${wp.label} (não alcançável)`);
            this.emit('waypointSkipped', { index: this._currentWpIndex, waypoint: wp });
        } else {
            this.logger.error(`Não consegue alcançar ${wp.label}, parando`);
            this.stop();
            return;
        }

        // Step 2: Execute waypoint action based on type
        if (arrived) {
            try {
                await this._executeWaypointAction(wp);
            } catch (err) {
                this.logger.error(`Erro ao executar ação do waypoint ${wp.label}: ${err.message}`);
            }
        }

        // Advance to next waypoint
        this._currentWpIndex++;
        if (this._currentWpIndex >= this.waypoints.length) {
            if (this.loop) {
                this._currentWpIndex = 0;
                this.emit('loopComplete');
            } else {
                this.logger.info('Todos os waypoints concluídos');
                this.emit('completed');
                this.stop();
                return;
            }
        }

        // Delay before next waypoint
        this._loopTimeout = setTimeout(() => {
            this._loopTimeout = null;
            this._processNextWaypoint();
        }, this.waypointDelay);
    }

    /**
     * Execute waypoint-specific action after arriving at the position.
     * @private
     * @param {object} wp - The waypoint object
     */
    async _executeWaypointAction(wp) {
        switch (wp.type) {
            case 'buy':
                await this._executeBuyAction(wp);
                break;

            case 'say':
                await this._executeSayAction(wp);
                break;

            case 'walk':
            default:
                // walk type — just arrive at the position, no extra action
                break;
        }
    }

    /**
     * Execute a 'buy' waypoint action: open backpack, check inventory and buy from NPC if needed.
     * @private
     * @param {object} wp
     */
    async _executeBuyAction(wp) {
        if (!wp.itemId && !wp.itemName) {
            this.logger.warn(`Waypoint ${wp.label}: buy type requer itemId ou itemName`);
            return;
        }

        // Step 1: Abrir a backpack antes de verificar o inventário
        console.log(`[Compra] Waypoint "${wp.label}": verificando inventário antes de comprar item id=${wp.itemId}...`);
        const backpackOpened = await this._openBackpack();
        if (backpackOpened) {
            // Esperar um pouco para garantir que os containers estão sincronizados
            await this._delay(500);
        }

        // Step 2: Verificar se o jogador já possui o item
        if (wp.itemId) {
            const minQty = wp.minQuantity ?? wp.buyQuantity ?? 1;
            const check = this.npcTrader.checkItem(wp.itemId, minQty);
            console.log(`[Compra] Verificação: possui ${check.totalCount}x item (id=${wp.itemId}), precisa de ${minQty}`);

            if (check.found) {
                console.log(`[Compra] ✔ Já possui ${check.totalCount}x item (id=${wp.itemId}) — pulando compra em "${wp.label}"`);
                this.emit('buyEnd', { waypoint: wp.label, result: { success: true, bought: 0, reason: 'already_has_enough' } });
                return;
            }

            console.log(`[Compra] ✘ Item insuficiente (${check.totalCount}/${minQty}) — comprando...`);
        }

        // Aguardar 3 segundos após chegar na coordenada antes de iniciar a compra
        console.log(`[Compra] Aguardando 3 segundos antes de iniciar compra em "${wp.label}"...`);
        await this._delay(3000);

        console.log(`[Compra] Comprando de NPC: ${wp.npcName || 'NPC'} — item: ${wp.itemName || wp.itemId} x${wp.buyQuantity}`);
        this.emit('buyStart', { waypoint: wp.label, itemId: wp.itemId, itemName: wp.itemName });

        const result = await this.npcTrader.buyFromNpc({
            npcName: wp.npcName || wp.label,
            itemId: wp.itemId,
            itemName: wp.itemName,
            quantity: wp.buyQuantity,
            minQuantity: wp.minQuantity,
            ignoreCapacity: wp.ignoreCapacity,
            buyWithBackpack: wp.buyWithBackpack,
            sayMessages: wp.sayMessages,
            talkDelay: wp.talkDelay,
        });

        if (result.success && result.bought > 0) {
            console.log(`[Compra] ✔ Compra concluída em "${wp.label}": ${result.bought} itens (${result.reason || 'ok'})`);

            // Mover o item comprado para o slot 0 do container (primeiro slot da backpack)
            if (wp.itemId) {
                await this._delay(500);
                await this._moveItemToFirstSlot(wp.itemId);
            }
        } else if (result.success) {
            console.log(`[Compra] ✔ Compra em "${wp.label}": nenhum item comprado (${result.reason || 'ok'})`);
        } else {
            console.log(`[Compra] ✘ Compra falhou em "${wp.label}": ${result.reason}`);
        }

        this.emit('buyEnd', { waypoint: wp.label, result });

        // Small delay after buy before continuing
        await this._delay(1000);
    }

    /**
     * Move an item to the first slot (slot 0) of the first open container.
     * Finds the item in any container slot and moves it to position 0.
     * @private
     * @param {number} itemId - Sprite ID of the item to move
     */
    async _moveItemToFirstSlot(itemId) {
        const sender = this.session.getSender();
        const containers = this.session.getContainers();
        if (!sender || !containers || containers.size === 0) return;

        // Find the first container (backpack)
        const firstCid = containers.keys().next().value;
        const container = containers.get(firstCid);
        if (!container) return;

        // Check if item is already at slot 0
        if (container.items[0] && container.items[0].id === itemId) {
            console.log(`[Compra] Pick (id=${itemId}) já está no slot [0] do container #${firstCid} "${container.name}"`);
            return;
        }

        // Find the item in the container
        let foundSlot = -1;
        for (let i = 0; i < container.items.length; i++) {
            if (container.items[i] && container.items[i].id === itemId) {
                foundSlot = i;
                break;
            }
        }

        if (foundSlot === -1) {
            console.log(`[Compra] ✘ Pick (id=${itemId}) não encontrada nos containers para mover`);
            return;
        }

        console.log(`[Compra] Movendo pick (id=${itemId}) do slot [${foundSlot}] para slot [0] no container #${firstCid} "${container.name}"...`);

        // sendMoveItem(fromPos, fromSpriteId, fromStackPos, toPos, count)
        // Server uses pos.z as the container slot index
        // fromPos.z = source slot, toPos.z = target slot (0 = first position)
        sender.sendMoveItem(
            { x: 0xFFFF, y: 64 + firstCid, z: foundSlot },  // fromPos (container, slot=foundSlot)
            itemId,                                           // fromSpriteId
            foundSlot,                                        // fromStackPos
            { x: 0xFFFF, y: 64 + firstCid, z: 0 },          // toPos (same container, slot=0)
            1                                                 // count
        );

        await this._delay(300);

        // Verify the move
        const updatedContainers = this.session.getContainers();
        if (updatedContainers) {
            const updatedContainer = updatedContainers.get(firstCid);
            if (updatedContainer && updatedContainer.items[0] && updatedContainer.items[0].id === itemId) {
                console.log(`[Compra] ✔ Pick movida para slot [0] com sucesso!`);
            } else {
                const items = updatedContainer ? updatedContainer.items.map((it, i) => `[${i}] id=${it.id} count=${it.count || 1}`).join(', ') : 'N/A';
                console.log(`[Compra] Container após mover: ${items}`);
            }
        }
    }

    /**
     * Execute a 'say' waypoint action: say a message when arriving.
     * @private
     * @param {object} wp
     */
    async _executeSayAction(wp) {
        if (!wp.message) {
            this.logger.warn(`Waypoint ${wp.label}: say type requer campo 'message'`);
            return;
        }

        const sender = this.session.getSender();
        if (!sender) return;

        this.logger.info(`Falando: "${wp.message}"`);
        sender.sendSay(wp.messageType || 1, wp.message);
        this.emit('said', { waypoint: wp.label, message: wp.message });

        await this._delay(500);
    }

    /**
     * Current waypoint label
     * @private
     */
    _currentWpLabel() {
        const wp = this.waypoints[this._currentWpIndex];
        return wp ? wp.label : 'none';
    }

    /**
     * Handle player death: pause cavebot
     * @private
     */
    _onDeath() {
        if (this._enabled) {
            this.logger.warn('Player morreu, pausando cavebot');
            this.pause();
        }
    }

    /**
     * Handle disconnect: pause
     * @private
     */
    _onDisconnected() {
        if (this._enabled) {
            this.logger.warn('Desconectado, pausando cavebot');
            this.pause();
        }
    }

    /**
     * Handle reconnect: resume if was enabled
     * @private
     */
    _onReconnected() {
        if (this._enabled && this._paused) {
            this.logger.info('Reconectado, retomando cavebot em 3s...');
            setTimeout(() => this.resume(), 3000);
        }
    }

    /**
     * @private
     */
    _delay(ms) {
        return new Promise(r => setTimeout(r, ms));
    }

    /**
     * Open the backpack (inventory slot 3) and wait for the container to appear.
     * Returns a promise that resolves when the backpack opens or after timeout.
     * @private
     * @returns {Promise<boolean>} true if backpack opened, false otherwise
     */
    _openBackpack() {
        return new Promise((resolve) => {
            const sender = this.session.getSender();
            const player = this.session.getPlayer();
            if (!sender || !player) {
                resolve(false);
                return;
            }

            // Check if containers are already open
            const containers = this.session.getContainers();
            if (containers && containers.size > 0) {
                console.log('[Compra] Backpack já está aberta');
                // Log contents
                for (const [cid, container] of containers) {
                    const items = container.items.map((it, i) => `[${i}] id=${it.id} count=${it.count || 1}`).join(', ');
                    console.log(`[Compra] Container #${cid} "${container.name}": ${items}`);
                }
                resolve(true);
                return;
            }

            // Get backpack item from slot 3
            const backpackItem = player.inventory.get(3); // SLOT_BACKPACK = 3
            if (!backpackItem) {
                console.log('[Compra] Nenhuma backpack equipada no slot 3');
                resolve(false);
                return;
            }

            console.log(`[Compra] Abrindo backpack (id=${backpackItem.id})...`);

            const game = this.session.game;
            if (!game) {
                resolve(false);
                return;
            }

            const timeout = setTimeout(() => {
                game.removeListener('openContainer', onOpen);
                console.log('[Compra] Timeout aguardando abertura da backpack');
                resolve(false);
            }, 3000);

            const onOpen = (data) => {
                clearTimeout(timeout);
                game.removeListener('openContainer', onOpen);
                console.log('[Compra] Backpack aberta!');
                // Wait a bit then log contents
                setTimeout(() => {
                    const containers = this.session.getContainers();
                    if (containers) {
                        for (const [cid, container] of containers) {
                            const items = container.items.map((it, i) => `[${i}] id=${it.id} count=${it.count || 1}`).join(', ');
                            console.log(`[Compra] Container #${cid} "${container.name}": ${items}`);
                        }
                    }
                    resolve(true);
                }, 200);
            };

            game.on('openContainer', onOpen);

            // Send UseItem on backpack slot
            sender.sendUseItem(
                { x: 0xFFFF, y: 3, z: 0 },
                backpackItem.id,
                0,
                0
            );
        });
    }
}

module.exports = CaveBot;
