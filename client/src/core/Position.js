'use strict';

/**
 * Position - Represents a 3D position in the game world
 */

class Position {
    /**
     * @param {number} x
     * @param {number} y
     * @param {number} z
     */
    constructor(x = 0, y = 0, z = 0) {
        this.x = x;
        this.y = y;
        this.z = z;
    }

    /**
     * Check if this is a valid map position
     * @returns {boolean}
     */
    isValid() {
        return this.x >= 0 && this.x <= 0xFFFF &&
               this.y >= 0 && this.y <= 0xFFFF &&
               this.z >= 0 && this.z <= 15;
    }

    /**
     * Check if this is an inventory/container position (0xFFFF)
     * @returns {boolean}
     */
    isInventory() {
        return this.x === 0xFFFF;
    }

    /**
     * Get distance to another position
     * @param {Position} other
     * @returns {number}
     */
    distanceTo(other) {
        return Math.max(
            Math.abs(this.x - other.x),
            Math.abs(this.y - other.y)
        );
    }

    /**
     * Check equality
     * @param {Position} other
     * @returns {boolean}
     */
    equals(other) {
        return this.x === other.x && this.y === other.y && this.z === other.z;
    }

    /**
     * Get translated position
     * @param {number} dx
     * @param {number} dy
     * @param {number} dz
     * @returns {Position}
     */
    translated(dx, dy, dz = 0) {
        return new Position(this.x + dx, this.y + dy, this.z + dz);
    }

    /**
     * Clone this position
     * @returns {Position}
     */
    clone() {
        return new Position(this.x, this.y, this.z);
    }

    toString() {
        return `(${this.x}, ${this.y}, ${this.z})`;
    }

    /**
     * Create position from object
     * @param {{x: number, y: number, z: number}} obj
     * @returns {Position}
     */
    static from(obj) {
        return new Position(obj.x, obj.y, obj.z);
    }
}

module.exports = Position;
