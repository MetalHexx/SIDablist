# SIDablist

Framework-free TypeScript libraries for driving real SID hardware from a host: a timeline engine
that runs a `.sid` tune's own 6502 code and streams the register writes it makes, plus the sinks
that put those writes on a wire.

The premise, because it explains every boundary below: a SID tune is not audio, it is a small 6502
program that writes to twenty-five registers fifty times a second. We run that program and watch
the writes. Nothing here synthesizes sound.

## Modules

Filled in as libraries land — a module missing from this table is a module no agent will route to.

| Module | Owns | Detail |
|---|---|---|
| _none yet_ | | |

## Invariants

These hold across every module, and no single module can own them.

### `libs/core` has zero runtime dependencies

Not an aspiration — a checked property. CI builds *and tests* `core` with nothing else installed.
If a change to core seems to need a package, either the change is wrong or the boundary moved, and
moving the boundary is a decision rather than an import.

### `libs/core` touches no browser global

No `window`, `document`, `navigator`, `localStorage`. Everything environmental arrives through an
injected port. Lint enforces it; the no-dependency CI build catches what lint misses. A library
that quietly assumes a browser cannot run under Node, under Electron, or in a test without one.

### Dependencies point inward, and the package manager enforces it

Sinks and analysis depend on `core`. `core` depends on none of them and does not know they exist.
That is why they are separate packages rather than folders in one — a reverse import is a circular
dependency the package manager rejects, not a convention someone has to remember.

### The hot path does not allocate

Frame delivery runs fifty times a second, per deck. Code on that path reuses typed arrays
deliberately and says so in comments. Do not wrap it in value objects, getters, or immutable
structures for readability. Speed is the acceptance bar there, and a regression is audible rather
than visible — no test will catch it for you.

### Ear-validated constants are not tuning knobs

Several timing constants were settled by listening on real hardware and cannot be re-derived from
tests. They carry comments saying so. Changing one is a hardware experiment, not a refactor.

### Relative imports carry explicit `.js` extensions

The build is plain `tsc` with no bundler, so output files stay files. That is what lets the web
workers resolve `new URL('./x.worker.js', import.meta.url)`, and what makes the output valid ESM
under Node rather than only under someone's bundler.

### Vendored code keeps its licence and says it was modified

`libs/core/src/vendor/` holds third-party source copied in rather than depended on. Each vendored
tree keeps its upstream `LICENSE` verbatim, names its author, its repo and the version forked from,
and states that it has been modified — so nobody attributes our bugs upstream.

## Commands

Land with the first library.

```
pnpm install
pnpm build
pnpm test
pnpm lint
```

## Commits

- Conventional Commits (`feat`, `fix`, `refactor`, `docs`, `chore`), optional scopes.
- **Never** write `Co-Authored-By` or any other agent-harness attribution trailer.

## Instruction files

| File | Role |
|---|---|
| `AGENTS.md` | This file, plus one per library. Authoritative. |
| `CLAUDE.md` | Thin — surfaces the essentials and points here. |
| `docs/` | Long-form explanation: architecture, writing a sink, the PAL/NTSC correction. |

Creating or restructuring any `AGENTS.md`, standing up a new library, or sweeping the set for
drift follows [`.claude/skills/agents-md/SKILL.md`](./.claude/skills/agents-md/SKILL.md). Do not
improvise the format.

## Further reading

- [`docs/architecture.md`](./docs/architecture.md) — the *why* behind every invariant above: the
  premise, why the dependency arrows point one way, the two seams, how a consumer reads core, and
  the PAL/NTSC correction. Read it before restructuring a library, adding one, or drawing a new
  boundary — not for a routine edit.
- Upstream context lives in the `DJ-LIBRARY` and `ASID-DJ` planning documents outside this repo.
