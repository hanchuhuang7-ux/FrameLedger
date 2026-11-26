///|
test "a delivery needs every eye and keeps overlapping uncertainty visible" {
  let single = fn(n) { Span::{ first: n, last: n, } }
  let result = combine_delivery(1, 8, 1, [
    { rerender: [single(3), single(5)], unverified: [], },
    { rerender: [single(5), single(7)], unverified: [single(3), single(8)], },
  ])
  assert_eq(result.ready, 4)
  assert_eq(result.rerender_count, 3)
  assert_eq(result.unverified_count, 2)
  assert_eq(result.review_only_count, 1)
  assert_true(result.rerender == [single(3), single(5), single(7)])
  assert_true(result.review_only == [single(8)])
}

///|
test "billion frame tails and coarse steps need only span boundaries" {
  let entire = combine_delivery(-1000000000, 1000000000, 1, [
    { rerender: [{ first: -1000000000, last: 1000000000, }], unverified: [], },
  ])
  assert_eq(entire.ready, 0)
  assert_eq(entire.rerender_count, 2000000001)
  let sparse = combine_delivery(-1000000000, 1000000000, 1000000000, [
    { rerender: [{ first: -1000000000, last: 1000000000, }], unverified: [], },
  ])
  assert_eq(sparse.rerender_count, 3)
}

///|
test "inconsistent per-output reports cannot produce a clean delivery" {
  let crossed = "[{\"rerender\":[{\"first\":1,\"last\":3}],\"unverified\":[{\"first\":3,\"last\":3}]}]"
  assert_true(combine_delivery_json(1, 6, 2, crossed).contains("error"))
  assert_true(combine_delivery_json(1, 6, 2, "[]").contains("error"))
  assert_true(combine_delivery_json(1, 6, 2, "invalid").contains("error"))
}
