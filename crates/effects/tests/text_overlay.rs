//! Text overlay engine tests.
//!
//! Covers both Task 1 (font resolution + drawtext escaping + animation
//! params) and Task 2 (callout + highlight ring + auto-annotate +
//! snapshot). Tests are grouped by task for traceability.

use std::path::{Path, PathBuf};

use effects::ast::types::{Rgba, Vec2};
use effects::ast::video::{
    FontChoice, HighlightBounds, HighlightOverlaySpec, HighlightShape, TextAnim, TextBox,
};
use effects::text::{
    anim_fade_params, anim_scale_in_params, anim_slide_up_params, auto_annotate_step,
    emit_callout_overlay, emit_drawtext, emit_ring_overlay, ensure_fonts_extracted,
    escape_drawtext_text, path_to_ffmpeg_arg, pulse_alpha_expr, render_callout_png,
    render_highlight_overlay_png, render_highlight_ring_png, resolve_bundled_font_path, ArrowDir,
    AutoAnnotateOptions, BundledFont, CalloutSpec, RingSpec, StepAstRef, BUNDLED_FONT_FILES,
};

// ------------------------------------------------------------
// Task 1 — escaping
// ------------------------------------------------------------

#[test]
fn escape_drawtext_text_colons() {
    assert_eq!(
        escape_drawtext_text("Step 3: Click Save"),
        "Step 3\\: Click Save"
    );
}

#[test]
fn escape_drawtext_text_backslashes() {
    assert_eq!(escape_drawtext_text("a\\b"), "a\\\\b");
}

#[test]
fn escape_drawtext_text_single_quotes() {
    assert_eq!(escape_drawtext_text("it's"), "it\\'s");
}

#[test]
fn escape_drawtext_text_percent() {
    // `%` is reserved for drawtext expansion tokens and must be escaped.
    assert_eq!(escape_drawtext_text("100% done"), "100\\% done");
}

#[test]
fn escape_drawtext_text_newlines_preserved() {
    // Drawtext accepts the literal two-character "\n" sequence as a
    // hard line break; we must pass it through unchanged.
    let input = "line1\nline2";
    let escaped = escape_drawtext_text(input);
    assert!(escaped.contains('\n'), "escaped = {:?}", escaped);
}

#[test]
fn escape_drawtext_text_adversarial_mix() {
    // T-02-26: adversarial text mixing every special char.
    let src = r#"a:b\c'd%e"#;
    let got = escape_drawtext_text(src);
    assert_eq!(got, r"a\:b\\c\'d\%e");
}

// ------------------------------------------------------------
// Task 1 — font resolution (Pitfall #8)
// ------------------------------------------------------------

#[test]
fn resolve_font_path_each_choice() {
    for choice in [
        BundledFont::GeistSansRegular,
        BundledFont::GeistSansBold,
        BundledFont::JetBrainsMonoRegular,
        BundledFont::InterDisplay,
        BundledFont::SpaceGroteskDisplay,
    ] {
        let p = resolve_bundled_font_path(choice).expect("font missing");
        assert!(p.exists(), "font not on disk: {:?}", p);
        assert!(
            p.extension().and_then(|e| e.to_str()) == Some("ttf"),
            "wrong ext: {:?}",
            p
        );
    }
}

#[test]
fn bundled_font_files_count_five() {
    assert_eq!(BUNDLED_FONT_FILES.len(), 5);
}

#[test]
fn ensure_fonts_extracted_no_spaces_in_path() {
    // Simulate a Windows-style "user with space" temp dir.
    let tmp = tempfile::tempdir().unwrap();
    let spaced = tmp.path().join("path with spaces");
    std::fs::create_dir_all(&spaced).unwrap();

    let extracted = ensure_fonts_extracted(&spaced).expect("extract");

    // The leaf directory (the UUID subdir) must have no spaces.
    let leaf = extracted
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap()
        .to_string();
    assert!(!leaf.contains(' '), "leaf dir has spaces: {:?}", leaf);
    assert!(leaf.starts_with("storycapture_fonts_"));

    // All 5 files copied.
    for name in BUNDLED_FONT_FILES.iter() {
        assert!(
            extracted.join(name).exists(),
            "missing copied font {}",
            name
        );
    }
}

