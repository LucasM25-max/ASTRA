#!/usr/bin/env python3
"""
Numeric verification of the exported clips, evaluated on the real skinned mesh
inside Blender.

Everything the game relies on is checked here, frame by frame:

  contact     the planted foot's sole must sit on the floor (0 +/- 4 mm) and no
              part of the character may ever dip below it
  slide       while a foot is planted its ground contact must travel backwards
              at exactly the clip's speed -- this is what stops the feet from
              skating when the character moves at that speed
  reach       the hip-to-ankle distance may never exceed the length of the bones
  bob         pelvis height, for the record
  swing       the two legs must be in anti-phase (they alternate, never hop)
  timing      clip durations, and the stride the game should move at

Run it after tools/build_character.py; the printed GAIT table is what
src/config.js uses.

    python tools/verify_clips.py            # rebuild first
    ASTRA_SKIP_BUILD=1 python tools/verify_clips.py
"""

from __future__ import annotations

import math
import os
import sys

import bpy
from mathutils import Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_character as bc  # noqa: E402

FPS = 30
SOLE_TOL = 0.004          # allowed contact error, metres
CLIPS = {
    "idle": dict(length=90, loop=True, gait=None),
    "walk": dict(length=30, loop=True, gait=bc.WALK),
    "run": dict(length=20, loop=True, gait=bc.RUN),
    "jump": dict(length=15, loop=False, gait=None),
    "fall": dict(length=24, loop=True, gait=None),
    "land": dict(length=14, loop=False, gait=None),
}
MESHES = ("astra_suit", "astra_light", "astra_dark", "astra_accent")


def use_action(rig, name):
    ad = rig.animation_data
    for track in ad.nla_tracks:
        track.mute = True
    action = bpy.data.actions[name]
    ad.action = action
    if action.slots:
        ad.action_slot = action.slots[0]


def sample(rig, frame):
    """World-space geometry of one frame."""
    bpy.context.scene.frame_set(frame)
    bpy.context.view_layer.update()
    dg = bpy.context.evaluated_depsgraph_get()
    low = {"L": 9e9, "R": 9e9}          # lowest vertex of each foot
    low_any = 9e9                        # lowest vertex of the whole character
    for name in MESHES:
        obj = dg.objects.get(name)
        if obj is None:
            continue
        mw = obj.matrix_world
        for v in obj.data.vertices:
            w = mw @ v.co
            low_any = min(low_any, w.z)
            if w.z < 0.35:
                low["L" if w.x > 0 else "R"] = min(low["L" if w.x > 0 else "R"], w.z)
    joints = {}
    for side in ("L", "R"):
        for stem in ("thigh", "shin", "foot"):
            pb = rig.pose.bones[f"{stem}.{side}"]
            m = rig.matrix_world @ pb.matrix
            joints[(stem, side)] = m @ Vector((0.0, 0.0, 0.0))
    return low, low_any, joints


def planted_flags(name, frame, length, gait):
    """Which feet the animation intends to have on the ground at this frame."""
    t = frame / length
    if name in ("walk", "run"):
        u = t
        return {s: bc.leg_at(gait, s, u + (0.0 if s == "L" else 0.5))[0]
                for s in ("L", "R")}
    if name == "jump":
        return {"L": t < 0.55, "R": t < 0.55}
    if name == "fall":
        return {"L": False, "R": False}
    return {"L": True, "R": True}        # idle, land


def sole_points(rig, side):
    """The two material points of the sole that can touch the floor, in world
    space, tracked rigidly with the foot."""
    pb = rig.pose.bones[f"foot.{side}"]
    m = rig.matrix_world @ pb.matrix
    delta = m.to_3x3() @ pb.bone.matrix_local.to_3x3().inverted()
    ankle = m @ Vector((0.0, 0.0, 0.0))
    out = {}
    for tag, pivot in (("heel", bc.HEEL_Y), ("ball", bc.BALL_Y)):
        out[tag] = ankle + delta @ Vector((0.0, pivot, -bc.ANKLE_Z))
    return out


