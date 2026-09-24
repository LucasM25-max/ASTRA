"""
Build the ASTRA humanoid inside Blender and export it as a skinned, animated glTF.

The character is modelled procedurally (no external assets), rigged with an
armature, and given one Blender Action per locomotion state:

    idle, walk, run, jump, fall, land

Run it with the Blender Python module (pip install bpy) or inside Blender itself:

    python tools/build_character.py            # writes assets/astra.glb
    blender -b -P tools/build_character.py     # same, from a Blender install

Everything is authored from numbers, so the committed .glb can always be
regenerated: the mesh, the rig and every keyframe come out the same. (Blender's
exporter may order triangles differently between runs, so the file is not
guaranteed to be byte-identical -- the geometry is, and tools/verify_glb.py
checks the structure that matters.)
"""

from __future__ import annotations

import math
import os
import sys

import bpy
from mathutils import Matrix, Quaternion, Vector

# --------------------------------------------------------------------------- #
# constants
# --------------------------------------------------------------------------- #

FPS = 30
OUT_PATH = os.environ.get(
    "ASTRA_CHARACTER_OUT",
    os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                 "assets", "astra.glb"),
)

D = math.radians  # degrees -> radians

COL_BODY = (0.148, 0.176, 0.216, 1.0)     # suit, cold charcoal blue
COL_ACCENT = (0.239, 0.855, 0.843, 1.0)   # joints / trim, bright teal
COL_LIGHT = (0.812, 0.847, 0.890, 1.0)    # head, neck, hands
COL_DARK = (0.043, 0.055, 0.075, 1.0)     # visor


# --------------------------------------------------------------------------- #
# small helpers
# --------------------------------------------------------------------------- #

def _link(obj):
    bpy.context.collection.objects.link(obj)
    return obj


def new_mesh_object(name, mesh):
    obj = bpy.data.objects.new(name, mesh)
    _link(obj)
    return obj


def _bake(mesh, matrix):
    mesh.transform(matrix)
    mesh.update()


def loc_rot_scale(loc, direction, scale=(1, 1, 1)):
    """Matrix sending +Z onto `direction` and centring on `loc`."""
    quat = Vector((0.0, 0.0, 1.0)).rotation_difference(direction.normalized())
    return Matrix.LocRotScale(Vector(loc), quat, Vector(scale))


def sphere(name, center, radius, scale=(1, 1, 1), segments=24, rings=12):
    bpy.ops.mesh.primitive_uv_sphere_add(
        radius=radius, segments=segments, ring_count=rings, location=(0, 0, 0)
    )
    obj = bpy.context.active_object
    obj.name = name
    _bake(obj.data, loc_rot_scale(center, Vector((0, 0, 1)), scale))
    return obj


def tube(name, p0, p1, r0, r1, verts=20, cap=True):
    """Tapered cylinder (truncated cone) stretched between two points."""
    p0, p1 = Vector(p0), Vector(p1)
    axis = p1 - p0
    bpy.ops.mesh.primitive_cone_add(
        vertices=verts, radius1=r0, radius2=r1, depth=1.0,
        end_fill_type="NGON" if cap else "NOTHING", location=(0, 0, 0),
    )
    obj = bpy.context.active_object
    obj.name = name
    _bake(obj.data, loc_rot_scale((p0 + p1) / 2, axis, (1, 1, axis.length)))
    return obj


def box(name, center, size, rot=(0, 0, 0)):
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=(0, 0, 0))
    obj = bpy.context.active_object
    obj.name = name
    q = Quaternion((1, 0, 0, 0))
    q = Quaternion((0, 0, 1), rot[2]) @ Quaternion((0, 1, 0), rot[1]) @ Quaternion((1, 0, 0), rot[0])
    _bake(obj.data, Matrix.LocRotScale(Vector(center), q, Vector(size)))
    return obj


def make_material(name, color, roughness=0.55, metallic=0.0):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = color
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Metallic"].default_value = metallic
    return mat


# --------------------------------------------------------------------------- #
# rig
# --------------------------------------------------------------------------- #

# name -> (head, tail, parent, roll)
BONES = {
    "root":        ((0, 0, 0),      (0, 0, 0.20),   None,        0),
    "hips":        ((0, 0, 0.95),   (0, 0, 1.12),   "root",      0),
    "spine":       ((0, 0, 1.12),   (0, 0, 1.30),   "hips",      0),
    "chest":       ((0, 0, 1.30),   (0, 0, 1.52),   "spine",     0),
    "neck":        ((0, 0, 1.52),   (0, 0, 1.62),   "chest",     0),
    "head":        ((0, 0, 1.62),   (0, 0, 1.80),   "neck",      0),

    "shoulder.L":  ((0.06, 0, 1.455), (0.20, 0, 1.455), "chest",  0),
    "upper_arm.L": ((0.20, 0, 1.44),  (0.20, 0, 1.18),  "shoulder.L", 0),
    "forearm.L":   ((0.20, 0, 1.18),  (0.20, 0, 0.94),  "upper_arm.L", 0),
    "hand.L":      ((0.20, 0, 0.94),  (0.20, 0, 0.84),  "forearm.L", 0),

    "shoulder.R":  ((-0.06, 0, 1.455), (-0.20, 0, 1.455), "chest", 0),
    "upper_arm.R": ((-0.20, 0, 1.44),  (-0.20, 0, 1.18),  "shoulder.R", 0),
    "forearm.R":   ((-0.20, 0, 1.18),  (-0.20, 0, 0.94),  "upper_arm.R", 0),
    "hand.R":      ((-0.20, 0, 0.94),  (-0.20, 0, 0.84),  "forearm.R", 0),

    "thigh.L":     ((0.105, 0, 0.96),  (0.105, 0, 0.52),  "hips", 0),
    "shin.L":      ((0.105, 0, 0.52),  (0.105, 0, 0.10),  "thigh.L", 0),
    "foot.L":      ((0.105, 0, 0.10),  (0.105, -0.16, 0.045), "shin.L", 0),

    "thigh.R":     ((-0.105, 0, 0.96), (-0.105, 0, 0.52), "hips", 0),
    "shin.R":      ((-0.105, 0, 0.52), (-0.105, 0, 0.10), "thigh.R", 0),
    "foot.R":      ((-0.105, 0, 0.10), (-0.105, -0.16, 0.045), "shin.R", 0),
}


