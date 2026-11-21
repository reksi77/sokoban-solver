// Sokoban solver: room decomposition + push-optimal breadth-first search.
//
// Strategy
// --------
// A level is a one-square-wide hallway with one to four small rooms off it.
// A box pushed out of a room through its door can never come back, so every
// box stays in its own room and the level's push optimum is the sum of its
// rooms' optima. The solver therefore
//   1. splits the level into rooms (see splitRooms below),
//   2. solves each room push-optimally on its own with a breadth-first
//      search over pushes, the other rooms' boxes standing as walls,
//   3. joins the rooms' move strings with the player's walks between doors.
// If the level does not split into rooms, a breadth-first search over the
// whole level is tried instead.
//
// The push search
// ---------------
// A state is the sorted squares of the boxes plus the player's reachable
// region, named by its lowest square (two states with the same boxes and the
// same reachable region are the same state). States are expanded in order of
// pushes made, so the first solved state found is push-optimal. Two safe
// prunes keep the search small without ever cutting a solvable state:
//   * dead squares: a square from which no sequence of pushes (ignoring the
//     other boxes) can bring a box onto a goal; a box is never pushed there.
//   * frozen 2x2 blocks: four squares of walls and boxes holding a box off
//     its goal; such a box can never move again.
// The search is budgeted by states expanded, never by the clock, and every
// tie is broken by square order, so two runs write the same bytes.
//
// Input / output
// --------------
// Reads /input/<id>/level.txt (XSB) and writes /output/<id>/solution.txt,
// a string of u/d/l/r moves (a capital letter marks a push; the checker
// ignores case). MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR override the
// directories, as in the kit's starter.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// The four moves: [dx, dy, walk letter, push letter]. Fixed order everywhere,
// so every tie in every search below breaks the same way on every run.
const DIRS: ReadonlyArray<readonly [number, number, string, string]> = [
  [0, -1, 'u', 'U'],
  [0, 1, 'd', 'D'],
  [-1, 0, 'l', 'L'],
  [1, 0, 'r', 'R'],
];

// How many states one room search may keep, and how many states the whole
// run may spend across all instances. Counts, not seconds: the same input
// always spends the same work and writes the same answer.
const ROOM_STATE_BUDGET = 250_000;
const GLOBAL_STATE_BUDGET = 4_000_000;

interface Level {
  w: number;
  h: number;
  wall: Uint8Array; // 1 on walls (and outside the board), 0 on floor
  goals: number[]; // sorted
  boxes: number[]; // sorted
  player: number;
}

interface Room {
  squares: number[];
  boxes: number[];
  goals: number[];
}

/** Parse XSB text into a level. Short rows are padded with walls. */
function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  goals.sort((a, b) => a - b);
  boxes.sort((a, b) => a - b);
  // The outermost frame is wall whatever the text shows: nothing leaves
  // the board, and the searches below step one square past any floor square.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  return { w, h, wall, goals, boxes, player };
}

/**
 * Dead-square analysis: the squares from which a box, alone on the board,
 * can be pushed onto some goal. Computed backwards from the goals: a square
 * y is live when some live square x = y + d sits beyond it with the square
 * behind it (y - d, where the player must stand to push towards x) open.
 * A box on a non-live square can never reach a goal, so it is never pushed
 * there. Hallway squares are never live: the only way in is through a door,
 * and the square behind a box in the hallway is a wall.
 */
function liveSquares(level: Level): Uint8Array {
  const { w, wall, goals } = level;
  const live = new Uint8Array(wall.length);
  const queue: number[] = [];
  for (const g of goals) {
    live[g] = 1;
    queue.push(g);
  }
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi];
    for (const [dx, dy] of DIRS) {
      const d = dy * w + dx;
      const y = x - d;
      const behind = y - d;
      if (y < 0 || y >= wall.length) continue;
      if (behind < 0 || behind >= wall.length) continue;
      if (!wall[y] && !wall[behind] && !live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

/**
 * Flood fill: the squares the player reaches from `from` with the boxes in
 * `occupied` in the way. Marks them in `seen` with `stamp` and returns the
 * lowest square reached, the region's name in a state key.
 */
function reach(
  level: Level,
  occupied: Uint8Array,
  from: number,
  seen: Int32Array,
  stamp: number,
  stack: Int32Array,
): number {
  const { w, wall } = level;
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n];
    if (p < low) low = p;
    // Up, down, left, right; the board's outer frame is wall, so no bounds
    // check is needed beyond the wall array itself.
    if (!wall[p - w] && !occupied[p - w] && seen[p - w] !== stamp) {
      seen[p - w] = stamp;
      stack[n++] = p - w;
    }
    if (!wall[p + w] && !occupied[p + w] && seen[p + w] !== stamp) {
      seen[p + w] = stamp;
      stack[n++] = p + w;
    }
    if (!wall[p - 1] && !occupied[p - 1] && seen[p - 1] !== stamp) {
      seen[p - 1] = stamp;
      stack[n++] = p - 1;
    }
    if (!wall[p + 1] && !occupied[p + 1] && seen[p + 1] !== stamp) {
      seen[p + 1] = stamp;
      stack[n++] = p + 1;
    }
  }
  return low;
}

