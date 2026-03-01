'use strict';

/**
 * Connection - TCP connection manager for Tibia protocol
 * 
 * Handles:
 * - TCP socket management
 * - Packet framing (2-byte length header)
 * - Adler32 checksum verification/addition
 * - XTEA encryption/decryption
 * - RSA encryption for login packets
 */

const net = require('net');
const EventEmitter = require('events');
const NetworkMessage = require('./NetworkMessage');
const { RSA, XTEA, adler32 } = require('../crypto');
const { HEADER_SIZE, CHECKSUM_SIZE } = require('../constants/GameConstants');

class Connection extends EventEmitter {
    /**
     * @param {object} [options]
     * @param {string} [options.host='127.0.0.1'] - Server host
     * @param {number} [options.port=7171] - Server port
     */
    constructor(options = {}) {
        super();
        this.host = options.host || '127.0.0.1';
        this.port = options.port || 7171;
        this.socket = null;
        this.connected = false;
        this.rsa = new RSA();
        this.xtea = null;
        this.xteaKey = null;
        this.useChecksum = true;
        this.useXtea = false;

        // Incoming data buffer for packet assembly
        this._recvBuffer = Buffer.alloc(0);
        this._expectedSize = 0;
    }

    /**
     * Connect to the server
     * @returns {Promise<void>}
     */
    connect() {
        return new Promise((resolve, reject) => {
            if (this.connected) {
                reject(new Error('Already connected'));
                return;
            }

            this.socket = new net.Socket();
            this.socket.setNoDelay(true);

            this._recvBuffer = Buffer.alloc(0);
            this._expectedSize = 0;

            this.socket.connect(this.port, this.host, () => {
                this.connected = true;
                this.emit('connected');
                resolve();
            });

            this.socket.on('data', (data) => {
                this._onData(data);
            });

            this.socket.on('error', (err) => {
                this.emit('error', err);
                reject(err);
            });

            this.socket.on('close', () => {
                this.connected = false;
                this.emit('disconnected');
            });

            this.socket.on('timeout', () => {
                this.emit('timeout');
                this.disconnect();
            });

            // 30 second timeout
            this.socket.setTimeout(30000);
        });
    }

    /**
     * Check if the connection is active
     * @returns {boolean}
     */
    isConnected() {
        return this.connected && this.socket !== null;
    }

    /**
     * Disconnect from server
     */
    disconnect() {
        if (this.socket) {
            this.socket.destroy();
            this.socket = null;
        }
        this.connected = false;
        this.useXtea = false;
        this.xtea = null;
        this.xteaKey = null;
        this._recvBuffer = Buffer.alloc(0);
    }

    /**
     * Enable XTEA encryption with the given key
     * @param {number[]} key - Array of 4 uint32 values
     */
    enableXtea(key) {
        this.xteaKey = key;
        this.xtea = new XTEA(key);
        this.useXtea = true;
    }

    /**
     * Set a custom RSA key
     * @param {string} nHex - Modulus N as hex string
     */
    setRsaKey(nHex) {
        this.rsa.setKey(nHex);
    }

    /**
     * Send a raw buffer (for login/first message with RSA)
     * @param {NetworkMessage} msg - Message to send
     * @param {boolean} [encrypt=false] - Whether to XTEA encrypt
     */
    send(msg, encrypt = false) {
        if (!this.connected || !this.socket) {
            throw new Error('Not connected');
        }

        // Payload starts at position 8 (after 2 header + 4 checksum + 2 inner length)
        const payloadStart = NetworkMessage.HEADER_SIZE + NetworkMessage.CHECKSUM_SIZE;
        const payloadSize = msg.length - payloadStart;

        if (encrypt && this.useXtea) {
            // Write inner message length before XTEA encryption
            const innerStart = payloadStart;
            const innerPayloadSize = msg.length - innerStart - 2; // minus 2 for inner length field itself

            // Write inner length at position 6-7
            msg.buffer.writeUInt16LE(innerPayloadSize, innerStart);

            // Encrypt from innerStart
            const dataToEncrypt = msg.buffer.subarray(innerStart, msg.length);
            const paddedLen = Math.ceil(dataToEncrypt.length / XTEA.BLOCK_SIZE) * XTEA.BLOCK_SIZE;

            // Pad if needed
            if (paddedLen > dataToEncrypt.length) {
                const padding = paddedLen - dataToEncrypt.length;
                for (let i = 0; i < padding; i++) {
                    msg.buffer[msg.length + i] = 0x33;
                }
                msg.length = innerStart + paddedLen;
            }

            this.xtea.encrypt(msg.buffer, innerStart, paddedLen);
        }

        // Calculate checksum
        const checksumStart = payloadStart;
        const checksumLen = msg.length - checksumStart;
        const checksum = adler32(msg.buffer, checksumStart, checksumLen);

        // Write checksum at position 2-5
        msg.buffer.writeUInt32LE(checksum, HEADER_SIZE);

        // Write total packet length at position 0-1
        const totalSize = msg.length - HEADER_SIZE;
        msg.buffer.writeUInt16LE(totalSize, 0);

        // Send the complete packet
        const packet = Buffer.alloc(msg.length);
        msg.buffer.copy(packet, 0, 0, msg.length);

        this.socket.write(packet);
    }

