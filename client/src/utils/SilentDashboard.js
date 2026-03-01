'use strict';

/**
 * SilentDashboard - Painel premium no console sem logs
 * 
 * Visual moderno com:
 * - Bordas duplas e cores
 * - IP e Porta do servidor
 * - Abas por conta com indicadores visuais
 * - Coordenadas em tempo real (X, Y, Z)
 * - Barras de HP/MP com gradiente de cores
 * - Status detalhado de cada personagem
 */

// ── Cores ANSI ──
const C = {
    reset:    '\x1b[0m',
    bold:     '\x1b[1m',
    dim:      '\x1b[2m',
    black:    '\x1b[30m',
    red:      '\x1b[31m',
    green:    '\x1b[32m',
    yellow:   '\x1b[33m',
    blue:     '\x1b[34m',
    magenta:  '\x1b[35m',
    cyan:     '\x1b[36m',
    white:    '\x1b[37m',
    gray:     '\x1b[90m',
    bRed:     '\x1b[91m',
    bGreen:   '\x1b[92m',
    bYellow:  '\x1b[93m',
    bBlue:    '\x1b[94m',
    bMagenta: '\x1b[95m',
    bCyan:    '\x1b[96m',
    bWhite:   '\x1b[97m',
    bgBlack:   '\x1b[40m',
    bgRed:     '\x1b[41m',
    bgGreen:   '\x1b[42m',
    bgYellow:  '\x1b[43m',
    bgBlue:    '\x1b[44m',
    bgMagenta: '\x1b[45m',
    bgCyan:    '\x1b[46m',
    bgWhite:   '\x1b[47m',
    bgGray:    '\x1b[100m',
};

class SilentDashboard {
    constructor(sessionManager, options = {}) {
        this.manager = sessionManager;
        this.refreshInterval = options.refreshInterval || 800;
        this.serverConfig = options.serverConfig || {};
        this.accountsConfig = options.accounts || [];
        this._timer = null;
        this._activeTab = 0;
        this._startTime = Date.now();
        this._frame = 0;
    }

    start() {
        this._silenceLogs();
        this._setupKeyboard();
        process.stdout.write('\x1b[?25l');
        this._render();
        this._timer = setInterval(() => this._render(), this.refreshInterval);
    }

    stop() {
        if (this._timer) {
            clearInterval(this._timer);
            this._timer = null;
        }
        process.stdout.write('\x1b[?25h');
        this._restoreLogs();
        if (process.stdin.isTTY) {
            process.stdin.setRawMode(false);
            process.stdin.pause();
        }
    }

    _silenceLogs() {
        this._origLog = console.log;
        this._origWarn = console.warn;
        this._origError = console.error;
        this._origDebug = console.debug;
        console.log = () => {};
        console.warn = () => {};
        console.error = () => {};
        console.debug = () => {};
    }

    _restoreLogs() {
        if (this._origLog) console.log = this._origLog;
        if (this._origWarn) console.warn = this._origWarn;
        if (this._origError) console.error = this._origError;
        if (this._origDebug) console.debug = this._origDebug;
    }

    _setupKeyboard() {
        if (!process.stdin.isTTY) return;
        process.stdin.setRawMode(true);
        process.stdin.resume();
        process.stdin.setEncoding('utf8');

        process.stdin.on('data', (key) => {
            if (key === '\u0003') {
                this.stop();
                process.emit('SIGINT');
                return;
            }
            const totalTabs = this.accountsConfig.length + 1;
            if (key === '\u001b[C' || key === '\t') {
                this._activeTab = (this._activeTab + 1) % totalTabs;
            } else if (key === '\u001b[D') {
                this._activeTab = (this._activeTab - 1 + totalTabs) % totalTabs;
            } else if (key >= '0' && key <= '9') {
                const idx = parseInt(key);
                if (idx < totalTabs) this._activeTab = idx;
            }
        });
    }

