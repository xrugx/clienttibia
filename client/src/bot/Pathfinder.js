'use strict';

/**
 * Pathfinder - A* pathfinding on the game map
 * 
 * Matches the original OTClient pathfinding behavior:
 * - Uses game map tiles for collision detection
 * - Checks tile walkability (ground, blocking items, creatures)
 * - Weighted costs based on ground speed
 * - Diagonal movement costs ~1.5× more than cardinal (≈√2)
 * - Supports ignoring creatures, non-pathable tiles (fields), etc.
 * 
 * Returns an array of direction constants matching the autoWalk protocol format.
 */

const {
    DIRECTION_NORTH, DIRECTION_EAST, DIRECTION_SOUTH, DIRECTION_WEST,
    DIRECTION_NORTHEAST, DIRECTION_SOUTHEAST, DIRECTION_SOUTHWEST, DIRECTION_NORTHWEST,
    PATH_NORTH, PATH_EAST, PATH_SOUTH, PATH_WEST,
    PATH_NORTHEAST, PATH_SOUTHEAST, PATH_SOUTHWEST, PATH_NORTHWEST,
} = require('../constants/GameConstants');

/**
 * 8 neighbors: [dx, dy, direction, pathDirection, isDiagonal]
 */
const NEIGHBORS = [
    { dx:  0, dy: -1, dir: DIRECTION_NORTH,     pathDir: PATH_NORTH,     diag: false },
    { dx:  1, dy:  0, dir: DIRECTION_EAST,      pathDir: PATH_EAST,      diag: false },
    { dx:  0, dy:  1, dir: DIRECTION_SOUTH,     pathDir: PATH_SOUTH,     diag: false },
    { dx: -1, dy:  0, dir: DIRECTION_WEST,      pathDir: PATH_WEST,      diag: false },
    { dx:  1, dy: -1, dir: DIRECTION_NORTHEAST, pathDir: PATH_NORTHEAST, diag: true },
    { dx:  1, dy:  1, dir: DIRECTION_SOUTHEAST, pathDir: PATH_SOUTHEAST, diag: true },
    { dx: -1, dy:  1, dir: DIRECTION_SOUTHWEST, pathDir: PATH_SOUTHWEST, diag: true },
    { dx: -1, dy: -1, dir: DIRECTION_NORTHWEST, pathDir: PATH_NORTHWEST, diag: true },
];

/**
 * Priority queue (min-heap) for A*
 */
class MinHeap {
    constructor() { this.data = []; }

    push(item) {
        this.data.push(item);
        this._bubbleUp(this.data.length - 1);
    }

    pop() {
        const top = this.data[0];
        const last = this.data.pop();
        if (this.data.length > 0) {
            this.data[0] = last;
            this._sinkDown(0);
        }
        return top;
    }

    get size() { return this.data.length; }

    _bubbleUp(i) {
        while (i > 0) {
            const parent = (i - 1) >> 1;
            if (this.data[i].f >= this.data[parent].f) break;
            [this.data[i], this.data[parent]] = [this.data[parent], this.data[i]];
            i = parent;
        }
    }

    _sinkDown(i) {
        const n = this.data.length;
        while (true) {
            let smallest = i;
            const left = 2 * i + 1;
            const right = 2 * i + 2;
            if (left < n && this.data[left].f < this.data[smallest].f) smallest = left;
            if (right < n && this.data[right].f < this.data[smallest].f) smallest = right;
            if (smallest === i) break;
            [this.data[i], this.data[smallest]] = [this.data[smallest], this.data[i]];
            i = smallest;
        }
    }
}

class Pathfinder {
    /**
     * @param {import('../core/Map')} gameMap - The game map instance
     * @param {object} [options]
     * @param {boolean} [options.ignoreCreatures=true] - Don't treat creatures as blocking
     * @param {boolean} [options.ignoreNonPathable=false] - Ignore fire/poison fields
     * @param {number} [options.maxSteps=200] - Max search iterations
     * @param {number} [options.maxDistance=50] - Max distance from start to search
     */
    /**
     * @param {import('../core/Map')} gameMap - The game map instance
     * @param {object} [options]
     * @param {boolean} [options.ignoreCreatures=true] - Don't treat creatures as blocking
     * @param {boolean} [options.ignoreNonPathable=false] - Ignore fire/poison fields
     * @param {boolean} [options.forceWalk=false] - Ignore ALL obstacles (items, creatures, fields)
     * @param {number} [options.maxSteps=200] - Max search iterations
     * @param {number} [options.maxDistance=50] - Max distance from start to search
     */
    constructor(gameMap, options = {}) {
        this.map = gameMap;
        this.ignoreCreatures = options.ignoreCreatures !== false;
        this.ignoreNonPathable = options.ignoreNonPathable || false;
        this.forceWalk = options.forceWalk || false;
        this.maxSteps = options.maxSteps || 200;
        this.maxDistance = options.maxDistance || 50;
    }

