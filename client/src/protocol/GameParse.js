'use strict';

/**
 * GameParse - Server → Client packet parsers for Tibia 8.60
 * 
 * Each parse method reads one specific opcode's data from the NetworkMessage
 * and returns a structured object with the parsed data.
 */

const { Creature, Item, Outfit, Position, Tile } = require('../core');
const {
    CREATURE_UNKNOWN,
    CREATURE_KNOWN,
    CREATURE_TURN,
    MAP_AWARE_X,
    MAP_AWARE_Y,
    SEA_FLOOR,
    MAP_MAX_Z,
    TILE_MAX_THINGS
} = require('../constants/GameConstants');

class GameParse {
    /**
     * @param {object} gameState - Reference to game state (creatures, map, player, datManager)
     */
    constructor(gameState) {
        this.game = gameState;
    }

    // ============================================================
    // Connection / Authentication
    // ============================================================

    /**
     * Parse 0x0A - Self Appear (player login)
     */
    parseSelfAppear(msg) {
        const playerId = msg.readU32();
        const beatDuration = msg.readU16();  // 0x0032 = 50ms
        const canReportBugs = msg.readU8() !== 0;
        return { playerId, beatDuration, canReportBugs };
    }

    /**
     * Parse 0x0B - GM Actions
     */
    parseGMActions(msg) {
        const actions = [];
        for (let i = 0; i < 20; i++) {
            actions.push(msg.readU8());
        }
        return { actions };
    }

    /**
     * Parse 0x14 - Error Message (login error in game protocol)
     */
    parseErrorMessage(msg) {
        const message = msg.readString();
        return { message };
    }

    /**
     * Parse 0x15 - FYI Message
     */
    parseFYIMessage(msg) {
        const message = msg.readString();
        return { message };
    }

    /**
     * Parse 0x16 - Waiting List
     */
    parseWaitingList(msg) {
        const message = msg.readString();
        const waitTime = msg.readU8();
        return { message, waitTime };
    }

    /**
     * Parse 0x1E - Ping
     */
    parsePing() {
        return {};
    }

    /**
     * Parse 0x1F - Challenge (game server sends on connect)
     */
    parseChallenge(msg) {
        const timestamp = msg.readU32();
        const random = msg.readU8();
        return { timestamp, random };
    }

    /**
     * Parse 0x28 - Death (re-login window)
     */
    parseDeath() {
        return {};
    }

    // ============================================================
    // Map parsing
    // ============================================================

    /**
     * Parse 0x64 - Full Map Description
     */
    parseFullMap(msg) {
        const pos = this._readPosition(msg);
        this.game.playerPosition = pos;

        // Parse map area: 18x14 tiles, multiple floors
        try {
            this._parseMapDescription(msg, pos.x - 8, pos.y - 6, pos.z, MAP_AWARE_X, MAP_AWARE_Y);
        } catch (e) {
            // Tile parsing may fail if DatManager has no item data (extra byte desync).
            // Position was already extracted — skip remaining tile data so the
            // session can still track player position and emit events.
            if (msg.hasMore()) msg.skipToEnd();
        }
        return { position: pos };
    }

    /**
     * Parse 0x65 - Map Top Row (walk north)
     */
    parseMapTopRow(msg) {
        const pos = this.game.playerPosition;
        pos.y--;
        try {
            this._parseMapDescription(msg, pos.x - 8, pos.y - 6, pos.z, MAP_AWARE_X, 1);
        } catch (e) {
            if (msg.hasMore()) msg.skipToEnd();
        }
        return { position: pos };
    }

    /**
     * Parse 0x66 - Map Right Column (walk east)
     */
    parseMapRightColumn(msg) {
        const pos = this.game.playerPosition;
        pos.x++;
        try {
            this._parseMapDescription(msg, pos.x + 9, pos.y - 6, pos.z, 1, MAP_AWARE_Y);
        } catch (e) {
            if (msg.hasMore()) msg.skipToEnd();
        }
        return { position: pos };
    }

