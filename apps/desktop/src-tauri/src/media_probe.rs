use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct MediaProbe {
    pub duration_ms: Option<u64>,
    pub width: Option<u32>,
    pub height: Option<u32>,
}

const BOX_HEADER_LEN: usize = 8;
const EXTENDED_BOX_HEADER_LEN: usize = 16;
const MAX_MOOV_BYTES: u64 = 16 * 1024 * 1024;

const BOX_MOOV: &[u8; 4] = b"moov";
const BOX_MVHD: &[u8; 4] = b"mvhd";
const BOX_TRAK: &[u8; 4] = b"trak";
const BOX_TKHD: &[u8; 4] = b"tkhd";

#[derive(Debug, Clone, Copy)]
struct Mp4BoxHeader {
    kind: [u8; 4],
    size: u64,
    header_len: u64,
}

pub fn probe_mp4_metadata(path: &Path) -> MediaProbe {
    match probe_mp4_metadata_inner(path) {
        Ok(probe) => probe,
        Err(err) => {
            tracing::debug!(path = %path.display(), error = %err, "mp4 metadata probe failed");
            MediaProbe::default()
        }
    }
}

fn probe_mp4_metadata_inner(path: &Path) -> Result<MediaProbe, String> {
    let mut file = File::open(path).map_err(|e| format!("open: {e}"))?;
    let file_len = file.metadata().map_err(|e| format!("metadata: {e}"))?.len();
    let mut offset = 0u64;
    while offset.saturating_add(BOX_HEADER_LEN as u64) <= file_len {
        file.seek(SeekFrom::Start(offset))
            .map_err(|e| format!("seek box: {e}"))?;
        let remaining = file_len - offset;
        let Some(header) = read_box_header(&mut file, remaining)? else {
            break;
        };
        if header.size < header.header_len {
            return Err(format!("invalid box size {}", header.size));
        }
        if header.size > remaining {
            return Err(format!(
                "box size {} exceeds remaining file bytes {}",
                header.size, remaining
            ));
        }
        if &header.kind == BOX_MOOV {
            let payload_len = header.size - header.header_len;
            if payload_len > MAX_MOOV_BYTES {
                return Err(format!("moov box too large: {payload_len}"));
            }
            let mut payload = vec![0; payload_len as usize];
            file.read_exact(&mut payload)
                .map_err(|e| format!("read moov: {e}"))?;
            return Ok(parse_moov_metadata(&payload));
        }
        offset = offset.saturating_add(header.size);
    }
    Ok(MediaProbe::default())
}

fn read_box_header<R: Read>(
    reader: &mut R,
    remaining: u64,
) -> Result<Option<Mp4BoxHeader>, String> {
    if remaining < BOX_HEADER_LEN as u64 {
        return Ok(None);
    }
    let mut header = [0u8; EXTENDED_BOX_HEADER_LEN];
    reader
        .read_exact(&mut header[..BOX_HEADER_LEN])
        .map_err(|e| format!("read box header: {e}"))?;
    let small_size = u32::from_be_bytes(header[0..4].try_into().expect("slice length"));
    let mut kind = [0u8; 4];
    kind.copy_from_slice(&header[4..8]);
    if small_size != 1 {
        let size = if small_size == 0 {
            remaining
        } else {
            u64::from(small_size)
        };
        return Ok(Some(Mp4BoxHeader {
            kind,
            size,
            header_len: BOX_HEADER_LEN as u64,
        }));
    }

    if remaining < EXTENDED_BOX_HEADER_LEN as u64 {
        return Err("extended box size without room for u64".into());
    }
    reader
        .read_exact(&mut header[BOX_HEADER_LEN..EXTENDED_BOX_HEADER_LEN])
        .map_err(|e| format!("read extended box size: {e}"))?;
    Ok(Some(Mp4BoxHeader {
        kind,
        size: u64::from_be_bytes(
            header[BOX_HEADER_LEN..EXTENDED_BOX_HEADER_LEN]
                .try_into()
                .expect("slice length"),
        ),
        header_len: EXTENDED_BOX_HEADER_LEN as u64,
    }))
}

fn parse_box_header(bytes: &[u8]) -> Option<Mp4BoxHeader> {
    if bytes.len() < BOX_HEADER_LEN {
        return None;
    }
    let small_size = u32::from_be_bytes(bytes[0..4].try_into().ok()?);
    let mut kind = [0u8; 4];
    kind.copy_from_slice(&bytes[4..8]);
    if small_size == 1 {
        if bytes.len() < EXTENDED_BOX_HEADER_LEN {
            return None;
        }
        return Some(Mp4BoxHeader {
            kind,
            size: u64::from_be_bytes(bytes[8..16].try_into().ok()?),
            header_len: EXTENDED_BOX_HEADER_LEN as u64,
        });
    }
    Some(Mp4BoxHeader {
        kind,
        size: if small_size == 0 {
            bytes.len() as u64
        } else {
            u64::from(small_size)
        },
        header_len: BOX_HEADER_LEN as u64,
    })
}

