'use strict';

/**
 * Item - Represents a game item on the map, in inventory, or container
 * 
 * Items carry DAT flags when a DatManager with loaded data is available:
 * - isNotWalkable, isNotPathable: for pathfinding
 * - groundSpeed: for movement cost calculation
 * - isGround: whether this is a ground tile item
 * - isStackable, isFluidContainer, isSplash: for protocol parsing (extra byte)
 */

class Item {
    /**
     * @param {number} id - Client sprite ID
     * @param {number} [count=1] - Stack count / fluid type
     */
    constructor(id = 0, count = 1) {
        this.id = id;           // Client sprite ID (uint16)
        this.count = count;     // Stack count or subtype (fluid, charges)

        // DAT flags (set by applyDatFlags when DatManager is available)
        this.isNotWalkable = false;
        this.isNotPathable = false;
        this.isGround = false;
        this.groundSpeed = 0;
        this.isOnBottom = false;
        this.isOnTop = false;
        this.isBlockProjectile = false;
        this.hasElevation = false;
        this.elevation = 0;
    }

    /**
     * Apply flags from DatManager
     * @param {import('./DatManager')} datManager
     */
    applyDatFlags(datManager) {
        if (!datManager || !datManager.loaded) return;
        const flags = datManager.getItemFlags(this.id);
        if (!flags) return;

        this.isNotWalkable = flags.isNotWalkable || false;
        this.isNotPathable = flags.isNotPathable || false;
        this.isGround = flags.isGround || false;
        this.groundSpeed = flags.groundSpeed || 0;
        this.isOnBottom = flags.isOnBottom || false;
        this.isOnTop = flags.isOnTop || false;
        this.isBlockProjectile = flags.isBlockProjectile || false;
        this.hasElevation = flags.hasElevation || false;
        this.elevation = flags.elevation || 0;
    }

    /**
     * Clone this item
     * @returns {Item}
     */
    clone() {
        return new Item(this.id, this.count);
    }

    /**
     * Read item from network message (for 8.60 protocol)
     * Item format: uint16 id + optional uint8 count/subtype
     * 
     * Note: In 8.60, whether to read count depends on item properties.
     * Since we don't have DAT file loaded, we pass a flag.
     * 
     * @param {NetworkMessage} msg
     * @param {boolean} [hasExtra=false] - Whether this item has extra byte (stackable/fluid/splash)
     * @returns {Item}
     */
    static fromMessage(msg, hasExtra = false) {
        const item = new Item();
        item.id = msg.readU16();
        if (hasExtra) {
            item.count = msg.readU8();
        }
        return item;
    }

    /**
     * Read item with automatic count detection
     * In 8.60, items with id >= certain threshold or stackable items need count byte.
     * We use a simple heuristic or item database if available.
     * 
     * @param {NetworkMessage} msg
     * @param {Function} [isStackable] - Function(id) => bool, check if item is stackable
     * @returns {Item}
     */
    static fromMessageAuto(msg, isStackable) {
        const item = new Item();
        item.id = msg.readU16();

        if (isStackable && isStackable(item.id)) {
            item.count = msg.readU8();
        }

        return item;
    }

    /**
     * Write item to network message
     * @param {NetworkMessage} msg
     * @param {boolean} [writeCount=false]
     */
    writeToMessage(msg, writeCount = false) {
        msg.writeU16(this.id);
        if (writeCount) {
            msg.writeU8(this.count);
        }
    }

    toString() {
        return `Item(id=${this.id}, count=${this.count})`;
    }
}

module.exports = Item;