    /**
     * Parse 0x67 - Map Bottom Row (walk south)
     */
    parseMapBottomRow(msg) {
        const pos = this.game.playerPosition;
        pos.y++;
        try {
            this._parseMapDescription(msg, pos.x - 8, pos.y + 7, pos.z, MAP_AWARE_X, 1);
        } catch (e) {
            if (msg.hasMore()) msg.skipToEnd();
        }
        return { position: pos };
    }

    /**
     * Parse 0x68 - Map Left Column (walk west)
     */
    parseMapLeftColumn(msg) {
        const pos = this.game.playerPosition;
        pos.x--;
        try {
            this._parseMapDescription(msg, pos.x - 8, pos.y - 6, pos.z, 1, MAP_AWARE_Y);
        } catch (e) {
            if (msg.hasMore()) msg.skipToEnd();
        }
        return { position: pos };
    }

    /**
     * Parse 0x69 - Update Tile
     */
    parseUpdateTile(msg) {
        const pos = this._readPosition(msg);
        const tile = this.game.map.getOrCreateTile(pos);
        tile.clear();

        // Read tile data - check for empty tile marker
        const firstU16 = msg.peekU16();
        if (firstU16 === 0xFF01) {
            // Empty tile
            msg.readU16();
            return { position: pos, empty: true };
        }

        // Parse tile things
        this._parseTileThings(msg, tile);

        // Skip end marker
        if (msg.hasMore()) {
            const skip = msg.peekU16();
            if (skip >= 0xFF00) {
                msg.readU16();
            }
        }

        return { position: pos, tile };
    }

    /**
     * Parse 0x6A - Add Thing to Tile
     */
    parseAddThingToTile(msg) {
        const pos = this._readPosition(msg);
        const stackPos = msg.readU8();
        const thing = this._readThing(msg);

        const tile = this.game.map.getOrCreateTile(pos);
        tile.addThing(thing, stackPos);

        return { position: pos, stackPos, thing };
    }

    /**
     * Parse 0x6B - Update Thing on Tile
     */
    parseUpdateThingOnTile(msg) {
        const pos = this._readPosition(msg);
        const stackPos = msg.readU8();
        const thing = this._readThing(msg);

        const tile = this.game.map.getOrCreateTile(pos);
        tile.updateThing(stackPos, thing);

        return { position: pos, stackPos, thing };
    }

    /**
     * Parse 0x6C - Remove Thing from Tile
     */
    parseRemoveThingFromTile(msg) {
        const pos = this._readPosition(msg);
        const stackPos = msg.readU8();

        const tile = this.game.map.getTile(pos);
        let removed = null;
        if (tile) {
            removed = tile.removeThing(stackPos);
        }

        return { position: pos, stackPos, removed };
    }

    /**
     * Parse 0x6D - Move Creature
     */
    parseMoveCreature(msg) {
        const fromPos = this._readPosition(msg);
        const fromStackPos = msg.readU8();
        const toPos = this._readPosition(msg);

        return { fromPos, fromStackPos, toPos };
    }

    // ============================================================
    // Container parsing
    // ============================================================

    /**
     * Parse 0x6E - Open Container
     */
    parseOpenContainer(msg) {
        const containerId = msg.readU8();
        const itemId = msg.readU16();
        const name = msg.readString();
        const capacity = msg.readU8();
        const hasParent = msg.readU8() !== 0;
        const itemCount = msg.readU8();

        const items = [];
        for (let i = 0; i < itemCount; i++) {
            items.push(this._readItem(msg));
        }

        return { containerId, itemId, name, capacity, hasParent, items };
    }

    /**
     * Parse 0x6F - Close Container
     */
    parseCloseContainer(msg) {
        const containerId = msg.readU8();
        return { containerId };
    }

    /**
     * Parse 0x70 - Add Container Item
     */
    parseAddContainerItem(msg) {
        const containerId = msg.readU8();
        const item = this._readItem(msg);
        return { containerId, item };
    }

