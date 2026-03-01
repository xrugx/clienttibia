'use strict';

const Creature = require('./Creature');
const Position = require('./Position');

/**
 * Player - Represents the local player with full stats
 */

class Player extends Creature {
    constructor(id = 0) {
        super(id);
        this.type = 'player';

        // Stats (from 0xA0 PlayerStats)
        this.health = 0;
        this.maxHealth = 0;
        this.freeCapacity = 0;      // In 1/100 oz
        this.experience = 0;        // uint32 in 8.60
        this.level = 0;
        this.levelPercent = 0;
        this.mana = 0;
        this.maxMana = 0;
        this.magicLevel = 0;
        this.magicLevelPercent = 0;
        this.soul = 0;
        this.stamina = 0;           // In minutes

        // Skills (from 0xA1 PlayerSkills)
        this.skills = {
            fist:     { level: 10, percent: 0 },
            club:     { level: 10, percent: 0 },
            sword:    { level: 10, percent: 0 },
            axe:      { level: 10, percent: 0 },
            distance: { level: 10, percent: 0 },
            shield:   { level: 10, percent: 0 },
            fishing:  { level: 10, percent: 0 }
        };

        // Status icons bitmask (from 0xA2)
        this.icons = 0;

        // Combat modes (from 0xA0 ChangeFightModes)
        this.fightMode = 1;     // 1=attack, 2=balanced, 3=defense
        this.chaseMode = 0;     // 0=stand, 1=chase
        this.secureMode = 1;    // 0=off, 1=on

        // Target
        this.attackingCreatureId = 0;
        this.followingCreatureId = 0;

        // Flags
        this.canReportBugs = false;
        this.premium = false;
        this.premiumDays = 0;

        // VIP list
        this.vipList = new Map(); // id -> { name, online }

        // Inventory (slot -> Item)
        this.inventory = new Map();
    }

    /**
     * Get formatted capacity string
     * @returns {string}
     */
    getCapacityString() {
        return (this.freeCapacity / 100).toFixed(2) + ' oz';
    }

    /**
     * Get formatted stamina string
     * @returns {string}
     */
    getStaminaString() {
        const hours = Math.floor(this.stamina / 60);
        const minutes = this.stamina % 60;
        return `${hours}h ${minutes}m`;
    }

    /**
     * Check if player has a specific status icon
     * @param {number} iconFlag
     * @returns {boolean}
     */
    hasIcon(iconFlag) {
        return (this.icons & iconFlag) !== 0;
    }

    /**
     * Get skill by index
     * @param {number} index - 0=fist, 1=club, 2=sword, 3=axe, 4=distance, 5=shield, 6=fishing
     * @returns {{level: number, percent: number}}
     */
    getSkill(index) {
        const names = ['fist', 'club', 'sword', 'axe', 'distance', 'shield', 'fishing'];
        return this.skills[names[index]] || { level: 0, percent: 0 };
    }

    /**
     * Update skills from packet data
     * @param {Array<{level: number, percent: number}>} skillData - 7 skills
     */
    updateSkills(skillData) {
        const names = ['fist', 'club', 'sword', 'axe', 'distance', 'shield', 'fishing'];
        for (let i = 0; i < Math.min(skillData.length, 7); i++) {
            this.skills[names[i]] = skillData[i];
        }
    }

    toString() {
        return `Player(id=${this.id}, name="${this.name}", level=${this.level}, hp=${this.health}/${this.maxHealth}, mana=${this.mana}/${this.maxMana})`;
    }
}

module.exports = Player;
