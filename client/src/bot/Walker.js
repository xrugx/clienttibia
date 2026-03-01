'use strict';

/**
 * Walker - Step-by-step movement engine
 * 
 * Matches the original OTClient cavebot walking behavior:
 * - Computes path via Pathfinder (A*)
 * - Sends one walk command at a time (step-by-step mode)
 * - Confirms each step via position change event (debounced for diagonals)
 * - Re-paths when the server cancels a walk (cancelWalk)
 * - Respects movement speed delays (stepDuration = tileCost / speed * 1000)
 * - Max 1-2 pending (unconfirmed) steps to stay safe
 * 
 * Key fix: diagonal steps produce 2 map events (TopRow+RightColumn etc.)
 * so we debounce position checks and track actual position changes
 * to avoid double-counting.
 * 
 * Usage:
 *   const walker = new Walker(session);
 *   await walker.walkTo({ x: 100, y: 200, z: 7 });
 */

const EventEmitter = require('events');
const Pathfinder = require('./Pathfinder');
const { Logger } = require('../utils');
const {
    DIRECTION_NORTH, DIRECTION_EAST, DIRECTION_SOUTH, DIRECTION_WEST,
    DIRECTION_NORTHEAST, DIRECTION_SOUTHEAST, DIRECTION_SOUTHWEST, DIRECTION_NORTHWEST,
} = require('../constants/GameConstants');

class Walker extends EventEmitter {
    /**
     * @param {import('../game/GameSession')} session - The game session to control
     * @param {object} [options]
     * @param {number} [options.walkDelay=10] - Extra delay between steps (ms)
     * @param {number} [options.maxPending=2] - Max unconfirmed steps before waiting
     * @param {number} [options.recalcRetries=5] - Max recalc attempts per walkTo
     * @param {boolean} [options.ignoreCreatures=true] - Pathfinder ignores creatures
     * @param {boolean} [options.ignoreNonPathable=false] - Pathfinder ignores fields
     * @param {number} [options.maxPathDistance=50] - Max pathfinder search distance
     * @param {number} [options.maxPathSteps=200] - Max A* iterations
     */
    constructor(session, options = {}) {
        super();
        this.session = session;
        this.logger = new Logger(`Walker[${session.label}]`);
        this.logger.setLevel(session.serverConfig?.logLevel || 'info');

        // Config
        this.walkDelay = options.walkDelay ?? 10;
        this.maxPending = options.maxPending ?? 2;
        this.recalcRetries = options.recalcRetries ?? 5;
        this.pathfinderOptions = {
            ignoreCreatures: options.ignoreCreatures !== false,
            ignoreNonPathable: options.ignoreNonPathable || false,
            maxSteps: options.maxPathSteps || 200,
            maxDistance: options.maxPathDistance || 50,
        };

        // State
        this._walking = false;
        this._stopped = false;
        this._currentPath = null;      // { directions, pathDirs, positions, partial }
        this._pathIndex = 0;
        this._pendingSteps = 0;
        this._destination = null;
        this._precision = 0;
        this._resolve = null;
        this._reject = null;
        this._totalRecalcs = 0;        // Total recalculations for this walkTo
        this._maxTotalRecalcs = 30;    // Safety: max recalcs before giving up

        // Position tracking — avoids double-counting diagonal step events
        this._lastConfirmedPos = null;  // { x, y, z }
        this._posDebounceTimer = null;  // debounce timer for position events
        this._stepTimer = null;         // timer for sending next step

        // Stuck detection: if no position change within this time after a step, force recalc
        this._stuckTimer = null;
        this._stuckTimeout = 3000;      // 3s without movement = stuck
        this._lastStepSentAt = 0;       // timestamp of last step sent
        this._consecutiveStucks = 0;    // how many times we detected stuck in a row
        this._maxConsecutiveStucks = 5; // give up after this many consecutive stucks

        // Auxiliary coordinate system: for portal/teleport waypoints
        // After a timeout, switches the destination check to auxCoord
        this._auxCoord = null;          // {x, y, z} auxiliary coordinate to verify after timeout
        this._auxCoordTimer = null;     // timer that triggers the switch
        this._auxCoordTimeout = 5000;   // default timeout (ms), overridable per-waypoint via auxCoordDelay
        this._originalDestination = null; // stores the original destination before switch

        // Cancel/rejection tracking — avoid spamming recalcs
        this._consecutiveCancels = 0;
        this._maxConsecutiveCancels = 8; // give up after this many consecutive rejections

        // Bind session events
        this._onPositionChange = this._onPositionChange.bind(this);
        this._onCancelWalk = this._onCancelWalk.bind(this);
        this._onTextMessage = this._onTextMessage.bind(this);
        this._onDisconnected = this._onDisconnected.bind(this);
    }