    /**
     * Parse 0x71 - Update Container Item
     */
    parseUpdateContainerItem(msg) {
        const containerId = msg.readU8();
        const slot = msg.readU8();
        const item = this._readItem(msg);
        return { containerId, slot, item };
    }

    /**
     * Parse 0x72 - Remove Container Item
     */
    parseRemoveContainerItem(msg) {
        const containerId = msg.readU8();
        const slot = msg.readU8();
        return { containerId, slot };
    }

    // ============================================================
    // Inventory
    // ============================================================

    /**
     * Parse 0x78 - Set Inventory Slot
     */
    parseSetInventory(msg) {
        const slot = msg.readU8();
        const item = this._readItem(msg);
        return { slot, item };
    }

    /**
     * Parse 0x79 - Remove Inventory Slot
     */
    parseRemoveInventory(msg) {
        const slot = msg.readU8();
        return { slot };
    }

    // ============================================================
    // NPC Trade
    // ============================================================

    /**
     * Parse 0x7A - Open NPC Shop
     */
    parseOpenShop(msg) {
        const itemCount = msg.readU8();
        const items = [];
        for (let i = 0; i < itemCount; i++) {
            items.push({
                spriteId: msg.readU16(),
                subType: msg.readU8(),
                name: msg.readString(),
                weight: msg.readU32(),
                buyPrice: msg.readU32(),
                sellPrice: msg.readU32()
            });
        }
        return { items };
    }

    /**
     * Parse 0x7B - Shop Goods / Sale List
     */
    parseShopGoods(msg) {
        const playerMoney = msg.readU32();
        const goodsCount = msg.readU8();
        const goods = [];
        for (let i = 0; i < goodsCount; i++) {
            goods.push({
                itemId: msg.readU16(),
                count: msg.readU8()
            });
        }
        return { playerMoney, goods };
    }

    /**
     * Parse 0x7C - Close Shop
     */
    parseCloseShop() {
        return {};
    }

    // ============================================================
    // Player Trade
    // ============================================================

    /**
     * Parse 0x7D - Own Trade Offer
     */
    parseOwnTradeOffer(msg) {
        const name = msg.readString();
        const itemCount = msg.readU8();
        const items = [];
        for (let i = 0; i < itemCount; i++) {
            items.push(this._readItem(msg));
        }
        return { name, items };
    }

    /**
     * Parse 0x7E - Counter Trade Offer
     */
    parseCounterTradeOffer(msg) {
        const name = msg.readString();
        const itemCount = msg.readU8();
        const items = [];
        for (let i = 0; i < itemCount; i++) {
            items.push(this._readItem(msg));
        }
        return { name, items };
    }

    /**
     * Parse 0x7F - Close Trade
     */
    parseCloseTrade() {
        return {};
    }

    // ============================================================
    // Environment Effects
    // ============================================================

    /**
     * Parse 0x82 - World Light
     */
    parseWorldLight(msg) {
        const level = msg.readU8();
        const color = msg.readU8();
        return { level, color };
    }

    /**
     * Parse 0x83 - Magic Effect
     */
    parseMagicEffect(msg) {
        const pos = this._readPosition(msg);
        const effectId = msg.readU8(); // type + 1 on wire
        return { position: pos, effectId: effectId - 1 };
    }

    /**
     * Parse 0x84 - Animated Text
     */
    parseAnimatedText(msg) {
        const pos = this._readPosition(msg);
        const color = msg.readU8();
        const text = msg.readString();
        return { position: pos, color, text };
    }

    /**
     * Parse 0x85 - Distance Effect (projectile)
     */
    parseDistanceEffect(msg) {
        const fromPos = this._readPosition(msg);
        const toPos = this._readPosition(msg);
        const effectId = msg.readU8(); // type + 1 on wire
        return { fromPos, toPos, effectId: effectId - 1 };
    }

    /**
     * Parse 0x86 - Creature Square (mark)
     */
    parseCreatureSquare(msg) {
        const creatureId = msg.readU32();
        const color = msg.readU8();
        return { creatureId, color };
    }

