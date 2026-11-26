///|
fn inspect_shot() -> @ledger.Report raise @ledger.InputError {
  let left = @ledger.FramePattern::parse("shot_####_L.exr")
  let scan = @ledger.AuditSession::new(1001, 1011, step=2)
  for
    (name, state) in [
      ("shot_1001_L.exr", @ledger.Ready),
      ("shot_1005_L.exr", @ledger.Empty),
      ("shot_1007_L.exr", @ledger.Ready),
      ("shot_1011_L.exr", @ledger.Ready),
      ("shot_1003_R.exr", @ledger.Ready),
    ] {
    if left.frame(name) is Some(frame) {
      scan.observe(frame, state)
    }
  }
  scan.report()
}

///|
fn main {
  let result = inspect_shot() catch { _ => abort("Invalid fixture") }
  println(@json.to_json(result).stringify())
}