    /**
     * Walk to a destination position
     * Returns a promise that resolves when arrived, or rejects on failure.
     * 
     * @param {{x:number, y:number, z:number}} destination
     * @param {number} [precision=0] - Allow stopping N tiles away
     * @param {object} [options] - Per-walk options
     * @param {boolean} [options.forceWalk=false] - Ignore all obstacles, try to walk no matter what
     * @returns {Promise<boolean>} true if arrived
     */
    walkTo(destination, precision = 0, options = {}) {
        return new Promise((resolve, reject) => {
            if (this._walking) {
                this.stop();
            }

            // Deep-copy destination so external mutations never affect us
            this._destination = this._snapshotPos(destination);
            this._precision = precision;
            this._forceWalk = options.forceWalk || false;
            this._stopped = false;
            this._resolve = resolve;
            this._reject = reject;
            this._pendingSteps = 0;
            this._lastConfirmedPos = null;
            this._totalRecalcs = 0;
            this._consecutiveStucks = 0;
            this._consecutiveCancels = 0;

            // Auxiliary coordinate system (for portals/teleports)
            // Deep-copy to avoid external reference issues
            this._auxCoord = options.auxCoord ? this._snapshotPos(options.auxCoord) : null;
            // Allow per-waypoint delay override (ms), fallback to default 5000ms
            this._auxCoordTimeout = options.auxCoordDelay ?? 5000;
            this._originalDestination = null;
            if (this._auxCoordTimer) {
                clearTimeout(this._auxCoordTimer);
                this._auxCoordTimer = null;
            }

            // Snapshot current position as last confirmed (isolated copy)
            this._lastConfirmedPos = this._getPlayerPos();

            // Attach listeners
            this._attachListeners();

            // If auxCoord is set, start timer to switch destination after timeout
            if (this._auxCoord) {
                this._originalDestination = { ...this._destination };
                this.logger.info(`AuxCoord configurado: (${this._auxCoord.x},${this._auxCoord.y},${this._auxCoord.z}) — será ativado em ${this._auxCoordTimeout / 1000}s`);
                this._auxCoordTimer = setTimeout(() => {
                    this._auxCoordTimer = null;
                    this._switchToAuxCoord();
                }, this._auxCoordTimeout);
            }

            // Calculate initial path and start walking
            this._recalcAndWalk(0);
        });
    }

    /**
     * Stop walking immediately
     */
    stop() {
        this._stopped = true;
        this._walking = false;
        this._clearTimers();
        this._detachListeners();
        this._currentPath = null;
        this._pendingSteps = 0;

        // Clear auxCoord timer on stop
        if (this._auxCoordTimer) {
            clearTimeout(this._auxCoordTimer);
            this._auxCoordTimer = null;
        }
        this._auxCoord = null;
        this._originalDestination = null;

        // Send stop autowalk to server
        try {
            const sender = this.session.getSender();
            if (sender) sender.sendStopAutoWalk();
        } catch (e) { /* ignore */ }

        if (this._resolve) {
            this._resolve(false);
            this._resolve = null;
            this._reject = null;
        }
    }

    /**
     * Check if currently walking
     * @returns {boolean}
     */
    get isWalking() {
        return this._walking;
    }

    // ──────── Internal ────────

    /**
     * Create an immutable snapshot of a position.
     * Always returns a fresh plain object { x, y, z } disconnected from
     * any Position instance or player reference.  Used throughout the Walker
     * to guarantee that cached coordinates are never mutated by
     * external code (map parser, protocol, other sessions, etc.).
     * @private
     * @param {{x:number,y:number,z:number}|null} pos
     * @returns {{x:number,y:number,z:number}|null}
     */
    _snapshotPos(pos) {
        if (!pos) return null;
        return { x: pos.x, y: pos.y, z: pos.z };
    }

