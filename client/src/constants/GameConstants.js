'use strict';

/**
 * Game constants for Tibia 8.60
 * Matches original client and server values
 */

module.exports = {
    // Protocol
    PROTOCOL_VERSION: 860,
    CLIENT_VERSION: 860,
    CLIENT_VERSION_STR: '8.60',

    // Network
    MAX_NETWORK_MESSAGE_SIZE: 24590,
    HEADER_SIZE: 2,
    CHECKSUM_SIZE: 4,
    INITIAL_BUFFER_POSITION: 8,
    MAX_BODY_LENGTH: 24576,

    // Map
    MAP_MAX_Z: 15,
    MAP_MIN_Z: 0,
    UNDERGROUND_FLOOR: 8,
    SEA_FLOOR: 7,
    MAP_AWARE_X: 18,      // Visible tiles width (8 left + 1 center + 9 right)
    MAP_AWARE_Y: 14,      // Visible tiles height (6 top + 1 center + 7 bottom)
    MAP_MAX_LAYERS: 16,   // 0-15
    MAP_VISIBLE_FLOORS: 8,
    TILE_MAX_THINGS: 10,  // Max items/creatures per tile

    // Inventory slots
    SLOT_HEAD: 1,
    SLOT_NECKLACE: 2,
    SLOT_BACKPACK: 3,
    SLOT_ARMOR: 4,
    SLOT_RIGHT: 5,
    SLOT_LEFT: 6,
    SLOT_LEGS: 7,
    SLOT_FEET: 8,
    SLOT_RING: 9,
    SLOT_AMMO: 10,
    SLOT_FIRST: 1,
    SLOT_LAST: 10,

    // Creature types
    CREATURE_UNKNOWN: 0x61,   // 97 - New creature (full data)
    CREATURE_KNOWN: 0x62,     // 98 - Known creature (update)
    CREATURE_TURN: 0x63,      // 99 - Creature turn only

    // Directions
    DIRECTION_NORTH: 0,
    DIRECTION_EAST: 1,
    DIRECTION_SOUTH: 2,
    DIRECTION_WEST: 3,
    DIRECTION_NORTHEAST: 4,
    DIRECTION_SOUTHEAST: 5,
    DIRECTION_SOUTHWEST: 6,
    DIRECTION_NORTHWEST: 7,

    // Fight modes
    FIGHTMODE_ATTACK: 1,
    FIGHTMODE_BALANCED: 2,
    FIGHTMODE_DEFENSE: 3,

    // Chase modes
    CHASEMODE_STAND: 0,
    CHASEMODE_CHASE: 1,

    // Secure mode
    SECUREMODE_OFF: 0,
    SECUREMODE_ON: 1,

    // Skull types
    SKULL_NONE: 0,
    SKULL_YELLOW: 1,
    SKULL_GREEN: 2,
    SKULL_WHITE: 3,
    SKULL_RED: 4,
    SKULL_BLACK: 5,

    // Shield types (party)
    SHIELD_NONE: 0,
    SHIELD_WHITEYELLOW: 1,
    SHIELD_WHITEBLUE: 2,
    SHIELD_BLUE: 3,
    SHIELD_YELLOW: 4,
    SHIELD_BLUE_SHAREDEXP: 5,
    SHIELD_YELLOW_SHAREDEXP: 6,
    SHIELD_BLUE_NOSHAREDEXP_BLINK: 7,
    SHIELD_YELLOW_NOSHAREDEXP_BLINK: 8,
    SHIELD_BLUE_NOSHAREDEXP: 9,
    SHIELD_YELLOW_NOSHAREDEXP: 10,

    // Speech/message types (client → server)
    SPEAK_SAY: 1,
    SPEAK_WHISPER: 2,
    SPEAK_YELL: 3,
    SPEAK_PRIVATE_PN: 4,
    SPEAK_PRIVATE_NP: 5,
    SPEAK_PRIVATE: 6,
    SPEAK_CHANNEL_Y: 7,
    SPEAK_CHANNEL_W: 8,
    SPEAK_RVR_CHANNEL: 9,
    SPEAK_RVR_ANSWER: 10,
    SPEAK_RVR_CONTINUE: 11,
    SPEAK_BROADCAST: 12,
    SPEAK_CHANNEL_R1: 13,
    SPEAK_PRIVATE_RED: 14,
    SPEAK_CHANNEL_O: 15,
    SPEAK_CHANNEL_R2: 16,  // Anonymous GM
    SPEAK_MONSTER_SAY: 19,
    SPEAK_MONSTER_YELL: 20,

    // Text message types (server → client in 0xB4)
    MSG_RED_CONSOLE: 18,
    MSG_ORANGE_EVENT: 19,
    MSG_ORANGE_CONSOLE: 20,
    MSG_RED_CENTER_CONSOLE: 21,
    MSG_WHITE_CENTER_CONSOLE: 22,
    MSG_WHITE_BOTTOM_CONSOLE: 23,
    MSG_WHITE_BOTTOM_CONSOLE2: 24,
    MSG_GREEN_CENTER_CONSOLE: 25,
    MSG_WHITE_BOTTOM: 26,
    MSG_BLUE_CONSOLE: 27,

    // Status icons (bitmask)
    ICON_POISON: 1 << 0,
    ICON_BURN: 1 << 1,
    ICON_ENERGY: 1 << 2,
    ICON_DRUNK: 1 << 3,
    ICON_MANASHIELD: 1 << 4,
    ICON_PARALYZE: 1 << 5,
    ICON_HASTE: 1 << 6,
    ICON_SWORDS: 1 << 7,
    ICON_DROWNING: 1 << 8,
    ICON_FREEZING: 1 << 9,
    ICON_DAZZLED: 1 << 10,
    ICON_CURSED: 1 << 11,
    ICON_BUFF: 1 << 12,
    ICON_PZBLOCK: 1 << 13,
    ICON_PZ: 1 << 14,
    ICON_BLEED: 1 << 15,
    ICON_HUNGRY: 1 << 16,

    // Channel IDs
    CHANNEL_GUILD: 0x00,
    CHANNEL_PARTY: 0x01,
    CHANNEL_RULEVIOLATIONS: 0x03,
    CHANNEL_HELP: 0x09,
    CHANNEL_LOOT: 0x15,
    CHANNEL_DEFAULT: 0xFFFE,
    CHANNEL_PRIVATE: 0xFFFF,

    // AutoWalk directions (used in path)
    PATH_EAST: 1,
    PATH_NORTHEAST: 2,
    PATH_NORTH: 3,
    PATH_NORTHWEST: 4,
    PATH_WEST: 5,
    PATH_SOUTHWEST: 6,
    PATH_SOUTH: 7,
    PATH_SOUTHEAST: 8,

    // Magic effects (0-based, but sent as type+1 on wire for distance)
    EFFECT_DRAW_BLOOD: 0,
    EFFECT_LOSE_ENERGY: 1,
    EFFECT_POFF: 2,
    EFFECT_BLOCK_HIT: 3,
    EFFECT_EXPLOSION: 4,
    EFFECT_EXPLOSION_AREA: 5,
    EFFECT_FIRE_AREA: 6,
    EFFECT_YELLOW_RINGS: 7,
    EFFECT_GREEN_RINGS: 8,
    EFFECT_HIT_AREA: 9,
    EFFECT_TELEPORT: 10,
    EFFECT_ENERGY_HIT: 11,
    EFFECT_MAGIC_BLUE: 13,
    EFFECT_MAGIC_RED: 14,
    EFFECT_MAGIC_GREEN: 15,
    EFFECT_HIT_BY_FIRE: 16,
    EFFECT_HIT_BY_POISON: 17,
    EFFECT_MORT_AREA: 18,
    EFFECT_SOUND_GREEN: 19,
    EFFECT_SOUND_RED: 20,
    EFFECT_POISON_AREA: 21,
    EFFECT_SOUND_YELLOW: 22,
    EFFECT_SOUND_PURPLE: 23,
    EFFECT_SOUND_BLUE: 24,
    EFFECT_SOUND_WHITE: 25,

    // Skills
    SKILL_FIST: 0,
    SKILL_CLUB: 1,
    SKILL_SWORD: 2,
    SKILL_AXE: 3,
    SKILL_DISTANCE: 4,
    SKILL_SHIELD: 5,
    SKILL_FISHING: 6,
    SKILL_COUNT: 7,

    // Operating system identifier (sent in login)
    OS_LINUX: 1,
    OS_WINDOWS: 2,
    OS_FLASH: 3,
    OS_OTCLIENT: 10,

    // Beat duration (server tick rate, ms)
    BEAT_DURATION: 50,
};
