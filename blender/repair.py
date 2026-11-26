"""Render the ranges in a verified FrameLedger report into a separate directory."""

import argparse
from contextlib import contextmanager
import json
import os
from pathlib import Path
import sys
from uuid import uuid4

import bpy

sys.path.insert(0, str(Path(__file__).resolve().parent))
from shot_settings import describe, exr_channels, file_hash


def read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8-sig"))


def checked_spans(values, first, last, step):
    if not isinstance(values, list):
        raise ValueError("Missing frame ranges in report.")
    previous = first - step
    spans = []
    for value in values:
        lo, hi = value["first"], value["last"]
        if (type(lo) is not int or type(hi) is not int or not first <= lo <= hi <= last
                or lo <= previous or (lo - first) % step or (hi - first) % step):
            raise ValueError("Invalid or overlapping frame ranges.")
        spans.append((lo, hi))
        previous = hi
    return spans


def repair_ranges(report, job):
    version = report.get("format")
    if version not in ("frameledger.report.v1", "frameledger.report.v2") or not job.get("origin") or report.get("origin") != job["origin"]:
        raise ValueError("The report must come from settings exported from this saved Blender scene.")
    for key in ("pattern", "first", "last", "step"):
        if report.get(key) != job[key]:
            raise ValueError("Shot setting differs: " + key)
    dims = tuple(report.get("expected_" + k) for k in ("width", "height"))
    # v0.2 EXR job files carried the scene fingerprint but omitted dimensions.
    old_exr_job = job["pattern"].lower().endswith(".exr") and dims == (None, None)
    if not old_exr_job and dims != (job.get("width"), job.get("height")):
        raise ValueError("Report dimensions differ from the exported shot.")
    first, last, step = job["first"], job["last"], job["step"]
    expected = (last - first) // step + 1
    faults, fault_count = [], 0
    for kind in ("missing", "empty", "damaged"):
        spans = checked_spans(report.get(kind), first, last, step)
        count = sum((hi - lo) // step + 1 for lo, hi in spans)
        if count != report.get(kind + "_count"):
            raise ValueError("Inconsistent frame count: " + kind)
        faults.extend(spans)
        fault_count += count
    review = checked_spans(report.get("unverified", []), first, last, step)
    review_count = sum((hi - lo) // step + 1 for lo, hi in review)
    if (review_count != report.get("unverified_count", 0) or
            (version == "frameledger.report.v1" and review_count)):
        raise ValueError("Invalid unverified-frame count or report version.")
    if version == "frameledger.report.v2" and not all(key in report for key in ("unverified", "unverified_count")):
        raise ValueError("The v2 report must include its unverified ranges.")
    all_ranges = sorted(faults + review)
    if any(right[0] <= left[1] for left, right in zip(all_ranges, all_ranges[1:])):
        raise ValueError("Frame categories overlap.")
    if report.get("expected") != expected or report.get("ready") != expected - fault_count - review_count:
        raise ValueError("Invalid totals in report.")
    merged = []
    for lo, hi in sorted(faults):
        if merged and lo == merged[-1][1] + step:
            merged[-1] = (merged[-1][0], hi)
        else:
            merged.append((lo, hi))
    if merged != checked_spans(report.get("rerender"), first, last, step):
        raise ValueError("Rerender ranges disagree with the audit.")
    return merged, fault_count


def same_staged_job(saved, current):
    if saved == current:
        return True
    if (isinstance(saved, dict) and current["pattern"].lower().endswith(".exr") and
            "width" not in saved and "height" not in saved):
        return saved == {key: value for key, value in current.items() if key not in ("width", "height")}
    return False


def channel_contract(report, job):
    names = report.get("required_exr_channels", [])
    if (not isinstance(names, list) or len(names) > 4096 or
            any(not isinstance(n, str) or not n or "\0" in n or len(n) > 1024 for n in names)):
        raise ValueError("Invalid EXR channel contract.")
    if names and (report.get("format") != "frameledger.report.v2" or not job["pattern"].lower().endswith(".exr")):
        raise ValueError("EXR channel contracts require a v2 report for an EXR shot.")
    return set(names)


def verify_channels(path, required):
    if required:
        missing = required - exr_channels(path)
        if missing:
            raise ValueError("Rendered EXR lacks required channel " + sorted(missing)[0])


def file_output_nodes(tree, visited):
    if not tree or tree.as_pointer() in visited:
        return False
    visited.add(tree.as_pointer())
    return any(not node.mute and (node.bl_idname == "CompositorNodeOutputFile" or
               file_output_nodes(getattr(node, "node_tree", None), visited)) for node in tree.nodes)


@contextmanager
def stage_lock(directory):
    lock = directory / ".frameledger.lock"
    if lock.is_symlink():
        raise ValueError("Invalid staging lock.")
    with lock.open("a+b") as handle:
        if os.name == "nt":
            import msvcrt
            if not handle.tell():
                handle.write(b"\0")
                handle.flush()
            handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield


@contextmanager
def pending_sibling(target):
    # A new file in the destination inherits that directory's access rules,
    # including when Blender runs as a different account from the reviewer.
    pending = target.parent / (".frameledger-" + uuid4().hex + target.suffix)
    with pending.open("xb"):
        pass
    try:
        yield pending
    finally:
        pending.unlink(missing_ok=True)


def write_atomic_text(target, value):
    with pending_sibling(target) as pending:
        pending.write_text(value, encoding="utf-8")
        os.replace(pending, target)


def render_plan(scene, job, spans, stage, required_channels=()):
    original_dir = Path(scene.render.frame_path(frame=job["first"])).resolve().parent
    if stage == original_dir:
        raise ValueError("Choose a staging directory separate from the primary render directory.")
    tree = scene.compositing_node_group if hasattr(scene, "compositing_node_group") else getattr(scene, "node_tree", None)
    if scene.render.use_compositing and file_output_nodes(tree, set()):
        raise ValueError("Active compositor File Output nodes can write outside staging. This helper supports the main output only.")
    stage.mkdir(parents=True, exist_ok=True)
    state_path = stage / ".frameledger-state.json"
    receipts = stage / ".frameledger-receipts"
    rendered, retained = 0, 0
    with stage_lock(stage):
        if state_path.is_symlink() or receipts.is_symlink():
            raise ValueError("Invalid staging metadata.")
        if state_path.exists():
            if not same_staged_job(read_json(state_path).get("job"), job):
                raise ValueError("This staging directory belongs to a different shot.")
        else:
            if any(p.name != ".frameledger.lock" for p in stage.iterdir()):
                raise ValueError("Use an empty directory or a previous FrameLedger staging directory for this shot.")
        settings = scene.render
        old_path, old_ext, old_frame = settings.filepath, settings.use_file_extension, scene.frame_current
        old_overwrite = settings.use_overwrite
        if not state_path.exists():
            write_atomic_text(state_path, json.dumps({"job": job}, ensure_ascii=False, sort_keys=True) + "\n")
        receipts.mkdir(exist_ok=True)
        try:
            for lo, hi in spans:
                for frame in range(lo, hi + 1, job["step"]):
                    scene.frame_set(frame)
                    settings.filepath, settings.use_file_extension = old_path, old_ext
                    name = Path(settings.frame_path(frame=frame)).name
                    target = stage / name
                    receipt = receipts / (str(frame) + ".sha256")
                    if target.is_symlink() or receipt.is_symlink():
                        raise ValueError("Cannot use linked staging frame " + name)
                    if target.exists():
                        if not receipt.is_file() or receipt.read_text(encoding="ascii").strip() != file_hash(target):
                            raise ValueError("Unrecognized or changed staging frame " + name)
                        verify_channels(target, required_channels)
                        retained += 1
                        continue
                    with pending_sibling(target) as pending:
                        settings.filepath, settings.use_file_extension = str(pending), False
                        settings.use_overwrite = True
                        result = bpy.ops.render.render(write_still=True, scene=scene.name)
                        if "FINISHED" not in result or not pending.is_file() or pending.stat().st_size == 0:
                            raise RuntimeError("Blender failed at frame " + str(frame))
                        verify_channels(pending, required_channels)
                        write_atomic_text(receipt, file_hash(pending) + "\n")
                        os.replace(pending, target)
                        rendered += 1
        finally:
            settings.filepath, settings.use_file_extension = old_path, old_ext
            settings.use_overwrite = old_overwrite
            scene.frame_set(old_frame)
    return rendered, retained


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("report")
    parser.add_argument("stage", help="separate directory for completed repair images")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else [])
    scene = bpy.context.scene
    job = describe(scene)
    report = read_json(args.report)
    ranges, count = repair_ranges(report, job)
    required_channels = channel_contract(report, job)
    made, retained = (0, 0)
    if count and not args.dry_run:
        made, retained = render_plan(scene, job, ranges, Path(args.stage).resolve(), required_channels)
    print("FRAMELEDGER_REPAIR", json.dumps({"planned": count, "rendered": made, "retained": retained,
          "unverified": report.get("unverified_count", 0), "ranges": ranges}))