    // ============================================================
    // Creature updates
    // ============================================================

    /**
     * Parse 0x8C - Creature Health
     */
    parseCreatureHealth(msg) {
        const creatureId = msg.readU32();
        const healthPercent = msg.readU8();
        return { creatureId, healthPercent };
    }

    /**
     * Parse 0x8D - Creature Light
     */
    parseCreatureLight(msg) {
        const creatureId = msg.readU32();
        const lightLevel = msg.readU8();
        const lightColor = msg.readU8();
        return { creatureId, lightLevel, lightColor };
    }

    /**
     * Parse 0x8E - Creature Outfit
     */
    parseCreatureOutfit(msg) {
        const creatureId = msg.readU32();
        const outfit = Outfit.fromMessage(msg);
        return { creatureId, outfit };
    }

    /**
     * Parse 0x8F - Creature Speed
     */
    parseCreatureSpeed(msg) {
        const creatureId = msg.readU32();
        const speed = msg.readU16();
        return { creatureId, speed };
    }

    /**
     * Parse 0x90 - Creature Skull
     */
    parseCreatureSkull(msg) {
        const creatureId = msg.readU32();
        const skull = msg.readU8();
        return { creatureId, skull };
    }

    /**
     * Parse 0x91 - Creature Shield (Party)
     */
    parseCreatureShield(msg) {
        const creatureId = msg.readU32();
        const shield = msg.readU8();
        return { creatureId, shield };
    }

    /**
     * Parse 0x92 - Creature Walkthrough (passability)
     */
    parseCreatureWalkthrough(msg) {
        const creatureId = msg.readU32();
        const impassable = msg.readU8() !== 0;
        return { creatureId, impassable: !impassable }; // Inverted on wire
    }

    // ============================================================
    // Text Windows
    // ============================================================

    /**
     * Parse 0x96 - Edit Text Window
     */
    parseEditTextWindow(msg) {
        const windowId = msg.readU32();
        const item = this._readItem(msg);
        const maxLength = msg.readU16();
        const text = msg.readString();
        const author = msg.readString();
        const date = msg.readString();
        return { windowId, item, maxLength, text, author, date };
    }

    /**
     * Parse 0x97 - Edit House Window
     */
    parseEditHouseWindow(msg) {
        msg.readU8(); // 0x00
        const windowId = msg.readU32();
        const text = msg.readString();
        return { windowId, text };
    }

    // ============================================================
    // Player data
    // ============================================================

    /**
     * Parse 0xA0 - Player Stats
     */
    parsePlayerStats(msg) {
        const health = msg.readU16();
        const maxHealth = msg.readU16();
        const freeCapacity = msg.readU32(); // capacity * 100
        const experience = msg.readU32();
        const level = msg.readU16();
        const levelPercent = msg.readU8();
        const mana = msg.readU16();
        const maxMana = msg.readU16();
        const magicLevel = msg.readU8();
        const magicLevelPercent = msg.readU8();
        const soul = msg.readU8();
        const stamina = msg.readU16(); // in minutes

        return {
            health, maxHealth, freeCapacity, experience,
            level, levelPercent, mana, maxMana,
            magicLevel, magicLevelPercent, soul, stamina
        };
    }

    /**
     * Parse 0xA1 - Player Skills
     */
    parsePlayerSkills(msg) {
        const skills = [];
        for (let i = 0; i < 7; i++) {
            skills.push({
                level: msg.readU8(),
                percent: msg.readU8()
            });
        }
        return { skills };
    }

    /**
     * Parse 0xA2 - Player Icons (status effects)
     */
    parsePlayerIcons(msg) {
        const icons = msg.readU16();
        return { icons };
    }

    /**
     * Parse 0xA3 - Cancel Target
     */
    parseCancelTarget(msg) {
        const creatureId = msg.readU32(); // Always 0
        return { creatureId };
    }

    // ============================================================
    // Chat / Messages
    // ============================================================

