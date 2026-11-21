/**
 * A part that can put everything deciding what it does next into storage sized ahead of time, and
 * take it back, so a player can save and restore its parts as one value without reaching into them.
 *
 * `S` is the part's own state type. A state may hold a reference to an object that never changes
 * once made (a prepared settings record, a loop, a `QueuedNext`); anything mutable is copied in, or
 * the part's own doc says why it is not and what its owner must guarantee instead.
 */
export interface Saveable<S> {
  /** Allocates a state sized for this instance, once and off the tick. */
  createState(): S;
  /** Copies every field that decides what this part does next into `target`. Allocates nothing. */
  saveInto(target: S): void;
  /**
   * Makes this part exactly as it was when `source` was saved. Allocates nothing, notifies nothing,
   * calls no hook and runs none of the clearing a setter does: it puts the fields back, which is
   * not what a command to the part would do.
   */
  restoreFrom(source: S): void;
}
