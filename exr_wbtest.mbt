///|
fn sample_attr(
  out : @buffer.Buffer,
  name : Bytes,
  kind : Bytes,
  value : Bytes,
) -> Unit {
  out.write_bytesview(name[:])
  out.write_byte(0)
  out.write_bytesview(kind[:])
  out.write_byte(0)
  out.write_int_le(value.length())
  out.write_bytesview(value[:])
}

///|
/// One half-float Y pixel, raw storage, with the offset calculated from its header.
fn single_pixel_exr(channel~ : Bytes = b"Y") -> Bytes {
  let out = @buffer.Buffer::Buffer()
  out.write_int_le(20000630)
  out.write_int_le(2)
  sample_attr(
    out,
    b"channels",
    b"chlist",
    channel +
    b"\x00\x01\x00\x00\x00\x00\x00\x00\x00\x01\x00\x00\x00\x01\x00\x00\x00\x00",
  )
  sample_attr(out, b"compression", b"compression", b"\x00")
  for name in [b"dataWindow", b"displayWindow"] {
    sample_attr(out, name, b"box2i", Bytes::make(16, 0))
  }
  sample_attr(out, b"lineOrder", b"lineOrder", b"\x00")
  sample_attr(out, b"pixelAspectRatio", b"float", b"\x00\x00\x80\x3f")
  sample_attr(out, b"screenWindowCenter", b"v2f", Bytes::make(8, 0))
  sample_attr(out, b"screenWindowWidth", b"float", b"\x00\x00\x80\x3f")
  out.write_byte(0)
  out.write_int64_le(out.length().to_int64() + 8L)
  out.write_int_le(0)
  out.write_int_le(2)
  out.write_int16_le(0)
  out.to_bytes()
}

///|
test "UTF-8 channel requirements compare with actual EXR identifier bytes" {
  let sample = single_pixel_exr(channel=@utf8.encode("深度.Z"))
  assert_true(
    ExrProbe::new(required_channels=["深度.Z"]).feed(sample, eof=true) ==
    Complete,
  )
  assert_true(
    ExrProbe::new(required_channels=["深度.X"]).feed(sample, eof=true)
    is Malformed(_),
  )
}

///|
test "a scan-line file survives one-byte fragmentation across every header, offset and block" {
  let bytes = single_pixel_exr()
  let probe = ExrProbe::new(width=1, height=1)
  for i in 0..<bytes.length() {
    assert_true(probe.feed(Bytes::from_array([bytes[i]])) == Reading)
  }
  assert_true(probe.feed(b"", eof=true) == Complete)
}

///|
test "a missing pixel byte and a mismatched display contract have positive damage verdicts" {
  let bytes = single_pixel_exr()
  let cut = Bytes::makei(bytes.length() - 1, i => bytes[i])
  assert_true(ExrProbe::new().feed(cut, eof=true) is Malformed(_))
  assert_true(
    ExrProbe::new(width=2, height=1).feed(bytes, eof=true) is Malformed(_),
  )
}

///|
test "unhandled layouts and versions never become a pass or an instruction to rerender" {
  for
    prefix in [
      b"\x76\x2f\x31\x01\x02\x02\x00\x00", b"\x76\x2f\x31\x01\x02\x08\x00\x00", b"\x76\x2f\x31\x01\x03\x00\x00\x00",
    ] {
    let probe = ExrProbe::new()
    assert_true(probe.feed(prefix) is NeedsReview(_))
    assert_true(probe.feed(b"", eof=true) is NeedsReview(_))
  }
  let session = AuditSession::new(1, 3)
  session.observe(2, NeedsReview)
  let report = session.report()
  assert_eq(report.ready, 0)
  assert_eq(report.unverified_count, 1)
  assert_true(
    report.rerender == [{ first: 1, last: 1, }, { first: 3, last: 3, }],
  )
}