    /**
     * Read the current player position as an isolated snapshot.
     * Falls back to the protocol-level playerPosition which is always
     * kept up-to-date even when tile parsing fails.
     * @private
     * @returns {{x:number,y:number,z:number}|null}
     */
    _getPlayerPos() {
        // Prefer session.getPlayerPosition() which has fallback logic
        if (this.session.getPlayerPosition) {
            const pos = this.session.getPlayerPosition();
            return this._snapshotPos(pos);
        }
        const player = this.session.getPlayer();
        return this._snapshotPos(player?.position);
    }

    /**
     * Clear all timers
     * @private
     */
    _clearTimers() {
        if (this._posDebounceTimer) {
            clearTimeout(this._posDebounceTimer);
            this._posDebounceTimer = null;
        }
        if (this._stepTimer) {
            clearTimeout(this._stepTimer);
            this._stepTimer = null;
        }
        if (this._stuckTimer) {
            clearTimeout(this._stuckTimer);
            this._stuckTimer = null;
        }
        // Note: auxCoord timer is NOT cleared here on purpose.
        // It should only be cleared on stop() or when it fires.
    }

    /**
     * Switch the destination to the auxiliary coordinate.
     * Called after the auxCoord timeout fires (e.g. 5 seconds after starting to walk
     * to a portal waypoint). After the switch, the walker will verify arrival
     * against the new auxCoord instead of the original portal coordinate.
     * @private
     */
    _switchToAuxCoord() {
        if (this._stopped || !this._auxCoord) return;

        const oldDest = this._snapshotPos(this._destination);
        this._destination = this._snapshotPos(this._auxCoord);

        this.logger.info(
            `AuxCoord ativado! Destino trocado de (${oldDest.x},${oldDest.y},${oldDest.z}) ` +
            `para (${this._destination.x},${this._destination.y},${this._destination.z})`
        );

        this.emit('auxCoordActivated', {
            original: oldDest,
            auxCoord: this._snapshotPos(this._destination),
        });

        // Immediately check if the player is already at the new destination
        const currentPos = this._getPlayerPos();
        if (currentPos && this._isAtDestination(currentPos)) {
            this.logger.info('Já está na coordenada auxiliar, finalizando!');
            this._finish(true);
            return;
        }

        // Reset counters and recalculate path to new destination
        this._totalRecalcs = 0;
        this._consecutiveStucks = 0;
        this._consecutiveCancels = 0;
        this._clearTimers();
        this._pendingSteps = 0;

        // Update last confirmed position (isolated snapshot)
        this._lastConfirmedPos = this._getPlayerPos();

        // Recalculate path to the new destination
        this._recalcAndWalk(0);
    }

    /**
     * Calculate path and start sending steps
     * @private
     */
    _recalcAndWalk(attempt) {
        if (this._stopped) return;

        // Safety: prevent infinite recalc loops
        // forceWalk gets higher limits since it's expected to retry more
        const maxRecalcs = this._forceWalk ? this._maxTotalRecalcs * 3 : this._maxTotalRecalcs;
        this._totalRecalcs++;
        if (this._totalRecalcs > maxRecalcs) {
            this._finish(false, 'Max recalc limit reached');
            return;
        }

        const map = this.session.getMap();
        if (!map) {
            this._finish(false, 'No player or map');
            return;
        }

        // Atomic position snapshot — prevents stale/mutated coordinates
        const playerPos = this._getPlayerPos();
        if (!playerPos || (playerPos.x === 0 && playerPos.y === 0 && playerPos.z === 0)) {
            this._finish(false, 'No player position (not yet received from server)');
            return;
        }

        // Floor check always applies — normal movement cannot cross floors
        if (playerPos.z !== this._destination.z) {
            this.logger.debug(`Destino (${this._destination.x},${this._destination.y},${this._destination.z}) em andar diferente (player z=${playerPos.z}) — fora de alcance`);
            this._finish(false, 'unreachable');
            return;
        }

        // Quick unreachable check — too far → fail immediately, no retries
        if (!this._forceWalk) {
            const dist = Math.max(Math.abs(playerPos.x - this._destination.x), Math.abs(playerPos.y - this._destination.y));
            if (dist > this.pathfinderOptions.maxDistance) {
                this.logger.debug(`Destino (${this._destination.x},${this._destination.y},${this._destination.z}) muito longe (dist=${dist}, max=${this.pathfinderOptions.maxDistance}) — fora de alcance`);
                this._finish(false, 'unreachable');
                return;
            }
        }

        // Check if already at destination
        if (this._isAtDestination(playerPos)) {
            this._finish(true);
            return;
        }

        // Create pathfinder for this session's map
        // Merge forceWalk from the per-walk option into pathfinder options
        const pfOptions = { ...this.pathfinderOptions };
        if (this._forceWalk) {
            pfOptions.forceWalk = true;
            pfOptions.ignoreCreatures = true;
            pfOptions.ignoreNonPathable = true;
        }
        const pathfinder = new Pathfinder(map, pfOptions);
        let result = pathfinder.findPath(playerPos, this._destination, this._precision);

        // If no path found and forceWalk is enabled, generate a direct-walk path
        // (just walk straight toward the destination, one step at a time)
        if ((!result || result.directions.length === 0) && this._forceWalk) {
            result = this._generateDirectPath(playerPos, this._destination);
        }

        if (!result || result.directions.length === 0) {
            if (attempt < this.recalcRetries) {
                this.logger.debug(`Path blocked, retry ${attempt + 1}/${this.recalcRetries}`);
                setTimeout(() => {
                    if (!this._stopped) this._recalcAndWalk(attempt + 1);
                }, 500);
            } else {
                this._finish(false, 'No path found');
            }
            return;
        }

        if (result.partial) {
            this.logger.debug(`Partial path: ${result.directions.length} steps toward destination (tiles outside visible range)`);
        }

        this._currentPath = result;
        this._pathIndex = 0;
        this._walking = true;
        this._pendingSteps = 0;

        this.logger.debug(`Path found: ${result.directions.length} steps from (${playerPos.x},${playerPos.y},${playerPos.z})${result.partial ? ' [partial]' : ''}`);
        this.emit('pathFound', { steps: result.directions.length, destination: this._destination, partial: result.partial });

        // Start sending steps
        this._sendNextStep();
    }

