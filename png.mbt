///|
priv enum Phase {
  Signature
  Header
  Payload
  Checksum
  Done
}

///|
priv struct PngReader {
  ihdr : FixedArray[Byte]
  expected_width : Int32
  expected_height : Int32
  mut phase : Phase
  mut position : Int32
  mut length : Int32
  mut kind : UInt32
  mut crc : UInt32
  mut stored_crc : UInt32
  mut seen_header : Bool
  mut seen_data : Bool
  mut nonempty_data : Bool
  mut data_ended : Bool
  mut error : String
}

///|
fn png_dimension(header : FixedArray[Byte], at : Int32) -> Int32 {
  (header[at].to_int() << 24) |
  (header[at + 1].to_int() << 16) |
  (header[at + 2].to_int() << 8) |
  header[at + 3].to_int()
}

///|
fn PngReader::check_ihdr(self : PngReader) -> String {
  let width = png_dimension(self.ihdr, 0)
  let height = png_dimension(self.ihdr, 4)
  guard width > 0 && height > 0 else {
    return "PNG 尺寸不符合 IHDR 规范。"
  }
  let depth = self.ihdr[8].to_int()
  let valid_depth = match self.ihdr[9].to_int() {
    0 => depth == 1 || depth == 2 || depth == 4 || depth == 8 || depth == 16
    3 => depth == 1 || depth == 2 || depth == 4 || depth == 8
    2 | 4 | 6 => depth == 8 || depth == 16
    _ => false
  }
  guard valid_depth else { return "PNG 的色型与位深组合无效。" }
  guard self.ihdr[10] == 0 && self.ihdr[11] == 0 && self.ihdr[12] <= 1 else {
    return "PNG 的压缩、过滤或隔行参数无效。"
  }
  if self.expected_width > 0 &&
    (width != self.expected_width || height != self.expected_height) {
    return "像素尺寸为 \{width}×\{height}，计划要求 \{self.expected_width}×\{self.expected_height}。"
  }
  ""
}

///|
let signature : Bytes = b"\x89PNG\r\n\x1a\n"

///|
let crc_table : FixedArray[UInt32] = FixedArray::makei(256, fn(index) {
  let mut bits = index.reinterpret_as_uint()
  for _ in 0..<8 {
    bits = if (bits & 1U) == 0U { bits >> 1 } else { (bits >> 1) ^ 0xedb88320U }
  }
  bits
})

///|
fn update_crc(current : UInt32, byte : Byte) -> UInt32 {
  (current >> 8) ^
  crc_table[((current ^ byte.to_uint()) & 255U).reinterpret_as_int()]
}

///|
const Ihdr : UInt32 = 0x49484452U

///|
const Idat : UInt32 = 0x49444154U

///|
const Iend : UInt32 = 0x49454e44U

///|
fn PngReader::start_chunk(self : PngReader) -> Unit {
  if !self.seen_header && self.kind != Ihdr {
    self.error = "PNG 的首块不是 IHDR。"
  } else if self.kind == Ihdr {
    if self.seen_header || self.length != 13 {
      self.error = "PNG 的 IHDR 重复或长度错误。"
    }
    self.seen_header = true
  } else if self.kind == Idat {
    if self.data_ended {
      self.error = "PNG 的 IDAT 块不连续。"
    }
    self.seen_data = true
    if self.length > 0 {
      self.nonempty_data = true
    }
  } else {
    if self.seen_data {
      self.data_ended = true
    }
    if self.kind == Iend && (self.length != 0 || !self.nonempty_data) {
      self.error = "PNG 的 IEND 长度错误或缺少图像数据。"
    }
  }
  self.position = 0
  self.stored_crc = 0U
  self.phase = if self.length == 0 { Checksum } else { Payload }
}

///|
fn PngReader::header_byte(self : PngReader, byte : Byte) -> Unit {
  let value = byte.to_uint()
  if self.position < 4 {
    if self.position == 0 && value > 127U {
      self.error = "PNG 块长度超出规范允许的范围。"
      return
    }
    self.length = (self.length << 8) | byte.to_int()
  } else {
    if !((value >= 65U && value <= 90U) || (value >= 97U && value <= 122U)) {
      self.error = "PNG 块类型包含非法字符。"
      return
    }
    self.kind = (self.kind << 8) | value
    self.crc = update_crc(self.crc, byte)
  }
  self.position += 1
  if self.position == 8 {
    self.start_chunk()
  }
}

///|
/// Consume as many payload bytes as possible per pass to avoid a phase
/// dispatch for every pixel-data byte in a large render.
fn PngReader::feed(self : PngReader, input : Bytes, eof : Bool) -> String {
  let mut offset = 0
  while offset < input.length() && self.error == "" {
    let byte = input[offset]
    match self.phase {
      Signature => {
        if byte != signature[self.position] {
          self.error = "PNG 签名错误。"
        }
        self.position += 1
        if self.position == 8 {
          self.phase = Header
          self.position = 0
        }
      }
      Header => self.header_byte(byte)
      Payload => {
        let count = (self.length - self.position).min(input.length() - offset)
        let end = offset + count
        if self.kind == Ihdr {
          for i in 0..<count {
            self.ihdr[self.position + i] = input[offset + i]
          }
        }
        let mut crc = self.crc
        for i in offset..<end {
          crc = update_crc(crc, input[i])
        }
        self.crc = crc
        self.position += count
        if self.position == self.length {
          self.phase = Checksum
          self.position = 0
        }
        offset = end
        continue
      }
      Checksum => {
        self.stored_crc = (self.stored_crc << 8) | byte.to_uint()
        self.position += 1
        if self.position == 4 {
          if self.stored_crc != (self.crc ^ 0xffffffffU) {
            self.error = "PNG 块 CRC 校验失败。"
          } else if self.kind == Ihdr {
            self.error = self.check_ihdr()
          }
          self.phase = if self.kind == Iend { Done } else { Header }
          self.position = 0
          self.length = 0
          self.kind = 0U
          self.crc = 0xffffffffU
        }
      }
      Done => self.error = "PNG 在 IEND 之后还有额外数据。"
    }
    offset += 1
  }
  if eof && self.error == "" {
    match self.phase {
      Done => ()
      _ =>
        self.error = "PNG 在完整 IEND 前结束，文件可能被截断。"
    }
  }
  self.error
}

///|
/// Feed arbitrary-sized blocks and mark EOF with final=true.
/// The empty string means no structural or CRC error has been found.
#export_name("newPngProbe")
pub fn new_png_probe() -> (Bytes, Bool) -> String {
  new_png_probe_for_size(0, 0)
}

///|
/// Width and height select the render's output contract. A 0×0 contract
/// performs PNG structural checks at any legal size.
#export_name("newPngProbeForSize")
pub fn new_png_probe_for_size(
  width : Int32,
  height : Int32,
) -> (Bytes, Bool) -> String {
  let reader : PngReader = {
    ihdr: FixedArray::make(13, 0),
    expected_width: width,
    expected_height: height,
    phase: Signature,
    position: 0,
    length: 0,
    kind: 0U,
    crc: 0xffffffffU,
    stored_crc: 0U,
    seen_header: false,
    seen_data: false,
    nonempty_data: false,
    data_ended: false,
    error: if (width == 0 && height == 0) || (width > 0 && height > 0) {
      ""
    } else {
      "预期宽高必须同时为正整数。"
    },
  }
  fn(input, eof) { reader.feed(input, eof) }
}
