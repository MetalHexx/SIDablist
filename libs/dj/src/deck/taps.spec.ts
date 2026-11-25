import {
  fitBeatGrid,
  handleScanRequest,
  recordRegisters,
  type AnalysisScanner,
  type NoteStarts,
  noteStarts,
} from '@sidablist/analysis';
import type { CrossingLines } from '@sidablist/core';
import { describe, expect, it } from 'vitest';
import { BUNDLED_TUNES, decodeBundledTune } from '../__fixtures__/index.js';
import type { DeckCommand, Grid } from '../messages/commands.js';
import type { DeckPicture } from '../messages/reports.js';
import { Rig, type RigOptions } from '../testing/harness.js';
import type { Deck } from './deck.js';

/**
 * Spec-only. Taps on Insid3-out, whose note starts fall every 12 frames (from 5) through the
 * register record's reach, at a frame every 10 ms: a tap on a note start fits a grid of 12. A
 * frame's position is its stream frame plus one, and a mark is the position of a delivered frame,
 * so a spec names the frame it means to mark by its position and asks the deck what it
 * delivered for the time that frame fell due.
 */

const TUNE = 'insid3-out';
/** How far the rig's scans reach, and so the note starts a deck's record gives. */
const RECORD_FRAMES = 400;
/** Positions on note starts, a beat (12 frames) apart. */
const ON_BEAT = [65, 77, 89, 101, 113];

/** The tune's note starts as a deck's record gives them. */
async function tuneNoteStarts(): Promise<NoteStarts> {
  const scanner: AnalysisScanner = {
    scan: (request) =>
      new Promise((resolve) =>
        handleScanRequest(
          { ...request, maxFrames: Math.min(request.maxFrames, RECORD_FRAMES) },
          (message) => {
            if (message.kind !== 'progress') resolve(message);
          },
        ),
      ),
    dispose: () => undefined,
  };
  const tune = BUNDLED_TUNES.find((item) => item.id === TUNE);
  if (tune === undefined) throw new Error(`no bundled tune ${TUNE}`);
  return noteStarts(
    await recordRegisters(scanner, decodeBundledTune(tune.base64), 1, RECORD_FRAMES),
  );
}

/** The grid taps marking `positions` fit, or null. */
async function fitOf(positions: readonly number[]): Promise<Grid | null> {
  return fitBeatGrid(positions, await tuneNoteStarts());
}

interface Fixture {
  readonly rig: Rig;
  readonly deck: Deck;
  /** Every `setCrossingCaptures` the engine took. */
  readonly captures: readonly (readonly CrossingLines[])[];
}

interface Options {
  readonly rig?: RigOptions;
  /** How long the deck plays before anything is pressed, in milliseconds. */
  readonly playMs?: number;
  readonly grid?: Grid;
}

/** A deck playing Insid3-out, its register record in (unless the rig holds scans), and its crossing lines watched. */
async function playing(options: Options = {}): Promise<Fixture> {
  const rig = new Rig(options.rig);
  const { deck } = rig.openDeck('a', 60);
  const captures: (readonly CrossingLines[])[] = [];
  const setCrossingCaptures = deck.player.setCrossingCaptures.bind(deck.player);
  deck.player.setCrossingCaptures = (lines) => {
    captures.push(lines);
    setCrossingCaptures(lines);
  };
  deck.receive({
    kind: 'load',
    deck: 'a',
    tune: TUNE,
    subtune: 1,
    ends: 'playing',
    ...(options.grid === undefined ? {} : { grid: options.grid }),
  });
  await rig.settle();
  rig.advance(options.playMs ?? 1500);
  return { rig, deck, captures };
}

function pictureOf(rig: Rig, deck: Deck): DeckPicture {
  deck.request({ kind: 'describe', deck: 'a' });
  const picture = rig.ofKind('picture', 'a').at(-1);
  if (picture === undefined) throw new Error('no picture');
  return picture;
}

/** Sends a command and lets a frame pass: a deck takes a second command in the same turn only after the next wake. */
async function send(rig: Rig, deck: Deck, command: DeckCommand): Promise<void> {
  deck.receive(command);
  await rig.microtasks();
  rig.advance(20);
}

const tapAt = (atMs: number): DeckCommand => ({ kind: 'tap', deck: 'a', atMs });

/** What each stream frame delivered, a re-rendered frame as its last render. */
function delivered(rig: Rig): Map<number, { dueAtMs: number; position: number }> {
  const frames = new Map<number, { dueAtMs: number; position: number }>();
  for (const update of rig.ofKind('update', 'a')) {
    frames.set(update.streamFrame, { dueAtMs: update.dueAtMs, position: update.position });
  }
  return frames;
}

/** The host time the frame that delivered `position` fell due at. */
function timeOf(rig: Rig, position: number): number {
  for (const frame of delivered(rig).values())
    if (frame.position === position) return frame.dueAtMs;
  throw new Error(`no frame delivered position ${position}`);
}