    /**
     * Parse 0xAA - Creature Speak
     */
    parseCreatureSpeak(msg) {
        const statementId = msg.readU32();
        const name = msg.readString();
        const level = msg.readU16();
        const type = msg.readU8();

        const result = { statementId, name, level, type };

        switch (type) {
            case 1:  // Say
            case 2:  // Whisper
            case 3:  // Yell
            case 19: // Monster say
            case 20: // Monster yell
                result.position = this._readPosition(msg);
                break;
            case 5:  // NPC say
                result.position = this._readPosition(msg);
                break;
            case 6:  // Private
            case 14: // GM private
                // No extra position data
                break;
            case 7:  // Channel Y
            case 8:  // Channel W
            case 13: // Channel R1
            case 15: // Channel O
            case 16: // Channel R2
                result.channelId = msg.readU16();
                break;
            case 9:  // RVR Channel
                result.timestamp = msg.readU32();
                break;
            case 10: // RVR Answer
            case 11: // RVR Continue
            case 12: // Broadcast
                break;
        }

        result.message = msg.readString();
        return result;
    }

    /**
     * Parse 0xAB - Channel List
     */
    parseChannelList(msg) {
        const count = msg.readU8();
        const channels = [];
        for (let i = 0; i < count; i++) {
            channels.push({
                id: msg.readU16(),
                name: msg.readString()
            });
        }
        return { channels };
    }

    /**
     * Parse 0xAC - Open Channel
     */
    parseOpenChannel(msg) {
        const channelId = msg.readU16();
        const name = msg.readString();
        return { channelId, name };
    }

    /**
     * Parse 0xAD - Open Private Channel
     */
    parseOpenPrivateChannel(msg) {
        const name = msg.readString();
        return { name };
    }

    /**
     * Parse 0xAE - Rule Violation Channel
     */
    parseRuleViolationChannel(msg) {
        const channelId = msg.readU16();
        return { channelId };
    }

    /**
     * Parse 0xAF - Remove Rule Violation Report
     */
    parseRemoveRuleViolation(msg) {
        const name = msg.readString();
        return { name };
    }

    /**
     * Parse 0xB0 - Cancel Rule Violation
     */
    parseCancelRuleViolation(msg) {
        const name = msg.readString();
        return { name };
    }

    /**
     * Parse 0xB1 - Lock Rule Violation
     */
    parseLockRuleViolation() {
        return {};
    }

    /**
     * Parse 0xB2 - Create Own Channel
     */
    parseCreateOwnChannel(msg) {
        const channelId = msg.readU16();
        const name = msg.readString();
        return { channelId, name };
    }

    /**
     * Parse 0xB3 - Close Channel
     */
    parseCloseChannel(msg) {
        const channelId = msg.readU16();
        return { channelId };
    }

    /**
     * Parse 0xB4 - Text Message
     */
    parseTextMessage(msg) {
        const type = msg.readU8();
        const message = msg.readString();
        return { type, message };
    }

    /**
     * Parse 0xB5 - Cancel Walk
     */
    parseCancelWalk(msg) {
        const direction = msg.readU8();
        return { direction };
    }

    // ============================================================
    // Floor changes
    // ============================================================

    /**
     * Parse 0xBE - Floor Change Up
     */
    parseFloorChangeUp(msg) {
        const pos = this.game.playerPosition;
        pos.z--;

        try {
            if (pos.z === SEA_FLOOR) {
                // Going to surface from underground
                for (let z = 5; z >= 0; z--) {
                    this._parseFloorDescription(msg, pos.x - 8, pos.y - 6, z, MAP_AWARE_X, MAP_AWARE_Y, 8 - z);
                }
            } else if (pos.z > SEA_FLOOR) {
                // Going up in underground
                this._parseFloorDescription(msg, pos.x - 8, pos.y - 6, pos.z - 2, MAP_AWARE_X, MAP_AWARE_Y, 3);
            }
        } catch (e) {
            if (msg.hasMore()) msg.skipToEnd();
        }

        // Read remaining strips
        pos.x++;
        pos.y++;

        return { position: pos };
    }