    /**
     * Check if a position is at (or within precision of) the destination
     * @private
     * @param {{x:number, y:number, z:number}} pos
     * @returns {boolean}
     */
    _isAtDestination(pos) {
        if (!pos || !this._destination) return false;
        if (pos.z !== this._destination.z) return false;
        const dist = Math.max(
            Math.abs(pos.x - this._destination.x),
            Math.abs(pos.y - this._destination.y)
        );
        return dist <= this._precision;
    }

    /**
     * Generate a simple direct-walk path toward the destination.
     * Used as fallback when forceWalk is enabled and A* can't find a path.
     * Generates only a few steps at a time (will recalc after).
     * @private
     * @param {{x:number,y:number,z:number}} from
     * @param {{x:number,y:number,z:number}} to
     * @returns {{directions: number[], pathDirs: number[], positions: Array, partial: boolean}|null}
     */
    _generateDirectPath(from, to) {
        const directions = [];
        const pathDirs = [];
        const positions = [];
        let cx = from.x, cy = from.y;
        const maxSteps = 3; // Only a few steps, then recalc

        for (let i = 0; i < maxSteps; i++) {
            const dx = Math.sign(to.x - cx);
            const dy = Math.sign(to.y - cy);
            if (dx === 0 && dy === 0) break;

            let dir, pathDir;
            if (dx === 0 && dy === -1)      { dir = DIRECTION_NORTH;     pathDir = 3; }
            else if (dx === 1 && dy === 0)  { dir = DIRECTION_EAST;      pathDir = 1; }
            else if (dx === 0 && dy === 1)  { dir = DIRECTION_SOUTH;     pathDir = 7; }
            else if (dx === -1 && dy === 0) { dir = DIRECTION_WEST;      pathDir = 5; }
            else if (dx === 1 && dy === -1) { dir = DIRECTION_NORTHEAST; pathDir = 2; }
            else if (dx === 1 && dy === 1)  { dir = DIRECTION_SOUTHEAST; pathDir = 8; }
            else if (dx === -1 && dy === 1) { dir = DIRECTION_SOUTHWEST; pathDir = 6; }
            else if (dx === -1 && dy === -1){ dir = DIRECTION_NORTHWEST; pathDir = 4; }
            else break;

            cx += dx;
            cy += dy;
            directions.push(dir);
            pathDirs.push(pathDir);
            positions.push({ x: cx, y: cy, z: from.z });
        }

        if (directions.length === 0) return null;

        this.logger.debug(`ForceWalk: direct path generated, ${directions.length} steps`);
        return { directions, pathDirs, positions, partial: true };
    }