/** Taps that mark the frames delivering `positions`, each sent with a time well behind the playhead. */
async function tapPositions(rig: Rig, deck: Deck, positions: readonly number[]): Promise<void> {
  for (const position of positions) await send(rig, deck, tapAt(timeOf(rig, position)));
}

/** The first frame the deck's sink has not passed: where a command sent now lands. */
function firstHeld(rig: Rig, deck: Deck): number {
  const updates = rig.ofKind('update', 'a');
  const frontier = updates[updates.length - 1].streamFrame + 1;
  return frontier - (pictureOf(rig, deck).output?.heldFrames ?? 0);
}

describe('a deck that is tapped', () => {
  it('fits a grid from the fourth tap, reports it and plays on it', async () => {
    const { rig, deck, captures } = await playing();
    expect(pictureOf(rig, deck).tune?.recordReady).toBe(true);
    const expected = await fitOf(ON_BEAT.slice(0, 4));
    expect(expected).toMatchObject({ beatFrames: 12 });

    await tapPositions(rig, deck, ON_BEAT.slice(0, 3));
    expect(pictureOf(rig, deck).grid).toBeNull();
    expect(rig.ofKind('grid-fitted')).toEqual([]);
    expect(captures).toEqual([]);

    await tapPositions(rig, deck, ON_BEAT.slice(3, 4));
    rig.advance(200);
    const landed = rig.landed('tap');
    expect(landed).toHaveLength(4);
    expect(pictureOf(rig, deck).grid).toEqual(expected);
    expect(rig.ofKind('grid-fitted')).toEqual([
      { kind: 'grid-fitted', deck: 'a', frame: landed[3].frame, grid: expected, taps: 4 },
    ]);
    expect(captures).toHaveLength(1);
    expect(captures[0]).toEqual([
      { originFrame: expected?.beatOneFrame, periodFrames: 12, keep: expect.any(Number) },
    ]);
    expect(rig.warnings).toEqual([]);
  });

  it('marks the earlier frame a tap names, however far behind the frontier its time is', async () => {
    const { rig, deck } = await playing();
    const positions = [89, 101, 113, 125];
    // Marked at the frontier, four taps sent at once would all land on one position and fit nothing.
    await tapPositions(rig, deck, positions);
    rig.advance(100);
    expect(pictureOf(rig, deck).grid).toEqual(await fitOf(positions));
    expect(pictureOf(rig, deck).grid).not.toBeNull();
  });

  it('marks the oldest frame it kept for a time before them all', async () => {
    const { rig, deck } = await playing();
    await send(rig, deck, tapAt(0));
    await tapPositions(rig, deck, [89, 101, 113]);
    rig.advance(100);
    const oldest = Math.min(...[...delivered(rig).values()].map((frame) => frame.position));
    const expected = await fitOf([oldest, 89, 101, 113]);
    expect(expected).not.toEqual(await fitOf([89, 101, 113, 125]));
    expect(pictureOf(rig, deck).grid).toEqual(expected);
  });

  it('marks the frame before the one a tap lands on, and no held frame, when frames are held', async () => {
    const { rig, deck } = await playing({ playMs: 700 });
    // The mark falls 2 frames short of a note start, a frame short of where its beat rounds up:
    // a held frame marked instead would put the grid a whole beat later.
    for (let guard = 0; guard < 400; guard++) {
      const held = delivered(rig).get(firstHeld(rig, deck) - 1);
      if (held !== undefined && held.position % 12 === 10) break;
      rig.advance(5);
    }
    const landing = firstHeld(rig, deck);
    const before = delivered(rig).get(landing - 1);
    expect(before?.position).toBe(82);
    const atMs = rig.time.ms + 45;
    expect(delivered(rig).get(landing)?.dueAtMs).toBeLessThanOrEqual(atMs);

    await send(rig, deck, tapAt(atMs));
    const newestAtOrBefore = [...delivered(rig).entries()]
      .filter(([, frame]) => frame.dueAtMs <= atMs)
      .reduce((a, b) => (b[0] > a[0] ? b : a));
    expect(newestAtOrBefore[0]).toBeGreaterThanOrEqual(landing);
    rig.advance(400);
    await tapPositions(rig, deck, [89, 101, 113]);
    rig.advance(100);

    const landed = rig.landed('tap');
    expect(landed[0].frame).toBe(landing);
    const expected = await fitOf([82, 89, 101, 113]);
    expect(pictureOf(rig, deck).grid).toEqual(expected);
    expect(pictureOf(rig, deck).grid).not.toEqual(
      await fitOf([newestAtOrBefore[1].position, 89, 101, 113]),
    );
  });

  it('starts a new run after tap-end, so one tap is a run of one', async () => {
    const { rig, deck } = await playing();
    await tapPositions(rig, deck, ON_BEAT.slice(0, 3));
    await send(rig, deck, { kind: 'tap-end', deck: 'a' });
    await tapPositions(rig, deck, ON_BEAT.slice(3, 5));
    rig.advance(100);
    // Five taps in one run would have fitted; the run that tap-end closed does not count.
    expect(pictureOf(rig, deck).grid).toBeNull();
    expect(rig.ofKind('grid-fitted')).toEqual([]);

    await tapPositions(rig, deck, [125, 137]);
    rig.advance(100);
    expect(rig.ofKind('grid-fitted').map((event) => event.taps)).toEqual([4]);
    expect(pictureOf(rig, deck).grid).toEqual(await fitOf([101, 113, 125, 137]));
  });

  it('declares no new lines for a tap that fits the grid the deck already plays on', async () => {
    const { rig, deck, captures } = await playing();
    await tapPositions(rig, deck, ON_BEAT.slice(0, 4));
    const grid = pictureOf(rig, deck).grid;
    expect(grid).not.toBeNull();
    expect(captures).toHaveLength(1);

    await tapPositions(rig, deck, ON_BEAT.slice(4, 5));
    rig.advance(200);
    expect(await fitOf(ON_BEAT)).toEqual(grid);
    expect(captures).toHaveLength(1);
    expect(pictureOf(rig, deck).grid).toBe(grid);
    // Every fit is reported, the one that changed nothing included.
    expect(rig.ofKind('grid-fitted').map((event) => event.taps)).toEqual([4, 5]);
  });

  it('empties its run on a load, and plays on the grid the load carries', async () => {
    const { rig, deck } = await playing();
    await tapPositions(rig, deck, ON_BEAT.slice(0, 4));
    expect(pictureOf(rig, deck).grid).not.toBeNull();

    const carried: Grid = { beatFrames: 8, beatOneFrame: 2 };
    await send(rig, deck, {
      kind: 'load',
      deck: 'a',
      tune: TUNE,
      subtune: 1,
      ends: 'playing',
      grid: carried,
    });
    await rig.settle();
    rig.advance(1500);
    expect(pictureOf(rig, deck).grid).toEqual(carried);

    // Four marks with the run the load found would fit; the three of this run do not.
    const fitted = rig.ofKind('grid-fitted').length;
    await tapPositions(rig, deck, ON_BEAT.slice(0, 3));
    rig.advance(100);
    expect(rig.ofKind('grid-fitted')).toHaveLength(fitted);
    expect(pictureOf(rig, deck).grid).toEqual(carried);

    await send(rig, deck, { kind: 'load', deck: 'a', tune: TUNE, subtune: 1, ends: 'playing' });
    await rig.settle();
    expect(pictureOf(rig, deck).grid).toBeNull();
  });

  it('does nothing, and says so, for a tap before the register record has arrived', async () => {
    const { rig, deck } = await playing({ rig: { scan: 'held' } });
    expect(pictureOf(rig, deck).tune?.recordReady).toBe(false);

    await tapPositions(rig, deck, [65]);
    expect(rig.warnings.filter((warning) => warning.includes('register record'))).toHaveLength(1);
    expect(pictureOf(rig, deck).grid).toBeNull();

    rig.releaseScans();
    await rig.settle();
    rig.advance(1200);
    expect(pictureOf(rig, deck).tune?.recordReady).toBe(true);
    // The tap that did nothing is not in the run: three taps more are not four.
    await tapPositions(rig, deck, [77, 89, 101]);
    rig.advance(100);
    expect(rig.ofKind('grid-fitted')).toEqual([]);
    await tapPositions(rig, deck, [113]);
    rig.advance(100);
    expect(rig.ofKind('grid-fitted').map((event) => event.taps)).toEqual([4]);
  });

  it('does nothing, and says so, for a tap on a deck that is not playing', async () => {
    const { rig, deck } = await playing();
    await send(rig, deck, { kind: 'pause', deck: 'a' });
    rig.advance(200);
    expect(pictureOf(rig, deck).transport).toBe('paused');

    await send(rig, deck, tapAt(timeOf(rig, 65)));
    expect(rig.warnings.filter((warning) => warning.includes('not playing'))).toHaveLength(1);
    await tapPositions(rig, deck, [77, 89, 101]);
    expect(rig.ofKind('grid-fitted')).toEqual([]);
    expect(pictureOf(rig, deck).grid).toBeNull();
  });

  it('refuses a tap while no tune is ready, and always takes tap-end', () => {
    const rig = new Rig();
    const { deck } = rig.openDeck('a', 60);
    expect(deck.refusal(tapAt(0))).toContain('tap');
    expect(deck.refusal({ kind: 'tap-end', deck: 'a' })).toBeNull();
    rig.dispose();
  });
});
