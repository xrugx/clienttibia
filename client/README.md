# Tibia 8.60 Client - Node.js Edition

A fully functional, zero-dependency Node.js client for Tibia protocol version 8.60 (860). Built from scratch based on the OTCv8 client and TFS server source code protocol implementations.

## Features

- **Full Protocol 860 Implementation** — All client↔server opcodes
- **RSA Encryption** — 128-byte blocks with BigInt (default OTServ key)
- **XTEA Encryption** — 32 rounds, matching Tibia's implementation
- **Adler32 Checksum** — Packet integrity verification
- **Complete Packet Parsing** — Map, creatures, items, chat, containers, trade, shops, VIP, quests
- **Complete Packet Building** — Movement, combat, chat, trade, items, containers, outfits, spells
- **Zero Dependencies** — Pure Node.js, no external packages
- **Event-Driven Architecture** — EventEmitter-based for easy integration
- **Interactive CLI** — Terminal-based client for testing
- **Bot-Ready** — Easy to build automated scripts on top

## Requirements

- Node.js >= 16.0.0 (for BigInt support)
- A Tibia 8.60 compatible server (TFS 0.4+, OTServ, etc.)

## Quick Start

```bash
# Clone or copy the project
cd tibia-client

# Run the interactive CLI
node cli/Client.js

# Or with arguments
node cli/Client.js 127.0.0.1 7171 myaccount mypassword MyCharacter
```

## Project Structure

```
tibia-client/
├── index.js                          # Main entry point & exports
├── package.json
├── cli/
│   └── Client.js                     # Interactive CLI client
├── examples/
│   ├── basic-login.js                # Simple login example
│   ├── auto-healer.js                # Auto-healing bot example
│   └── chat-logger.js                # Chat logging example
├── tests/
│   ├── run-all.js                    # Test runner
│   ├── test-crypto.js                # Crypto module tests
│   ├── test-network-message.js       # NetworkMessage tests
│   └── test-entities.js              # Entity class tests
└── src/
    ├── constants/
    │   ├── Opcodes.js                # All protocol opcodes (8.60)
    │   └── GameConstants.js          # Game constants & enums
    ├── crypto/
    │   ├── adler32.js                # Adler32 checksum
    │   ├── xtea.js                   # XTEA encrypt/decrypt
    │   └── rsa.js                    # RSA encryption (BigInt)
    ├── network/
    │   ├── NetworkMessage.js         # Binary packet buffer R/W
    │   └── Connection.js             # TCP connection + framing
    ├── core/
    │   ├── Position.js               # 3D position (x, y, z)
    │   ├── Outfit.js                 # Creature outfit/appearance
    │   ├── Item.js                   # Game item (id + count)
    │   ├── Creature.js               # Creature entity
    │   ├── Player.js                 # Local player (stats/skills)
    │   ├── Tile.js                   # Map tile with things
    │   ├── Map.js                    # Tile storage (sparse hash)
    │   ├── Container.js              # Open container
    │   └── DatManager.js             # Runtime item type DB
    ├── protocol/
    │   ├── ProtocolLogin.js          # Login server protocol
    │   ├── ProtocolGame.js           # Game protocol dispatcher
    │   ├── GameParse.js              # Server→Client parsers
    │   └── GameSend.js               # Client→Server builders
    ├── game/
    │   └── Game.js                   # High-level game session
    └── utils/
        └── Logger.js                 # Configurable logger
```

## API Usage

### Basic Login

```javascript
const { Game } = require('./tibia-client');

const game = new Game({
    host: '127.0.0.1',
    loginPort: 7171,
    logLevel: 'info'
});

// Full login flow (login server → character select → game server)
await game.login('myaccount', 'mypassword', 'MyCharacter');

// Access the protocol for game actions
const proto = game.protocol;

// Listen for events
proto.on('textMessage', (data) => {
    console.log(`[MSG] ${data.message}`);
});

proto.on('creatureSpeak', (data) => {
    console.log(`${data.name}: ${data.message}`);
});

proto.on('playerStats', () => {
    console.log(`HP: ${proto.player.health}/${proto.player.maxHealth}`);
});
```

### Manual Login (Step by Step)

```javascript
const { Game } = require('./tibia-client');

const game = new Game({ host: '127.0.0.1', loginPort: 7171 });

// Step 1: Get character list
const charList = await game.getCharacterList('account', 'password');
console.log(charList.characters); // [{name, world, ip, port}, ...]

// Step 2: Select and connect to game server
const char = charList.characters[0];
await game.loginToGame('account', 'password', char.name, char.ip, char.port);
```

### Game Actions

```javascript
const proto = game.protocol;

// Movement
proto.walkNorth();
proto.walkSouth();
proto.walkEast();
proto.walkWest();
proto.walkNorthEast();
proto.turnNorth();

// Chat
proto.say('Hello!');
proto.whisper('Psst...');
proto.yell('HEY!');
proto.privateMessage('Player', 'Hi there');
proto.channelMessage(7, 'Hello channel'); // Game-Chat

// Combat
proto.attack(creatureId);
proto.follow(creatureId);
proto.cancelAttack();
proto.setFightModes(1, 1, 1); // offensive, chase, secure

// Items
proto.useItem(position, spriteId, stackPos);
proto.moveItem(fromPos, spriteId, fromStack, toPos, count);
proto.look(position, spriteId, stackPos);

// Containers
proto.sender.sendCloseContainer(containerId);
proto.sender.sendUpContainer(containerId);

// Trade
proto.sender.sendRequestTrade(position, spriteId, stackPos, creatureId);
proto.sender.sendAcceptTrade();
proto.sender.sendCloseTrade();

// Channels
proto.sender.sendGetChannels();
proto.sender.sendOpenChannel(channelId);
proto.sender.sendCloseChannel(channelId);

// Other
proto.sender.sendRequestOutfit();
proto.sender.sendRequestQuests();
proto.sender.sendAddVip('PlayerName');
proto.sender.sendRemoveVip(playerId);
proto.logout();
```

