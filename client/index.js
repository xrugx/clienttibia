'use strict';

/**
 * Tibia Client 8.60 - Node.js Implementation
 * 
 * A complete protocol implementation for Tibia 8.60 servers,
 * matching the original OTClient behavior.
 * 
 * @example
 * const { Game } = require('./');
 * 
 * const game = new Game({
 *     host: '127.0.0.1',
 *     loginPort: 7171,
 *     gamePort: 7172
 * });
 * 
 * // Full login flow
 * await game.login('account', 'password', 'CharacterName');
 * 
 * // Listen to events
 * game.on('textMessage', (data) => console.log(data.message));
 * game.on('creatureSpeak', (data) => console.log(`${data.name}: ${data.message}`));
 * 
 * // Interact
 * game.protocol.say('Hello!');
 * game.protocol.walkNorth();
 */

// Core
const { Position, Outfit, Item, Creature, Player, Tile, GameMap, Container } = require('./src/core');
const DatManager = require('./src/core/DatManager');

// Crypto
const { RSA, XTEA, adler32 } = require('./src/crypto');

// Network
const { NetworkMessage, Connection } = require('./src/network');

// Protocol
const { ProtocolLogin, ProtocolGame, GameParse, GameSend } = require('./src/protocol');

// Game
const { Game, GameSession, SessionManager } = require('./src/game');

// Bot
const { Pathfinder, Walker, CaveBot } = require('./src/bot');

// Constants
const Constants = require('./src/constants');

// Utils
const { Logger, ConsoleDashboard } = require('./src/utils');

// Config (JSON)
const config = require('./config.json');

module.exports = {
    // Main entry point
    Game,
    GameSession,
    SessionManager,

    // Config
    config,

    // Protocol
    ProtocolLogin,
    ProtocolGame,
    GameParse,
    GameSend,

    // Core entities
    Position,
    Outfit,
    Item,
    Creature,
    Player,
    Tile,
    GameMap,
    Container,
    DatManager,

    // Network
    NetworkMessage,
    Connection,

    // Crypto
    RSA,
    XTEA,
    adler32,

    // Constants
    Constants,

    // Utils
    Logger,
    ConsoleDashboard,

    // Bot
    Pathfinder,
    Walker,
    CaveBot
};


// ─── Auto-start quando executado diretamente (Multi-Account) ───────────────
if (require.main === module) {
    (async () => {
        const logger = new Logger('Main');
        logger.setLevel(config.logging.level);

        // ── Criar o SessionManager com as configs padrão do servidor ──
        const manager = new SessionManager({
            host:      config.server.host,
            loginPort: config.server.loginPort,
            gamePort:  config.server.gamePort,
            rsaKey:    config.rsa.publicKey,
            logLevel:  config.logging.level,
            reconnect: config.reconnect,
        });

        // ── Registrar todas as contas do config ──
        for (const acc of config.accounts) {
            for (const charName of acc.characters) {
                const session = manager.addAccount({
                    account:   acc.name,
                    password:  acc.password,
                    character: charName,
                    reconnect: config.reconnect,
                });

                // Eventos por sessão
                session.on('textMessage', (d) =>
                    logger.info(`[${session.label}][Msg] ${d.message}`));
                session.on('creatureSpeak', (d) =>
                    logger.info(`[${session.label}][Chat] ${d.name}: ${d.message}`));
                session.on('playerStats', () => {
                    const p = session.getPlayer();
                    if (p) logger.info(`[${session.label}][Stats] HP: ${p.health}/${p.maxHealth}  MP: ${p.mana}/${p.maxMana}`);
                });
                session.on('death', () =>
                    logger.warn(`[${session.label}] Morreu!`));
            }
        }

        // ── Eventos globais do manager ──
        manager.on('sessionStarted', (d) =>
            logger.info(`✔ ${d.character} conectado (Session #${d.sessionId})`));
        manager.on('sessionDisconnected', (d) =>
            logger.warn(`✘ ${d.character} desconectado (Session #${d.sessionId})`));
        manager.on('sessionError', (d) =>
            logger.error(`Erro em ${d.character}: ${d.error.message}`));
        manager.on('sessionReconnectFailed', (d) =>
            logger.error(`Reconexão de ${d.character} esgotada`));

        // ── Iniciar todas as sessões ──
        const delay = config.multiAccount?.delayBetweenLogins ?? 2000;
        logger.info(`Iniciando ${manager.size} sessão(ões) com ${delay}ms de intervalo...`);

        const results = await manager.startAll(delay);

        const ok = results.filter(r => r.status === 'ok');
        const fail = results.filter(r => r.status === 'error');

        if (ok.length > 0) {
            logger.info(`${ok.length} conta(s) conectada(s): ${ok.map(r => r.character).join(', ')}`);
        }
        if (fail.length > 0) {
            logger.error(`${fail.length} conta(s) falharam: ${fail.map(r => `${r.character} (${r.error})`).join(', ')}`);
        }
        if (ok.length === 0) {
            logger.error('Nenhuma conta conseguiu conectar. Encerrando.');
            process.exit(1);
        }

        // ── Expor o manager globalmente para scripts externos ──
        global.__sessionManager = manager;

        // ── Painel do Console ──
        const dashboard = new ConsoleDashboard(manager, {
            refreshInterval: 2000,
            clearScreen: true,
            accounts: config.accounts,
        });
        dashboard.start();
        global.__dashboard = dashboard;

        // ── CaveBot: anexar a todas as sessões com config única ──
        if (config.cavebot && config.cavebot.enabled) {
            const cavebotConfig = config.cavebot;
            logger.info(`CaveBot ativado com ${cavebotConfig.waypoints.length} waypoint(s)`);

            for (const session of manager.getRunning()) {
                const bot = new CaveBot(session, {
                    enabled: true,
                    waypoints: cavebotConfig.waypoints,
                    loop: cavebotConfig.loop,
                    skipBlocked: cavebotConfig.skipBlocked,
                    maxRetries: cavebotConfig.maxRetries,
                    waypointDelay: cavebotConfig.waypointDelay,
                    walker: cavebotConfig.walker,
                });

                // Guardar referência no session para acesso externo
                session.cavebot = bot;

                bot.on('waypointReached', (d) =>
                    logger.info(`[${session.label}][CaveBot] Chegou em ${d.waypoint}`));
                bot.on('walkFailed', (d) =>
                    logger.warn(`[${session.label}][CaveBot] Falha ao ir para ${d.waypoint}: ${d.reason}`));
                bot.on('waypointSkipped', (d) =>
                    logger.warn(`[${session.label}][CaveBot] Pulou ${d.waypoint.label}`));
                bot.on('loopComplete', () =>
                    logger.info(`[${session.label}][CaveBot] Loop completo, recomeçando...`));
            }
        } else {
            logger.info('CaveBot desativado (config.cavebot.enabled = false)');
        }

        // ── Graceful shutdown ──
        process.on('SIGINT', () => {
            dashboard.stop();
            logger.info('Encerrando todas as sessões...');
            manager.stopAll();
            process.exit(0);
        });
    })();
}