/**
 * Whether the box just pushed to `t` sits in a frozen 2x2 block: four
 * squares of walls and boxes, one of them a box off its goal. A frozen box
 * can never be pushed again, so the state is dead.
 */
function frozenBlock(
  level: Level,
  occupied: Uint8Array,
  goal: Uint8Array,
  t: number,
): boolean {
  const { w, wall } = level;
  const starts = [t, t - 1, t - w, t - w - 1];
  for (const a of starts) {
    const b = a + 1;
    const c = a + w;
    const d = c + 1;
    if (a < 0 || d >= wall.length) continue;
    if (!(wall[a] || occupied[a])) continue;
    if (!(wall[b] || occupied[b])) continue;
    if (!(wall[c] || occupied[c])) continue;
    if (!(wall[d] || occupied[d])) continue;
    if (
      (occupied[a] && !goal[a]) ||
      (occupied[b] && !goal[b]) ||
      (occupied[c] && !goal[c]) ||
      (occupied[d] && !goal[d])
    ) {
      return true;
    }
  }
  return false;
}

/**
 * The shortest walk from `from` to `to` around walls and boxes, in lower
 * LURD letters, ties broken by the fixed direction order. The caller only
 * asks for squares the player can reach.
 */
function walkTo(
  level: Level,
  occupied: Uint8Array,
  from: number,
  to: number,
): string {
  const { w, wall } = level;
  if (from === to) return '';
  const prev = new Int32Array(wall.length).fill(-1);
  const how: string[] = new Array(wall.length);
  const queue: number[] = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi];
    if (p === to) break;
    for (const [dx, dy, letter] of DIRS) {
      const q = p + dy * w + dx;
      if (wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = letter;
      queue.push(q);
    }
  }
  if (prev[to] === -1) throw new Error('walkTo: target square out of reach');
  let s = '';
  for (let p = to; p !== from; p = prev[p]) s = how[p] + s;
  return s;
}

interface PushSolution {
  pushes: number;
  moves: string;
  states: number;
}

/**
 * Push-optimal breadth-first search over one level (a whole level or one
 * room embedded in it). Expands states in order of pushes made, so the
 * first solved state is optimal. Returns null when the budget runs out or
 * the level has no solution. `spent` counts states for the run-wide budget.
 */
function solvePushOptimal(
  level: Level,
  maxStates: number,
  spent: { count: number },
): PushSolution | null {
  const { w, wall, goals } = level;
  const size = wall.length;
  const goal = new Uint8Array(size);
  for (const g of goals) goal[g] = 1;
  const live = liveSquares(level);
  const solved = (boxes: number[]): boolean => boxes.every((b) => goal[b]);

  // A box that starts on a dead square dooms the level at once.
  if (level.boxes.some((b) => !live[b])) return null;
  if (solved(level.boxes)) return { pushes: 0, moves: '', states: 0 };

  const occupied = new Uint8Array(size);
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;

  // The states in order found: their boxes, the player's square after the
  // push that made them, and the push (from, to) that made them.
  const statesBoxes: number[][] = [level.boxes.slice()];
  const statesPlayer: number[] = [level.player];
  const statesFrom: number[] = [-1];
  const statesTo: number[] = [-1];
  const parent: number[] = [-1];
  const index = new Map<string, number>();

  const keyOf = (boxes: number[], low: number): string =>
    boxes.join(',') + '|' + low;

  for (const b of level.boxes) occupied[b] = 1;
  const startLow = reach(level, occupied, level.player, seen, ++stamp, stack);
  for (const b of level.boxes) occupied[b] = 0;
  index.set(keyOf(level.boxes, startLow), 0);

  let found = -1;
  for (let head = 0; found < 0 && head < statesBoxes.length; head++) {
    const boxes = statesBoxes[head];
    for (const b of boxes) occupied[b] = 1;
    reach(level, occupied, statesPlayer[head], seen, ++stamp, stack);
    const here = stamp;
    for (let bi = 0; bi < boxes.length && found < 0; bi++) {
      const b = boxes[bi];
      for (const [dx, dy] of DIRS) {
        const d = dy * w + dx;
        const behind = b - d;
        const t = b + d;
        if (seen[behind] !== here) continue; // player cannot reach the push square
        if (wall[t] || occupied[t] || !live[t]) continue;
        occupied[b] = 0;
        occupied[t] = 1;
        let key = '';
        let next: number[] | null = null;
        if (!frozenBlock(level, occupied, goal, t)) {
          next = boxes.slice();
          next[bi] = t;
          next.sort((x, y) => x - y);
          // A separate marking array: this reach must not overwrite the
          // parent region's marks in `seen`, which the loop still reads.
          const low = reach(level, occupied, b, mark, ++stamp, stack);
          key = keyOf(next, low);
        }
        occupied[t] = 0;
        occupied[b] = 1;
        if (next === null || index.has(key)) continue;
        if (statesBoxes.length >= maxStates || spent.count >= GLOBAL_STATE_BUDGET) {
          for (const x of boxes) occupied[x] = 0;
          return null;
        }
        spent.count++;
        index.set(key, statesBoxes.length);
        statesBoxes.push(next);
        statesPlayer.push(b); // after the push the player stands where the box was
        statesFrom.push(b);
        statesTo.push(t);
        parent.push(head);
        if (solved(next)) {
          found = statesBoxes.length - 1;
          break;
        }
      }
    }
    for (const x of boxes) occupied[x] = 0;
  }
  if (found < 0) return null;

  // Rebuild the moves: for each push on the path, walk to the push square
  // (from where the player stands) and push.
  const path: number[] = [];
  for (let s = found; s > 0; s = parent[s]) path.push(s);
  path.reverse();
  let moves = '';
  let player = level.player;
  let boxes = level.boxes;
  for (const s of path) {
    const from = statesFrom[s];
    const to = statesTo[s];
    const d = to - from;
    const dir = DIRS.find(([dx, dy]) => dy * w + dx === d);
    if (dir === undefined) throw new Error('solvePushOptimal: bad push step');
    for (const b of boxes) occupied[b] = 1;
    moves += walkTo(level, occupied, player, from - d);
    for (const b of boxes) occupied[b] = 0;
    moves += dir[3];
    player = from;
    boxes = statesBoxes[s];
  }
  return { pushes: path.length, moves, states: statesBoxes.length };
}

