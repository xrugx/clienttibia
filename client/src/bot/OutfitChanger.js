'use strict';

/**
 * OutfitChanger - Troca automática de cores do outfit
 * 
 * Muda periodicamente as cores (head, body, legs, feet) do personagem
 * enquanto ele está online. Mantém o lookType e addons do outfit atual.
 * 
 * Cores válidas no Tibia 8.60: 0-132
 * 
 * Uso:
 *   const changer = new OutfitChanger(session, {
 *       enabled: true,
 *       interval: 30000,
 *   });
 *   changer.start();
 *   changer.stop();
 */

const EventEmitter = require('events');

const MAX_COLOR = 132;

class OutfitChanger extends EventEmitter {
    /**
     * @param {import('../game/GameSession')} session - Game session
     * @param {object} config
     * @param {boolean} [config.enabled=false] - Iniciar ativo
     * @param {number} [config.interval=30000] - Intervalo entre trocas (ms)
     */
    constructor(session, config = {}) {
        super();
        this.session = session;
        this.enabled = config.enabled || false;
        // Mínimo 2000ms - o servidor tem 300ms exhaust no request + 1000ms no change
        this.interval = Math.max(config.interval || 30000, 2000);
        this._timer = null;
        this._running = false;
        this._pendingOutfit = null;
        this._outfitWindowHandler = null;
    }

    /**
     * Gera uma cor aleatória válida (0-132)
     * @returns {number}
     */
    _randomColor() {
        return Math.floor(Math.random() * (MAX_COLOR + 1));
    }

    /**
     * Inicia a troca automática de cores
     */
    start() {
        if (this._running) return;
        if (!this.enabled) return;

        this._running = true;
        this._scheduleNext();
        this.emit('started');
    }

    /**
     * Para a troca automática
     */
    stop() {
        this._running = false;
        if (this._timer) {
            clearTimeout(this._timer);
            this._timer = null;
        }
        // Remove o listener do outfitWindow se existir
        this._removeOutfitListener();
        this._pendingOutfit = null;
        this.emit('stopped');
    }

    /**
     * Remove o listener de outfitWindow do protocolo
     * @private
     */
    _removeOutfitListener() {
        if (this._outfitWindowHandler) {
            const protocol = this.session.getProtocol();
            if (protocol) {
                protocol.removeListener('outfitWindow', this._outfitWindowHandler);
            }
            this._outfitWindowHandler = null;
        }
    }

    /**
     * Agenda a próxima troca
     * @private
     */
    _scheduleNext() {
        if (!this._running) return;

        this._timer = setTimeout(() => {
            this._changeOutfit();
            this._scheduleNext();
        }, this.interval);
    }

    /**
     * Troca as cores do outfit usando o fluxo correto:
     * 1. Envia RequestOutfit (0xD2) para abrir o diálogo
     * 2. Espera o servidor responder com OutfitWindow (0xC8)
     * 3. Envia SetOutfit (0xD3) com as cores aleatórias
     * @private
     */
    _changeOutfit() {
        if (!this.session.isRunning) return;

        const sender = this.session.getSender();
        if (!sender) return;

        const protocol = this.session.getProtocol();
        if (!protocol) return;

        const player = this.session.getPlayer();
        if (!player || !player.outfit) return;

        // Não enviar se lookType é 0 (invisível/item)
        if (player.outfit.lookType === 0) return;

        // Prepara o outfit com cores aleatórias mantendo lookType e addons
        this._pendingOutfit = {
            lookType: player.outfit.lookType,
            lookHead: this._randomColor(),
            lookBody: this._randomColor(),
            lookLegs: this._randomColor(),
            lookFeet: this._randomColor(),
            lookAddons: player.outfit.lookAddons || 0,
        };

        // Remove listener anterior se existir
        this._removeOutfitListener();

        // Listener para quando o servidor responder com OutfitWindow
        this._outfitWindowHandler = () => {
            if (!this._running || !this._pendingOutfit) return;

            // O servidor adiciona 300ms de exhaust ao processar RequestOutfit.
            // playerChangeOutfit checa o MESMO exhaust (condition type 4).
            // Se enviarmos SetOutfit imediatamente, o exhaust ainda está ativo
            // e o servidor rejeita silenciosamente. Esperamos 500ms para garantir.
            setTimeout(() => {
                if (!this._running || !this._pendingOutfit) return;

                const s = this.session.getSender();
                if (!s) return;

                const outfit = this._pendingOutfit;
                this._pendingOutfit = null;

                s.sendSetOutfit(outfit);
                this.emit('outfitChanged', outfit);
            }, 500);

            // Remove o listener após usar
            this._removeOutfitListener();
        };

        protocol.once('outfitWindow', this._outfitWindowHandler);

        // Timeout de segurança: se o servidor não responder em 5s, limpa
        setTimeout(() => {
            if (this._pendingOutfit) {
                this._pendingOutfit = null;
                this._removeOutfitListener();
            }
        }, 5000);

        // Passo 1: pedir ao servidor para abrir o diálogo de outfit
        sender.sendRequestOutfit();
    }

    /**
     * Status atual
     * @returns {object}
     */
    getStatus() {
        return {
            running: this._running,
            enabled: this.enabled,
            interval: this.interval,
        };
    }
}

module.exports = OutfitChanger;