    /**
     * Parse 0xBF - Floor Change Down
     */
    parseFloorChangeDown(msg) {
        const pos = this.game.playerPosition;
        pos.z++;

        try {
            if (pos.z === SEA_FLOOR + 1) {
                // Going underground from surface
                for (let z = pos.z; z <= pos.z + 2 && z <= MAP_MAX_Z; z++) {
                    const offset = z - pos.z;
                    this._parseFloorDescription(msg, pos.x - 8, pos.y - 6, z, MAP_AWARE_X, MAP_AWARE_Y, -1 - offset);
                }
            } else if (pos.z > SEA_FLOOR + 1 && pos.z <= MAP_MAX_Z) {
                // Going deeper underground
                this._parseFloorDescription(msg, pos.x - 8, pos.y - 6, pos.z + 2, MAP_AWARE_X, MAP_AWARE_Y, -3);
            }
        } catch (e) {
            if (msg.hasMore()) msg.skipToEnd();
        }

        pos.x--;
        pos.y--;

        return { position: pos };
    }

    // ============================================================
    // Outfit
    // ============================================================

    /**
     * Parse 0xC8 - Outfit Window
     */
    parseOutfitWindow(msg) {
        const currentOutfit = Outfit.fromMessage(msg);
        const outfitCount = msg.readU8();
        const outfits = [];
        for (let i = 0; i < outfitCount; i++) {
            outfits.push({
                lookType: msg.readU16(),
                name: msg.readString(),
                addons: msg.readU8()
            });
        }
        return { currentOutfit, outfits };
    }

    // ============================================================
    // VIP
    // ============================================================

    /**
     * Parse 0xD2 - VIP Entry
     */
    parseVipEntry(msg) {
        const id = msg.readU32();
        const name = msg.readString();
        const online = msg.readU8() !== 0;
        return { id, name, online };
    }

    /**
     * Parse 0xD3 - VIP Login
     */
    parseVipLogin(msg) {
        const id = msg.readU32();
        return { id };
    }

    /**
     * Parse 0xD4 - VIP Logout
     */
    parseVipLogout(msg) {
        const id = msg.readU32();
        return { id };
    }

    // ============================================================
    // Tutorial / Map marker
    // ============================================================

    /**
     * Parse 0xDC - Tutorial Hint
     */
    parseTutorialHint(msg) {
        const hintId = msg.readU8();
        return { hintId };
    }

    /**
     * Parse 0xDD - Map Marker
     */
    parseMapMarker(msg) {
        const pos = this._readPosition(msg);
        const icon = msg.readU8();
        const description = msg.readString();
        return { position: pos, icon, description };
    }

    // ============================================================
    // Quests
    // ============================================================

    /**
     * Parse 0xF0 - Quest List
     */
    parseQuestList(msg) {
        const questCount = msg.readU16();
        const quests = [];
        for (let i = 0; i < questCount; i++) {
            quests.push({
                id: msg.readU16(),
                name: msg.readString(),
                completed: msg.readU8() !== 0
            });
        }
        return { quests };
    }

    /**
     * Parse 0xF1 - Quest Info
     */
    parseQuestInfo(msg) {
        const questId = msg.readU16();
        const missionCount = msg.readU8();
        const missions = [];
        for (let i = 0; i < missionCount; i++) {
            missions.push({
                name: msg.readString(),
                description: msg.readString()
            });
        }
        return { questId, missions };
    }

    // ============================================================
    // Extended Opcode (OTClient)
    // ============================================================

    /**
     * Parse 0x32 - Extended Opcode
     */
    parseExtendedOpcode(msg) {
        const opcode = msg.readU8();
        const data = msg.readString();
        return { opcode, data };
    }

    // ============================================================
    // Internal map parsing helpers
    // ============================================================

    /**
     * Read position from message
     * @private
     */
    _readPosition(msg) {
        return new Position(msg.readU16(), msg.readU16(), msg.readU8());
    }

