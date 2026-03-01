'use strict';

/**
 * Logger - Simple logging utility with levels and timestamps
 */

const LEVELS = {
    DEBUG: 0,
    INFO: 1,
    WARN: 2,
    ERROR: 3,
    NONE: 4
};

class Logger {
    /**
     * @param {string} [name='TibiaClient']
     * @param {number} [level=LEVELS.INFO]
     */
    constructor(name = 'TibiaClient', level = LEVELS.INFO) {
        this.name = name;
        this.level = level;
    }

    _timestamp() {
        return new Date().toISOString().replace('T', ' ').replace('Z', '');
    }

    _format(level, ...args) {
        return `[${this._timestamp()}] [${level}] [${this.name}] ${args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')}`;
    }

    debug(...args) {
        if (this.level <= LEVELS.DEBUG) {
            console.log(this._format('DEBUG', ...args));
        }
    }

    info(...args) {
        if (this.level <= LEVELS.INFO) {
            console.log(this._format('INFO', ...args));
        }
    }

    warn(...args) {
        if (this.level <= LEVELS.WARN) {
            console.warn(this._format('WARN', ...args));
        }
    }

    error(...args) {
        if (this.level <= LEVELS.ERROR) {
            console.error(this._format('ERROR', ...args));
        }
    }

    /**
     * Log raw hex dump of a buffer
     * @param {Buffer} buffer
     * @param {number} [maxBytes=64]
     */
    hex(buffer, maxBytes = 64) {
        if (this.level > LEVELS.DEBUG) return;
        const len = Math.min(buffer.length, maxBytes);
        const hex = [];
        for (let i = 0; i < len; i++) {
            hex.push(buffer[i].toString(16).padStart(2, '0'));
        }
        const suffix = buffer.length > maxBytes ? `... (${buffer.length} bytes total)` : '';
        console.log(`[${this._timestamp()}] [HEX] [${this.name}] ${hex.join(' ')}${suffix}`);
    }

    /**
     * Create a child logger with a sub-name
     * @param {string} subName
     * @returns {Logger}
     */
    child(subName) {
        return new Logger(`${this.name}:${subName}`, this.level);
    }

    /**
     * Set log level
     * @param {string} levelName - 'debug', 'info', 'warn', 'error', 'none'
     */
    setLevel(levelName) {
        const upper = levelName.toUpperCase();
        if (LEVELS[upper] !== undefined) {
            this.level = LEVELS[upper];
        }
    }
}

Logger.LEVELS = LEVELS;

module.exports = Logger;
