'use strict';

const Tile = require('./Tile');
const Position = require('./Position');
const {
    MAP_MAX_Z,
    MAP_MIN_Z,
    MAP_AWARE_X,
    MAP_AWARE_Y,
    SEA_FLOOR,
    UNDERGROUND_FLOOR
} = require('../constants/GameConstants');

/**
 * Map - Manages the game world tiles
 * 
 * Stores tiles in a sparse hash map using position keys.
 * The visible area is 18x14 tiles centered on the player.
 */

class GameMap {
    constructor() {
        this.tiles = new Map();     // 'x:y:z' -> Tile
        this.description = '';      // Map description from server
    }

    /**
     * Get position key for map storage
     * @param {number} x
     * @param {number} y
     * @param {number} z
     * @returns {string}
     */
    _key(x, y, z) {
        return `${x}:${y}:${z}`;
    }

    /**
     * Get tile at position
     * @param {Position|{x:number,y:number,z:number}} pos
     * @returns {Tile|null}
     */
    getTile(pos) {
        return this.tiles.get(this._key(pos.x, pos.y, pos.z)) || null;
    }

    /**
     * Get or create tile at position
     * @param {Position|{x:number,y:number,z:number}} pos
     * @returns {Tile}
     */
    getOrCreateTile(pos) {
        const key = this._key(pos.x, pos.y, pos.z);
        let tile = this.tiles.get(key);
        if (!tile) {
            tile = new Tile(new Position(pos.x, pos.y, pos.z));
            this.tiles.set(key, tile);
        }
        return tile;
    }

    /**
     * Set tile at position
     * @param {Position} pos
     * @param {Tile} tile
     */
    setTile(pos, tile) {
        this.tiles.set(this._key(pos.x, pos.y, pos.z), tile);
    }

    /**
     * Remove tile at position
     * @param {Position} pos
     */
    removeTile(pos) {
        this.tiles.delete(this._key(pos.x, pos.y, pos.z));
    }

    /**
     * Clear tile at position
     * @param {Position} pos
     */
    clearTile(pos) {
        const tile = this.getTile(pos);
        if (tile) {
            tile.clear();
        }
    }

    /**
     * Clean tiles outside the visible area around a position
     * @param {Position} centerPos
     */
    cleanOutOfRange(centerPos) {
        const minX = centerPos.x - Math.floor(MAP_AWARE_X / 2) - 1;
        const maxX = centerPos.x + Math.ceil(MAP_AWARE_X / 2) + 1;
        const minY = centerPos.y - Math.floor(MAP_AWARE_Y / 2) - 1;
        const maxY = centerPos.y + Math.ceil(MAP_AWARE_Y / 2) + 1;

        for (const [key, tile] of this.tiles) {
            const pos = tile.position;
            if (pos.x < minX || pos.x > maxX || pos.y < minY || pos.y > maxY) {
                this.tiles.delete(key);
            }
        }
    }

    /**
     * Get visible Z range based on current Z position
     * @param {number} z - Current floor
     * @returns {{start: number, end: number}}
     */
    getVisibleFloors(z) {
        if (z <= SEA_FLOOR) {
            // Surface: show floors 7 down to 0
            return { start: SEA_FLOOR, end: MAP_MIN_Z };
        } else {
            // Underground: show current floor ±2
            return {
                start: Math.min(z + 2, MAP_MAX_Z),
                end: Math.max(z - 2, MAP_MIN_Z)
            };
        }
    }

    /**
     * Get total number of stored tiles
     * @returns {number}
     */
    get size() {
        return this.tiles.size;
    }

    /**
     * Clear entire map
     */
    clear() {
        this.tiles.clear();
    }
}

module.exports = GameMap;
