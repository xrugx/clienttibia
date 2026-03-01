'use strict';

// Suppress all console output
const _noop = () => {};
console.log = _noop;
console.info = _noop;
console.warn = _noop;
console.error = _noop;
console.debug = _noop;

const fs = require('fs');
const path = require('path');

let config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const { SessionManager } = require('./src/game');
const { CaveBot, Miner, AutoMessage, AutoCommand, OutfitChanger } = require('./src/bot');
const WebDashboard = require('./src/utils/WebDashboard');

const CONFIG_PATH = path.join(__dirname, 'config.json');

function loadConfig() {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return config;
}

function saveConfig(newConfig) {
    config = newConfig;
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 4), 'utf8');
}

function getConfig() {
    return config;
}

(async () => {
    const manager = new SessionManager({
        host:      config.server.host,
        loginPort: config.server.loginPort,
        gamePort:  config.server.gamePort,
        rsaKey:    config.rsa.publicKey,
        logLevel:  'none',
        reconnect: config.reconnect,
    });

    function loadSessionsFromConfig() {
        for (const acc of config.accounts) {
            for (const charName of acc.characters) {
                manager.addAccount({
                    account:   acc.name,
                    password:  acc.password,
                    character: charName,
                    reconnect: config.reconnect,
                });
            }
        }
    }

    loadSessionsFromConfig();

    function getFirstCharacterName() {
        if (config.accounts && config.accounts.length > 0 && config.accounts[0].characters && config.accounts[0].characters.length > 0) {
            return config.accounts[0].characters[0].toLowerCase();
        }
        return null;
    }

    const dashCfg = config.dashboard || {};
    const dashboardPort = dashCfg.port || 443;
    const dashboard = new WebDashboard(manager, {
        port: dashboardPort,
        refreshInterval: 1000,
        serverConfig: config.server,
        accounts: config.accounts,
        ssl: dashCfg.ssl || null,
        domain: dashCfg.domain || 'localhost',
        password: dashCfg.password || 'admin',
    });
    await dashboard.start();
    global.__dashboard = dashboard;
    global.__sessionManager = manager;

    const delay = config.multiAccount?.delayBetweenLogins ?? 2000;

    function attachCaveBot(session) {
        if (!config.cavebot || !config.cavebot.enabled) return;
        const cavebotConfig = config.cavebot;
        const bot = new CaveBot(session, {
            enabled: true,
            waypoints: cavebotConfig.waypoints,
            loop: cavebotConfig.loop,
            skipBlocked: cavebotConfig.skipBlocked,
            maxRetries: cavebotConfig.maxRetries,
            waypointDelay: cavebotConfig.waypointDelay,
            walker: cavebotConfig.walker,
        });
        session.cavebot = bot;
    }

    function attachMiner(session) {
        if (!config.miner || !config.miner.enabled) return;
        const minerConfig = config.miner;
        const miner = new Miner(session, {
            stoneId: minerConfig.stoneId,
            pickId: minerConfig.pickId,
            mineDelay: minerConfig.mineDelay,
            scanInterval: minerConfig.scanInterval,
            enabled: true,
        });
        session.miner = miner;
        miner.start();
    }

    function attachAutoMessage(session) {
        if (!config.autoMessage || !config.autoMessage.enabled) return;
        const amConfig = config.autoMessage;
        const autoMsg = new AutoMessage(session, {
            enabled: true,
            messages: amConfig.messages,
            interval: amConfig.interval,
            type: amConfig.type,
            channelId: amConfig.channelId,
            random: amConfig.random,
        });
        session.autoMessage = autoMsg;
        autoMsg.start();
    }

    function attachGlobalAutoChat(session) {
        if (!config.globalAutoChat || !config.globalAutoChat.enabled) return;
        const gac = config.globalAutoChat;
        const autoChat = new AutoMessage(session, {
            enabled: true,
            messages: gac.messages,
            interval: gac.interval,
            type: gac.type,
            channelId: gac.channelId,
            random: gac.random,
        });
        session.globalAutoChat = autoChat;
        autoChat.start();
    }

    function attachAutoCommand(session) {
        if (!config.autoCommand || !config.autoCommand.enabled) return;
        const acConfig = config.autoCommand;
        const autoCmd = new AutoCommand(session, {
            enabled: true,
            commands: acConfig.commands,
            interval: acConfig.interval,
            type: acConfig.type,
            random: acConfig.random,
            responseTimeout: acConfig.responseTimeout,
            loop: acConfig.loop,
            transfer: acConfig.transfer,
        });
        session.autoCommand = autoCmd;
        autoCmd.start();
    }

    function attachOutfitChanger(session) {
        if (!config.outfitChanger || !config.outfitChanger.enabled) return;
        const ocConfig = config.outfitChanger;
        const changer = new OutfitChanger(session, {
            enabled: true,
            interval: ocConfig.interval || 30000,
        });
        session.outfitChanger = changer;
        changer.start();
    }

    manager.startAll(delay).then((results) => {
        const firstChar = getFirstCharacterName();
        for (const session of manager.getRunning()) {
            if (!session.cavebot) attachCaveBot(session);
            if (!session.miner) attachMiner(session);
            if (!session.autoMessage && firstChar && session.character?.toLowerCase() === firstChar) attachAutoMessage(session);
            if (!session.autoCommand) attachAutoCommand(session);
            if (!session.globalAutoChat) attachGlobalAutoChat(session);
            if (!session.outfitChanger) attachOutfitChanger(session);
        }
    });

    manager.on('sessionStarted', (d) => {
        const session = manager.getByCharacter(d.character);
        const firstChar = getFirstCharacterName();
        if (session && !session.cavebot) attachCaveBot(session);
        if (session && !session.miner) attachMiner(session);
        if (session && !session.autoMessage && firstChar && session.character?.toLowerCase() === firstChar) attachAutoMessage(session);
        if (session && !session.autoCommand) attachAutoCommand(session);
        if (session && !session.globalAutoChat) attachGlobalAutoChat(session);
        if (session && !session.outfitChanger) attachOutfitChanger(session);
    });

    // ── Restart all: stop everything, reload config, recreate sessions ──
    async function restartAll() {
        // Stop all bots for each session
        for (const session of manager.getAll()) {
            if (session.cavebot) { try { session.cavebot.stop(); } catch(_){} session.cavebot = null; }
            if (session.miner) { try { session.miner.stop(); } catch(_){} session.miner = null; }
            if (session.autoMessage) { try { session.autoMessage.stop(); } catch(_){} session.autoMessage = null; }
            if (session.autoCommand) { try { session.autoCommand.stop(); } catch(_){} session.autoCommand = null; }
            if (session.globalAutoChat) { try { session.globalAutoChat.stop(); } catch(_){} session.globalAutoChat = null; }
            if (session.outfitChanger) { try { session.outfitChanger.stop(); } catch(_){} session.outfitChanger = null; }
        }

        // Stop all sessions
        manager.stopAll();

        // Clear all sessions from the manager
        for (const session of manager.getAll()) {
            session.removeAllListeners();
        }
        manager.sessions.clear();

        // Reload config from disk
        loadConfig();

        // Update dashboard accounts config reference
        dashboard.accountsConfig = config.accounts;

        // Reload sessions from config
        loadSessionsFromConfig();

        // Start all with delay
        const newDelay = config.multiAccount?.delayBetweenLogins ?? 2000;
        const results = await manager.startAll(newDelay);

        const firstChar = getFirstCharacterName();
        for (const session of manager.getRunning()) {
            if (!session.cavebot) attachCaveBot(session);
            if (!session.miner) attachMiner(session);
            if (!session.autoMessage && firstChar && session.character?.toLowerCase() === firstChar) attachAutoMessage(session);
            if (!session.autoCommand) attachAutoCommand(session);
            if (!session.globalAutoChat) attachGlobalAutoChat(session);
            if (!session.outfitChanger) attachOutfitChanger(session);
        }

        return results;
    }

    // ── Connect a single character by session ID ──
    async function connectCharacter(sessionId) {
        const session = manager.getById(sessionId);
        if (!session) throw new Error(`Session ${sessionId} not found`);
        if (session.isRunning) return;
        await session.start();
        // Reattach bots after connecting
        const firstChar = getFirstCharacterName();
        if (!session.cavebot) attachCaveBot(session);
        if (!session.miner) attachMiner(session);
        if (!session.autoMessage && firstChar && session.character?.toLowerCase() === firstChar) attachAutoMessage(session);
        if (!session.autoCommand) attachAutoCommand(session);
        if (!session.globalAutoChat) attachGlobalAutoChat(session);
        if (!session.outfitChanger) attachOutfitChanger(session);
    }

    // ── Disconnect a single character by session ID ──
    function disconnectCharacter(sessionId) {
        const session = manager.getById(sessionId);
        if (!session) throw new Error(`Session ${sessionId} not found`);
        // Stop all bots first
        if (session.cavebot) { try { session.cavebot.stop(); } catch(_){} session.cavebot = null; }
        if (session.miner) { try { session.miner.stop(); } catch(_){} session.miner = null; }
        if (session.autoMessage) { try { session.autoMessage.stop(); } catch(_){} session.autoMessage = null; }
        if (session.autoCommand) { try { session.autoCommand.stop(); } catch(_){} session.autoCommand = null; }
        if (session.globalAutoChat) { try { session.globalAutoChat.stop(); } catch(_){} session.globalAutoChat = null; }
        if (session.outfitChanger) { try { session.outfitChanger.stop(); } catch(_){} session.outfitChanger = null; }
        // Stop the session (sets _stopped=true, disables auto-reconnect)
        session.stop();
    }

    // ── Walk all online characters in a given direction ──
    function walkAll(direction) {
        const running = manager.getRunning();
        let moved = 0;
        for (const session of running) {
            const sender = session.getSender();
            if (!sender) continue;
            try {
                switch (direction) {
                    case 'north':     sender.sendWalkNorth(); break;
                    case 'south':     sender.sendWalkSouth(); break;
                    case 'east':      sender.sendWalkEast(); break;
                    case 'west':      sender.sendWalkWest(); break;
                    case 'northeast': sender.sendWalkNorthEast(); break;
                    case 'northwest': sender.sendWalkNorthWest(); break;
                    case 'southeast': sender.sendWalkSouthEast(); break;
                    case 'southwest': sender.sendWalkSouthWest(); break;
                }
                moved++;
            } catch (_) {}
        }
        return { moved, total: running.length };
    }

    // Expose functions globally for WebDashboard API
    global.__getConfig = getConfig;
    global.__saveConfig = saveConfig;
    global.__restartAll = restartAll;
    global.__connectCharacter = connectCharacter;
    global.__disconnectCharacter = disconnectCharacter;
    global.__walkAll = walkAll;

    // ── Global AutoChat: start on all running sessions ──
    function globalAutoChatStart(options) {
        // Update config
        if (!config.globalAutoChat) config.globalAutoChat = {};
        config.globalAutoChat.enabled = true;
        if (options.messages !== undefined) config.globalAutoChat.messages = options.messages;
        if (options.interval !== undefined) config.globalAutoChat.interval = options.interval;
        if (options.type !== undefined) config.globalAutoChat.type = options.type;
        if (options.channelId !== undefined) config.globalAutoChat.channelId = options.channelId;
        if (options.random !== undefined) config.globalAutoChat.random = options.random;
        saveConfig(config);

        // Attach to all running sessions
        for (const session of manager.getRunning()) {
            // Stop existing if any
            if (session.globalAutoChat) { try { session.globalAutoChat.stop(); } catch(_){} session.globalAutoChat = null; }
            attachGlobalAutoChat(session);
        }
        return { started: manager.getRunning().length };
    }

    // ── Global AutoChat: stop on all sessions ──
    function globalAutoChatStop() {
        if (config.globalAutoChat) {
            config.globalAutoChat.enabled = false;
            saveConfig(config);
        }
        let stopped = 0;
        for (const session of manager.getAll()) {
            if (session.globalAutoChat) {
                try { session.globalAutoChat.stop(); } catch(_){}
                session.globalAutoChat = null;
                stopped++;
            }
        }
        return { stopped };
    }

    // ── Global AutoChat: get current status ──
    function globalAutoChatStatus() {
        const gac = config.globalAutoChat || {};
        const running = manager.getAll().filter(s => s.globalAutoChat && s.globalAutoChat._running).length;
        return {
            enabled: gac.enabled || false,
            messages: gac.messages || [],
            interval: gac.interval || 120000,
            type: gac.type || 1,
            channelId: gac.channelId || 0,
            random: gac.random || false,
            activeOn: running,
            totalSessions: manager.getAll().length,
        };
    }

    global.__globalAutoChatStart = globalAutoChatStart;
    global.__globalAutoChatStop = globalAutoChatStop;
    global.__globalAutoChatStatus = globalAutoChatStatus;

    process.on('SIGINT', () => {
        dashboard.stop();
        manager.stopAll();
        process.exit(0);
    });

    process.on('uncaughtException', (err) => {
        // Safety net: prevent process crash on unhandled errors
    });

    process.on('unhandledRejection', (reason) => {
        // Safety net: prevent process crash on unhandled promise rejections
    });
})();
