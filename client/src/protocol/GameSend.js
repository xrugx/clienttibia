'use strict';

/**
 * GameSend - Client → Server packet builders for Tibia 8.60
 * 
 * Each method builds a complete packet ready to be sent through the connection.
 * All packets start with the opcode byte, followed by opcode-specific data.
 */

const NetworkMessage = require('../network/NetworkMessage');
const { ClientOpcodes } = require('../constants/Opcodes');
const {
    PROTOCOL_VERSION,
    OS_OTCLIENT,
    PATH_EAST, PATH_NORTHEAST, PATH_NORTH, PATH_NORTHWEST,
    PATH_WEST, PATH_SOUTHWEST, PATH_SOUTH, PATH_SOUTHEAST
} = require('../constants/GameConstants');
const XTEA = require('../crypto/xtea');

class GameSend {
    /**
     * @param {Connection} connection - Network connection
     */
    constructor(connection) {
        this.connection = connection;
    }

    /**
     * Create a new outgoing message
     * @private
     * @returns {NetworkMessage}
     */
    _createMsg() {
        return NetworkMessage.createOutgoing();
    }

    /**
     * Send an encrypted message
     * @private
     * @param {NetworkMessage} msg
     * @returns {boolean} true if sent, false if connection was lost
     */
    _send(msg) {
        if (!this.connection || !this.connection.isConnected()) {
            return false;
        }
        try {
            this.connection.sendEncrypted(msg);
            return true;
        } catch (err) {
            return false;
        }
    }

    // ============================================================
    // Game Login (First Message)
    // ============================================================

    /**
     * Build game server login packet (first message, RSA encrypted)
     * @param {string} account - Account name
     * @param {string} characterName - Character name
     * @param {string} password - Password
     * @param {object} [challenge] - Server challenge {timestamp, random}
     * @returns {NetworkMessage}
     */
    buildGameLogin(account, characterName, password, challenge) {
        const msg = this._createMsg();

        // Opcode
        msg.writeU8(ClientOpcodes.GameServerRequest); // 0x0A

        // OS type - Send as Windows to match official client
        msg.writeU16(OS_OTCLIENT);

        // Protocol version
        msg.writeU16(PROTOCOL_VERSION);

        // Build RSA block
        const rsaBlock = Buffer.alloc(128);
        let pos = 0;

        // First byte must be 0x00
        rsaBlock[pos++] = 0x00;

        // XTEA key
        const xteaKey = XTEA.generateKey();
        for (let i = 0; i < 4; i++) {
            rsaBlock.writeUInt32LE(xteaKey[i], pos);
            pos += 4;
        }

        // Gamemaster flag (0 = no)
        rsaBlock[pos++] = 0x00;

        // Account name
        const accBuf = Buffer.from(account, 'latin1');
        rsaBlock.writeUInt16LE(accBuf.length, pos);
        pos += 2;
        accBuf.copy(rsaBlock, pos);
        pos += accBuf.length;

        // Character name
        const charBuf = Buffer.from(characterName, 'latin1');
        rsaBlock.writeUInt16LE(charBuf.length, pos);
        pos += 2;
        charBuf.copy(rsaBlock, pos);
        pos += charBuf.length;

        // Password
        const pwdBuf = Buffer.from(password, 'latin1');
        rsaBlock.writeUInt16LE(pwdBuf.length, pos);
        pos += 2;
        pwdBuf.copy(rsaBlock, pos);
        pos += pwdBuf.length;

        // Challenge data (if server sent challenge)
        if (challenge) {
            rsaBlock.writeUInt32LE(challenge.timestamp, pos);
            pos += 4;
            rsaBlock[pos++] = challenge.random;
        }

        // Fill rest with random bytes
        for (let i = pos; i < 128; i++) {
            rsaBlock[i] = Math.floor(Math.random() * 256);
        }

        // RSA encrypt
        const encrypted = this.connection.rsaEncrypt(rsaBlock);
        msg.writeBytes(encrypted);

        // Store XTEA key for enabling after send
        this._pendingXteaKey = xteaKey;

        return msg;
    }

