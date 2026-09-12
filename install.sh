#!/bin/sh
# openmcp installer.
#
#   curl -fsSL https://openmcp.logicsrc.com/install.sh | sh
#
# Installs the `openmcp` command (the OpenMCP catalog client and reference
# server, @logicsrc/openmcp) under your home directory. No root, no system
# package manager, no system files touched. If this machine has no Node 24,
# an official Node build is fetched into the same private directory and used
# from there; nothing else on the box changes.
#
# Updating is `openmcp update` and removing is `openmcp uninstall`, which runs
# a script this installer leaves behind, so removal is exact and needs no
# network.
#
#   sh -s -- --version X    install a specific release
#   sh -s -- --prefix DIR   install root (default: ~/.local)
#
#   OPENMCP_VERSION, OPENMCP_PREFIX   the same, from the environment
#   OPENMCP_NODE=system|private       force which Node is used
set -eu

PKG="@logicsrc/openmcp"
SITE="${OPENMCP_SITE:-https://openmcp.logicsrc.com}"
PREFIX="${OPENMCP_PREFIX:-$HOME/.local}"
VERSION="${OPENMCP_VERSION:-}"
NODE_CHOICE="${OPENMCP_NODE:-auto}"
NODE_LINE="v24.x"

while [ $# -gt 0 ]; do
  case "$1" in
    --version) VERSION="${2:?--version needs a value}"; shift ;;
    --prefix)  PREFIX="${2:?--prefix needs a value}"; shift ;;
    -h|--help) sed -n '2,20p' "$0" 2>/dev/null || echo "See $SITE"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 64 ;;
  esac
  shift
done

say()  { printf '%s\n' "$*"; }
fail() { printf 'openmcp: %s\n' "$*" >&2; exit 1; }

# --- what this machine has ----------------------------------------------------

OS="$(uname -s)"
case "$OS" in
  Linux)  OS=linux ;;
  Darwin) OS=darwin ;;
  *) fail "unsupported operating system: $OS. Linux and macOS are supported." ;;
esac

ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|amd64)  ARCH=x64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  armv7l)        ARCH=armv7l ;;
  *) fail "unsupported architecture: $ARCH." ;;
esac

if command -v curl >/dev/null 2>&1; then
  fetch() { curl -fsSL "$1" -o "$2"; }
elif command -v wget >/dev/null 2>&1; then
  fetch() { wget -q "$1" -O "$2"; }
else
  fail "curl or wget is required to download."
fi

SHARE="$PREFIX/share/openmcp"
BIN="$PREFIX/bin"
mkdir -p "$SHARE" "$BIN"

# --- a Node 24 ----------------------------------------------------------------
#
# The catalog uses node:sqlite, which is Node 24. A system Node that is new
# enough is used as `node` from PATH, so the shim follows upgrades. Otherwise
# an official build is unpacked under $SHARE/node and the shim names it by
# absolute path; it is removed with everything else by `openmcp uninstall`.

node_major() {
  "$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0
}

NODE=""
NODE_KIND=""

if [ "$NODE_CHOICE" != "private" ] && command -v node >/dev/null 2>&1; then
  if [ "$(node_major node)" -ge 24 ]; then
    NODE=node
    NODE_KIND=system
  elif [ "$NODE_CHOICE" = "system" ]; then
    fail "Node 24 or newer is required and this is $(node -v). Unset OPENMCP_NODE to let the installer fetch one."
  fi
fi

if [ -z "$NODE" ] && [ -x "$SHARE/node/bin/node" ] && [ "$(node_major "$SHARE/node/bin/node")" -ge 24 ]; then
  NODE="$SHARE/node/bin/node"
  NODE_KIND=private
fi

if [ -z "$NODE" ]; then
  say "No Node 24 on this machine; fetching an official build into $SHARE/node ..."
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  fetch "https://nodejs.org/dist/latest-$NODE_LINE/SHASUMS256.txt" "$TMP/SHASUMS256.txt" ||
    fail "could not read https://nodejs.org/dist/latest-$NODE_LINE/"
  TARBALL="$(grep -o "node-v24\.[0-9.]*-$OS-$ARCH\.tar\.gz" "$TMP/SHASUMS256.txt" | head -n 1 || true)"
  [ -n "$TARBALL" ] || fail "nodejs.org has no Node 24 build for $OS-$ARCH."
  fetch "https://nodejs.org/dist/latest-$NODE_LINE/$TARBALL" "$TMP/$TARBALL" || fail "could not download $TARBALL"
  if command -v sha256sum >/dev/null 2>&1; then
    SUM="$(sha256sum "$TMP/$TARBALL" | cut -d ' ' -f 1)"
  elif command -v shasum >/dev/null 2>&1; then
    SUM="$(shasum -a 256 "$TMP/$TARBALL" | cut -d ' ' -f 1)"
  else
    SUM=""
  fi
  if [ -n "$SUM" ]; then
    grep -q "^$SUM  $TARBALL\$" "$TMP/SHASUMS256.txt" || fail "checksum mismatch for $TARBALL"
  fi
  rm -rf "$SHARE/node"
  mkdir -p "$SHARE/node"
  tar -xzf "$TMP/$TARBALL" -C "$SHARE/node" --strip-components=1 || fail "could not unpack $TARBALL"
  NODE="$SHARE/node/bin/node"
  NODE_KIND=private
  [ "$(node_major "$NODE")" -ge 24 ] || fail "the downloaded Node does not run here."