    /**
     * Find a path from start to goal on the same Z level
     * 
     * @param {import('../core/Position')} start - Start position
     * @param {import('../core/Position')} goal - Goal position
     * @param {number} [precision=0] - Allow stopping this many tiles away from goal
     * @returns {{ directions: number[], pathDirs: number[], positions: Position[] } | null}
     *   directions: internal direction constants
     *   pathDirs: autoWalk protocol direction bytes
     *   positions: intermediate positions
     */
    findPath(start, goal, precision = 0) {
        // Must be on same floor
        if (start.z !== goal.z) return null;

        // Already there
        if (start.x === goal.x && start.y === goal.y) return { directions: [], pathDirs: [], positions: [], partial: false };

        // Too far
        const dist = Math.max(Math.abs(start.x - goal.x), Math.abs(start.y - goal.y));
        if (dist > this.maxDistance) return null;

        const key = (x, y) => `${x}:${y}`;
        const z = start.z;

        const open = new MinHeap();
        const closed = new Set();
        const gScore = new Map();
        const cameFrom = new Map(); // key -> { parentKey, dir, pathDir, x, y }

        const startKey = key(start.x, start.y);
        gScore.set(startKey, 0);

        open.push({
            x: start.x,
            y: start.y,
            g: 0,
            f: this._heuristic(start.x, start.y, goal.x, goal.y),
        });

        // Track best explored node (closest to goal) for partial paths
        const startDist = Math.max(Math.abs(start.x - goal.x), Math.abs(start.y - goal.y));
        let bestNodeKey = null;
        let bestNodeDist = startDist;

        let iterations = 0;

        while (open.size > 0 && iterations < this.maxSteps) {
            iterations++;

            const current = open.pop();
            const currentKey = key(current.x, current.y);

            // Check if we reached the goal (or within precision)
            const distToGoal = Math.max(Math.abs(current.x - goal.x), Math.abs(current.y - goal.y));
            if (distToGoal <= precision) {
                const path = this._reconstructPath(cameFrom, currentKey, start);
                path.partial = false;
                return path;
            }

            if (closed.has(currentKey)) continue;
            closed.add(currentKey);

            // Track closest explored node for partial path fallback
            if (distToGoal < bestNodeDist) {
                bestNodeDist = distToGoal;
                bestNodeKey = currentKey;
            }

            // Explore neighbors
            for (const nb of NEIGHBORS) {
                const nx = current.x + nb.dx;
                const ny = current.y + nb.dy;
                const neighborKey = key(nx, ny);

                if (closed.has(neighborKey)) continue;

                // Check if tile is walkable
                if (!this._isWalkable(nx, ny, z, nb.diag, current.x, current.y)) continue;

                // Calculate movement cost
                // Diagonal ≈ √2 × cardinal. Using 1.5 so 1 diagonal (1.5) < 2 cardinal (2.0)
                const tile = this.map.getTile({ x: nx, y: ny, z });
                const groundSpeed = this._getGroundSpeed(tile);
                const moveCost = nb.diag ? Math.floor(groundSpeed * 1.5) : groundSpeed;
                const tentativeG = current.g + moveCost;

                const existingG = gScore.get(neighborKey);
                if (existingG !== undefined && tentativeG >= existingG) continue;

                gScore.set(neighborKey, tentativeG);
                cameFrom.set(neighborKey, {
                    parentKey: currentKey,
                    dir: nb.dir,
                    pathDir: nb.pathDir,
                    x: nx,
                    y: ny,
                });

                open.push({
                    x: nx,
                    y: ny,
                    g: tentativeG,
                    f: tentativeG + this._heuristic(nx, ny, goal.x, goal.y),
                });
            }
        }

        // No complete path found — try returning partial path
        // (best explored node closer to goal than start)
        if (bestNodeKey && bestNodeDist < startDist) {
            const path = this._reconstructPath(cameFrom, bestNodeKey, start);
            path.partial = true;
            return path;
        }

        // No path found at all
        return null;
    }