    /**
     * Get the pending XTEA key (to enable after sending login)
     * @returns {number[]|null}
     */
    getPendingXteaKey() {
        return this._pendingXteaKey || null;
    }

    // ============================================================
    // Connection
    // ============================================================

    /**
     * 0x14 - Logout / Leave game
     */
    sendLogout() {
        const msg = this._createMsg();
        msg.writeU8(ClientOpcodes.LeaveGame);
        this._send(msg);
    }

    /**
     * 0x1E - Ping (keep-alive)
     */
    sendPing() {
        const msg = this._createMsg();
        msg.writeU8(ClientOpcodes.Ping);
        this._send(msg);
    }

    // ============================================================
    // Movement
    // ============================================================

    /**
     * 0x64 - Auto Walk with path
     * @param {number[]} path - Array of direction bytes
     */
    sendAutoWalk(path) {
        const msg = this._createMsg();
        msg.writeU8(ClientOpcodes.AutoWalk);
        msg.writeU8(path.length);
        for (const dir of path) {
            msg.writeU8(dir);
        }
        this._send(msg);
    }

    /** 0x65 - Walk North */
    sendWalkNorth() {
        const msg = this._createMsg();
        msg.writeU8(ClientOpcodes.WalkNorth);
        this._send(msg);
    }

    /** 0x66 - Walk East */
    sendWalkEast() {
        const msg = this._createMsg();
        msg.writeU8(ClientOpcodes.WalkEast);
        this._send(msg);
    }

    /** 0x67 - Walk South */
    sendWalkSouth() {
        const msg = this._createMsg();
        msg.writeU8(ClientOpcodes.WalkSouth);
        this._send(msg);
    }

    /** 0x68 - Walk West */
    sendWalkWest() {
        const msg = this._createMsg();
        msg.writeU8(ClientOpcodes.WalkWest);
        this._send(msg);
    }

    /** 0x69 - Stop Auto Walk */
    sendStopAutoWalk() {
        const msg = this._createMsg();
        msg.writeU8(ClientOpcodes.StopAutoWalk);
        this._send(msg);
    }

    /** 0x6A - Walk NE */
    sendWalkNorthEast() {
        const msg = this._createMsg();
        msg.writeU8(ClientOpcodes.WalkNorthEast);
        this._send(msg);
    }

    /** 0x6B - Walk SE */
    sendWalkSouthEast() {
        const msg = this._createMsg();
        msg.writeU8(ClientOpcodes.WalkSouthEast);
        this._send(msg);
    }

    /** 0x6C - Walk SW */
    sendWalkSouthWest() {
        const msg = this._createMsg();
        msg.writeU8(ClientOpcodes.WalkSouthWest);
        this._send(msg);
    }

    /** 0x6D - Walk NW */
    sendWalkNorthWest() {
        const msg = this._createMsg();
        msg.writeU8(ClientOpcodes.WalkNorthWest);
        this._send(msg);
    }

    // ============================================================
    // Turning
    // ============================================================

    /** 0x6F - Turn North */
    sendTurnNorth() {
        const msg = this._createMsg();
        msg.writeU8(ClientOpcodes.TurnNorth);
        this._send(msg);
    }

    /** 0x70 - Turn East */
    sendTurnEast() {
        const msg = this._createMsg();
        msg.writeU8(ClientOpcodes.TurnEast);
        this._send(msg);
    }

    /** 0x71 - Turn South */
    sendTurnSouth() {
        const msg = this._createMsg();
        msg.writeU8(ClientOpcodes.TurnSouth);
        this._send(msg);
    }

    /** 0x72 - Turn West */
    sendTurnWest() {
        const msg = this._createMsg();
        msg.writeU8(ClientOpcodes.TurnWest);
        this._send(msg);
    }