/**
 * Split a level into rooms: cut the dead squares of the player's row (the
 * hallway: a box there reaches no goal) out of the floor, and each part left
 * that holds a box is a room. Returns null when the level is no set of rooms
 * (a box starts in the hallway, a goal falls outside every part, or some
 * part holds a different number of boxes and goals).
 */
function splitRooms(level: Level): Room[] | null {
  const { w, wall, goals, boxes, player } = level;
  const live = liveSquares(level);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(wall.length);
  for (let i = row * w; i < (row + 1) * w; i++) {
    if (!wall[i] && !live[i]) cut[i] = 1;
  }
  if (boxes.some((b) => cut[b])) return null;
  const part = new Int32Array(wall.length).fill(-1);
  const rooms: Room[] = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares: number[] = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      for (const [dx, dy] of DIRS) {
        const q = squares[i] + dy * w + dx;
        if (!wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ squares, boxes: [], goals: [] });
  }
  for (const b of boxes) {
    if (part[b] < 0) return null;
    rooms[part[b]].boxes.push(b);
  }
  for (const g of goals) {
    if (part[g] < 0) return null;
    rooms[part[g]].goals.push(g);
  }
  if (rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  const withBoxes = rooms.filter((r) => r.boxes.length > 0);
  // Deterministic order: by each room's lowest square.
  withBoxes.sort((a, b) => a.squares[0] - b.squares[0]);
  return withBoxes;
}

/** The square the player stands on after `moves` from `from`. */
function endOf(w: number, from: number, moves: string): number {
  let p = from;
  for (const ch of moves.toLowerCase()) {
    p += ch === 'u' ? -w : ch === 'd' ? w : ch === 'l' ? -1 : 1;
  }
  return p;
}

/**
 * Solve one level: room by room when it splits into rooms, else a search
 * over the whole level. Returns the move string, or '' when unsolved (an
 * empty answer is valid, worth no points, and keeps the instance answered).
 */
function solveLevel(level: Level, spent: { count: number }): string {
  const rooms = splitRooms(level);
  if (rooms !== null) {
    let player = level.player;
    let moves = '';
    const done = new Set<number>();
    for (const room of rooms) {
      // The room's own sub-level: the level's walls, plus the other rooms'
      // boxes as walls (on their goals once their room is done, else where
      // they stand). Boxes never leave their room, so the rooms are
      // independent and their optima add up.
      const wall = level.wall.slice();
      for (const other of rooms) {
        if (other === room) continue;
        const at = done.has(other.squares[0])
          ? other.goals
          : other.boxes;
        for (const b of at) wall[b] = 1;
      }
      const sub: Level = {
        w: level.w,
        h: level.h,
        wall,
        goals: room.goals.slice().sort((a, b) => a - b),
        boxes: room.boxes.slice().sort((a, b) => a - b),
        player,
      };
      const solved = solvePushOptimal(sub, ROOM_STATE_BUDGET, spent);
      if (solved === null) return '';
      moves += solved.moves;
      player = endOf(level.w, player, solved.moves);
      done.add(room.squares[0]);
    }
    return moves;
  }
  // No rooms: one search over the whole level.
  const solved = solvePushOptimal(level, ROOM_STATE_BUDGET, spent);
  return solved === null ? '' : solved.moves;
}

const spent = { count: 0 };
for (const id of readdirSync(INPUT_DIR).sort()) {
  let moves = '';
  try {
    const level = parseLevel(readFileSync(join(INPUT_DIR, id, 'level.txt'), 'utf8'));
    moves = solveLevel(level, spent);
  } catch {
    moves = '';
  }
  mkdirSync(join(OUTPUT_DIR, id), { recursive: true });
  writeFileSync(join(OUTPUT_DIR, id, 'solution.txt'), `${moves}\n`);
}
