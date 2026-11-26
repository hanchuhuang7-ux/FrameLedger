///|
/// Structural validation distinguishes a file fault from an unsupported layout.
#derive(Eq)
pub(all) enum ExrStatus {
  Reading
  Complete
  Malformed(String)
  NeedsReview(String)
}

///|
priv enum ExrStage {
  Version
  AttrName
  AttrType
  AttrLength
  AttrValue
  OffsetEntry
  SeekBlock
  BlockLeader
  BlockData
  AllBlocksRead
}

///|
priv struct ExrOffset {
  pos : Int64
  part : Int32
  index : Int32
}

///|
/// Feed file bytes in order. Pixel payloads are counted without decoding or retaining them.
pub struct ExrProbe {
  priv width : Int32
  priv height : Int32
  priv required : Map[String, String]
  priv mut status : ExrStatus
  priv mut stage : ExrStage
  priv mut pos : Int64
  priv fixed : FixedArray[Byte]
  priv mut used : Int32
  priv token : Array[Byte]
  priv mut multipart : Bool
  priv mut name_limit : Int32
  priv mut header : ExrHeader
  priv mut key : String
  priv mut kind : String
  priv mut value : FixedArray[Byte]
  priv mut remaining : Int32
  priv parts : Array[ExrPart]
  priv names : Map[String, Bool]
  priv offsets : Array[ExrOffset]
  priv mut total : Int32
  priv mut table_part : Int32
  priv mut table_slot : Int32
  priv mut next : Int32
}

///|
pub fn ExrProbe::new(
  width~ : Int32 = 0,
  height~ : Int32 = 0,
  required_channels~ : FixedArray[String] = [],
) -> ExrProbe {
  let required : Map[String, String] = Map([])
  let mut status = Reading
  if !((width == 0 && height == 0) || (width > 0 && height > 0)) {
    status = Malformed("预期宽高必须同时为正整数。")
  } else if required_channels.length() > 4096 {
    status = Malformed("必需通道数超出检查上限。")
  } else {
    for label in required_channels {
      if label.length() == 0 ||
        label.length() > 1024 ||
        label.contains("\u0000") {
        status = Malformed("必需通道名称无效。")
        break
      }
      // Compare UTF-8 input with the same lossless byte keys used for EXR identifiers.
      let bytes = @utf8.encode(label)
      required[String::from_iter(bytes.iter().map(b => b.to_char()))] = label
    }
  }
  {
    width,
    height,
    required,
    status,
    stage: Version,
    pos: 0L,
    fixed: FixedArray::make(12, 0),
    used: 0,
    token: [],
    multipart: false,
    name_limit: 31,
    header: ExrHeader::new(),
    key: "",
    kind: "",
    value: [],
    remaining: 0,
    parts: [],
    names: Map([]),
    offsets: [],
    total: 0,
    table_part: 0,
    table_slot: 0,
    next: 0,
  }
}

///|
/// Fill a short fixed-size field across arbitrary input boundaries.
fn ExrProbe::take_fixed(
  self : ExrProbe,
  data : Bytes,
  at : Int32,
  length : Int32,
) -> Int32 {
  let count = (length - self.used).min(data.length() - at)
  for i in 0..<count {
    self.fixed[self.used + i] = data[at + i]
  }
  self.used += count
  self.pos += count.to_int64()
  count
}

///|
fn ExrProbe::version(self : ExrProbe) -> Unit raise ExrProblem {
  if exr_i32(self.fixed, 0) != 20000630 {
    raise BrokenExr("EXR 文件签名错误。")
  }
  let bits = exr_i32(self.fixed, 4)
  if (bits & 255) != 2 || (bits & 0x1eff) != bits {
    raise UnexaminedExr(
      "EXR 版本或布局标志尚未支持，需要复核。",
    )
  }
  if (bits & 0x200) != 0 && (bits & 0x1800) != 0 {
    raise BrokenExr("EXR 布局标志相互冲突。")
  }
  if (bits & 0x800) != 0 {
    raise UnexaminedExr("深度 EXR 需要支持深度采样的工具复核。")
  }
  if (bits & 0x200) != 0 {
    raise UnexaminedExr("分块（tiled）EXR 需要复核。")
  }
  self.multipart = (bits & 0x1000) != 0
  self.name_limit = if (bits & 0x400) != 0 { 255 } else { 31 }
  self.used = 0
  self.stage = AttrName
}

///|
fn ExrProbe::start_offsets(self : ExrProbe) -> Unit raise ExrProblem {
  if !self.required.is_empty() {
    let missing = self.required.values().to_array()
    missing.sort()
    raise BrokenExr(
      "EXR 缺少约定通道 \{missing[0]}（共缺 \{missing.length()} 项）。",
    )
  }
  self.stage = OffsetEntry
}

