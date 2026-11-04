### Added

- **`file.open` RPC, `file_open` MCP tool and `wmux open <path>`.** An agent or script can now show a file in a read-only editor or preview tab of a pane, optionally at a line (`wmux open src/a.ts:42`, `--line N`, `--workspace <id>`). `file_open` is available in the full MCP profile only.

### Changed

- **`wmux open` routes file targets to the viewer.** A target with a scheme is a URL and still opens a browser pane; a path shape or an existing file opens in the file viewer.
