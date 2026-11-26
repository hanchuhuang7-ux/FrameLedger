///|
/// A scan-line part's header, with opaque application attributes skipped.
priv struct ExrHeader {
  names : Map[String, Bool]
  fields : Map[String, FixedArray[Byte]]
}

///|
priv suberror ExrProblem {
  BrokenExr(String)
  UnexaminedExr(String)
}

///|
fn ExrHeader::new() -> ExrHeader {
  { names: Map([]), fields: Map([]), }
}

///|
fn ExrHeader::field(
  self : ExrHeader,
  key : String,
) -> FixedArray[Byte] raise ExrProblem {
  match self.fields.get(key) {
    Some(value) => value
    None => raise BrokenExr("EXR 头缺少属性 \{key}。")
  }
}

///|
fn exr_i32(bytes : FixedArray[Byte], at : Int32) -> Int32 {
  bytes[at].to_int() |
  (bytes[at + 1].to_int() << 8) |
  (bytes[at + 2].to_int() << 16) |
  (bytes[at + 3].to_int() << 24)
}

///|
/// Keep non-ASCII identifiers distinct while comparing reserved ASCII names.
fn exr_text(data : FixedArray[Byte], first : Int32, last : Int32) -> String {
  let chars : Array[Char] = []
  for i in first..<last {
    chars.push(data[i].to_char())
  }
  String::from_array(chars[:])
}

///|
fn exr_field_type(name : String) -> (String, Int32)? {
  match name {
    "channels" => Some(("chlist", -1))
    "compression" => Some(("compression", 1))
    "dataWindow" | "displayWindow" => Some(("box2i", 16))
    "lineOrder" => Some(("lineOrder", 1))
    "pixelAspectRatio" | "screenWindowWidth" => Some(("float", 4))
    "screenWindowCenter" => Some(("v2f", 8))
    "type" | "name" => Some(("string", -1))
    "chunkCount" => Some(("int", 4))
    _ => None
  }
}

///|
#derive(Eq)
priv struct ExrWindow {
  x0 : Int32
  y0 : Int32
  x1 : Int32
  y1 : Int32
}

///|
fn exr_window(data : FixedArray[Byte]) -> ExrWindow raise ExrProblem {
  let window = {
    x0: exr_i32(data, 0),
    y0: exr_i32(data, 4),
    x1: exr_i32(data, 8),
    y1: exr_i32(data, 12),
  }
  if window.x0 > window.x1 || window.y0 > window.y1 {
    raise BrokenExr("EXR 图像窗口的边界无效。")
  }
  window
}

///|
fn exr_floor_div(value : Int64, divisor : Int64) -> Int64 {
  if value < 0L {
    (value + 1L) / divisor - 1L
  } else {
    value / divisor
  }
}

///|
/// EXR channel samples occur at multiples of the sampling factor in image coordinates.
fn exr_samples(first : Int64, last : Int64, stride : Int64) -> Int64 {
  exr_floor_div(last, stride) - exr_floor_div(first - 1L, stride)
}

///|
priv struct ExrSampling {
  y_step : Int64
  row_bytes : Int64
}

///|
fn exr_channels(
  data : FixedArray[Byte],
  window : ExrWindow,
  name_limit : Int32,
) -> Array[ExrSampling] raise ExrProblem {
  let names : Map[String, Bool] = Map([])
  let groups : Map[Int64, Int64] = Map([])
  let mut at = 0
  while at < data.length() && data[at] != 0 {
    let begin = at
    while at < data.length() && data[at] != 0 {
      at += 1
    }
    guard at - begin <= name_limit && data.length() - at >= 17 else {
      raise BrokenExr("EXR 通道名称或通道记录不完整。")
    }
    let name = exr_text(data, begin, at)
    if names.contains(name) {
      raise BrokenExr("EXR 通道名重复。")
    }
    names[name] = true
    let sample_bytes : Int64 = match exr_i32(data, at + 1) {
      0 | 2 => 4L
      1 => 2L
      _ => raise BrokenExr("EXR 通道的像素类型无效。")
    }
    let xs = exr_i32(data, at + 9).to_int64()
    let ys = exr_i32(data, at + 13).to_int64()
    guard xs > 0L && ys > 0L else {
      raise BrokenExr("EXR 通道采样间隔无效。")
    }
    let row = exr_samples(window.x0.to_int64(), window.x1.to_int64(), xs) *
      sample_bytes
    groups[ys] = groups.get(ys).unwrap_or(0L) + row
    at += 17
  }
  guard !names.is_empty() && at == data.length() - 1 && data[at] == 0 else {
    raise BrokenExr("EXR 通道列表为空或缺少正确的结束标记。")
  }
  let samples = []
  for ys, row in groups {
    samples.push({ y_step: ys, row_bytes: row, })
  }
  samples
}