    _uptime() {
        const diff = Date.now() - this._startTime;
        const s = Math.floor(diff / 1000) % 60;
        const m = Math.floor(diff / 60000) % 60;
        const h = Math.floor(diff / 3600000);
        return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }

    // ═══════════════════════════════════════════════════════════
    //  RENDER PRINCIPAL
    // ═══════════════════════════════════════════════════════════
    _render() {
        this._frame++;
        const write = this._origLog || console.log;
        process.stdout.write('\x1B[2J\x1B[H');

        const now = new Date().toLocaleTimeString('pt-BR');
        const sessions = this.manager.getAll();
        const running = sessions.filter(s => s.isRunning);
        const accountMap = this._groupByAccount(sessions);
        const accountNames = Object.keys(accountMap);

        const W = 90;
        const out = [];

        // ╔══ HEADER ══╗
        out.push(this._boxTop(W));
        out.push(this._boxRow('', W));
        out.push(this._boxRow(this._center(this._titleArt(), W), W));
        out.push(this._boxRow('', W));
        out.push(this._boxMid(W));

        // ── SERVIDOR INFO ──
        const host = this.serverConfig.host || '???';
        const loginPort = this.serverConfig.loginPort || '???';
        const gamePort = this.serverConfig.gamePort || '???';
        const pulse = this._frame % 2 === 0 ? C.bGreen : C.green;

        out.push(this._boxRow(`  ${C.bold}${C.cyan}+-- Servidor ${'─'.repeat(62)}+${C.reset}`, W));
        out.push(this._boxRow(`  ${C.cyan}|${C.reset}  ${pulse}*${C.reset} ${C.bold}${C.white}Host:${C.reset} ${C.bCyan}${host}${C.reset}          ${C.bold}${C.white}Login:${C.reset} ${C.bYellow}${loginPort}${C.reset}    ${C.bold}${C.white}Game:${C.reset} ${C.bYellow}${gamePort}${C.reset}`, W, true));
        out.push(this._boxRow(`  ${C.cyan}|${C.reset}  ${C.gray}~${C.reset} ${C.bold}${C.white}Uptime:${C.reset} ${C.bGreen}${this._uptime()}${C.reset}       ${C.gray}@${C.reset} ${C.bold}${C.white}Hora:${C.reset} ${C.bWhite}${now}${C.reset}`, W, true));
        out.push(this._boxRow(`  ${C.cyan}+${'─'.repeat(75)}+${C.reset}`, W));

        // ── RESUMO ──
        const onlineAcc = Object.values(accountMap).filter(ch => ch.some(s => s.isRunning)).length;

        out.push(this._boxRow('', W));
        out.push(this._boxRow(`  ${C.bgGray}${C.bWhite}  # Contas: ${onlineAcc}/${accountNames.length}  |  @ Chars: ${running.length}/${sessions.length}  |  x Offline: ${sessions.length - running.length}  ${C.reset}`, W));
        out.push(this._boxRow('', W));
        out.push(this._boxMid(W));

        // ── ABAS ──
        let tabLine = ' ';
        if (this._activeTab === 0) {
            tabLine += ` ${C.bgCyan}${C.bold}${C.black} > GERAL ${C.reset}`;
        } else {
            tabLine += ` ${C.gray}  > GERAL  ${C.reset}`;
        }

        for (let i = 0; i < accountNames.length; i++) {
            const tabIdx = i + 1;
            const accName = accountNames[i];
            const accOn = accountMap[accName].filter(s => s.isRunning).length;
            const accT = accountMap[accName].length;
            const dot = accOn > 0 ? `${C.bGreen}*${C.reset}` : `${C.red}*${C.reset}`;

            if (this._activeTab === tabIdx) {
                tabLine += ` ${C.bgCyan}${C.bold}${C.black} ${accName} (${accOn}/${accT}) ${C.reset}`;
            } else {
                tabLine += ` ${C.gray} ${dot}${C.gray} ${accName} (${accOn}/${accT}) ${C.reset}`;
            }
        }

        out.push(this._boxRow(tabLine, W));
        out.push(this._boxMid(W));

        // ── CONTEUDO DA ABA ──
        if (this._activeTab === 0) {
            this._renderOverview(out, accountMap, W);
        } else {
            const accIndex = this._activeTab - 1;
            if (accIndex < accountNames.length) {
                const accName = accountNames[accIndex];
                this._renderAccountTab(out, accName, accountMap[accName], W);
            }
        }

        // ── FOOTER ──
        out.push(this._boxMid(W));
        out.push(this._boxRow(this._center(`${C.gray}<< >> Tab: Abas  |  0-9: Atalho  |  Ctrl+C: Sair${C.reset}`, W), W));
        out.push(this._boxBottom(W));

        write(out.join('\n'));
    }

