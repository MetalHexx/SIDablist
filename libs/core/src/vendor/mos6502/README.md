# mos6502 (vendored)

A MOS6502 CPU emulator. Vendored as source, rather than depended on, so it can be fixed and
extended in place — a `.sid` tune's own 6502 code has to run correctly here, and that is this
repo's problem to solve, not upstream's.

## Origin

- Package: [`mos6502`](https://www.npmjs.com/package/mos6502) **v1.1.1**
- Repository: <https://github.com/kgtrey1/mos6502>
- Author: Kevin Gouyet
- Licence: MIT — see `LICENSE` in this directory, copied byte-for-byte from upstream.

Fetched from the published npm tarball (`mos6502@1.1.1`). That tarball ships both the compiled
`dist/` bundle and the original `src/` TypeScript source; this vendor tree is taken from `src/`,
not the compiled bundle.

### Upstream tarball contents (v1.1.1)

```
LICENSE
README.md
dist/cjs/addressing.js
dist/cjs/decoder.js
dist/cjs/formatter.js
dist/cjs/index.js
dist/cjs/instructions.js
dist/cjs/mos6502.js
dist/cjs/types/debug.js
dist/cjs/types/flags.js
dist/cjs/types/register.js
dist/typescript/addressing.d.ts
dist/typescript/decoder.d.ts
dist/typescript/formatter.d.ts
dist/typescript/index.d.ts
dist/typescript/instructions.d.ts
dist/typescript/mos6502.d.ts
dist/typescript/types/debug.d.ts
dist/typescript/types/flags.d.ts
dist/typescript/types/register.d.ts
jest.config.ts
package.json
src/addressing.ts
src/decoder.ts
src/formatter.ts
src/index.ts
src/instructions.ts
src/mos6502.ts
src/types/debug.ts
src/types/flags.ts
src/types/register.ts
tsconfig.json
```

Upstream `package.json` points `main` at `dist/cjs/index.js` and `types` at
`dist/typescript/index.d.ts` — those are the compiled outputs. The entry point for this vendor
tree, and for upstream's own source, is `src/index.ts`, mirrored here as `index.ts`.

## Entry point and exported symbols

`index.ts` is the entry point. It exports, all as named exports (see "What changed" below):

| Export                                           | Kind     | Notes                                                                                                                                                                                                                                  |
| ------------------------------------------------ | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mos6502`                                        | class    | The CPU. `new mos6502(read, write, debug?)` where `read: (address: number) => number` and `write: (address: number, value: number) => void`. Public: `emulate()`, `getFlag()`, `setFlag()`, `nmi()`, `reset()`, `irq()`, `getState()`. |
| `decode`                                         | function | `(opcode: number) => Instruction` — opcode-to-instruction decode.                                                                                                                                                                      |
| `hex`                                            | function | Formats a number as zero-padded uppercase hex.                                                                                                                                                                                         |
| `formatDisassembly`                              | function | Formats a `DebugInfo` entry as a disassembly line.                                                                                                                                                                                     |
| `formatRegisters`                                | function | Formats a `RegistersInfo` as a compact status string.                                                                                                                                                                                  |
| `AddressingModes`, `AddressingModesMap`          | types    | From `addressing.ts`.                                                                                                                                                                                                                  |
| `Instruction`, `Instructions`, `InstructionsMap` | types    | From `instructions.ts`.                                                                                                                                                                                                                |

Present in the tree but **not** re-exported from `index.ts` (matching upstream, which doesn't
re-export them either) — import these directly from their own files if needed:

- `Flags` (`types/flags.ts`) — status-register bit positions. A real `enum`, not a type-only alias.
- `DebugInfo` (`types/debug.ts`), `RegistersInfo` (`types/register.ts`) — debug/state shapes used
  by `formatDisassembly` / `formatRegisters` and by `mos6502.getState()`.

## What changed from upstream

Conversion only in this task — no behavioural edits:

- Every `export default` became a named export: `mos6502`, `decode`, `Flags`, `DebugInfo`,
  `RegistersInfo`.
- Every relative import carries an explicit `.js` extension, and type-only imports are marked
  (`import type` / inline `type`), to satisfy this repo's `tsconfig.base.json`
  (`moduleResolution: NodeNext`, `verbatimModuleSyntax: true`).
- Each `.ts` file carries a header naming this origin and stating that the file has been modified
  from upstream, so bugs introduced here aren't mistakenly attributed back to `kgtrey1/mos6502`.

Everything else — logic, comments, formatting — is left as upstream wrote it.

## Expected future work

This emulator does not yet support RSID (interrupt-driven) tunes, and other fixes or extensions
will surface once it's exercised against real `.sid` files. That work belongs here, in this vendor
tree, not upstream — once `core` depends on behaviour that diverges from `kgtrey1/mos6502`, this is
where it's changed.
