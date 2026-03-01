'use strict';

/**
 * AutoCommand - Sistema de comandos automáticos
 * 
 * Envia comandos configurados automaticamente em intervalos definidos,
 * captura as respostas do servidor, extrai dados (ex: balance) e exibe no console.
 */

const EventEmitter = require('events');

class AutoCommand extends EventEmitter {
    /**
     * @param {import('../game/GameSession')} session - Game session
     * @param {object} config - AutoCommand configuration
     * @param {string[]} config.commands - Lista de comandos para enviar
     * @param {number} [config.interval=60000] - Intervalo entre comandos (ms)
     * @param {number} [config.type=1] - Tipo de fala para enviar o comando (1=say)
     * @param {boolean} [config.random=false] - Enviar comandos em ordem aleatória
     * @param {boolean} [config.enabled=false] - Iniciar ativo
     * @param {number} [config.responseTimeout=5000] - Tempo (ms) para capturar respostas após enviar comando
     * @param {boolean} [config.loop=true] - Repetir os comandos em loop
     */
    constructor(session, config = {}) {
        super();
        this.session = session;
        this.character = session.character || 'Unknown';

        this.commands = config.commands || [];
        this.interval = config.interval || 60000;
        this.type = config.type || 1;
        this.random = config.random || false;
        this.enabled = config.enabled || false;
        this.responseTimeout = config.responseTimeout || 5000;
        this.loop = config.loop !== false;

        // Transfer config
        this.transfer = {
            enabled: config.transfer?.enabled ?? false,
            recipient: config.transfer?.recipient || '',
            delay: config.transfer?.delay ?? 1500,
        };

        this._timer = null;
        this._commandIndex = 0;
        this._running = false;
        this._listening = false;
        this._lastCommand = null;
        this._responseTimer = null;
        this._transferPending = false;
        this._chatLogEnabled = false;

        // Dados extraídos das respostas
        this.data = {
            balance: null,       // Saldo no banco
            moneyInHand: null,   // Dinheiro em mãos
            total: null,         // Total (banco + mãos)
            lastUpdate: null,    // Timestamp da última atualização
        };

        // Tracking de transferências
        this.transfers = {
            totalSent: 0,        // Total de gps enviado
            count: 0,            // Quantidade de transferências
            history: [],         // Histórico [{amount, recipient, timestamp}]
        };

        // Handlers para capturar respostas
        this._onTextMessage = this._handleTextMessage.bind(this);
        this._onCreatureSpeak = this._handleCreatureSpeak.bind(this);

        // Handler permanente de log de chat
        this._onChatLog = this._handleChatLog.bind(this);
        this._onSpeakLog = this._handleSpeakLog.bind(this);
    }

    /**
     * Inicia o envio automático de comandos
     */
    start() {
        if (this._running) return;
        if (!this.enabled || this.commands.length === 0) return;

        this._running = true;
        this._commandIndex = 0;

        // Ativar log permanente de chat
        this._enableChatLog();

        // Enviar o primeiro comando imediatamente
        this._sendCommand();

        // Agendar os próximos
        this._scheduleNext();
        this.emit('started');
    }

    /**
     * Para o envio automático de comandos
     */
    stop() {
        this._running = false;
        if (this._timer) {
            clearTimeout(this._timer);
            this._timer = null;
        }
        this._stopListening();
        this._disableChatLog();
        this.emit('stopped');
    }

    /**
     * Agenda o envio do próximo comando
     * @private
     */
    _scheduleNext() {
        if (!this._running) return;

        this._timer = setTimeout(() => {
            this._sendCommand();
            if (this._running) {
                this._scheduleNext();
            }
        }, this.interval);
    }

