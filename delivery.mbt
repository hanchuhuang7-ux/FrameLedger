///|
/// Frame spans for one required output of a shot. All outputs share a frame grid.
#derive(FromJson)
pub(all) struct OutputRanges {
  rerender : Array[Span]
  unverified : Array[Span]
}

///|
/// Unverified covers every frame with an unresolved output. Review-only is
/// the subset without a confirmed fault in another required output.
#derive(ToJson)
pub(all) struct DeliverySummary {
  first : Int32
  last : Int32
  step : Int32
  expected : Int32
  ready : Int32
  rerender_count : Int32
  unverified_count : Int32
  review_only_count : Int32
  rerender : Array[Span]
  unverified : Array[Span]
  review_only : Array[Span]
}

///|
fn delivery_event(
  events : Map[Int32, (Int32, Int32)],
  at : Int32,
  fault : Int32,
  review : Int32,
) -> Unit {
  let (a, b) = events.get(at).unwrap_or((0, 0))
  events[at] = (a + fault, b + review)
}

///|
fn collect_output_spans(
  events : Map[Int32, (Int32, Int32)],
  ranges : Array[Span],
  first : Int32,
  last : Int32,
  step : Int32,
  fault : Int32,
  review : Int32,
) -> Unit raise InputError {
  let mut previous = first - step
  for span in ranges {
    guard span.first >= first &&
      span.last <= last &&
      span.first <= span.last &&
      span.first > previous &&
      (span.first - first) % step == 0 &&
      (span.last - first) % step == 0 else {
      raise InvalidInput(
        "交付报告的帧段无序、重叠或超出计划。",
      )
    }
    delivery_event(events, span.first, fault, review)
    delivery_event(events, span.last + step, -fault, -review)
    previous = span.last
  }
}

///|
/// Combine sparse ranges by their boundaries, including jobs with very long missing tails.
pub fn combine_delivery(
  first : Int32,
  last : Int32,
  step : Int32,
  outputs : Array[OutputRanges],
) -> DeliverySummary raise InputError {
  let error = range_error(first, last, step)
  if error != "" {
    raise InvalidInput(error)
  }
  if outputs.is_empty() {
    raise InvalidInput("交付清单至少需要一组输出。")
  }
  let events : Map[Int32, (Int32, Int32)] = Map([])
  for output in outputs {
    collect_output_spans(events, output.rerender, first, last, step, 1, 0)
    collect_output_spans(events, output.unverified, first, last, step, 0, 1)
    let mut i = 0
    for uncertain in output.unverified {
      while i < output.rerender.length() &&
            output.rerender[i].last < uncertain.first {
        i += 1
      }
      if i < output.rerender.length() &&
        output.rerender[i].first <= uncertain.last {
        raise InvalidInput(
          "同一输出内的补渲染帧和待复核帧相互重叠。",
        )
      }
    }
  }
  let boundaries = events.keys().to_array()
  boundaries.sort()
  let rerender : Array[Span] = []
  let unverified : Array[Span] = []
  let review_only : Array[Span] = []
  let mut faults = 0
  let mut pending = 0
  let mut cursor = first
  let mut rerender_count = 0
  let mut unverified_count = 0
  let mut review_only_count = 0
  for at in boundaries {
    if at > cursor {
      let count = ((at.to_int64() - cursor.to_int64()) / step.to_int64()).to_int()
      if faults > 0 {
        add_span(rerender, cursor, at - step, step)
        rerender_count += count
      }
      if pending > 0 {
        add_span(unverified, cursor, at - step, step)
        unverified_count += count
        if faults == 0 {
          add_span(review_only, cursor, at - step, step)
          review_only_count += count
        }
      }
    }
    let (df, dr) = events[at]
    faults += df
    pending += dr
    cursor = at
  }
  let expected = (last - first) / step + 1
  {
    first,
    last,
    step,
    expected,
    ready: expected - rerender_count - review_only_count,
    rerender_count,
    unverified_count,
    review_only_count,
    rerender,
    unverified,
    review_only,
  }
}

///|
#export_name("combineDelivery")
pub fn combine_delivery_json(
  first : Int32,
  last : Int32,
  step : Int32,
  ranges : String,
) -> String {
  try {
    let outputs : Array[OutputRanges] = @json.from_json(@json.parse(ranges))
    @json.to_json(combine_delivery(first, last, step, outputs)).stringify()
  } catch {
    InvalidInput(message) => {
      let error : Json = { "error": message }
      error.stringify()
    }
    _ => {
      let error : Json = { "error": "各输出的帧段格式无效。" }
      error.stringify()
    }
  }
}
