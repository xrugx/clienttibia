'use strict';

/**
 * DatManager - Manages item/creature type information from Tibia .dat file
 * 
 * Stores per-item flags parsed from the binary .dat file:
 * - Whether items have an extra byte (stackable, fluid, splash)
 * - Walkability/pathability flags for pathfinding
 * - Ground speed for movement cost calculation
 * - Light, elevation, minimap color, etc.
 * 
 * Loaded at startup via loadFromDat() or loadFromParsed().
 */

class DatManager {
    constructor() {
        // Per-item flags: itemId → { isGround, groundSpeed, isStackable, isFluidContainer,
        //   isSplash, isNotWalkable, isNotPathable, isOnBottom, isOnTop, ... }
        this.itemFlags = new Map();

        // Fast lookup sets for hot-path checks
        this.itemsWithExtra = new Set();    // stackable + fluid + splash
        this.stackableItems = new Set();
        this.fluidItems = new Set();
        this.splashItems = new Set();

        // Whether data has been loaded
        this.loaded = false;
    }

    /**
     * Load item flags from a parsed DAT result (from DatParser)
     * @param {Map<number, object>} items - Map of itemId → flags object from DatParser
     */
    loadFromParsed(items) {
        for (const [id, flags] of items) {
            this.itemFlags.set(id, flags);

            if (flags.isStackable) {
                this.stackableItems.add(id);
                this.itemsWithExtra.add(id);
            }
            if (flags.isFluidContainer) {
                this.fluidItems.add(id);
                this.itemsWithExtra.add(id);
            }
            if (flags.isSplash) {
                this.splashItems.add(id);
                this.itemsWithExtra.add(id);
            }
        }
        this.loaded = true;
    }

    /**
     * Load item flags directly from the .dat file
     * @param {string} datPath - Path to decrypted Tibia.dat file
     */
    loadFromDat(datPath) {
        const DatParser = require('./DatParser');
        const result = DatParser.parseFile(datPath);
        this.loadFromParsed(result.items);
        return result;
    }

    /**
     * Check if an item needs extra byte (count/subtype)
     * @param {number} id - Item client ID
     * @returns {boolean}
     */
    hasExtraByte(id) {
        return this.itemsWithExtra.has(id);
    }

    /**
     * Get all flags for an item
     * @param {number} id - Item client ID
     * @returns {object|null} Flags object or null if unknown
     */
    getItemFlags(id) {
        return this.itemFlags.get(id) || null;
    }

    /**
     * Get ground speed for an item (0 if not a ground tile)
     * @param {number} id
     * @returns {number}
     */
    getGroundSpeed(id) {
        const flags = this.itemFlags.get(id);
        return flags ? flags.groundSpeed : 0;
    }

    /**
     * Check if item blocks walking
     * @param {number} id
     * @returns {boolean}
     */
    isNotWalkable(id) {
        const flags = this.itemFlags.get(id);
        return flags ? flags.isNotWalkable : false;
    }

    /**
     * Check if item blocks pathfinding
     * @param {number} id
     * @returns {boolean}
     */
    isNotPathable(id) {
        const flags = this.itemFlags.get(id);
        return flags ? flags.isNotPathable : false;
    }

    /**
     * Check if item is a ground tile
     * @param {number} id
     * @returns {boolean}
     */
    isGround(id) {
        const flags = this.itemFlags.get(id);
        return flags ? flags.isGround : false;
    }

    /**
     * Check if item is stackable
     * @param {number} id
     * @returns {boolean}
     */
    isStackable(id) {
        return this.stackableItems.has(id);
    }

    /**
     * Check if item is fluid container
     * @param {number} id
     * @returns {boolean}
     */
    isFluidContainer(id) {
        return this.fluidItems.has(id);
    }

    /**
     * Mark an item as having extra byte (manual override)
     * @param {number} id
     */
    setHasExtraByte(id) {
        this.itemsWithExtra.add(id);
    }

    /**
     * Mark an item as stackable (manual override)
     * @param {number} id
     */
    setStackable(id) {
        this.stackableItems.add(id);
        this.itemsWithExtra.add(id);
    }

    /**
     * Mark an item as fluid container (manual override)
     * @param {number} id
     */
    setFluidContainer(id) {
        this.fluidItems.add(id);
        this.itemsWithExtra.add(id);
    }

    /**
     * Load item type data from a pre-built database (legacy)
     * @param {object} data - { stackable: number[], fluid: number[], splash: number[] }
     */
    loadDatabase(data) {
        if (data.stackable) {
            for (const id of data.stackable) this.setStackable(id);
        }
        if (data.fluid) {
            for (const id of data.fluid) this.setFluidContainer(id);
        }
        if (data.splash) {
            for (const id of data.splash) {
                this.splashItems.add(id);
                this.itemsWithExtra.add(id);
            }
        }
    }
}

module.exports = DatManager;
