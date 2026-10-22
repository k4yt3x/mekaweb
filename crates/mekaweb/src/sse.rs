//! Event streams from meka on their way to the browser: a `tool_call.completed` whose `change`
//! carries a file's whole text before and after has it replaced with the changed lines alone; the
//! stream may be compressed, flushing after every write so events still arrive one by one; and on
//! a device saving data, a command's output is not streamed as it runs (its result comes when it
//! ends), and writes are gathered and sent a few times a second.

use std::{io::Write, time::Duration};

use flate2::{Compression, write::GzEncoder};
use similar::TextDiff;

/// The largest frame held back to rewrite; a larger one passes through as it came.
const MAX_HELD_BYTES: usize = 8 * 1024 * 1024;

/// The longest diff a `change` becomes; past it the diff stops at a line, marked as cut short.
const MAX_DIFF_BYTES: usize = 256 * 1024;

/// How long a diff may take; past it, the diff is rougher, never wrong.
const DIFF_TIMEOUT: Duration = Duration::from_millis(250);

/// How much held back makes the next piece worth rewriting off the async runtime: it may complete
/// a frame whose diff takes a while.
const HEAVY_BYTES: usize = 64 * 1024;

/// Rewrites the frames of an event stream as they arrive in pieces.
#[derive(Debug, Default)]
pub(crate) struct Rewriter {
    /// The end of the last piece, short of a line.
    partial: Vec<u8>,
    /// Whether the line `partial` begins was begun in an earlier piece, already sent on or left
    /// out: its end is not a blank line.
    continued: bool,
    /// The frame's lines held back, each with its line ending removed.
    held: Vec<Vec<u8>>,
    held_bytes: usize,
    /// The frame's event, once its `event:` line came.
    event: Option<String>,
    /// Whether the rest of the frame passes through untouched.
    passing: bool,
    /// Whether the rest of the frame is left out.
    dropping: bool,
    /// Whether `tool_call.output_delta` frames are left out.
    drop_output: bool,
}

impl Rewriter {
    /// A rewriter that leaves out commands' streamed output if `drop_output`.
    pub(crate) fn new(drop_output: bool) -> Self {
        Self {
            drop_output,
            ..Self::default()
        }
    }

    /// Whether rewriting `chunk` may take long enough to be done off the async runtime.
    pub(crate) fn is_heavy(&self, chunk: &[u8]) -> bool {
        self.held_bytes + self.partial.len() + chunk.len() > HEAVY_BYTES
    }

    /// What to send for `chunk`.
    pub(crate) fn push(&mut self, chunk: &[u8]) -> Vec<u8> {
        let mut out = Vec::with_capacity(chunk.len());
        // Only the new piece can hold a line's end.
        let mut from = self.partial.len();
        self.partial.extend_from_slice(chunk);
        let mut start = 0;
        while let Some(offset) = self
            .partial
            .get(from..)
            .and_then(|rest| rest.iter().position(|byte| *byte == b'\n'))
        {
            let end = from + offset;
            let mut line = self.partial.get(start..end).unwrap_or_default().to_vec();
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            self.line(line, &mut out);
            start = end + 1;
            from = start;
        }
        self.partial.drain(..start);
        if !self.partial.is_empty() {
            if self.passing {
                // A frame passing through need not wait for its line to end.
                out.append(&mut self.partial);
                self.continued = true;
            } else if self.dropping {
                self.partial.clear();
                self.continued = true;
            } else if self.held_bytes + self.partial.len() > MAX_HELD_BYTES {
                // Too long to hold: what is held, and the rest of the frame, pass through.
                self.release(&mut out);
                self.passing = true;
                out.append(&mut self.partial);
                self.continued = true;
            }
        }
        out
    }

    /// What is left at the end of the stream.
    pub(crate) fn finish(&mut self) -> Vec<u8> {
        let mut out = Vec::new();
        self.release(&mut out);
        out.append(&mut self.partial);
        out
    }

