//! Rope-backed document model + UTF-8 safe LSP position conversions.
//!
//! T-03-13-02 mitigation: all slicing goes through `ropey`'s char-index
//! API so multi-byte characters in user-authored `.story` files never
//! produce a mid-codepoint byte offset.

use ropey::Rope;
use tower_lsp::lsp_types::{Position, Range, TextDocumentContentChangeEvent};

/// Apply an ordered list of `TextDocumentContentChangeEvent`s to `rope`.
///
/// Each change that carries a `range` is an incremental edit; a change
/// without a range replaces the whole document (LSP spec).
pub fn apply_changes(rope: &mut Rope, changes: &[TextDocumentContentChangeEvent]) {
    for change in changes {
        match change.range {
            None => {
                *rope = Rope::from_str(&change.text);
            }
            Some(range) => {
                let Some(start_char) = position_to_char(rope, range.start) else {
                    continue;
                };
                let Some(end_char) = position_to_char(rope, range.end) else {
                    continue;
                };
                if start_char > end_char || end_char > rope.len_chars() {
                    continue;
                }
                rope.remove(start_char..end_char);
                rope.insert(start_char, &change.text);
            }
        }
    }
}

/// Convert an LSP `Position` (UTF-16 code units) to a rope **char index**.
///
/// LSP positions are nominally UTF-16 code units per spec. For the common
/// BMP case this equals char count. Characters outside the BMP (emoji,
/// etc.) are rare in `.story` source; treating `character` as char count
/// keeps parity with VS Code's default utf-16/utf-8 negotiation while
/// remaining safe (we never exceed line length).
pub fn position_to_char(rope: &Rope, pos: Position) -> Option<usize> {
    let line = pos.line as usize;
    if line > rope.len_lines() {
        return None;
    }
    let line_start = rope.line_to_char(line.min(rope.len_lines()));
    let line_len = if line < rope.len_lines() {
        rope.line(line).len_chars()
    } else {
        0
    };
    let col = (pos.character as usize).min(line_len);
    Some(line_start + col)
}

/// Convert a byte offset (e.g. from a pest span) to an LSP `Position`.
pub fn byte_offset_to_position(rope: &Rope, byte_offset: usize) -> Position {
    let clamped = byte_offset.min(rope.len_bytes());
    let char_idx = rope.byte_to_char(clamped);
    let line = rope.char_to_line(char_idx);
    let line_start = rope.line_to_char(line);
    let col = char_idx - line_start;
    Position { line: line as u32, character: col as u32 }
}

/// Range covering `[start_byte, end_byte)` in rope coordinates.
pub fn byte_range_to_lsp_range(rope: &Rope, start_byte: usize, end_byte: usize) -> Range {
    Range {
        start: byte_offset_to_position(rope, start_byte),
        end: byte_offset_to_position(rope, end_byte),
    }
}

/// Extract the identifier (word) at the given LSP position.
///
/// Returns `(identifier, range)` if the position is on a word character,
/// else `None`. Words are `[A-Za-z0-9_-]+` so verbs like `wait-for` are
/// treated as one identifier.
pub fn identifier_at(rope: &Rope, pos: Position) -> Option<(String, Range)> {
    let char_idx = position_to_char(rope, pos)?;
    let total = rope.len_chars();
    if total == 0 {
        return None;
    }

    let is_word = |c: char| c.is_ascii_alphanumeric() || c == '_' || c == '-';

    // Walk left.
    let mut start = char_idx;
    while start > 0 {
        let c = rope.char(start - 1);
        if !is_word(c) {
            break;
        }
        start -= 1;
    }
    // Walk right.
    let mut end = char_idx;
    while end < total {
        let c = rope.char(end);
        if !is_word(c) {
            break;
        }
        end += 1;
    }

    if start == end {
        return None;
    }

    let ident: String = rope.slice(start..end).to_string();
    let start_byte = rope.char_to_byte(start);
    let end_byte = rope.char_to_byte(end);
    Some((ident, byte_range_to_lsp_range(rope, start_byte, end_byte)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn position_to_char_clamps_past_eol() {
        let r = Rope::from_str("abc\ndef");
        let p = Position { line: 0, character: 100 };
        // ropey includes the trailing newline in line 0's length (4 chars:
        // 'a','b','c','\n'), so clamped col = 4 (pointing at the start of
        // the next line in char coordinates). This keeps multi-byte-safe
        // arithmetic consistent with `line_to_char`.
        assert_eq!(position_to_char(&r, p), Some(4));
    }

    #[test]
    fn byte_offset_round_trip_multibyte() {
        let r = Rope::from_str("héllo\nwörld");
        // 'é' is 2 bytes; 'w' begins at byte 7 (h=1, é=2, l=1, l=1, o=1, \n=1).
        let pos = byte_offset_to_position(&r, 7);
        assert_eq!(pos.line, 1);
        assert_eq!(pos.character, 0);
    }

    #[test]
    fn identifier_at_finds_hyphenated_verb() {
        let r = Rope::from_str("  wait-for \"#btn\"\n");
        let p = Position { line: 0, character: 5 };
        let (ident, _) = identifier_at(&r, p).unwrap();
        assert_eq!(ident, "wait-for");
    }

    #[test]
    fn apply_changes_incremental_replace() {
        let mut r = Rope::from_str("click x\n");
        let changes = vec![TextDocumentContentChangeEvent {
            range: Some(Range {
                start: Position { line: 0, character: 0 },
                end: Position { line: 0, character: 5 },
            }),
            range_length: None,
            text: "hover".into(),
        }];
        apply_changes(&mut r, &changes);
        assert_eq!(r.to_string(), "hover x\n");
    }

    #[test]
    fn apply_changes_full_replace() {
        let mut r = Rope::from_str("old");
        let changes = vec![TextDocumentContentChangeEvent {
            range: None,
            range_length: None,
            text: "new document".into(),
        }];
        apply_changes(&mut r, &changes);
        assert_eq!(r.to_string(), "new document");
    }
}