    // ============================================================
    // Item interaction
    // ============================================================

    /**
     * 0x78 - Move / Throw item
     * @param {{x:number,y:number,z:number}} fromPos - Source position
     * @param {number} fromSpriteId - Client sprite ID of item
     * @param {number} fromStackPos - Stack position at source
     * @param {{x:number,y:number,z:number}} toPos - Destination position
     * @param {number} count - Number of items to move
     */
    sendMoveItem(fromPos, fromSpriteId, fromStackPos, toPos, count) {
        const msg = this._createMsg();
        msg.writeU8(ClientOpcodes.MoveItem);
        msg.writePosition(fromPos);
        msg.writeU16(fromSpriteId);
        msg.writeU8(fromStackPos);
        msg.writePosition(toPos);
        msg.writeU8(count);
        this._send(msg);
    }

    /**
     * 0x79 - Look in Shop
     * @param {number} spriteId
     * @param {number} count
     */
    sendLookInShop(spriteId, count) {
        const msg = this._createMsg();
        msg.writeU8(ClientOpcodes.LookInShop);
        msg.writeU16(spriteId);
        msg.writeU8(count);
        this._send(msg);
    }

    /**
     * 0x7A - Buy from NPC
     * @param {number} spriteId
     * @param {number} count
     * @param {number} amount
     * @param {boolean} ignoreCapacity
     * @param {boolean} buyWithBackpack
     */
    sendBuy(spriteId, count, amount, ignoreCapacity = false, buyWithBackpack = false) {
        const msg = this._createMsg();
        msg.writeU8(ClientOpcodes.PlayerPurchase);
        msg.writeU16(spriteId);
        msg.writeU8(count);
        msg.writeU8(amount);
        msg.writeU8(ignoreCapacity ? 1 : 0);
        msg.writeU8(buyWithBackpack ? 1 : 0);
        this._send(msg);
    }

    /**
     * 0x7B - Sell to NPC
     * @param {number} spriteId
     * @param {number} count
     * @param {number} amount
     */
    sendSell(spriteId, count, amount) {
        const msg = this._createMsg();
        msg.writeU8(ClientOpcodes.PlayerSale);
        msg.writeU16(spriteId);
        msg.writeU8(count);
        msg.writeU8(amount);
        this._send(msg);
    }

    /**
     * 0x7C - Close NPC Shop
     */
    sendCloseShop() {
        const msg = this._createMsg();
        msg.writeU8(ClientOpcodes.CloseShop);
        this._send(msg);
    }

    // ============================================================
    // Player Trade
    // ============================================================

    /**
     * 0x7D - Request Trade
     * @param {{x:number,y:number,z:number}} pos
     * @param {number} spriteId
     * @param {number} stackPos
     * @param {number} creatureId
     */
    sendRequestTrade(pos, spriteId, stackPos, creatureId) {
        const msg = this._createMsg();
        msg.writeU8(ClientOpcodes.RequestTrade);
        msg.writePosition(pos);
        msg.writeU16(spriteId);
        msg.writeU8(stackPos);
        msg.writeU32(creatureId);
        this._send(msg);
    }

    /**
     * 0x7E - Look in Trade
     * @param {boolean} counterOffer - true = look at counter offer
     * @param {number} index - Item index
     */
    sendLookInTrade(counterOffer, index) {
        const msg = this._createMsg();
        msg.writeU8(ClientOpcodes.LookInTrade);
        msg.writeU8(counterOffer ? 1 : 0);
        msg.writeU8(index);
        this._send(msg);
    }

    /**
     * 0x7F - Accept Trade
     */
    sendAcceptTrade() {
        const msg = this._createMsg();
        msg.writeU8(ClientOpcodes.AcceptTrade);
        this._send(msg);
    }

    /**
     * 0x80 - Close/Reject Trade
     */
    sendCloseTrade() {
        const msg = this._createMsg();
        msg.writeU8(ClientOpcodes.CloseTrade);
        this._send(msg);
    }

