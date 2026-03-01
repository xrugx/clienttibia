'use strict';

/**
 * DatParser - Parses the binary Tibia .dat file to extract item/creature/effect/missile type flags.
 * 
 * The .dat file contains visual and physical attributes for every ThingType:
 * - Ground speed, stackable, fluid, splash, walkable, pathable, light, etc.
 * - Sprite dimensions, layers, patterns, animation data, and sprite IDs.
 * 
 * This parser reads the decrypted .dat file (ENC3 files must be decrypted first)
 * and produces a map of itemId → flags object that can be loaded into DatManager.
 * 
 * Supports Tibia 8.60 protocol and OTClient v8 extended DATs.
 */

const fs = require('fs');

// ThingAttr enum (matches OTClient src/client/thingtypeattributes.h)
const ThingAttr = {
    Ground:             0,
    GroundBorder:       1,
    OnBottom:           2,
    OnTop:              3,
    Container:          4,
    Stackable:          5,
    ForceUse:           6,
    MultiUse:           7,
    Writable:           8,
    WritableOnce:       9,
    FluidContainer:     10,
    Splash:             11,
    NotWalkable:        12,
    NotMoveable:        13,
    BlockProjectile:    14,
    NotPathable:        15,
    Pickupable:         16,
    Hangable:           17,
    HookSouth:          18,
    HookEast:           19,
    Rotatable:          20,
    Light:              21,
    DontHide:           22,
    Translucent:        23,
    Displacement:       24,
    Elevation:          25,
    LyingCorpse:        26,
    AnimateAlways:      27,
    MinimapColor:       28,
    LensHelp:           29,
    FullGround:         30,
    IgnoreLook:         31,
    Cloth:              32,
    Market:             33,
    Usable:             34,
    Last:               255,
};

class DatParser {
    /**
     * Parse a decrypted Tibia .dat file
     * @param {string} filePath - Path to the decrypted .dat file
     * @returns {{ signature: number, itemCount: number, items: Map<number, object> }}
     */
    static parseFile(filePath) {
        const buf = fs.readFileSync(filePath);
        return DatParser.parseBuffer(buf);
    }

    /**
     * Parse a .dat buffer
     * @param {Buffer} buf
     * @returns {{ signature: number, itemCount: number, creatureCount: number, effectCount: number, missileCount: number, items: Map<number, object> }}
     */
    static parseBuffer(buf) {
        let off = 0;

        // Header
        const signature = buf.readUInt32LE(off); off += 4;
        const itemCount = buf.readUInt16LE(off); off += 2;
        const creatureCount = buf.readUInt16LE(off); off += 2;
        const effectCount = buf.readUInt16LE(off); off += 2;
        const missileCount = buf.readUInt16LE(off); off += 2;

        // Parse all items (start at ID 100)
        const items = new Map();
        for (let id = 100; id <= itemCount; id++) {
            try {
                const result = DatParser._parseThingType(buf, off);
                off = result.endOffset;
                items.set(id, result.flags);
            } catch (e) {
                // Skip remaining items on parse error (shouldn't happen with correct DAT)
                break;
            }
        }

        // We don't need creatures/effects/missiles for the bot, but skip them
        // to validate the parse was correct. Skip silently on error.
        for (let id = 1; id <= creatureCount; id++) {
            try {
                const result = DatParser._parseThingType(buf, off);
                off = result.endOffset;
            } catch (e) { break; }
        }

        return { signature, itemCount, creatureCount, effectCount, missileCount, items };
    }