#[test]
fn drawtext_emits_forward_slashes_on_windowsy_path() {
    // Synthetic Windows path; Rust's `Path` normalises separators per OS
    // but `path_to_ffmpeg_arg` must always produce forward slashes.
    let p = PathBuf::from(r"C:\Users\foo\font.ttf");
    let got = path_to_ffmpeg_arg(&p);
    // No *path-separator* backslashes — the only backslashes allowed are
    // the ones escaping the drive-letter colon.
    assert!(!got.contains(r"\\"), "still has path backslash: {:?}", got);
    assert!(
        !got.contains(r"\U"),
        "backslash-before-letter leak: {:?}",
        got
    );
    assert!(got.contains('/'), "no forward slash: {:?}", got);
    // Drive-letter colon must be escaped so the filter-arg parser does
    // not treat it as a separator.
    assert!(got.starts_with("C\\:/"), "missing escaped colon: {:?}", got);
}

// ------------------------------------------------------------
// Task 1 — animation params (Research §7)
// ------------------------------------------------------------

#[test]
fn anim_fade_alpha_expr_shape() {
    let e = anim_fade_params(5_000, 10_000, 300, 300);
    // Spot-check the four segment markers are present in the expression.
    assert!(e.contains("5.000"), "{}", e);
    assert!(e.contains("5.300"), "{}", e);
    assert!(e.contains("9.700"), "{}", e);
    assert!(e.contains("10.000"), "{}", e);
    assert!(e.starts_with("if(lt(t,"), "{}", e);
}

#[test]
fn anim_slide_up_produces_y_ramp() {
    let (alpha, y) = anim_slide_up_params(1_000, 2_000, 300, 300);
    assert!(alpha.starts_with("if(lt(t,"));
    // Slide-up amplitude is ±40 px.
    assert!(y.contains("40"), "y: {}", y);
}

#[test]
fn anim_scale_in_produces_fontsize_scale() {
    let (alpha, scale) = anim_scale_in_params(1_000, 2_000, 300, 300);
    assert!(alpha.starts_with("if(lt(t,"));
    // Scale-in goes 0.8 → 1.0.
    assert!(scale.contains("0.8"), "scale: {}", scale);
    assert!(scale.contains("0.2"), "scale: {}", scale);
}

// ------------------------------------------------------------
// Task 1 — emit_drawtext integration
// ------------------------------------------------------------

fn sample_text_box(anim_in: TextAnim, anim_out: TextAnim) -> TextBox {
    TextBox {
        t_start_ms: 1_000,
        t_end_ms: 4_000,
        text: "Click Save".into(),
        pos: Vec2::new(160.0, 400.0),
        font: FontChoice::Bundled {
            family: "Geist".into(),
            weight: 400,
        },
        size_pt: 36.0,
        color: Rgba::new(240, 240, 240, 255),
        box_style: None,
        anim_in,
        anim_out,
    }
}

#[test]
fn emit_drawtext_full_stage() {
    let tmp = tempfile::tempdir().unwrap();
    let font_dir = ensure_fonts_extracted(tmp.path()).unwrap();

    let tb = sample_text_box(TextAnim::Fade, TextAnim::Fade);
    let s = emit_drawtext(&tb, &font_dir, "[vin]", "[vout]").unwrap();

    // Starts with the input label.
    assert!(s.starts_with("[vin]drawtext="), "{}", s);
    // Ends with the output label.
    assert!(s.ends_with("[vout]"), "{}", s);
    // Contains the escape pipeline hallmarks.
    assert!(s.contains("text='Click Save'"), "{}", s);
    assert!(s.contains("fontfile='"), "{}", s);
    // Alpha ramp present.
    assert!(s.contains("alpha='if(lt(t,"), "{}", s);
    // Enable window present.
    assert!(s.contains("enable='between(t,1.000,4.000)'"), "{}", s);
    // Forward-slash font path (either on Windows or Unix).
    assert!(
        !emit_drawtext_font_region(&s).contains('\\'),
        "font path contains backslash: {}",
        s
    );
}

/// Extract the `fontfile='...'` value for assertions.
fn emit_drawtext_font_region(s: &str) -> &str {
    let start = s.find("fontfile='").unwrap() + "fontfile='".len();
    let rest = &s[start..];
    let end = rest.find('\'').unwrap();
    &rest[..end]
}