    // ═══════════════════════════════════════════════════════════
    //  ABA: VISAO GERAL
    // ═══════════════════════════════════════════════════════════
    _renderOverview(out, accountMap, W) {
        const accountNames = Object.keys(accountMap);

        if (accountNames.length === 0) {
            out.push(this._boxRow(this._center(`${C.gray}Nenhuma conta registrada${C.reset}`, W), W));
            return;
        }

        for (let i = 0; i < accountNames.length; i++) {
            const accName = accountNames[i];
            const accSessions = accountMap[accName];
            const accOnline = accSessions.filter(s => s.isRunning).length;
            const accTotal = accSessions.length;
            const dot = accOnline > 0 ? `${C.bGreen}*${C.reset}` : `${C.red}*${C.reset}`;

            out.push(this._boxRow(`  ${dot} ${C.bold}${C.bWhite}${accName}${C.reset} ${C.gray}(${C.bGreen}${accOnline}${C.gray}/${accTotal} online)${C.reset}`, W));
            out.push(this._boxRow(`  ${C.cyan}${'─'.repeat(W - 6)}${C.reset}`, W));

            for (const session of accSessions) {
                const isOn = session.isRunning;
                const pos = session.getPlayerPosition();

                if (isOn) {
                    const icon = `${C.bGreen}>${C.reset}`;
                    const nm = `${C.bold}${C.bWhite}${session.character}${C.reset}`;

                    let posStr = '';
                    if (pos) {
                        posStr = ` ${C.gray}@${C.reset}${C.bYellow}${pos.x}${C.gray},${C.bYellow}${pos.y}${C.gray},${C.bYellow}${pos.z}${C.reset}`;
                    }

                    // Bot status indicators
                    const cbOn = session.cavebot && session.cavebot._enabled && !session.cavebot._paused;
                    const mnOn = session.miner && session.miner.isMining;
                    const cbDot = cbOn ? `${C.bGreen}●${C.reset}` : `${C.red}●${C.reset}`;
                    const mnDot = mnOn ? `${C.bGreen}●${C.reset}` : `${C.red}●${C.reset}`;
                    const botStr = ` ${C.gray}[${C.reset}${cbDot}${C.dim}CB${C.reset} ${mnDot}${C.dim}MN${C.reset}${C.gray}]${C.reset}`;

                    out.push(this._boxRow(`    ${icon} ${nm}${posStr}${botStr}`, W));
                } else {
                    out.push(this._boxRow(`    ${C.red}>${C.reset} ${C.gray}${session.character}${C.reset} ${C.dim}${C.red}offline${C.reset}`, W));
                }
            }

            if (i < accountNames.length - 1) {
                out.push(this._boxRow('', W));
            }
        }
    }