    fn line(&mut self, line: Vec<u8>, out: &mut Vec<u8>) {
        let continued = std::mem::take(&mut self.continued);
        if self.dropping {
            if line.is_empty() && !continued {
                self.reset();
            }
            return;
        }
        if continued && self.passing {
            out.extend_from_slice(&line);
            out.push(b'\n');
            return;
        }
        if line.is_empty() {
            if !self.passing && self.event.as_deref() == Some("tool_call.completed") {
                let held = std::mem::take(&mut self.held);
                rewrite_frame(&held, out);
            } else {
                self.release(out);
            }
            out.push(b'\n');
            self.reset();
            return;
        }
        if self.passing {
            out.extend_from_slice(&line);
            out.push(b'\n');
            return;
        }
        if let Some(value) = line.strip_prefix(b"event:") {
            let event = String::from_utf8_lossy(value).trim().to_owned();
            if self.drop_output && event == "tool_call.output_delta" {
                self.held.clear();
                self.held_bytes = 0;
                self.dropping = true;
                return;
            }
            if event != "tool_call.completed" {
                self.held.push(line);
                self.release(out);
                self.passing = true;
                return;
            }
            self.event = Some(event);
        }
        self.held_bytes += line.len() + 1;
        self.held.push(line);
        if self.held_bytes > MAX_HELD_BYTES {
            self.release(out);
            self.passing = true;
        }
    }

    /// Sends the lines held back as they came.
    fn release(&mut self, out: &mut Vec<u8>) {
        for line in self.held.drain(..) {
            out.extend_from_slice(&line);
            out.push(b'\n');
        }
        self.held_bytes = 0;
    }

    fn reset(&mut self) {
        self.held.clear();
        self.held_bytes = 0;
        self.event = None;
        self.passing = false;
        self.dropping = false;
    }
}

/// Writes a held `tool_call.completed` frame, its `change` made a diff, without its blank line.
fn rewrite_frame(lines: &[Vec<u8>], out: &mut Vec<u8>) {
    let data = lines
        .iter()
        .filter_map(|line| data_value(line))
        .collect::<Vec<_>>()
        .join(&b'\n');
    let rewritten = serde_json::from_slice::<serde_json::Value>(&data)
        .ok()
        .and_then(|mut value| rewrite_change(&mut value).then_some(value))
        .and_then(|value| serde_json::to_vec(&value).ok());
    let Some(rewritten) = rewritten else {
        for line in lines {
            out.extend_from_slice(line);
            out.push(b'\n');
        }
        return;
    };
    let mut written = false;
    for line in lines {
        if data_value(line).is_some() {
            if !written {
                out.extend_from_slice(b"data: ");
                out.extend_from_slice(&rewritten);
                out.push(b'\n');
                written = true;
            }
        } else {
            out.extend_from_slice(line);
            out.push(b'\n');
        }
    }
}

/// The value of a `data:` line, without its one optional leading space.
fn data_value(line: &[u8]) -> Option<&[u8]> {
    let value = line.strip_prefix(b"data:")?;
    Some(value.strip_prefix(b" ").unwrap_or(value))
}

/// Replaces `value.change`'s `old` and `new` with a unified diff of them; whether it did.
pub(crate) fn rewrite_change(value: &mut serde_json::Value) -> bool {
    let Some(change) = value
        .get_mut("change")
        .and_then(serde_json::Value::as_object_mut)
    else {
        return false;
    };
    let old = change.get("old").and_then(serde_json::Value::as_str);
    let new = change.get("new").and_then(serde_json::Value::as_str);
    if old.is_none() && new.is_none() {
        return false;
    }
    let path = change
        .get("path")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("file")
        .to_owned();
    let (diff, truncated) = diff(old.unwrap_or_default(), new.unwrap_or_default(), &path);
    change.remove("old");
    change.remove("new");
    change.insert("diff".to_owned(), diff.into());
    if truncated {
        change.insert("diff_truncated".to_owned(), true.into());
    }
    true
}