    // ============================================================
    // Item Usage
    // ============================================================

    /**
     * 0x82 - Use Item
     * @param {{x:number,y:number,z:number}} pos
     * @param {number} spriteId
     * @param {number} stackPos
     * @param {number} index - Container index or 0
     */
    sendUseItem(pos, spriteId, stackPos, index = 0) {
        const msg = this._createMsg();
        msg.writeU8(ClientOpcodes.UseItem);
        msg.writePosition(pos);
        msg.writeU16(spriteId);
        msg.writeU8(stackPos);
        msg.writeU8(index);
        this._send(msg);
    }

    /**
     * 0x83 - Use Item Extended (use on target)
     * @param {{x:number,y:number,z:number}} fromPos
     * @param {number} fromSpriteId
     * @param {number} fromStackPos
     * @param {{x:number,y:number,z:number}} toPos
     * @param {number} toSpriteId
     * @param {number} toStackPos
     */
    sendUseItemEx(fromPos, fromSpriteId, fromStackPos, toPos, toSpriteId, toStackPos) {
        const msg = this._createMsg();
        msg.writeU8(ClientOpcodes.UseItemEx);
        msg.writePosition(fromPos);
        msg.writeU16(fromSpriteId);
        msg.writeU8(fromStackPos);
        msg.writePosition(toPos);
        msg.writeU16(toSpriteId);
        msg.writeU8(toStackPos);
        this._send(msg);
    }

    /**
     * 0x84 - Use on Creature (battle window)
     * @param {{x:number,y:number,z:number}} pos
     * @param {number} spriteId
     * @param {number} stackPos
     * @param {number} creatureId
     */
    sendUseOnCreature(pos, spriteId, stackPos, creatureId) {
        const msg = this._createMsg();
        msg.writeU8(ClientOpcodes.UseOnCreature);
        msg.writePosition(pos);
        msg.writeU16(spriteId);
        msg.writeU8(stackPos);
        msg.writeU32(creatureId);
        this._send(msg);
    }

    /**
     * 0x85 - Rotate Item
     * @param {{x:number,y:number,z:number}} pos
     * @param {number} spriteId
     * @param {number} stackPos
     */
    sendRotateItem(pos, spriteId, stackPos) {
        const msg = this._createMsg();
        msg.writeU8(ClientOpcodes.RotateItem);
        msg.writePosition(pos);
        msg.writeU16(spriteId);
        msg.writeU8(stackPos);
        this._send(msg);
    }

    // ============================================================
    // Containers
    // ============================================================

    /**
     * 0x87 - Close Container
     * @param {number} containerId
     */
    sendCloseContainer(containerId) {
        const msg = this._createMsg();
        msg.writeU8(ClientOpcodes.CloseContainer);
        msg.writeU8(containerId);
        this._send(msg);
    }

    /**
     * 0x88 - Up Container (go to parent)
     * @param {number} containerId
     */
    sendUpContainer(containerId) {
        const msg = this._createMsg();
        msg.writeU8(ClientOpcodes.UpContainer);
        msg.writeU8(containerId);
        this._send(msg);
    }

    // ============================================================
    // Text editing
    // ============================================================

    /**
     * 0x89 - Edit Text (writable item)
     * @param {number} windowId
     * @param {string} text
     */
    sendEditText(windowId, text) {
        const msg = this._createMsg();
        msg.writeU8(ClientOpcodes.EditText);
        msg.writeU32(windowId);
        msg.writeString(text);
        this._send(msg);
    }

    /**
     * 0x8A - Edit House Text
     * @param {number} doorId
     * @param {number} windowId
     * @param {string} text
     */
    sendEditHouseText(doorId, windowId, text) {
        const msg = this._createMsg();
        msg.writeU8(ClientOpcodes.EditHouseText);
        msg.writeU8(doorId);
        msg.writeU32(windowId);
        msg.writeString(text);
        this._send(msg);
    }