def build_armature():
    arm = bpy.data.armatures.new("astra_rig")
    arm.display_type = "OCTAHEDRAL"
    obj = bpy.data.objects.new("Astra", arm)
    _link(obj)
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)

    bpy.ops.object.mode_set(mode="EDIT")
    made = {}
    for name, (head, tail, parent, roll) in BONES.items():
        eb = arm.edit_bones.new(name)
        eb.head = Vector(head)
        eb.tail = Vector(tail)
        eb.roll = roll
        made[name] = eb
    for name, (_, _, parent, _) in BONES.items():
        if parent:
            made[name].parent = made[parent]
    bpy.ops.object.mode_set(mode="OBJECT")
    return obj


def seg_dist(p, a, b):
    """Distance from point p to segment ab."""
    ab = b - a
    L2 = ab.length_squared
    if L2 < 1e-12:
        return (p - a).length
    t = max(0.0, min(1.0, (p - a).dot(ab) / L2))
    return (p - (a + ab * t)).length


def skin_object(obj, rigid_bone=None, bind=None, power=4.0):
    """Weight the vertices of one body part to the rig.

    A part is either rigid (one bone: hands, boots, visor) or blended between
    the bones it spans.  `bind` names those bones explicitly -- choosing the
    nearest bone by distance alone hands torso vertices to whichever limb
    happens to hang closest to them, which tears the mesh apart the moment the
    limbs swing.
    """
    groups = {}

    def group(name):
        if name not in groups:
            groups[name] = obj.vertex_groups.new(name=name)
        return groups[name]

    if rigid_bone:
        group(rigid_bone).add([v.index for v in obj.data.vertices], 1.0, "REPLACE")
        return

    segments = {n: (Vector(h), Vector(t)) for n, (h, t, _, _) in BONES.items()}
    candidates = bind or list(segments)
    for vert in obj.data.vertices:
        near = sorted((seg_dist(vert.co, *segments[n]) + 1e-4, n) for n in candidates)[:2]
        weights = [(1.0 / d ** power, n) for d, n in near]
        total = sum(w for w, _ in weights)
        for w, n in weights:
            group(n).add([vert.index], w / total, "REPLACE")


def build_body(materials):
    """Return a list of (object, material, rigid_bone) parts."""
    B, A, L, K = materials
    parts = []

    def add(obj, mat, rigid=None):
        obj.data.materials.append(mat)
        bpy.ops.object.shade_smooth()
        parts.append((obj, mat, rigid))

    # --- head -------------------------------------------------------------
    add(sphere("skull", (0, 0, 1.705), 0.115, (0.92, 1.0, 1.08)), L, "head")
    add(box("visor", (0, -0.098, 1.718), (0.145, 0.035, 0.055), rot=(D(-8), 0, 0)), K, "head")
    add(tube("neck", (0, 0, 1.545), (0, 0, 1.645), 0.052, 0.046), L, "neck")

    # --- torso ------------------------------------------------------------
    add(sphere("pelvis", (0, 0, 1.01), 0.145, (1.06, 0.82, 0.80)), B)
    add(tube("abdomen", (0, 0, 1.03), (0, 0, 1.30), 0.132, 0.152), B)
    add(sphere("chest", (0, 0, 1.375), 0.163, (1.02, 0.74, 0.86)), B)
    add(box("chest_plate", (0, -0.075, 1.385), (0.19, 0.05, 0.17), rot=(D(6), 0, 0)), A)
    add(sphere("shoulder_pad.L", (0.205, 0, 1.455), 0.078, (1.0, 0.95, 0.95)), A, "shoulder.L")
    add(sphere("shoulder_pad.R", (-0.205, 0, 1.455), 0.078, (1.0, 0.95, 0.95)), A, "shoulder.R")

    # --- arms -------------------------------------------------------------
    for s in ("L", "R"):
        x = 0.205 if s == "L" else -0.205
        add(tube(f"upper_arm.{s}", (x, 0, 1.435), (x, 0, 1.19), 0.056, 0.049), B)
        add(sphere(f"elbow.{s}", (x, 0, 1.18), 0.053), A)
        add(tube(f"forearm.{s}", (x, 0, 1.17), (x, 0, 0.95), 0.048, 0.040), B)
        add(sphere(f"wrist.{s}", (x, 0, 0.945), 0.043), A, f"forearm.{s}")
        add(box(f"hand.{s}", (x, 0, 0.872), (0.068, 0.042, 0.115)), L, f"hand.{s}")

    # --- legs -------------------------------------------------------------
    for s in ("L", "R"):
        x = 0.108 if s == "L" else -0.108
        add(tube(f"thigh.{s}", (x, 0, 0.955), (x, 0, 0.53), 0.088, 0.066), B)
        add(sphere(f"knee.{s}", (x, 0, 0.52), 0.069), A)
        add(tube(f"shin.{s}", (x, 0, 0.51), (x, 0, 0.115), 0.061, 0.047), B)
        # sole sits exactly on z=0; the toe cap turns up so the boot does not
        # cut through the floor while the heel lifts during toe-off
        add(box(f"foot.{s}", (x, -0.034, 0.029), (0.098, 0.2125, 0.058)), K, f"foot.{s}")
        add(box(f"toe.{s}", (x, -0.161, 0.0390), (0.092, 0.058, 0.050),
                rot=(D(-20), 0, 0)), K, f"foot.{s}")

    return parts


