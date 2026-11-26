"""A deterministic moving-cube shot for interruption and pixel comparisons."""

from array import array
import hashlib
import json
from pathlib import Path
import sys
import time

import bpy


def make_scene(root):
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = 1
    scene.cycles.use_denoising = False
    scene.render.resolution_x, scene.render.resolution_y = 128, 96
    scene.render.resolution_percentage = 75
    scene.render.image_settings.file_format = "PNG"
    scene.render.filepath = "//original/sh010_v2_###_beauty"
    scene.frame_start, scene.frame_end, scene.frame_step = 1001, 1061, 2
    cube = bpy.data.objects["Cube"]
    cube.keyframe_insert(data_path="rotation_euler", frame=1001)
    cube.rotation_euler.z = 1.4
    cube.keyframe_insert(data_path="rotation_euler", frame=1061)
    bpy.ops.wm.save_as_mainfile(filepath=str(root / "shot.blend"), relative_remap=False)


def stop_after_checkpoint(scene, *_):
    if scene.frame_current == 1017:
        print("FRAMELEDGER_CHECKPOINT 1017", flush=True)
        # The parent terminates only this test process at a deterministic file boundary.
        time.sleep(20)


def pixel_digest(path):
    image = bpy.data.images.load(str(path), check_existing=False)
    try:
        pixels = array("f", [0]) * len(image.pixels)
        image.pixels.foreach_get(pixels)
        return tuple(image.size), hashlib.sha256(pixels.tobytes()).hexdigest()
    finally:
        bpy.data.images.remove(image)


def compare(root):
    reference = sorted((root / "reference").glob("*.png"))
    mismatches, fingerprints = [], set()
    for file in reference:
        actual = root / "original" / file.name
        if not actual.is_file():
            actual = root / "repaired" / file.name
        expected = pixel_digest(file)
        fingerprints.add(expected)
        if pixel_digest(actual) != expected:
            mismatches.append(file.name)
    print("FRAMELEDGER_PIXELS", json.dumps({"frames": len(reference), "different_images": len(fingerprints),
          "mismatches": mismatches, "blender": bpy.app.version_string}))


mode, target = sys.argv[sys.argv.index("--") + 1:]
root = Path(target).resolve()
if mode == "create":
    make_scene(root)
elif mode == "interrupt":
    bpy.app.handlers.render_write.append(stop_after_checkpoint)
    bpy.ops.render.render(animation=True)
elif mode == "compare":
    compare(root)
else:
    raise ValueError("Unknown test mode.")