    /**
     * Send a raw first message (login) without XTEA but with checksum
     * First messages don't have the 2-byte inner length field that
     * XTEA-encrypted messages use, so we shift the payload back.
     * @param {NetworkMessage} msg
     */
    sendFirst(msg) {
        // The message was built starting at position 8 (HEADER + CHECKSUM + 2 inner length)
        // But first messages have no inner length field. Layout must be:
        //   [0-1] packet size  [2-5] checksum  [6+] payload (opcode + data)
        // Shift payload from position 8 back to position 6
        const payloadStart = NetworkMessage.HEADER_SIZE + NetworkMessage.CHECKSUM_SIZE; // 6
        const dataStart = NetworkMessage.INITIAL_BUFFER_POSITION; // 8

        msg.buffer.copy(msg.buffer, payloadStart, dataStart, msg.length);
        msg.length -= (dataStart - payloadStart);

        this.send(msg, false);
    }

    /**
     * Send an encrypted game message
     * @param {NetworkMessage} msg
     */
    sendEncrypted(msg) {
        this.send(msg, true);
    }

    /**
     * Handle incoming data from socket
     * @private
     */
    _onData(data) {
        // Append to receive buffer
        this._recvBuffer = Buffer.concat([this._recvBuffer, data]);

        // Process complete packets
        while (this._recvBuffer.length >= HEADER_SIZE) {
            // Read packet size
            const packetSize = this._recvBuffer.readUInt16LE(0);
            const totalSize = HEADER_SIZE + packetSize;

            if (this._recvBuffer.length < totalSize) {
                // Not enough data yet
                break;
            }

            // Extract complete packet
            const packetData = Buffer.alloc(totalSize);
            this._recvBuffer.copy(packetData, 0, 0, totalSize);

            // Remove from receive buffer
            this._recvBuffer = this._recvBuffer.subarray(totalSize);

            // Process the packet
            this._processPacket(packetData, packetSize);
        }
    }

    /**
     * Process a complete packet
     * @private
     */
    _processPacket(data, packetSize) {
        try {
            let offset = HEADER_SIZE; // Skip 2-byte size header

            // Verify checksum
            if (this.useChecksum) {
                const receivedChecksum = data.readUInt32LE(offset);
                offset += CHECKSUM_SIZE;

                const calculatedChecksum = adler32(data, offset, packetSize - CHECKSUM_SIZE);
                if (receivedChecksum !== calculatedChecksum) {
                    this.emit('error', new Error(`Checksum mismatch: expected ${calculatedChecksum}, got ${receivedChecksum}`));
                    return;
                }
            }

            // Decrypt if XTEA is enabled
            let payloadOffset = offset;
            let payloadLength = packetSize - CHECKSUM_SIZE;

            if (this.useXtea && this.xtea) {
                this.xtea.decrypt(data, payloadOffset, payloadLength);
            }

            // Server always includes a 2-byte inner message length
            const innerLength = data.readUInt16LE(payloadOffset);
            payloadOffset += 2;
            payloadLength = innerLength;

            // Create NetworkMessage from payload
            const payload = Buffer.alloc(payloadLength);
            data.copy(payload, 0, payloadOffset, payloadOffset + payloadLength);

            const msg = new NetworkMessage(payload, payloadLength);
            msg.position = 0;

            this.emit('packet', msg);
        } catch (err) {
            this.emit('error', err);
        }
    }

    /**
     * RSA encrypt a 128-byte block within a message
     * @param {Buffer} data - 128 bytes to encrypt
     * @returns {Buffer} Encrypted 128 bytes
     */
    rsaEncrypt(data) {
        return this.rsa.encrypt(data);
    }
}

module.exports = Connection;
