'use strict';

/**
 * All protocol opcodes for Tibia 8.60
 * Matches the original client and server implementation
 */

// ============================================================
// Client → Server Opcodes (packets the client sends)
// ============================================================
const ClientOpcodes = {
    // Login
    LoginServerRequest:     0x01,   // Login server request
    GameServerRequest:      0x0A,   // Game server login

    // Connection
    EnterGame:              0x0F,   // Enter game after pending
    LeaveGame:              0x14,   // Logout / disconnect
    Ping:                   0x1E,   // Keep-alive ping

    // Extended (OTClient)
    ExtendedOpcode:         0x32,   // Extended opcode

    // Movement
    AutoWalk:               0x64,   // Auto-walk with path
    WalkNorth:              0x65,
    WalkEast:               0x66,
    WalkSouth:              0x67,
    WalkWest:               0x68,
    StopAutoWalk:           0x69,
    WalkNorthEast:          0x6A,
    WalkSouthEast:          0x6B,
    WalkSouthWest:          0x6C,
    WalkNorthWest:          0x6D,

    // Turning
    TurnNorth:              0x6F,
    TurnEast:               0x70,
    TurnSouth:              0x71,
    TurnWest:               0x72,

    // Item interaction
    MoveItem:               0x78,   // Throw / move thing
    LookInShop:             0x79,   // Look at shop item
    PlayerPurchase:         0x7A,   // Buy from NPC
    PlayerSale:             0x7B,   // Sell to NPC
    CloseShop:              0x7C,   // Close NPC shop

    // Trading
    RequestTrade:           0x7D,   // Request player trade
    LookInTrade:            0x7E,   // Look at trade item
    AcceptTrade:            0x7F,   // Accept trade
    CloseTrade:             0x80,   // Reject/close trade

    // Item usage
    UseItem:                0x82,   // Use item
    UseItemEx:              0x83,   // Use item on target
    UseOnCreature:          0x84,   // Use item on creature (battle window)
    RotateItem:             0x85,   // Rotate item

    // Containers
    CloseContainer:         0x87,   // Close container
    UpContainer:            0x88,   // Go up in container

    // Text/house editing
    EditText:               0x89,   // Edit text (writable items)
    EditHouseText:          0x8A,   // Edit house text

    // Looking
    Look:                   0x8C,   // Look at position
    LookCreature:           0x8D,   // Look at creature in battle list

    // Chat
    Say:                    0x96,   // Say/whisper/yell/channel message
    GetChannels:            0x97,   // Request channel list
    OpenChannel:            0x98,   // Open channel
    CloseChannel:           0x99,   // Close channel
    OpenPrivateChannel:     0x9A,   // Open private message channel

    // Rule violations
    ProcessRuleViolation:   0x9B,
    CloseRuleViolation:     0x9C,
    CancelRuleViolation:    0x9D,

    // NPC
    CloseNPCChannel:        0x9E,   // Close NPC channel

    // Combat
    ChangeFightModes:       0xA0,   // Change fight/chase/secure mode
    Attack:                 0xA1,   // Attack creature
    Follow:                 0xA2,   // Follow creature

    // Party
    InviteToParty:          0xA3,
    JoinParty:              0xA4,
    RevokePartyInvite:      0xA5,
    PassPartyLeadership:    0xA6,
    LeaveParty:             0xA7,
    SharePartyExperience:   0xA8,

    // Private channel
    CreatePrivateChannel:   0xAA,
    ChannelInvite:          0xAB,
    ChannelExclude:         0xAC,

    // Cancel
    CancelAttackAndFollow:  0xBE,   // Cancel attack and follow

    // Refresh
    UpdateTile:             0xC9,   // Request tile update
    UpdateContainer:        0xCA,   // Request container update

    // Outfits
    RequestOutfit:          0xD2,   // Request outfit dialog
    SetOutfit:              0xD3,   // Change outfit

    // VIP
    AddVip:                 0xDC,   // Add VIP
    RemoveVip:              0xDD,   // Remove VIP

    // Reports
    BugReport:              0xE6,   // Bug report
    ViolationWindow:        0xE7,   // Rule violation report
    DebugAssert:            0xE8,   // Debug assertion

    // Quests
    RequestQuests:          0xF0,   // Request quest log
    RequestQuestInfo:       0xF1,   // Request quest details

    // Rule violation report v2
    ViolationReport:        0xF2,
};

