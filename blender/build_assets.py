#!/usr/bin/env python3
"""Build Lit Miniature nature + bean prototypes in Blender and export GLB."""
import math
import random
import sys
from pathlib import Path

import bpy
import bmesh
from mathutils import Vector, Matrix, noise as mathnoise

OUT = Path(__file__).resolve().parents[1] / "public" / "models"
OUT.mkdir(parents=True, exist_ok=True)


def enable_gltf():
    try:
        bpy.ops.preferences.addon_enable(module="io_scene_gltf2")
    except Exception:
        import addon_utils

        addon_utils.enable("io_scene_gltf2")


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    enable_gltf()
    # factory empty still may have nothing; ensure a scene
    if not bpy.data.scenes:
        bpy.data.scenes.new("Scene")
    scene = bpy.data.scenes[0]
    bpy.context.window.scene = scene if hasattr(bpy.context, "window") and bpy.context.window else scene


def purge():
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    for mesh in list(bpy.data.meshes):
        bpy.data.meshes.remove(mesh)
    for mat in list(bpy.data.materials):
        bpy.data.materials.remove(mat)
    for crv in list(bpy.data.curves):
        bpy.data.curves.remove(crv)


def mat(name, color, rough=0.55, spec=0.4, metallic=0.0, alpha=1.0):
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    bsdf = nt.nodes.get("Principled BSDF")
    if bsdf:
        bsdf.inputs["Base Color"].default_value = (color[0], color[1], color[2], 1.0)
        if "Roughness" in bsdf.inputs:
            bsdf.inputs["Roughness"].default_value = rough
        if "Metallic" in bsdf.inputs:
            bsdf.inputs["Metallic"].default_value = metallic
        if "Alpha" in bsdf.inputs:
            bsdf.inputs["Alpha"].default_value = alpha
        for key in ("Specular IOR Level", "Specular"):
            if key in bsdf.inputs:
                bsdf.inputs[key].default_value = spec
    if alpha < 1.0:
        m.blend_method = "HASHED"
    return m


def assign(obj, material):
    if obj.data and hasattr(obj.data, "materials"):
        obj.data.materials.clear()
        obj.data.materials.append(material)


def select_only(obj):
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj


def apply_all(obj):
    select_only(obj)
    try:
        bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    except Exception:
        pass


def shade_smooth(obj):
    mesh = getattr(obj, "data", None)
    if not mesh or not hasattr(mesh, "polygons"):
        return
    for p in mesh.polygons:
        p.use_smooth = True
    if hasattr(mesh, "use_auto_smooth"):
        mesh.use_auto_smooth = True
        mesh.auto_smooth_angle = math.radians(60)


def smart_uv(obj):
    select_only(obj)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    try:
        bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=0.03)
    except Exception:
        try:
            bpy.ops.uv.unwrap(margin=0.03)
        except Exception:
            pass
    bpy.ops.object.mode_set(mode="OBJECT")


def join(objs, name):
    objs = [o for o in objs if o]
    if not objs:
        return None
    if len(objs) == 1:
        objs[0].name = name
        return objs[0]
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.join()
    objs[0].name = name
    return objs[0]


def empty(name):
    obj = bpy.data.objects.new(name, None)
    bpy.context.scene.collection.objects.link(obj)
    obj.empty_display_size = 0.4
    return obj


def cone(r1, r2, depth, loc, rot=(0, 0, 0), verts=8):
    bpy.ops.mesh.primitive_cone_add(
        vertices=verts,
        radius1=r1,
        radius2=r2,
        depth=depth,
        location=loc,
        rotation=rot,
        end_fill_type="NGON",
    )
    return bpy.context.object


def ico(radius, loc, subdiv=2):
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=subdiv, radius=radius, location=loc)
    return bpy.context.object


def cylinder(r, depth, loc, rot=(0, 0, 0), verts=12):
    bpy.ops.mesh.primitive_cylinder_add(
        vertices=verts, radius=r, depth=depth, location=loc, rotation=rot
    )
    return bpy.context.object


def plane(size, loc, rot=(0, 0, 0)):
    bpy.ops.mesh.primitive_plane_add(size=size, location=loc, rotation=rot)
    return bpy.context.object


def displace_noise(obj, scale=1.4, amount=0.22, flatten=0.55, seed=0):
    mesh = obj.data
    rng = random.Random(seed)
    off = Vector((rng.random() * 20, rng.random() * 20, rng.random() * 20))
    for v in mesh.vertices:
        n = mathnoise.noise(v.co * scale + off)
        v.co += v.normal * n * amount
        v.co.z *= flatten
    mesh.update()


