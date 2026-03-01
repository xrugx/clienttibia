'use strict';

/**
 * ProtocolLogin - Tibia 8.60 Login Protocol
 * 
 * Handles:
 * - Connecting to the login server
 * - Sending account credentials (RSA encrypted)
 * - Parsing character list response
 * - Parsing MOTD and error messages
 */

const EventEmitter = require('events');
const { Connection } = require('../network');
const NetworkMessage = require('../network/NetworkMessage');
const XTEA = require('../crypto/xtea');
const { LoginServerOpcodes, PROTOCOL_VERSION, OS_OTCLIENT } = require('../constants');
const { Logger } = require('../utils');

class ProtocolLogin extends EventEmitter {
    /**
     * @param {object} options
     * @param {string} options.host - Login server host
     * @param {number} [options.port=7171] - Login server port
     * @param {string} [options.rsaKey] - Custom RSA key (hex)
     */
    constructor(options = {}) {
        super();
        this.host = options.host || '127.0.0.1';
        this.port = options.port || 7171;
        this.connection = new Connection({ host: this.host, port: this.port });
        this.logger = new Logger('ProtocolLogin');

        if (options.rsaKey) {
            this.connection.setRsaKey(options.rsaKey);
        }

        // Bind connection events
        this.connection.on('packet', (msg) => this._onPacket(msg));
        this.connection.on('error', (err) => this.emit('error', err));
        this.connection.on('disconnected', () => this.emit('disconnected'));
    }

    /**
     * Login to the login server and get character list
     * @param {string} account - Account name
     * @param {string} password - Password
     * @returns {Promise<{motd: string, characters: Array, premiumDays: number}>}
     */
    async login(account, password) {
        return new Promise(async (resolve, reject) => {
            this._loginResolve = resolve;
            this._loginReject = reject;

            try {
                await this.connection.connect();
                this.logger.info(`Connected to login server ${this.host}:${this.port}`);
                this._sendLoginPacket(account, password);
            } catch (err) {
                reject(err);
            }
        });
    }

    /**
     * Build and send the login packet
     * @private
     */
    _sendLoginPacket(account, password) {
        const msg = NetworkMessage.createOutgoing();

        // Opcode
        msg.writeU8(0x01);

        // OS type (uint16) - Send as Windows to match official client
        msg.writeU16(OS_OTCLIENT);

        // Protocol version (uint16) - 860
        msg.writeU16(PROTOCOL_VERSION);

        // DAT signature (uint32) - can be 0
        msg.writeU32(0);
        // SPR signature (uint32)
        msg.writeU32(0);
        // PIC signature (uint32)
        msg.writeU32(0);

        // Build RSA block (128 bytes)
        const rsaBlock = Buffer.alloc(128);
        let rsaPos = 0;

        // First byte must be 0x00 (RSA verification)
        rsaBlock[rsaPos++] = 0x00;

        // XTEA key (4 x uint32)
        const xteaKey = XTEA.generateKey();
        for (let i = 0; i < 4; i++) {
            rsaBlock.writeUInt32LE(xteaKey[i], rsaPos);
            rsaPos += 4;
        }

        // Account name (string: uint16 length + data)
        const accBuf = Buffer.from(account, 'latin1');
        rsaBlock.writeUInt16LE(accBuf.length, rsaPos);
        rsaPos += 2;
        accBuf.copy(rsaBlock, rsaPos);
        rsaPos += accBuf.length;

        // Password (string: uint16 length + data)
        const pwdBuf = Buffer.from(password, 'latin1');
        rsaBlock.writeUInt16LE(pwdBuf.length, rsaPos);
        rsaPos += 2;
        pwdBuf.copy(rsaBlock, rsaPos);
        rsaPos += pwdBuf.length;

        // Fill rest with random bytes
        for (let i = rsaPos; i < 128; i++) {
            rsaBlock[i] = Math.floor(Math.random() * 256);
        }

        // RSA encrypt the block
        const encryptedRsa = this.connection.rsaEncrypt(rsaBlock);
        msg.writeBytes(encryptedRsa);

        // Enable XTEA for decrypting the response
        this.connection.enableXtea(xteaKey);

        // Send (login packet uses checksum but no XTEA)
        this.connection.sendFirst(msg);

        this.logger.info('Login packet sent, waiting for response...');
    }

    /**
     * Handle incoming packet from login server
     * @private
     */
    _onPacket(msg) {
        let motd = '';
        let characters = [];
        let premiumDays = 0;
        let error = null;

        try {
            while (msg.hasMore()) {
                const opcode = msg.readU8();

                switch (opcode) {
                    case LoginServerOpcodes.Error: // 0x0A
                        error = msg.readString();
                        this.logger.error('Login error:', error);
                        break;

                    case LoginServerOpcodes.MOTD: // 0x14
                        motd = msg.readString();
                        this.logger.info('MOTD:', motd);
                        break;

                    case LoginServerOpcodes.CharacterList: // 0x64
                    {
                        const charCount = msg.readU8();
                        for (let i = 0; i < charCount; i++) {
                            const charName = msg.readString();
                            const worldName = msg.readString();
                            const ip = msg.readU32();
                            const port = msg.readU16();

                            // Convert uint32 IP to string
                            const ipStr = [
                                ip & 0xFF,
                                (ip >> 8) & 0xFF,
                                (ip >> 16) & 0xFF,
                                (ip >> 24) & 0xFF
                            ].join('.');

                            characters.push({
                                name: charName,
                                world: worldName,
                                ip: ipStr,
                                ipRaw: ip,
                                port: port
                            });

                            this.logger.info(`Character: ${charName} @ ${worldName} (${ipStr}:${port})`);
                        }

                        premiumDays = msg.readU16();
                        this.logger.info(`Premium days: ${premiumDays}`);
                        break;
                    }

                    case LoginServerOpcodes.UpdateNeeded: // 0x1E
                        error = 'Client update required';
                        this.logger.error(error);
                        break;

                    default:
                        this.logger.warn(`Unknown login opcode: 0x${opcode.toString(16)}`);
                        break;
                }
            }
        } catch (err) {
            this.logger.error('Error parsing login response:', err.message);
            error = err.message;
        }

        // Disconnect from login server
        this.connection.disconnect();

        if (error && this._loginReject) {
            this._loginReject(new Error(error));
        } else if (this._loginResolve) {
            this._loginResolve({ motd, characters, premiumDays });
        }

        this._loginResolve = null;
        this._loginReject = null;
    }

    /**
     * Disconnect
     */
    disconnect() {
        this.connection.disconnect();
    }
}

module.exports = ProtocolLogin;