    // ═══════════════════════════════════════════════════════════
    //  ABA: CONTA DETALHADA
    // ═══════════════════════════════════════════════════════════
    _renderAccountTab(out, accName, sessions, W) {
        const accOnline = sessions.filter(s => s.isRunning).length;
        const dot = accOnline > 0 ? `${C.bGreen}*${C.reset}` : `${C.red}*${C.reset}`;

        out.push(this._boxRow(`  ${dot} ${C.bold}${C.bWhite}Conta: ${accName}${C.reset}  ${C.gray}(${C.bGreen}${accOnline}${C.gray}/${sessions.length} online)${C.reset}`, W));
        out.push(this._boxRow('', W));

        if (sessions.length === 0) {
            out.push(this._boxRow(this._center(`${C.gray}Nenhum personagem nesta conta${C.reset}`, W), W));
            return;
        }

        for (const session of sessions) {
            const isOn = session.isRunning;
            const player = session.getPlayer();
            const pos = session.getPlayerPosition();

            const innerW = W - 8;
            const cardLine = (ch = '─') => ch.repeat(innerW);

            if (isOn) {
                const statusBadge = `${C.bgGreen}${C.bold}${C.black} ONLINE ${C.reset}`;
                out.push(this._boxRow(`    ${C.green}+${cardLine()}+${C.reset}`, W));

                // Nome + Status
                const nameStr = `${C.bold}${C.bWhite}>> ${session.character}${C.reset}  ${statusBadge}`;
                out.push(this._boxRow(`    ${C.green}|${C.reset} ${nameStr}`, W, true));
                out.push(this._boxRow(`    ${C.green}|${C.gray}${cardLine('─')}${C.green}|${C.reset}`, W));

                if (player) {
                    const lvl = player.level || '?';
                    const exp = player.experience || 0;

                    // Level + Exp
                    out.push(this._boxRow(`    ${C.green}|${C.reset}  ${C.gray}Level:${C.reset} ${C.bold}${C.bYellow}${lvl}${C.reset}    ${C.gray}Exp:${C.reset} ${C.bWhite}${this._formatNumber(exp)}${C.reset}`, W, true));

                    // Separador
                    out.push(this._boxRow(`    ${C.green}|${C.gray}${cardLine('.')}${C.green}|${C.reset}`, W));

                    // Coordenadas em destaque
                    if (pos) {
                        const compassChars = ['>', '+', '<', '+'];
                        const compass = compassChars[this._frame % compassChars.length];
                        out.push(this._boxRow(`    ${C.green}|${C.reset}  ${C.bYellow}${compass}${C.reset} ${C.bold}${C.white}Coordenadas:${C.reset}  ${C.bgGray}${C.bWhite} X: ${C.bCyan}${String(pos.x).padStart(5)} ${C.reset}  ${C.bgGray}${C.bWhite} Y: ${C.bCyan}${String(pos.y).padStart(5)} ${C.reset}  ${C.bgGray}${C.bWhite} Z: ${C.bCyan}${String(pos.z).padStart(2)} ${C.reset}`, W, true));
                    } else {
                        out.push(this._boxRow(`    ${C.green}|${C.reset}  ${C.gray}@ Coordenadas: aguardando...${C.reset}`, W, true));
                    }

                    // CaveBot
                    const cbActive = session.cavebot && session.cavebot._enabled && !session.cavebot._paused;
                    const cbStatus = cbActive
                        ? `${C.bGreen}●${C.reset} ${C.bold}CaveBot${C.reset}`
                        : `${C.red}●${C.reset} ${C.dim}CaveBot${C.reset}`;

                    // Miner
                    const mnActive = session.miner && session.miner.isMining;
                    const mnStatus = mnActive
                        ? `${C.bGreen}●${C.reset} ${C.bold}Miner${C.reset}`
                        : `${C.red}●${C.reset} ${C.dim}Miner${C.reset}`;

                    out.push(this._boxRow(`    ${C.green}|${C.reset}  ${C.gray}[Bot]${C.reset} ${cbStatus}  ${mnStatus}`, W, true));

                } else {
                    out.push(this._boxRow(`    ${C.green}|${C.reset}  ${C.gray}Carregando dados do personagem...${C.reset}`, W, true));
                }

                out.push(this._boxRow(`    ${C.green}+${cardLine()}+${C.reset}`, W));

            } else {
                // Offline card
                const statusBadge = `${C.bgRed}${C.bold}${C.white} OFFLINE ${C.reset}`;
                out.push(this._boxRow(`    ${C.gray}+${cardLine('-')}+${C.reset}`, W));
                out.push(this._boxRow(`    ${C.gray}|${C.reset} ${C.dim}${C.white}x ${session.character}${C.reset}  ${statusBadge}`, W, true));
                out.push(this._boxRow(`    ${C.gray}+${cardLine('-')}+${C.reset}`, W));
            }

            out.push(this._boxRow('', W));
        }
    }