def make_bean():
    root = empty("Bean")
    bpy.ops.mesh.primitive_uv_sphere_add(segments=32, ring_count=24, radius=0.30, location=(0, 0, 0.02))
    body = bpy.context.object
    body.name = "BeanBody"
    body.scale = (0.84, 0.68, 1.12)
    apply_all(body)
    # kidney cleft
    select_only(body)
    bpy.ops.object.mode_set(mode="EDIT")
    bm = bmesh.from_edit_mesh(body.data)
    for v in bm.verts:
        # pinch a groove along +Y side
        if v.co.y > 0.02:
            pinch = max(0.0, 1.0 - abs(v.co.z) * 2.2)
            v.co.y *= 1.0 - 0.22 * pinch
            v.co.x *= 1.0 + 0.06 * pinch
    bmesh.update_edit_mesh(body.data)
    bpy.ops.object.mode_set(mode="OBJECT")
    shade_smooth(body)
    smart_uv(body)
    assign(body, mat("BeanSkin", (0.78, 0.58, 0.32), rough=0.38, spec=0.55))
    body.parent = root

    eye_mat = mat("BeanEye", (0.07, 0.05, 0.04), rough=0.25)
    for i, x in enumerate((-0.09, 0.09)):
        bpy.ops.mesh.primitive_uv_sphere_add(segments=12, ring_count=8, radius=0.034, location=(x, 0.155, 0.12))
        eye = bpy.context.object
        eye.name = f"BeanEye{i}"
        assign(eye, eye_mat)
        shade_smooth(eye)
        eye.parent = root
    return root


def _point_rotation(direction):
    d = Vector(direction).normalized()
    quat = d.to_track_quat("Z", "Y")
    return quat.to_euler()