    /**
     * Envia o comando atual e começa a escutar respostas
     * @private
     */
    _sendCommand() {
        if (!this.session.isRunning) return;

        const sender = this.session.getSender();
        if (!sender) return;

        let command;
        if (this.random) {
            const idx = Math.floor(Math.random() * this.commands.length);
            command = this.commands[idx];
        } else {
            command = this.commands[this._commandIndex];
            this._commandIndex++;
            if (this._commandIndex >= this.commands.length) {
                if (this.loop) {
                    this._commandIndex = 0;
                } else {
                    this._running = false;
                    if (this._timer) {
                        clearTimeout(this._timer);
                        this._timer = null;
                    }
                }
            }
        }

        if (!command) return;

        this._lastCommand = command;

        // Começar a escutar respostas antes de enviar
        this._startListening();

        // Enviar o comando como say
        sender.sendSay(this.type, command);

        this.emit('commandSent', { command, type: this.type });
    }

    /**
     * Começa a escutar respostas do servidor
     * @private
     */
    _startListening() {
        this._stopListening();
        this._listening = true;

        if (this.session.game) {
            this.session.game.on('textMessage', this._onTextMessage);
            this.session.game.on('creatureSpeak', this._onCreatureSpeak);
        }

        // Para de escutar após o timeout
        this._responseTimer = setTimeout(() => {
            this._stopListening();
        }, this.responseTimeout);
    }

    /**
     * Para de escutar respostas
     * @private
     */
    _stopListening() {
        if (!this._listening) return;
        this._listening = false;

        if (this.session.game) {
            this.session.game.removeListener('textMessage', this._onTextMessage);
            this.session.game.removeListener('creatureSpeak', this._onCreatureSpeak);
        }

        if (this._responseTimer) {
            clearTimeout(this._responseTimer);
            this._responseTimer = null;
        }
    }

    /**
     * Verifica se a mensagem é relevante para o último comando enviado
     * Filtra mensagens de broadcast (mortes, anúncios, etc.)
     * @private
     * @param {string} message
     * @returns {boolean}
     */
    _isRelevantResponse(message) {
        if (!this._lastCommand) return false;

        // Padrões de mensagens irrelevantes (broadcast de mortes, anúncios globais)
        const ignorePatterns = [
            /foi morto por/i,
            /foi assassinado/i,
            /has been killed/i,
            /was killed by/i,
            /entrou no jogo/i,
            /saiu do jogo/i,
            /has logged/i,
        ];

        for (const pattern of ignorePatterns) {
            if (pattern.test(message)) return false;
        }

        return true;
    }

    /**
     * Extrai dados da resposta com base no comando enviado
     * @private
     * @param {string} message - Mensagem de resposta
     */
    _parseResponseData(message) {
        if (!this._lastCommand) return;

        const cmd = this._lastCommand.toLowerCase();

        // Parser para !balance
        if (cmd === '!balance' || cmd === '!bank' || cmd === '!money') {
            this._parseBalance(message);
        }
    }

    /**
     * Extrai dados de balance da resposta
     * @private
     * @param {string} message
     */
    _parseBalance(message) {
        // Tenta capturar: "Balance: 2250000 gps"
        const balanceMatch = message.match(/balance[:\s]+([0-9.,]+)\s*gps?/i);
        if (balanceMatch) {
            this.data.balance = parseInt(balanceMatch[1].replace(/[.,]/g, ''), 10);
        }

        // Tenta capturar: "Money em mãos: 96800 gps"
        const handMatch = message.match(/money\s+em\s+m[aã]os[:\s]+([0-9.,]+)\s*gps?/i);
        if (handMatch) {
            this.data.moneyInHand = parseInt(handMatch[1].replace(/[.,]/g, ''), 10);
        }

        // Tenta capturar: "Total: 2346800 gps"
        const totalMatch = message.match(/total[:\s]+([0-9.,]+)\s*gps?/i);
        if (totalMatch) {
            this.data.total = parseInt(totalMatch[1].replace(/[.,]/g, ''), 10);
            this.data.lastUpdate = Date.now();

            const now = new Date().toLocaleTimeString('pt-BR');
            console.log(`\x1b[35m[${now}] [AutoCmd][${this.character}] 💰 Balance: ${(this.data.balance || 0).toLocaleString('pt-BR')} gps\x1b[0m`);

            this.emit('balanceUpdated', {
                character: this.character,
                balance: this.data.balance,
                moneyInHand: this.data.moneyInHand,
                total: this.data.total,
                lastUpdate: this.data.lastUpdate,
            });

            // Executar transfer automático usando o BALANCE (saldo do banco), não o total
            if (this.transfer.enabled && this.transfer.recipient && this.data.balance > 0) {
                this._executeTransfer(this.data.balance);
            }
        }
    }