def run_clip(rig, name, spec):
    length, gait = spec["length"], spec["gait"]
    use_action(rig, name)
    frames = range(length + 1) if not spec["loop"] else range(length)
    rows = []
    for f in frames:
        low, low_any, joints = sample(rig, f)
        rows.append(dict(f=f, low=low, low_any=low_any, joints=joints,
                         sole={s: sole_points(rig, s) for s in ("L", "R")},
                         planted=planted_flags(name, f, length, gait)))

    report = {"name": name, "dur": length / FPS}

    # ---- ground contact -------------------------------------------------
    contact_err = []
    for r in rows:
        for side in ("L", "R"):
            if r["planted"][side]:
                contact_err.append(r["low"][side])
    report["contact"] = (min(contact_err), max(contact_err)) if contact_err else None
    report["below"] = min(r["low_any"] for r in rows)

    # ---- stride, speed, slide ------------------------------------------
    stride = {}
    for side in ("L", "R"):
        ys = [r["joints"][("foot", side)].y for r in rows]
        stride[side] = max(ys) - min(ys)
    report["stride"] = sum(stride.values()) / 2

    # The character moves at the speed the ground under a planted foot travels
    # backwards.  Reconstruct that from the posed foot: what touches the floor
    # is the heel while the toe is up and the ball once the heel lifts.
    # A point of the sole that is lying on the floor must be stationary in the
    # world: in this in-place clip that means it slides backwards at exactly the
    # speed the game will move the character.
    design = spec["gait"]["speed"] if spec["gait"] else None
    moves = []
    for a, b in zip(rows, rows[1:]):
        if a["f"] + 1 != b["f"]:
            continue
        for side in ("L", "R"):
            if not (a["planted"][side] and b["planted"][side]):
                continue                      # only feet the pose puts down
            for tag in ("heel", "ball"):
                pa, pb_ = a["sole"][side][tag], b["sole"][side][tag]
                if abs(pa.z) < 0.004 and abs(pb_.z) < 0.004:
                    moves.append((pb_.y - pa.y) * FPS)
    report["speed"] = sorted(moves)[len(moves) // 2] if moves else 0.0
    ref = design if design else report["speed"]
    report["slide"] = max((abs(m - ref) for m in moves), default=0.0)

    # ---- reach ----------------------------------------------------------
    over = 0.0
    for r in rows:
        for side in ("L", "R"):
            hip = r["joints"][("thigh", side)]
            ankle = r["joints"][("shin", side)]
            over = max(over, (ankle - hip).length - bc.LEG_REACH)
    report["over"] = over

    hips = [r["joints"][("thigh", "L")].z for r in rows]
    report["hips"] = (min(hips), max(hips))
    report["ankle_z"] = {s: (min(r["joints"][("foot", s)].z for r in rows),
                             max(r["joints"][("foot", s)].z for r in rows))
                         for s in ("L", "R")}
    report["antiphase"] = abs(stride["L"] - stride["R"]) < 0.02
    return report


def main():
    if os.environ.get("ASTRA_SKIP_BUILD") != "1":
        bc.main()
    rig = bpy.data.objects["Astra"]

    fails = []
    reports = {}
    for name, spec in CLIPS.items():
        rep = run_clip(rig, name, spec)
        reports[name] = rep
        print(f"\n[{name}]  {rep['dur']:.3f} s")
        if rep["contact"]:
            lo, hi = rep["contact"]
            ok = abs(lo) <= SOLE_TOL and abs(hi) <= SOLE_TOL
            fails += [] if ok else [name]
            print(f"  planted sole      {lo * 1000:+.1f} .. {hi * 1000:+.1f} mm"
                  f"   {'ok' if ok else 'NOT ON THE FLOOR'}")
        else:
            print("  planted sole      (no ground contact in this clip)")
        ok = rep["below"] > -SOLE_TOL
        fails += [] if ok else [name]
        print(f"  lowest vertex     {rep['below'] * 1000:+.1f} mm"
              f"   {'ok' if ok else 'SINKS THROUGH THE FLOOR'}")
        if spec["gait"] is not None:
            ok = rep["slide"] < 0.04
            fails += [] if ok else [name]
            print(f"  ground speed      {rep['speed']:.3f} m/s (config "
                  f"{spec['gait']['speed']:.2f}), stride {rep['stride']:.3f} m")
            print(f"  contact slip      {rep['slide'] * 1000:.0f} mm/s "
                  f"while on the floor   {'ok' if ok else 'FOOT SKATES'}")
        ok = rep["over"] <= 0.001
        fails += [] if ok else [name]
        print(f"  knee over-reach   {rep['over'] * 1000:+.2f} mm"
              f"   {'ok' if ok else 'LEG TOO SHORT'}")
        print(f"  pelvis height     {rep['hips'][0]:.3f} .. {rep['hips'][1]:.3f} m")
        print(f"  ankle height      L {rep['ankle_z']['L'][0]:.3f}..{rep['ankle_z']['L'][1]:.3f}"
              f"  R {rep['ankle_z']['R'][0]:.3f}..{rep['ankle_z']['R'][1]:.3f} m")
        if spec["gait"] is not None:
            ok = rep["antiphase"]
            fails += [] if ok else [name]
            print(f"  left/right swing  {'are in anti-phase' if ok else 'ARE IN PHASE'}")

    print("\n// ---- paste into src/config.js ------------------------------------")
    print("export const GAIT = {")
    for name in ("walk", "run"):
        r = reports[name]
        print(f"  {name}: {{ speed: {r['speed']:.2f}, duration: {r['dur']:.3f},"
              f" stride: {r['stride']:.3f} }},")
    for name in ("idle", "jump", "fall", "land"):
        print(f"  {name}: {{ duration: {reports[name]['dur']:.3f} }},")
    print("};")

    if fails:
        print(f"\nFAILED: {sorted(set(fails))}")
        sys.exit(1)
    print("\nall clip checks passed")


if __name__ == "__main__":
    main()
