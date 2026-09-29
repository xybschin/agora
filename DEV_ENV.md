# Development Environment Setup

This project uses **direnv** to provide an isolated, reproducible development environment with all necessary tools and LSP.

## Quick Start

### 1. Install direnv (if not already installed)

```bash
# On NixOS / with nix-direnv
# Already available in your system environment

# On other systems, follow: https://direnv.net/docs/installation.html
```

### 2. Allow the direnv configuration

```bash
cd /path/to/agora
direnv allow
```

You should see:
```
✓ agora development environment loaded
  - Bun package manager
  - Node.js runtime
  - Docker & Docker Compose
  - TypeScript LSP
```

### 3. Install project dependencies

```bash
bun install
```

## What's Included

The development environment provides:

### Package Management & Runtime
- **Bun** - Fast JavaScript runtime and package manager
- **Node.js 22** - JavaScript runtime (for tools that require it)

### Build & Development Tools
- **TypeScript 5.7** - Type checking
- **TypeScript Language Server** - Editor support
- **Prettier** - Code formatting

### Infrastructure
- **Docker** - Container runtime
- **Docker Compose** - Multi-container orchestration

### Utilities
- **Git** - Version control
- **curl** - HTTP client
- **jq** - JSON processor
- **yq** - YAML processor
- **beads** - Local issue tracking

## Available Commands

### Project Management
```bash
bun install              # Install all dependencies
bun run typecheck        # Type-check all packages
```

### Running Services
```bash
bun run run:scenario scenarios/remote-work-policy.yaml   # Run a scenario
bun run bootstrap:matrix scenarios/remote-work-policy.yaml  # Bootstrap Matrix
```

### Docker Infrastructure
```bash
# Start Matrix infrastructure (persistent: Synapse + PostgreSQL + Element Web + Nginx)
docker compose -f docker-compose.infra.yml up -d

# Stop infrastructure
docker compose -f docker-compose.infra.yml down

# View logs
docker compose -f docker-compose.infra.yml logs -f
```

## IDE/Editor Setup

### VS Code

With direnv and flake.nix in place, VS Code will automatically pick up:
- TypeScript language server
- Proper Node.js path for debugging

Add to `.vscode/settings.json`:
```json
{
  "[typescript]": {
    "editor.defaultFormatter": "esbenp.prettier-vscode",
    "editor.formatOnSave": true
  }
}
```

### Vim / Neovim

The TypeScript LSP is available at:
```
$(which typescript-language-server)
```

Configure your LSP client to use it.

## Environment Variables

Create a `.env.local` file for local overrides (git-ignored):

```bash
cp .env.example .env.local
# Edit .env.local with your settings
```

Common variables:
- `NODE_ENV` - Set to "development" (default)
- `DEBUG` - Enable debug logging
- `LLM_API_KEY` - Your LLM provider API key
- `MATRIX_HOME_SERVER_URL` - The Matrix homeserver base URL

## Troubleshooting

### direnv not automatically loading

If direnv doesn't auto-load when you `cd` into the directory:

```bash
# Force reload
direnv reload

# Or check status
direnv status
```

### Nix flake evaluation issues

If you see "Path is not tracked by Git" error:

```bash
# This is expected until the file is committed
# You can still use the environment with:
direnv reload

# Or to permanently fix, commit the files:
git add flake.nix .envrc
```

### Docker permission denied

If you get "permission denied while trying to connect to Docker daemon":

```bash
# Add your user to the docker group (requires logout/login)
sudo usermod -aG docker $USER
newgrp docker
```

### Bun not found

```bash
# Verify it's installed
which bun

# If not, ensure direnv is properly loaded
eval "$(direnv export bash)"
```

## Development Workflow

1. **Clone the repo** and navigate to the directory
2. **Run `direnv allow`** to enable the environment
3. **Run `bun install`** to install dependencies
4. **Run `bun run typecheck`** to verify setup
5. **Start coding!** Your IDE should have full TypeScript support

## See Also

- [README.md](README.md) - Project overview and running scenarios
- [flake.nix](flake.nix) - NixOS flake definition (all dependencies)
- [.envrc](.envrc) - direnv shell hook configuration
