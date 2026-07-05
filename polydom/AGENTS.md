# Project Agent Instructions

This file provides guidance to AI agents (DeepSeek TUI, Claude Code, etc.) when working with code in this repository.

## File Location

Save this file as `AGENTS.md` in your project root so the CLI can load it automatically.

## Build and Development Commands

```bash
# Build
# cargo build              # Rust projects
# npm run build            # Node.js projects
# python -m build          # Python projects

# Test
# cargo test               # Rust
# npm test                 # Node.js
# pytest                   # Python

# Lint and Format
# cargo fmt && cargo clippy  # Rust
# npm run lint               # Node.js
# ruff check .               # Python
```

## Architecture Overview

<!-- Describe your project's high-level architecture here -->
<!-- Focus on the "big picture" that requires reading multiple files to understand -->

### Key Components

<!-- List and describe the main components/modules -->

### Data Flow

<!-- Describe how data flows through the system -->

## Configuration Files

<!-- List important configuration files and their purposes -->

## Extension Points

<!-- Describe how to extend the codebase (add new features, tools, etc.) -->

## Commit Messages

Use conventional commits: `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`
