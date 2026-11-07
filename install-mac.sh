#!/bin/bash
# Fig2AE for macOS: one line in Terminal, no Node.js, no admin rights.
#   curl -fsSL https://raw.githubusercontent.com/fggtf24-cyber/fig2ae/main/install-mac.sh | bash
# Unlike a browser download, curl sets no quarantine flag, so Gatekeeper has nothing to block.
# Remove:  ... | bash -s -- --uninstall        From an unpacked Fig2AE.zip:  bash install-mac.sh
#
#  - Fig2AE for After Effects (hidden server + panel) -> ~/Library/Application Support/Adobe/CEP/extensions/fig2ae
#  - PlayerDebugMode=1 for CSXS 9..16 (unsigned extensions); stays on uninstall, AEUX & co. need it too
#  - fallback ScriptUI panel (Window > Fig2AE.jsx) into every After Effects version
#  - the Figma plugin -> ~/Library/Application Support/Fig2AE/figma-plugin
#  - ~/Library/Application Support/Fig2AE/install.json: where things are, for auto-update (cep/updater.js)
#
# Everything is inside main: "curl | bash" cut off half-way then runs nothing.
main() {
  set -eu
  local support="$HOME/Library/Application Support"
  local cep="$support/Adobe/CEP/extensions/fig2ae" cfg="$support/Fig2AE"
  local plugin="$cfg/figma-plugin" prefs="$HOME/Library/Preferences/Adobe/After Effects"
  local d v src=''

  if [ "${1:-}" = '--uninstall' ]; then
    rm -rf "$cep" "$cfg"
    for d in "$prefs"/*/; do rm -f "$d/Scripts/ScriptUI Panels/Fig2AE.jsx"; done
    echo 'Fig2AE removed. In Figma remove the plugin: Plugins > Development > Manage plugins in development.'
    return
  fi

  # next to the script (unpacked zip) or fresh from GitHub (curl | bash)
  if [ -n "${BASH_SOURCE:-}" ]; then src="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; fi
  if [ -z "$src" ] || [ ! -f "$src/cep/CSXS/manifest.xml" ]; then
    src="$(mktemp -d)"
    trap "rm -rf '$src'" EXIT       # expanded now: at exit the local variable is gone
    echo 'Downloading Fig2AE...'
    curl -fsSL "${FIG2AE_ZIP:-https://raw.githubusercontent.com/fggtf24-cyber/fig2ae/main/Fig2AE.zip}" -o "$src/Fig2AE.zip"
    ditto -x -k "$src/Fig2AE.zip" "$src"
  fi

  mkdir -p "$(dirname "$cep")" "$cfg"
  rm -rf "$cep" "$plugin"
  cp -R "$src/cep" "$cep"
  cp -R "$src/figma-plugin" "$plugin"
  echo "After Effects extension -> $cep"

  for v in 9 10 11 12 13 14 15 16; do defaults write "com.adobe.CSXS.$v" PlayerDebugMode 1; done

  for d in "$prefs"/*/; do
    v="$(basename "$d")"
    case "$v" in ''|*[!0-9.]*) continue ;; esac
    mkdir -p "$d/Scripts/ScriptUI Panels"
    cp "$src/ae/Fig2AE Panel.jsx" "$d/Scripts/ScriptUI Panels/Fig2AE.jsx"
    rm -f "$d/Scripts/Startup/Fig2AE Startup.jsx"
    echo "After Effects $v: fallback panel Window > Fig2AE.jsx"
  done

  # a copy made from a browser-downloaded zip keeps its quarantine flag otherwise
  xattr -dr com.apple.quarantine "$cep" "$plugin" 2>/dev/null || true

  printf '{\n  "figmaPlugin": "%s",\n  "cep": "%s"\n}\n' "$plugin" "$cep" > "$cfg/install.json"
  rm -f "$cfg/update.json"

  local manifest="$plugin/manifest.json"
  printf '%s' "$manifest" | pbcopy 2>/dev/null || true
  cat <<EOF

Done. Two last steps:
1. After Effects > Settings > Scripting & Expressions > turn on
   "Allow Scripts to Write Files and Access Network" (once), then restart After Effects.
   The panel: Window > Extensions > Fig2AE.
2. Figma desktop app: Plugins > Development > Import plugin from manifest...
   In the file dialog press Cmd+Shift+G, paste the path (it is in the clipboard), press Return:
   $manifest
EOF
}
main "$@"
