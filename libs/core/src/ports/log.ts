/** Where the engine and its sinks report input they reject and failures. With none supplied, they are silent. */
export interface EngineLog {
  warn(message: string): void;
  error(message: string): void;
}
