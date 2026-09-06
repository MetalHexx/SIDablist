declare const unit: unique symbol;

/** Zero-cost branded type: provides compile-time type identity to a runtime number. */
type Branded<T extends string> = number & { readonly [unit]: T };

/** Frames: a quantity of playback frames. */
export type Frames = Branded<'Frames'>;

/** Milliseconds: a duration in milliseconds. */
export type Milliseconds = Branded<'Milliseconds'>;

/** Microseconds: a duration in microseconds. */
export type Microseconds = Branded<'Microseconds'>;

/** Cycles: a count of CPU cycles. */
export type Cycles = Branded<'Cycles'>;

/** Construct a Frames value. */
export const frames = (n: number): Frames => n as Frames;

/** Construct a Milliseconds value. */
export const milliseconds = (n: number): Milliseconds => n as Milliseconds;

/** Construct a Microseconds value. */
export const microseconds = (n: number): Microseconds => n as Microseconds;

/** Construct a Cycles value. */
export const cycles = (n: number): Cycles => n as Cycles;