    /**
     * Read a thing (item or creature) from message
     * @private
     */
    _readThing(msg) {
        const thingId = msg.readU16();

        if (thingId === CREATURE_UNKNOWN) { // 0x61
            return Creature.readUnknown(msg, this.game.knownCreatures);
        } else if (thingId === CREATURE_KNOWN) { // 0x62
            return Creature.readKnown(msg, this.game.knownCreatures);
        } else if (thingId === CREATURE_TURN) { // 0x63
            return Creature.readTurn(msg, this.game.knownCreatures);
        } else {
            // Regular item
            const item = new Item(thingId);
            if (this.game.datManager && this.game.datManager.hasExtraByte(thingId)) {
                item.count = msg.readU8();
            }
            // Apply DAT flags (walkability, ground speed, etc.)
            if (this.game.datManager) {
                item.applyDatFlags(this.game.datManager);
            }
            return item;
        }
    }

    /**
     * Read an item from message (always with count if applicable)
     * @private
     */
    _readItem(msg) {
        const id = msg.readU16();
        const item = new Item(id);
        if (this.game.datManager && this.game.datManager.hasExtraByte(id)) {
            item.count = msg.readU8();
        }
        // Apply DAT flags (walkability, ground speed, etc.)
        if (this.game.datManager) {
            item.applyDatFlags(this.game.datManager);
        }
        return item;
    }

    /**
     * Parse map description (multiple floors)
     * @private
     */
    _parseMapDescription(msg, startX, startY, z, width, height) {
        let skipTiles = 0;

        if (z <= SEA_FLOOR) {
            // Surface: floors from 7 down to 0
            for (let nz = SEA_FLOOR; nz >= 0; nz--) {
                skipTiles = this._parseFloorDescription(msg, startX, startY, nz, width, height, z - nz, skipTiles);
            }
        } else {
            // Underground: z-2 to z+2 (capped at 0 and 15)
            for (let nz = z - 2; nz <= z + 2 && nz <= MAP_MAX_Z; nz++) {
                skipTiles = this._parseFloorDescription(msg, startX, startY, nz, width, height, z - nz, skipTiles);
            }
        }
    }

    /**
     * Parse a single floor description
     * @private
     * @returns {number} Number of tiles to skip
     */
    _parseFloorDescription(msg, startX, startY, z, width, height, offset, skipTiles = 0) {
        for (let x = 0; x < width; x++) {
            for (let y = 0; y < height; y++) {
                if (skipTiles > 0) {
                    skipTiles--;
                    continue;
                }

                const tileX = startX + x + offset;
                const tileY = startY + y + offset;
                const pos = new Position(tileX, tileY, z);

                skipTiles = this._parseTileArea(msg, pos);
            }
        }
        return skipTiles;
    }

    /**
     * Parse tile area from message
     * @private
     * @returns {number} Number of tiles to skip after this one
     */
    _parseTileArea(msg, pos) {
        // Check for skip marker
        const peek = msg.peekU16();
        if (peek >= 0xFF00) {
            // Skip tiles
            msg.readU16();
            return (peek & 0xFF);
        }

        // Create/clear tile
        const tile = this.game.map.getOrCreateTile(pos);
        tile.clear();

        // Read things
        this._parseTileThings(msg, tile);

        // Check for skip after tile
        const nextPeek = msg.peekU16();
        if (nextPeek >= 0xFF00) {
            msg.readU16();
            return (nextPeek & 0xFF);
        }

        return 0;
    }

    /**
     * Parse things on a tile
     * @private
     */
    _parseTileThings(msg, tile) {
        for (let i = 0; i < TILE_MAX_THINGS; i++) {
            if (!msg.hasMore()) break;

            const peek = msg.peekU16();
            if (peek >= 0xFF00) {
                break; // End of tile / skip marker
            }

            const thing = this._readThing(msg);
            if (thing) {
                tile.addThing(thing);
            }
        }
    }
}

module.exports = GameParse;
