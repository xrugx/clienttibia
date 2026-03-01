'use strict';

/**
 * Container - Represents an open container (backpack, chest, etc.)
 */

class Container {
    /**
     * @param {number} id - Container ID (uint8)
     */
    constructor(id) {
        this.id = id;               // Container slot ID (0-15)
        this.itemId = 0;            // Client sprite ID of container item
        this.name = '';             // Container name
        this.capacity = 0;          // Max items
        this.hasParent = false;     // Has parent container (can go up)
        this.items = [];            // Array of Items
    }

    /**
     * Add item to container
     * @param {object} item
     */
    addItem(item) {
        this.items.unshift(item); // Add to front (slot 0)
    }

    /**
     * Update item at slot
     * @param {number} slot
     * @param {object} item
     */
    updateItem(slot, item) {
        if (slot >= 0 && slot < this.items.length) {
            this.items[slot] = item;
        }
    }

    /**
     * Remove item at slot
     * @param {number} slot
     * @returns {object|null}
     */
    removeItem(slot) {
        if (slot >= 0 && slot < this.items.length) {
            return this.items.splice(slot, 1)[0];
        }
        return null;
    }

    /**
     * Get item at slot
     * @param {number} slot
     * @returns {object|null}
     */
    getItem(slot) {
        return this.items[slot] || null;
    }

    /**
     * Get number of items
     * @returns {number}
     */
    getItemCount() {
        return this.items.length;
    }

    /**
     * Check if container is full
     * @returns {boolean}
     */
    isFull() {
        return this.items.length >= this.capacity;
    }

    /**
     * Clear all items
     */
    clear() {
        this.items = [];
    }

    toString() {
        return `Container(id=${this.id}, name="${this.name}", items=${this.items.length}/${this.capacity})`;
    }
}

module.exports = Container;