def build_body(materials):
    """Return a list of (object, material, rigid_bone, bind_bones) parts."""
    B, A, L, K = materials
    parts = []

    def add(obj, mat, rigid=None, bind=None):
        obj.data.materials.append(mat)
        bpy.ops.object.shade_smooth()
        parts.append((obj, mat, rigid, bind))

    # --- head -------------------------------------------------------------
    add(sphere("skull", (0, 0, 1.705), 0.115, (0.92, 1.0, 1.08)), L, "head")
    add(box("visor", (0, -0.098, 1.718), (0.145, 0.035, 0.055), rot=(D(-8), 0, 0)), K, "head")
    add(tube("neck", (0, 0, 1.545), (0, 0, 1.645), 0.052, 0.046), L, None,
        ["neck", "head", "chest"])

    # --- torso ------------------------------------------------------------
    add(sphere("pelvis", (0, 0, 1.01), 0.145, (1.06, 0.82, 0.80)), B, None, ["hips", "spine"])
    add(tube("abdomen", (0, 0, 1.03), (0, 0, 1.30), 0.132, 0.152), B, None,
        ["hips", "spine", "chest"])
    add(sphere("chest", (0, 0, 1.375), 0.163, (1.02, 0.74, 0.86)), B, None,
        ["spine", "chest", "neck"])
    add(box("chest_plate", (0, -0.075, 1.385), (0.19, 0.05, 0.17), rot=(D(6), 0, 0)), A,
        None, ["chest", "spine"])
    add(sphere("shoulder_pad.L", (0.205, 0, 1.455), 0.078, (1.0, 0.95, 0.95)), A, "shoulder.L")
    add(sphere("shoulder_pad.R", (-0.205, 0, 1.455), 0.078, (1.0, 0.95, 0.95)), A, "shoulder.R")

    # --- arms -------------------------------------------------------------
    for s in ("L", "R"):
        x = 0.205 if s == "L" else -0.205
        add(tube(f"upper_arm.{s}", (x, 0, 1.435), (x, 0, 1.19), 0.056, 0.049), B, None,
            [f"upper_arm.{s}", f"shoulder.{s}", f"forearm.{s}"])
        add(sphere(f"elbow.{s}", (x, 0, 1.18), 0.053), A, None,
            [f"upper_arm.{s}", f"forearm.{s}"])
        add(tube(f"forearm.{s}", (x, 0, 1.17), (x, 0, 0.95), 0.048, 0.040), B, None,
            [f"forearm.{s}", f"upper_arm.{s}", f"hand.{s}"])
        add(sphere(f"wrist.{s}", (x, 0, 0.945), 0.043), A, f"forearm.{s}")
        add(box(f"hand.{s}", (x, 0, 0.872), (0.068, 0.042, 0.115)), L, f"hand.{s}")

    # --- legs -------------------------------------------------------------
    for s in ("L", "R"):
        x = 0.108 if s == "L" else -0.108
        add(tube(f"thigh.{s}", (x, 0, 0.955), (x, 0, 0.53), 0.088, 0.066), B, None,
            [f"thigh.{s}", "hips", f"shin.{s}"])
        add(sphere(f"knee.{s}", (x, 0, 0.52), 0.069), A, None,
            [f"thigh.{s}", f"shin.{s}"])
        add(tube(f"shin.{s}", (x, 0, 0.51), (x, 0, 0.115), 0.061, 0.047), B, None,
            [f"shin.{s}", f"thigh.{s}", f"foot.{s}"])
        # sole sits exactly on z=0; the toe cap turns up so the boot does not
        # cut through the floor while the heel lifts during toe-off
        add(box(f"foot.{s}", (x, -0.034, 0.029), (0.098, 0.2125, 0.058)), K, f"foot.{s}")
        add(box(f"toe.{s}", (x, -0.161, 0.0390), (0.092, 0.058, 0.050),
                rot=(D(-20), 0, 0)), K, f"foot.{s}")

    return parts


def assemble(parts, rig):
    """Skin each part, merge parts that share a material, parent to the rig."""
    merged = []
    by_mat = {}
    for obj, mat, rigid, bind in parts:
        skin_object(obj, rigid, bind)
        by_mat.setdefault(mat.name, []).append(obj)

    for mat_name, objs in by_mat.items():
        bpy.ops.object.select_all(action="DESELECT")
        for o in objs:
            o.select_set(True)
        bpy.context.view_layer.objects.active = objs[0]
        if len(objs) > 1:
            bpy.ops.object.join()
        body = bpy.context.active_object
        body.name = f"astra_{mat_name}"
        body.parent = rig
        mod = body.modifiers.new("Armature", "ARMATURE")
        mod.object = rig
        merged.append(body)
    return merged


# --------------------------------------------------------------------------- #
# animation
# --------------------------------------------------------------------------- #
#
# Poses are authored in world space:
#
#   delta      rotation deltas about world axes, accumulated down the bone
#              hierarchy -- so a pelvis yaw really does carry the legs and arms
#   world_rot  absolute world rotations (used by the IK-driven legs)
#   pos        absolute world positions (used by the pelvis)
#   legs       ankle targets, solved with analytic two-bone IK
#
# Feet are never hand-posed.  A foot is either planted -- its sole touching the
# ground at a prescribed pitch -- or swinging along an arc between two planted
# poses, and the pelvis height is derived from the planted legs.  The character
# therefore cannot float above the floor or push through it, and it never
# over-extends a knee.

LEN_THIGH, LEN_SHIN = 0.44, 0.42          # hip->knee, knee->ankle
LEG_REACH = LEN_THIGH + LEN_SHIN
ANKLE_Z = 0.10                            # ankle height with the sole flat
BALL_Y, HEEL_Y = -0.140, 0.0725           # toe-off / heel-strike pivots from ankle
SOLE_SPAN = HEEL_Y - BALL_Y               # heel to ball, 0.2075 m
HIP_X = 0.105                             # lateral offset of a hip joint
THIGH_HEAD_Z = 0.01                       # thigh head above the pelvis origin


def extension(flex):
    """Hip-to-ankle distance for a knee flexed by `flex` radians."""
    return math.sqrt(LEN_THIGH ** 2 + LEN_SHIN ** 2
                     + 2 * LEN_THIGH * LEN_SHIN * math.cos(flex))


def flexion(dist):
    """Knee flexion (radians) needed to span `dist` from hip to ankle."""
    c = (LEN_THIGH ** 2 + LEN_SHIN ** 2 - dist ** 2) / (2 * LEN_THIGH * LEN_SHIN)
    return math.acos(max(-1.0, min(1.0, c)))


def smoothstep(a, b, x):
    t = 0.0 if b <= a else max(0.0, min(1.0, (x - a) / (b - a)))
    return t * t * (3.0 - 2.0 * t)


