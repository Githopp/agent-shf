{
  description = "agent-sh — a composable agent runtime";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
    in
    {
      packages = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        rec {
          agent-sh = pkgs.callPackage ./nix/agent-sh.nix { src = self; };
          default = agent-sh;
        }
      );

      apps = forAllSystems (system: {
        default = {
          type = "app";
          program = "${self.packages.${system}.agent-sh}/bin/agent-sh";
        };
      });

      overlays.default = final: _prev: {
        agent-sh = self.packages.${final.system}.agent-sh;
      };

      devShells = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        {
          default = pkgs.mkShell {
            packages = [
              pkgs.nodejs_22
              pkgs.ripgrep
            ];
            shellHook = ''
              echo "agent-sh dev shell — node $(node --version), rg $(rg --version | head -1)"
            '';
          };
        }
      );
    };
}