fi

# npm beside the Node in use, so a private Node installs with its own npm.
if [ "$NODE_KIND" = private ]; then
  NPM="$SHARE/node/bin/npm"
else
  command -v npm >/dev/null 2>&1 || fail "npm is required (it ships with Node)."
  NPM=npm
fi

# --- install ------------------------------------------------------------------

SPEC="$PKG"
[ -n "$VERSION" ] && SPEC="$PKG@$VERSION"

say "Installing $SPEC into $SHARE ..."

# A private tree rather than a global install: it cannot fight a system npm
# prefix, needs no root, and goes away by deleting one directory. Only the
# package tree is replaced; a private Node beside it stays.
rm -rf "$SHARE/node_modules" "$SHARE/package.json" "$SHARE/package-lock.json"
cd "$SHARE"
printf '{\n  "name": "openmcp-install",\n  "private": true\n}\n' > package.json
"$NPM" install --silent --no-audit --no-fund --omit=dev "$SPEC" >/dev/null 2>&1 ||
  "$NPM" install --no-audit --no-fund --omit=dev "$SPEC" ||
  fail "npm could not install $SPEC"

PKG_DIR="$SHARE/node_modules/$PKG"
[ -d "$PKG_DIR" ] || fail "$SPEC installed but $PKG_DIR is missing."
ENTRY="$PKG_DIR/bin/openmcp.mjs"
[ -f "$ENTRY" ] || fail "$SPEC does not contain bin/openmcp.mjs"

INSTALLED="$("$NODE" -p "require('$PKG_DIR/package.json').version" 2>/dev/null || echo unknown)"

# --- shim ---------------------------------------------------------------------
#
# A script rather than a symlink, so the command always runs against the copy
# this installer put down, with the Node it chose, even if npm's own bin links
# change underneath.

cat > "$BIN/openmcp" <<SHIM
#!/bin/sh
# openmcp. Written by the installer; \`openmcp uninstall\` removes it.
OPENMCP_HOME="$SHARE" exec "$NODE" "$ENTRY" "\$@"
SHIM
chmod 0755 "$BIN/openmcp"

# --- what was installed, and how to remove it ---------------------------------

PATHS="$BIN/openmcp
$SHARE"

INSTALLED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
{
  printf '{\n'
  printf '  "package": "%s",\n' "$PKG"
  printf '  "version": "%s",\n' "$INSTALLED"
  printf '  "installer": "%s/install.sh",\n' "$SITE"
  printf '  "installedAt": "%s",\n' "$INSTALLED_AT"
  printf '  "prefix": "%s",\n' "$PREFIX"
  printf '  "node": "%s",\n' "$NODE_KIND"
  printf '  "paths": [\n'
  printf '%s\n' "$PATHS" | sed 's/.*/    "&",/' | sed '$ s/,$//'
  printf '  ]\n}\n'
} > "$SHARE/manifest.json"

# Written now, by the thing that knows exactly what it created, so removal is
# exact and works offline.
{
  echo '#!/bin/sh'
  echo '# Removes openmcp. Written by the installer.'
  echo 'set -eu'
  printf '%s\n' "$PATHS" | sed 's|.*|rm -rf "&"|'
  echo 'echo "openmcp removed."'
} > "$SHARE/uninstall.sh"
chmod 0755 "$SHARE/uninstall.sh"

# --- report -------------------------------------------------------------------

say ""
say "Installed openmcp $INSTALLED ($NODE_KIND Node $("$NODE" -v))"
say ""

case ":$PATH:" in
  *":$BIN:"*)
    say "Next:"
    say "  openmcp relays                     what $SITE lists"
    say "  openmcp find \"fetch a page\"        search every relay's tools"
    say "  openmcp add https://your.site      register a relay you operate"
    say "  openmcp serve                      run a catalog of your own"
    ;;
  *)
    say "$BIN is not on your PATH. Add it:"
    say "  echo 'export PATH=\"$BIN:\$PATH\"' >> ~/.profile && . ~/.profile"
    say ""
    say "Or run it directly:  $BIN/openmcp relays"
    ;;
esac

say ""
say "Update with \`openmcp update\`, remove with \`openmcp uninstall\`."
say "Spec: https://logicsrc.com/openmcp"
