"""
Verify the exported character: geometry, skinning and one animation per
locomotion state.  Reads the GLB directly (no Blender needed), so it can be
run in CI as a plain `python tools/verify_glb.py`.
"""

from __future__ import annotations

import json
import os
import struct
import sys

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GLB = os.environ.get("ASTRA_CHARACTER_GLB", os.path.join(HERE, "public", "assets", "astra.glb"))

EXPECTED_ANIMS = {
    "idle": 3.0,
    "walk": 1.0,
    "run": 20 / 30,
    "jump": 15 / 30,
    "fall": 0.8,
    "land": 14 / 30,
}
EXPECTED_BONES = 20
DUR_TOL = 0.06


def read_glb(path):
    with open(path, "rb") as fh:
        magic, version, length = struct.unpack("<4sII", fh.read(12))
        if magic != b"glTF":
            raise SystemExit(f"{path}: not a GLB file")
        clen, ctype = struct.unpack("<II", fh.read(8))
        if ctype != 0x4E4F534A:
            raise SystemExit(f"{path}: first chunk is not JSON")
        return json.loads(fh.read(clen)), length


def accessor_times(gltf, acc_index):
    """min/max of a scalar (time) accessor, straight from the JSON header."""
    acc = gltf["accessors"][acc_index]
    return acc["min"][0], acc["max"][0]


def main():
    gltf, byte_length = read_glb(GLB)
    problems = []
    ok = []

    # ---- geometry + skinning --------------------------------------------
    meshes = gltf.get("meshes", [])
    skins = gltf.get("skins", [])
    if not meshes:
        problems.append("no meshes in the GLB")
    if len(skins) != 1:
        problems.append(f"expected 1 skin, found {len(skins)}")
    else:
        joints = skins[0].get("joints", [])
        if len(joints) != EXPECTED_BONES:
            problems.append(f"expected {EXPECTED_BONES} joints, found {len(joints)}")
        else:
            ok.append(f"skin with {len(joints)} joints")

    skinned_prims = 0
    total_verts = 0
    for mesh in meshes:
        for prim in mesh["primitives"]:
            attrs = prim["attributes"]
            if "JOINTS_0" in attrs and "WEIGHTS_0" in attrs:
                skinned_prims += 1
            total_verts += gltf["accessors"][attrs["POSITION"]]["count"]
    if skinned_prims != sum(len(m["primitives"]) for m in meshes):
        problems.append(f"only {skinned_prims} primitives are skinned")
    else:
        ok.append(f"{len(meshes)} skinned mesh(es), {total_verts} vertices")

    # ---- animations ------------------------------------------------------
    anims = {a["name"]: a for a in gltf.get("animations", [])}
    missing = [n for n in EXPECTED_ANIMS if n not in anims]
    if missing:
        problems.append(f"missing animations: {missing}")
    extra = [n for n in anims if n not in EXPECTED_ANIMS]
    if extra:
        problems.append(f"unexpected animations: {extra}")

    node_names = [n.get("name", "") for n in gltf.get("nodes", [])]
    for name, expected in EXPECTED_ANIMS.items():
        anim = anims.get(name)
        if not anim:
            continue
        times = []
        targets = set()
        paths = set()
        for ch in anim["channels"]:
            sampler = anim["samplers"][ch["sampler"]]
            lo, hi = accessor_times(gltf, sampler["input"])
            times.append(hi)
            node = gltf["nodes"][ch["target"]["node"]].get("name", "")
            targets.add(node)
            paths.add(ch["target"]["path"])
        duration = max(times)
        if abs(duration - expected) > DUR_TOL:
            problems.append(f"{name}: duration {duration:.3f}s, expected ~{expected:.3f}s")
        if "rotation" not in paths:
            problems.append(f"{name}: no rotation channels (not animated)")
        if len(targets) < 8:
            problems.append(f"{name}: only {len(targets)} bones animated")
        if len(anim["channels"]) < 20:
            problems.append(f"{name}: only {len(anim['channels'])} channels")
        ok.append(f"{name}: {duration:.3f}s, {len(anim['channels'])} channels, "
                  f"{len(targets)} bones")

    # ---- the walk cycle must move the legs in opposite phase -------------
    if "walk" in anims and "hips" in node_names:
        hips = node_names.index("hips")
        translated = any(ch["target"]["node"] == hips and ch["target"]["path"] == "translation"
                         for ch in anims["walk"]["channels"])
        if not translated:
            problems.append("walk: hips are not translated (no body bob)")
        else:
            ok.append("walk: hips bob (translation channel present)")

    for line in ok:
        print(f"  ok   {line}")
    for line in problems:
        print(f"  FAIL {line}")
    print(f"\n{GLB} — {byte_length} bytes, "
          f"{len(meshes)} meshes, {len(skins)} skin(s), {len(anims)} animations")
    if problems:
        print(f"{len(problems)} problem(s) found")
        return 1
    print("all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
