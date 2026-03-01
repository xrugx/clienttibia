'use strict';

/**
 * NetworkMessage - Binary packet buffer for Tibia 8.60 protocol
 * 
 * Handles reading and writing of all primitive data types used in the protocol.
 * Supports little-endian byte order matching the original implementation.
 * 
 * Buffer layout:
 *   [0-1]   Packet size (uint16, written on send)
 *   [2-5]   Adler32 checksum (written on send)
 *   [6-7]   Inner message length (part of XTEA payload)
 *   [8+]    Payload data
 */

const { MAX_NETWORK_MESSAGE_SIZE, HEADER_SIZE, CHECKSUM_SIZE } = require('../constants/GameConstants');

const INITIAL_BUFFER_POSITION = HEADER_SIZE + CHECKSUM_SIZE + 2; // 2 for inner length

class NetworkMessage {
    /**
     * @param {Buffer} [buffer] - Existing buffer (for incoming data) or null for outgoing
     * @param {number} [size] - Size of valid data in buffer
     */
    constructor(buffer, size) {
        if (buffer) {
            this.buffer = buffer;
            this.length = size || buffer.length;
        } else {
            this.buffer = Buffer.alloc(MAX_NETWORK_MESSAGE_SIZE);
            this.length = 0;
        }
        this.position = 0;
    }

    // ============================================================
    // Reading methods (for parsing incoming packets)
    // ============================================================

    /**
     * Read uint8 (1 byte)
     * @returns {number}
     */
    readU8() {
        if (this.position + 1 > this.length) {
            throw new Error(`NetworkMessage.readU8: buffer overflow at position ${this.position}, length ${this.length}`);
        }
        const value = this.buffer.readUInt8(this.position);
        this.position += 1;
        return value;
    }

    /**
     * Read uint16 little-endian (2 bytes)
     * @returns {number}
     */
    readU16() {
        if (this.position + 2 > this.length) {
            throw new Error(`NetworkMessage.readU16: buffer overflow at position ${this.position}, length ${this.length}`);
        }
        const value = this.buffer.readUInt16LE(this.position);
        this.position += 2;
        return value;
    }

    /**
     * Read uint32 little-endian (4 bytes)
     * @returns {number}
     */
    readU32() {
        if (this.position + 4 > this.length) {
            throw new Error(`NetworkMessage.readU32: buffer overflow at position ${this.position}, length ${this.length}`);
        }
        const value = this.buffer.readUInt32LE(this.position);
        this.position += 4;
        return value;
    }

    /**
     * Read uint64 little-endian (8 bytes) as BigInt
     * @returns {bigint}
     */
    readU64() {
        if (this.position + 8 > this.length) {
            throw new Error('NetworkMessage.readU64: buffer overflow');
        }
        const value = this.buffer.readBigUInt64LE(this.position);
        this.position += 8;
        return value;
    }

    /**
     * Read int8 (signed, 1 byte)
     * @returns {number}
     */
    readI8() {
        if (this.position + 1 > this.length) {
            throw new Error('NetworkMessage.readI8: buffer overflow');
        }
        const value = this.buffer.readInt8(this.position);
        this.position += 1;
        return value;
    }

    /**
     * Read int16 little-endian (signed, 2 bytes)
     * @returns {number}
     */
    readI16() {
        if (this.position + 2 > this.length) {
            throw new Error('NetworkMessage.readI16: buffer overflow');
        }
        const value = this.buffer.readInt16LE(this.position);
        this.position += 2;
        return value;
    }

    /**
     * Read string (uint16 length + data)
     * @returns {string}
     */
    readString() {
        const len = this.readU16();
        if (this.position + len > this.length) {
            throw new Error(`NetworkMessage.readString: buffer overflow (string length ${len})`);
        }
        const str = this.buffer.toString('latin1', this.position, this.position + len);
        this.position += len;
        return str;
    }

    /**
     * Read position (uint16 x + uint16 y + uint8 z)
     * @returns {{x: number, y: number, z: number}}
     */
    readPosition() {
        return {
            x: this.readU16(),
            y: this.readU16(),
            z: this.readU8()
        };
    }

    /**
     * Read raw bytes
     * @param {number} count - Number of bytes to read
     * @returns {Buffer}
     */
    readBytes(count) {
        if (this.position + count > this.length) {
            throw new Error(`NetworkMessage.readBytes: buffer overflow (need ${count} at pos ${this.position}, have ${this.length})`);
        }
        const data = Buffer.alloc(count);
        this.buffer.copy(data, 0, this.position, this.position + count);
        this.position += count;
        return data;
    }

    /**
     * Peek at next byte without advancing position
     * @returns {number}
     */
    peekU8() {
        if (this.position + 1 > this.length) {
            throw new Error('NetworkMessage.peekU8: buffer overflow');
        }
        return this.buffer.readUInt8(this.position);
    }