///|
fn ExrProbe::end_header(self : ExrProbe) -> Unit raise ExrProblem {
  if self.header.names.is_empty() {
    guard self.multipart && !self.parts.is_empty() else {
      raise BrokenExr("EXR 头为空。")
    }
    self.start_offsets()
    return
  }
  if self.parts.length() >= 256 {
    raise UnexaminedExr("EXR 分部超过本地检查上限。")
  }
  let part = self.header.part(
    self.multipart,
    self.name_limit,
    self.width,
    self.height,
    self.required,
  )
  if self.multipart {
    if self.names.contains(part.name) {
      raise BrokenExr("EXR 分部名称重复。")
    }
    self.names[part.name] = true
    if !self.parts.is_empty() {
      let previous = self.parts[0]
      if previous.display != part.display ||
        previous.aspect_bits != part.aspect_bits {
        raise BrokenExr(
          "EXR 分部的共享显示窗口或像素宽高比不一致。",
        )
      }
    }
  }
  self.total += part.chunks
  if self.total > 1_000_000 {
    raise UnexaminedExr("EXR 区块索引超过本地检查上限。")
  }
  self.parts.push(part)
  self.header = ExrHeader::new()
  if self.multipart {
    self.stage = AttrName
  } else {
    self.start_offsets()
  }
}

///|
fn ExrProbe::name_byte(
  self : ExrProbe,
  byte : Byte,
  is_key : Bool,
) -> Unit raise ExrProblem {
  if byte != 0 {
    if self.token.length() >= self.name_limit {
      raise BrokenExr("EXR 属性名称或类型超长。")
    }
    self.token.push(byte)
    return
  }
  if self.token.is_empty() {
    if !is_key {
      raise BrokenExr("EXR 属性类型为空。")
    }
    self.end_header()
    return
  }
  let word = String::from_iter(self.token.iter().map(b => b.to_char()))
  self.token.clear()
  if is_key {
    if self.header.names.contains(word) {
      raise BrokenExr("EXR 头的属性重复。")
    }
    if self.header.names.length() >= 4096 {
      raise UnexaminedExr("EXR 属性数超过本地检查上限。")
    }
    self.header.names[word] = true
    self.key = word
    self.stage = AttrType
  } else {
    self.kind = word
    self.stage = AttrLength
    self.used = 0
  }
}

///|
fn ExrProbe::value_length(self : ExrProbe) -> Unit raise ExrProblem {
  let size = exr_i32(self.fixed, 0)
  if size < 0 {
    raise BrokenExr("EXR 属性长度为负数。")
  }
  if self.pos + size.to_int64() > 16_777_216L {
    raise UnexaminedExr("EXR 头超过 16 MiB 检查上限。")
  }
  match exr_field_type(self.key) {
    Some((kind, length)) => {
      if self.kind != kind || (length >= 0 && size != length) {
        raise BrokenExr("EXR 属性 \{self.key} 的类型或长度不符。")
      }
      if size > 1_048_576 {
        raise UnexaminedExr(
          "单个 EXR 结构属性超过 1 MiB，需要复核。",
        )
      }
      self.value = FixedArray::make(size, 0)
      self.header.fields[self.key] = self.value
    }
    None => self.value = []
  }
  self.used = 0
  self.remaining = size
  self.stage = if size == 0 { AttrName } else { AttrValue }
}

///|
fn ExrProbe::offset_entry(self : ExrProbe) -> Unit raise ExrProblem {
  let low = exr_i32(self.fixed, 0).reinterpret_as_uint().to_int64()
  let high = exr_i32(self.fixed, 4)
  let offset = (high.to_int64() << 32) | low
  guard offset > 0L else {
    raise BrokenExr("EXR 索引包含未写入或无效的区块偏移。")
  }
  self.offsets.push({
    pos: offset,
    part: self.table_part,
    index: self.table_slot,
  })
  self.table_slot += 1
  if self.table_slot == self.parts[self.table_part].chunks {
    self.table_part += 1
    self.table_slot = 0
  }
  self.used = 0
  if self.offsets.length() == self.total {
    self.offsets.sort_by((a, b) => a.pos.compare(b.pos))
    if self.offsets[0].pos < self.pos {
      raise BrokenExr("EXR 区块偏移指向文件头或偏移表。")
    }
    self.stage = SeekBlock
  }
}