    // ============================================================
    // Looking
    // ============================================================

    /**
     * 0x8C - Look at position
     * @param {{x:number,y:number,z:number}} pos
     * @param {number} spriteId
     * @param {number} stackPos
     */
    sendLook(pos, spriteId, stackPos) {
        const msg = this._createMsg();
        msg.writeU8(ClientOpcodes.Look);
        msg.writePosition(pos);
        msg.writeU16(spriteId);
        msg.writeU8(stackPos);
        this._send(msg);
    }

    /**
     * 0x8D - Look at creature in battle list
     * @param {number} creatureId
     */
    sendLookCreature(creatureId) {
        const msg = this._createMsg();
        msg.writeU8(ClientOpcodes.LookCreature);
        msg.writeU32(creatureId);
        this._send(msg);
    }

    // ============================================================
    // Chat
    // ============================================================

    /**
     * 0x96 - Say / chat message
     * @param {number} type - Speech type
     * @param {string} message - Message text
     * @param {string} [receiver] - Private message receiver name
     * @param {number} [channelId] - Channel ID
     */
    sendSay(type, message, receiver, channelId) {
        const msg = this._createMsg();
        msg.writeU8(ClientOpcodes.Say);
        msg.writeU8(type);

        switch (type) {
            case 6:  // Private
            case 14: // GM Private
                msg.writeString(receiver || '');
                break;
            case 7:  // Channel Y
            case 8:  // Channel W
            case 13: // Channel R1
            case 15: // Channel O
            case 16: // Channel R2
                msg.writeU16(channelId || 0);
                break;
        }

        msg.writeString(message);
        this._send(msg);
    }

    /**
     * 0x97 - Get Channel List
     */
    sendGetChannels() {
        const msg = this._createMsg();
        msg.writeU8(ClientOpcodes.GetChannels);
        this._send(msg);
    }

    /**
     * 0x98 - Open Channel
     * @param {number} channelId
     */
    sendOpenChannel(channelId) {
        const msg = this._createMsg();
        msg.writeU8(ClientOpcodes.OpenChannel);
        msg.writeU16(channelId);
        this._send(msg);
    }

    /**
     * 0x99 - Close Channel
     * @param {number} channelId
     */
    sendCloseChannel(channelId) {
        const msg = this._createMsg();
        msg.writeU8(ClientOpcodes.CloseChannel);
        msg.writeU16(channelId);
        this._send(msg);
    }

    /**
     * 0x9A - Open Private Channel
     * @param {string} name - Player name
     */
    sendOpenPrivateChannel(name) {
        const msg = this._createMsg();
        msg.writeU8(ClientOpcodes.OpenPrivateChannel);
        msg.writeString(name);
        this._send(msg);
    }

    /**
     * 0x9E - Close NPC Channel
     */
    sendCloseNPCChannel() {
        const msg = this._createMsg();
        msg.writeU8(ClientOpcodes.CloseNPCChannel);
        this._send(msg);
    }

    // ============================================================
    // Combat
    // ============================================================

    /**
     * 0xA0 - Change Fight Modes
     * @param {number} fightMode - 1=attack, 2=balanced, 3=defense
     * @param {number} chaseMode - 0=stand, 1=chase
     * @param {number} secureMode - 0=off, 1=on
     */
    sendChangeFightModes(fightMode, chaseMode, secureMode) {
        const msg = this._createMsg();
        msg.writeU8(ClientOpcodes.ChangeFightModes);
        msg.writeU8(fightMode);
        msg.writeU8(chaseMode);
        msg.writeU8(secureMode);
        this._send(msg);
    }

    /**
     * 0xA1 - Attack creature
     * @param {number} creatureId - Creature ID (0 to cancel)
     */
    sendAttack(creatureId) {
        const msg = this._createMsg();
        msg.writeU8(ClientOpcodes.Attack);
        msg.writeU32(creatureId);
        this._send(msg);
    }