def make_tree(name, seed, dead=False, height=6.2):
    rng = random.Random(seed)
    root = empty(name)
    h = height * rng.uniform(0.88, 1.12)
    r0 = rng.uniform(0.20, 0.36) * (0.75 if dead else 1.0)
    trunk_parts = []
    trunk = cone(r0, r0 * 0.22, h, (0, 0, h * 0.5), verts=9)
    trunk_parts.append(trunk)
    # roots
    for i in range(rng.randint(3, 5)):
        a = i / 5 * math.tau + rng.uniform(-0.3, 0.3)
        rr = r0 * rng.uniform(0.28, 0.45)
        ln = rng.uniform(0.45, 0.9)
        loc = (math.cos(a) * r0 * 0.45, math.sin(a) * r0 * 0.45, ln * 0.18)
        rot = _point_rotation((math.cos(a), math.sin(a), 0.35))
        trunk_parts.append(cone(rr, rr * 0.15, ln, loc, rot, verts=6))
    n_br = rng.randint(3, 5) if dead else rng.randint(5, 8)
    tips = []
    for i in range(n_br):
        t = rng.uniform(0.38, 0.9)
        br_h = h * t
        a = rng.uniform(0, math.tau)
        tilt = rng.uniform(0.55, 1.15)
        length = h * rng.uniform(0.22, 0.48) * (1.15 - t)
        rad = r0 * rng.uniform(0.10, 0.20)
        direction = Vector((math.cos(a) * tilt, math.sin(a) * tilt, rng.uniform(0.35, 0.9))).normalized()
        loc = Vector((math.cos(a) * r0 * 0.15, math.sin(a) * r0 * 0.15, br_h)) + direction * (length * 0.5)
        rot = _point_rotation(direction)
        br = cone(rad, rad * 0.12, length, loc, rot, verts=6)
        trunk_parts.append(br)
        tip = loc + direction * (length * 0.5)
        tips.append(tip)
        if not dead and rng.random() < 0.55:
            d2 = (direction + Vector((rng.uniform(-0.4, 0.4), rng.uniform(-0.4, 0.4), rng.uniform(0.1, 0.4)))).normalized()
            ln2 = length * rng.uniform(0.4, 0.7)
            loc2 = tip + d2 * (ln2 * 0.5)
            trunk_parts.append(cone(rad * 0.55, rad * 0.08, ln2, loc2, _point_rotation(d2), verts=5))
            tips.append(loc2 + d2 * (ln2 * 0.5))
    trunk_obj = join(trunk_parts, f"{name}_Trunk")
    shade_smooth(trunk_obj)
    smart_uv(trunk_obj)
    bark_col = (0.22, 0.14, 0.09) if not dead else (0.18, 0.14, 0.10)
    assign(trunk_obj, mat(f"{name}_Bark", bark_col, rough=0.82))
    trunk_obj.parent = root

    if not dead:
        canopy_parts = []
        blobs = rng.randint(4, 6)
        for i in range(blobs):
            sz = rng.uniform(1.25, 2.15) * (h / 6.2)
            loc = (
                rng.uniform(-1.15, 1.15),
                rng.uniform(-1.15, 1.15),
                h * rng.uniform(0.58, 0.96),
            )
            s = ico(sz, loc, subdiv=2)
            s.scale = (
                rng.uniform(0.85, 1.15),
                rng.uniform(0.85, 1.15),
                rng.uniform(0.7, 1.0),
            )
            apply_all(s)
            canopy_parts.append(s)
        for tip in tips[:: max(1, len(tips) // 6)]:
            canopy_parts.append(ico(rng.uniform(0.7, 1.2), tip, subdiv=1))
        for i in range(26):
            sz = rng.uniform(0.4, 0.85)
            loc = (
                rng.uniform(-1.7, 1.7),
                rng.uniform(-1.7, 1.7),
                h * rng.uniform(0.52, 1.04),
            )
            rot = (rng.uniform(0, math.tau), rng.uniform(0, math.tau), rng.uniform(0, math.tau))
            canopy_parts.append(plane(sz, loc, rot))
        canopy = join(canopy_parts, f"{name}_Foliage")
        shade_smooth(canopy)
        smart_uv(canopy)
        g = rng.uniform(0.18, 0.32)
        assign(canopy, mat(f"{name}_Leaf", (0.18, 0.38 + g * 0.3, 0.12), rough=0.58))
        canopy.parent = root
    else:
        # a few broken stubs
        for i in range(rng.randint(2, 4)):
            a = rng.uniform(0, math.tau)
            t = rng.uniform(0.45, 0.8)
            ln = h * rng.uniform(0.12, 0.22)
            direction = Vector((math.cos(a), math.sin(a), 0.2)).normalized()
            loc = Vector((0, 0, h * t)) + direction * (ln * 0.5)
            stub = cone(r0 * 0.08, r0 * 0.02, ln, loc, _point_rotation(direction), verts=5)
            assign(stub, mat(f"{name}_Bark", bark_col, rough=0.86))
            stub.parent = root
    return root


def make_rock(name, seed, size=1.0):
    rng = random.Random(seed)
    obj = ico(size * rng.uniform(0.7, 1.15), (0, 0, 0.05), subdiv=3)
    obj.name = name
    obj.scale = (
        rng.uniform(0.8, 1.3),
        rng.uniform(0.7, 1.2),
        rng.uniform(0.35, 0.7),
    )
    apply_all(obj)
    displace_noise(obj, scale=rng.uniform(1.1, 2.2), amount=rng.uniform(0.16, 0.32), flatten=rng.uniform(0.45, 0.7), seed=seed)
    # sit on ground
    minz = min(v.co.z for v in obj.data.vertices)
    for v in obj.data.vertices:
        v.co.z -= minz
    shade_smooth(obj)
    smart_uv(obj)
    c = rng.uniform(0.28, 0.48)
    assign(obj, mat(name + "Mat", (c, c * 0.92, c * 0.82), rough=0.78))
    return obj


def make_log(name, seed=3):
    rng = random.Random(seed)
    parts = []
    L = rng.uniform(2.4, 3.4)
    r = rng.uniform(0.18, 0.28)
    body = cylinder(r, L, (0, 0, r * 0.9), (math.pi / 2, 0, rng.uniform(-0.2, 0.2)), verts=10)
    parts.append(body)
    # end caps already there; add a broken branch
    br = cone(r * 0.35, r * 0.08, 0.7, (L * 0.15, 0.15, r * 1.1), (0.9, 0.2, 0.4), verts=6)
    parts.append(br)
    obj = join(parts, name)
    displace_noise(obj, scale=3.5, amount=0.04, flatten=1.0, seed=seed)
    shade_smooth(obj)
    smart_uv(obj)
    assign(obj, mat("LogBark", (0.25, 0.16, 0.1), rough=0.84))
    return obj


def make_barrel(name, dent=False, seed=1):
    rng = random.Random(seed)
    parts = []
    h = 0.95
    r = 0.36
    body = cylinder(r, h, (0, 0, h * 0.5), verts=16)
    parts.append(body)
    for z in (0.12, 0.48, 0.84):
        hoop = cylinder(r * 1.04, 0.045, (0, 0, z), verts=16)
        parts.append(hoop)
    lid = cylinder(r * 0.98, 0.05, (0, 0, h + 0.01), verts=16)
    parts.append(lid)
    obj = join(parts, name)
    if dent:
        select_only(obj)
        for v in obj.data.vertices:
            if v.co.x > 0.1:
                v.co.x *= 0.86
                v.co.y += 0.04 * math.sin(v.co.z * 8)
        obj.data.update()
    shade_smooth(obj)
    smart_uv(obj)
    assign(obj, mat("BarrelRust", (0.38, 0.2, 0.08), rough=0.62, metallic=0.45))
    if rng.random() > 0.4:
        obj.rotation_euler[0] = rng.uniform(0, 0.15)
    return obj


def make_pipe(name):
    parts = []
    # vertical riser
    parts.append(cylinder(0.16, 1.1, (0, 0, 0.55), verts=12))
    # elbow-ish
    parts.append(cylinder(0.16, 0.7, (0.28, 0, 1.05), (0, math.pi / 2, 0), verts=12))
    # lip
    parts.append(cylinder(0.2, 0.08, (0.62, 0, 1.05), (0, math.pi / 2, 0), verts=12))
    # flange
    parts.append(cylinder(0.28, 0.06, (0, 0, 0.04), verts=12))
    obj = join(parts, name)
    shade_smooth(obj)
    smart_uv(obj)
    assign(obj, mat("PipeMetal", (0.32, 0.28, 0.22), rough=0.48, metallic=0.7))
    return obj


def make_reed(name, seed=4):
    rng = random.Random(seed)
    parts = []
    for i in range(rng.randint(6, 9)):
        h = rng.uniform(0.9, 1.7)
        x = rng.uniform(-0.18, 0.18)
        y = rng.uniform(-0.18, 0.18)
        lean = (rng.uniform(-0.12, 0.12), rng.uniform(-0.12, 0.12), 0)
        stalk = cone(0.018, 0.007, h, (x, y, h * 0.5), lean, verts=5)
        parts.append(stalk)
        head = cone(0.035, 0.01, 0.18, (x + lean[0] * 0.4, y + lean[1] * 0.4, h + 0.05), lean, verts=5)
        parts.append(head)
    obj = join(parts, name)
    smart_uv(obj)
    assign(obj, mat("ReedGreen", (0.3, 0.38, 0.16), rough=0.7))
    return obj


def make_fern(name, seed=8):
    rng = random.Random(seed)
    parts = []
    for i in range(7):
        a = i / 7 * math.tau
        length = rng.uniform(0.55, 0.95)
        rot = (math.radians(55), 0, a)
        fr = plane(0.18, (math.cos(a) * 0.12, math.sin(a) * 0.12, 0.22), rot)
        fr.scale = (1.0, length / 0.18 * 0.55, 1.0)
        apply_all(fr)
        parts.append(fr)
    obj = join(parts, name)
    smart_uv(obj)
    assign(obj, mat("FernGreen", (0.16, 0.42, 0.14), rough=0.62))
    return obj


def make_crate(name):
    bpy.ops.mesh.primitive_cube_add(size=0.7, location=(0, 0, 0.28))
    obj = bpy.context.object
    obj.name = name
    obj.scale[2] = 0.8
    apply_all(obj)
    smart_uv(obj)
    assign(obj, mat("CrateWood", (0.4, 0.26, 0.14), rough=0.8))
    return obj


def layout_and_export():
    # Keep each prototype at origin; three.js clones by name.
    make_bean()
    make_tree("TreeOak1", 11, height=6.4)
    make_tree("TreeOak2", 29, height=7.2)
    make_tree("TreeOak3", 47, height=5.6)
    make_tree("TreeOak4", 83, height=6.8)
    make_tree("TreeDead1", 101, dead=True, height=5.8)
    make_tree("TreeDead2", 124, dead=True, height=4.9)
    make_rock("Rock1", 2, 1.0)
    make_rock("Rock2", 5, 0.7)
    make_rock("Rock3", 8, 1.35)
    make_rock("Rock4", 13, 0.5)
    make_log("Log1", 3)
    make_barrel("Barrel1", dent=False, seed=1)
    make_barrel("Barrel2", dent=True, seed=2)
    make_pipe("Pipe1")
    make_reed("Reed1", 4)
    make_reed("Reed2", 9)
    make_fern("Fern1", 8)
    make_crate("Crate1")

    filepath = str(OUT / "nature.glb")
    bpy.ops.export_scene.gltf(
        filepath=filepath,
        export_format="GLB",
        export_apply=True,
        export_texcoords=True,
        export_normals=True,
        export_materials="EXPORT",
        export_yup=True,
    )
    print("WROTE", filepath, "size", Path(filepath).stat().st_size)


def main():
    enable_gltf()
    purge()
    layout_and_export()


if __name__ == "__main__":
    main()
