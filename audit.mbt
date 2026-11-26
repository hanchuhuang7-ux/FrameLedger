///|
#derive(Eq, ToJson)
pub(all) struct Span {
  first : Int32
  last : Int32
}

///|
#derive(ToJson)
pub(all) struct Report {
  first : Int32
  last : Int32
  step : Int32
  expected : Int32
  ready : Int32
  missing_count : Int32
  empty_count : Int32
  damaged_count : Int32
  missing : Array[Span]
  empty : Array[Span]
  damaged : Array[Span]
  rerender : Array[Span]
}

///|
#export_name("rangeError")
pub fn range_error(first : Int32, last : Int32, step : Int32) -> String {
  if first < -FrameLimit || last > FrameLimit || first > last {
    "首尾帧须在正负十亿内，且起始帧不能大于结束帧。"
  } else if step <= 0 || step > FrameLimit {
    "步长须为 1 至 10 亿之间的整数。"
  } else {
    ""
  }
}

///|
/// Each caller supplies intervals in ascending, non-overlapping order.
fn add_span(
  spans : Array[Span],
  first : Int32,
  last : Int32,
  step : Int32,
) -> Unit {
  if spans.last() is Some(previous) && previous.last + step == first {
    spans[spans.length() - 1] = { first: previous.first, last, }
  } else {
    spans.push({ first, last, })
  }
}

///|
/// The host provides the file status for each observed frame:
/// 0 = ready, 1 = zero bytes, 2 = failed the PNG check.
pub fn audit(
  first : Int32,
  last : Int32,
  step : Int32,
  frames : FixedArray[Int32],
  states : FixedArray[Int32],
) -> Report raise InputError {
  let message = range_error(first, last, step)
  guard message == "" else { raise InvalidInput(message) }
  guard frames.length() == states.length() else {
    raise InvalidInput("每个帧号必须对应一个文件状态。")
  }
  let seen : Map[Int32, Int32] = Map([])
  for i in 0..<frames.length() {
    let frame = frames[i]
    if frame < first || frame > last || (frame - first) % step != 0 {
      continue
    }
    let state = states[i]
    guard state >= 0 && state <= 2 else {
      raise InvalidInput("未知文件状态。")
    }
    if seen.get(frame) is Some(previous) && previous != state {
      raise InvalidInput("同一帧的两条记录状态冲突。")
    }
    seen[frame] = state
  }
  let ordered = seen.keys().to_array()
  ordered.sort()
  let expected = (last - first) / step + 1
  let final_frame = first + (expected - 1) * step
  let missing : Array[Span] = []
  let empty : Array[Span] = []
  let damaged : Array[Span] = []
  let rerender : Array[Span] = []
  let mut empty_count = 0
  let mut damaged_count = 0
  let mut cursor = first
  for frame in ordered {
    if cursor < frame {
      add_span(missing, cursor, frame - step, step)
      add_span(rerender, cursor, frame - step, step)
    }
    match seen[frame] {
      1 => {
        empty_count += 1
        add_span(empty, frame, frame, step)
        add_span(rerender, frame, frame, step)
      }
      2 => {
        damaged_count += 1
        add_span(damaged, frame, frame, step)
        add_span(rerender, frame, frame, step)
      }
      _ => ()
    }
    cursor = frame + step
  }
  if cursor <= final_frame {
    add_span(missing, cursor, final_frame, step)
    add_span(rerender, cursor, final_frame, step)
  }
  {
    first,
    last,
    step,
    expected,
    ready: ordered.length() - empty_count - damaged_count,
    missing_count: expected - ordered.length(),
    empty_count,
    damaged_count,
    missing,
    empty,
    damaged,
    rerender,
  }
}

///|
#export_name("auditFrames")
pub fn audit_frames(
  first : Int32,
  last : Int32,
  step : Int32,
  frames : FixedArray[Int32],
  states : FixedArray[Int32],
) -> String {
  @json.to_json(audit(first, last, step, frames, states)).stringify() catch {
    InvalidInput(message) => {
      let error : Json = { "error": message }
      error.stringify()
    }
  }
}
