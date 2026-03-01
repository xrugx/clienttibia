'use strict';

/**
 * NpcTrader - Automated NPC interaction and item purchasing
 * 
 * Handles the full NPC trade flow:
 * 1. Say "hi" to NPC
 * 2. Say "trade" to open shop
 * 3. Wait for server to send openShop event
 * 4. Buy the desired item(s) using the shop data
 * 5. Close the shop / say "bye"
 * 
 * Can check player inventory/containers for existing items
 * to avoid buying when not needed.
 * 
 * Usage:
 *   const trader = new NpcTrader(session);
 *   await trader.buyFromNpc({
 *       npcName: 'Rashid',
 *       itemName: 'mana potion',
 *       itemId: 268,
 *       quantity: 100,
 *       talkDelay: 1500,
 *       maxPrice: 50,
 *       ignoreCapacity: false,
 *       buyWithBackpack: false,
 *   });
 */

const EventEmitter = require('events');
const { Logger } = require('../utils');
const { SPEAK_SAY, SPEAK_PRIVATE_PN } = require('../constants/GameConstants');

class NpcTrader extends EventEmitter {
    /**
     * @param {import('../game/GameSession')} session - The game session
     * @param {object} [options]
     * @param {number} [options.talkDelay=1500] - Delay (ms) between each chat message to NPC
     * @param {number} [options.shopTimeout=8000] - Max time (ms) to wait for shop to open
     * @param {number} [options.buyDelay=500] - Delay (ms) between buy operations
     */
    constructor(session, options = {}) {
        super();
        this.session = session;
        this.logger = new Logger(`NpcTrader[${session.label}]`);
        this.logger.setLevel(session.serverConfig?.logLevel || 'info');

        // Config
        this.talkDelay = options.talkDelay ?? 1500;
        this.shopTimeout = options.shopTimeout ?? 8000;
        this.buyDelay = options.buyDelay ?? 500;
    }

    /**
     * Check if the player has at least `minCount` of an item in inventory + open containers.
     * 
     * @param {number} itemId - The item's sprite/client ID to look for
     * @param {number} [minCount=1] - Minimum quantity needed
     * @returns {object} { found: boolean, totalCount: number }
     */
    checkItem(itemId, minCount = 1) {
        let totalCount = 0;
        const foundLocations = [];

        const player = this.session.getPlayer();
        if (!player) return { found: false, totalCount: 0 };

        const slotNames = { 1: 'Head', 2: 'Necklace', 3: 'Backpack', 4: 'Armor', 5: 'Right', 6: 'Left', 7: 'Legs', 8: 'Feet', 9: 'Ring', 10: 'Ammo' };

        // Check inventory slots (1-10)
        for (const [slot, item] of player.inventory) {
            if (item && item.id === itemId) {
                const qty = item.count || 1;
                totalCount += qty;
                foundLocations.push(`inventário slot ${slot} (${slotNames[slot] || '?'}) x${qty}`);
            }
        }

        // Check open containers
        const containers = this.session.getContainers();
        if (containers) {
            for (const [cid, container] of containers) {
                for (let i = 0; i < container.items.length; i++) {
                    const item = container.items[i];
                    if (item && item.id === itemId) {
                        const qty = item.count || 1;
                        totalCount += qty;
                        foundLocations.push(`container #${cid} "${container.name}" slot [${i}] x${qty}`);
                    }
                }
            }
        }

        if (foundLocations.length > 0) {
            console.log(`[Compra] Item id=${itemId} encontrado em: ${foundLocations.join(' | ')} (total: ${totalCount})`);
        } else {
            console.log(`[Compra] Item id=${itemId} NÃO encontrado em nenhum slot ou container (total: 0)`);
        }

        return {
            found: totalCount >= minCount,
            totalCount,
        };
    }

