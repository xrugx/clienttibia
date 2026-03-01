'use strict';

/**
 * ConsoleDashboard - Painel no console que mostra contas online e personagens
 * 
 * Exibe periodicamente um painel formatado com:
 * - Total de contas/sessões online
 * - Lista de cada conta com seus personagens
 * - Status (online/offline), HP, MP, posição de cada personagem
 */

class ConsoleDashboard {
    /**
     * @param {import('../game/SessionManager')} sessionManager
     * @param {object} [options]
     * @param {number} [options.refreshInterval=3000] - Intervalo de atualização em ms
     * @param {boolean} [options.clearScreen=true] - Limpar tela antes de redesenhar
     * @param {object} [options.accounts] - Array de accounts do config (para agrupar personagens)
     */
    constructor(sessionManager, options = {}) {
        this.manager = sessionManager;
        this.refreshInterval = options.refreshInterval || 3000;
        this.clearScreen = options.clearScreen !== false;
        this.accountsConfig = options.accounts || [];
        this._timer = null;
        this._logBuffer = [];
        this._maxLogLines = 15;
    }

    /**
     * Inicia o painel com atualização periódica
     */
    start() {
        // Interceptar logs do console para exibir no painel
        this._interceptLogs();
        this._render();
        this._timer = setInterval(() => this._render(), this.refreshInterval);
    }

    /**
     * Para o painel
     */
    stop() {
        if (this._timer) {
            clearInterval(this._timer);
            this._timer = null;
        }
        this._restoreLogs();
    }

    /**
     * Adiciona uma mensagem ao buffer de log do painel
     * @param {string} message 
     */
    pushLog(message) {
        const lines = String(message).split('\n');
        for (const line of lines) {
            this._logBuffer.push(line);
        }
        // Manter apenas as últimas N linhas
        while (this._logBuffer.length > this._maxLogLines) {
            this._logBuffer.shift();
        }
    }

    /**
     * Intercepta console.log/warn/error para capturar no buffer
     * @private
     */
    _interceptLogs() {
        this._origLog = console.log;
        this._origWarn = console.warn;
        this._origError = console.error;

        const self = this;

        console.log = function (...args) {
            const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
            self.pushLog(msg);
        };

        console.warn = function (...args) {
            const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
            self.pushLog(`⚠ ${msg}`);
        };

        console.error = function (...args) {
            const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
            self.pushLog(`✖ ${msg}`);
        };
    }

    /**
     * Restaura console original
     * @private
     */
    _restoreLogs() {
        if (this._origLog) console.log = this._origLog;
        if (this._origWarn) console.warn = this._origWarn;
        if (this._origError) console.error = this._origError;
    }