// ============================================================
// Server → Client Opcodes (packets the server sends)
// ============================================================
const ServerOpcodes = {
    // Connection / Authentication
    SelfAppear:             0x0A,   // Player login (self appear)
    GMActions:              0x0B,   // GM violation actions
    ErrorMessage:           0x14,   // Login error / MOTD
    FYIMessage:             0x15,   // FYI box
    WaitingList:            0x16,   // Waiting list
    Ping:                   0x1E,   // Ping
    Challenge:              0x1F,   // Connection challenge (game server sends first)
    Death:                  0x28,   // Death / re-login window

    // Extended (OTClient)
    ExtendedOpcode:         0x32,   // Extended opcode

    // Map
    FullMap:                0x64,   // Full map description
    MapTopRow:              0x65,   // Map row north (walk north)
    MapRightColumn:         0x66,   // Map column east (walk east)
    MapBottomRow:           0x67,   // Map row south (walk south)
    MapLeftColumn:          0x68,   // Map column west (walk west)
    UpdateTile:             0x69,   // Tile update
    AddThingToTile:         0x6A,   // Add thing to tile
    UpdateThingOnTile:      0x6B,   // Update thing on tile
    RemoveThingFromTile:    0x6C,   // Remove thing from tile
    MoveCreature:           0x6D,   // Move creature

    // Containers
    OpenContainer:          0x6E,   // Open container
    CloseContainer:         0x6F,   // Close container
    AddContainerItem:       0x70,   // Add item to container
    UpdateContainerItem:    0x71,   // Update item in container
    RemoveContainerItem:    0x72,   // Remove item from container

    // Inventory
    SetInventory:           0x78,   // Set inventory slot
    RemoveInventory:        0x79,   // Clear inventory slot

    // NPC Trade
    OpenShop:               0x7A,   // Open NPC shop
    ShopGoods:              0x7B,   // Update shop goods / sale list
    CloseShop:              0x7C,   // Close NPC shop

    // Player Trade
    OwnTradeOffer:          0x7D,   // Own trade offer
    CounterTradeOffer:      0x7E,   // Counter trade offer
    CloseTrade:             0x7F,   // Close trade

    // Environment
    WorldLight:             0x82,   // Set world light
    MagicEffect:            0x83,   // Magic effect at position
    AnimatedText:           0x84,   // Animated text at position
    DistanceEffect:         0x85,   // Projectile / distance shoot
    CreatureSquare:         0x86,   // Creature mark/square

    // Creature updates
    CreatureHealth:         0x8C,   // Creature health percent
    CreatureLight:          0x8D,   // Creature light
    CreatureOutfit:         0x8E,   // Creature outfit change
    CreatureSpeed:          0x8F,   // Creature speed
    CreatureSkull:          0x90,   // Creature skull type
    CreatureShield:         0x91,   // Creature party shield
    CreatureWalkthrough:    0x92,   // Creature passability

    // Text windows
    EditTextWindow:         0x96,   // Open text edit window
    EditHouseWindow:        0x97,   // Open house edit window

    // Player data
    PlayerStats:            0xA0,   // Player stats (hp, mana, etc.)
    PlayerSkills:           0xA1,   // Player skills
    PlayerIcons:            0xA2,   // Status icons
    CancelTarget:           0xA3,   // Cancel target

    // Chat
    CreatureSpeak:          0xAA,   // Creature speak (chat message)
    ChannelList:            0xAB,   // Channel list dialog
    OpenChannel:            0xAC,   // Open channel
    OpenPrivateChannel:     0xAD,   // Open private channel
    RuleViolationChannel:   0xAE,   // Rule violation channel
    RemoveRuleViolation:    0xAF,   // Remove rule violation report
    CancelRuleViolation:    0xB0,   // Cancel rule violation
    LockRuleViolation:      0xB1,   // Lock rule violation
    CreateOwnChannel:       0xB2,   // Create own private channel
    CloseChannel:           0xB3,   // Close channel
    TextMessage:            0xB4,   // System text message
    CancelWalk:             0xB5,   // Cancel walk (direction)

    // Floor change
    FloorChangeUp:          0xBE,   // Floor change up
    FloorChangeDown:        0xBF,   // Floor change down

    // Outfit
    OutfitWindow:           0xC8,   // Outfit dialog

    // VIP
    VipEntry:               0xD2,   // VIP list entry
    VipLogin:               0xD3,   // VIP logged in
    VipLogout:              0xD4,   // VIP logged out

    // Tutorial
    TutorialHint:           0xDC,   // Tutorial hint
    MapMarker:              0xDD,   // Minimap marker

    // Quests
    QuestList:              0xF0,   // Quest log
    QuestInfo:              0xF1,   // Quest details
};

// ============================================================
// Login Server Opcodes
// ============================================================
const LoginServerOpcodes = {
    Error:                  0x0A,   // Error message
    MOTD:                   0x14,   // Message of the day
    UpdateNeeded:           0x1E,   // Client update required
    CharacterList:          0x64,   // Character list
};

module.exports = {
    ClientOpcodes,
    ServerOpcodes,
    LoginServerOpcodes
};
