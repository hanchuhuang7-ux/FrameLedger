///|
test "a MoonBit consumer reads a repair plan and keeps left and right eyes separate" {
  let result = inspect_shot()
  assert_eq(result.ready, 3)
  assert_eq(result.missing_count, 2)
  assert_eq(result.empty_count, 1)
  assert_eq(result.rerender.length(), 2)
  assert_eq(result.rerender[0].first, 1003)
  assert_eq(result.rerender[0].last, 1005)
  assert_eq(result.rerender[1].first, 1009)
}