///|
fn ExrProbe::block_leader(self : ExrProbe) -> Unit raise ExrProblem {
  let slot = self.offsets[self.next]
  let part = self.parts[slot.part]
  let at = if self.multipart { 4 } else { 0 }
  if self.multipart && exr_i32(self.fixed, 0) != slot.part {
    raise BrokenExr("EXR 区块的分部编号与偏移表不符。")
  }
  let y = exr_i32(self.fixed, at).to_int64()
  if y !=
    part.data.y0.to_int64() +
    slot.index.to_int64() * part.block_lines.to_int64() {
    raise BrokenExr("EXR 扫描线坐标与偏移表不符。")
  }
  let packed = exr_i32(self.fixed, at + 4)
  if packed < 0 {
    raise BrokenExr("EXR 区块长度无效。")
  }
  if part.compression == 0 || packed == 0 {
    let end_y = (y + part.block_lines.to_int64() - 1L).min(
      part.data.y1.to_int64(),
    )
    let mut raw = 0L
    for group in part.sampling {
      raw += exr_samples(y, end_y, group.y_step) * group.row_bytes
    }
    if (raw > 0L && packed == 0) ||
      (part.compression == 0 && raw != packed.to_int64()) {
      raise BrokenExr("EXR 区块长度与通道采样不符。")
    }
  }
  self.next += 1
  if self.next < self.total &&
    self.pos + packed.to_int64() > self.offsets[self.next].pos {
    raise BrokenExr("EXR 区块相互重叠或索引重复。")
  }
  self.used = 0
  self.remaining = packed
  self.stage = BlockData
  if packed == 0 {
    self.stage = if self.next == self.total { AllBlocksRead } else { SeekBlock }
  }
}

///|
fn ExrProbe::consume(self : ExrProbe, data : Bytes) -> Unit raise ExrProblem {
  let mut at = 0
  while at < data.length() {
    match self.stage {
      Version => {
        at += self.take_fixed(data, at, 8)
        if self.used == 8 {
          self.version()
        }
      }
      AttrName | AttrType => {
        if self.pos >= 16_777_216L {
          raise UnexaminedExr("EXR 头超过 16 MiB 检查上限。")
        }
        let is_key = self.stage is AttrName
        self.pos += 1L
        self.name_byte(data[at], is_key)
        at += 1
      }
      AttrLength => {
        at += self.take_fixed(data, at, 4)
        if self.used == 4 {
          self.value_length()
        }
      }
      AttrValue => {
        let count = self.remaining.min(data.length() - at)
        if self.value.length() > 0 {
          for i in 0..<count {
            self.value[self.used + i] = data[at + i]
          }
        }
        self.used += count
        at += count
        self.pos += count.to_int64()
        self.remaining -= count
        if self.remaining == 0 {
          self.used = 0
          self.stage = AttrName
        }
      }
      OffsetEntry => {
        at += self.take_fixed(data, at, 8)
        if self.used == 8 {
          self.offset_entry()
        }
      }
      SeekBlock => {
        let gap = self.offsets[self.next].pos - self.pos
        guard gap >= 0L else {
          raise BrokenExr("EXR 区块偏移相互重叠。")
        }
        if gap == 0L {
          self.stage = BlockLeader
          continue
        }
        let count = gap.min((data.length() - at).to_int64()).to_int()
        at += count
        self.pos += count.to_int64()
      }
      BlockLeader => {
        let length = if self.multipart { 12 } else { 8 }
        at += self.take_fixed(data, at, length)
        if self.used == length {
          self.block_leader()
        }
      }
      BlockData => {
        let count = self.remaining.min(data.length() - at)
        self.remaining -= count
        self.pos += count.to_int64()
        at += count
        if self.remaining == 0 {
          self.stage = if self.next == self.total {
            AllBlocksRead
          } else {
            SeekBlock
          }
        }
      }
      AllBlocksRead => return
    }
  }
}

///|
/// Call with eof=true on the final block. A terminal verdict is sticky.
pub fn ExrProbe::feed(
  self : ExrProbe,
  data : Bytes,
  eof~ : Bool = false,
) -> ExrStatus {
  if self.status != Reading {
    return self.status
  }
  try {
    self.consume(data)
    if eof {
      self.status = if self.stage is AllBlocksRead {
        Complete
      } else {
        Malformed(
          "EXR 在文件头、偏移表或像素区块读完前结束，文件可能被截断。",
        )
      }
    }
  } catch {
    BrokenExr(message) => self.status = Malformed(message)
    UnexaminedExr(message) => self.status = NeedsReview(message)
  }
  self.status
}

///|
/// JS bridge: empty while reading or on success, a tagged diagnostic on failure.
#export_name("newExrProbe")
pub fn new_exr_probe(width : Int32, height : Int32) -> (Bytes, Bool) -> String {
  new_exr_probe_for_channels(width, height, [])
}

///|
#export_name("newExrProbeForChannels")
pub fn new_exr_probe_for_channels(
  width : Int32,
  height : Int32,
  required_channels : FixedArray[String],
) -> (Bytes, Bool) -> String {
  let probe = ExrProbe::new(width~, height~, required_channels~)
  fn(data, eof) {
    let result : Json = match probe.feed(data, eof~) {
      Reading | Complete => return ""
      Malformed(reason) => { "state": 2, "reason": reason }
      NeedsReview(reason) => { "state": 3, "reason": reason }
    }
    result.stringify()
  }
}