// ------------------------------------------------------------
// Task 2 — pulse alpha + auto-annotate
// ------------------------------------------------------------

#[test]
fn pulse_alpha_expr_shape() {
    let e = pulse_alpha_expr(5.0, 1.0);
    assert!(e.contains("0.5+0.5*sin(2*PI*(t-5.000)/1.000)"), "{}", e);
}

struct FakeStep {
    v: &'static str,
    t: Option<&'static str>,
    c: Option<&'static str>,
}
impl StepAstRef for FakeStep {
    fn verb(&self) -> &str {
        self.v
    }
    fn target(&self) -> Option<&str> {
        self.t
    }
    fn comment(&self) -> Option<&str> {
        self.c
    }
}

#[test]
fn auto_annotate_default_off() {
    // Default Options has enabled=false.
    let s = FakeStep {
        v: "click",
        t: Some("Save button"),
        c: None,
    };
    assert_eq!(
        auto_annotate_step(&s, &AutoAnnotateOptions::default()),
        None
    );
}

#[test]
fn auto_annotate_click_verb_when_enabled() {
    let opts = AutoAnnotateOptions {
        enabled: true,
        prefer_comment_over_synthesis: true,
    };
    let s = FakeStep {
        v: "click",
        t: Some("Save button"),
        c: None,
    };
    assert_eq!(
        auto_annotate_step(&s, &opts),
        Some("Click Save button".into())
    );
}

#[test]
fn auto_annotate_prefers_comment() {
    let opts = AutoAnnotateOptions {
        enabled: true,
        prefer_comment_over_synthesis: true,
    };
    let s = FakeStep {
        v: "click",
        t: Some("Save"),
        c: Some("Persist the draft"),
    };
    assert_eq!(
        auto_annotate_step(&s, &opts),
        Some("Persist the draft".into())
    );
}

#[test]
fn auto_annotate_unknown_verb_returns_none() {
    let opts = AutoAnnotateOptions {
        enabled: true,
        prefer_comment_over_synthesis: false,
    };
    let s = FakeStep {
        v: "teleport",
        t: Some("home"),
        c: None,
    };
    assert_eq!(auto_annotate_step(&s, &opts), None);
}

// ------------------------------------------------------------
// Task 2 — snapshot
// ------------------------------------------------------------

