"""Generate independently readable OpenEXR samples using Blender and the EXR layout."""

import json
from pathlib import Path
import shutil
import sys

import bpy
import numpy as np
import OpenEXR


def decode(path):
    with OpenEXR.File(str(path), separate_channels=True) as image:
        for part in image.parts:
            if not part.channels or any(ch.pixels.shape != (37, 43) for ch in part.channels.values()):
                raise RuntimeError("Invalid reference decode for " + path.name)
        lo, hi = image.parts[0].header["displayWindow"]
        return {"dimensions": [int(hi[0] - lo[0] + 1), int(hi[1] - lo[1] + 1)], "parts": len(image.parts),
                "channels": sum(len(part.channels) for part in image.parts)}


def generate(root):
    generated, demo = root / "generated", root / "demo"
    generated.mkdir(parents=True)
    demo.mkdir()
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.samples = 1
    scene.cycles.use_denoising = False
    scene.render.resolution_x, scene.render.resolution_y = 43, 37
    scene.render.resolution_percentage = 100
    scene.view_layers[0].use_pass_z = True
    scene.view_layers[0].use_pass_normal = True
    settings = scene.render.image_settings
    codecs = [item.identifier for item in settings.bl_rna.properties["exr_codec"].enum_items]
    cases = [("flat", codec, "32" if codec in ("NONE", "PXR24") else "16") for codec in codecs]
    cases.extend([("flat", "ZIP", "32"), ("interleaved", "ZIP", "16"), ("multipart", "ZIP", "32")])
    manifest = []
    for layout, codec, depth in cases:
        settings.media_type = "IMAGE" if layout == "flat" else "MULTI_LAYER_IMAGE"
        settings.file_format = "OPEN_EXR" if layout == "flat" else "OPEN_EXR_MULTILAYER"
        settings.use_exr_interleave = layout == "interleaved"
        settings.exr_codec = "ZIP"
        settings.color_depth = depth
        settings.exr_codec = codec
        path = generated / f"{layout}-{codec}-{depth}.exr"
        scene.render.filepath = str(path)
        bpy.ops.render.render(write_still=True)
        manifest.append({"name": path.name, "layout": layout, "codec": codec, "depth": depth, **decode(path)})
    tile = generated / "tiled.exr"
    tile_desc = OpenEXR.TileDescription()
    tile_desc.xSize, tile_desc.ySize = 16, 16
    with OpenEXR.File({"type": OpenEXR.tiledimage, "tiles": tile_desc}, {"Y": np.ones((37, 43), dtype=np.float16)}) as image:
        image.write(str(tile))
    deep = generated / "deep.exr"
    samples = np.full((37, 43), None, dtype=object)
    samples[0, 0] = np.array([0.25, 0.75], dtype=np.float32)
    with OpenEXR.File({"type": OpenEXR.deepscanline, "compression": OpenEXR.ZIPS_COMPRESSION}, {"Z": samples}) as image:
        image.write(str(deep))
    for layout, path in (("tiled", tile), ("deep", deep)):
        manifest.append({"name": path.name, "layout": layout, **decode(path)})
    cropped = generated / "cropped-decreasing.exr"
    def box(x0, y0, x1, y1):
        return np.array([x0, y0], dtype=np.int32), np.array([x1, y1], dtype=np.int32)
    header = {"dataWindow": box(-11, 20, 31, 56), "displayWindow": box(-22, -9, 78, 69),
              "lineOrder": OpenEXR.DECREASING_Y, "compression": OpenEXR.ZIP_COMPRESSION}
    with OpenEXR.File(header, {"Z": np.arange(43 * 37, dtype=np.float32).reshape(37, 43)}) as image:
        image.write(str(cropped))
    manifest.append({"name": cropped.name, "layout": "offset-window", **decode(cropped)})
    shutil.copyfile(generated / "flat-ZIP-16.exr", demo / "shot_0001.exr")
    multilayer = generated / "multipart-ZIP-32.exr"
    shutil.copyfile(multilayer, demo / "shot_0002.exr")
    (demo / "shot_0003.exr").write_bytes(multilayer.read_bytes()[:-17])
    shutil.copyfile(tile, demo / "shot_0004.exr")
    (root / "corpus.json").write_text(json.dumps({"blender": bpy.app.version_string, "openexr": OpenEXR.__version__, "cases": manifest}, indent=2), encoding="utf-8")
    print("FRAMELEDGER_EXR_CASES", len(manifest), root)


generate(Path(sys.argv[sys.argv.index("--") + 1]).resolve())