def curve(points, x):
    """Smooth interpolation through [(x, y), ...]."""
    if x <= points[0][0]:
        return points[0][1]
    if x >= points[-1][0]:
        return points[-1][1]
    for (x0, y0), (x1, y1) in zip(points, points[1:]):
        if x0 <= x <= x1:
            return y0 + (y1 - y0) * smoothstep(x0, x1, x)
    return points[-1][1]


def hermite(p0, p1, m0, m1, s):
    s2, s3 = s * s, s * s * s
    return ((2 * s3 - 3 * s2 + 1) * p0 + (s3 - 2 * s2 + s) * m0
            + (-2 * s3 + 3 * s2) * p1 + (s3 - s2) * m1)


def contact_ankle(x, ground_y, pitch, pivot):
    """Ankle position that puts `pivot` ('ball' or 'heel') on the ground at
    `ground_y`, with the sole pitched by `pitch` (positive = heel up)."""
    rel = Vector((0.0, BALL_Y if pivot == "ball" else HEEL_Y, -ANKLE_Z))
    return Vector((x, ground_y, 0.0)) - (Matrix.Rotation(pitch, 3, "X") @ rel)


# --- locomotion parameters --------------------------------------------------

WALK = dict(
    cycle=1.00, duty=0.62, speed=1.13, front=0.30, rise=0.0,
    heel_roll=0.10, toe_roll=0.48,
    pitch_strike=14.0, pitch_toe=22.0, swing_lift=0.040,
    ankle_x=0.105, toe_out=5.0,
    flex=[(0.00, 7.0), (0.12, 10.0), (0.31, 17.0), (0.50, 13.0), (0.62, 10.0)],
    sway=0.020, yaw=5.0, roll=3.5, lean=2.5,
    arm=19.0, arm_lean=-3.0, elbow=14.0, elbow_swing=13.0, hand=-6.0,
)

RUN = dict(
    cycle=0.667, duty=0.32, speed=2.45, front=0.27, rise=0.030,
    heel_roll=0.06, toe_roll=0.22,
    pitch_strike=6.0, pitch_toe=22.0, swing_lift=0.150,
    ankle_x=0.095, toe_out=2.0,
    flex=[(0.00, 20.0), (0.08, 30.0), (0.16, 50.0), (0.24, 42.0), (0.32, 30.0)],
    sway=0.012, yaw=7.0, roll=4.0, lean=9.0,
    arm=44.0, arm_lean=-6.0, elbow=76.0, elbow_swing=26.0, hand=-12.0,
)


def leg_at(g, side, u, _eps=1e-4):
    """State of one leg at phase `u` (0 = heel strike).

    Returns (planted, ankle position, foot pitch, knee flexion)."""
    u = u % 1.0
    duty = g["duty"]
    sgn = 1.0 if side == "L" else -1.0
    ax = sgn * g["ankle_x"]

    if u < duty:
        # stance: the point of the sole that touches the ground travels
        # backwards at exactly the walking speed, so the foot never slides
        c = -g["front"] + g["speed"] * g["cycle"] * u
        if u < g["heel_roll"]:
            pitch = -D(g["pitch_strike"]) * (1.0 - smoothstep(0.0, g["heel_roll"], u))
            ankle = contact_ankle(ax, c, pitch, "heel")
        elif u < g["toe_roll"]:
            pitch = 0.0
            ankle = contact_ankle(ax, c, pitch, "heel")
        else:
            pitch = D(g["pitch_toe"]) * smoothstep(g["toe_roll"], duty, u)
            ankle = contact_ankle(ax, c - SOLE_SPAN, pitch, "ball")
        return True, ankle, pitch, D(curve(g["flex"], u))

    # swing: cubic hermite between toe-off and the next heel strike, with the
    # end slopes taken from the stance trajectory so the leg never snaps
    _, a0, p0, _ = leg_at(g, side, duty - _eps, _eps)
    _, a1, p1, _ = leg_at(g, side, _eps, _eps)
    _, am, _, _ = leg_at(g, side, duty - 2 * _eps, _eps)
    _, ab, _, _ = leg_at(g, side, 0.0, _eps)

    s = (u - duty) / (1.0 - duty)
    span = 1.0 - duty
    m0 = (a0 - am) / _eps * span          # dy/du -> dy/ds
    m1 = (a1 - ab) / _eps * span
    y = hermite(a0.y, a1.y, m0.y, m1.y, s)
    z = (hermite(a0.z, a1.z, m0.z, m1.z, s)
         + g["swing_lift"] * math.sin(math.pi * s) ** 2)
    pitch = p0 + (p1 - p0) * smoothstep(0.0, 1.0, s)
    return False, Vector((ax, y, z)), pitch, None


def leg_extended(g, side, u):
    """Stance geometry continued past toe-off, used to keep the pelvis
    trajectory sensible while the character is airborne."""
    u = u % 1.0
    if u < g["duty"]:
        return leg_at(g, side, u)
    sgn = 1.0 if side == "L" else -1.0
    ax = sgn * g["ankle_x"]
    pitch = D(g["pitch_toe"])
    c = -g["front"] + g["speed"] * g["cycle"] * u
    return (True, contact_ankle(ax, c - SOLE_SPAN, pitch, "ball"),
            pitch, D(curve(g["flex"], g["duty"])))