#[test]
fn snapshot_text_overlay_filter_complex() {
    let tmp = tempfile::tempdir().unwrap();
    let font_dir = ensure_fonts_extracted(tmp.path()).unwrap();

    // Two text boxes with different animations.
    let tb1 = TextBox {
        t_start_ms: 500,
        t_end_ms: 3_500,
        text: "Step 1: open the panel".into(), // exercises `:` escape
        pos: Vec2::new(120.0, 80.0),
        font: FontChoice::Bundled {
            family: "Geist".into(),
            weight: 400,
        },
        size_pt: 32.0,
        color: Rgba::new(240, 240, 240, 255),
        box_style: None,
        anim_in: TextAnim::Fade,
        anim_out: TextAnim::Fade,
    };
    let tb2 = TextBox {
        t_start_ms: 3_500,
        t_end_ms: 6_000,
        text: "It's 100% ready".into(), // `'` and `%`
        pos: Vec2::new(200.0, 400.0),
        font: FontChoice::Bundled {
            family: "Inter".into(),
            weight: 700,
        },
        size_pt: 44.0,
        color: Rgba::new(255, 255, 255, 255),
        box_style: None,
        anim_in: TextAnim::SlideUp,
        anim_out: TextAnim::Fade,
    };

    let s1 = emit_drawtext(&tb1, &font_dir, "[v0]", "[t0]").unwrap();
    let s2 = emit_drawtext(&tb2, &font_dir, "[t0]", "[t1]").unwrap();

    // Task 2: integrated callout + highlight ring overlays.
    let tmp_assets = tempfile::tempdir().unwrap();
    let callout_png = tmp_assets.path().join("callout.png");
    let ring_png = tmp_assets.path().join("ring.png");
    render_callout_png(
        &CalloutSpec {
            text: "Primary CTA".into(),
            size_pt: 22.0,
            font: FontChoice::Bundled {
                family: "Inter".into(),
                weight: 700,
            },
            fg: Rgba::new(240, 240, 240, 255),
            bg: Rgba::new(20, 20, 20, 230),
            border: Some(Rgba::new(255, 255, 255, 255)),
            padding_px: 14,
            radius_px: 10,
            arrow: Some(ArrowDir::Down),
        },
        &callout_png,
    )
    .unwrap();
    render_highlight_ring_png(
        &RingSpec {
            bbox_w: 220,
            bbox_h: 48,
            stroke_px: 3,
            color: Rgba::new(0, 200, 255, 255),
            rounded_radius_px: 8,
        },
        &ring_png,
    )
    .unwrap();
    let s3 = emit_callout_overlay(
        &callout_png,
        Vec2::new(300.0, 240.0),
        1_000,
        4_500,
        "[t1]",
        2,
        "[t2]",
    );
    let s4 = emit_ring_overlay(
        &ring_png,
        Vec2::new(400.0, 220.0),
        2_000,
        5_000,
        1.0,
        "[t2]",
        3,
        "[t3]",
    );

    let pulse = pulse_alpha_expr(5.0, 1.0);

    // Normalise the font dir path (UUID varies per run) to keep the
    // snapshot deterministic.
    let stable = normalize_font_path(&format!(
        "{};{};{};{}\n--- pulse ---\n{}",
        s1, s2, s3, s4, pulse
    ));

    // Write to fixtures dir as a plain-text snap.
    let snap_dir = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures");
    std::fs::create_dir_all(&snap_dir).unwrap();
    let snap_path = snap_dir.join("text_overlay.filter_complex.snap");

    if let Ok(existing) = std::fs::read_to_string(&snap_path) {
        assert_eq!(existing.trim(), stable.trim(), "snapshot drift");
    } else {
        std::fs::write(&snap_path, &stable).unwrap();
    }
    // Sanity: produced snap contains every expected feature.
    assert!(stable.contains("drawtext="));
    assert!(stable.contains("between(t,0.500,3.500)"));
    assert!(stable.contains("0.5+0.5*sin(2*PI*"));
}

// ------------------------------------------------------------
// Task 2 — callout + highlight ring PNGs + integrated snapshot
// ------------------------------------------------------------

#[test]
fn render_callout_png_rounded_rect() {
    let tmp = tempfile::tempdir().unwrap();
    let out = tmp.path().join("callout.png");
    let (w, h) = render_callout_png(
        &CalloutSpec {
            text: "Click Save".into(),
            size_pt: 24.0,
            font: FontChoice::SystemDefault,
            fg: Rgba::new(240, 240, 240, 255),
            bg: Rgba::new(20, 20, 20, 230),
            border: None,
            padding_px: 16,
            radius_px: 12,
            arrow: None,
        },
        &out,
    )
    .unwrap();
    // Heuristic: 10 chars * 24pt * 0.55 ≈ 132 text width, + 32 padding.
    assert!(w > 32, "w={}", w);
    assert!(h > 32, "h={}", h);
    assert!(out.exists());
}

#[test]
fn render_callout_png_with_arrow_adds_strip() {
    let tmp = tempfile::tempdir().unwrap();
    let plain = tmp.path().join("plain.png");
    let arrow = tmp.path().join("arrow.png");
    let base = CalloutSpec {
        text: "Hello".into(),
        size_pt: 20.0,
        font: FontChoice::SystemDefault,
        fg: Rgba::new(240, 240, 240, 255),
        bg: Rgba::new(10, 10, 10, 230),
        border: Some(Rgba::new(255, 255, 255, 255)),
        padding_px: 12,
        radius_px: 10,
        arrow: None,
    };
    let (_, h0) = render_callout_png(&base, &plain).unwrap();
    let (_, h1) = render_callout_png(
        &CalloutSpec {
            arrow: Some(ArrowDir::Down),
            ..base
        },
        &arrow,
    )
    .unwrap();
    assert!(h1 > h0, "arrow variant should be taller: {} vs {}", h1, h0);
}

