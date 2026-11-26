"""Render two real camera positions, then create an interrupted delivery copy."""

from array import array
import hashlib
import json
from pathlib import Path
import shutil
import sys
import bpy

def generate(root):
    root.mkdir(parents=True, exist_ok=False)
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = 1
    scene.cycles.use_denoising = False
    scene.render.image_settings.file_format = "PNG"
    scene.render.resolution_x, scene.render.resolution_y = 80, 54
    scene.render.resolution_percentage = 100
    scene.frame_start, scene.frame_end = 1, 8
    cube = bpy.data.objects["Cube"]
    cube.keyframe_insert(data_path="rotation_euler", frame=1)
    cube.rotation_euler.z = 1.3
    cube.keyframe_insert(data_path="rotation_euler", frame=8)
    camera = scene.camera
    centre = camera.location.copy()
    axis = camera.matrix_world.to_3x3().col[0].normalized()
    for eye, distance in (("left", -0.12), ("right", 0.12)):
        camera.location = centre + distance * axis
        reference = root / "reference" / eye
        scene.frame_set(1)
        scene.render.filepath = "//reference/" + eye + "/eye_####"
        bpy.ops.wm.save_as_mainfile(filepath=str(root / (eye + ".blend")), relative_remap=False)
        bpy.ops.render.render(animation=True)
        demo = root / "interrupted" / eye
        demo.mkdir(parents=True)
        for frame in range(1, 9):
            name = f"eye_{frame:04d}.png"
            if (eye, frame) in (("left", 3), ("right", 7)):
                continue
            if frame == 5:
                data = (reference / name).read_bytes()
                (demo / name).write_bytes(b"" if eye == "left" else data[:-12])
            else:
                shutil.copyfile(reference / name, demo / name)

def pixels(path):
    image = bpy.data.images.load(str(path), check_existing=False)
    try:
        values = array("f", [0]) * len(image.pixels)
        image.pixels.foreach_get(values)
        return tuple(image.size), hashlib.sha256(values.tobytes()).hexdigest()
    finally:
        bpy.data.images.remove(image)


def compare(root):
    matched, distinct = 0, 0
    for frame in range(1, 9):
        name = f"eye_{frame:04d}.png"
        refs = []
        for eye in ("left", "right"):
            reference = pixels(root / "reference" / eye / name)
            refs.append(reference)
            chosen = root / "repairs" / eye / name
            if not chosen.is_file():
                chosen = root / "interrupted" / eye / name
            if pixels(chosen) != reference:
                raise RuntimeError(f"Pixel mismatch in {eye}/{name}")
            matched += 1
        distinct += refs[0] != refs[1]
    print("STEREO_PIXELS", json.dumps({"matched": matched, "distinct_pairs": distinct, "blender": bpy.app.version_string}))


mode, location = sys.argv[sys.argv.index("--") + 1:]
root = Path(location).resolve()
if mode == "create":
    generate(root)
elif mode == "compare":
    compare(root)
else:
    raise ValueError("Unknown stereo fixture mode")
