"""Render the ranges in a verified FrameLedger report into a separate directory."""

import argparse
from contextlib import contextmanager
import json
import os
from pathlib import Path
import sys
import tempfile

import bpy

sys.path.insert(0, str(Path(__file__).resolve().parent))
from shot_settings import describe, file_hash


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
    if report.get("format") != "frameledger.report.v1" or not job.get("origin") or report.get("origin") != job["origin"]:
        raise ValueError("The report must come from settings exported from this saved Blender scene.")
    for key in ("pattern", "first", "last", "step"):
        if report.get(key) != job[key]:
            raise ValueError("Shot setting differs: " + key)
    if any(report.get("expected_" + k) != job.get(k) for k in ("width", "height")):
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
    if report.get("expected") != expected or report.get("ready") != expected - fault_count:
        raise ValueError("Invalid totals in report.")
    merged = []
    for lo, hi in sorted(faults):
        if merged and lo <= merged[-1][1]:
            raise ValueError("Frame categories overlap.")
        if merged and lo == merged[-1][1] + step:
            merged[-1] = (merged[-1][0], hi)
        else:
            merged.append((lo, hi))
    if merged != checked_spans(report.get("rerender"), first, last, step):
        raise ValueError("Rerender ranges disagree with the audit.")
    return merged, fault_count


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


def write_state(path, state, scratch):
    pending = scratch / "state.json"
    pending.write_text(json.dumps(state, ensure_ascii=False, sort_keys=True) + "\n", encoding="utf-8")
    os.replace(pending, path)


def render_plan(scene, job, spans, stage):
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
            if read_json(state_path).get("job") != job:
                raise ValueError("This staging directory belongs to a different shot.")
        else:
            if any(p.name != ".frameledger.lock" for p in stage.iterdir()):
                raise ValueError("Use an empty directory or a previous FrameLedger staging directory for this shot.")
        settings = scene.render
        old_path, old_ext, old_frame = settings.filepath, settings.use_file_extension, scene.frame_current
        with tempfile.TemporaryDirectory(dir=stage, prefix=".frameledger-work-") as temp:
            scratch = Path(temp)
            if not state_path.exists():
                write_state(state_path, {"job": job}, scratch)
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
                            retained += 1
                            continue
                        pending = scratch / name
                        settings.filepath, settings.use_file_extension = str(pending), False
                        result = bpy.ops.render.render(write_still=True, scene=scene.name)
                        if "FINISHED" not in result or not pending.is_file() or pending.stat().st_size == 0:
                            raise RuntimeError("Blender failed at frame " + str(frame))
                        pending_digest = scratch / "frame.sha256"
                        pending_digest.write_text(file_hash(pending) + "\n", encoding="ascii")
                        os.replace(pending_digest, receipt)
                        os.replace(pending, target)
                        rendered += 1
            finally:
                settings.filepath, settings.use_file_extension = old_path, old_ext
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
    ranges, count = repair_ranges(read_json(args.report), job)
    made, retained = (0, 0)
    if count and not args.dry_run:
        made, retained = render_plan(scene, job, ranges, Path(args.stage).resolve())
    print("FRAMELEDGER_REPAIR", json.dumps({"planned": count, "rendered": made, "retained": retained, "ranges": ranges}))