    /**
     * Send the next walk step to the server
     * @private
     */
    _sendNextStep() {
        if (this._stopped || !this._walking) return;
        if (!this._currentPath) return;
        if (this._pendingSteps >= this.maxPending) {
            // Even when at max pending, start stuck detection so we don't hang forever
            this._startStuckTimer();
            return;
        }

        if (this._pathIndex >= this._currentPath.directions.length) {
            // Path exhausted — if no pending steps, do a final arrival check
            if (this._pendingSteps <= 0) {
                this._doArrivalCheck();
            } else {
                // Waiting for pending steps — start stuck detection
                this._startStuckTimer();
            }
            return;
        }

        const dir = this._currentPath.directions[this._pathIndex];
        this._pathIndex++;
        this._pendingSteps++;
        this._lastStepSentAt = Date.now();

        // Send direction command
        const sender = this.session.getSender();
        if (!sender) {
            this._finish(false, 'No sender available');
            return;
        }

        this._sendDirection(sender, dir);
        this.emit('step', { direction: dir, remaining: this._currentPath.directions.length - this._pathIndex });

        // Start stuck detection timer
        this._startStuckTimer();

        // Schedule next step via timer (based on movement speed)
        // This will be superseded by position confirmation if it arrives first
        if (this._stepTimer) clearTimeout(this._stepTimer);
        const stepDelay = this._getStepDuration() + this.walkDelay;
        this._stepTimer = setTimeout(() => {
            this._stepTimer = null;
            this._sendNextStep();
        }, stepDelay);
    }

    /**
     * Start/restart stuck detection timer.
     * If no position change is received within the timeout, assume we're stuck
     * and force a path recalculation.
     * @private
     */
    _startStuckTimer() {
        if (this._stuckTimer) clearTimeout(this._stuckTimer);
        this._stuckTimer = setTimeout(() => {
            this._stuckTimer = null;
            this._onStuckDetected();
        }, this._stuckTimeout);
    }

    /**
     * Called when stuck is detected (no position change for too long)
     * @private
     */
    _onStuckDetected() {
        if (this._stopped || !this._walking) return;

        this._consecutiveStucks++;
        this.logger.debug(`Stuck detected (#${this._consecutiveStucks}), pending=${this._pendingSteps}, resetting...`);

        // Give up if stuck too many times in a row
        // forceWalk gets more attempts since obstacles are expected
        const maxStucks = this._forceWalk ? this._maxConsecutiveStucks * 3 : this._maxConsecutiveStucks;
        if (this._consecutiveStucks > maxStucks) {
            this.logger.warn('Too many consecutive stucks, giving up on this walk');
            this._finish(false, 'Stuck: no movement progress');
            return;
        }

        // Reset pending steps — the server clearly didn't process them
        this._clearTimers();
        this._pendingSteps = 0;

        // Atomic position snapshot
        const currentPos = this._getPlayerPos();

        // Update last confirmed position to current actual position
        if (currentPos) {
            this._lastConfirmedPos = currentPos;
        }

        // Check if maybe we already arrived
        if (currentPos && this._isAtDestination(currentPos)) {
            this._finish(true);
            return;
        }

        // Recalculate path from current position
        this.emit('walkStuck', { consecutiveStucks: this._consecutiveStucks });
        setTimeout(() => {
            if (!this._stopped && this._walking) this._recalcAndWalk(0);
        }, 300);
    }

    /**
     * Send a single direction walk command
     * @private
     */
    _sendDirection(sender, dir) {
        switch (dir) {
            case DIRECTION_NORTH:     sender.sendWalkNorth(); break;
            case DIRECTION_EAST:      sender.sendWalkEast(); break;
            case DIRECTION_SOUTH:     sender.sendWalkSouth(); break;
            case DIRECTION_WEST:      sender.sendWalkWest(); break;
            case DIRECTION_NORTHEAST: sender.sendWalkNorthEast(); break;
            case DIRECTION_SOUTHEAST: sender.sendWalkSouthEast(); break;
            case DIRECTION_SOUTHWEST: sender.sendWalkSouthWest(); break;
            case DIRECTION_NORTHWEST: sender.sendWalkNorthWest(); break;
        }
    }

