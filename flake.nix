# topiq packaged from its GitHub release binary — the same .gz and SHA256SUMS the curl
# installer and the Homebrew formula verify against. release.json is written by the release
# workflow the moment a release is published, so `nix run github:candril/topiq` is the
# newest release without any hand edit. (Building from source under Nix would need a
# fixed-output hash for the bun dependency tree, which differs per platform and changes with
# every bun.lock edit.)
#
# Generated from candril/homebrew-tap/templates/flake.nix; edit it there.
{
  description = "topiq — packaged from its GitHub releases";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";

  outputs = { self, nixpkgs }:
    let
      lib = nixpkgs.lib;
      systems = [ "aarch64-darwin" "x86_64-darwin" "aarch64-linux" "x86_64-linux" ];
      target = {
        aarch64-darwin = "darwin-arm64";
        x86_64-darwin = "darwin-x64";
        aarch64-linux = "linux-arm64";
        x86_64-linux = "linux-x64";
      };
      rel = builtins.fromJSON (builtins.readFile ./release.json);
      forAll = f: lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system} system);
    in
    {
      packages = forAll (pkgs: system:
        let
          t = target.${system};
          runtime = map (p: pkgs.${p}) [  ];
          isLinux = pkgs.stdenv.hostPlatform.isLinux;
        in
        rec {
          default = topiq;
          topiq = pkgs.stdenvNoCC.mkDerivation {
            pname = "topiq";
            version = rel.version;

            src = pkgs.fetchurl {
              url = "https://github.com/candril/topiq/releases/download/v${rel.version}/topiq-${t}.gz";
              sha256 = rel.sha256.${t};
            };
            dontUnpack = true;

            nativeBuildInputs = [ pkgs.makeWrapper ] ++ lib.optionals isLinux [ pkgs.autoPatchelfHook ];
            # Bun-compiled binaries link glibc and libstdc++ dynamically.
            buildInputs = lib.optionals isLinux [ pkgs.stdenv.cc.cc.lib ];

            installPhase = ''
              runHook preInstall
              mkdir -p $out/bin
              gunzip -c $src > $out/bin/topiq
              chmod +x $out/bin/topiq
              ${lib.optionalString (runtime != [ ]) ''
                wrapProgram $out/bin/topiq --prefix PATH : ${lib.makeBinPath runtime}
              ''}
              runHook postInstall
            '';

            meta = {
              description = "Peek, filter, replay. Kafka without leaving the terminal";
              homepage = "https://candril.github.io/topiq/";
              license = lib.licenses.mit;
              mainProgram = "topiq";
              platforms = systems;
            };
          };
        });

      devShells = forAll (pkgs: _: {
        default = pkgs.mkShell {
          packages = with pkgs; [ bun just gh git typescript ];
        };
      });
    };
}
