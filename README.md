# Sokoban Solver — room decomposition + push-optimal BFS

A solver for make.fun's "Build the best Sokoban solver" bounty
(`sokoban-solver-01-run-20261121`). One program answers all 5 instances of
a set in a single run, in as few pushes as possible.

## Results

Practice set (kit): **1,000,000 / 1,000,000** — every instance solved
exactly at its push optimum P\*:

| instance | rooms | P\* | pushes | points |
|----------|-------|-----|--------|--------|
| i001 | 1 | 13 | 13 | 1,000 |
| i002 | 1 | 16 | 16 | 1,000 |
| i003 | 2 | 29 | 29 | 1,000 |
| i004 | 3 | 47 | 47 | 1,000 |
| i005 | 4 | 60 | 60 | 1,000 |

Two runs on the practice set write byte-identical output, in about 2
seconds total — far inside the 60-second wall budget. Sixteen further
sets drawn at random with the kit's own generator also scored 1,000,000
each (~1.5 s per set), including sets with P\* up to 67.

## Why rooms

Every level is a one-square-wide hallway with one to four small rooms off
it, each room holding 3–4 boxes and as many goals behind a single door. A
box pushed out of a room through its door can never be pushed back (the
player would have to stand on the hallway's far side, which is wall), so
every box stays in its own room and the level's push optimum is the sum of
its rooms' optima. Solving the whole level at once would meet the product
of the rooms' state spaces; solving room by room meets only their sum.

## Algorithm

**1. Split into rooms.** Dead-square analysis first marks every square
from which a box can never be pushed onto a goal (computed backwards from
the goals: a square is live when a live square lies beyond it with open
floor behind it for the player to stand on). Hallway squares are never
live, so cutting the dead squares of the player's row out of the floor
splits the board into components; each component holding boxes is a room.
The split is rejected when a box starts in the hallway, a goal falls
outside every component, or some component holds a different number of
boxes and goals — then the whole level is searched instead.

**2. Push-optimal search per room.** Each room is solved with a
breadth-first search over pushes, the other rooms' boxes standing as walls
(on their goals once their room is done, else where they stand). A state
is the sorted squares of the boxes plus the player's reachable region,
named by its lowest square. States expand in order of pushes made, so the
first solved state found is push-optimal. Two safe prunes keep the search
small without ever cutting a solvable state:

- *Dead squares:* a box is never pushed onto a non-live square.
- *Frozen 2×2 blocks:* four squares of walls and boxes holding a box off
  its goal — that box can never move again.

The player's walk to each push square is a shortest-path search, ties
broken by the fixed direction order (up, down, left, right).

**3. Join.** The rooms' move strings are concatenated; the player walks
from where one room left it to the next room's door. The answer is a
string of `u`/`d`/`l`/`r` moves (a capital letter marks a push; the
checker ignores case).

## Determinism and budget

The search is budgeted by *work*, never by the clock: at most 250,000
states per room search and 4,000,000 states for the whole run. The program
reads no clock, no randomness and no environment as a source of variation,
and every tie is broken by square order, so two executions on the same
input write the same bytes. An instance that cannot be solved within its
budget still gets a (valid, empty) `solution.txt`, so the entry always
answers every instance.

## Running it

```sh
MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

`main.ts` is plain TypeScript with erasable syntax only (Node 22+
type-stripping, no dependencies, no network). It reads
`$MAKEFUN_INPUT_DIR/<id>/level.txt` (XSB) and writes
`$MAKEFUN_OUTPUT_DIR/<id>/solution.txt`, creating the directory itself.

## Files

- `main.ts` — the solver (the whole entry).
- `LICENSE` — MIT.
- `.makefun/owner.json` — the payout wallet.
