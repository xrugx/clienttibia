'use strict';

/**
 * Outfit - Represents a creature's visual appearance
 */

class Outfit {
    constructor() {
        this.lookType = 0;      // Outfit type ID
        this.lookTypeEx = 0;    // Item type ID (if lookType = 0)
        this.lookHead = 0;      // Head color
        this.lookBody = 0;      // Body color
        this.lookLegs = 0;      // Legs color
        this.lookFeet = 0;      // Feet color
        this.lookAddons = 0;    // Addons bitmask
    }

    /**
     * Check if this is an item disguise
     * @returns {boolean}
     */
    isItem() {
        return this.lookType === 0 && this.lookTypeEx !== 0;
    }

    /**
     * Check if invisible
     * @returns {boolean}
     */
    isInvisible() {
        return this.lookType === 0 && this.lookTypeEx === 0;
    }

    /**
     * Clone this outfit
     * @returns {Outfit}
     */
    clone() {
        const o = new Outfit();
        o.lookType = this.lookType;
        o.lookTypeEx = this.lookTypeEx;
        o.lookHead = this.lookHead;
        o.lookBody = this.lookBody;
        o.lookLegs = this.lookLegs;
        o.lookFeet = this.lookFeet;
        o.lookAddons = this.lookAddons;
        return o;
    }

    /**
     * Read outfit from network message
     * @param {NetworkMessage} msg
     * @returns {Outfit}
     */
    static fromMessage(msg) {
        const outfit = new Outfit();
        outfit.lookType = msg.readU16();

        if (outfit.lookType !== 0) {
            outfit.lookHead = msg.readU8();
            outfit.lookBody = msg.readU8();
            outfit.lookLegs = msg.readU8();
            outfit.lookFeet = msg.readU8();
            outfit.lookAddons = msg.readU8();
        } else {
            outfit.lookTypeEx = msg.readU16();
        }

        return outfit;
    }

    /**
     * Write outfit to network message
     * @param {NetworkMessage} msg
     */
    writeToMessage(msg) {
        msg.writeU16(this.lookType);

        if (this.lookType !== 0) {
            msg.writeU8(this.lookHead);
            msg.writeU8(this.lookBody);
            msg.writeU8(this.lookLegs);
            msg.writeU8(this.lookFeet);
            msg.writeU8(this.lookAddons);
        } else {
            msg.writeU16(this.lookTypeEx);
        }
    }

    toString() {
        if (this.lookType !== 0) {
            return `Outfit(type=${this.lookType}, head=${this.lookHead}, body=${this.lookBody}, legs=${this.lookLegs}, feet=${this.lookFeet}, addons=${this.lookAddons})`;
        }
        if (this.lookTypeEx !== 0) {
            return `Outfit(item=${this.lookTypeEx})`;
        }
        return 'Outfit(invisible)';
    }
}

module.exports = Outfit;