    /**
     * 0xA2 - Follow creature
     * @param {number} creatureId - Creature ID (0 to cancel)
     */
    sendFollow(creatureId) {
        const msg = this._createMsg();
        msg.writeU8(ClientOpcodes.Follow);
        msg.writeU32(creatureId);
        this._send(msg);
    }

    // ============================================================
    // Party
    // ============================================================

    /**
     * 0xA3 - Invite to Party
     * @param {number} creatureId
     */
    sendInviteToParty(creatureId) {
        const msg = this._createMsg();
        msg.writeU8(ClientOpcodes.InviteToParty);
        msg.writeU32(creatureId);
        this._send(msg);
    }

    /**
     * 0xA4 - Join Party
     * @param {number} creatureId
     */
    sendJoinParty(creatureId) {
        const msg = this._createMsg();
        msg.writeU8(ClientOpcodes.JoinParty);
        msg.writeU32(creatureId);
        this._send(msg);
    }

    /**
     * 0xA5 - Revoke Party Invite
     * @param {number} creatureId
     */
    sendRevokePartyInvite(creatureId) {
        const msg = this._createMsg();
        msg.writeU8(ClientOpcodes.RevokePartyInvite);
        msg.writeU32(creatureId);
        this._send(msg);
    }

    /**
     * 0xA6 - Pass Party Leadership
     * @param {number} creatureId
     */
    sendPassPartyLeadership(creatureId) {
        const msg = this._createMsg();
        msg.writeU8(ClientOpcodes.PassPartyLeadership);
        msg.writeU32(creatureId);
        this._send(msg);
    }

    /**
     * 0xA7 - Leave Party
     */
    sendLeaveParty() {
        const msg = this._createMsg();
        msg.writeU8(ClientOpcodes.LeaveParty);
        this._send(msg);
    }

    /**
     * 0xA8 - Share Party Experience
     * @param {boolean} active
     */
    sendSharePartyExperience(active) {
        const msg = this._createMsg();
        msg.writeU8(ClientOpcodes.SharePartyExperience);
        msg.writeU8(active ? 1 : 0);
        this._send(msg);
    }

    // ============================================================
    // Cancel / Stop
    // ============================================================

    /**
     * 0xBE - Cancel Attack and Follow
     */
    sendCancelAttackAndFollow() {
        const msg = this._createMsg();
        msg.writeU8(ClientOpcodes.CancelAttackAndFollow);
        this._send(msg);
    }

    // ============================================================
    // Outfits
    // ============================================================

    /**
     * 0xD2 - Request Outfit Dialog
     */
    sendRequestOutfit() {
        const msg = this._createMsg();
        msg.writeU8(ClientOpcodes.RequestOutfit);
        this._send(msg);
    }

    /**
     * 0xD3 - Set Outfit
     * @param {object} outfit - {lookType, lookHead, lookBody, lookLegs, lookFeet, lookAddons}
     */
    sendSetOutfit(outfit) {
        const msg = this._createMsg();
        msg.writeU8(ClientOpcodes.SetOutfit);
        msg.writeU16(outfit.lookType);
        msg.writeU8(outfit.lookHead);
        msg.writeU8(outfit.lookBody);
        msg.writeU8(outfit.lookLegs);
        msg.writeU8(outfit.lookFeet);
        msg.writeU8(outfit.lookAddons);
        this._send(msg);
    }

    // ============================================================
    // VIP
    // ============================================================

    /**
     * 0xDC - Add VIP
     * @param {string} name - Player name
     */
    sendAddVip(name) {
        const msg = this._createMsg();
        msg.writeU8(ClientOpcodes.AddVip);
        msg.writeString(name);
        this._send(msg);
    }

    /**
     * 0xDD - Remove VIP
     * @param {number} playerId
     */
    sendRemoveVip(playerId) {
        const msg = this._createMsg();
        msg.writeU8(ClientOpcodes.RemoveVip);
        msg.writeU32(playerId);
        this._send(msg);
    }