fn for_each_child_box(mut bytes: &[u8], mut visit: impl FnMut(&[u8; 4], &[u8])) {
    while let Some(header) = parse_box_header(bytes) {
        if header.size < header.header_len || header.size as usize > bytes.len() {
            break;
        }
        let payload_start = header.header_len as usize;
        let payload_end = header.size as usize;
        visit(&header.kind, &bytes[payload_start..payload_end]);
        bytes = &bytes[payload_end..];
    }
}

fn parse_moov_metadata(moov: &[u8]) -> MediaProbe {
    let mut probe = MediaProbe::default();
    for_each_child_box(moov, |box_type, payload| match box_type {
        BOX_MVHD => {
            probe.duration_ms = probe
                .duration_ms
                .or_else(|| parse_mvhd_duration_ms(payload));
        }
        BOX_TRAK => {
            if probe.width.is_none() || probe.height.is_none() {
                let dims = parse_trak_dimensions(payload);
                probe.width = probe.width.or(dims.0);
                probe.height = probe.height.or(dims.1);
            }
        }
        _ => {}
    });
    probe
}

fn parse_mvhd_duration_ms(payload: &[u8]) -> Option<u64> {
    let version = *payload.first()?;
    let (timescale, duration) = if version == 1 {
        if payload.len() < 32 {
            return None;
        }
        let timescale = u32::from_be_bytes(payload[20..24].try_into().ok()?);
        let duration = u64::from_be_bytes(payload[24..32].try_into().ok()?);
        (timescale, duration)
    } else {
        if payload.len() < 20 {
            return None;
        }
        let timescale = u32::from_be_bytes(payload[12..16].try_into().ok()?);
        let duration = u32::from_be_bytes(payload[16..20].try_into().ok()?) as u64;
        (timescale, duration)
    };
    if timescale == 0 {
        return None;
    }
    Some(duration.saturating_mul(1000) / u64::from(timescale))
}

fn parse_trak_dimensions(trak: &[u8]) -> (Option<u32>, Option<u32>) {
    let mut dims = (None, None);
    for_each_child_box(trak, |box_type, payload| {
        if box_type == BOX_TKHD {
            dims = parse_tkhd_dimensions(payload);
        }
    });
    dims
}

fn parse_tkhd_dimensions(payload: &[u8]) -> (Option<u32>, Option<u32>) {
    if payload.len() < 12 {
        return (None, None);
    }
    let width_fixed = u32::from_be_bytes(
        payload[payload.len() - 8..payload.len() - 4]
            .try_into()
            .expect("slice length"),
    );
    let height_fixed = u32::from_be_bytes(
        payload[payload.len() - 4..payload.len()]
            .try_into()
            .expect("slice length"),
    );
    let width = width_fixed >> 16;
    let height = height_fixed >> 16;
    ((width > 0).then_some(width), (height > 0).then_some(height))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn mp4_box(name: &[u8; 4], payload: &[u8]) -> Vec<u8> {
        let size = (BOX_HEADER_LEN + payload.len()) as u32;
        let mut out = Vec::with_capacity(size as usize);
        out.extend_from_slice(&size.to_be_bytes());
        out.extend_from_slice(name);
        out.extend_from_slice(payload);
        out
    }

    fn minimal_mp4(duration_ms: u32, width: u32, height: u32) -> Vec<u8> {
        let mut mvhd = vec![0u8; 100];
        mvhd[12..16].copy_from_slice(&1000u32.to_be_bytes());
        mvhd[16..20].copy_from_slice(&duration_ms.to_be_bytes());

        let mut tkhd = vec![0u8; 84];
        tkhd[1..4].copy_from_slice(&7u32.to_be_bytes()[1..4]);
        tkhd[76..80].copy_from_slice(&(width << 16).to_be_bytes());
        tkhd[80..84].copy_from_slice(&(height << 16).to_be_bytes());

        let mut moov = Vec::new();
        moov.extend_from_slice(&mp4_box(BOX_MVHD, &mvhd));
        moov.extend_from_slice(&mp4_box(BOX_TRAK, &mp4_box(BOX_TKHD, &tkhd)));

        let mut out = Vec::new();
        out.extend_from_slice(&mp4_box(b"ftyp", b"isom\0\0\0\x01isommp42"));
        out.extend_from_slice(&mp4_box(BOX_MOOV, &moov));
        out
    }

    #[test]
    fn reads_valid_mp4_media_metadata() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("valid.mp4");
        fs::write(&file, minimal_mp4(40_064, 1920, 1080)).unwrap();

        let probe = probe_mp4_metadata(&file);

        assert_eq!(probe.duration_ms, Some(40_064));
        assert_eq!(probe.width, Some(1920));
        assert_eq!(probe.height, Some(1080));
    }

    #[test]
    fn corrupt_mp4_returns_empty_media_metadata() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("corrupt.mp4");
        fs::write(&file, b"not a real mp4").unwrap();

        assert_eq!(probe_mp4_metadata(&file), MediaProbe::default());
    }

    #[test]
    fn declared_box_size_beyond_file_returns_empty_media_metadata() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("oversized.mp4");
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&32u32.to_be_bytes());
        bytes.extend_from_slice(BOX_MOOV);
        fs::write(&file, bytes).unwrap();

        assert_eq!(probe_mp4_metadata(&file), MediaProbe::default());
    }
}
