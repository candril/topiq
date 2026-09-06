# The binary comes from candril/homebrew-tap, which packages every release of the five
# tools from the same SHA256SUMS the installer and the Homebrew formula verify against.
# There is deliberately no flake.lock here: `nix run github:candril/topiq` should
# resolve the tap fresh and land on the latest release, not the one pinned at commit time.
#
# Generated from candril/homebrew-tap/templates/flake.nix; edit it there.
{
  description = "topiq — packaged from its GitHub releases via candril/homebrew-tap";

  inputs = {
    tap.url = "github:candril/homebrew-tap";
    nixpkgs.follows = "tap/nixpkgs";
  };

  outputs = { self, tap, nixpkgs }:
    let
      systems = builtins.attrNames tap.packages;
      forAll = f: nixpkgs.lib.genAttrs systems f;
    in {
      packages = forAll (system: {
        default = tap.packages.${system}.topiq;
      });

      devShells = forAll (system:
        let pkgs = nixpkgs.legacyPackages.${system};
        in {
          default = pkgs.mkShell {
            packages = with pkgs; [ bun just gh git typescript ];
          };
        });
    };
}