### Events

| Event | Data | Description |
|-------|------|-------------|
| `selfAppear` | `{creatureId, canReportBugs}` | Logged in successfully |
| `playerStats` | `{}` | Player stats updated |
| `playerSkills` | `{}` | Player skills updated |
| `textMessage` | `{type, message}` | System/status message |
| `creatureSpeak` | `{name, level, type, message, channelId?, position?}` | Chat message |
| `magicEffect` | `{position, type}` | Visual effect |
| `animatedText` | `{position, color, text}` | Animated text |
| `distanceEffect` | `{from, to, type}` | Projectile effect |
| `openContainer` | `{containerId, name, itemId, capacity, hasParent, items}` | Container opened |
| `closeContainer` | `{containerId}` | Container closed |
| `addContainerItem` | `{containerId, item}` | Item added to container |
| `updateContainerItem` | `{containerId, slot, item}` | Item updated in container |
| `removeContainerItem` | `{containerId, slot}` | Item removed from container |
| `setInventory` | `{slot, item}` | Inventory slot set |
| `removeInventory` | `{slot}` | Inventory slot cleared |
| `creatureMove` | `{creature, oldPos, newPos}` | Creature moved |
| `creatureHealth` | `{creatureId, percent}` | Creature health changed |
| `creatureOutfit` | `{creatureId, outfit}` | Creature appearance changed |
| `death` | `{deathPenalty}` | Player died |
| `vipEntry` | `{id, name, online}` | VIP list entry |
| `vipLogin` | `{id}` | VIP player came online |
| `vipLogout` | `{id}` | VIP player went offline |
| `channelList` | `{channels: [{id, name}]}` | Available channels |
| `openChannel` | `{channelId, name}` | Channel opened |
| `worldLight` | `{level, color}` | World light changed |
| `ping` | `{}` | Server ping |
| `disconnected` | `{}` | Connection lost |
| `error` | `Error` | Protocol error |

### Custom RSA Key

```javascript
const { RSA } = require('./tibia-client');

const rsa = new RSA();

// Set custom RSA key (hex)
rsa.setKey('hexP', 'hexQ');

// Set custom RSA key (decimal)
rsa.setKeyDecimal('decimalP', 'decimalQ');

// Use with game
const game = new Game({ host: '127.0.0.1', loginPort: 7171 });
// Access RSA through protocol internals
```

## Running Tests

```bash
# Run all tests
npm test

# Run individual test suites
node tests/test-crypto.js
node tests/test-network-message.js
node tests/test-entities.js
```

## Protocol Details

### Packet Structure

```
┌─────────┬─────────────┬──────────────┬───────────┐
│ 2 bytes │   4 bytes   │   2 bytes    │  N bytes  │
│  Size   │  Adler32    │ XTEA Length  │  Payload  │
│ (LE)    │  Checksum   │    (LE)      │ (XTEA)    │
└─────────┴─────────────┴──────────────┴───────────┘
```

### Login Flow

1. Client connects to login server (TCP port 7171)
2. Client sends login packet:
   - Opcode `0x01`
   - OS type (2 = Linux, 1 = Windows)
   - Protocol version `860`
   - RSA-encrypted block (128 bytes):
     - XTEA key (4 × uint32)
     - Account name (string)
     - Password (string)
     - Padding (zeros to 128 bytes)
3. Server responds with XTEA-encrypted:
   - MOTD (`0x14`) + character list (`0x64`)
   - Or error message (`0x0A`)

### Game Login Flow

1. Client connects to game server
2. Server sends challenge (`0x1F`) with timestamp + random number
3. Client sends game login packet:
   - Opcode `0x0A`
   - OS, version, RSA-encrypted block:
     - XTEA key, GM flag, account, character name, password
     - Challenge timestamp + random
4. Server sends initial game state:
   - Self appear (`0x0A`)
   - Map description (`0x64`)
   - Player stats, skills, icons, world light, etc.

### XTEA Implementation

- Algorithm: 32-round Feistel cipher
- Block size: 8 bytes (two 32-bit halves)
- Delta: `0x61C88647` (Tibia uses negated standard delta)
- Key: 4 × 32-bit unsigned integers
- Padding: `0x33` bytes to align to 8-byte boundary

### Map Format

- Visible area: 18×14 tiles (AWARE_X × AWARE_Y)
- Underground floors: current ± 2
- Surface floors: 0-7 (when on surface), current-2 to current+2 (underground)
- Tile data: sequential things until skip marker (`>= 0xFF00`)
- Thing types: `0x61` = unknown creature, `0x62` = known creature, `0x63` = creature turn

## Architecture Notes

- **Zero external dependencies** — Everything is implemented with Node.js built-in modules
- **BigInt RSA** — Uses native BigInt for modular exponentiation (no crypto libraries)
- **Buffer-based networking** — Direct Buffer manipulation for packet reading/writing
- **Sparse map storage** — Hash map with string keys (`"x:y:z"`) for memory efficiency
- **DatManager** — Runtime item type learning (tracks stackable/fluid items from server data)
- **Event-driven** — All protocol events emit through Node.js EventEmitter

## License

MIT

## Credits

Based on protocol analysis of:
- **OTCv8** — Original Tibia Client (C++ source)
- **TFS** — The Forgotten Server (C++ source)
- **Tibia 8.60** — Protocol version 860 specification
