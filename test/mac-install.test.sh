#!/bin/bash
# bash test/mac-install.test.sh
# install-mac.sh in a throw-away HOME: from an unpacked release and through "curl | bash".
# On macOS (CI: macos-latest) defaults, ditto, xattr and base64 are the real ones; elsewhere they are stubbed.
set -eu
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
fail() { echo "FAIL: $1" >&2; exit 1; }

if [ "$(uname)" != Darwin ]; then
  mkdir "$T/bin"
  printf '#!/bin/bash\nexit 0\n' > "$T/bin/defaults"
  printf '#!/bin/bash\nexit 0\n' > "$T/bin/xattr"
  printf '#!/bin/bash\ncat > /dev/null\n' > "$T/bin/pbcopy"
  printf '#!/bin/bash\nunzip -q -o "$3" -d "$4"\n' > "$T/bin/ditto"
  chmod +x "$T"/bin/*
  export PATH="$T/bin:$PATH"
fi

check() {   # $1 = the HOME that was installed into
  local s="$1/Library/Application Support" ae="$1/Library/Preferences/Adobe/After Effects/26.2/Scripts"
  [ -f "$s/Adobe/CEP/extensions/fig2ae/CSXS/manifest.xml" ] || fail 'extension not installed'
  [ -f "$s/Adobe/CEP/extensions/fig2ae/panel/host.jsx" ] || fail 'panel not installed'
  [ -f "$s/Fig2AE/figma-plugin/manifest.json" ] || fail 'Figma plugin not installed'
  [ -f "$ae/ScriptUI Panels/Fig2AE.jsx" ] || fail 'fallback panel not installed'
  [ ! -f "$ae/Startup/Fig2AE Startup.jsx" ] || fail 'old watcher left behind'
  [ ! -f "$s/Fig2AE/update.json" ] || fail 'stale update state left behind'
  # auto-update reads this file: it has to be JSON and to point at the plugin
  node -e 'var j = JSON.parse(require("fs").readFileSync(0, "utf8")); if (!/Fig2AE\/figma-plugin$/.test(j.figmaPlugin) || !/extensions\/fig2ae$/.test(j.cep)) process.exit(1);' \
    < "$s/Fig2AE/install.json" || fail 'install.json is wrong'
}

home() {   # a user who had the old watcher, a pending update state and a non-version folder
  local h="$T/$1"
  mkdir -p "$h/Library/Preferences/Adobe/After Effects/26.2/Scripts/Startup" "$h/Library/Preferences/Adobe/After Effects/Plugin Cache" \
           "$h/Library/Application Support/Fig2AE"
  echo old > "$h/Library/Preferences/Adobe/After Effects/26.2/Scripts/Startup/Fig2AE Startup.jsx"
  echo '{}' > "$h/Library/Application Support/Fig2AE/update.json"
  echo "$h"
}

# 1. from an unpacked release, with spaces in the path like every real one under Application Support
R="$T/un packed"
mkdir -p "$R/ae"
cp -R "$ROOT/cep" "$ROOT/figma-plugin" "$R/"
cp "$ROOT/ae/Fig2AE Panel.jsx" "$R/ae/"
cp "$ROOT/install-mac.sh" "$R/"
H="$(home a)"
HOME="$H" bash "$R/install-mac.sh" > /dev/null
check "$H"
[ ! -d "$H/Library/Preferences/Adobe/After Effects/Plugin Cache/Scripts" ] || fail 'a non-version folder got a panel'
[ "$(uname)" != Darwin ] || [ "$(defaults read com.adobe.CSXS.12 PlayerDebugMode)" = 1 ] || fail 'PlayerDebugMode not set'

# 2. uninstall takes it all out again
HOME="$H" bash "$R/install-mac.sh" --uninstall > /dev/null
[ ! -d "$H/Library/Application Support/Adobe/CEP/extensions/fig2ae" ] || fail 'extension left behind'
[ ! -d "$H/Library/Application Support/Fig2AE" ] || fail 'settings left behind'
[ ! -f "$H/Library/Preferences/Adobe/After Effects/26.2/Scripts/ScriptUI Panels/Fig2AE.jsx" ] || fail 'panel left behind'

# 3. curl | bash: the script comes from stdin and fetches the release itself
if [ "$(uname)" = Darwin ] || command -v unzip > /dev/null; then
  H="$(home b)"
  HOME="$H" FIG2AE_ZIP="file://$ROOT/Fig2AE.zip" bash < "$ROOT/install-mac.sh" > /dev/null
  check "$H"
else echo 'no unzip here: curl | bash path skipped'; fi

# 4. the importer's picture decoding, with a path that would run code inside double quotes
if [ "$(uname)" = Darwin ]; then
  P="$T/it's \$(touch pwned)"
  mkdir "$P"
  printf 'QUJD' > "$P/a.b64"
  (cd "$T" && sh -c "base64 -D -i $(node -p 'require(process.argv[1]).shellQuote(process.argv[2])' "$ROOT/ae/geom.jsx" "$P/a.b64") -o $(node -p 'require(process.argv[1]).shellQuote(process.argv[2])' "$ROOT/ae/geom.jsx" "$P/a.out")")
  [ "$(cat "$P/a.out")" = ABC ] || fail 'base64 -D did not decode'
  [ ! -e "$T/pwned" ] || fail 'a path ran as a command'
fi

echo 'mac install: all checks passed'