#[test]
fn render_highlight_ring_png_bbox() {
    let tmp = tempfile::tempdir().unwrap();
    let out = tmp.path().join("ring.png");
    let (w, h) = render_highlight_ring_png(
        &RingSpec {
            bbox_w: 200,
            bbox_h: 100,
            stroke_px: 4,
            color: Rgba::new(0, 200, 255, 255),
            rounded_radius_px: 8,
        },
        &out,
    )
    .unwrap();
    assert_eq!(w, 208);
    assert_eq!(h, 108);
    assert!(out.exists());
}

#[test]
fn render_highlight_overlay_png_rounded_ring() {
    let tmp = tempfile::tempdir().unwrap();
    let out = tmp.path().join("highlight.png");
    let rendered = render_highlight_overlay_png(
        &HighlightOverlaySpec {
            t_start_ms: 1_000,
            duration_ms: 700,
            shape: HighlightShape::Ring,
            center: Vec2::new(100.0, 80.0),
            max_radius_px: 40.0,
            bounds: Some(HighlightBounds {
                x: 80.0,
                y: 50.0,
                w: 120.0,
                h: 50.0,
            }),
            padding_px: 8.0,
            radius_px: 10.0,
            stroke_px: 2.0,
            glow_px: 14.0,
            color: Rgba::new(255, 255, 255, 230),
            opacity: 0.8,
            png_path: None,
            overlay_pos: None,
        },
        320,
        180,
        &out,
    )
    .unwrap();
    assert!(out.exists());
    assert!(rendered.width > 120);
    assert!(rendered.height > 50);
    assert!(rendered.overlay_pos.x < 80.0);
}

#[test]
fn render_highlight_overlay_png_spotlight() {
    let tmp = tempfile::tempdir().unwrap();
    let out = tmp.path().join("spotlight.png");
    let rendered = render_highlight_overlay_png(
        &HighlightOverlaySpec {
            t_start_ms: 1_000,
            duration_ms: 700,
            shape: HighlightShape::Spotlight,
            center: Vec2::new(100.0, 80.0),
            max_radius_px: 40.0,
            bounds: Some(HighlightBounds {
                x: 80.0,
                y: 50.0,
                w: 120.0,
                h: 50.0,
            }),
            padding_px: 8.0,
            radius_px: 10.0,
            stroke_px: 2.0,
            glow_px: 14.0,
            color: Rgba::new(255, 255, 255, 230),
            opacity: 0.8,
            png_path: None,
            overlay_pos: None,
        },
        320,
        180,
        &out,
    )
    .unwrap();
    assert_eq!(rendered.width, 320);
    assert_eq!(rendered.height, 180);
    assert_eq!(rendered.overlay_pos, Vec2::ZERO);
}

#[test]
fn emit_callout_overlay_shape() {
    let s = emit_callout_overlay(
        Path::new("/tmp/callout.png"),
        Vec2::new(100.0, 200.0),
        1_000,
        5_000,
        "[vin]",
        2,
        "[vout]",
    );
    assert!(s.starts_with("[vin][2:v]overlay=x=100:y=200:"), "{}", s);
    assert!(s.ends_with("[vout]"));
    assert!(s.contains("between(t,1.000,5.000)"));
}

#[test]
fn emit_ring_overlay_has_pulse_alpha() {
    let s = emit_ring_overlay(
        Path::new("/tmp/ring.png"),
        Vec2::new(50.0, 50.0),
        2_000,
        8_000,
        1.5,
        "[vin]",
        3,
        "[vout]",
    );
    assert!(s.contains("0.5+0.5*sin(2*PI*(t-2.000)/1.500)"), "{}", s);
    assert!(s.contains("enable='between(t,2.000,8.000)'"), "{}", s);
}

fn normalize_font_path(s: &str) -> String {
    // Replace everything between `fontfile='` and the next `'` with a
    // deterministic sentinel.
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(idx) = rest.find("fontfile='") {
        out.push_str(&rest[..idx]);
        out.push_str("fontfile='<FONT_DIR>/");
        let after = &rest[idx + "fontfile='".len()..];
        // Find the close quote and the font filename (last path segment).
        let close = after.find('\'').unwrap();
        let file_segment = after[..close].rsplit('/').next().unwrap_or(&after[..close]);
        out.push_str(file_segment);
        out.push('\'');
        rest = &after[close + 1..];
    }
    out.push_str(rest);
    out
}
