#!/usr/bin/env bash
# Provision the headless Blender used to build the character.
#
# Blender is available as the `bpy` wheel on PyPI -- a headless Blender build
# that imports as an ordinary Python module.  Its DSOs still reference a handful
# of X11/OpenGL libraries that a slim container lacks and that cannot be
# apt-installed here (no mirror reachable).  Nothing in the modelling/export
# path ever calls them, so tools/gfx_stubs.py compiles empty stub libraries to
# satisfy the dynamic linker.
#
#   tools/setup_blender_env.sh
#
# Idempotent: re-runs are instant.  Creates $HOME/env (venv with bpy) and
# $HOME/gfxstub (stub .so files, cached symbol list).
set -euo pipefail

ROOT="${ASTRA_BLENDER_ROOT:-$HOME/env}"
STUBS="${ASTRA_GFX_STUBS:-$HOME/gfxstub}"
PY="$ROOT/bin/python"

if [ ! -x "$PY" ]; then
  echo "[setup] creating venv at $ROOT"
  python3 -m venv "$ROOT"
  "$ROOT/bin/pip" -q install --upgrade pip
  echo "[setup] installing bpy (headless Blender, ~370 MB)"
  "$ROOT/bin/pip" -q install "${ASTRA_BPY_SPEC:-bpy==4.5.9}"
fi

echo "[setup] generating X11/GL stub libraries in $STUBS"
"$PY" "$(dirname "$0")/gfx_stubs.py"

echo
echo "Blender toolchain ready.  Use it like this:"
echo
echo "  export LD_LIBRARY_PATH=$STUBS"
echo "  $PY tools/build_character.py   # rig + animate + export public/assets/astra.glb"
echo "  $PY tools/pose_debug.py        # numeric check of the clips (stride, foot plant)"
echo "  $PY tools/render_preview.py    # contact sheet of the poses"
