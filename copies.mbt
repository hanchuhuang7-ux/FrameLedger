///|
#derive(ToJson)
pub(all) struct CopyAudit {
  report : Report
  selected : Array[Int32]
}

///|
/// Lower source numbers take precedence between equally usable copies.
/// A readable copy restores a frame even when the primary file is damaged.
pub fn audit_copies(
  first : Int32,
  last : Int32,
  step : Int32,
  frames : FixedArray[Int32],
  states : FixedArray[Int32],
  sources : FixedArray[Int32],
) -> CopyAudit raise InputError {
  let scan = AuditSession::new(first, last, step~)
  guard frames.length() == states.length() &&
    frames.length() == sources.length() else {
    raise InvalidInput("每个候选帧必须带有文件状态和来源。")
  }
  let best : Map[Int32, Int32] = Map([])
  let copies : Map[(Int32, Int32), Int32] = Map([])
  // Keep a damaged diagnostic in preference to an empty file when no copy is ready.
  let ranks : FixedArray[Int32] = [0, 2, 1]
  for i in 0..<frames.length() {
    let frame = frames[i]
    if !scan.includes(frame) {
      continue
    }
    let state = states[i]
    let source = sources[i]
    guard state >= 0 && state <= 2 && source >= 0 else {
      raise InvalidInput("无效的候选帧记录。")
    }
    let key = (frame, source)
    if copies.get(key) is Some(previous_state) && state != previous_state {
      raise InvalidInput("同一目录内的相同帧号存在冲突。")
    }
    copies[key] = state
    if best.get(frame) is Some(prior) {
      let rank = ranks[state]
      let prior_rank = ranks[states[prior]]
      if rank > prior_rank || (rank == prior_rank && source >= sources[prior]) {
        continue
      }
    }
    best[frame] = i
  }
  let selected = best.values().to_array()
  selected.sort()
  for i in selected {
    let state = match states[i] {
      0 => Ready
      1 => Empty
      _ => Damaged
    }
    scan.observe(frames[i], state)
  }
  { report: scan.report(), selected, }
}

///|
#export_name("auditCopies")
pub fn audit_copies_json(
  first : Int32,
  last : Int32,
  step : Int32,
  frames : FixedArray[Int32],
  states : FixedArray[Int32],
  sources : FixedArray[Int32],
) -> String {
  @json.to_json(audit_copies(first, last, step, frames, states, sources)).stringify() catch {
    InvalidInput(message) => {
      let failure : Json = { "error": message }
      failure.stringify()
    }
  }
}
