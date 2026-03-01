'use strict';

/**
 * XTEA (eXtended Tiny Encryption Algorithm) for Tibia 8.60 protocol
 * 
 * - 128-bit key (4 x uint32)
 * - 8-byte block size
 * - 32 rounds
 * - Delta: 0x61C88647
 * - Padding byte: 0x33
 */

const DELTA = 0x61C88647;
const ROUNDS = 32;
const BLOCK_SIZE = 8;

class XTEA {
    /**
     * @param {number[]} key - Array of 4 uint32 values
     */
    constructor(key) {
        if (!Array.isArray(key) || key.length !== 4) {
            throw new Error('XTEA key must be an array of 4 uint32 values');
        }
        this.key = key.map(k => k >>> 0);
    }

    /**
     * Encrypt a buffer in-place
     * @param {Buffer} buffer - Data to encrypt (must be padded to 8-byte boundary)
     * @param {number} offset - Start offset
     * @param {number} length - Length of data to encrypt
     * @returns {Buffer}
     */
    encrypt(buffer, offset = 0, length = buffer.length - offset) {
        // Pad to 8-byte boundary
        const paddedLength = Math.ceil(length / BLOCK_SIZE) * BLOCK_SIZE;
        let result = buffer;
        
        if (paddedLength > length) {
            // Need padding
            const padded = Buffer.alloc(offset + paddedLength);
            buffer.copy(padded, 0, 0, offset + length);
            // Fill padding with 0x33
            for (let i = offset + length; i < offset + paddedLength; i++) {
                padded[i] = 0x33;
            }
            result = padded;
        }

        for (let i = 0; i < paddedLength; i += BLOCK_SIZE) {
            this._encryptBlock(result, offset + i);
        }

        return result;
    }

    /**
     * Decrypt a buffer in-place
     * @param {Buffer} buffer - Data to decrypt
     * @param {number} offset - Start offset
     * @param {number} length - Length of data to decrypt
     * @returns {Buffer}
     */
    decrypt(buffer, offset = 0, length = buffer.length - offset) {
        if (length % BLOCK_SIZE !== 0) {
            throw new Error('XTEA decrypt: data length must be multiple of 8');
        }

        for (let i = 0; i < length; i += BLOCK_SIZE) {
            this._decryptBlock(buffer, offset + i);
        }

        return buffer;
    }

    /**
     * Encrypt a single 8-byte block
     * @private
     */
    _encryptBlock(buffer, offset) {
        let v0 = buffer.readUInt32LE(offset);
        let v1 = buffer.readUInt32LE(offset + 4);
        let sum = 0;

        for (let i = 0; i < ROUNDS; i++) {
            v0 = (v0 + ((((v1 << 4) ^ (v1 >>> 5)) + v1) ^ (sum + this.key[sum & 3]))) >>> 0;
            sum = (sum - DELTA) >>> 0;
            v1 = (v1 + ((((v0 << 4) ^ (v0 >>> 5)) + v0) ^ (sum + this.key[(sum >>> 11) & 3]))) >>> 0;
        }

        buffer.writeUInt32LE(v0, offset);
        buffer.writeUInt32LE(v1, offset + 4);
    }

    /**
     * Decrypt a single 8-byte block
     * @private
     */
    _decryptBlock(buffer, offset) {
        let v0 = buffer.readUInt32LE(offset);
        let v1 = buffer.readUInt32LE(offset + 4);
        let sum = 0xC6EF3720; // ROUNDS * DELTA

        for (let i = 0; i < ROUNDS; i++) {
            v1 = (v1 - ((((v0 << 4) ^ (v0 >>> 5)) + v0) ^ (sum + this.key[(sum >>> 11) & 3]))) >>> 0;
            sum = (sum + DELTA) >>> 0;
            v0 = (v0 - ((((v1 << 4) ^ (v1 >>> 5)) + v1) ^ (sum + this.key[sum & 3]))) >>> 0;
        }

        buffer.writeUInt32LE(v0, offset);
        buffer.writeUInt32LE(v1, offset + 4);
    }

    /**
     * Generate a random XTEA key
     * @returns {number[]} Array of 4 random uint32 values
     */
    static generateKey() {
        const key = [];
        for (let i = 0; i < 4; i++) {
            key.push((Math.random() * 0xFFFFFFFF) >>> 0);
        }
        return key;
    }
}

XTEA.BLOCK_SIZE = BLOCK_SIZE;

module.exports = XTEA;