    /**
     * Executa o comando de transferência
     * Pausa a mineração, espera 5s, envia o transfer, depois retoma a mineração
     * @private
     * @param {number} amount - Valor a transferir
     */
    _executeTransfer(amount) {
        if (this._transferPending) return;
        this._transferPending = true;

        // Pausar mineração para evitar bugs
        const miner = this.session.miner;
        const minerWasEnabled = miner && miner._enabled;
        if (minerWasEnabled) {
            const now = new Date().toLocaleTimeString('pt-BR');
            console.log(`\x1b[33m[${now}] [AutoCmd][${this.character}] ⏸ Pausando mineração para transferir...\x1b[0m`);
            miner.stop();
        }

        // Esperar 5 segundos antes de enviar o transfer
        setTimeout(() => {
            if (!this.session.isRunning) {
                this._transferPending = false;
                if (minerWasEnabled && miner) miner.start();
                return;
            }

            const sender = this.session.getSender();
            if (!sender) {
                this._transferPending = false;
                if (minerWasEnabled && miner) miner.start();
                return;
            }

            const cmd = `!transfer ${this.transfer.recipient}, ${amount}`;
            const now = new Date().toLocaleTimeString('pt-BR');
            console.log(`\x1b[36m[${now}] [AutoCmd][${this.character}] >>> ${cmd}\x1b[0m`);

            // Escutar resposta do transfer
            this._listenForTransferResponse();

            sender.sendSay(this.type, cmd);

            this.emit('transferSent', {
                character: this.character,
                recipient: this.transfer.recipient,
                amount,
            });

            // Retomar mineração após o transfer (com pequeno delay de segurança)
            setTimeout(() => {
                this._transferPending = false;
                if (minerWasEnabled && miner) {
                    const t = new Date().toLocaleTimeString('pt-BR');
                    console.log(`\x1b[33m[${t}] [AutoCmd][${this.character}] ▶ Retomando mineração...\x1b[0m`);
                    miner.start();
                }
            }, 2000);
        }, 5000);
    }

    /**
     * Processa mensagens de texto do servidor (respostas de sistema)
     * @private
     */
    _handleTextMessage(data) {
        if (!this._listening) return;
        if (!this._isRelevantResponse(data.message)) return;

        // Extrair dados da resposta
        this._parseResponseData(data.message);

        this.emit('response', { type: 'textMessage', command: this._lastCommand, message: data.message });
    }

    /**
     * Processa falas de criaturas/NPCs (respostas de NPC/servidor)
     * @private
     */
    _handleCreatureSpeak(data) {
        if (!this._listening) return;
        if (data.name === this.character) return;
        if (!this._isRelevantResponse(data.message)) return;

        this.emit('response', { type: 'creatureSpeak', command: this._lastCommand, name: data.name, message: data.message });
    }

    // ──────── Chat Log (permanente) ────────

    /**
     * Ativa o log permanente de todas as mensagens de chat
     * @private
     */
    _enableChatLog() {
        if (this._chatLogEnabled) return;
        this._chatLogEnabled = true;

        if (this.session.game) {
            this.session.game.on('textMessage', this._onChatLog);
            this.session.game.on('creatureSpeak', this._onSpeakLog);
        }
    }

    /**
     * Desativa o log permanente de chat
     * @private
     */
    _disableChatLog() {
        if (!this._chatLogEnabled) return;
        this._chatLogEnabled = false;

        if (this.session.game) {
            this.session.game.removeListener('textMessage', this._onChatLog);
            this.session.game.removeListener('creatureSpeak', this._onSpeakLog);
        }
    }

