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
  unverified_count : Int32
  missing : Array[Span]
  empty : Array[Span]
  damaged : Array[Span]
  unverified : Array[Span]
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
/// Result of inspecting a single frame file.
#derive(Eq)
pub(all) enum FrameState {
  Ready
  Empty
  Damaged
  NeedsReview
}

///|
pub struct AuditSession {
  priv first : Int32
  priv last : Int32
  priv step : Int32
  priv seen : Map[Int32, FrameState]
}

///|
/// Start a sparse audit. The range is inclusive; its first frame anchors the step.
pub fn AuditSession::new(
  first : Int32,
  last : Int32,
  step~ : Int32 = 1,
) -> AuditSession raise InputError {
  let message = range_error(first, last, step)
  guard message == "" else { raise InvalidInput(message) }
  { first, last, step, seen: Map([]), }
}

///|
pub fn AuditSession::includes(self : AuditSession, frame : Int32) -> Bool {
  frame >= self.first &&
  frame <= self.last &&
  (frame - self.first) % self.step == 0
}

///|
/// Add an observation in any order. Conflicting observations require the
/// caller to resolve which file to trust before recording it.
pub fn AuditSession::observe(
  self : AuditSession,
  frame : Int32,
  state : FrameState,
) -> Unit raise InputError {
  if !self.includes(frame) {
    return
  }
  if self.seen.get(frame) is Some(previous) && previous != state {
    raise InvalidInput("同一帧的两条记录状态冲突。")
  }
  self.seen[frame] = state
}

///|
/// Obtain an independent snapshot; more observations can be added later.
pub fn AuditSession::report(self : AuditSession) -> Report {
  let { first, last, step, seen, } = self
  let ordered = seen.keys().to_array()
  ordered.sort()
  let expected = (last - first) / step + 1
  let final_frame = first + (expected - 1) * step
  let missing : Array[Span] = []
  let empty : Array[Span] = []
  let damaged : Array[Span] = []
  let unverified : Array[Span] = []
  let rerender : Array[Span] = []
  let mut empty_count = 0
  let mut damaged_count = 0
  let mut unverified_count = 0
  let mut cursor = first
  for frame in ordered {
    if cursor < frame {
      add_span(missing, cursor, frame - step, step)
      add_span(rerender, cursor, frame - step, step)
    }
    match seen[frame] {
      Empty => {
        empty_count += 1
        add_span(empty, frame, frame, step)
        add_span(rerender, frame, frame, step)
      }
      Damaged => {
        damaged_count += 1
        add_span(damaged, frame, frame, step)
        add_span(rerender, frame, frame, step)
      }
      NeedsReview => {
        unverified_count += 1
        add_span(unverified, frame, frame, step)
      }
      Ready => ()
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
    ready: ordered.length() - empty_count - damaged_count - unverified_count,
    missing_count: expected - ordered.length(),
    empty_count,
    damaged_count,
    unverified_count,
    missing,
    empty,
    damaged,
    unverified,
    rerender,
  }
}

///|
/// Batch adapter retained for hosts using parallel frame and status arrays.
pub fn audit(
  first : Int32,
  last : Int32,
  step : Int32,
  frames : FixedArray[Int32],
  states : FixedArray[Int32],
) -> Report raise InputError {
  let session = AuditSession::new(first, last, step~)
  guard frames.length() == states.length() else {
    raise InvalidInput("每个帧号必须对应一个文件状态。")
  }
  for i in 0..<frames.length() {
    if !session.includes(frames[i]) {
      continue
    }
    let state = match states[i] {
      0 => Ready
      1 => Empty
      2 => Damaged
      3 => NeedsReview
      _ => raise InvalidInput("未知文件状态。")
    }
    session.observe(frames[i], state)
  }
  session.report()
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
