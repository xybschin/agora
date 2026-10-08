# Nix flake providing the Agora development shell: Bun and Node for the
# workspaces, Docker for the Matrix infra and per-Run containers, and beads
# (the `bd` issue tracker). The shell hook creates the directories the runner
# writes into (logs/, runner-generated/) and prints the common commands once.
{
  description = "agora - LLM agent population simulator";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    beads.url = "github:gastownhall/beads";
  };

  outputs = { self, nixpkgs, flake-utils, beads }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
        beadsPkg = beads.packages.${system}.default;
      in
      {
        devShells.default = pkgs.mkShell {
          buildInputs = with pkgs; [
            # Core runtime and package management
            bun
            nodejs_22

            # Build and compilation
            typescript

            # Infrastructure and containerization
            docker
            docker-compose

            # Language servers and development tools
            typescript-language-server
            prettier

            # Utilities
            git
            curl
            jq
            yq
            beadsPkg

            # Optional: useful CLI tools
            direnv
          ];

          shellHook = ''
            # Set up shell environment
            export NODE_ENV=development
            export PROJECT_ROOT="$(pwd)"

            # Create necessary directories
            mkdir -p "$PROJECT_ROOT/.bun"
            mkdir -p "$PROJECT_ROOT/logs"
            mkdir -p "$PROJECT_ROOT/runner-generated"

            # Function to show available commands
            show_help() {
              echo "📦 Agora Development Environment"
              echo ""
              echo "Available commands:"
              echo "  bun install              - Install dependencies"
              echo "  bun run typecheck        - Type-check all packages"
              echo "  bun run run:scenario     - Run a scenario (e.g., scenarios/remote-work-policy.yaml)"
              echo "  bun run bootstrap:matrix - Bootstrap Matrix with a scenario"
              echo ""
              echo "Docker:"
              echo "  docker compose -f docker-compose.infra.yml up -d   - Start Matrix infra"
              echo "  docker compose -f docker-compose.infra.yml down    - Stop Matrix infra"
              echo ""
              echo "For more info, see README.md"
            }

            # Only show help on first shell entry (check if BUN_SHELL_INIT is set)
            if [ -z "$BUN_SHELL_INIT" ]; then
              show_help
              export BUN_SHELL_INIT=1
            fi
          '';
        };

        # Legacy `devShell` output, for Nix versions that predate devShells.
        devShell = self.devShells.${system}.default;
      }
    );
}
