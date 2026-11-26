from pathlib import Path
import sys

import bpy

output = Path(sys.argv[sys.argv.index("--") + 1]).resolve()
output.mkdir(parents=True, exist_ok=True)
scene = bpy.context.scene
scene.render.engine = "CYCLES"
scene.cycles.device = "CPU"
scene.cycles.samples = 1
scene.cycles.use_denoising = False
scene.render.resolution_x = 64
scene.render.resolution_y = 48
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = "PNG"
scene.render.filepath = str(output / "shot_####")
cube = bpy.data.objects["Cube"]
cube.rotation_euler.z = 0.0
cube.keyframe_insert(data_path="rotation_euler", frame=1)
cube.rotation_euler.z = 1.3
cube.keyframe_insert(data_path="rotation_euler", frame=8)
scene.frame_start, scene.frame_end = 1, 8
bpy.ops.render.render(animation=True)
print("FRAMELEDGER_FIXTURE", bpy.app.version_string, len(list(output.glob("*.png"))))