    /**
     * Calculate step duration based on player speed and ground
     * Tibia formula: stepDuration(ms) = groundSpeed * 1000 / playerSpeed
     * @private
     * @returns {number} ms
     */
    _getStepDuration() {
        const player = this.session.getPlayer();
        const protocol = this.session.getProtocol();
        const speed = player?.speed || protocol?.player?.speed || 220;

        // Ground speed: current tile (use isolated snapshot)
        const map = this.session.getMap();
        const pos = this._getPlayerPos();
        let groundSpeed = 100;
        if (map && pos) {
            const tile = map.getTile(pos);
            if (tile && tile.ground && tile.ground.groundSpeed) {
                groundSpeed = tile.ground.groundSpeed;
            }
        }

        if (speed <= 0) return 1000;
        return Math.max(Math.floor((groundSpeed * 1000) / speed), 50);
    }

    /**
     * Handle any map position change event.
     * 
     * CRITICAL: Diagonal steps (NE/SE/SW/NW) produce TWO events
     * (e.g. MapTopRow + MapRightColumn). We must debounce so that:
     *  - Both events settle before we check position
     *  - We only count ONE position confirmation per actual step
     * 
     * @private
     */
    _onPositionChange(data) {
        if (!this._walking || this._stopped) return;

        // Debounce: wait 60ms for all events from a single step to arrive
        // (both map packets from a diagonal step come in the same TCP segment)
        if (this._posDebounceTimer) clearTimeout(this._posDebounceTimer);
        this._posDebounceTimer = setTimeout(() => {
            this._posDebounceTimer = null;
            this._onPositionSettled();
        }, 60);
    }

    /**
     * Called after position events have settled (debounced).
     * Now we can safely check the player's FINAL position for this step.
     * @private
     */
    _onPositionSettled() {
        if (!this._walking || this._stopped) return;

        // Atomic position snapshot — avoids reading a position that changes mid-handler
        const pos = this._getPlayerPos();
        if (!pos) return;

        // Check if position actually changed from last confirmed
        if (this._lastConfirmedPos &&
            pos.x === this._lastConfirmedPos.x &&
            pos.y === this._lastConfirmedPos.y &&
            pos.z === this._lastConfirmedPos.z) {
            // Position didn't change — not a real step confirmation
            return;
        }

        // Position changed — this is a confirmed step (pos is already an isolated snapshot)
        this._lastConfirmedPos = pos;
        this._pendingSteps = Math.max(0, this._pendingSteps - 1);
        this._consecutiveStucks = 0; // Reset stuck counter on successful movement
        this._consecutiveCancels = 0; // Reset cancel counter on successful movement

        // Reset stuck timer since we got movement
        if (this._stuckTimer) {
            clearTimeout(this._stuckTimer);
            this._stuckTimer = null;
        }

        this.logger.debug(`Step confirmed → (${pos.x},${pos.y},${pos.z}) pending=${this._pendingSteps}`);

        // Check arrival
        if (this._isAtDestination(pos)) {
            this._finish(true);
            return;
        }

        // If path exhausted and no more pending, do final check
        if (this._currentPath && this._pathIndex >= this._currentPath.directions.length && this._pendingSteps <= 0) {
            this._doArrivalCheck();
            return;
        }

        // Send more steps if under the limit
        if (this._pendingSteps < this.maxPending) {
            this._sendNextStep();
        }
    }

    /**
     * Handle server cancelWalk (obstacle, can't move that way)
     * @private
     */
    _onCancelWalk(data) {
        this._handleWalkRejection('cancelWalk');
    }

    /**
     * Handle textMessage — detect server rejection messages that aren't
     * accompanied by a cancelWalk packet (e.g. "Sorry, not possible.")
     * @private
     */
    _onTextMessage(data) {
        if (!this._walking || this._stopped) return;
        if (!data || !data.message) return;

        // Tibia sends these messages when a walk is rejected but doesn't always
        // send a cancelWalk (0xB5) packet alongside them
        const msg = data.message.toLowerCase();
        const rejectPatterns = [
            'sorry, not possible',
            'you cannot go there',
            'there is no way',
            'it is locked',
            'the door seems to be sealed',
        ];

        if (rejectPatterns.some(p => msg.includes(p))) {
            this._handleWalkRejection(`textMessage: ${data.message}`);
        }
    }

