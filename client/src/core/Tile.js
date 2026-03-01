'use strict';

const Position = require('./Position');

/**
 * Tile - Represents a single map tile containing items and creatures
 */

class Tile {
    /**
     * @param {Position} position
     */
    constructor(position) {
        this.position = position ? position.clone() : new Position();
        this.things = [];       // Array of Items and Creatures (max 10)
        this.ground = null;     // Ground item (first item)
    }

    /**
     * Add a thing (item or creature) to this tile
     * @param {object} thing - Item or Creature
     * @param {number} [stackPos=-1] - Stack position (-1 = top)
     */
    addThing(thing, stackPos = -1) {
        if (stackPos < 0 || stackPos >= this.things.length) {
            this.things.push(thing);
        } else {
            this.things.splice(stackPos, 0, thing);
        }

        // First item is ground
        if (this.things.length > 0 && !this.ground) {
            this.ground = this.things[0];
        }
    }

    /**
     * Update thing at stack position
     * @param {number} stackPos
     * @param {object} thing
     */
    updateThing(stackPos, thing) {
        if (stackPos >= 0 && stackPos < this.things.length) {
            this.things[stackPos] = thing;
            if (stackPos === 0) {
                this.ground = thing;
            }
        }
    }

    /**
     * Remove thing at stack position
     * @param {number} stackPos
     * @returns {object|null} Removed thing
     */
    removeThing(stackPos) {
        if (stackPos >= 0 && stackPos < this.things.length) {
            const removed = this.things.splice(stackPos, 1)[0];
            if (stackPos === 0) {
                this.ground = this.things.length > 0 ? this.things[0] : null;
            }
            return removed;
        }
        return null;
    }

    /**
     * Get thing at stack position
     * @param {number} stackPos
     * @returns {object|null}
     */
    getThing(stackPos) {
        return this.things[stackPos] || null;
    }

    /**
     * Get number of things on this tile
     * @returns {number}
     */
    getThingCount() {
        return this.things.length;
    }

    /**
     * Clear all things from tile
     */
    clear() {
        this.things = [];
        this.ground = null;
    }

    /**
     * Find a creature on this tile by ID
     * @param {number} creatureId
     * @returns {object|null}
     */
    getCreatureById(creatureId) {
        return this.things.find(t => t.id === creatureId && t.constructor.name === 'Creature') || null;
    }

    toString() {
        return `Tile(${this.position}, things=${this.things.length})`;
    }
}

module.exports = Tile;