    // ============================================================
    // Quests
    // ============================================================

    /**
     * 0xF0 - Request Quest Log
     */
    sendRequestQuests() {
        const msg = this._createMsg();
        msg.writeU8(ClientOpcodes.RequestQuests);
        this._send(msg);
    }

    /**
     * 0xF1 - Request Quest Info
     * @param {number} questId
     */
    sendRequestQuestInfo(questId) {
        const msg = this._createMsg();
        msg.writeU8(ClientOpcodes.RequestQuestInfo);
        msg.writeU16(questId);
        this._send(msg);
    }

    // ============================================================
    // Reports
    // ============================================================

    /**
     * 0xE6 - Bug Report
     * @param {string} message
     */
    sendBugReport(message) {
        const msg = this._createMsg();
        msg.writeU8(ClientOpcodes.BugReport);
        msg.writeString(message);
        this._send(msg);
    }

    // ============================================================
    // Extended Opcode (OTClient)
    // ============================================================

    /**
     * 0x32 - Extended Opcode
     * @param {number} opcode - Sub-opcode
     * @param {string} data - Data payload
     */
    sendExtendedOpcode(opcode, data) {
        const msg = this._createMsg();
        msg.writeU8(ClientOpcodes.ExtendedOpcode);
        msg.writeU8(opcode);
        msg.writeString(data);
        this._send(msg);
    }

    // ============================================================
    // Refresh requests
    // ============================================================

    /**
     * 0xC9 - Request Tile Update
     * @param {{x:number,y:number,z:number}} pos
     */
    sendUpdateTile(pos) {
        const msg = this._createMsg();
        msg.writeU8(ClientOpcodes.UpdateTile);
        msg.writePosition(pos);
        this._send(msg);
    }

    /**
     * 0xCA - Request Container Update
     * @param {number} containerId
     */
    sendUpdateContainer(containerId) {
        const msg = this._createMsg();
        msg.writeU8(ClientOpcodes.UpdateContainer);
        msg.writeU8(containerId);
        this._send(msg);
    }

    // ============================================================
    // Private channel management
    // ============================================================

    /**
     * 0xAA - Create Private Channel
     */
    sendCreatePrivateChannel() {
        const msg = this._createMsg();
        msg.writeU8(ClientOpcodes.CreatePrivateChannel);
        this._send(msg);
    }

    /**
     * 0xAB - Channel Invite
     * @param {string} name
     */
    sendChannelInvite(name) {
        const msg = this._createMsg();
        msg.writeU8(ClientOpcodes.ChannelInvite);
        msg.writeString(name);
        this._send(msg);
    }

    /**
     * 0xAC - Channel Exclude
     * @param {string} name
     */
    sendChannelExclude(name) {
        const msg = this._createMsg();
        msg.writeU8(ClientOpcodes.ChannelExclude);
        msg.writeString(name);
        this._send(msg);
    }

    // ============================================================
    // Rule violations
    // ============================================================

    /**
     * 0x9B - Process Rule Violation
     * @param {string} name
     */
    sendProcessRuleViolation(name) {
        const msg = this._createMsg();
        msg.writeU8(ClientOpcodes.ProcessRuleViolation);
        msg.writeString(name);
        this._send(msg);
    }

    /**
     * 0x9C - Close Rule Violation
     * @param {string} name
     */
    sendCloseRuleViolation(name) {
        const msg = this._createMsg();
        msg.writeU8(ClientOpcodes.CloseRuleViolation);
        msg.writeString(name);
        this._send(msg);
    }

    /**
     * 0x9D - Cancel Rule Violation
     */
    sendCancelRuleViolation() {
        const msg = this._createMsg();
        msg.writeU8(ClientOpcodes.CancelRuleViolation);
        this._send(msg);
    }
}

module.exports = GameSend;