    /**
     * Central handler for walk rejections (from cancelWalk or textMessage).
     * Uses escalating delays to avoid spamming the server.
     * @private
     * @param {string} source - What triggered the rejection (for logging)
     */
    _handleWalkRejection(source) {
        if (!this._walking || this._stopped) return;

        this._consecutiveCancels++;
        this._clearTimers();
        this._pendingSteps = 0;
        this._consecutiveStucks = 0;

        // Atomic position snapshot
        const currentPos = this._getPlayerPos();
        if (currentPos) {
            this._lastConfirmedPos = currentPos;
        }

        // Give up after too many consecutive rejections
        const maxCancels = this._forceWalk ? this._maxConsecutiveCancels * 2 : this._maxConsecutiveCancels;
        if (this._consecutiveCancels > maxCancels) {
            this.logger.warn(`Walk rejected ${this._consecutiveCancels} times (${source}), giving up`);
            this._finish(false, 'Too many walk rejections');
            return;
        }

        // Escalating delay: 200ms, 400ms, 800ms, 1200ms, 1500ms...
        const delay = Math.min(200 * this._consecutiveCancels, 1500);
        this.logger.debug(`Walk rejected (${source}), cancel #${this._consecutiveCancels}, retry in ${delay}ms`);

        this.emit('walkCancelled');

        // Recalculate path from current position after delay
        setTimeout(() => {
            if (!this._stopped && this._walking) this._recalcAndWalk(0);
        }, delay);
    }

    /**
     * Handle disconnection
     * @private
     */
    _onDisconnected() {
        this._finish(false, 'Disconnected');
    }

    /**
     * Final arrival check when path is exhausted and no pending steps
     * @private
     */
    _doArrivalCheck() {
        // Atomic position snapshot
        const pos = this._getPlayerPos();
        if (!pos || !this._destination) {
            this._finish(false, 'Lost position');
            return;
        }

        if (this._isAtDestination(pos)) {
            this._finish(true);
        } else {
            // Path exhausted but not at destination — recalculate
            // This naturally handles partial paths: player moved closer,
            // new tiles loaded from server, next recalc should find more path.
            this.logger.debug(`Path exhausted at (${pos.x},${pos.y},${pos.z}), ` +
                `destination (${this._destination.x},${this._destination.y},${this._destination.z}), ` +
                `recalc #${this._totalRecalcs}, recalculating...`);
            // Small delay to let map tiles settle after last step
            setTimeout(() => {
                if (!this._stopped) this._recalcAndWalk(0);
            }, 100);
        }
    }

    /**
     * Finish walk operation
     * @private
     */
    _finish(success, reason) {
        this._walking = false;
        this._clearTimers();
        this._detachListeners();
        this._currentPath = null;
        this._pendingSteps = 0;

        // Clear auxCoord timer on finish
        if (this._auxCoordTimer) {
            clearTimeout(this._auxCoordTimer);
            this._auxCoordTimer = null;
        }

        if (success) {
            this.logger.debug('Arrived at destination');
            this.emit('arrived', this._destination);
        } else {
            this.logger.debug(`Walk failed: ${reason || 'unknown'}`);
            this.emit('walkFailed', { destination: this._destination, reason });
        }

        if (this._resolve) {
            this._resolve(success);
            this._resolve = null;
            this._reject = null;
        }
    }

    /**
     * Attach event listeners to session
     * @private
     */
    _attachListeners() {
        this._detachListeners();

        const game = this.session.game;
        if (!game) return;

        // Listen for map movement events (position change)
        game.on('mapDescription', this._onPositionChange);
        game.on('mapTopRow', this._onPositionChange);
        game.on('mapRightColumn', this._onPositionChange);
        game.on('mapBottomRow', this._onPositionChange);
        game.on('mapLeftColumn', this._onPositionChange);
        game.on('floorChangeUp', this._onPositionChange);
        game.on('floorChangeDown', this._onPositionChange);
        game.on('cancelWalk', this._onCancelWalk);
        game.on('textMessage', this._onTextMessage);
        game.on('disconnected', this._onDisconnected);
    }

    /**
     * Detach event listeners
     * @private
     */
    _detachListeners() {
        const game = this.session.game;
        if (!game) return;

        game.removeListener('mapDescription', this._onPositionChange);
        game.removeListener('mapTopRow', this._onPositionChange);
        game.removeListener('mapRightColumn', this._onPositionChange);
        game.removeListener('mapBottomRow', this._onPositionChange);
        game.removeListener('mapLeftColumn', this._onPositionChange);
        game.removeListener('floorChangeUp', this._onPositionChange);
        game.removeListener('floorChangeDown', this._onPositionChange);
        game.removeListener('cancelWalk', this._onCancelWalk);
        game.removeListener('textMessage', this._onTextMessage);
        game.removeListener('disconnected', this._onDisconnected);
    }
}

module.exports = Walker;
