#!/usr/bin/env bash
set -euo pipefail

# topiq installer (spec 026)
# Usage: curl -fsSL https://raw.githubusercontent.com/candril/topiq/main/scripts/install.sh | bash
#
#   TOPIQ_VERSION=0.2.0        install a specific release instead of the latest
#   TOPIQ_INSTALL_DIR=~/.local/bin   install somewhere other than /usr/local/bin

REPO="candril/topiq"
INSTALL_DIR="${TOPIQ_INSTALL_DIR:-/usr/local/bin}"
BINARY_NAME="topiq"

case "$(uname -s)" in
  Darwin) OS="darwin" ;;
  Linux)  OS="linux" ;;
  *)      echo "Error: unsupported operating system $(uname -s)" >&2; exit 1 ;;
esac

case "$(uname -m)" in
  x86_64|amd64)  ARCH="x64" ;;
  arm64|aarch64) ARCH="arm64" ;;
  *)             echo "Error: unsupported architecture $(uname -m)" >&2; exit 1 ;;
esac

ASSET="topiq-${OS}-${ARCH}.gz"

echo "topiq installer"
echo "  OS:      ${OS}"
echo "  Arch:    ${ARCH}"
echo "  Install: ${INSTALL_DIR}/${BINARY_NAME}"
echo

if [ -n "${TOPIQ_VERSION:-}" ]; then
  TAG="v${TOPIQ_VERSION#v}"
  echo "Installing ${TAG}..."
else
  TAG=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" \
    | sed -nE 's/.*"tag_name" *: *"([^"]+)".*/\1/p' | head -1)
  if [ -z "$TAG" ]; then
    echo "Error: could not determine the latest release of ${REPO}" >&2
    exit 1
  fi
  echo "Latest release: ${TAG}"
fi

TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

echo "Downloading ${ASSET}..."
curl -fsSL -o "${TMP_DIR}/${ASSET}" \
  "https://github.com/${REPO}/releases/download/${TAG}/${ASSET}"
curl -fsSL -o "${TMP_DIR}/SHA256SUMS" \
  "https://github.com/${REPO}/releases/download/${TAG}/SHA256SUMS"

# A skipped verification is how a truncated download becomes a mystery bug report, so a
# missing checksum tool is fatal rather than a warning.
echo "Verifying checksum..."
cd "$TMP_DIR"
if command -v sha256sum >/dev/null 2>&1; then
  grep " ${ASSET}\$" SHA256SUMS | sha256sum -c --quiet -
elif command -v shasum >/dev/null 2>&1; then
  grep " ${ASSET}\$" SHA256SUMS | shasum -a 256 -c --quiet -
else
  echo "Error: neither sha256sum nor shasum found; refusing to install unverified" >&2
  exit 1
fi

gunzip "$ASSET"
chmod +x "topiq-${OS}-${ARCH}"

# `mv`, never a copy onto the existing file: overwriting in place keeps the inode, and
# macOS then SIGKILLs the running binary because its cached code signature no longer
# matches the contents — exit 137, no output, indistinguishable from a hang.
echo "Installing..."
mkdir -p "$INSTALL_DIR" 2>/dev/null || true
if [ -w "$INSTALL_DIR" ]; then
  mv "topiq-${OS}-${ARCH}" "${INSTALL_DIR}/${BINARY_NAME}"
else
  echo "  ${INSTALL_DIR} is not writable — using sudo"
  sudo mv "topiq-${OS}-${ARCH}" "${INSTALL_DIR}/${BINARY_NAME}"
fi

echo
echo "topiq ${TAG} installed to ${INSTALL_DIR}/${BINARY_NAME}"
if ! command -v topiq >/dev/null 2>&1; then
  echo "Note: ${INSTALL_DIR} is not on your PATH."
fi
echo "Next: copy config.example.toml to ~/.config/topiq/config.toml, then run 'topiq --help'."
