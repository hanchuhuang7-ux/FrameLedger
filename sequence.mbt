///|
const FrameLimit : Int32 = 1_000_000_000

///|
pub suberror InputError {
  InvalidInput(String)
}

///|
pub struct FramePattern {
  prefix : String
  suffix : String
  width : Int32
}

///|
/// Accept one run of # marks anywhere in a single filename.
pub fn FramePattern::parse(raw : String) -> FramePattern raise InputError {
  let mut first = -1
  let mut width = 0
  for i in 0..<raw.length() {
    match raw[i].to_int() {
      47 | 92 =>
        raise InvalidInput("模板只填文件名，目录请单独选择。")
      35 => {
        if first < 0 {
          first = i
        } else if i != first + width {
          raise InvalidInput("模板只能有一组连续的 #。")
        }
        width += 1
      }
      _ => ()
    }
  }
  guard width >= 1 && width <= 10 else {
    raise InvalidInput(
      "请用 1 至 10 个连续的 # 标记帧号，例如 shot_####.png。",
    )
  }
  {
    prefix: raw[:first].to_owned(),
    suffix: raw[first + width:].to_owned(),
    width,
  }
}

///|
/// Match canonical padding, preserving everything before and after the frame.
pub fn FramePattern::frame(self : FramePattern, name : String) -> Int32? {
  guard name.has_prefix(self.prefix) && name.has_suffix(self.suffix) else {
    return None
  }
  let start = self.prefix.length()
  let end = name.length() - self.suffix.length()
  guard start < end else { return None }
  let negative = name[start].to_int() == 45
  let digits = if negative { start + 1 } else { start }
  let count = end - digits
  guard count >= self.width && count <= 10 else { return None }
  if count > self.width && name[digits].to_int() == 48 {
    return None
  }
  let mut number = 0
  for i in digits..<end {
    let digit = name[i].to_int() - 48
    guard digit >= 0 && digit <= 9 && number <= (FrameLimit - digit) / 10 else {
      return None
    }
    number = number * 10 + digit
  }
  if negative {
    if number == 0 {
      None
    } else {
      Some(-number)
    }
  } else {
    Some(number)
  }
}

///|
#export_name("patternError")
pub fn pattern_error(raw : String) -> String {
  try {
    ignore(FramePattern::parse(raw))
    ""
  } catch {
    InvalidInput(message) => message
  }
}

///|
/// The unmatched sentinel lies outside every supported frame range.
#export_name("makeMatcher")
pub fn make_matcher(raw : String) -> (String) -> Int32 {
  try {
    let value = FramePattern::parse(raw)
    fn(name) { value.frame(name).unwrap_or(FrameLimit + 1) }
  } catch {
    _ => fn(_) { FrameLimit + 1 }
  }
}
