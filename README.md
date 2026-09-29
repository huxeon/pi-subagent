# pi-subagent

The official Pi [`subagent` example](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/examples/extensions/subagent),
packaged so that `pi install` also puts its agents and workflow prompts in place.

The example is copied **verbatim** under `extensions/subagent/`. A single
`postinstall` script copies its `agents/` and `prompts/` into `~/.pi/agent`,
replacing the manual `ln -s` steps from the example README.

## Install

```bash
# From npm (after `npm publish`)
pi install npm:pi-subagent

# From git
pi install git:github.com/<you>/pi-subagent

# From a local checkout
pi install ./pi-subagent
npm run seed   # local installs don't run postinstall; run this once
```

The `postinstall` script seeds these files into your Pi config directory:

```text
~/.pi/agent/agents/
├── scout.md      # fast codebase recon, returns compressed context
├── planner.md    # creates implementation plans
├── reviewer.md   # code review
└── worker.md     # general-purpose, full capabilities

~/.pi/agent/prompts/
├── implement.md               # scout -> planner -> worker
├── scout-and-plan.md          # scout -> planner (no implementation)
└── implement-and-review.md    # worker -> reviewer -> worker
```

Existing files are never overwritten, so your edits are kept. Re-run with
`npm run seed` (or `PI_CODING_AGENT_DIR=/tmp/pi-agent node scripts/install.mjs`
for an isolated config dir).

## Package layout

```text
pi-subagent/
├── package.json
├── extensions/
│   └── subagent/                # verbatim copy of the official example
│       ├── index.ts
│       ├── agents.ts
│       ├── agents/*.md
│       ├── prompts/*.md
│       └── README.md
└── scripts/
    └── install.mjs              # postinstall: seeds ~/.pi/agent
```

`pi.extensions` registers only the example. It is unmodified: the `subagent`
tool discovers agents from `~/.pi/agent/agents` and Pi loads the prompts from
`~/.pi/agent/prompts` — both populated by the seeding script.

## Usage

Same as the upstream example:

```text
Use scout to find all authentication code
Run 2 scouts in parallel: one to find models, one to find providers
Use a chain: first have scout find the read tool, then have planner suggest improvements
```

```text
/implement add Redis caching to the session store
/scout-and-plan refactor auth to support OAuth
/implement-and-review add input validation to API endpoints
```

See [`extensions/subagent/README.md`](extensions/subagent/README.md) for the
full reference (tool modes, output display, security model, limitations).

## Agents and models

The bundled agents keep the upstream `model` values (Claude Sonnet/Haiku). If
those models are not configured, edit your copies in `~/.pi/agent/agents/*.md`
or remove the `model:` line so subagents inherit the dispatching session's
model. Seeding will not overwrite your edits.

## Development

```bash
# Try the example without installing (no seeding)
pi -e ./extensions/subagent/index.ts

# Seed the user config directory manually
npm run seed
```

## License

MIT. The `extensions/subagent/` directory is from the Pi coding agent, © Mario
Zechner. See [LICENSE](LICENSE).
