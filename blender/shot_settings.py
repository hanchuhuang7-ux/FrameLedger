"""Export the active Blender scene's main image sequence as a FrameLedger job."""

import argparse
import hashlib
import json
from pathlib import Path
import re
import sys

import bpy


def pattern_from_scene(scene):
    render = scene.render
    if render.is_movie_format or render.use_multiview:
        raise ValueError("Export a single-view still image sequence for this job.")
    raw = render.filepath.replace("\\", "/").rsplit("/", 1)[-1]
    markers = re.findall(r"#+", raw)
    if len(markers) > 1:
        raise ValueError("The output must use one frame-number field.")
    width = len(markers[0]) if markers else 4
    if not 1 <= width <= 10:
        raise ValueError("Frame-number padding must be between 1 and 10 digits.")
    samples = {n: Path(render.frame_path(frame=n)) for n in (1, 12, 12345)}
    if len({path.parent for path in samples.values()}) != 1:
        raise ValueError("A job must render its frames into one directory.")
    name = samples[1].name
    token = f"{1:0{width}d}"
    for offset in range(len(name)):
        if not name.startswith(token, offset):
            continue
        prefix, suffix = name[:offset], name[offset + len(token):]
        if all(path.name == prefix + f"{n:0{width}d}" + suffix for n, path in samples.items()):
            return prefix + "#" * width + suffix
    raise ValueError("The evaluated Blender filenames have no consistent frame field.")


def file_hash(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def exr_channels(path):
    """Read the channel names of a trusted reference frame; no pixel decode needed."""
    import OpenEXR
    names = set()
    with OpenEXR.File(str(path), header_only=True) as image:
        for part in image.parts:
            label = part.header.get("name", "")
            prefix = label + "." if label else ""
            for channel in part.header["channels"]:
                name = channel.name
                names.add(name if not prefix or name.startswith(prefix) else prefix + name)
    if not names:
        raise ValueError("No EXR channels were found in " + str(path))
    return names


def describe(scene):
    render = scene.render
    pattern = pattern_from_scene(scene)
    job = {"format": "frameledger.job.v1", "pattern": pattern, "first": scene.frame_start,
           "last": scene.frame_end, "step": scene.frame_step}
    if pattern.lower().endswith((".png", ".exr")) and not (render.use_border and render.use_crop_to_border):
        job["width"] = max(1, render.resolution_x * render.resolution_percentage // 100)
        job["height"] = max(1, render.resolution_y * render.resolution_percentage // 100)
    if bpy.data.filepath:
        job["origin"] = {"scene": scene.name, "blend_sha256": file_hash(bpy.data.filepath)}
    return job


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("output", help="destination .json")
    parser.add_argument("--reference-exr", help="use all named channels in a known-good reference frame")
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else [])
    target = Path(args.output)
    if target.suffix.lower() != ".json":
        parser.error("The settings file must end in .json.")
    job = describe(bpy.context.scene)
    if args.reference_exr:
        if not job["pattern"].lower().endswith(".exr"):
            parser.error("A reference EXR needs an EXR output sequence.")
        job["required_exr_channels"] = sorted(exr_channels(args.reference_exr))
    target.write_text(json.dumps(job, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("FrameLedger job:", target, job["pattern"], job["first"], job["last"], job["step"])