class Animator:
    """Turns world-space pose descriptions into keyframed Blender Actions."""

    def __init__(self, rig):
        self.rig = rig
        self.actions = {}
        self.current = None
        self.miss = 0.0
        self.diag = []          # (frame, side, unreachable mm) per clip
        self.clip_diag = {}
        rig.animation_data_create()

        bones = list(rig.data.bones)
        self.rest = {b.name: b.matrix_local.copy() for b in bones}
        self.rest_q = {b.name: b.matrix_local.to_quaternion() for b in bones}
        self.rest_dir = {b.name: (b.tail_local - b.head_local).normalized() for b in bones}
        self.parent = {b.name: (b.parent.name if b.parent else None) for b in bones}
        self.refs = {}
        for b in bones:
            p = self.parent[b.name]
            self.refs[b.name] = (self.rest[b.name] if p is None
                                 else self.rest[p].inverted() @ self.rest[b.name])
        legs = ("thigh", "shin", "foot")
        names = [b.name for b in bones]
        self.spine = self._topo([n for n in names if n.split(".")[0] not in legs])
        self.leg_order = self._topo([n for n in names if n.split(".")[0] in legs])
        self.order = self._topo(names)

    # -- plumbing ----------------------------------------------------------
    def _depth(self, name):
        d, p = 0, self.parent[name]
        while p:
            d, p = d + 1, self.parent[p]
        return d

    def _topo(self, names):
        return sorted(names, key=lambda n: (self._depth(n), n))

    def wrot(self, bone, rx=0.0, ry=0.0, rz=0.0):
        """Absolute world rotation: the bone's rest orientation turned by
        world-axis angles (applied rz . ry . rx)."""
        d = (Quaternion((0, 0, 1), D(rz)) @ Quaternion((0, 1, 0), D(ry))
             @ Quaternion((1, 0, 0), D(rx)))
        return d @ self.rest_q[bone]

    def wdir(self, bone, direction):
        """Absolute world rotation pointing the bone along `direction`."""
        return self.rest_dir[bone].rotation_difference(direction) @ self.rest_q[bone]

    def begin(self, name, length):
        act = bpy.data.actions.new(name)
        self.actions[name] = act
        ad = self.rig.animation_data
        ad.action = act
        if getattr(ad, "action_slot", None) is None and hasattr(act, "slots"):
            ad.action_slot = act.slots.new(id_type="OBJECT", name=f"{name}_slot")
        self.current = act
        self.length = length
        self.diag = []
        self.clip_diag[name] = self.diag
        return self

    def _curve_setup(self):
        for fc in self.current.fcurves:
            for kp in fc.keyframe_points:
                kp.interpolation = "BEZIER"
                kp.handle_left_type = "AUTO_CLAMPED"
                kp.handle_right_type = "AUTO_CLAMPED"
            fc.update()

    def end(self):
        self._curve_setup()
        self.rig.animation_data.action = None
        self.current = None
        return self

    # -- inverse kinematics ------------------------------------------------
    def solve_leg(self, side, ankle, flex, hips_world):
        """Two-bone IK.  Returns world rotations for thigh and shin plus the
        residual miss vector (zero whenever the target is reachable)."""
        hip = (hips_world @ self.refs[f"thigh.{side}"]).translation
        d = Vector(ankle) - hip
        limit = LEG_REACH - 0.001 if flex is None else extension(flex)
        span = max(0.24, min(d.length, limit))
        axis = d.normalized() if d.length > 1e-6 else Vector((0, 0, -1))
        pole = Vector((0.0, -1.0, 0.0))                  # knees bend forward
        perp = pole - axis * pole.dot(axis)
        perp = perp.normalized() if perp.length > 1e-5 else Vector((0.0, -1.0, 0.0))
        a = math.acos(max(-1.0, min(1.0, (LEN_THIGH ** 2 + span ** 2 - LEN_SHIN ** 2)
                                        / (2 * LEN_THIGH * span))))
        thigh_dir = axis * math.cos(a) + perp * math.sin(a)
        knee = hip + thigh_dir * LEN_THIGH
        solved_ankle = hip + axis * span
        shin_dir = (solved_ankle - knee).normalized()
        return (self.wdir(f"thigh.{side}", thigh_dir),
                self.wdir(f"shin.{side}", shin_dir),
                solved_ankle - Vector(ankle))

    # -- pelvis height -----------------------------------------------------
    def hips_height(self, hips_rot, hx, hy, states, planted_only=False):
        """Lowest pelvis height that still leaves every planted leg inside its
        knee-flex budget -- i.e. the body simply cannot float or over-reach."""
        rot = hips_rot.to_matrix()
        best = None
        for side, (planted, ankle, pitch, flex) in states.items():
            if planted_only and not planted:
                continue
            # a planted leg is limited by the knee flexion its phase calls for,
            # a swinging one only by the length of the bones
            reach = LEG_REACH if flex is None else extension(flex)
            sgn = 1.0 if side == "L" else -1.0
            off = rot @ Vector((sgn * HIP_X, 0.0, THIGH_HEAD_Z))
            dx = hx + off.x - ankle.x
            dy = hy + off.y - ankle.y
            room = reach * reach - dx * dx - dy * dy
            if room <= 1e-6:
                continue
            z = ankle.z + math.sqrt(room) - off.z
            best = z if best is None else min(best, z)
        return best

    def states_at(self, g, u, shift=0.0):
        return {s: leg_at(g, s, u + (0.0 if s == "L" else 0.5))
                for s in ("L", "R")}

    # -- keyframing --------------------------------------------------------
    def _local(self, ref, q_world, pos):
        inv = ref.to_3x3().inverted()
        loc = Vector((0.0, 0.0, 0.0)) if pos is None else inv @ (Vector(pos) - ref.translation)
        return (inv @ q_world.to_matrix()).to_quaternion(), loc

    def key(self, frame, delta=None, world_rot=None, pos=None, legs=None):
        delta = delta or {}
        world_rot = world_rot or {}
        pos = pos or {}
        legs = legs or {}
        world, acc, out = {}, {}, {}

        def place(name, q, at=None):
            parent = self.parent[name]
            ref = (world[parent] @ self.refs[name]) if parent else self.rest[name].copy()
            ql, loc = self._local(ref, q, at)
            world[name] = ref @ Matrix.Translation(loc) @ ql.to_matrix().to_4x4()
            out[name] = (ql, loc)

        for name in self.spine:
            parent = self.parent[name]
            base = acc.get(parent, Quaternion()) if parent else Quaternion()
            q = (world_rot[name] if name in world_rot
                 else (base @ delta.get(name, Quaternion())) @ self.rest_q[name])
            acc[name] = q @ self.rest_q[name].inverted()
            place(name, q, pos.get(name))

        ik = {}
        for side in ("L", "R"):
            if side in legs:
                ankle, flex = legs[side]
                qt, qs, miss = self.solve_leg(side, ankle, flex, world["hips"])
                ik[side] = (qt, qs)
                self.miss = max(self.miss, miss.length)
                if miss.length > 0.002:
                    self.diag.append((frame, side, miss.length))

        for name in self.leg_order:
            parent = self.parent[name]
            side = name.split(".")[1]
            stem = name.split(".")[0]
            if stem in ("thigh", "shin") and side in ik:
                q = ik[side][0 if stem == "thigh" else 1]
            elif name in world_rot:
                q = world_rot[name]
            else:
                q = acc.get(parent, Quaternion()) @ self.rest_q[name]
            acc[name] = q @ self.rest_q[name].inverted()
            place(name, q)

        for name in self.order:
            q, loc = out[name]
            pb = self.rig.pose.bones[name]
            pb.rotation_mode = "QUATERNION"
            pb.location = loc
            pb.rotation_quaternion = q
            pb.keyframe_insert("location", frame=frame)
            pb.keyframe_insert("rotation_quaternion", frame=frame)
        return self

    def cycle(self, frames, fn):
        """Sample `fn(t, frame)` over a loop and repeat frame 0 at the end."""
        for i in range(frames):
            fn(i / frames, i)
        fn(0.0, frames)
        return self.end()

    def once(self, frames, fn):
        """Sample `fn(t, frame)` over a one-shot clip, inclusive of both ends."""
        for i in range(frames + 1):
            fn(i / frames, i)
        return self.end()

    # ---------------------------------------------------------------- idle
    def idle(self):
        self.begin("idle", 90)                       # 3 s

        def pose(t, f):
            ph = 2 * math.pi * t
            breathe = math.sin(ph)
            shift = -math.cos(ph)                    # slow weight shift
            states = {}
            for s, sgn in (("L", 1.0), ("R", -1.0)):
                states[s] = (True, Vector((sgn * 0.105, 0.0, ANKLE_Z)), 0.0,
                             D(7.5 - sgn * 2.5 * shift))
            hips_r = (Quaternion((0, 0, 1), D(1.2 * shift))
                      @ Quaternion((0, 1, 0), D(1.6 * shift))
                      @ Quaternion((1, 0, 0), D(1.8)))
            sway = 0.013 * shift
            hz = self.hips_height(hips_r, sway, 0.0, states)

            delta = {
                "hips": hips_r,
                "spine": Quaternion((1, 0, 0), D(-0.8 + 0.8 * breathe)),
                "chest": Quaternion((1, 0, 0), D(0.6 * breathe)),
                "neck": Quaternion((1, 0, 0), D(1.0 - 0.4 * breathe)),
                "head": Quaternion((1, 0, 0), D(-1.6 + 0.5 * breathe)),
            }
            for s, sgn in (("L", 1.0), ("R", -1.0)):
                delta[f"shoulder.{s}"] = Quaternion((0, 0, 1), D(sgn * -2.0))
                delta[f"upper_arm.{s}"] = (Quaternion((0, 1, 0), D(-sgn * 6.0 - sgn * 1.2 * breathe))
                                           @ Quaternion((1, 0, 0), D(-3.0 + 1.2 * breathe)))
                delta[f"forearm.{s}"] = Quaternion((1, 0, 0), D(-11.0 - 2.5 * breathe))
                delta[f"hand.{s}"] = Quaternion((1, 0, 0), D(-4.0))
            world_rot = {f"foot.{s}": self.wrot(f"foot.{s}", rz=-sgn * 7.0)
                         for s, sgn in (("L", 1.0), ("R", -1.0))}
            legs = {s: (states[s][1], states[s][3]) for s in ("L", "R")}
            self.key(f, delta=delta, world_rot=world_rot,
                     pos={"hips": Vector((sway, 0.0, hz))}, legs=legs)

        return self.cycle(90, pose)

    # ------------------------------------------------------- walk and run
    def _gait(self, name, length, g, steps=None):
        self.begin(name, length)
        tau = 2 * math.pi
        duty = g["duty"]

        def pose(t, f):
            u = t
            sway = g["sway"] * math.sin(tau * (u - 0.06))
            yaw = -g["yaw"] * math.cos(tau * u)
            roll = -g["roll"] * math.cos(tau * (u - 0.31))
            lean = g["lean"]
            hips_r = (Quaternion((0, 0, 1), D(yaw))
                      @ Quaternion((0, 1, 0), D(roll))
                      @ Quaternion((1, 0, 0), D(lean)))

            states = self.states_at(g, u)
            if any(st[0] for st in states.values()):
                # every leg counts: planted ones through their knee-flex budget,
                # the one reaching for the ground through the length of the bones
                hz = self.hips_height(hips_r, sway, 0.0, states)
            else:
                u0, u1 = (duty, 0.5) if u < 0.5 else (0.5 + duty, 1.0)
                h0 = self.hips_height(hips_r, sway, 0.0, self.states_at(g, u0 - 1e-4))
                h1 = self.hips_height(hips_r, sway, 0.0, self.states_at(g, u1 + 1e-4))
                s = (u - u0) / (u1 - u0)
                hz = h0 + (h1 - h0) * s + 4.0 * g["rise"] * s * (1.0 - s)
                lim = self.hips_height(hips_r, sway, 0.0, states)
                if lim is not None:
                    hz = min(hz, lim)

            # torso counter-rotates against the pelvis, arms swing against the legs
            delta = {
                "hips": hips_r,
                "spine": (Quaternion((0, 0, 1), D(-0.35 * yaw))
                          @ Quaternion((1, 0, 0), D(-0.30 * lean))),
                "chest": (Quaternion((0, 0, 1), D(-0.45 * yaw))
                          @ Quaternion((1, 0, 0), D(-0.35 * lean + 1.2 * math.cos(2 * tau * u)))),
                "neck": (Quaternion((0, 0, 1), D(-0.25 * yaw))
                         @ Quaternion((1, 0, 0), D(-0.25 * lean))),
                "head": (Quaternion((0, 0, 1), D(0.30 * yaw))
                         @ Quaternion((1, 0, 0), D(-0.20 * lean))),
            }
            for s, sgn in (("L", 1.0), ("R", -1.0)):
                ph = tau * (u + (0.0 if s == "L" else 0.5))
                swing = math.cos(ph)                     # +1 = arm at its rearmost
                fwd = -swing                             # +1 = arm swung forward
                delta[f"shoulder.{s}"] = (Quaternion((0, 0, 1), D(sgn * -3.0))
                                          @ Quaternion((0, 1, 0), D(-sgn * 0.05 * g["arm"] * fwd)))
                delta[f"upper_arm.{s}"] = (Quaternion((0, 1, 0), D(-sgn * (7.0 + 2.0 * fwd)))
                                           @ Quaternion((1, 0, 0),
                                                        D(g["arm_lean"] + g["arm"] * swing)))
                delta[f"forearm.{s}"] = Quaternion(
                    (1, 0, 0), D(-(g["elbow"] + g["elbow_swing"] * max(0.0, fwd))))
                delta[f"hand.{s}"] = Quaternion((1, 0, 0), D(g["hand"]))

            world_rot = {}
            for s, sgn in (("L", 1.0), ("R", -1.0)):
                world_rot[f"foot.{s}"] = self.wrot(
                    f"foot.{s}", rx=math.degrees(states[s][2]), rz=-sgn * g["toe_out"])

            legs = {s: (states[s][1], states[s][3]) for s in ("L", "R")}
            self.key(f, delta=delta, world_rot=world_rot,
                     pos={"hips": Vector((sway, 0.0, hz))}, legs=legs)

        return self.cycle(length, pose)

    def walk(self):
        return self._gait("walk", 30, WALK)          # 1.00 s

    def run(self):
        return self._gait("run", 20, RUN)            # 0.667 s

    # ---------------------------------------------------------------- jump
    def jump(self):
        """One shot: load up, drive off the toes, tuck for the flight."""
        self.begin("jump", 15)                       # 0.5 s
        crouch, launch, tuck = 0.30, 0.55, 0.72

        def pose(t, f):
            if t < launch:                            # grounded: crouch -> drive
                s = smoothstep(0.0, crouch, t)
                drive = smoothstep(crouch, launch, t)
                flex = D(10.0 + 62.0 * s - 67.0 * drive)
                pitch = D(26.0) * drive
                y = -0.02 * s
                ankle = contact_ankle(0.105, y, pitch, "ball" if pitch > 0 else "heel")
                states = {s2: (True, Vector(((1.0 if s2 == "L" else -1.0) * ankle.x,
                                             ankle.y, ankle.z)), pitch, flex)
                          for s2 in ("L", "R")}
                hips_r = Quaternion((1, 0, 0), D(26.0 * s - 32.0 * drive))
                hz = self.hips_height(hips_r, 0.0, 0.0, states)
                lean = 26.0 * s - 34.0 * drive
                arm = 40.0 * s - 170.0 * drive
                elbow = -30.0 * s - 10.0 * drive
                feet = pitch
                # legs keep extending for a few frames after the toes leave
                hips_z = hz
            else:                                     # airborne: tuck the knees up
                s = smoothstep(launch, tuck, t)
                hips_r = Quaternion((1, 0, 0), D(-6.0 + 14.0 * s))
                lean = -6.0 + 16.0 * s
                arm = -168.0 + 46.0 * s
                elbow = -38.0 - 8.0 * s
                feet = D(26.0 - 8.0 * s)
                hips_z = 1.010 + 0.035 * smoothstep(launch, 1.0, t)
                ankle = Vector((0.105, -0.02 - 0.16 * s, 0.159 + 0.261 * s))
                states = {s2: (False, Vector(((1.0 if s2 == "L" else -1.0) * ankle.x,
                                              ankle.y, ankle.z)), feet, None)
                          for s2 in ("L", "R")}

            delta = {
                "hips": hips_r,
                "spine": Quaternion((1, 0, 0), D(0.55 * lean)),
                "chest": Quaternion((1, 0, 0), D(0.45 * lean)),
                "neck": Quaternion((1, 0, 0), D(-0.35 * lean)),
                "head": Quaternion((1, 0, 0), D(-0.45 * lean)),
            }
            for s2, sgn in (("L", 1.0), ("R", -1.0)):
                delta[f"shoulder.{s2}"] = Quaternion((0, 0, 1), D(sgn * -4.0))
                delta[f"upper_arm.{s2}"] = (Quaternion((0, 1, 0), D(-sgn * 12.0))
                                            @ Quaternion((1, 0, 0), D(arm)))
                delta[f"forearm.{s2}"] = Quaternion((1, 0, 0), D(elbow))
                delta[f"hand.{s2}"] = Quaternion((1, 0, 0), D(-8.0))
            world_rot = {f"foot.{s2}": self.wrot(f"foot.{s2}", rx=math.degrees(feet),
                                                 rz=-sgn * 4.0)
                         for s2, sgn in (("L", 1.0), ("R", -1.0))}
            legs = {s2: (states[s2][1], states[s2][3]) for s2 in ("L", "R")}
            self.key(f, delta=delta, world_rot=world_rot,
                     pos={"hips": Vector((0.0, 0.0, hips_z))}, legs=legs)

        return self.once(15, pose)

    # ---------------------------------------------------------------- fall
    def fall(self):
        """Loop: airborne, legs reaching for the ground, arms balancing."""
        self.begin("fall", 24)                       # 0.8 s

        def pose(t, f):
            ph = 2 * math.pi * t
            bob = math.sin(ph)
            hips_r = (Quaternion((0, 0, 1), D(3.0 * math.sin(ph)))
                      @ Quaternion((0, 1, 0), D(4.0 * bob))
                      @ Quaternion((1, 0, 0), D(-7.0)))
            delta = {
                "hips": hips_r,
                "spine": Quaternion((1, 0, 0), D(-6.0)),
                "chest": Quaternion((1, 0, 0), D(-5.0)),
                "neck": Quaternion((1, 0, 0), D(6.0)),
                "head": Quaternion((1, 0, 0), D(8.0),),
            }
            states = {}
            for s, sgn in (("L", 1.0), ("R", -1.0)):
                p = ph + (0.0 if s == "L" else math.pi)
                states[s] = (False,
                             Vector((sgn * 0.120,
                                     0.045 + 0.070 * math.sin(p),
                                     0.190 + 0.050 * math.sin(p))),
                             D(12.0), None)
                swing = math.sin(p)
                delta[f"shoulder.{s}"] = Quaternion((0, 0, 1), D(sgn * -6.0))
                delta[f"upper_arm.{s}"] = (Quaternion((0, 1, 0), D(-sgn * (26.0 + 6.0 * swing)))
                                           @ Quaternion((1, 0, 0), D(-64.0 - 16.0 * swing)))
                delta[f"forearm.{s}"] = Quaternion((1, 0, 0), D(-38.0 - 12.0 * swing))
                delta[f"hand.{s}"] = Quaternion((1, 0, 0), D(-12.0))

            world_rot = {f"foot.{s}": self.wrot(f"foot.{s}", rx=12.0, rz=-sgn * 3.0)
                         for s, sgn in (("L", 1.0), ("R", -1.0))}
            legs = {s: (states[s][1], None) for s in ("L", "R")}
            self.key(f, delta=delta, world_rot=world_rot,
                     pos={"hips": Vector((0.01 * bob, 0.0, 0.930 + 0.012 * bob))},
                     legs=legs)

        return self.cycle(24, pose)

    # ---------------------------------------------------------------- land
    def land(self):
        """One shot: touch down, absorb, stand back up."""
        self.begin("land", 14)                       # 0.467 s
        floor, deep = 0.10, 0.34

        def pose(t, f):
            flex = D(curve([(0.0, 22.0), (floor, 40.0), (deep, 70.0), (1.0, 8.0)], t))
            lean = curve([(0.0, 8.0), (floor, 16.0), (deep, 30.0), (1.0, 3.0)], t)
            hips_r = Quaternion((1, 0, 0), D(lean))
            states = {s: (True, Vector((sgn * 0.115, 0.0, ANKLE_Z)), 0.0, flex)
                      for s, sgn in (("L", 1.0), ("R", -1.0))}
            hz = self.hips_height(hips_r, 0.0, 0.0, states)
            arm = curve([(0.0, 34.0), (floor, 46.0), (deep, 18.0), (1.0, -4.0)], t)
            elbow = curve([(0.0, -34.0), (deep, -26.0), (1.0, -12.0)], t)
            delta = {
                "hips": hips_r,
                "spine": Quaternion((1, 0, 0), D(0.55 * lean)),
                "chest": Quaternion((1, 0, 0), D(0.45 * lean)),
                "neck": Quaternion((1, 0, 0), D(-0.35 * lean)),
                "head": Quaternion((1, 0, 0), D(-0.5 * lean)),
            }
            for s, sgn in (("L", 1.0), ("R", -1.0)):
                delta[f"shoulder.{s}"] = Quaternion((0, 0, 1), D(sgn * -5.0))
                delta[f"upper_arm.{s}"] = (Quaternion((0, 1, 0), D(-sgn * 14.0))
                                           @ Quaternion((1, 0, 0), D(arm)))
                delta[f"forearm.{s}"] = Quaternion((1, 0, 0), D(elbow))
                delta[f"hand.{s}"] = Quaternion((1, 0, 0), D(-8.0))
            world_rot = {f"foot.{s}": self.wrot(f"foot.{s}", rz=-sgn * 5.0)
                         for s, sgn in (("L", 1.0), ("R", -1.0))}
            legs = {s: (states[s][1], states[s][3]) for s in ("L", "R")}
            self.key(f, delta=delta, world_rot=world_rot,
                     pos={"hips": Vector((0.0, 0.0, hz))}, legs=legs)

        return self.once(14, pose)

