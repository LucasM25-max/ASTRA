"""
Render still frames of the character so the poses can be eyeballed.

    python tools/render_preview.py                 # PNGs + contact sheet in /tmp/astra_preview

Cycles on the CPU is used deliberately: the sandbox has no GPU. This is a
development aid, not part of the runtime app.
"""

from __future__ import annotations

import os
import subprocess
import sys

import bpy
from mathutils import Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_character as bc  # noqa: E402

OUT_DIR = os.environ.get("ASTRA_PREVIEW_DIR", "/tmp/astra_preview")

# (label, action, frame)
FRAMES = [
    ("1 idle", "idle", 0),
    ("2 walk heel strike", "walk", 15),
    ("3 walk mid stance", "walk", 24),
    ("4 walk toe off", "walk", 3),
    ("5 walk swing", "walk", 9),
    ("6 run contact", "run", 0),
    ("7 run mid stance", "run", 3),
    ("8 run flight", "run", 9),
    ("9 run swing", "run", 14),
    ("10 jump crouch", "jump", 4),
    ("11 jump drive", "jump", 8),
    ("12 jump tuck", "jump", 13),
    ("13 fall", "fall", 6),
    ("14 land contact", "land", 1),
    ("15 land absorb", "land", 5),
]


def add_camera():
    cam_data = bpy.data.cameras.new("cam")
    cam_data.lens = 62
    cam = bpy.data.objects.new("cam", cam_data)
    bpy.context.collection.objects.link(cam)
    cam.location = Vector((-2.45, -2.9, 1.35))
    direction = Vector((0, 0, 0.95)) - cam.location
    cam.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
    bpy.context.scene.camera = cam


def add_lighting():
    sun = bpy.data.lights.new("sun", "SUN")
    sun.angle = 0.6
    sun.energy = 3.2
    sun_obj = bpy.data.objects.new("sun", sun)
    bpy.context.collection.objects.link(sun_obj)
    sun_obj.location = (3.0, -4.0, 6.0)
    sun_obj.rotation_euler = (0.9, 0.2, 0.6)

    fill = bpy.data.lights.new("fill", "AREA")
    fill.energy = 400
    fill.size = 6
    fill_obj = bpy.data.objects.new("fill", fill)
    bpy.context.collection.objects.link(fill_obj)
    fill_obj.location = (-3.0, -3.0, 2.5)
    fill_obj.rotation_euler = (1.2, 0.0, -0.7)

    world = bpy.data.worlds.new("world")
    world.use_nodes = True
    bg = world.node_tree.nodes.get("Background")
    bg.inputs[0].default_value = (0.55, 0.60, 0.66, 1.0)
    bg.inputs[1].default_value = 1.0
    bpy.context.scene.world = world


def add_ground():
    bpy.ops.mesh.primitive_plane_add(size=40, location=(0, 0, 0))
    plane = bpy.context.active_object
    plane.name = "preview_ground"
    mat = bpy.data.materials.new("ground")
    mat.use_nodes = True
    mat.node_tree.nodes.get("Principled BSDF").inputs["Base Color"].default_value = (
        0.32, 0.34, 0.36, 1.0)
    mat.node_tree.nodes.get("Principled BSDF").inputs["Roughness"].default_value = 0.9
    plane.data.materials.append(mat)


def set_pose(rig, action_name, frame):
    action = bpy.data.actions[action_name]
    ad = rig.animation_data
    for track in ad.nla_tracks:
        track.mute = True
    ad.action = action
    slot = getattr(ad, "action_slot", None)
    if slot is None and action.slots:
        ad.action_slot = action.slots[0]
    bpy.context.scene.frame_set(frame)
    bpy.context.view_layer.update()


def main():
    bc.main()  # builds the character (and re-exports the .glb)

    rig = bpy.data.objects["Astra"]
    scene = bpy.context.scene
    add_camera()
    add_lighting()
    add_ground()

    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = 48
    scene.cycles.use_denoising = True
    scene.render.resolution_x = 420
    scene.render.resolution_y = 420
    scene.render.film_transparent = False
    scene.render.image_settings.file_format = "PNG"

    os.makedirs(OUT_DIR, exist_ok=True)
    written = []
    for label, action_name, frame in FRAMES:
        set_pose(rig, action_name, frame)
        path = os.path.join(OUT_DIR, f"{label}.png")
        scene.render.filepath = path
        bpy.ops.render.render(write_still=True)
        written.append(path)
        print(f"[preview] {label}: {action_name} frame {frame} -> {path}")

    sheet = os.path.join(OUT_DIR, "contact_sheet.png")
    subprocess.run(["montage", *written, "-tile", "5x3", "-geometry", "+3+3", "-label", "%f",
                    "-background", "#20242a", sheet], check=True)
    print(f"[preview] contact sheet -> {sheet}")


if __name__ == "__main__":
    main()