    /**
     * Peek at next uint16 without advancing position
     * @returns {number}
     */
    peekU16() {
        if (this.position + 2 > this.length) {
            throw new Error('NetworkMessage.peekU16: buffer overflow');
        }
        return this.buffer.readUInt16LE(this.position);
    }

    /**
     * Skip N bytes
     * @param {number} count
     */
    skip(count) {
        this.position += count;
    }

    /**
     * Read previous byte (step back 1 and read)
     * @returns {number}
     */
    getPreviousByte() {
        this.position -= 1;
        return this.buffer.readUInt8(this.position);
    }

    /**
     * Get remaining bytes count
     * @returns {number}
     */
    remaining() {
        return this.length - this.position;
    }

    /**
     * Check if there are more bytes to read
     * @returns {boolean}
     */
    hasMore() {
        return this.position < this.length;
    }

    /**
     * Skip all remaining bytes (advance position to end)
     */
    skipToEnd() {
        this.position = this.length;
    }

    // ============================================================
    // Writing methods (for building outgoing packets)
    // ============================================================

    /**
     * Write uint8 (1 byte)
     * @param {number} value
     */
    writeU8(value) {
        this.buffer.writeUInt8(value & 0xFF, this.position);
        this.position += 1;
        this._updateLength();
    }

    /**
     * Write uint16 little-endian (2 bytes)
     * @param {number} value
     */
    writeU16(value) {
        this.buffer.writeUInt16LE(value & 0xFFFF, this.position);
        this.position += 2;
        this._updateLength();
    }

    /**
     * Write uint32 little-endian (4 bytes)
     * @param {number} value
     */
    writeU32(value) {
        this.buffer.writeUInt32LE(value >>> 0, this.position);
        this.position += 4;
        this._updateLength();
    }

    /**
     * Write uint64 little-endian (8 bytes)
     * @param {bigint} value
     */
    writeU64(value) {
        this.buffer.writeBigUInt64LE(BigInt(value), this.position);
        this.position += 8;
        this._updateLength();
    }

    /**
     * Write string (uint16 length + data)
     * @param {string} str
     */
    writeString(str) {
        const len = Buffer.byteLength(str, 'latin1');
        this.writeU16(len);
        this.buffer.write(str, this.position, len, 'latin1');
        this.position += len;
        this._updateLength();
    }

    /**
     * Write position (uint16 x + uint16 y + uint8 z)
     * @param {{x: number, y: number, z: number}} pos
     */
    writePosition(pos) {
        this.writeU16(pos.x);
        this.writeU16(pos.y);
        this.writeU8(pos.z);
    }

    /**
     * Write raw bytes
     * @param {Buffer} data
     */
    writeBytes(data) {
        data.copy(this.buffer, this.position);
        this.position += data.length;
        this._updateLength();
    }

    /**
     * Write padding bytes (0x33)
     * @param {number} count
     */
    writePadding(count) {
        for (let i = 0; i < count; i++) {
            this.buffer[this.position + i] = 0x33;
        }
        this.position += count;
        this._updateLength();
    }

    // ============================================================
    // Buffer management
    // ============================================================

    /**
     * Reset message for writing a new outgoing packet
     */
    reset() {
        this.position = INITIAL_BUFFER_POSITION;
        this.length = INITIAL_BUFFER_POSITION;
    }

    /**
     * Reset for raw writing (no header space)
     */
    resetRaw() {
        this.position = 0;
        this.length = 0;
    }

    /**
     * Set position for reading from payload start
     * @param {number} [pos=0]
     */
    setReadPos(pos = 0) {
        this.position = pos;
    }

    /**
     * Get the payload data (for outgoing, after header/checksum)
     * @returns {Buffer}
     */
    getPayload() {
        return this.buffer.subarray(INITIAL_BUFFER_POSITION, this.length);
    }

    /**
     * Get the full buffer including headers
     * @returns {Buffer}
     */
    getBuffer() {
        return this.buffer.subarray(0, this.length);
    }

    /**
     * Get payload size (without headers)
     * @returns {number}
     */
    getPayloadSize() {
        return this.length - INITIAL_BUFFER_POSITION;
    }

    /**
     * Create a new NetworkMessage for outgoing packet
     * Position starts after header space
     * @returns {NetworkMessage}
     */
    static createOutgoing() {
        const msg = new NetworkMessage();
        msg.reset();
        return msg;
    }

    /**
     * Create a NetworkMessage from incoming raw data
     * @param {Buffer} data - Raw data from socket
     * @returns {NetworkMessage}
     */
    static fromBuffer(data) {
        const msg = new NetworkMessage(data, data.length);
        msg.position = 0;
        return msg;
    }

    /**
     * @private
     */
    _updateLength() {
        if (this.position > this.length) {
            this.length = this.position;
        }
    }
}

NetworkMessage.INITIAL_BUFFER_POSITION = INITIAL_BUFFER_POSITION;
NetworkMessage.HEADER_SIZE = HEADER_SIZE;
NetworkMessage.CHECKSUM_SIZE = CHECKSUM_SIZE;

module.exports = NetworkMessage;
