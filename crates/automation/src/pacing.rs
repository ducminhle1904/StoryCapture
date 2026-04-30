use serde::{Deserialize, Serialize};
use story_parser::Command;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PacingProfile {
    Raw,
    Fast,
    Normal,
    Cinematic,
    Custom(PacingConfig),
}

impl Default for PacingProfile {
    fn default() -> Self {
        Self::Normal
    }
}

impl PacingProfile {
    pub fn config(self) -> PacingConfig {
        match self {
            Self::Raw => PacingConfig::raw(),
            Self::Fast => PacingConfig {
                enabled: true,
                before_click_ms: 120,
                after_click_ms: 250,
                after_type_ms: 120,
                after_navigate_settle_ms: 0,
                after_screenshot_ms: 500,
                between_scene_ms: 500,
                max_auto_dwell_ms: 500,
            },
            Self::Normal => PacingConfig {
                enabled: true,
                before_click_ms: 250,
                after_click_ms: 450,
                after_type_ms: 180,
                after_navigate_settle_ms: 700,
                after_screenshot_ms: 1000,
                between_scene_ms: 900,
                max_auto_dwell_ms: 1000,
            },
            Self::Cinematic => PacingConfig {
                enabled: true,
                before_click_ms: 350,
                after_click_ms: 700,
                after_type_ms: 250,
                after_navigate_settle_ms: 1000,
                after_screenshot_ms: 1400,
                between_scene_ms: 1200,
                max_auto_dwell_ms: 1400,
            },
            Self::Custom(config) => config,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct PacingConfig {
    pub enabled: bool,
    pub before_click_ms: u64,
    pub after_click_ms: u64,
    pub after_type_ms: u64,
    pub after_navigate_settle_ms: u64,
    pub after_screenshot_ms: u64,
    pub between_scene_ms: u64,
    pub max_auto_dwell_ms: u64,
}

impl PacingConfig {
    pub const fn raw() -> Self {
        Self {
            enabled: false,
            before_click_ms: 0,
            after_click_ms: 0,
            after_type_ms: 0,
            after_navigate_settle_ms: 0,
            after_screenshot_ms: 0,
            between_scene_ms: 0,
            max_auto_dwell_ms: 0,
        }
    }

    pub fn clamp_dwell(self, ms: u64) -> u64 {
        if !self.enabled || ms == 0 {
            return 0;
        }
        if self.max_auto_dwell_ms == 0 {
            return ms;
        }
        ms.min(self.max_auto_dwell_ms)
    }

    pub fn is_raw(self) -> bool {
        !self.enabled
            || (self.before_click_ms == 0
                && self.after_click_ms == 0
                && self.after_type_ms == 0
                && self.after_navigate_settle_ms == 0
                && self.after_screenshot_ms == 0
                && self.between_scene_ms == 0)
    }
}

impl Default for PacingConfig {
    fn default() -> Self {
        PacingProfile::Normal.config()
    }
}

#[derive(Debug, Clone, Copy)]
pub struct PacingRuntime {
    config: PacingConfig,
    previous_scene_had_visible_action: bool,
    scene_had_visible_action: bool,
    pending_navigate_settle: bool,
}

impl PacingRuntime {
    pub fn new(config: PacingConfig) -> Self {
        Self {
            config,
            previous_scene_had_visible_action: false,
            scene_had_visible_action: false,
            pending_navigate_settle: false,
        }
    }

    pub fn is_enabled(self) -> bool {
        !self.config.is_raw()
    }

    pub fn before_command(self, scene_index: usize, cmd_index: usize, cmd: &Command) -> u64 {
        if !self.is_enabled()
            || cmd_index != 0
            || scene_index == 0
            || !self.previous_scene_had_visible_action
            || !is_visible_boundary(cmd)
        {
            return 0;
        }
        self.config.clamp_dwell(self.config.between_scene_ms)
    }

    pub fn after_command(&mut self, cmd: &Command, next_cmd: Option<&Command>) -> u64 {
        if !self.is_enabled() {
            return 0;
        }
        if is_visible_boundary(cmd) {
            self.scene_had_visible_action = true;
        }

        let pending_settle_ms =
            if self.pending_navigate_settle && !matches!(cmd, Command::Navigate { .. }) {
                self.pending_navigate_settle = false;
                self.config.after_navigate_settle_ms
            } else {
                0
            };

        let command_dwell_ms = match cmd {
            Command::Navigate { .. } => {
                if matches!(next_cmd, Some(Command::WaitFor { .. })) {
                    self.pending_navigate_settle = true;
                    0
                } else {
                    self.config.after_navigate_settle_ms
                }
            }
            Command::Click { .. } => self.config.after_click_ms,
            Command::Type { .. } | Command::Select { .. } | Command::Upload { .. } => {
                self.config.after_type_ms
            }
            Command::Screenshot { .. } => self.config.after_screenshot_ms,
            Command::Wait { .. }
            | Command::WaitFor { .. }
            | Command::Assert { .. }
            | Command::Pause { .. }
            | Command::Scroll { .. }
            | Command::Hover { .. }
            | Command::Drag { .. } => 0,
        };

        self.config
            .clamp_dwell(pending_settle_ms.max(command_dwell_ms))
    }

    pub fn finish_scene(&mut self) {
        if !self.is_enabled() {
            return;
        }
        self.previous_scene_had_visible_action = self.scene_had_visible_action;
        self.scene_had_visible_action = false;
    }
}

fn is_visible_boundary(cmd: &Command) -> bool {
    matches!(
        cmd,
        Command::Navigate { .. }
            | Command::Click { .. }
            | Command::Type { .. }
            | Command::Select { .. }
            | Command::Upload { .. }
            | Command::Screenshot { .. }
            | Command::Scroll { .. }
            | Command::Hover { .. }
            | Command::Drag { .. }
    )
}