/// A unified diff of `old` and `new` with three lines of context, and whether it was cut short.
fn diff(old: &str, new: &str, path: &str) -> (String, bool) {
    let text = TextDiff::configure()
        .timeout(DIFF_TIMEOUT)
        .diff_lines(old, new)
        .unified_diff()
        .context_radius(3)
        .header(&format!("a/{path}"), &format!("b/{path}"))
        .to_string();
    if text.len() <= MAX_DIFF_BYTES {
        return (text, false);
    }
    // A line's end is a byte that is never inside a character, so cutting after one is safe.
    let cut = text
        .as_bytes()
        .get(..MAX_DIFF_BYTES)
        .and_then(|head| head.iter().rposition(|byte| *byte == b'\n'))
        .map_or(0, |index| index + 1);
    (text.get(..cut).unwrap_or_default().to_owned(), true)
}

/// A gzip stream that flushes after every write, so the browser reads each piece as it comes
/// while the dictionary carries across pieces.
pub(crate) struct Gzip {
    encoder: GzEncoder<Vec<u8>>,
}

impl Gzip {
    /// A new stream.
    pub(crate) fn new() -> Self {
        Self {
            encoder: GzEncoder::new(Vec::new(), Compression::new(6)),
        }
    }

    /// The compressed bytes for `chunk`, flushed.
    pub(crate) fn push(&mut self, chunk: &[u8]) -> std::io::Result<Vec<u8>> {
        self.encoder.write_all(chunk)?;
        self.encoder.flush()?;
        Ok(std::mem::take(self.encoder.get_mut()))
    }

    /// The stream's end.
    pub(crate) fn finish(self) -> std::io::Result<Vec<u8>> {
        self.encoder.finish()
    }
}

#[cfg(test)]
mod tests {
    use std::io::Read;

    use flate2::read::GzDecoder;

    use super::*;

    fn rewrite_whole(input: &str, piece: usize) -> String {
        let mut rewriter = Rewriter::default();
        let mut out = Vec::new();
        for chunk in input.as_bytes().chunks(piece) {
            out.extend(rewriter.push(chunk));
        }
        out.extend(rewriter.finish());
        String::from_utf8(out).unwrap()
    }

    #[test]
    fn a_change_becomes_the_changed_lines_however_the_stream_is_cut() {
        let old = (1..=200).map(|n| format!("line {n}\n")).collect::<String>();
        let new = old.replace("line 100\n", "line one hundred\n");
        let payload = serde_json::json!({
            "id": "toolu_1",
            "is_error": false,
            "content": [{"type": "text", "text": "Edited"}],
            "change": {"path": "notes.txt", "old": old, "new": new},
            "turn_id": "t",
        });
        let input = format!(
            "id: 4\nevent: tool_call.completed\ndata: {payload}\n\nevent: notice\ndata: {{\"text\":\"after\"}}\n\n"
        );
        for piece in [1, 7, 64, 100_000] {
            let output = rewrite_whole(&input, piece);
            let frames: Vec<&str> = output.split("\n\n").collect();
            assert_eq!(frames.len(), 3, "{output}");
            assert!(frames[0].starts_with("id: 4\nevent: tool_call.completed\ndata: "));
            let data = frames[0].split("data: ").nth(1).unwrap();
            let value: serde_json::Value = serde_json::from_str(data).unwrap();
            let diff = value["change"]["diff"].as_str().unwrap();
            assert!(diff.contains("-line 100\n+line one hundred\n"), "{diff}");
            assert!(!diff.contains("line 50\n"));
            assert!(value["change"].get("old").is_none());
            assert_eq!(value["change"]["path"], "notes.txt");
            let keys: Vec<&String> = value.as_object().unwrap().keys().collect();
            assert_eq!(
                keys,
                ["id", "is_error", "content", "change", "turn_id"],
                "order is kept"
            );
            assert_eq!(frames[1], "event: notice\ndata: {\"text\":\"after\"}");
        }
    }

    #[test]
    fn other_events_and_completions_without_a_change_pass_untouched() {
        let input = "event: assistant_text.delta\ndata: {\"text\":\"hi\"}\n\n: heartbeat\n\nevent: tool_call.completed\ndata: {\"id\":\"x\",\"content\":[]}\n\n";
        for piece in [1, 5, 1000] {
            assert_eq!(rewrite_whole(input, piece), input);
        }
    }