# --------------------------------------------------------------------------- #
# export
# --------------------------------------------------------------------------- #

def stage_actions(rig, animator):
    """Park every action on its own muted NLA track so the exporter can pull
    each one out as a separate glTF animation."""
    ad = rig.animation_data
    ad.action = None
    for name, action in animator.actions.items():
        track = ad.nla_tracks.new()
        track.name = name
        track.mute = True
        start = int(round(action.frame_range[0]))
        strip = track.strips.new(name, start, action)
        strip.name = name
        strip.frame_start = start
        strip.frame_end = int(round(action.frame_range[1]))


def export(path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format="GLB",
        export_yup=True,
        export_skins=True,
        export_animations=True,
        export_animation_mode="ACTIONS",
        export_def_bones=False,
        export_frame_range=False,
        export_apply=False,
        export_extras=True,
    )
    return os.path.getsize(path)


def main():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.render.fps = FPS
    scene.frame_start = 1
    scene.frame_end = 30

    rig = build_armature()
    bpy.context.view_layer.objects.active = rig

    materials = {
        "suit": make_material("suit", COL_BODY, roughness=0.62),
        "accent": make_material("accent", COL_ACCENT, roughness=0.35, metallic=0.15),
        "light": make_material("light", COL_LIGHT, roughness=0.45),
        "dark": make_material("dark", COL_DARK, roughness=0.15, metallic=0.35),
    }
    mats = (materials["suit"], materials["accent"], materials["light"], materials["dark"])

    parts = build_body(mats)
    meshes = assemble(parts, rig)

    animator = Animator(rig)
    animator.idle()
    animator.walk()
    animator.run()
    animator.jump()
    animator.fall()
    animator.land()

    verts = sum(len(m.data.vertices) for m in meshes)
    print(f"[astra] meshes={len(meshes)} verts={verts} "
          f"bones={len(rig.data.bones)} actions={list(animator.actions)}")
    bad = {c: rows for c, rows in animator.clip_diag.items() if rows}
    if bad:
        print("[astra] WARNING ankle targets outside the reach of the bones:")
        for clip, rows in bad.items():
            worst = max(rows, key=lambda r: r[2])
            print(f"[astra]   {clip}: {len(rows)} frames, worst "
                  f"{worst[2] * 1000:.1f} mm at frame {worst[0]} ({worst[1]})")
    else:
        print("[astra] IK: every planted and swinging ankle target is reachable")
    print(f"[astra] gait: walk {WALK['speed']:.2f} m/s over {WALK['cycle']:.2f} s, "
          f"run {RUN['speed']:.2f} m/s over {RUN['cycle']:.2f} s")

    stage_actions(rig, animator)
    size = export(OUT_PATH)
    print(f"[astra] wrote {OUT_PATH} ({size} bytes)")


if __name__ == "__main__":
    main()