    /**
     * Check if a tile is walkable
     * @private
     */
    _isWalkable(x, y, z, isDiagonal, fromX, fromY) {
        const tile = this.map.getTile({ x, y, z });

        // forceWalk mode: only require that the tile exists (was seen)
        // Ignore ALL blocking items, creatures, and non-pathable flags
        if (this.forceWalk) {
            // If tile is unknown, still allow it in force mode
            // (we'll send the walk command and let the server decide)
            if (!tile) return true;
            // Has ground? Good enough in force mode
            return true;
        }

        // If tile is not known (not in our map), assume NOT walkable
        // (conservative - only walk on tiles we've actually seen)
        if (!tile) return false;

        // Must have ground
        if (!tile.ground) return false;

        // Check all things on the tile
        for (const thing of tile.things) {
            // Check if it's a creature blocking the tile
            if (thing.type === 'creature' || thing.type === 'player' || thing.type === 'npc' || thing.type === 'monster') {
                if (!this.ignoreCreatures) {
                    // Check if creature is not passable
                    if (thing.impassable !== false) return false;
                }
                continue;
            }

            // Check item flags from DatManager attributes if available
            if (thing.isNotWalkable) return false;
            if (!this.ignoreNonPathable && thing.isNotPathable) return false;
        }

        // For diagonal movement, check that both adjacent cardinal tiles are also walkable
        // (can't cut through corners)
        if (isDiagonal) {
            const dx = x - fromX;
            const dy = y - fromY;

            const tile1 = this.map.getTile({ x: fromX + dx, y: fromY, z });
            const tile2 = this.map.getTile({ x: fromX, y: fromY + dy, z });

            if (!this._isTilePassable(tile1) || !this._isTilePassable(tile2)) {
                return false;
            }
        }

        return true;
    }

    /**
     * Check if a tile is passable (for diagonal corner check)
     * @private
     */
    _isTilePassable(tile) {
        if (this.forceWalk) return true;
        if (!tile || !tile.ground) return false;
        for (const thing of tile.things) {
            if (thing.isNotWalkable) return false;
            if (thing.type === 'creature' || thing.type === 'player' || thing.type === 'npc' || thing.type === 'monster') {
                if (!this.ignoreCreatures && thing.impassable !== false) return false;
            }
        }
        return true;
    }

    /**
     * Get ground speed of a tile (higher = slower/more expensive)
     * Default 100 if unknown
     * @private
     */
    _getGroundSpeed(tile) {
        if (!tile || !tile.ground) return 100;
        return tile.ground.groundSpeed || 100;
    }

    /**
     * Octile distance heuristic (for 8-direction movement)
     * Uses minimum ground speed (100) with diagonal ≈ 1.5× cardinal
     * @private
     */
    _heuristic(x1, y1, x2, y2) {
        const dx = Math.abs(x1 - x2);
        const dy = Math.abs(y1 - y2);
        // Cardinal = 100, diagonal = 150 (matching movement cost ratio)
        return (Math.max(dx, dy) - Math.min(dx, dy)) * 100 + Math.min(dx, dy) * 150;
    }

    /**
     * Reconstruct path from A* came-from map
     * @private
     */
    _reconstructPath(cameFrom, endKey, start) {
        const directions = [];
        const pathDirs = [];
        const positions = [];
        let currentKey = endKey;

        while (cameFrom.has(currentKey)) {
            const node = cameFrom.get(currentKey);
            directions.unshift(node.dir);
            pathDirs.unshift(node.pathDir);
            positions.unshift({ x: node.x, y: node.y, z: start.z });
            currentKey = node.parentKey;
        }

        return { directions, pathDirs, positions };
    }

    /**
     * Get direction from one position to an adjacent position
     * @param {Position} from
     * @param {Position} to
     * @returns {number|null} Direction constant or null
     */
    static getDirection(from, to) {
        const dx = to.x - from.x;
        const dy = to.y - from.y;

        for (const nb of NEIGHBORS) {
            if (nb.dx === dx && nb.dy === dy) return nb.dir;
        }
        return null;
    }

    /**
     * Get path direction byte from one position to an adjacent position
     * (for autoWalk protocol)
     * @param {Position} from
     * @param {Position} to
     * @returns {number|null}
     */
    static getPathDirection(from, to) {
        const dx = to.x - from.x;
        const dy = to.y - from.y;

        for (const nb of NEIGHBORS) {
            if (nb.dx === dx && nb.dy === dy) return nb.pathDir;
        }
        return null;
    }
}

module.exports = Pathfinder;
