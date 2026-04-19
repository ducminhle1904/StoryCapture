//! Background compositor (POST-04): gradient presets, user-image upload
//! validation, rounded window frame, drop shadow, and padding. Emits into
//! both the FFmpeg filter_complex chain and the PreviewRenderPlan (D-01).

pub mod compositor;
pub mod gradients;
pub mod rounded_frame;
pub mod shadow;

pub use compositor::{emit_background, BackgroundEmit, ExtraInput};
pub use gradients::{
    load_gradient_png, lookup, resolve_asset_path, GradientPreset, GRADIENT_PRESETS,
};
pub use rounded_frame::{emit_rounded_mask, RoundedFrameParams};
pub use shadow::{emit_drop_shadow, ShadowParams};

use std::path::{Path, PathBuf};

use crate::error::EffectsError;

/// Upload constraints (POST-04 must-have):
///   - Max dimensions: 8192x8192
///   - Max file size: 10 MiB
///   - Allowed extensions: png, jpg, jpeg
pub const MAX_UPLOAD_DIMS: u32 = 8192;
pub const MAX_UPLOAD_SIZE_BYTES: u64 = 10 * 1024 * 1024;
pub const ALLOWED_IMAGE_EXTS: &[&str] = &["png", "jpg", "jpeg"];

/// Validate and copy an uploaded background image into
/// `<project_dir>/backgrounds/<filename>`. Returns the destination path.
///
/// Checks:
///   1. File exists and is readable.
///   2. Extension is one of [`ALLOWED_IMAGE_EXTS`].
///   3. File size <= [`MAX_UPLOAD_SIZE_BYTES`].
///   4. Decoded dimensions <= [`MAX_UPLOAD_DIMS`] on both axes.
///
/// Threat mitigations (T-02-18, T-02-19).
pub fn validate_and_copy_image(source: &Path, project_dir: &Path) -> Result<PathBuf, EffectsError> {
    let meta = std::fs::metadata(source)?;
    if meta.len() > MAX_UPLOAD_SIZE_BYTES {
        return Err(EffectsError::ImageTooLarge { bytes: meta.len() });
    }
    let ext = source
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    if !ALLOWED_IMAGE_EXTS.contains(&ext.as_str()) {
        return Err(EffectsError::UnsupportedImageFormat(ext));
    }
    // Actually decode to confirm well-formedness + dimensions.
    let img = image::open(source)?;
    if img.width() > MAX_UPLOAD_DIMS || img.height() > MAX_UPLOAD_DIMS {
        return Err(EffectsError::ImageTooLarge { bytes: meta.len() });
    }
    let file_name = source.file_name().ok_or(EffectsError::InvalidPath)?;
    let dest = project_dir.join("backgrounds").join(file_name);
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::copy(source, &dest)?;
    Ok(dest)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageBuffer, Rgba};
    use std::io::Write;

    fn write_png(dir: &Path, name: &str, w: u32, h: u32) -> PathBuf {
        let path = dir.join(name);
        let img: image::RgbaImage = ImageBuffer::from_pixel(w, h, Rgba([128, 128, 128, 255]));
        img.save(&path).expect("save png");
        path
    }

    #[test]
    fn image_upload_accepts_valid_png() {
        let tmp = tempfile::tempdir().unwrap();
        let project = tmp.path().join("proj");
        std::fs::create_dir_all(&project).unwrap();
        let src = write_png(tmp.path(), "bg.png", 512, 512);
        let dest = validate_and_copy_image(&src, &project).expect("validate");
        assert!(dest.exists());
        assert_eq!(dest.parent().unwrap().file_name().unwrap(), "backgrounds");
    }

    #[test]
    fn image_upload_rejects_too_large_dimensions() {
        let tmp = tempfile::tempdir().unwrap();
        let project = tmp.path().join("proj");
        std::fs::create_dir_all(&project).unwrap();
        // 9000x9000 → exceeds MAX_UPLOAD_DIMS. File size also exceeds cap;
        // either error is acceptable per the must-have (ImageTooLarge).
        let src = write_png(tmp.path(), "big.png", 9000, 9000);
        let err = validate_and_copy_image(&src, &project).expect_err("should reject");
        assert!(matches!(err, EffectsError::ImageTooLarge { .. }));
    }

    #[test]
    fn image_upload_rejects_bad_mime() {
        let tmp = tempfile::tempdir().unwrap();
        let project = tmp.path().join("proj");
        std::fs::create_dir_all(&project).unwrap();
        let src = tmp.path().join("notes.txt");
        let mut f = std::fs::File::create(&src).unwrap();
        writeln!(f, "hello").unwrap();
        let err = validate_and_copy_image(&src, &project).expect_err("should reject");
        assert!(matches!(err, EffectsError::UnsupportedImageFormat(_)));
    }

    #[test]
    fn image_upload_rejects_oversized_bytes() {
        let tmp = tempfile::tempdir().unwrap();
        let project = tmp.path().join("proj");
        std::fs::create_dir_all(&project).unwrap();
        // Synthesize a .png file that's > 10MiB by padding bytes. image::open
        // will fail first, but we hit the size-cap check before decoding.
        let src = tmp.path().join("huge.png");
        let buf = vec![0u8; (MAX_UPLOAD_SIZE_BYTES + 1) as usize];
        std::fs::write(&src, buf).unwrap();
        let err = validate_and_copy_image(&src, &project).expect_err("should reject");
        assert!(matches!(err, EffectsError::ImageTooLarge { .. }));
    }
}