///|
priv struct ExrPart {
  name : String
  data : ExrWindow
  display : ExrWindow
  aspect_bits : Int32
  compression : Int32
  block_lines : Int32
  chunks : Int32
  sampling : Array[ExrSampling]
}

///|
fn ExrHeader::part(
  self : ExrHeader,
  multipart : Bool,
  name_limit : Int32,
  width : Int32,
  height : Int32,
) -> ExrPart raise ExrProblem {
  let kind = match self.fields.get("type") {
    Some(raw) => exr_text(raw, 0, raw.length())
    None if !multipart => "scanlineimage"
    None => raise BrokenExr("EXR 分部缺少 type 属性。")
  }
  if kind != "scanlineimage" {
    raise UnexaminedExr("此 EXR 含扫描线以外的分部，需要复核。")
  }
  let name = match self.fields.get("name") {
    Some(raw) => exr_text(raw, 0, raw.length())
    None => ""
  }
  if multipart && name == "" {
    raise BrokenExr("EXR 分部缺少名称。")
  }
  let data = exr_window(self.field("dataWindow"))
  let display = exr_window(self.field("displayWindow"))
  let dw = display.x1.to_int64() - display.x0.to_int64() + 1L
  let dh = display.y1.to_int64() - display.y0.to_int64() + 1L
  if width > 0 && (dw != width.to_int64() || dh != height.to_int64()) {
    raise BrokenExr(
      "EXR 显示尺寸为 \{dw}×\{dh}，计划要求 \{width}×\{height}。",
    )
  }
  let compression = self.field("compression")[0].to_int()
  let block_lines = match compression {
    0 | 1 | 2 => 1
    3 | 5 => 16
    4 | 6 | 7 | 8 | 11 => 32
    9 | 10 => 256
    _ =>
      raise UnexaminedExr(
        "未知 EXR 压缩编号 \{compression}，需要复核。",
      )
  }
  let chunks = (data.y1.to_int64() - data.y0.to_int64()) /
    block_lines.to_int64() +
    1L
  match self.fields.get("chunkCount") {
    Some(raw) if exr_i32(raw, 0).to_int64() != chunks =>
      raise BrokenExr("EXR 声明的区块数与数据窗口不符。")
    None if multipart => raise BrokenExr("EXR 分部缺少 chunkCount。")
    _ => ()
  }
  if chunks > 1_000_000L {
    raise UnexaminedExr("EXR 区块索引超过本地检查上限。")
  }
  if self.field("lineOrder")[0] > 2 {
    raise BrokenExr("EXR 扫描线顺序字段无效。")
  }
  let aspect_bits = exr_i32(self.field("pixelAspectRatio"), 0)
  if aspect_bits <= 0 || (aspect_bits & 0x7f800000) == 0x7f800000 {
    raise BrokenExr("EXR 像素宽高比无效。")
  }
  ignore(self.field("screenWindowCenter"))
  ignore(self.field("screenWindowWidth"))
  let sampling = exr_channels(self.field("channels"), data, name_limit)
  {
    name,
    data,
    display,
    aspect_bits,
    compression,
    block_lines,
    chunks: chunks.to_int(),
    sampling,
  }
}