    // ═══════════════════════════════════════════════════════════
    //  HELPERS VISUAIS
    // ═══════════════════════════════════════════════════════════

    _titleArt() {
        const s = this._frame % 4 < 2 ? '*' : '+';
        return `${C.bold}${C.bCyan}${s} ${C.bWhite}T I B I A   C L I E N T   8 . 6 0 ${C.bCyan}${s}${C.reset}`;
    }

    _miniBar(pct, width, type) {
        const filled = Math.round((pct / 100) * width);
        const empty = width - filled;

        let color;
        if (type === 'hp') {
            color = pct > 60 ? C.bGreen : pct > 30 ? C.bYellow : C.bRed;
        } else {
            color = C.bBlue;
        }

        return `${C.gray}[${color}${'#'.repeat(filled)}${C.gray}${'-'.repeat(empty)}]${C.reset}`;
    }

    _fancyBar(pct, width, type) {
        const filled = Math.round((pct / 100) * width);
        const empty = width - filled;

        let color;
        if (type === 'hp') {
            color = pct > 60 ? C.bGreen : pct > 30 ? C.bYellow : C.bRed;
        } else {
            color = C.bBlue;
        }

        const fillStr = `${color}${'='.repeat(filled)}${C.reset}`;
        const emptyStr = `${C.gray}${'-'.repeat(empty)}${C.reset}`;

        return `${C.gray}[${fillStr}${emptyStr}${C.gray}]${C.reset}`;
    }

    _hpColor(pct) {
        return pct > 60 ? C.bGreen : pct > 30 ? C.bYellow : C.bRed;
    }

    // ═══════════════════════════════════════════════════════════
    //  BOX DRAWING
    // ═══════════════════════════════════════════════════════════

    _boxTop(w) {
        return `${C.cyan}+${'='.repeat(w)}+${C.reset}`;
    }

    _boxBottom(w) {
        return `${C.cyan}+${'='.repeat(w)}+${C.reset}`;
    }

    _boxMid(w) {
        return `${C.cyan}+${'='.repeat(w)}+${C.reset}`;
    }

    _boxRow(content, w, hasInnerCard) {
        const vLen = this._vLen(content);
        const padding = Math.max(0, w - vLen);
        return `${C.cyan}|${C.reset}${content}${' '.repeat(padding)}${C.cyan}|${C.reset}`;
    }

    // ═══════════════════════════════════════════════════════════
    //  UTILITARIOS
    // ═══════════════════════════════════════════════════════════

    _formatNumber(n) {
        return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    }

    _groupByAccount(sessions) {
        const map = {};
        if (this.accountsConfig.length > 0) {
            for (const acc of this.accountsConfig) {
                map[acc.name] = [];
            }
        }
        for (const session of sessions) {
            const accName = session.account || 'desconhecida';
            if (!map[accName]) map[accName] = [];
            map[accName].push(session);
        }
        return map;
    }

    _center(text, width) {
        const vl = this._vLen(text);
        if (vl >= width) return text;
        const left = Math.floor((width - vl) / 2);
        const right = width - vl - left;
        return ' '.repeat(left) + text + ' '.repeat(right);
    }

    _pad(text, width) {
        const vl = this._vLen(text);
        if (vl >= width) return text;
        return text + ' '.repeat(width - vl);
    }

    _vLen(str) {
        const clean = str.replace(/\x1b\[[0-9;]*m/g, '');
        return clean.length;
    }
}

module.exports = SilentDashboard;