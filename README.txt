syrox-opencode

OpenCode V2 plugin for Syrox (.srx), using the external `srx lsp` server.
Source: https://github.com/ryro-hq/syrox-opencode
Language server: https://github.com/ryro-hq/syrox

Install with OpenCode V2:

  opencode plugin add github:ryro-hq/syrox-opencode

For development, clone this repository alongside Syrox and load it in the
Syrox project's opencode.jsonc:

  { "$schema": "https://opencode.ai/config.json",
    "plugins": ["../syrox-opencode"] }

Build/install `srx` separately and put it on PATH, or set SYROX_LSP_BIN to
its absolute executable path before starting OpenCode. When the active
OpenCode workspace contains target/release/srx, the plugin uses that binary
automatically. The binary must support `srx lsp` (Linux). No npm dependencies
or binary download are required by this plugin.

The plugin exposes read-only semantic tools: syrox_diagnostics, syrox_reload,
syrox_symbols, syrox_hints, syrox_quickfixes, syrox_hover, syrox_definition,
syrox_type_definition, syrox_references, syrox_completion, syrox_signature
and syrox_source. Definitions in the bundled std use revision-scoped virtual
sources, retrievable with syrox_source. Hints include ownership information;
quick fixes are previews only and never apply edits.

Files must be saved .srx sources inside the current OpenCode workspace. Cursor
inputs use one-based lines and UTF-16 columns; returned LSP locations are
zero-based. The plugin locates the nearest main.srx as the project root. Its
workspace's std/ folder uses std authoring mode; set SYROX_STD_DIR to another
std tree within the workspace when needed. Unsupported/initially invalid
projects may provide only local syntax diagnostics until the loader can open
the graph.

Successful OpenCode edit/write/patch calls on .srx files append bounded
diagnostics to the tool result. Syrox.lock changes and deleted sources notify
active project servers. For edits via shell or other editors that affect
imports or topology, call syrox_reload with a .srx path in the project.
Queries otherwise refresh the selected file's saved content on demand.

Checks from this repository:

  npm run check
  SRX_BIN=/path/to/srx npm run check

The first command runs portable unit tests and skips tests needing srx. With
SRX_BIN, the protocol suite checks real diagnostics, edits, navigation, hints
and quick fixes. OpenCode and Syrox have independent release cycles; language
semantics and LSP protocol behavior remain in the Syrox server.
