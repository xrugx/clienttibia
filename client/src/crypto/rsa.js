'use strict';

/**
 * RSA Encryption for Tibia 8.60 protocol
 * 
 * Uses Node.js native BigInt for modular exponentiation.
 * The client encrypts a 128-byte block using the server's public key (N, e).
 * The first byte after decryption must be 0x00.
 * 
 * Default OTServ RSA public key is included.
 */

const RSA_BLOCK_SIZE = 128;

// Default OTServ RSA key (matching the server)
// P and Q from the server source
const DEFAULT_P = 14299623962416399520070177382898895550795403345466153217470516082934737582776038882967213386204600674145392845853859217990626450972452084065728686565928113n;
const DEFAULT_Q = 7630979195970404721891201847792002125535401292779123937207447574596692788513647179235335529307251350570728407373705564708871762033017096809910315212884101n;
const DEFAULT_E = 65537n;
const DEFAULT_N = DEFAULT_P * DEFAULT_Q;

class RSA {
    /**
     * @param {bigint} [n] - Public modulus
     * @param {bigint} [e] - Public exponent
     */
    constructor(n, e) {
        this.n = n || DEFAULT_N;
        this.e = e || DEFAULT_E;
    }

    /**
     * Encrypt a 128-byte block using RSA public key
     * @param {Buffer} data - Must be exactly 128 bytes
     * @returns {Buffer} 128-byte encrypted block
     */
    encrypt(data) {
        if (data.length !== RSA_BLOCK_SIZE) {
            throw new Error(`RSA encrypt: data must be ${RSA_BLOCK_SIZE} bytes, got ${data.length}`);
        }

        // Convert buffer to BigInt (big-endian)
        let m = 0n;
        for (let i = 0; i < data.length; i++) {
            m = (m << 8n) | BigInt(data[i]);
        }

        // c = m^e mod n
        const c = this._modPow(m, this.e, this.n);

        // Convert back to buffer (big-endian, 128 bytes)
        const result = Buffer.alloc(RSA_BLOCK_SIZE);
        let temp = c;
        for (let i = RSA_BLOCK_SIZE - 1; i >= 0; i--) {
            result[i] = Number(temp & 0xFFn);
            temp >>= 8n;
        }

        return result;
    }

    /**
     * Modular exponentiation: base^exp mod mod
     * @private
     */
    _modPow(base, exp, mod) {
        let result = 1n;
        base = base % mod;

        while (exp > 0n) {
            if (exp & 1n) {
                result = (result * base) % mod;
            }
            exp >>= 1n;
            base = (base * base) % mod;
        }

        return result;
    }

    /**
     * Set custom RSA public key from hex strings
     * @param {string} nHex - Modulus N as hex string
     * @param {string} [eHex='10001'] - Exponent e as hex string (default 65537)
     */
    setKey(nHex, eHex = '10001') {
        this.n = BigInt('0x' + nHex);
        this.e = BigInt('0x' + eHex);
    }

    /**
     * Set key from decimal string
     * @param {string} nDec - Modulus N as decimal string 
     */
    setKeyDecimal(nDec) {
        this.n = BigInt(nDec);
    }
}

RSA.BLOCK_SIZE = RSA_BLOCK_SIZE;
RSA.DEFAULT_N = DEFAULT_N;
RSA.DEFAULT_E = DEFAULT_E;

module.exports = RSA;