    /**
     * Renderiza o painel no console
     * @private
     */
    _render() {
        const write = this._origLog || console.log;

        if (this.clearScreen) {
            process.stdout.write('\x1B[2J\x1B[H');
        }

        const now = new Date().toLocaleTimeString('pt-BR');
        const sessions = this.manager.getAll();
        const running = sessions.filter(s => s.isRunning);

        // ── Agrupar sessões por conta ──
        const accountMap = this._groupByAccount(sessions);
        const accountCount = Object.keys(accountMap).length;
        const onlineAccounts = Object.values(accountMap).filter(chars =>
            chars.some(s => s.isRunning)
        ).length;

        // ── Largura do painel ──
        const W = 78;
        const line = (char = '─') => char.repeat(W);

        // ── Header ──
        const lines = [];
        lines.push(`┌${line()}┐`);
        lines.push(`│${this._center('🎮  TIBIA CLIENT 8.60 - PAINEL DE CONTROLE', W)}│`);
        lines.push(`│${this._center(`Atualizado: ${now}`, W)}│`);
        lines.push(`├${line()}┤`);

        // ── Resumo ──
        const totalSessions = sessions.length;
        const onlineSessions = running.length;
        const offlineSessions = totalSessions - onlineSessions;

        lines.push(`│${this._pad(`  📊 Contas: ${onlineAccounts}/${accountCount} online    Personagens: ${onlineSessions}/${totalSessions} online    Offline: ${offlineSessions}`, W)}│`);
        lines.push(`├${line()}┤`);

        // ── Detalhe por conta ──
        const accountNames = Object.keys(accountMap);
        for (let i = 0; i < accountNames.length; i++) {
            const accName = accountNames[i];
            const accSessions = accountMap[accName];
            const accOnline = accSessions.filter(s => s.isRunning).length;
            const accTotal = accSessions.length;
            const accStatus = accOnline > 0 ? '🟢' : '🔴';

            lines.push(`│${this._pad(`  ${accStatus} Conta: ${accName}  (${accOnline}/${accTotal} online)`, W)}│`);
            lines.push(`│${this._pad(`  ${'─'.repeat(W - 4)}`, W)}│`);

            // Header da tabela de personagens
            const hdrName = 'Personagem'.padEnd(16);
            const hdrStatus = 'Status'.padEnd(10);
            const hdrHP = 'HP'.padEnd(12);
            const hdrMP = 'MP'.padEnd(12);
            const hdrPos = 'Posição'.padEnd(14);
            const hdrBots = 'Bots'.padEnd(10);
            lines.push(`│  ${this._pad(`  ${hdrName} ${hdrStatus} ${hdrHP} ${hdrMP} ${hdrPos} ${hdrBots}`, W - 2)}│`);

            for (const session of accSessions) {
                const player = session.getPlayer();
                const isOn = session.isRunning;

                const name = session.character.padEnd(16);
                const status = isOn ? '✅ Online'.padEnd(10) : '❌ Offline'.padEnd(10);

                let hp = '---'.padEnd(12);
                let mp = '---'.padEnd(12);
                let pos = '---'.padEnd(14);
                let bots = '---'.padEnd(10);

                if (isOn && player) {
                    const hpPct = player.maxHealth > 0 ? Math.round((player.health / player.maxHealth) * 100) : 0;
                    hp = `${player.health}/${player.maxHealth} (${hpPct}%)`.padEnd(12);

                    const mpPct = player.maxMana > 0 ? Math.round((player.mana / player.maxMana) * 100) : 0;
                    mp = `${player.mana}/${player.maxMana} (${mpPct}%)`.padEnd(12);

                    const pPos = session.getPlayerPosition();
                    if (pPos) {
                        pos = `${pPos.x},${pPos.y},${pPos.z}`.padEnd(14);
                    }

                    const cbOn = session.cavebot && session.cavebot._enabled && !session.cavebot._paused;
                    const mnOn = session.miner && session.miner.isMining;
                    const cbDot = cbOn ? '🟢' : '🔴';
                    const mnDot = mnOn ? '🟢' : '🔴';
                    bots = `${cbDot}C ${mnDot}M`;
                }

                lines.push(`│  ${this._pad(`  ${name} ${status} ${hp} ${mp} ${pos} ${bots}`, W - 2)}│`);
            }

            if (i < accountNames.length - 1) {
                lines.push(`├${line()}┤`);
            }
        }

        if (accountNames.length === 0) {
            lines.push(`│${this._center('Nenhuma conta registrada', W)}│`);
        }

        lines.push(`├${line()}┤`);

        // ── Log recente ──
        lines.push(`│${this._pad('  📝 Log Recente:', W)}│`);
        lines.push(`│${this._pad(`  ${'─'.repeat(W - 4)}`, W)}│`);

        const logLines = this._logBuffer.slice(-this._maxLogLines);
        if (logLines.length === 0) {
            lines.push(`│${this._pad('  (sem mensagens)', W)}│`);
        } else {
            for (const log of logLines) {
                // Truncar linhas muito longas
                const truncated = log.length > W - 4 ? log.substring(0, W - 7) + '...' : log;
                lines.push(`│${this._pad(`  ${truncated}`, W)}│`);
            }
        }

        lines.push(`└${line()}┘`);
        lines.push('  Pressione Ctrl+C para encerrar');

        write(lines.join('\n'));
    }

    /**
     * Agrupa sessões por nome da conta
     * @private
     * @param {Array} sessions
     * @returns {Object<string, Array>}
     */
    _groupByAccount(sessions) {
        const map = {};

        // Se temos config de contas, usar como base para manter ordem
        if (this.accountsConfig.length > 0) {
            for (const acc of this.accountsConfig) {
                map[acc.name] = [];
            }
        }

        for (const session of sessions) {
            const accName = session.account || 'desconhecida';
            if (!map[accName]) {
                map[accName] = [];
            }
            map[accName].push(session);
        }

        return map;
    }

    /**
     * Centraliza texto em uma largura
     * @private
     */
    _center(text, width) {
        // Conta o comprimento visual (emojis ocupam ~2 chars)
        const visualLen = this._visualLength(text);
        if (visualLen >= width) return text.substring(0, width);
        const left = Math.floor((width - visualLen) / 2);
        const right = width - visualLen - left;
        return ' '.repeat(left) + text + ' '.repeat(right);
    }

    /**
     * Preenche texto à direita até a largura
     * @private
     */
    _pad(text, width) {
        const visualLen = this._visualLength(text);
        if (visualLen >= width) return text.substring(0, width);
        return text + ' '.repeat(width - visualLen);
    }

    /**
     * Calcula comprimento visual (emojis = 2)
     * @private
     */
    _visualLength(str) {
        // Regex simplificada para emojis comuns
        const emojiRegex = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F000}-\u{1F02F}\u{1F0A0}-\u{1F0FF}]/gu;
        const emojis = str.match(emojiRegex);
        const emojiCount = emojis ? emojis.length : 0;
        // Cada emoji ocupa ~2 posições no terminal, mas o match conta como 1 char
        return str.replace(emojiRegex, '').length + emojiCount * 2;
    }
}

module.exports = ConsoleDashboard;
