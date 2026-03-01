'use strict';

/**
 * Adler32 checksum - identical to the one used by Tibia protocol
 * Used for packet integrity verification
 */

const MOD_ADLER = 65521;

function adler32(buffer, offset = 0, length = buffer.length - offset) {
    let a = 1;
    let b = 0;
    const end = offset + length;

    for (let i = offset; i < end; i++) {
        a = (a + buffer[i]) % MOD_ADLER;
        b = (b + a) % MOD_ADLER;
    }

    return ((b << 16) | a) >>> 0;
}

module.exports = { adler32 };
