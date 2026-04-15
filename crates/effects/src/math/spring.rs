//! Critically-damped spring smoother — implemented in Task 2.
//!
//! Placeholder struct so the `math` module compiles during Task 1 TDD.

pub struct Spring {
    pub pos: f32,
    pub vel: f32,
    pub target: f32,
    pub omega: f32,
}