    /**
     * Parse a single ThingType entry from the buffer
     * @private
     * @param {Buffer} buf
     * @param {number} offset
     * @returns {{ endOffset: number, flags: object }}
     */
    static _parseThingType(buf, offset) {
        let off = offset;
        const flags = {
            groundSpeed: 0,
            isGround: false,
            isStackable: false,
            isFluidContainer: false,
            isSplash: false,
            isNotWalkable: false,
            isNotMoveable: false,
            isNotPathable: false,
            isBlockProjectile: false,
            isPickupable: false,
            isContainer: false,
            isHangable: false,
            isOnBottom: false,
            isOnTop: false,
            isFullGround: false,
            hasElevation: false,
            elevation: 0,
            lightLevel: 0,
            lightColor: 0,
            minimapColor: 0,
            displacementX: 0,
            displacementY: 0,
        };

        // Read attributes until ThingLastAttr (0xFF)
        while (off < buf.length) {
            const attr = buf.readUInt8(off); off++;

            if (attr === ThingAttr.Last) break;

            switch (attr) {
                case ThingAttr.Ground:
                    flags.isGround = true;
                    flags.groundSpeed = buf.readUInt16LE(off); off += 2;
                    break;

                case ThingAttr.GroundBorder:
                    break;

                case ThingAttr.OnBottom:
                    flags.isOnBottom = true;
                    break;

                case ThingAttr.OnTop:
                    flags.isOnTop = true;
                    break;

                case ThingAttr.Container:
                    flags.isContainer = true;
                    break;

                case ThingAttr.Stackable:
                    flags.isStackable = true;
                    break;

                case ThingAttr.ForceUse:
                case ThingAttr.MultiUse:
                    break;

                case ThingAttr.Writable:
                case ThingAttr.WritableOnce:
                    off += 2; // maxTextLength (u16)
                    break;

                case ThingAttr.FluidContainer:
                    flags.isFluidContainer = true;
                    break;

                case ThingAttr.Splash:
                    flags.isSplash = true;
                    break;

                case ThingAttr.NotWalkable:
                    flags.isNotWalkable = true;
                    break;

                case ThingAttr.NotMoveable:
                    flags.isNotMoveable = true;
                    break;

                case ThingAttr.BlockProjectile:
                    flags.isBlockProjectile = true;
                    break;

                case ThingAttr.NotPathable:
                    flags.isNotPathable = true;
                    break;

                case ThingAttr.Pickupable:
                    flags.isPickupable = true;
                    break;

                case ThingAttr.Hangable:
                    flags.isHangable = true;
                    break;

                case ThingAttr.HookSouth:
                case ThingAttr.HookEast:
                case ThingAttr.Rotatable:
                    break;

                case ThingAttr.Light:
                    flags.lightLevel = buf.readUInt16LE(off); off += 2;
                    flags.lightColor = buf.readUInt16LE(off); off += 2;
                    break;

                case ThingAttr.DontHide:
                case ThingAttr.Translucent:
                    break;

                case ThingAttr.Displacement:
                    flags.displacementX = buf.readUInt16LE(off); off += 2;
                    flags.displacementY = buf.readUInt16LE(off); off += 2;
                    break;

                case ThingAttr.Elevation:
                    flags.hasElevation = true;
                    flags.elevation = buf.readUInt16LE(off); off += 2;
                    break;

                case ThingAttr.LyingCorpse:
                case ThingAttr.AnimateAlways:
                    break;

                case ThingAttr.MinimapColor:
                    flags.minimapColor = buf.readUInt16LE(off); off += 2;
                    break;

                case ThingAttr.LensHelp:
                    off += 2; // lensHelp(u16)
                    break;

                case ThingAttr.FullGround:
                    flags.isFullGround = true;
                    break;

                case ThingAttr.IgnoreLook:
                    break;

                case ThingAttr.Cloth:
                    off += 2; // clothSlot(u16)
                    break;

                case ThingAttr.Market:
                    // category(u16) + tradeAs(u16) + showAs(u16) + name(u16 len + string) + restrictVocation(u16) + requiredLevel(u16)
                    off += 2; // category
                    off += 2; // tradeAs
                    off += 2; // showAs
                    {
                        const nameLen = buf.readUInt16LE(off); off += 2;
                        off += nameLen; // name string
                    }
                    off += 2; // restrictVocation
                    off += 2; // requiredLevel
                    break;

                case ThingAttr.Usable:
                    off += 2; // u16
                    break;

                default:
                    // Unknown attribute — boolean flag with no data
                    break;
            }
        }

        // Parse sprite data (skip it — we just need the flags)
        const width = buf.readUInt8(off); off++;
        const height = buf.readUInt8(off); off++;

        if (width > 1 || height > 1) {
            off++; // exactSize
        }

        const layers = buf.readUInt8(off); off++;
        const patternX = buf.readUInt8(off); off++;
        const patternY = buf.readUInt8(off); off++;
        const patternZ = buf.readUInt8(off); off++;
        const animationPhases = buf.readUInt8(off); off++;

        if (animationPhases > 1) {
            // async(u8) + loopCount(i32) + startPhase(i8)
            off += 1 + 4 + 1;
            // Phase durations: min(u32) + max(u32) per phase
            off += animationPhases * 8;
        }

        const totalSprites = width * height * layers * patternX * patternY * patternZ * animationPhases;

        // Sprite IDs — uint32 each (in protocols >= 960 sprite IDs are 32-bit)
        off += totalSprites * 4;

        return { endOffset: off, flags };
    }
}

module.exports = DatParser;
