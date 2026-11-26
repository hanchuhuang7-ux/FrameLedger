///|
test "pattern preserves unicode prefixes and suffixes and the requested padding" {
  let pattern = FramePattern::parse("镜头2_###_左.png")
  assert_true(pattern.frame("镜头2_007_左.png") == Some(7))
  assert_true(pattern.frame("镜头2_-007_左.png") == Some(-7))
  assert_true(pattern.frame("镜头2_1000_左.png") == Some(1000))
  for
    name in [
      "镜头2_07_左.png", "镜头2_0007_左.png", "镜头2_-000_左.png", "镜头2_007_右.png",
      "镜头2_+007_左.png", "镜头2_７７７_左.png",
    ] {
    assert_true(pattern.frame(name) == None)
  }
}

///|
test "templates and frame magnitudes have explicit bounds" {
  for
    raw in ["", "x.png", "#-#.png", "dir/x#.png", "dir\\x#.png", "###########"] {
    assert_true(pattern_error(raw) != "")
  }
  let p = FramePattern::parse("#")
  assert_true(p.frame("0") == Some(0))
  assert_true(p.frame("1000000000") == Some(1000000000))
  assert_true(p.frame("-1000000000") == Some(-1000000000))
  assert_true(p.frame("1000000001") == None)
  assert_true(p.frame("99999999999999") == None)
  assert_true(p.frame("-") == None)
}

///|
test "sparse observations preserve categories and merge repairs across categories" {
  let r = audit(1, 8, 1, [8, 5, 7, 1, 6, 4, 2], [0, 1, 2, 0, 0, 0, 0])
  assert_eq(r.ready, 5)
  assert_eq(r.expected, 8)
  assert_true(r.missing == [{ first: 3, last: 3, }])
  assert_true(r.empty == [{ first: 5, last: 5, }])
  assert_true(r.damaged == [{ first: 7, last: 7, }])
  let joined = audit(1, 6, 1, [2, 4, 6], [1, 2, 0])
  assert_true(joined.rerender == [{ first: 1, last: 5, }])
}

///|
test "sparse two-billion frame window uses one interval" {
  let r = audit(-1000000000, 1000000000, 1, [], [])
  assert_eq(r.expected, 2000000001)
  assert_eq(r.missing_count, r.expected)
  assert_eq(r.missing.length(), 1)
  assert_true(r.rerender == [{ first: -1000000000, last: 1000000000, }])
}

///|
test "step anchors at first, ignores off-grid frames and stops at final grid point" {
  let r = audit(-5, 6, 3, [-5, -5, -3, 1, 8], [0, 0, 0, 1, 0])
  assert_eq(r.expected, 4)
  assert_eq(r.ready, 1)
  assert_eq(r.empty_count, 1)
  assert_true(r.missing == [{ first: -2, last: -2, }, { first: 4, last: 4, }])
  assert_true(r.rerender == [{ first: -2, last: 4, }])
}

///|
test "complete range and single empty frame" {
  let complete = audit(1, 5, 2, [3, 1, 5], [0, 0, 0])
  assert_eq(complete.ready, 3)
  assert_eq(complete.rerender.length(), 0)
  let one = audit(9, 9, 4, [9], [1])
  assert_eq(one.expected, 1)
  assert_eq(one.empty_count, 1)
  assert_eq(one.missing_count, 0)
}

///|
test "bad manifest and contradictory duplicate raise an error" {
  assert_true(audit_frames(1, 4, 1, [1], []).contains("error"))
  assert_true(audit_frames(1, 4, 1, [1, 1], [0, 2]).contains("error"))
  assert_true(audit_frames(1, 4, 1, [1], [5]).contains("error"))
  assert_true(range_error(2, 1, 1) != "")
  assert_true(range_error(1, 2, 0) != "")
}

///|
test "streaming PNG retains errors and rejects an unfinished header" {
  let truncated = new_png_probe()
  assert_eq(truncated(b"\x89PNG", false), "")
  assert_eq(truncated(b"\r\n\x1a\n", false), "")
  assert_true(truncated(b"", true).contains("IEND"))
  let wrong = new_png_probe()
  let message = wrong(b"bad", false)
  assert_true(message.contains("签名"))
  assert_eq(wrong(b"", true), message)
}
