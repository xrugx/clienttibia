'use strict';

const Outfit = require('./Outfit');
const Position = require('./Position');
const {
    DIRECTION_SOUTH,
    SKULL_NONE,
    SHIELD_NONE
} = require('../constants/GameConstants');

/**
 * Creature - Represents any creature in the game (player, monster, NPC)
 */

class Creature {
    /**
     * @param {number} id - Creature ID
     */
    constructor(id = 0) {
        this.id = id;                           // Creature ID (uint32)
        this.name = '';                         // Name
        this.healthPercent = 100;               // Health 0-100
        this.direction = DIRECTION_SOUTH;       // Facing direction
        this.outfit = new Outfit();             // Visual appearance
        this.lightLevel = 0;                    // Light emission level
        this.lightColor = 0;                    // Light color
        this.speed = 0;                         // Movement speed
        this.skull = SKULL_NONE;                // Skull type
        this.shield = SHIELD_NONE;              // Party shield
        this.emblem = 0;                        // Guild emblem
        this.impassable = false;                // Cannot walk through
        this.position = new Position();         // Current position
        this.isKnown = false;                   // Whether creature was previously seen
        this.type = 'creature';                 // 'creature', 'player', 'npc', 'monster'
    }

    /**
     * Check if creature is dead
     * @returns {boolean}
     */
    isDead() {
        return this.healthPercent <= 0;
    }

    /**
     * Check if this is the local player
     * @param {number} localPlayerId
     * @returns {boolean}
     */
    isLocalPlayer(localPlayerId) {
        return this.id === localPlayerId;
    }

    /**
     * Update creature data from known creature packet
     * @param {object} data
     */
    update(data) {
        if (data.healthPercent !== undefined) this.healthPercent = data.healthPercent;
        if (data.direction !== undefined) this.direction = data.direction;
        if (data.outfit) this.outfit = data.outfit;
        if (data.lightLevel !== undefined) this.lightLevel = data.lightLevel;
        if (data.lightColor !== undefined) this.lightColor = data.lightColor;
        if (data.speed !== undefined) this.speed = data.speed;
        if (data.skull !== undefined) this.skull = data.skull;
        if (data.shield !== undefined) this.shield = data.shield;
        if (data.impassable !== undefined) this.impassable = data.impassable;
        if (data.position) this.position = data.position;
    }

    /**
     * Read unknown creature (0x61) from network message
     * Full creature data for a creature seen for the first time
     * 
     * @param {NetworkMessage} msg
     * @param {Map<number, Creature>} knownCreatures - Known creatures map
     * @returns {Creature}
     */
    static readUnknown(msg, knownCreatures) {
        const removeId = msg.readU32();
        const creatureId = msg.readU32();
        const name = msg.readString();

        // Remove old creature if needed
        if (removeId !== 0 && knownCreatures) {
            knownCreatures.delete(removeId);
        }

        let creature = knownCreatures ? knownCreatures.get(creatureId) : null;
        if (!creature) {
            creature = new Creature(creatureId);
        }

        creature.id = creatureId;
        creature.name = name;
        creature.isKnown = true;
        creature.healthPercent = msg.readU8();
        creature.direction = msg.readU8();
        creature.outfit = Outfit.fromMessage(msg);
        creature.lightLevel = msg.readU8();
        creature.lightColor = msg.readU8();
        creature.speed = msg.readU16();
        creature.skull = msg.readU8();
        creature.shield = msg.readU8();
        creature.emblem = msg.readU8();   // Only for unknown creatures
        creature.impassable = msg.readU8() !== 0;

        if (knownCreatures) {
            knownCreatures.set(creatureId, creature);
        }

        return creature;
    }

    /**
     * Read known creature (0x62) from network message
     * Update data for a creature we've seen before
     * 
     * @param {NetworkMessage} msg
     * @param {Map<number, Creature>} knownCreatures
     * @returns {Creature}
     */
    static readKnown(msg, knownCreatures) {
        const creatureId = msg.readU32();

        let creature = knownCreatures ? knownCreatures.get(creatureId) : null;
        if (!creature) {
            creature = new Creature(creatureId);
            creature.isKnown = true;
        }

        creature.healthPercent = msg.readU8();
        creature.direction = msg.readU8();
        creature.outfit = Outfit.fromMessage(msg);
        creature.lightLevel = msg.readU8();
        creature.lightColor = msg.readU8();
        creature.speed = msg.readU16();
        creature.skull = msg.readU8();
        creature.shield = msg.readU8();
        creature.impassable = msg.readU8() !== 0;

        if (knownCreatures) {
            knownCreatures.set(creatureId, creature);
        }

        return creature;
    }

    /**
     * Read creature turn (0x63) from network message
     * Only direction update
     * 
     * @param {NetworkMessage} msg
     * @param {Map<number, Creature>} knownCreatures
     * @returns {Creature|null}
     */
    static readTurn(msg, knownCreatures) {
        const creatureId = msg.readU32();
        const direction = msg.readU8();

        let creature = knownCreatures ? knownCreatures.get(creatureId) : null;
        if (creature) {
            creature.direction = direction;
        }

        return creature;
    }

    toString() {
        return `Creature(id=${this.id}, name="${this.name}", hp=${this.healthPercent}%, pos=${this.position})`;
    }
}

module.exports = Creature;