    /**
     * Count total quantity of an item across inventory and containers
     * @param {number} itemId
     * @returns {number}
     */
    countItem(itemId) {
        return this.checkItem(itemId, 1).totalCount;
    }

    /**
     * Full NPC buy flow: open trade, find item, buy.
     * 
     * @param {object} buyConfig
     * @param {string} [buyConfig.npcName] - NPC name (for logging, optional)
     * @param {number} buyConfig.itemId - Sprite/client ID of the item to buy
     * @param {string} [buyConfig.itemName] - Item name (for matching in shop list)
     * @param {number} [buyConfig.quantity=1] - Total quantity to buy
     * @param {number} [buyConfig.minQuantity] - Minimum qty before triggering buy (default = quantity)
     * @param {boolean} [buyConfig.ignoreCapacity=false] - Ignore capacity when buying
     * @param {boolean} [buyConfig.buyWithBackpack=false] - Buy with backpack
     * @param {string[]} [buyConfig.sayMessages] - Custom NPC messages (default: ['hi', 'trade'])
     * @param {number} [buyConfig.talkDelay] - Override talk delay for this purchase
     * @param {number} [buyConfig.shopTimeout] - Override shop timeout for this purchase
     * @returns {Promise<{success: boolean, bought: number, reason?: string}>}
     */
    async buyFromNpc(buyConfig) {
        const {
            npcName = 'NPC',
            itemId,
            itemName,
            quantity = 1,
            minQuantity,
            ignoreCapacity = false,
            buyWithBackpack = false,
            sayMessages,
            talkDelay: customTalkDelay,
            shopTimeout: customShopTimeout,
        } = buyConfig;

        const talkDelay = customTalkDelay ?? this.talkDelay;
        const shopTimeout = customShopTimeout ?? this.shopTimeout;
        const minQty = minQuantity ?? quantity;

        // Step 0: Check if we already have enough items
        if (itemId) {
            const check = this.checkItem(itemId, minQty);
            if (check.found) {
                console.log(`[Compra] NpcTrader: já tem ${check.totalCount}x item (${itemId}) — compra não necessária`);
                this.emit('skipBuy', { itemId, totalCount: check.totalCount, minQuantity: minQty });
                return { success: true, bought: 0, reason: 'already_has_enough' };
            }
            console.log(`[Compra] NpcTrader: tem ${check.totalCount}x item (${itemId}), precisa de ${minQty} — comprando de ${npcName}`);
        }

        const sender = this.session.getSender();
        if (!sender) {
            return { success: false, bought: 0, reason: 'no_sender' };
        }

        // Step 1: Talk to NPC
        const messages = sayMessages || ['hi', 'trade'];
        console.log(`[Compra] Falando com ${npcName}: ${messages.join(' → ')}`);

        for (let i = 0; i < messages.length; i++) {
            sender.sendSay(SPEAK_PRIVATE_PN, messages[i]);
            this.emit('npcSay', { message: messages[i], step: i + 1, total: messages.length });

            // Wait between messages
            if (i < messages.length - 1) {
                await this._delay(talkDelay);
            }
        }

        // Step 2: Wait for openShop event from server
        this.logger.debug(`Aguardando abertura da loja (timeout: ${shopTimeout}ms)...`);
        const shopData = await this._waitForShop(shopTimeout);

        if (!shopData) {
            console.log(`[Compra] ✘ Loja não abriu após ${shopTimeout}ms`);
            // Try to say bye to clean up NPC channel
            try { sender.sendSay(SPEAK_PRIVATE_PN, 'bye'); } catch (e) { /* ignore */ }
            await this._delay(500);
            return { success: false, bought: 0, reason: 'shop_timeout' };
        }

        console.log(`[Compra] Loja aberta com ${shopData.items.length} itens`);
        this.emit('shopOpened', { itemCount: shopData.items.length });

        // Step 3: Find the desired item in the shop
        let shopItem = null;

        if (itemId) {
            shopItem = shopData.items.find(i => i.spriteId === itemId);
        }
        if (!shopItem && itemName) {
            const nameLower = itemName.toLowerCase();
            shopItem = shopData.items.find(i => i.name.toLowerCase().includes(nameLower));
        }

        if (!shopItem) {
            console.log(`[Compra] ✘ Item ${itemName || itemId} não encontrado na loja`);
            sender.sendCloseShop();
            await this._delay(500);
            try { sender.sendSay(SPEAK_PRIVATE_PN, 'bye'); } catch (e) { /* ignore */ }
            return { success: false, bought: 0, reason: 'item_not_found' };
        }

        console.log(`[Compra] Encontrado na loja: "${shopItem.name}" (sprite=${shopItem.spriteId}, preço=${shopItem.buyPrice}gp)`);

        if (shopItem.buyPrice <= 0) {
            this.logger.warn(`Item "${shopItem.name}" não está à venda (buyPrice=0)`);
            sender.sendCloseShop();
            await this._delay(500);
            try { sender.sendSay(SPEAK_PRIVATE_PN, 'bye'); } catch (e) { /* ignore */ }
            return { success: false, bought: 0, reason: 'item_not_for_sale' };
        }

        // Step 4: Calculate how many to buy (considering what we already have)
        let currentAmount = itemId ? this.countItem(itemId) : 0;
        let needToBuy = Math.max(0, quantity - currentAmount);

        if (needToBuy <= 0) {
            this.logger.info('Já tem quantidade suficiente');
            sender.sendCloseShop();
            await this._delay(500);
            try { sender.sendSay(SPEAK_PRIVATE_PN, 'bye'); } catch (e) { /* ignore */ }
            return { success: true, bought: 0, reason: 'already_has_enough' };
        }

        // Step 5: Buy in batches (max 100 per purchase in Tibia 8.60)
        let totalBought = 0;
        const maxPerBuy = 100;

        while (needToBuy > 0) {
            const batchSize = Math.min(needToBuy, maxPerBuy);

            console.log(`[Compra] Comprando ${batchSize}x "${shopItem.name}"...`);
            sender.sendBuy(shopItem.spriteId, shopItem.subType || 0, batchSize, ignoreCapacity, buyWithBackpack);

            totalBought += batchSize;
            needToBuy -= batchSize;

            this.emit('bought', { itemName: shopItem.name, amount: batchSize, remaining: needToBuy });

            if (needToBuy > 0) {
                await this._delay(this.buyDelay);
            }
        }

        // Step 6: Close shop
        console.log(`[Compra] ✔ Compra concluída: ${totalBought}x "${shopItem.name}"`);
        await this._delay(300);
        sender.sendCloseShop();
        await this._delay(500);

        // Say bye to NPC
        try { sender.sendSay(SPEAK_PRIVATE_PN, 'bye'); } catch (e) { /* ignore */ }

        this.emit('buyComplete', { itemName: shopItem.name, totalBought });
        return { success: true, bought: totalBought };
    }

    /**
     * Wait for the openShop event from the game session
     * @private
     * @param {number} timeout
     * @returns {Promise<object|null>}
     */
    _waitForShop(timeout) {
        return new Promise((resolve) => {
            const game = this.session.game;
            if (!game) {
                resolve(null);
                return;
            }

            let timer = null;
            let resolved = false;

            const onShop = (data) => {
                if (resolved) return;
                resolved = true;
                if (timer) clearTimeout(timer);
                game.removeListener('openShop', onShop);
                resolve(data);
            };

            game.on('openShop', onShop);

            timer = setTimeout(() => {
                if (resolved) return;
                resolved = true;
                game.removeListener('openShop', onShop);
                resolve(null);
            }, timeout);
        });
    }

    /**
     * @private
     */
    _delay(ms) {
        return new Promise(r => setTimeout(r, ms));
    }
}

module.exports = NpcTrader;
