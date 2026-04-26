//! StoryCapture-curated voice presets.
//!
//! Six canonical voices spanning male/female, warm/authoritative, and
//! tutorial/cinematic tones. Each `slug` is a stable identifier used in
//! project metadata; `voice_id` maps to the ElevenLabs catalog.
//!
// TODO: Validate voice_id values against live ElevenLabs catalog during
// the eval harness — some voice IDs may change; confirm active and
// en-locale.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VoicePreset {
    pub slug: &'static str,
    pub voice_id: &'static str,
    pub display_name: &'static str,
    pub locale: &'static str,
}

/// Six curated ElevenLabs voices surfaced in the StoryCapture voice
/// picker. Target 6–8.
pub const CURATED_PRESETS: &[VoicePreset] = &[
    VoicePreset {
        slug: "energetic_male",
        voice_id: "EXAVITQu4vr4xnSDxMaL",
        display_name: "Energetic Male",
        locale: "en",
    },
    VoicePreset {
        slug: "calm_female",
        voice_id: "21m00Tcm4TlvDq8ikWAM",
        display_name: "Calm Female",
        locale: "en",
    },
    VoicePreset {
        slug: "tutorial_narrator",
        voice_id: "pNInz6obpgDQGcFmaJgB",
        display_name: "Tutorial Narrator",
        locale: "en",
    },
    VoicePreset {
        slug: "news_anchor",
        voice_id: "ErXwobaYiN019PkySvjV",
        display_name: "News Anchor",
        locale: "en",
    },
    VoicePreset {
        slug: "friendly_mentor",
        voice_id: "TxGEqnHWrfWFTfGW9XjX",
        display_name: "Friendly Mentor",
        locale: "en",
    },
    VoicePreset {
        slug: "cinematic_trailer",
        voice_id: "VR6AewLTigWG4xSOukaG",
        display_name: "Cinematic Trailer",
        locale: "en",
    },
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn curated_presets_has_at_least_six() {
        assert!(
            CURATED_PRESETS.len() >= 6,
            "D-11 requires 6–8 curated presets, got {}",
            CURATED_PRESETS.len()
        );
    }

    #[test]
    fn curated_preset_slugs_are_unique() {
        let mut slugs: Vec<&str> = CURATED_PRESETS.iter().map(|p| p.slug).collect();
        slugs.sort_unstable();
        let pre_dedup = slugs.len();
        slugs.dedup();
        assert_eq!(pre_dedup, slugs.len(), "duplicate preset slug detected");
    }

    #[test]
    fn curated_preset_voice_ids_are_nonempty() {
        for preset in CURATED_PRESETS {
            assert!(
                !preset.voice_id.is_empty(),
                "{}: empty voice_id",
                preset.slug
            );
            assert!(
                !preset.display_name.is_empty(),
                "{}: empty display_name",
                preset.slug
            );
        }
    }
}
