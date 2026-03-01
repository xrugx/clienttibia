'use strict';

/**
 * AutoMessage - Sistema de mensagens automáticas
 * 
 * Envia mensagens configuradas automaticamente em intervalos definidos.
 * Suporta diferentes tipos de fala (say, whisper, yell, channel).
 * As mensagens podem ser enviadas em sequência ou aleatoriamente.
 * 
 * Uso:
 *   const autoMsg = new AutoMessage(session, {
 *       messages: ["Msg 1", "Msg 2"],
 *       interval: 120000,
 *       type: 1,
 *       enabled: true,
 *   });
 *   autoMsg.start();
 *   autoMsg.stop();
 */

const EventEmitter = require('events');

class AutoMessage extends EventEmitter {
    /**
     * @param {import('../game/GameSession')} session - Game session
     * @param {object} config - AutoMessage configuration
     * @param {string[]} config.messages - Lista de mensagens para enviar
     * @param {number} [config.interval=120000] - Intervalo entre mensagens (ms)
     * @param {number} [config.type=1] - Tipo de fala (1=say, 2=whisper, 3=yell, 7=channel)
     * @param {number} [config.channelId=0] - ID do canal (usado apenas com type channel)
     * @param {boolean} [config.random=false] - Enviar mensagens em ordem aleatória
     * @param {boolean} [config.enabled=false] - Iniciar ativo
     */
    constructor(session, config = {}) {
        super();
        this.session = session;

        this.messages = config.messages || [];
        this.interval = config.interval || 120000;
        this.type = config.type || 1;
        this.channelId = config.channelId || 0;
        this.random = config.random || false;
        this.enabled = config.enabled || false;

        this._timer = null;
        this._messageIndex = 0;
        this._running = false;
    }

    /**
     * Inicia o envio automático de mensagens
     */
    start() {
        if (this._running) return;
        if (!this.enabled || this.messages.length === 0) return;

        this._running = true;
        this._messageIndex = 0;
        this._scheduleNext();
        this.emit('started');
    }

    /**
     * Para o envio automático de mensagens
     */
    stop() {
        this._running = false;
        if (this._timer) {
            clearTimeout(this._timer);
            this._timer = null;
        }
        this.emit('stopped');
    }

    /**
     * Agenda o envio da próxima mensagem
     * @private
     */
    _scheduleNext() {
        if (!this._running) return;

        this._timer = setTimeout(() => {
            this._sendMessage();
            this._scheduleNext();
        }, this.interval);
    }

    /**
     * Envia a mensagem atual
     * @private
     */
    _sendMessage() {
        if (!this.session.isRunning) return;

        const sender = this.session.getSender();
        if (!sender) return;

        let message;
        if (this.random) {
            const idx = Math.floor(Math.random() * this.messages.length);
            message = this.messages[idx];
        } else {
            message = this.messages[this._messageIndex];
            this._messageIndex = (this._messageIndex + 1) % this.messages.length;
        }

        if (!message) return;

        sender.sendSay(this.type, message, undefined, this.channelId);
        this.emit('messageSent', { message, type: this.type, channelId: this.channelId });
    }

    /**
     * Retorna status atual do AutoMessage
     * @returns {object}
     */
    getStatus() {
        return {
            running: this._running,
            enabled: this.enabled,
            messages: this.messages,
            interval: this.interval,
            type: this.type,
            channelId: this.channelId,
            random: this.random,
            currentIndex: this._messageIndex,
        };
    }
}

module.exports = AutoMessage;