    /**
     * Handler permanente: loga textMessage no console
     * @private
     */
    _handleChatLog(data) {
        const now = new Date().toLocaleTimeString('pt-BR');
        console.log(`\x1b[33m[${now}] [Chat][${this.character}] [text type=${data.type}] ${data.message}\x1b[0m`);
    }

    /**
     * Handler permanente: loga creatureSpeak no console
     * @private
     */
    _handleSpeakLog(data) {
        const now = new Date().toLocaleTimeString('pt-BR');
        console.log(`\x1b[32m[${now}] [Chat][${this.character}] ${data.name} (type=${data.type}): ${data.message}\x1b[0m`);
    }

    // ──────── Transfer response listener ────────

    /**
     * Escuta temporariamente por respostas após enviar o !transfer
     * @private
     */
    _listenForTransferResponse() {
        if (!this.session.game) return;

        const onText = (data) => {
            const now = new Date().toLocaleTimeString('pt-BR');
            console.log(`\x1b[35m[${now}] [Transfer][${this.character}] Resposta: ${data.message}\x1b[0m`);

            // Parsear confirmação: "Você transferiu 20000 gps para noxter."
            const match = data.message.match(/transferiu\s+([0-9.,]+)\s*gps?\s+para\s+(\S+)/i);
            if (match) {
                const amount = parseInt(match[1].replace(/[.,]/g, ''), 10);
                const recipient = match[2].replace(/\.$/, '');
                this.transfers.totalSent += amount;
                this.transfers.count++;
                this.transfers.history.push({
                    amount,
                    recipient,
                    timestamp: Date.now(),
                });
                console.log(`\x1b[32m[${now}] [Transfer][${this.character}] ✅ Confirmado: ${amount.toLocaleString('pt-BR')} gps para ${recipient} (Total enviado: ${this.transfers.totalSent.toLocaleString('pt-BR')} gps)\x1b[0m`);
                this.emit('transferConfirmed', {
                    character: this.character,
                    amount,
                    recipient,
                    totalSent: this.transfers.totalSent,
                    count: this.transfers.count,
                });
            }

            this.emit('transferResponse', { type: 'textMessage', message: data.message });
        };

        const onSpeak = (data) => {
            if (data.name === this.character) return;
            const now = new Date().toLocaleTimeString('pt-BR');
            console.log(`\x1b[35m[${now}] [Transfer][${this.character}] ${data.name}: ${data.message}\x1b[0m`);
            this.emit('transferResponse', { type: 'creatureSpeak', name: data.name, message: data.message });
        };

        this.session.game.on('textMessage', onText);
        this.session.game.on('creatureSpeak', onSpeak);

        // Parar de escutar após 10 segundos
        setTimeout(() => {
            if (this.session.game) {
                this.session.game.removeListener('textMessage', onText);
                this.session.game.removeListener('creatureSpeak', onSpeak);
            }
        }, 10000);
    }

    /**
     * Retorna o total de gold do personagem
     * @returns {number|null}
     */
    getTotal() {
        return this.data.total;
    }

    /**
     * Retorna o balance no banco
     * @returns {number|null}
     */
    getBalance() {
        return this.data.balance;
    }

    /**
     * Retorna o dinheiro em mãos
     * @returns {number|null}
     */
    getMoneyInHand() {
        return this.data.moneyInHand;
    }

    /**
     * Retorna status atual do AutoCommand
     * @returns {object}
     */
    getStatus() {
        return {
            running: this._running,
            enabled: this.enabled,
            commands: this.commands,
            interval: this.interval,
            type: this.type,
            random: this.random,
            loop: this.loop,
            currentIndex: this._commandIndex,
            lastCommand: this._lastCommand,
            data: { ...this.data },
            transfers: {
                totalSent: this.transfers.totalSent,
                count: this.transfers.count,
                lastTransfers: this.transfers.history.slice(-10),
            },
        };
    }
}

module.exports = AutoCommand;