    #[test]
    fn a_device_saving_data_gets_no_streamed_output() {
        let input = "event: tool_call.output_delta\ndata: {\"id\":\"t\",\"chunk\":\"lots\"}\n\nid: 5\nevent: tool_call.completed\ndata: {\"id\":\"t\",\"content\":[]}\n\n";
        for piece in [1, 4, 1000] {
            let mut rewriter = Rewriter::new(true);
            let mut out = Vec::new();
            for chunk in input.as_bytes().chunks(piece) {
                out.extend(rewriter.push(chunk));
            }
            out.extend(rewriter.finish());
            assert_eq!(
                String::from_utf8(out).unwrap(),
                "id: 5\nevent: tool_call.completed\ndata: {\"id\":\"t\",\"content\":[]}\n\n"
            );
        }
    }

    #[test]
    fn a_huge_diff_is_cut_short_at_a_line() {
        let new = (0..100_000)
            .map(|n| format!("added line {n}\n"))
            .collect::<String>();
        let mut value = serde_json::json!({"change": {"path": "big", "new": new}});
        assert!(rewrite_change(&mut value));
        let diff = value["change"]["diff"].as_str().unwrap();
        assert!(diff.len() <= MAX_DIFF_BYTES);
        assert!(diff.ends_with('\n'));
        assert_eq!(value["change"]["diff_truncated"], true);
    }

    #[test]
    fn a_diff_cut_inside_a_character_does_not_panic() {
        let mut straddled = false;
        for width in 1..=6 {
            let new = (0..40_000)
                .map(|n| format!("{}{n}\n", "漢".repeat(width)))
                .collect::<String>();
            let full = TextDiff::from_lines("", new.as_str())
                .unified_diff()
                .context_radius(3)
                .header("a/x", "b/x")
                .to_string();
            straddled |= full.len() > MAX_DIFF_BYTES && !full.is_char_boundary(MAX_DIFF_BYTES);
            let (diff, truncated) = diff("", &new, "x");
            assert!(truncated);
            assert!(diff.len() <= MAX_DIFF_BYTES && diff.ends_with('\n'));
        }
        assert!(straddled, "one of the widths cuts inside a character");
    }

    #[test]
    fn a_frame_too_long_to_hold_passes_through_without_piling_up() {
        let line = "x".repeat(MAX_HELD_BYTES + 1024);
        let input = format!(
            "event: tool_call.completed\ndata: {{\"change\":{{\"new\":\"{line}\"}}}}\n\nevent: notice\ndata: 1\n\n"
        );
        let mut rewriter = Rewriter::default();
        let mut out = Vec::new();
        for chunk in input.as_bytes().chunks(64 * 1024) {
            out.extend(rewriter.push(chunk));
            assert!(rewriter.partial.len() <= MAX_HELD_BYTES + 64 * 1024);
        }
        out.extend(rewriter.finish());
        assert_eq!(String::from_utf8(out).unwrap(), input);
    }

    #[test]
    fn a_left_out_line_cut_before_its_end_does_not_end_its_frame() {
        let input = "event: tool_call.output_delta\ndata: {\"chunk\":\"lots\"}\n\nevent: notice\ndata: 1\n\n";
        let cut = input.find("\n\nevent: notice").unwrap();
        let mut rewriter = Rewriter::new(true);
        let mut out = rewriter.push(&input.as_bytes()[..cut]);
        out.extend(rewriter.push(&input.as_bytes()[cut..]));
        out.extend(rewriter.finish());
        assert_eq!(
            String::from_utf8(out).unwrap(),
            "event: notice\ndata: 1\n\n"
        );
    }

    #[test]
    fn a_flushed_gzip_stream_reads_back_piece_by_piece() {
        let mut gzip = Gzip::new();
        let mut compressed = Vec::new();
        let pieces = ["event: a\ndata: 1\n\n", "event: a\ndata: 2\n\n"];
        for piece in pieces {
            let out = gzip.push(piece.as_bytes()).unwrap();
            assert!(!out.is_empty(), "each piece is flushed");
            compressed.extend(out);
        }
        compressed.extend(gzip.finish().unwrap());
        let mut text = String::new();
        GzDecoder::new(&compressed[..])
            .read_to_string(&mut text)
            .unwrap();
        assert_eq!(text, pieces.concat());
    }
}
